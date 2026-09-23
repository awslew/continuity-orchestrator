import { execFile } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { ReaderError, visible } from "./service.js";
import { sourceFile, type SourceFile } from "./encoding.js";

const execute = promisify(execFile);
const failure = (code: string, message: string): never => { throw new ReaderError(code, message); };
/** Shared-path containment. "." means the whole project; otherwise the entry or
 * one of its ancestors must be the shared path. */
export const contains = (prefixes: readonly string[], path: string, ancestor = false) =>
  prefixes.some(prefix => prefix === "." || prefix === path || path.startsWith(prefix + "/") || ancestor && prefix.startsWith(path + "/"));
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith(".." + sep) && rel !== ".." && !rel.includes(":" + sep) && !/^[a-zA-Z]:(?:[\\/]|$)/.test(rel);
};
/** Generated trees are skipped by name for non-Git projects only. Git projects
 * let .gitignore decide, which is the authority the user already maintains. Only
 * names that are always caches or package stores are listed here: a project may
 * legitimately keep source in vendor/, dist/ or target/. */
const GENERATED_DIRECTORIES = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".turbo", ".cache", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", ".vs", ".tox", ".svelte-kit", "dist", "build"]);
export type OmissionReason =
  | "HIDDEN_PATH" | "BINARY_OR_UNKNOWN_ENCODING" | "FILE_LIMIT" | "LINK" | "NOT_A_REGULAR_FILE" | "MULTIPLE_HARD_LINKS" | "MISSING";
export type Omission = { path: string; reason: OmissionReason; bytes: number | null };
/** The full omission list can be large; the count always stays exact. */
export const MAX_LISTED_OMISSIONS = 400;
export type SnapshotScope = {
  source: "git_index_and_untracked" | "directory_scan";
  scope_note: string;
  entry_count: number;
  captured_files: number;
  captured_bytes: number;
  omissions_total: number;
  listed_omissions: number;
  omissions_truncated: boolean;
  git: { available: boolean; head: string | null; ignored_paths_excluded: boolean; reason: string | null };
};
export type ProjectSnapshot = { files: Map<string, SourceFile>; omissions: Omission[]; scope: SnapshotScope };
export type SnapshotLimits = { totalBytes: number; totalFiles: number; fileBytes: number };

const GIT_ENV = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
/** Read-only Git queries. Hooks, index refresh and optional locks are disabled so
 * observing a project can never write to the user's repository. */
export async function projectGit(root: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  return execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "core.quotepath=false", "-C", root, ...args], { timeout: 20000, maxBuffer, windowsHide: true, env: GIT_ENV() });
}
const gitReady = async (root: string) => { try { await projectGit(root, ["rev-parse", "--git-dir"]); return true; } catch { return false; } };
const gitHead = async (root: string) => { try { return (await projectGit(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim() || null; } catch { return null; } };
/** A directory with many untracked entries makes `--others` unbounded, so the
 * scan falls back instead of pulling enormous generated trees into memory. */
async function untrackedVolumeIsBounded(root: string, limit: number): Promise<boolean> {
  try {
    const status = (await projectGit(root, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no"], 8 * 1024 * 1024)).stdout;
    let untracked = 0;
    for (const line of status.split("\n")) if (line.startsWith("?? ")) untracked++;
    return untracked <= limit;
  } catch { return false; }
}
const fileKind = (stat: { isFile: () => boolean; nlink: number }) => !stat.isFile() ? "NOT_A_REGULAR_FILE" : stat.nlink !== 1 ? "MULTIPLE_HARD_LINKS" : null;
async function readBounded(path: string, max: number): Promise<{ bytes: Buffer; reason: OmissionReason | null }> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const kind = fileKind(stat);
    if (kind) return { bytes: Buffer.alloc(0), reason: kind };
    if (stat.size > max) return { bytes: Buffer.alloc(0), reason: "FILE_LIMIT" };
    // A fixed buffer bounds the read even if the file grows after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count > max) return { bytes: Buffer.alloc(0), reason: "FILE_LIMIT" };
    return { bytes: buffer.subarray(0, count), reason: null };
  } finally { await handle.close(); }
}

/** Snapshot the shared source of one project as raw bytes, using the Git-visible
 * file set when the project is a repository. Ignored, hidden, binary and
 * oversized paths are recorded as omissions so a development round can report
 * exactly what it did not copy, instead of failing or pretending completeness. */
export async function snapshotProject(root: string, share: readonly string[], limits: SnapshotLimits): Promise<ProjectSnapshot> {
  const files = new Map<string, SourceFile>(), omissions: Omission[] = [];
  if (await realpath(root) !== root) failure("PATH_DENIED", "Project root changed");
  let totalBytes = 0, entries = 0, omitted = 0;
  const budget = () => { if (files.size >= limits.totalFiles) failure("SNAPSHOT_LIMIT", `Source snapshot exceeds ${limits.totalFiles} files; narrow the shared paths or raise limits.total_files`); };
  const add = async (path: string, reason: OmissionReason, bytes: number | null) => {
    if (++entries > limits.totalFiles * 25 + 20000) failure("SNAPSHOT_LIMIT", "Source snapshot scan exceeds the entry budget; narrow the shared paths");
    if (omissions.length < MAX_LISTED_OMISSIONS) omissions.push({ path, reason, bytes });
    else omitted++;
  };
  const capture = async (path: string): Promise<void> => {
    const target = join(root, ...path.split("/"));
    let stat;
    try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return add(path, "MISSING", null); throw error; }
    if (stat.isSymbolicLink()) return add(path, "LINK", null);
    const kind = fileKind(stat);
    if (kind) return add(path, kind, stat.isFile() ? stat.size : null);
    if (stat.size > limits.fileBytes) return add(path, "FILE_LIMIT", stat.size);
    if (!inside(root, await realpath(target))) failure("PATH_DENIED", "Snapshot path escaped project");
    const read = await readBounded(target, limits.fileBytes);
    if (read.reason) return add(path, read.reason, stat.size);
    const file = sourceFile(path, read.bytes);
    if (file.encoding === null) return add(path, "BINARY_OR_UNKNOWN_ENCODING", file.bytes.length);
    budget();
    totalBytes += file.bytes.length;
    if (totalBytes > limits.totalBytes) failure("SNAPSHOT_LIMIT", `Source snapshot exceeds ${Math.round(limits.totalBytes / 1024 / 1024)} MiB; narrow the shared paths or raise limits.total_bytes`);
    files.set(path, file);
  };
  const walk = async (dir: string) => {
    const target = dir ? join(root, dir) : root;
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !inside(root, await realpath(target))) failure("PATH_DENIED", "Snapshot directory changed");
    if (dir && GENERATED_DIRECTORIES.has(dir.split("/").at(-1)!.toLowerCase())) return;
    for (const item of await readdir(target, { withFileTypes: true })) {
      const path = dir ? `${dir}/${item.name}` : item.name;
      if (!visible(path)) { await add(path, "HIDDEN_PATH", null); continue; }
      if (!contains(share, path, item.isDirectory())) continue;
      if (item.isSymbolicLink()) { await add(path, "LINK", null); continue; }
      if (item.isDirectory()) { await walk(path); continue; }
      if (!item.isFile()) { await add(path, "NOT_A_REGULAR_FILE", null); continue; }
      await capture(path);
    }
  };
  let source: SnapshotScope["source"] = "directory_scan";
  let scopeNote = "Directory scan of the shared paths; generated and hidden directories are excluded by name.";
  let git = { available: false, head: null as string | null, ignored_paths_excluded: false, reason: null as string | null };
  if (await gitReady(root)) {
    const listable: string[] = [];
    let scoped = true;
    for (const prefix of share) {
      try { listable.push(...(await projectGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", prefix])).stdout.split("\0").filter(Boolean)); }
      catch { scoped = false; break; }
    }
    // An empty listing means Git knows nothing about this share, so it is outside
    // the repository (or entirely ignored): fall back instead of copying nothing.
    if (scoped && listable.length > 0 && await untrackedVolumeIsBounded(root, 2000)) {
      source = "git_index_and_untracked";
      scopeNote = "Git index plus untracked non-ignored files; .gitignore is authoritative, so ignored generated output (videos, databases, build directories) is not copied.";
      git = { available: true, head: await gitHead(root), ignored_paths_excluded: true, reason: null };
      for (const path of [...new Set(listable)].sort()) {
        const normalized = path.split("\\").join("/");
        if (!normalized || normalized.split("/").some(part => !part || part === "." || part === "..")) continue;
        if (!contains(share, normalized, true)) continue;
        if (!visible(normalized)) { await add(normalized, "HIDDEN_PATH", null); continue; }
        await capture(normalized);
      }
    } else git = { available: true, head: await gitHead(root), ignored_paths_excluded: false, reason: "Git file listing unavailable or unbounded; a directory scan was used, so .gitignore exclusions are by name only" };
  }
  if (source === "directory_scan") await walk("");
  return { files, omissions, scope: { source, scope_note: scopeNote, entry_count: entries, captured_files: files.size, captured_bytes: totalBytes, omissions_total: omissions.length + omitted, listed_omissions: omissions.length, omissions_truncated: omitted > 0, git } };
}
