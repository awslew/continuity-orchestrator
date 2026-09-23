import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { detectSource } from "./encoding.js";

export class ReaderError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
// Preserve actionable filesystem categories without exposing raw OS messages.
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ReaderError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: "INPUT_INVALID", message: "Invalid tool arguments" };
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return { code: "PATH_NOT_FOUND", message: "Requested path does not exist" };
  if (code === "ENOTDIR") return { code: "NOT_DIRECTORY", message: "A requested path component is not a directory" };
  if (code === "EACCES" || code === "EPERM") return { code: "ACCESS_DENIED", message: "Local operating system denied access" };
  return { code: "OPERATION_FAILED", message: "Operation failed; inspect local diagnostics" };
}
const deny = (message = "Path is outside the project's shared files"): never => { throw new ReaderError("PATH_DENIED", message); };

/** Portable spelling rules include Windows ADS, device names and alternate separators. */
export function parts(path: string, rootAllowed = false): string[] {
  if (rootAllowed && path === ".") return [];
  if (!path || path.length > 500 || /[\\:~<>"|?*\x00-\x1f\x7f]/.test(path) || isAbsolute(path)) return deny();
  const result = path.split("/");
  if (result.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) return deny();
  return result;
}
/** Denylist of names that must never be shared, whatever the project's own
 * .gitignore says. It stays deliberately narrow: generated output (dist, build,
 * coverage, target) is decided by .gitignore for Git projects and by
 * GENERATED_DIRECTORIES during a directory scan, so listing it here as well only
 * duplicated that authority and made a project's own build artifacts, and any
 * test that asserts they exist, unreachable. */
const EXCLUDED = new Set(["node_modules", "vendor", "target", "evidence", "logs", "secrets", "credentials", "private", "__pycache__", "venv", "tunnel-client"]);
/** Credential-looking file names. The rule is anchored to the whole name
 * (`token.json`, `staging-tokens.txt`) so ordinary source such as `tokens.css`
 * stays shareable: the earlier unanchored form blocked real CSS files and made a
 * frontend build impossible to run in a snapshot. Files without an extension are
 * unaffected because `.` is required before the suffix. */
const CREDENTIAL_NAME = /^(?:[a-z0-9]+[._-])*(?:secrets?|credentials?|tokens?|passwords?|cookies?)(?:[._-][a-z0-9]+)*\.(?:json|ya?ml|txt|env|ini|cfg|conf|pem|key|crt|log|xml|properties)$/i;
/** Whether one path segment is a name this service never shares. The exception for
 * a dotted template name is applied by `visible` after every segment has passed
 * this test, so an allowed template cannot smuggle a denylisted parent directory
 * (`secrets/.env.example`) or a credential-looking parent file back in. */
const deniesPart = (part: string): boolean => part.startsWith(".") || EXCLUDED.has(part.toLowerCase())
  || CREDENTIAL_NAME.test(part) || /^workspaces(?:\.|$)/i.test(part) || /^(?:auth|session)\.json$/i.test(part);
export function visible(path: string): boolean {
  const parts = path.split("/");
  if (parts.some(deniesPart)) {
    // One exception, and it is a documented template rather than a secret: the
    // single dotted name a project must be able to share for its own doc checks
    // (`.env.example`). Every parent segment still has to pass the test above, so
    // this only ever widens the file's own name.
    const name = parts.at(-1)!;
    return !parts.slice(0, -1).some(deniesPart) && !CREDENTIAL_NAME.test(name)
      && /^\.env(?:\.[a-z]+)*\.(?:example|sample|template|defaults|dist)$/i.test(name);
  }
  return true;
}
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".py", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".css", ".scss", ".html", ".vue", ".svelte", ".sql", ".toml", ".yaml", ".yml", ".sh", ".ps1", ".rb", ".php", ".swift", ".xml", ".graphql", ".proto"]);

export function textFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || /^(readme|license|makefile|dockerfile)$/i.test(basename(path));
}
export const readerConfigSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(120), root: z.string().min(1),
    share: z.array(z.string().min(1).max(500)).min(1).max(100)
  }).strict()).min(1).max(30)
}).strict();
type Project = z.infer<typeof readerConfigSchema>["projects"][number];
type Entry = { path: string; kind: "file" | "directory" };
/** One read returns at most this much text, so this bounds a single allocation and
 * keeps a huge generated file from consuming a whole search page. It is not the
 * editable-file budget: a file larger than this stays readable through search and
 * remains editable by anchor, and the refusal names its real size. */
export const READER_LIMITS = Object.freeze({ fileBytes: 512 * 1024, outputChars: 16_000, directoryEntries: 2_000, searchEntries: 2_000, searchFiles: 100, searchBytes: 4 * 1024 * 1024 });
/** One directory page. The default shape names each entry by its full shared path; the
 * compact shape (`metaOnly`) names it relative to the listed directory, because the
 * request already said which directory it is and repeating that prefix once per entry is
 * paid for in the caller's context on every later turn. `kind` stays in both shapes: a
 * caller cannot navigate without knowing what is a directory. */
export type DirectoryEntry = { path: string; kind: "file" | "directory" };
export type DirectoryPage = { project_id: string; path: string; entries: DirectoryEntry[]; next_after: string | null; truncated: boolean; scanned_entries: number; scope: string };
export type CompactDirectoryPage = { project_id: string; path: string; files: string[]; directories: string[]; next_after: string | null; truncated: boolean; scanned_entries: number; scope: string };
/** Literal search results, grouped by file so a path and its hash are stated once and
 * each hit is only a line number with its text. */
export type SearchResult = {
  project_id: string; query: string; match_count: number;
  files: { path: string; sha256: string; hits: { line: number; text: string }[] }[];
  attempted_files: number; searched_files: number; searched_bytes: number; scanned_entries: number;
  skipped_files: number; truncated: boolean; scope: string;
};
/** One page of a text file. `lines` is plain text with line endings removed: the
 * number of a line is its offset from `start_line`, so the payload carries no repeated
 * per-line wrapper. `next_start_line` is absent on the last page and `lines_truncated`
 * is absent unless a line was actually cut. */
export type ReadResult = {
  project_id: string; path: string; sha256: string; bytes: number; encoding: string | null;
  total_lines: number; start_line: number; lines: string[];
  next_start_line?: number; lines_truncated?: number[]; meta_only?: true;
};

export class ProjectReader {
  private constructor(private readonly projects: Project[]) {}
  static async create(raw: unknown): Promise<ProjectReader> {
    const config = readerConfigSchema.parse(raw);
    const ids = new Set<string>();
    const projects: Project[] = [];
    for (const project of config.projects) {
      if (ids.has(project.id)) throw new ReaderError("CONFIG_INVALID", "Duplicate project id");
      ids.add(project.id);
      if (!isAbsolute(project.root)) throw new ReaderError("CONFIG_INVALID", "Project roots must be absolute");
      for (const path of project.share) {
        parts(path, true);
        if (path !== "." && !visible(path)) throw new ReaderError("CONFIG_INVALID", "Shared paths cannot include excluded names");
      }
      const root = await realpath(project.root);
      if (!(await lstat(root)).isDirectory()) throw new ReaderError("CONFIG_INVALID", "Project root must be a directory");
      projects.push({ ...project, root });
    }
    return new ProjectReader(projects);
  }
  listProjects() {
    return { projects: this.projects.map(({ id, name, share }) => ({ project_id: id, name, shared_paths: [...share] })), read_only: true, limits: READER_LIMITS };
  }
  private project(id: string): Project {
    const found = this.projects.find((project) => project.id === id);
    if (!found) throw new ReaderError("PROJECT_UNKNOWN", "Project is not registered");
    return found;
  }
  private shared(project: Project, path: string, ancestor: boolean): boolean {
    return project.share.some((prefix) => prefix === "." || prefix === path || path.startsWith(prefix + "/")
      || (ancestor && (path === "." || prefix.startsWith(path + "/"))));
  }
  private async checked(project: Project, path: string, ancestor = false): Promise<string> {
    const components = parts(path, ancestor);
    if ((path !== "." && !visible(path)) || !this.shared(project, path, ancestor)) return deny();
    if (await realpath(project.root) !== project.root) return deny("Project root changed; restart with reviewed configuration");
    let current = project.root;
    for (const component of components) {
      current = join(current, component);
      if ((await lstat(current)).isSymbolicLink()) return deny("Symbolic links and junctions are not shared");
    }
    const rel = relative(project.root, await realpath(current));
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return deny();
    return current;
  }
  private async entries(project: Project, path: string, budget: number = READER_LIMITS.directoryEntries): Promise<{ entries: Entry[]; scanned: number; truncated: boolean }> {
    const directory = await this.checked(project, path, true);
    if (!(await lstat(directory)).isDirectory()) throw new ReaderError("NOT_DIRECTORY", "Expected a directory");
    const entries: Entry[] = [];
    let scanned = 0, truncated = false;
    const dir = await opendir(directory);
    for await (const item of dir) {
      if (scanned >= budget) { truncated = true; break; }
      scanned++;
      const child = path === "." ? item.name : `${path}/${item.name}`;
      try { parts(child); } catch { continue; }
      if (!visible(child) || item.isSymbolicLink() || !this.shared(project, child, item.isDirectory())) continue;
      if (item.isDirectory()) entries.push({ path: child, kind: "directory" });
      else if (item.isFile() && textFile(child)) entries.push({ path: child, kind: "file" });
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { entries, scanned, truncated };
  }
  /** `metaOnly` drops the parent prefix that every entry repeats and returns the names
   * alone. The caller already said which directory it is listing, so repeating it once
   * per entry is paid for in the caller's context on every later turn of the
   * conversation. `kind` stays: a caller cannot navigate without knowing what is a
   * directory. Cursors are bare names in this mode and full paths otherwise. */
  async listFiles(id: string, path?: string, after?: string, limit?: number, metaOnly?: false): Promise<DirectoryPage>;
  async listFiles(id: string, path: string, after: string | undefined, limit: number | undefined, metaOnly: true): Promise<CompactDirectoryPage>;
  async listFiles(id: string, path: string, after: string | undefined, limit: number | undefined, metaOnly: boolean): Promise<DirectoryPage | CompactDirectoryPage>;
  async listFiles(id: string, path = ".", after?: string, limit = 100, metaOnly = false): Promise<DirectoryPage | CompactDirectoryPage> {
    const result = await this.entries(this.project(id), path);
    const cursor = after === undefined ? undefined : metaOnly && path !== "." && !after.includes("/") ? `${path}/${after}` : after;
    const remaining = result.entries.filter((entry) => cursor === undefined || entry.path > cursor);
    const page: Entry[] = [];
    let chars = 0;
    // The read limit bounds what a caller pays for; only the entries are chargeable.
    const budget = metaOnly ? READER_LIMITS.outputChars - 512 : READER_LIMITS.outputChars;
    for (const entry of remaining) {
      if (page.length >= limit || chars + entry.path.length > budget) break;
      page.push(entry); chars += entry.path.length;
    }
    const next = remaining.length > page.length ? page.at(-1)?.path ?? null : null;
    if (!metaOnly) return { project_id: id, path, entries: page, next_after: next, truncated: result.truncated, scanned_entries: result.scanned, scope: "shared text files; excluded names and links omitted" };
    // Names alone, split by kind: an entry costs only its own name, because the keys
    // ("path", "kind") and the repeated directory prefix are both stated once.
    const prefix = path === "." ? "" : `${path}/`;
    const bare = (value: string) => prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
    return { project_id: id, path, files: page.filter(entry => entry.kind === "file").map(entry => bare(entry.path)),
      directories: page.filter(entry => entry.kind === "directory").map(entry => bare(entry.path)),
      next_after: next === null ? null : bare(next), truncated: result.truncated, scanned_entries: result.scanned,
      scope: `names relative to ${path}, files and directories listed separately; excluded names and links omitted; listing carries no hashes, so read a file before editing it` };
  }
  private async text(project: Project, path: string) {
    // Containment is decided BEFORE the extension rule. Reversed, a path that escapes the
    // project was answered with "Only supported text files are shared" whenever its extension
    // was unsupported, so a caller that had tried to read outside the project was told it had a
    // file-format problem — reported by a real client testing `..\..\Windows\win.ini`, which
    // was refused for the wrong stated reason. The boundary is the more important answer.
    const filename = await this.checked(project, path);
    if (!textFile(path)) throw new ReaderError("FILE_TYPE_DENIED", "Only supported text files are shared");
    // Reject FIFOs/devices before open(), which can otherwise block indefinitely.
    if (!(await lstat(filename)).isFile()) throw new ReaderError("FILE_TYPE_DENIED", "Only regular files are shared");
    const handle = await open(filename, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new ReaderError("FILE_TYPE_DENIED", "Only regular, single-link files are shared");
      if (stat.size > READER_LIMITS.fileBytes) throw new ReaderError("FILE_TOO_LARGE", "File exceeds the bounded read limit");
      // A fixed buffer bounds reads even if the file grows after stat().
      const buffer = Buffer.alloc(READER_LIMITS.fileBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > READER_LIMITS.fileBytes) throw new ReaderError("FILE_TOO_LARGE", "File exceeds the bounded read limit");
      await this.checked(project, path);
      const bytes = buffer.subarray(0, count);
      // Windows projects mix UTF-8 and legacy code pages in one tree; a file that
      // still cannot be decoded stays unreadable rather than being corrupted.
      const source = detectSource(bytes);
      if (source.encoding === null || source.text === null) throw new ReaderError("NON_TEXT_FILE", "File is binary or uses an unrecognized text encoding");
      return { content: source.text, encoding: source.encoding, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: count };
    } finally { await handle.close(); }
  }
  async readFile(id: string, path: string, start = 1, count = 100, expectedHash?: string, metaOnly = false): Promise<ReadResult> {
    const file = await this.text(this.project(id), path);
    if (expectedHash && expectedHash !== file.sha256) throw new ReaderError("FILE_CHANGED", "File changed; read again from the first page");
    const all = file.content.length ? file.content.split(/\r\n|\n|\r/) : [];
    // Every character here is replayed in the caller's context on every later turn, so
    // the payload carries text and nothing else: the line number is the index in this
    // array, and a line is only marked when it was actually cut. Wrapping each line in
    // {"number":n,"text":…,"truncated":false} cost about 26 bytes per line for data the
    // caller already knows.
    const lines: string[] = [];
    const clipped: number[] = [];
    let chars = 0;
    if (!metaOnly) for (let index = start - 1; index < all.length && lines.length < count && chars < READER_LIMITS.outputChars; index++) {
      const source = all[index]!;
      const room = READER_LIMITS.outputChars - chars;
      if (source.length <= room) { lines.push(source); chars += source.length + 1; continue; }
      const text = source.slice(0, room);
      // Offset by the caller's own line numbering, not this page's.
      clipped.push(index + 1);
      lines.push(text);
      chars += text.length + 1;
    }
    const next = !metaOnly && lines.length && start + lines.length <= all.length ? start + lines.length : null;
    const result: ReadResult = { project_id: id, path, sha256: file.sha256, bytes: file.bytes, encoding: file.encoding,
      total_lines: all.length, start_line: start, lines };
    // Absent means "the obvious value": no next page, nothing cut, nothing omitted.
    if (next !== null) result.next_start_line = next;
    if (clipped.length) result.lines_truncated = clipped;
    if (metaOnly) result.meta_only = true;
    return result;
  }
  async search(id: string, query: string, path = ".", limit = 30): Promise<SearchResult> {
    const project = this.project(id);
    // Grouped by file: the path and its hash are stated once, and each hit is just a
    // line number with its text. Repeating a 64-character sha256 on every hit cost
    // more than the matched lines themselves.
    const groups: { path: string; sha256: string; hits: { line: number; text: string }[] }[] = [];
    const byPath = new Map<string, { path: string; sha256: string; hits: { line: number; text: string }[] }>();
    let total = 0;
    let scannedEntries = 0, attemptedFiles = 0, searchedFiles = 0, searchedBytes = 0, skippedFiles = 0, outputChars = 0;
    let truncated = false;
    const queue = [path];
    while (queue.length) {
      if (scannedEntries >= READER_LIMITS.searchEntries || attemptedFiles >= READER_LIMITS.searchFiles || total >= limit
        || searchedBytes + READER_LIMITS.fileBytes > READER_LIMITS.searchBytes) { truncated = true; break; }
      const current = queue.pop()!;
      const filename = await this.checked(project, current, true);
      if ((await lstat(filename)).isDirectory()) {
        const result = await this.entries(project, current, READER_LIMITS.searchEntries - scannedEntries);
        scannedEntries += result.scanned;
        truncated ||= result.truncated;
        queue.push(...result.entries.map((entry) => entry.path).reverse());
        continue;
      }
      attemptedFiles++;
      try {
        const file = await this.text(project, current);
        searchedFiles++;
        searchedBytes += file.bytes;
        const lines = file.content.split(/\r\n|\n|\r/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const at = line.indexOf(query);
          if (at < 0) continue;
          if (total >= limit) { truncated = true; break; }
          const from = Math.max(0, at - 80);
          const snippet = line.slice(from, from + 300);
          if (outputChars + current.length + snippet.length > READER_LIMITS.outputChars) {
            truncated = true;
            queue.length = 0;
            break;
          }
          outputChars += current.length + snippet.length;
          let group = byPath.get(current);
          if (!group) { group = { path: current, sha256: file.sha256, hits: [] }; byPath.set(current, group); groups.push(group); }
          group.hits.push({ line: i + 1, text: snippet });
          total++;
        }
      } catch (error) {
        if (!(error instanceof ReaderError) && !(error instanceof Error && "code" in error)) throw error;
        skippedFiles++;
      }
    }
    return { project_id: id, query, match_count: total, files: groups, attempted_files: attemptedFiles, searched_files: searchedFiles, searched_bytes: searchedBytes, scanned_entries: scannedEntries,
      skipped_files: skippedFiles, truncated: truncated || skippedFiles > 0, scope: "shared text files only; literal case-sensitive search" };
  }
}
