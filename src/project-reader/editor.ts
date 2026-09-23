import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { z } from "zod";
import { parts, visible, textFile, ReaderError, readerConfigSchema } from "./service.js";
import { checkpoint, readCheckpoint, audit, digest, checkpointEntry, type CheckpointFiles } from "./checkpoint.js";
import { EDITABLE_FILE_BYTES, encodeForEdit, encodeSource, sha256, sourceFile, type SourceEncoding, type SourceFile } from "./encoding.js";
import { contains, inside, projectGit, snapshotProject, type Omission, type ProjectSnapshot, type SnapshotLimits } from "./snapshot.js";
import { RoundRunner, StateLock, processAlive, workerOver, workerRunning, workerStale, stopReason, crashReason, atomicWrite, tolerantRead, type RunnerPhase } from "./runner.js";

export const sha = z.string().regex(/^[a-f0-9]{64}$/);
/** Replacement content stays bounded because it travels through the Chat
 * protocol; snapshot limits are separate and deliberately larger so generated
 * files cannot block unrelated development. */
const CONTENT_BYTES = 512 * 1024;
/** What one CALL may carry. These are budgets, not policy: they exist so a run stops
 * producing evidence instead of exhausting memory, and they are far above any real
 * round. Nothing here is a platform requirement, so nothing here may be tightened to
 * "keep rounds small" — a smaller round just costs the user another conversation. */
const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_TEXT_BYTES = 32 * 1024 * 1024;
export const MAX_CHANGES_PER_CALL = 10_000;
export const snapshotLimitsSchema = z.object({
  total_bytes: z.number().int().min(1024 * 1024).max(512 * 1024 * 1024).default(64 * 1024 * 1024),
  total_files: z.number().int().min(10).max(200000).default(8000),
  file_bytes: z.number().int().min(1024).max(256 * 1024 * 1024).default(32 * 1024 * 1024)
}).strict();
/** One file change. `content` replaces the whole file (null deletes it). `anchor`
 * replaces one exact occurrence instead, which is what a large file needs: quoting
 * the whole file back through the Chat protocol is the dominant context cost of a
 * round, and a local edit only has to quote itself. Exactly one of the two must be
 * present; that rule is enforced per change in `propose` so the error names the
 * path instead of failing a whole batch as a schema error. */
export const anchorSchema = z.object({
  old_string: z.string().min(1).max(MAX_EDIT_TEXT_BYTES),
  new_string: z.string().max(MAX_EDIT_TEXT_BYTES),
  replace_all: z.boolean().default(false)
}).strict();
/** What the caller sends: whole-file content, or one anchored edit. */
export const authoredChangeSchema = z.object({ path: z.string().min(1).max(500), expected_sha256: sha.nullable(), content: z.string().max(MAX_EDIT_TEXT_BYTES).nullable().optional(), anchor: anchorSchema.optional() }).strict();
/** What this service retains and reasons about: final text only. */
export const changeSchema = z.object({ path: z.string().min(1).max(500), expected_sha256: sha.nullable(), content: z.string().max(MAX_EDIT_TEXT_BYTES).nullable() }).strict();
export const editorConfigSchema = z.object({
  state_dir: z.string().refine(isAbsolute),
  workspaces: z.array(z.object({ project_id: z.string().min(1), writable_paths: z.array(z.string()).min(1), limits: snapshotLimitsSchema.optional(),
    validation: z.array(z.object({ name: z.string().min(1).max(100), argv: z.array(z.string().min(1)).min(1).max(200), timeout_seconds: z.number().int().min(1).max(3600).default(60) }).strict()).min(1).max(50)
  }).strict()).min(1).max(30)
}).strict();
export const EDIT_SCHEMAS = {
  continuity_edit_propose: z.object({ project_id: z.string().min(1), changes: z.array(authoredChangeSchema).min(1).max(MAX_CHANGES_PER_CALL) }).strict(),
  continuity_edit_validate: z.object({ task_id: z.string().uuid() }).strict(),
  continuity_edit_apply: z.object({ task_id: z.string().uuid(), confirmation: z.literal("APPLY") }).strict(),
  continuity_edit_result: z.object({ task_id: z.string().uuid() }).strict(),
  continuity_edit_cancel: z.object({ task_id: z.string().uuid() }).strict()
};
type Config = z.infer<typeof editorConfigSchema>;
type Project = z.infer<typeof readerConfigSchema>["projects"][number];
type Change = z.infer<typeof changeSchema>;
/** A change as the caller authorizes it: exactly one of content/anchor, unchecked. */
type AuthoredChange = z.infer<typeof authoredChangeSchema>;
type Report = z.infer<typeof reportSchema>;
const defaultLimits: SnapshotLimits = { totalBytes: 64 * 1024 * 1024, totalFiles: 8000, fileBytes: 32 * 1024 * 1024 };
/** Omitted paths cannot be restored or validated byte for byte, so editing them
 * would silently change a file the snapshot never verified. Each reason is
 * reported so a round can explain exactly what it did not copy. */
export const OMISSION_REASONS: Record<Omission["reason"], string> = {
  HIDDEN_PATH: "hidden or excluded by name",
  BINARY_OR_UNKNOWN_ENCODING: "binary or an unrecognized text encoding",
  FILE_LIMIT: "larger than the per-file snapshot budget",
  LINK: "a link, which is never followed",
  NOT_A_REGULAR_FILE: "not a regular file",
  MULTIPLE_HARD_LINKS: "a file with multiple hard links",
  MISSING: "listed by Git but missing on disk"
};
const reportSchema = z.object({ name: z.string(), exit_code: z.number().nullable(), timed_out: z.boolean(), cancelled: z.boolean(), termination_confirmed: z.boolean().default(true), output: z.string(), output_truncated: z.boolean() }).strict();
const taskSchema = z.object({ id: z.string().uuid(), project_id: z.string(), created_at: z.string(), base_fingerprint: sha,
  changes: z.array(changeSchema), before: z.record(z.string().nullable()),
  // "rolling_back", "recovered" and "recovery_required" are real persisted states;
  // omitting them here would fail closed on every restart after an interruption.
  state: z.enum(["proposed", "validating", "pass", "fail", "cancelled", "applying", "applied", "rolling_back", "rolled_back", "recovered", "recovery_required"]),
  reports: z.array(reportSchema), validation_session: z.string().nullable(), error: z.string().nullable(),
  snapshot_omissions: z.array(z.object({ path: z.string(), reason: z.string(), bytes: z.number().nullable().optional() }).strict()).optional(),
  snapshot_scope: z.object({ source: z.string(), captured_files: z.number(), captured_bytes: z.number(), omissions_total: z.number(), ignored_paths_excluded: z.boolean(), omissions_truncated: z.boolean().optional() }).strict().optional(),
  development: z.object({ request_id: z.string(), request_hash: sha, goal: z.string(), checkpoint: z.object({ repository: z.string(), before_commit: z.string(), candidate_commit: z.string() }).nullable(), validation: editorConfigSchema.shape.workspaces.element.shape.validation.optional() }).optional()
}).strict();
type Task = z.infer<typeof taskSchema>;
const storeSchema = z.object({ version: z.literal(1), scope: sha, tasks: z.array(taskSchema).max(200) }).strict();
/** Key order must not matter: the same task rebuilt by two processes is not written with
 * its keys in the same order, and a digest that changed for that reason would make every
 * task look locally modified. */
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) ?? "null"
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
/** One task's content digest; see `ProjectEditor.digests`. */
const taskDigest = (task: Task) => createHash("sha256").update(canonical(task)).digest("hex");
const failure: (code: string, message: string) => never = (code, message) => { throw new ReaderError(code, message); };

/** Tasks retain originals as text plus the exact bytes in base64: text keeps the
 * checkpoint readable and reviewable, bytes keep restoration exact for files
 * whose encoding cannot be reproduced from text alone. Format: s<base64> or b<base64>. */
export function serializeSource(file: SourceFile): string {
  return (file.encoding === null ? "b" : "s") + file.bytes.toString("base64");
}
export function parseSerializedSource(path: string, value: string): SourceFile {
  if (!/^[sb][A-Za-z0-9+/]*={0,2}$/.test(value)) failure("STATE_INVALID", "Retained original file record is invalid");
  const bytes = Buffer.from(value.slice(1), "base64");
  if (bytes.length === 0 && value.length > 1) failure("STATE_INVALID", "Retained original file record is not valid base64");
  return sourceFile(path, bytes);
}
export function rawText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const file = parseSerializedSource("retained", value);
  return file.encoding === null ? null : file.text;
}
const lineEnding = (value: string): "\r\n" | "\n" | null => {
  const crlf = (value.match(/\r\n/g) ?? []).length, lf = (value.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf === 0) return "\r\n";
  if (lf > 0 && crlf === 0) return "\n";
  return null;
};
const occurrences = (haystack: string, needle: string): number => {
  let count = 0, from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++; from = at + needle.length;
  }
};
/** Apply one anchored edit to the file's current text. Matching is literal, and a
 * line-ending difference is bridged only when both sides are internally uniform,
 * so a Windows file written with CRLF can be edited by an anchor assembled from a
 * paginated read without ever loosening the match to "any whitespace". An edit that
 * needed that bridge is written back with the file's own line ending, so quoting an
 * anchor never silently converts a file's endings. */
export function applyAnchor(current: string, anchor: z.infer<typeof anchorSchema>): string {
  const currentEnding = lineEnding(current), anchorEnding = lineEnding(anchor.new_string) ?? lineEnding(anchor.old_string);
  let text = current, needle = anchor.old_string, replaced = anchor.new_string, matched = occurrences(text, needle) > 0;
  // Bridge only uniform-against-uniform, and only when the literal match failed:
  // a mixed-ending file is never normalized, so an anchor cannot slip past an
  // accidental whitespace difference there.
  if (!matched && lineEnding(needle) !== null && currentEnding !== null && lineEnding(needle) !== currentEnding) {
    const normalize = (value: string) => value.split("\r\n").join("\n");
    text = normalize(current); needle = normalize(anchor.old_string); replaced = normalize(anchor.new_string);
    matched = occurrences(text, needle) > 0;
  }
  const found = occurrences(text, needle);
  if (found === 0) return failure("ANCHOR_NOT_FOUND", "anchor.old_string does not appear in the current file; reread it and quote the exact text, including indentation");
  if (found > 1 && !anchor.replace_all) return failure("ANCHOR_AMBIGUOUS", `anchor.old_string appears ${found} times; quote a longer unique span, or set replace_all: true to replace every occurrence`);
  const updated = anchor.replace_all ? text.split(needle).join(replaced) : text.replace(needle, replaced);
  // Restore the file's own convention only when the bridge actually normalized it.
  // Normalize to LF first: joining "\n" onto text that still holds CRLF is how a
  // well-meant ending conversion turns every "\r\n" into "\r\r\n".
  if (!matched || currentEnding === null) return updated;
  const lf = updated.split("\r\n").join("\n");
  return currentEnding === "\r\n" ? lf.split("\n").join("\r\n") : lf;
}
/** Turn every change into final text. Anchored changes are resolved against the
 * file's current bytes here, so checkpointing, validation and application all keep
 * operating on complete content and never have to know how it was expressed. Callers
 * use this one entry point; `resolveAgainstDrafts` is the same walk over a short-lived
 * view of what this call has written so far. */
export async function resolveChanges(changes: AuthoredChange[], read: (path: string) => Promise<SourceFile | null>): Promise<Change[]> {
  return resolveAgainstDrafts(changes, read);
}
async function resolveAgainstDrafts(changes: AuthoredChange[], read: (path: string) => Promise<SourceFile | null>): Promise<Change[]> {
  // Keyed by lowercased path, matching the duplicate rule in propose. `drafts` holds
  // the text this call has produced so far, in bytes-as-text terms, so an anchor or a
  // deletion can be resolved against the running result instead of the file on disk.
  const drafts = new Map<string, { text: string | null; encoding: SourceEncoding }>();
  const resolved: Change[] = [];
  for (const change of changes) {
    if (change.content !== undefined && change.anchor !== undefined) failure("INPUT_INVALID", `${change.path}: supply either content or anchor, not both`);
    if (change.content === undefined && change.anchor === undefined) failure("INPUT_INVALID", `${change.path}: supply content (whole file, null deletes) or anchor (old_string/new_string)`);
    const key = change.path.toLowerCase(), anchor = change.anchor;
    // What a change must expect: the bytes the previous change to this path left
    // behind, so a second change to one path is checked against the running result
    // rather than the disk. A first change keeps the caller's own expectation.
    const previous = drafts.get(key);
    const expectation = previous === undefined
      ? { expected_sha256: change.expected_sha256, encoding: undefined as SourceEncoding | undefined }
      : { expected_sha256: previous.text === null ? null : sha256(encodeSource(previous.text, previous.encoding)), encoding: previous.encoding };
    if (anchor === undefined) {
      const content = change.content ?? null;
      // A creation is written as UTF-8; a replacement keeps the file's own encoding.
      const encoding = expectation.encoding ?? (content === null ? "utf8" : (await read(change.path))?.encoding ?? "utf8");
      if (content !== null) drafts.set(key, { text: content, encoding }); else drafts.delete(key);
      resolved.push({ path: change.path, expected_sha256: expectation.expected_sha256, content });
      continue;
    }
    const file = previous === undefined ? await read(change.path) : null;
    const text: string | null = previous?.text ?? file?.text ?? null;
    if (text === null) {
      failure("NO_CHANGE", `${change.path} does not exist and no earlier change in this call writes it; an anchor cannot create a file, so send content first`);
    } else {
      if (Buffer.byteLength(anchor.new_string, "utf8") > MAX_EDIT_TEXT_BYTES) failure("FILE_LIMIT", `${change.path}: anchor.new_string must be at most ${Math.round(MAX_EDIT_TEXT_BYTES / 1024 / 1024)} MiB of UTF-8 text`);
      const updated = applyAnchor(text, anchor);
      drafts.set(key, { text: updated, encoding: expectation.encoding ?? file?.encoding ?? "utf8" });
      resolved.push({ path: change.path, expected_sha256: expectation.expected_sha256, content: updated });
    }
  }
  return resolved;
}
/** Retained original bytes of one change, or null when the change creates a file. */
export const originalFor = (path: string, retained: string | null): SourceFile | null =>
  retained === null ? null : parseSerializedSource(path, retained);
/** The bytes a change would write: edited text re-encoded in the file's own
 * encoding, and UTF-8 for files this round creates. */
export const proposedBytes = (path: string, retained: string | null, content: string | null): Buffer | null =>
  content === null ? null : encodeForEdit(path, content, originalFor(path, retained)?.encoding ?? "utf8");
/** Readable text plus exact bytes for one side of a change, as stored privately. */
const checkpointSide = (path: string, retained: string | null, content: string | null): ReturnType<typeof checkpointEntry> | null => {
  if (content === null) return null;
  const file = sourceFile(path, proposedBytes(path, retained, content)!);
  return checkpointEntry(serializeSource(file), file.encoding, file.text);
};
const retainedSide = (path: string, retained: string | null): ReturnType<typeof checkpointEntry> | null => {
  if (retained === null) return null;
  const file = parseSerializedSource(path, retained);
  return checkpointEntry(retained, file.encoding, file.text);
};

/** A compact unified diff of one change: three lines of context around each edit, and
 * caps on both the number of hunks and the characters emitted. The caller uses this to
 * confirm what landed without paying to re-read whole files, which is the most
 * expensive habit a Chat session can have. */
const DIFF_HUNK_CONTEXT = 3, DIFF_MAX_HUNKS = 6, DIFF_MAX_CHARS = 2000;
export function changeDiff(before: string | null, after: string | null): string | null {
  if (before === null && after === null) return null;
  const oldLines = before === null ? [] : before.split(/\r\n|\n|\r/);
  const newLines = after === null ? [] : after.split(/\r\n|\n|\r/);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let tail = 0;
  while (tail < oldLines.length - start && tail < newLines.length - start && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const removed = oldLines.slice(start, oldLines.length - tail);
  const added = newLines.slice(start, newLines.length - tail);
  if (!removed.length && !added.length) return null;
  const from = Math.max(0, start - DIFF_HUNK_CONTEXT);
  const to = Math.min(newLines.length, start + Math.max(added.length, removed.length) + DIFF_HUNK_CONTEXT);
  const body: string[] = [`@@ line ${from + 1}`];
  const head = oldLines.slice(from, Math.min(start, oldLines.length));
  for (const line of head) body.push(` ${line}`);
  for (const line of removed.slice(0, DIFF_MAX_HUNKS * 40)) body.push(`-${line}`);
  if (removed.length > DIFF_MAX_HUNKS * 40) body.push(`-… ${removed.length - DIFF_MAX_HUNKS * 40} more removed lines`);
  for (const line of added.slice(0, DIFF_MAX_HUNKS * 40)) body.push(`+${line}`);
  if (added.length > DIFF_MAX_HUNKS * 40) body.push(`+… ${added.length - DIFF_MAX_HUNKS * 40} more added lines`);
  // Trailing context comes from the first common line after the edit.
  const afterContext = oldLines.slice(oldLines.length - tail, oldLines.length - tail + DIFF_HUNK_CONTEXT);
  for (const line of afterContext) body.push(` ${line}`);
  const text = body.join("\n");
  return text.length > DIFF_MAX_CHARS ? `${text.slice(0, DIFF_MAX_CHARS)}\n… diff truncated` : text;
}

/** Source snapshots and optimistic file hashes support dirty and non-Git roots.
 * This is a trusted local developer service, not a sandbox against local processes. */
export class ProjectEditor {
  private tasks = new Map<string, Task>();
  private session = randomUUID();
  private busy = false;
  private closing = false;
  private closed = false;
  private active: { id: string; abort: AbortController; done: Promise<void> } | undefined;
  private repositories = new Map<string, boolean>();
  /** What this instance last wrote or read, so a teammate process's write can be
   * noticed instead of overwritten. The value is opaque: it is compared, never parsed. */
  private revision: string | null = null;
  /** The revision at which this instance last wrote each task, and therefore the tasks it
   * owns. A task it wrote at an older revision has been superseded by a teammate. */
  private written = new Map<string, string>();
  /** A digest of each task exactly as it was last taken from, or given to, the archive.
   *
   * This is what makes a shared archive safe. A writer re-reads the file and writes a task
   * only when its OWN copy differs from the digest it recorded for it; every other task is
   * taken from the file as it is at that moment. The alternative — deciding ownership from
   * "the file's revision is the one I last wrote" — is wrong whenever a teammate writes:
   * that bumps the revision too, so a stale copy of an untouched task looks like local
   * authority and gets written back over the teammate's newer version. Here, a task whose
   * digest is unchanged is simply never written, so nothing stale can be reverted. */
  private digests = new Map<string, string>();
  /** Serializes the write to the archive file. It is intentionally NOT an instance lease:
   * an instance lease has to be held for a whole process lifetime, which is exactly what
   * used to stop a second, short-lived process from owning the same archive. */
  private readonly lock: StateLock;
  /** Public only so the worker entry point can read the same archive it was written to
   * obey; nothing else may use it. */
  readonly runner: RoundRunner;
  /** Only an exclusive instance is the archive's owner and takes the crash lease that
   * proves it; a shared instance is a client of that archive and retains nothing. */
  private readonly exclusive: boolean;
  private readonly legacyLock: string;
  /** Where a round runs. `process` is the real thing; `inline` keeps a round in this
   * process's background so a test can exercise the SAME round code (`runRound`) without
   * paying for a process spawn per case. It is deliberately not "fake": inline calls the
   * identical entry point the worker calls, so only the isolation is substituted. */
  private readonly spawnMode: "process" | "inline";
  private constructor(private config: Config, private projects: Project[], private reader: unknown, private scope: string, private stateFile: string,
    runner: RoundRunner, legacyLock: string, options: { exclusive: boolean; spawn?: "process" | "inline" }) {
    this.runner = runner;
    this.exclusive = options.exclusive;
    this.legacyLock = legacyLock;
    this.spawnMode = options.spawn ?? "process";
    this.lock = StateLock.at(dirname(stateFile));
  }
  /** `exclusive` (the default) means this process owns the archive and takes the crash
   * lease that proves it. `shared` means the archive is owned elsewhere — in production
   * by the tunnel's Pro process — and this instance only needs to observe and extend it.
   * Both write through the same bounded `state.lock`, so "one writer at a time" no
   * longer has to mean "one process forever": that equivalence is what previously made a
   * second, short-lived process unable to run a round. */
  static async create(raw: unknown, reader: z.infer<typeof readerConfigSchema>, options: { recoverDeadOwner?: boolean; exclusive?: boolean; runner?: RoundRunner; spawn?: "process" | "inline" } = {}) {
    const config = editorConfigSchema.parse(raw);
    const projects = await Promise.all(reader.projects.map(async p => ({ ...p, root: await realpath(p.root) })));
    const ids = new Set<string>();
    for (const w of config.workspaces) {
      const p = projects.find(p => p.id === w.project_id);
      if (!p || ids.has(w.project_id)) failure("EDITOR_CONFIG", "Unique registered project required");
      ids.add(w.project_id);
      for (const path of w.writable_paths) {
        parts(path, true);
        if (path !== "." && !visible(path) || !contains(p!.share, path)) failure("EDITOR_CONFIG", "Writable paths must be inside shared paths");
      }
    }
    const parent = await realpath(dirname(config.state_dir));
    const stateRoot = join(parent, basename(config.state_dir));
    if (projects.some(p => inside(p.root, stateRoot))) failure("EDITOR_CONFIG", "Editor state must be outside all shared projects");
    await mkdir(stateRoot, { recursive: true });
    if (await realpath(stateRoot) !== stateRoot || (await lstat(stateRoot)).isSymbolicLink()) failure("EDITOR_CONFIG", "Canonical non-link state directory required");
    const legacyLock = join(stateRoot, "instance.lock"), exclusive = options.exclusive ?? true;
    if (exclusive && options.recoverDeadOwner) {
      try {
        const stat = await lstat(legacyLock), ownerPath = join(legacyLock, "owner.json"), ownerStat = await lstat(ownerPath);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) failure("EDITOR_LOCKED", "Invalid crash lease; inspect manually");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) failure("EDITOR_LOCKED", "Invalid lock owner");
        // An owner that is GONE is still not automatically safe to replace: a round may
        // have died between writing a file and recording it. The task table is inspected
        // by the caller's recovery pass, which knows which states are resumable.
        if (processAlive(owner.pid)) failure("EDITOR_LOCKED", "Owner is still alive; stop the runtime normally");
        await rename(legacyLock, join(stateRoot, `instance.lock.stale.${randomUUID()}`));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (exclusive) { try { await mkdir(legacyLock); } catch { failure("EDITOR_LOCKED", "Editor is active or has a crash lock; inspect it locally before recovery"); } }
    const runner = options.runner ?? await RoundRunner.create(stateRoot);
    const editor = new ProjectEditor(config, projects, reader, sha256(JSON.stringify({ config, projects })), join(stateRoot, "tasks.json"), runner, legacyLock,
      { exclusive, ...(options.spawn ? { spawn: options.spawn } : {}) });
    try {
      // A shared instance must not claim the exclusive directory: it would then be the
      // lock holder without being the owner, and the next real owner would refuse to
      // start. Its presence is recorded where only diagnostics read it.
      if (exclusive) await writeFile(join(legacyLock, "owner.json"), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { flag: "wx" });
      else await writeFile(join(stateRoot, "instance.shared"), JSON.stringify({ pid: process.pid, mode: "shared", created_at: new Date().toISOString() }), { flag: "w" });
      try {
        const stat = await lstat(editor.stateFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) failure("EDITOR_STATE", "Invalid editor state");
        const state = storeSchema.parse(JSON.parse(await readFile(editor.stateFile, "utf8")));
        const blocking = state.scope === editor.scope ? [] : await editor.scopeBlockers(state.tasks);
        if (blocking.length) failure("EDITOR_SCOPE_CHANGED", `${blocking.map(t => `${t.id} (${t.state})`).slice(0, 5).join(", ")} may still be changing this project, and the editor configuration changed underneath it. Call continuity_local_result for each of those task ids: the project opens with the new configuration on the next call once none of them can still write. Nothing has been lost.`);
        editor.tasks = new Map(state.tasks.map(t => [t.id, t]));
        editor.revision = await editor.revisionOf();
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      // Establish the baseline every later reload compares against. Without it the first
      // reload would see an empty baseline and treat every stored task as locally changed.
      await editor.reload();
      // Resolving leftovers belongs here, before any caller can read or extend the archive,
      // and not at the door of one particular entry point: a task left mid-flight by a
      // process that is GONE must never be presented as merely "still running".
      await editor.recoverInterrupted();
      return editor;
    } catch (e) { await editor.close(); throw e; }
  }
  /** Resolve what a dead process left behind, once, before any tool can read it. */
  async recoverInterruptedRounds() {
    await this.recoverInterrupted();
  }
  /** Resolve what a dead process left behind, once, before any tool can read it.
   *
   * A round whose worker is STILL RUNNING is left exactly as it is: that is the whole
   * point of moving execution out of process, and rewriting its state here is what used
   * to turn a live round into a cancelled one. Everything else needs a judgement about
   * whether the effects are known:
   *   - an interrupted validation changed no source file, so it is honestly retryable;
   *   - an interrupted apply or rollback may have written some paths and not others, so
   *     it keeps the recovery lock that forbids further writes until a human looks.
   *
   * "Still running" is decided by `workerOver`, so it covers BOTH ways a round stops
   * without saying so: the process is gone, or the process id now belongs to something
   * else while the record's own deadline has passed. Without the second test a record
   * left behind by a tree kill was immortal — nothing rewrites it, and its pid is either
   * free or recycled — and the round it named could never be resolved by anyone. */
  private async recoverInterrupted() {
    // Decide against the archive's own copy of each round, not this process's. A record is
    // read from disk, so the state it is judged against must be too: a long-lived process
    // can be several rounds behind (a worker it started advanced the file), and judging a
    // stale copy would either miss a round that is over or rewrite one that is not.
    await this.reload();
    let changed = false;
    for (const t of this.tasks.values()) {
      const record = await this.runner.record(t.id);
      if (!workerOver(record)) continue;
      // An in-process round (`spawn: "inline"`) has no worker record at all and is still
      // running: its own `active` entry is the only evidence that exists, so it must be
      // consulted here. Without this the recovery pass would cancel the round it is
      // currently executing, which is the exact failure this pass exists to prevent.
      if (this.active?.id === t.id) continue;
      const where = stopReason(record);
      if (t.state === "validating") { t.state = "cancelled"; t.error = `Round interrupted while validating (${where}); no source file was written, so resend it with the same request_id`; changed = true; }
      else if (t.state === "applying" || t.state === "rolling_back") {
        const during = t.state === "applying" ? "applying" : "rolling back";
        t.state = "recovery_required";
        t.error = `Round interrupted while ${during} (${where}); inspect retained before/after content locally`;
        changed = true;
      }
    }
    if (changed) await this.save();
  }
  /** Whatever a worker is doing right now, as the archive describes it. Exposed so a
   * caller never has to guess from `state` alone whether a round is moving.
   *
   * `running` means a live process is genuinely behind this record; `over` says the
   * record has stopped speaking for this round, which is true once the worker finished OR
   * once its own deadline passed; `stale` is the narrower, honest statement that a record
   * still marked `running` outlived that deadline — i.e. the round was killed and nothing
   * will ever move it again. Reporting them apart matters: a caller that cannot tell a
   * running round from a dead one can only keep asking a question whose answer will never
   * change. */
  async workerState(id: string) {
    const record = await this.runner.record(id);
    if (!record) return null;
    return { job: record.job, action: record.action, phase: record.phase, status: record.status, pid: record.pid,
      running: workerRunning(record), over: workerOver(record),
      stale: record.status === "running" && workerStale(record), deadline_at: record.deadline_at ?? null,
      started_at: record.started_at, finished_at: record.finished_at, error: record.error, log: record.log };
  }
  private workspace(id: string) {
    const w = this.config.workspaces.find(w => w.project_id === id);
    if (!w) return failure("EDITOR_DENIED", "Project is not enabled for editing");
    return w;
  }
  private limits(id: string): SnapshotLimits {
    const limits = this.workspace(id).limits;
    return { totalBytes: limits?.total_bytes ?? defaultLimits.totalBytes, totalFiles: limits?.total_files ?? defaultLimits.totalFiles, fileBytes: limits?.file_bytes ?? defaultLimits.fileBytes };
  }
  /** Is this root itself a repository? Asked once per root and cached, because the
   * .gitignore test below needs Git and a project without it must not pay for a
   * failing subprocess on every created file. Git climbs to the nearest parent
   * repository, so the answer must compare the discovered top level with the project
   * root: a project inside another checkout (or under a user profile that happens to
   * contain one) has no .gitignore of its own, and applying the ancestor's rules would
   * refuse paths this project really does track. */
  private async isRepository(root: string) {
    const known = this.repositories.get(root);
    if (known !== undefined) return known;
    const found = await projectGit(root, ["rev-parse", "--show-toplevel"]).then(result => result.stdout.trim(), () => "");
    const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    const ready = found.length > 0 && same(join(found).replace(/[\\/]+$/, ""), root);
    this.repositories.set(root, ready);
    return ready;
  }
  private project(id: string) {
    const p = this.projects.find(p => p.id === id);
    if (!p || !this.config.workspaces.some(w => w.project_id === id)) return failure("EDITOR_DENIED", "Project is not enabled for editing");
    return p;
  }
  private async checked(p: Project, path: string, missing: boolean) {
    const components = parts(path);
    // Name gates first: whether a path is refused is decided by its own name and
    // sharing, not by whether it happens to exist yet. A hidden or denylisted name
    // is refused even when it is a creation, and the reason says which gate did it
    // — the single shared message used to hide that a name denylist, not the
    // project's own sharing, rejected an ordinary source file such as a stylesheet
    // whose name contains "tokens".
    if (!visible(path)) failure("PATH_DENIED", "This path name is excluded from shared source files by the local denylist (hidden name, credential-like name, or excluded directory)");
    if (!textFile(path)) failure("PATH_DENIED", "Only supported text source file types are editable");
    // A path that does not exist yet is authorized as a whole (any missing
    // component is a creation), which is the same rule the original `contains`
    // check applied to `nested/new.txt`. Requiring each missing ancestor
    // separately would forbid creating the first file in a new directory.
    if (!contains(p.share, path, missing)) failure("PATH_DENIED", "Only shared source files are editable");
    if (await realpath(p.root) !== p.root) failure("PATH_DENIED", "Project root changed");
    let current = p.root, absent = false;
    for (let i = 0; i < components.length; i++) {
      current = join(current, components[i]!);
      if (absent) continue;
      // The walk still visits every component after a missing one: a junction that
      // appears later is how a creation would try to escape, and it must be
      // refused as a link rather than silently skipped.
      const stat = await lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (!missing || e.code !== "ENOENT") throw e;
        return null;
      });
      if (stat === null) { absent = true; continue; }
      if (stat.isSymbolicLink() || i < components.length - 1 && !stat.isDirectory() || i === components.length - 1 && (!stat.isFile() || stat.nlink !== 1)) failure("PATH_DENIED", "Links and special files are excluded");
      if (!inside(p.root, await realpath(current))) failure("PATH_DENIED", "Path escaped project");
    }
    return current;
  }
  /** Original bytes and detected encoding of one file. `missing` decides whether a
   * nonexistent path is null or a denial. */
  /** Is this path inside the snapshot's own scope? The only two ways a path can be
   * missing from the snapshot without being listed as an omission are: it does not
   * exist yet (the case this round creates), or Git never lists it because
   * .gitignore excludes it. `.gitignore` decides even for a path whose parent
   * directory already exists — `work/` exists in the real project and is ignored —
   * so the answer is always Git's, asked once per path, and never an existence test.
   * Git tracks ignored files that are already in the index, and those are captured,
   * so they never reach here. */
  private async inScope(p: Project, path: string): Promise<boolean> {
    if (!await this.isRepository(p.root)) return true;
    const target = join(p.root, ...parts(path));
    try {
      await projectGit(p.root, ["check-ignore", "-q", "--", relative(p.root, target)]);
      return false;
    } catch { return true; }
  }
  /** Did the snapshot capture this path, or does THIS round create it? A file the
   * same call creates is present in the candidate tree that validation runs against,
   * so it is just as verifiable as a captured one. Refusing it would force a second
   * round for something the first round already has in hand. What "this round
   * creates" means is decided by the snapshot's scope, never by the size of the
   * submitted text: a .gitignore'd path is absent from both the snapshot and its
   * omission list, so a size check alone would let it through and validation would
   * then pass without ever having seen the file. */
  private async captured(p: Project, snapshot: ProjectSnapshot, change: Change, limit: SnapshotLimits): Promise<boolean> {
    if (snapshot.files.has(change.path)) return true;
    if (change.expected_sha256 !== null || change.content === null) return false;
    if (snapshot.omissions.some(o => o.path.toLowerCase() === change.path.toLowerCase())) return false;
    return await this.inScope(p, change.path);
  }
  private async source(p: Project, path: string, missing: boolean, max = EDITABLE_FILE_BYTES): Promise<SourceFile | null> {
    const target = await this.checked(p, path, true);
    let file;
    try { file = await open(target, "r"); } catch (e) { if (missing && (e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) failure("FILE_TYPE", "Only regular, single-link files are shared");
      if (stat.size > max) failure("FILE_LIMIT", max === EDITABLE_FILE_BYTES
        ? `Editable files must be at most ${Math.round(max / 1024)} KiB; larger generated files are preserved as snapshot omissions and do not block other work`
        : "File exceeds the snapshot read limit");
      const buffer = Buffer.alloc(max + 1);
      let count = 0;
      while (count < buffer.length) { const r = await file.read(buffer, count, buffer.length - count, count); if (!r.bytesRead) break; count += r.bytesRead; }
      if (count > max) failure("FILE_LIMIT", "File grew beyond the read limit");
      await this.checked(p, path, false);
      return sourceFile(path, buffer.subarray(0, count));
    } finally { await file.close(); }
  }
  /** Decoded text of an editable file, or null when it does not exist. */
  private async content(p: Project, path: string): Promise<string | null> {
    const file = await this.source(p, path, true);
    if (file === null) return null;
    if (file.encoding === null || file.text === null) failure("FILE_TYPE", "Binary files are excluded; the exact bytes are preserved instead of being edited");
    return file.text;
  }
  private async snapshot(p: Project): Promise<ProjectSnapshot> { return snapshotProject(p.root, p.share, this.limits(p.id)); }
  private fingerprint(snapshot: ProjectSnapshot) {
    return sha256(JSON.stringify([...snapshot.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, file.sha256])));
  }
  private task(id: string) { const t = this.tasks.get(id); if (!t) return failure("TASK_UNKNOWN", "Unknown editor task"); return t; }
  private available() {
    if (this.closing || this.busy) failure("EDITOR_BUSY", "Another editor operation is running");
    if ([...this.tasks.values()].some(t => t.state === "recovery_required" || t.state === "applying")) failure("RECOVERY_REQUIRED", "Inspect interrupted edits locally before more writes");
  }
  /** Identity of the archive as this instance last saw it: size and mtime are enough to
   * notice a teammate's write, and the value is never parsed. Two writes inside one
   * millisecond with the same length would be missed, which is why `save` bumps the mtime
   * explicitly after replacing the file. */
  private async revisionOf(): Promise<string | null> {
    try { const stat = await lstat(this.stateFile); return `${stat.size}:${stat.mtimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  /** Adopt another process's tasks without losing the ones this instance owns.
   *
   * Ownership is by last writer, tracked per task in `written`. A task this instance wrote
   * at the current revision is OURS: a teammate's older copy of it must not replace ours,
   * or the request identity, checkpoint and reports of a round this process is running
   * would vanish. A task written when the file was at an earlier revision has since been
   * changed by someone else — the newer copy wins, and this process must not resurrect its
   * own stale version of it.
   *
   * Comparing content (does this task still equal the baseline?) looks equivalent but is
   * not: a worker loading the archive AFTER the acceptor wrote `validating` would load the
   * newer copy and then be told it "changed" it locally, which is exactly how a live round
   * got its own record overwritten. */
  /** A pure read of the archive, sharing nothing with this instance's own state. Observing
   * a round must never be able to damage it, and merging a teammate's file into the table
   * this process writes later is exactly such a risk: a read is not a synchronisation
   * point. Mutating callers use `reload` instead, where the merge question is asked
   * deliberately and the answer is written immediately.
   *
   * Returns null when the archive does not exist yet. */
  /** Which retained tasks still forbid reading an archive that carries a different `scope`.
   *
   * The scope is a hash of the WHOLE editor configuration, so it changes on any configuration
   * edit — one more validation command, one more writable path. Refusing outright on that
   * mismatch is what a real caller hit: after a project's validation profile was edited, every
   * round on that project answered `EDITOR_SCOPE_CHANGED / Review retained editor tasks before
   * changing configuration`, and nothing anywhere in the tool surface reviews or clears a
   * retained task, so the project could be neither used nor repaired by the caller that was
   * told to review it.
   *
   * What actually matters is only whether a retained task can STILL change this project, since
   * those were launched under the old configuration. Once they have all settled the archive is
   * history: reading it under the new configuration reinterprets nothing. */
  private async scopeBlockers(tasks: Task[]): Promise<Task[]> {
    const blocking: Task[] = [];
    for (const task of tasks) {
      // Mid-write, or an interrupted write a human still has to reconcile: the configuration
      // that described it must not be swapped out from under it.
      if (task.state === "applying" || task.state === "rolling_back" || task.state === "recovery_required") { blocking.push(task); continue; }
      // `validating` is the one settled-looking state that can still be executing, in its own
      // process, under the old configuration. It is therefore judged by the shared worker
      // evidence rather than by its label: a worker that is not over means this answer is
      // decided by a process the new configuration never described.
      if (task.state === "validating" && !workerOver(await this.runner.record(task.id))) blocking.push(task);
    }
    return blocking;
  }
  private async diskView(): Promise<Map<string, Task> | null> {
    try {
      const stat = await lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) failure("EDITOR_STATE", "Invalid editor state");
      const state = storeSchema.parse(JSON.parse(await tolerantRead(this.stateFile)));
      // A different scope is accepted once nothing retained can still write, so that editing a
      // project's validation profile does not lock that project out of the tool entirely. The
      // stamp itself is refreshed by the next ordinary save.
      if (state.scope !== this.scope) {
        const blocking = await this.scopeBlockers(state.tasks);
        if (blocking.length) failure("EDITOR_SCOPE_CHANGED", `${blocking.map(t => `${t.id} (${t.state})`).slice(0, 5).join(", ")} may still be changing this project, and the editor configuration changed underneath it. Call continuity_local_result for each of those task ids: the project opens with the new configuration on the next call once none of them can still write. Nothing has been lost.`);
      }
      return new Map(state.tasks.map(t => [t.id, t]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  /** Adopt another process's tasks without losing the ones this instance owns.
   *
   * Ownership is by last writer, tracked per task in `written`. A task this instance wrote
   * at the current revision is OURS: a teammate's older copy of it must not replace ours,
   * or the request identity, checkpoint and reports of a round this process is running
   * would vanish. A task written when the file was at an earlier revision has since been
   * changed by someone else — the newer copy wins, and this process must not resurrect its
   * own stale version of it. */
  async reload(): Promise<boolean> {
    const revision = await this.revisionOf();
    if (revision === this.revision) return false;
    if (revision === null) { this.revision = null; this.written.clear(); this.digests.clear(); return false; }
    const stored = await this.diskView();
    if (stored === null) { this.revision = null; this.written.clear(); this.digests.clear(); return false; }
    const merged: Task[] = [];
    for (const [id, task] of stored) merged.push(this.owns(id, revision) ? this.tasks.get(id)! : task);
    // A task only this process knows about can only be this process's own new work.
    for (const [id, task] of this.tasks) if (!stored.has(id) && this.owns(id, revision)) merged.push(task);
    this.tasks = new Map(merged.map(t => [t.id, t]));
    // Every task now holds exactly what the archive holds, so none of them has anything to
    // write until this process changes one.
    this.digests = new Map([...stored].map(([id, t]) => [id, taskDigest(t)]));
    this.revision = revision;
    return true;
  }
  /** Claim the named tasks as this instance's, at the revision the archive has NOW.
   *
   * The mark must be the file's own revision, because that is the only thing `reload`
   * compares — and because it is the only value that can tell "the archive still holds the
   * write I just made" from "someone else has written since". A private counter cannot:
   * the worker that executes a round writes `tasks.json` under the SAME revision mark the
   * acceptor recorded when it published the round, so a counter-based mark keeps claiming
   * ownership of a copy the worker has already advanced. The acceptor then rejects the
   * worker's newer `applied` task in `reload` — "a task I wrote at the current revision is
   * mine" — and writes its own stale `validating` copy back over it, which is exactly how
   * a finished round lost its result. The mark is taken from the file AFTER this instance
   * wrote it, so it is both the revision this process owns and the revision the archive
   * really has; if a teammate writes in the same instant, the newer copy is theirs and
   * this copy must not be resurrected. */
  private async claim(ids: Iterable<string>): Promise<void> {
    const current = await this.revisionOf();
    if (current === null) return;
    const list = [...ids];
    for (const id of list) this.written.set(id, current);
    this.revision = current;
  }
  /** Does this instance hold the newest copy of the named task, as of `revision` — the
   * revision the archive has right now?
   *
   * The revision is a parameter and not `this.revision`, because `reload` asks this
   * question about a file it has just measured while its own field still names the older
   * revision it last saw. Answering against the stale field makes every task this process
   * ever wrote look like its own newest copy, including one a worker has since advanced —
   * which is precisely how a finished round's `applied` result was thrown away and
   * replaced by the acceptor's older `validating` record. */
  private owns(id: string, revision: string | null): boolean {
    const at = this.written.get(id);
    return at !== undefined && at === revision && this.tasks.has(id);
  }
  /** Write every task, oldest first, exactly as this instance holds them. Called under the
   * state lock and never preceded by a reload: the caller has already pulled the current
   * file in, so writing is the one thing left to do. */
  private async save() {
    await this.lock.with(async () => {
      const merged = new Map((await this.diskView()) ?? []);
      const writing: string[] = [];
      for (const [id, task] of this.tasks) if (this.digests.get(id) !== taskDigest(task)) { merged.set(id, task); writing.push(`${id.slice(0, 8)}=${task.state}`); }
      const state = storeSchema.parse({ version: 1, scope: this.scope, tasks: [...merged.values()] });
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) failure("STATE_LIMIT", "Archive reviewed editor history locally");
      await atomicWrite(this.stateFile, text);
      // A replace carries the temp file's mtime, and a fast write can land in the same
      // millisecond as the previous one; without this bump a teammate would read an
      // unchanged revision and keep serving the older table.
      const now = new Date();
      await utimes(this.stateFile, now, now).catch(() => undefined);
      // Ownership is recorded against the revision the archive now has, and it is taken
      // only after the write has actually landed: a teammate writing in the same
      // millisecond owns the newer revision, and this process's copy must then lose.
      await this.claim(state.tasks.map(t => t.id));
      // Hold exactly what was written, and the digest of exactly that. A later `save` then
      // sees "unchanged" for every task this process merely read, which is the whole point.
      //
      // The validated copies replace the LIVE objects they were validated from, never the
      // other way round. A round mutates the task object it holds (`t.state`, `t.reports`,
      // `t.error`) and every writer reads the table, so the object the round holds must be
      // the object in the table: adopting the parser's fresh copy here would leave the
      // round's own reference detached, and the next `save` would then write the stale
      // copy back — silently discarding the report, the state and the error of the step
      // that just ran. `digests` is recorded from the same object for the same reason.
      const held = new Map(state.tasks.map(t => [t.id, t]));
      for (const [id, live] of this.tasks) {
        const validated = held.get(id);
        // Zod re-validates the same values it produced, so the two are equal by
        // construction; only the identity may differ. This states the invariant rather
        // than assuming it, because the whole round depends on it.
        if (validated && taskDigest(validated) !== taskDigest(live)) failure("STATE_INVALID", "Validated state disagrees with the table it was written from");
        if (validated) held.set(id, live);
      }
      this.tasks = held;
      this.digests = new Map([...this.tasks].map(([id, live]) => [id, taskDigest(live)]));
    });
  }
  status() { return { projects: this.config.workspaces.map(w => ({ project_id: w.project_id, writable_paths: w.writable_paths, validation: w.validation.map(v => v.name), limits: this.limits(w.project_id) })), busy: this.busy,
    tasks: [...this.tasks.values()].slice(-100).map(t => ({ task_id: t.id, project_id: t.project_id, state: t.state })),
    snapshot_scope: `shared working files by raw bytes; Git-visible files when the project is a repository (${Math.round(this.limits(this.config.workspaces[0]!.project_id).fileBytes / 1024 / 1024)} MiB per file, ${Math.round(this.limits(this.config.workspaces[0]!.project_id).totalBytes / 1024 / 1024)} MiB total); UTF-8/UTF-16/GB18030 text is copied byte-exact, binary and oversized files are reported as omissions` }; }
  /** Retained result of one round. `waitSeconds` blocks up to that long for this
   * round to finish, which is the difference between one call and a dozen polls:
   * polling costs a full model round trip each time and buys no new information.
   * The wait lives here, in the service that owns the task, and never in a schema.
   *
   * The wait watches the DISK, not this process. A round may be executed by a separate
   * worker, so `ready` can become true while this process is doing nothing at all: that
   * is what makes one wait keep working across a restart of the process that accepted it. */
  async awaited(id: string, waitSeconds: number) {
    // Waiting for a round to finish is the one place where resolving a round that is ALREADY
    // over belongs: the caller has asked for the outcome, and production keeps a single
    // editor alive for the life of the tunnel, so the recovery pass at editor creation may
    // be hours behind. Without this a round killed by a tree restart answered `ready:false`
    // until someone restarted the server — every call, for ever. It only ever touches a
    // round the evidence has already declared over, so a live round is still left alone.
    // `result()` stays a pure read on purpose: observing a round must never be able to
    // change it, and this is the entry point where resolving one is what the caller wants.
    await this.recoverInterrupted();
    const waitingSince = Date.now();
    const deadline = waitingSince + waitSeconds * 1000;
    let snapshot = await this.result(id);
    while (!snapshot.ready && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      snapshot = await this.result(id);
    }
    // The next action travels WITH the answer. Knowledge that has to be carried by the
    // caller instead — written into a prompt, or relayed by the human in front of one — is
    // knowledge that goes missing in exactly the case that matters: the caller raises the
    // wait past its own 60 s abort, or resends a round that is still running and earns a
    // duplicate_request where it expected a result.
    //
    // `waited_seconds` is what this call ACTUALLY blocked, not the budget it was handed.
    // Reporting the requested number made a round that finished early indistinguishable from
    // one that used up the whole wait: measured in production, a real client read
    // `waited_seconds=45` beside `ready=true` and had to guess which of the two it was, so it
    // could not tell "this was already over when I asked" from "this finished while I waited".
    // The caller already knows what it asked for; only this process knows how long it took.
    const waitedSeconds = Number(((Date.now() - waitingSince) / 1000).toFixed(1));
    return { ...snapshot, waited_seconds: waitedSeconds, wait_timed_out: !snapshot.ready, ...this.nextStep(snapshot, !snapshot.ready) };
  }
  /** The next action, derived from the round's own state, for every entry point that hands a
   * round back to the caller. `next_tool: null` means the round is over and the answer is
   * already complete. `stillRunning` is the caller-visible `ready:false`, so a round that is
   * mid-flight is never described as settled just because its state string looks settled —
   * `pass` in particular is a real state that exists between "tests passed" and "files
   * written", and calling that "landed" would invite a caller to skip a round that never
   * wrote anything. The states below are exactly the enum the archive persists. */
  private nextStep(snapshot: { state: string; error?: string | null }, stillRunning: boolean) {
    const state = snapshot.state;
    const why = snapshot.error ? `: ${snapshot.error}` : "";
    if (stillRunning || ["validating", "applying", "rolling_back"].includes(state)) {
      return { next_tool: "continuity_local_result",
        next_hint: `Still running (state=${state}). This timeout changed nothing: the round is unaffected, no work is lost, and it may already be executing in its own process. Call continuity_local_result again with the SAME task_id and wait_seconds at most 45, as many times as it takes. Do not raise the wait — the client aborts at its own 60 s timeout and the tunnel drops any call past 120 s, so a longer wait produces a transport error instead of a result — and do not resend continuity_local_develop for this round.` };
    }
    if (state === "applied") {
      return { next_tool: null,
        next_hint: `Landed and verified (state=applied). This round is over, so do not call continuity_local_result for this task again. Each change carries its own diff in changes[].diff, so read those instead of re-reading the files. Continue with the next round, or roll this one back with continuity_local_control action=undo.` };
    }
    if (state === "pass") {
      return { next_tool: "continuity_local_develop",
        next_hint: "Validation PASSED but the write is NOT recorded as applied (state=pass), so do not assume the files changed: read them to confirm, or send the round again — a byte-identical request is accepted under the same request_id, and continuity_local_develop validates and writes in one go." };
    }
    if (state === "fail") {
      return { next_tool: "continuity_local_develop",
        next_hint: `This round did not pass${why} and NOTHING was written to the project. Read reports[].output to see why, repair the changes, then send continuity_local_develop again under a NEW request_id — reusing this one returns this same round instead of running again. Read what is on disk first, because nothing was written: when the failed change was a replacement and its repaired form is what the file already holds, there is nothing left to send and the project is already in the state you wanted — a resend then answers NO_CHANGE, which means "nothing to do", not "your call was wrong".` };
    }
    if (state === "cancelled" || state === "recovered") {
      return { next_tool: "continuity_local_develop",
        next_hint: `This round was ${state === "cancelled" ? "cancelled" : "recovered after an interruption"} and no source file was written${why}. If the work is still wanted, send continuity_local_develop again — the same request_id is accepted when the request is byte-identical.` };
    }
    if (state === "rolled_back") {
      return { next_tool: null,
        next_hint: "Rolled back (state=rolled_back): changed files are back to their content before this round and files it created are gone. This round is over, so do not call continuity_local_result for this task again. The user's Git HEAD and index were not touched." };
    }
    if (state === "recovery_required") {
      return { next_tool: null,
        next_hint: `This project has an interrupted write that must be inspected on the machine before any further round${why}. Every write to this project is refused with RECOVERY_REQUIRED until a human resolves it; do not retry the same round, and do not call continuity_local_result for this task again.` };
    }
    if (state === "proposed") {
      return { next_tool: "continuity_local_develop",
        next_hint: "This round was recorded but never validated (state=proposed), so nothing was tested and nothing was written. Send it through continuity_local_develop to run and write it." };
    }
    return { next_tool: null, next_hint: `Round ended in state=${state}${why}.` };
  }
  /** Is a worker still in charge of this task's outcome? The shared definition from
   * `runner.ts`: a record that has not reached `finished`, and has not outlived its own
   * deadline, still decides what happens next — alive or not, because a worker that has
   * just exited may still be mid-write. Having a SINGLE answer matters more here than the
   * answer itself: `recoverInterrupted` retires a round on the same test, so a task cannot
   * be resolved by one reader and left looking unfinished to the other. */
  async result(id: string) {
    const view = await this.diskView();
    const task = view?.get(id) ?? this.tasks.get(id);
    if (!task) failure("TASK_UNKNOWN", "Unknown editor task");
    const worker = await this.workerState(id);
    return { task_id: task.id, project_id: task.project_id, state: task.state,
      // A round is unfinished while a worker still owns it, and also while this process
      // runs one in its own background with no worker involved. A record that has outlived
      // its own deadline is NOT still deciding: treating it as if it were would leave the
      // caller polling a fixed answer — `ready:false` for ever — for a round that was
      // killed with its parent's tree, which is worse than reporting the interruption.
      ready: !["validating", "applying", "rolling_back"].includes(task.state) && this.active?.id !== id && !(worker && !worker.over),
      worker, base_fingerprint: task.base_fingerprint,
      validation_current_session: task.validation_session === this.session,
      // A local round is validated AND applied by its own worker process, so this is false for
      // every local round and says nothing is wrong. A real client read it beside
      // `applied: true` and reported that it "does not look natural" — the name promises a
      // statement about validation freshness and delivers a statement about process identity.
      // It cannot simply be renamed: the legacy validate/apply pair genuinely requires both
      // halves in one server session, and that contract is what reads this field.
      validation_current_session_hint: "True only when the validation ran inside THIS server process. Every continuity_local_* round is validated and applied by a separate worker process, so false is normal here and is not a complaint about the validation: the round's own state and reports[].output are the evidence. The legacy continuity_edit_validate → continuity_edit_apply pair is the caller that needs this to be true.",
      reports: task.reports, error: task.error,
      snapshot_omissions: task.snapshot_omissions ?? [],
      snapshot_scope: task.snapshot_scope ?? null,
      validation_commands: task.development?.validation ?? this.config.workspaces.find(w => w.project_id === task.project_id)!.validation,
      changes: task.changes.map((c: Change) => {
        const before = originalFor(c.path, task.before[c.path] ?? null);
        const after = proposedBytes(c.path, task.before[c.path] ?? null, c.content);
        const entry: Record<string, unknown> = { path: c.path, before_sha256: c.expected_sha256, after_sha256: after === null ? null : sha256(after),
          operation: c.content === null ? "delete" : c.expected_sha256 === null ? "create" : "replace",
          encoding: before?.encoding ?? null, content_bytes: after?.length ?? null };
        // The diff is what makes a round verifiable without a second read of every file
        // it touched, so it is part of the retained result rather than a separate call.
        const had = task.before[c.path] === null || task.before[c.path] === undefined ? null : rawText(task.before[c.path]);
        const has = after === null ? null : c.content;
        if (c.content === null || (after?.length ?? 0) <= 4 * 1024 * 1024) entry.diff = changeDiff(had, has);
        return entry;
      }),
      applied: task.state === "applied", current_files_verified: false,
      development: task.development ? { request_id: task.development.request_id, goal: task.development.goal, checkpoint: task.development.checkpoint, audit_log: join(dirname(this.stateFile), "audit.jsonl") } : null };
  }
  async propose(projectId: string, changes: AuthoredChange[]) {
    this.available(); this.busy = true;
    try {
      // Pull the current archive in before deciding anything about it: the history limit,
      // the duplicate-path rules and the new task's neighbours are all read from it, and a
      // worker may have extended it since this instance last looked.
      await this.reload();
      if (this.tasks.size >= 200) failure("STATE_LIMIT", "Archive reviewed editor history locally");
      // Changes apply in order, so a path may legitimately appear more than once:
      // "create it, then fix one line" is one intention, not two rounds. Only a repeat
      // that would discard earlier work is refused — a second whole-file write, or a
      // delete after a write. Anchors compose, so they are never ambiguous.
      const written = new Map<string, AuthoredChange>();
      for (const change of changes) {
        const key = change.path.toLowerCase(), earlier = written.get(key);
        const wholeFile = (c: AuthoredChange) => c.content !== undefined && c.content !== null;
        if (earlier && (wholeFile(change) || (wholeFile(earlier) && change.content === null))) {
          failure("DUPLICATE_PATH", "Each path may appear only once as a whole-file write; send one content change per path, or use anchors to make ordered edits to it");
        }
        if (wholeFile(change) || change.content === null) written.set(key, change);
      }
      const p = this.project(projectId), w = this.workspace(projectId);
      const snapshot = await this.snapshot(p), before: Record<string, string | null> = {};
      // Anchored changes become complete text before anything else looks at them,
      // so the rest of this service still reasons about final bytes only.
      const resolved = await resolveChanges(changes, async (path) => {
        await this.checked(p, path, true);
        return this.source(p, path, true);
      });
      let bytes = 0;
      // What this call has already decided for each path, so a path changed twice is
      // checked against the running result instead of the bytes still on disk.
      const settled = new Map<string, string | null>();
      for (const c of resolved) {
        await this.checked(p, c.path, true);
        if (!contains(w.writable_paths, c.path)) failure("PATH_DENIED", "Path is outside configured write scope");
        const key = c.path.toLowerCase();
        const onDisk = await this.source(p, c.path, true);
        const prior = settled.has(key);
        const captured = snapshot.files.get(c.path);
        // A path the snapshot never copied cannot be validated in the test copy, so
        // editing it would bypass the verification this service promises. A path this
        // round creates is different: it is in the candidate tree by construction.
        // Report the real reason and the budget that caused it instead of a generic
        // failure.
        if (!prior && !captured && !await this.captured(p, snapshot, c, this.limits(projectId))) {
          const omission = snapshot.omissions.find(o => o.path === c.path);
          const limit = this.limits(projectId);
          const reason = omission ? OMISSION_REASONS[omission.reason] : "excluded by the project's own .gitignore, which is what decides the snapshot file set";
          failure("FILE_LIMIT", `${c.path} was not captured for validation (${reason}${omission?.bytes ? `, ${omission.bytes} bytes` : ""}); it cannot be validated, so it is not editable. Snapshot budgets are currently ${Math.round(limit.fileBytes / 1024 / 1024)} MiB per file and ${Math.round(limit.totalBytes / 1024 / 1024)} MiB total in editor.workspaces[].limits; hidden, ignored, binary and linked paths stay uneditable regardless of the budget`);
        }
        // The reference bytes for this change: what an earlier change in this call
        // already decided, otherwise the file on disk.
        const currentSha = prior
          ? (settled.get(key) === null ? null : sha256(proposedBytes(c.path, before[c.path] ?? null, settled.get(key)!)!))
          : (onDisk === null ? null : onDisk.sha256);
        if (currentSha !== c.expected_sha256) failure("FILE_CHANGED", "Read current file before proposing an edit; hashes compare the file's exact bytes");
        const referenceText = prior ? settled.get(key)! : (onDisk === null ? null : onDisk.text);
        if (referenceText === null && c.content === null || referenceText !== null && referenceText === c.content) failure("NO_CHANGE", `${c.path} already holds exactly this content, so there is nothing to write for it: the file is already in the state this change asks for. Drop this path from the round, or skip the round entirely if it had no other change. This is also what a REPAIR looks like after a failed round — a failed round writes nothing, so the file on disk can already be the content you were about to send, and then there is nothing to send.`);
        if (c.content !== null) {
          if (Buffer.byteLength(c.content, "utf8") > MAX_EDIT_TEXT_BYTES) failure("FILE_LIMIT", `Replacement must be at most ${Math.round(MAX_EDIT_TEXT_BYTES / 1024 / 1024)} MiB of UTF-8 text`);
          // Rejects text the file's own encoding cannot represent, before any work.
          encodeForEdit(c.path, c.content, onDisk?.encoding ?? "utf8");
        }
        if (onDisk !== null && captured?.sha256 !== onDisk.sha256) failure("FILE_CHANGED", "The source snapshot does not match the current file; retry the round");
        settled.set(key, c.content);
        bytes += Buffer.byteLength(c.content ?? "", "utf8");
        if (bytes > MAX_PROPOSAL_BYTES) failure("PROPOSAL_LIMIT", `Proposal exceeds ${Math.round(MAX_PROPOSAL_BYTES / 1024 / 1024)} MiB of UTF-8 text; split it across calls rather than shrinking the work`);
        // Only the first change to a path records the original; that is what rollback
        // restores, and it must never be overwritten by a later change in the same call.
        if (!prior) before[c.path] = onDisk === null ? null : serializeSource(onDisk);
      }
      const task: Task = { id: randomUUID(), project_id: projectId, created_at: new Date().toISOString(), base_fingerprint: this.fingerprint(snapshot), changes: resolved, before, state: "proposed", reports: [], validation_session: null, error: null,
        snapshot_omissions: snapshot.omissions.map(o => ({ path: o.path, reason: o.reason, bytes: o.bytes })),
        snapshot_scope: { source: snapshot.scope.source, captured_files: snapshot.scope.captured_files, captured_bytes: snapshot.scope.captured_bytes, omissions_total: snapshot.scope.omissions_total, ignored_paths_excluded: snapshot.scope.git.ignored_paths_excluded, omissions_truncated: snapshot.scope.omissions_truncated } };
      this.tasks.set(task.id, task); await this.save(); return this.result(task.id);    } finally { this.busy = false; }
  }
  /** Everything a round does after its task exists: checkpoint, validate, and — when
   * validation passed — write the files. This is the method the out-of-process worker
   * runs, so it takes a bare task id and re-reads the task: an identity that survived a
   * restart must not depend on an object some other process is holding.
   *
   * `onPhase` reports the transition before the state is written, which is what lets the
   * worker's record say "applying" while the archive still says "pass"; a process killed
   * between the two is then described by whichever write landed, never by neither. */
  async runRound(id: string, options: { signal?: AbortSignal; onPhase?: (phase: RunnerPhase) => Promise<void> } = {}) {
    const signal = options.signal ?? new AbortController().signal;
    // Which task this is has to survive a restart, so it is re-read here rather than
    // handed in: the caller may be a different process from the one that proposed it.
    await this.reload();
    const current = this.task(id);
    if (current.state === "applied") return { ...await this.result(id), previously_applied: true };
    if (!["validating", "pass", "fail", "cancelled"].includes(current.state)) failure("TASK_STATE", `This round cannot run from state=${current.state}`);
    const p = this.project(current.project_id);
    const beforeFiles: CheckpointFiles = {}, afterFiles: CheckpointFiles = {};
    for (const c of current.changes) {
      beforeFiles[c.path] = retainedSide(c.path, current.before[c.path] ?? null);
      afterFiles[c.path] = checkpointSide(c.path, current.before[c.path] ?? null, c.content);
    }
    // The originals are recorded before validation runs, so a round that dies while
    // testing still has a recoverable "before" side.
    const recorded = await checkpoint(dirname(this.stateFile), id, beforeFiles, afterFiles);
    current.development!.checkpoint = null;
    await this.save();
    await this.reload();
    const t = this.task(id);
    t.development!.checkpoint = recorded;
    await this.save();
    try {
      await options.onPhase?.("validating");
      await this.validateTask(t, signal);
      await audit(dirname(this.stateFile), { event: "validation_finished", task_id: t.id, state: t.state, reports: t.reports.map(r => ({ name: r.name, exit_code: r.exit_code, timed_out: r.timed_out })) });
      if (t.state === "pass" && !signal.aborted && !this.closing) {
        await audit(dirname(this.stateFile), { event: "apply_intent", task_id: t.id, checkpoint: t.development!.checkpoint });
        await options.onPhase?.("applying");
        await this.applyTask(t);
        await audit(dirname(this.stateFile), { event: "applied", task_id: t.id });
      } else if (t.state === "pass") { t.state = "cancelled"; await this.save(); }
    } catch (e) {
      // A successful write receipt survives a later audit failure: the files are on
      // disk, and saying otherwise would invite a duplicate round.
      if (!["applied", "recovery_required"].includes(t.state)) t.state = "fail";
      t.error = e instanceof ReaderError ? e.code : "DEVELOPMENT_FAILED";
      try { await this.save(); } catch { t.state = "recovery_required"; t.error = "STATE_SAVE_FAILED"; }
      await audit(dirname(this.stateFile), { event: "development_error", task_id: t.id, state: t.state, error: t.error }).catch(() => undefined);
      throw e;
    }
    return await this.result(id);
  }
  /** Validate one task in this process. `validate` publishes the round first and then
   * starts this in the background: the state must be on disk before any work begins, so a
   * caller that arrives while it runs sees a round rather than nothing. */
  async validate(id: string) {
    this.available(); const t = this.task(id);
    if (["applied", "rolled_back", "recovery_required"].includes(t.state)) failure("TASK_STATE", "This task cannot be validated");
    this.busy = true; t.state = "validating"; t.validation_session = null; t.reports = []; t.error = null;
    try { await this.save(); } catch (e) { this.busy = false; t.state = "fail"; throw e; }
    const abort = new AbortController();
    const done = this.validateTask(t, abort.signal).finally(() => { this.busy = false; this.active = undefined; });
    this.active = { id, abort, done };
    return { task_id: id, state: "validating", ready: false };
  }
  private async validateTask(t: Task, signal: AbortSignal) {
    let run: string | undefined;
    try {
      const p = this.project(t.project_id), snapshot = await this.snapshot(p);
      if (this.fingerprint(snapshot) !== t.base_fingerprint) failure("FILE_CHANGED", "Project changed; create a new proposal");
      // Only requested changes are re-encoded. Every other file is copied with its
      // original bytes, so GB18030, UTF-16 and binary dependencies stay intact.
      const candidates = new Map<string, Buffer>();
      for (const [path, file] of snapshot.files) candidates.set(path, file.bytes);
      for (const c of t.changes) {
        const original = originalFor(c.path, t.before[c.path] ?? null);
        if (c.content === null) candidates.delete(c.path);
        else candidates.set(c.path, encodeForEdit(c.path, c.content, original?.encoding ?? "utf8"));
      }
      run = join(tmpdir(), "continuity-validation", randomUUID());
      await mkdir(run, { recursive: true });
      // Validation runs from a system-temporary directory: no relative path from
      // the candidate tree can walk back into the user's real project. Absolute
      // paths still reach everything the local user can read, so this bounds
      // accidents, not a sandbox against hostile project code.
      for (const [path, bytes] of candidates) { await mkdir(dirname(join(run, path)), { recursive: true }); await writeFile(join(run, path), bytes, { flag: "wx" }); }
      for (const step of t.development?.validation ?? this.workspace(p.id).validation) {
        const report = await runCommand(step, run, signal); t.reports.push(report);
        // Reports are published as each step finishes: a caller waiting on this round
        // needs to see which step is running, and after a restart that is the only
        // surviving evidence of how far it got.
        await this.save();
        if (!report.termination_confirmed) { t.state = "recovery_required"; t.error = "VALIDATION_PROCESS_UNCONFIRMED"; break; }
        if (report.exit_code !== 0 || report.timed_out || report.cancelled) { t.state = report.cancelled ? "cancelled" : "fail"; break; }
      }
      if (t.state === "validating") {
      // Tests may generate files but must not rewrite candidate source to get PASS.
      for (const [path, bytes] of candidates) {
        const file = join(run, path), stat = await lstat(file);
        let parent = dirname(file);
        while (parent !== run) { if ((await lstat(parent)).isSymbolicLink()) failure("VALIDATION_CHANGED_SOURCE", "Candidate directory replaced with a link"); parent = dirname(parent); }
        if (!inside(run, await realpath(file))) failure("VALIDATION_CHANGED_SOURCE", "Candidate source escaped validation directory");
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > this.limits(p.id).fileBytes || sha256(await readFile(file)) !== sha256(bytes)) failure("VALIDATION_CHANGED_SOURCE", "Validation modified candidate source");
      }
      for (const c of t.changes) if (c.content === null) {
        try { await lstat(join(run, c.path)); failure("VALIDATION_CHANGED_SOURCE", "Validation recreated a deleted source file"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      if (signal.aborted) { t.state = "cancelled"; } else { t.state = "pass"; t.validation_session = this.session; }
      }
    } catch (e) { t.state = "fail"; t.error = e instanceof ReaderError ? e.code : "VALIDATION_FAILED"; }
    finally {
      // Keep evidence in the journal; remove disposable source/dependency copies.
      // Do not touch a run whose process termination is still uncertain.
      if (run && t.error !== "VALIDATION_PROCESS_UNCONFIRMED") {
        try {
          const runsRoot = join(tmpdir(), "continuity-validation");
          if (dirname(run) !== runsRoot || !inside(runsRoot, run) || await realpath(run) !== run || (await lstat(run)).isSymbolicLink()) failure("CLEANUP_SCOPE", "Snapshot cleanup path changed");
          await rm(run, { recursive: true, force: true });
        } catch {
          // Cleanup is bookkeeping: it must not overwrite the verdict that validation
          // reached, and a discarded candidate tree is not evidence worth a recovery lock.
          if (t.state === "pass") { t.state = "recovery_required"; t.error = "SNAPSHOT_CLEANUP_FAILED"; }
        }
      }
    }
    try { await this.save(); } catch { t.state = "recovery_required"; t.error = "STATE_SAVE_FAILED"; }
  }
  /** Stop a round wherever it is running. A worker is a process, so stopping it means
   * killing exactly that pid — and the state is written first, so a crash between the two
   * cannot leave a killed worker's round looking like a live one.
   *
   * A record that says `running` is retired even when there is no process left to kill.
   * That is the leftover of a tree kill, and it is exactly the record a caller reaches
   * for this tool to clear: `kill` answers "nothing to stop" for a pid that is gone, which
   * is true and useless if the record is then left claiming the round is still moving. */
  async cancel(id: string) {
    await this.reload();
    const t = this.task(id), record = await this.runner.record(id);
    if (this.active?.id === id) { const active = this.active; active.abort.abort(); await active.done; }
    if (record?.status === "running") {
      // Only a record that still names something is worth a kill: a stale pid can belong
      // to an unrelated process now, and killing THAT would be a real fault.
      const stopped = workerStale(record) ? true : await this.runner.kill(record);
      if (!stopped) failure("RUNNER_UNCONFIRMED", "The worker process did not stop; inspect it locally before resending this round");
      await this.runner.update(id, { status: "failed", phase: "finished", finished_at: new Date().toISOString(), error: "Cancelled by the caller" });
    }
    // `proposed` belongs in this list: a proposal that was never validated is exactly the kind
    // of round a caller wants retired, and leaving it alone made action=cancel answer with the
    // very state it was asked to leave — a tool silently doing nothing is worse than one that
    // refuses, because the caller reads the unchanged state as "still on its way".
    const cancellable = ["proposed", "validating", "applying", "rolling_back"].includes(t.state);
    if (cancellable) { t.state = "cancelled"; t.error = "Cancelled by the caller"; await this.save(); }
    const snapshot = await this.result(id);
    const next = this.nextStep(snapshot, !snapshot.ready);
    // A cancel that could not cancel has to SAY so. Returning the unchanged receipt and letting
    // the caller deduce it from the state is the same silence that made action=cancel look like
    // it worked on a `proposed` round, and a real client reported having to infer it here too.
    // The `applied` advice has to name the round's OWN undo, or it sends the caller at a tool
    // that refuses. A real client followed "only continuity_local_control action=undo removes
    // them" from a round created by continuity_edit_propose → continuity_edit_apply, and that
    // tool has nothing to do with such a task; continuity_develop_undo answered TASK_STATE
    // instead, because only a development round carries the Git checkpoint a rollback needs.
    // Naming the rule rather than one tool costs a sentence and is true for both origins.
    return cancellable ? { ...snapshot, ...next } : { ...snapshot, ...next,
      cancel_hint: `action=cancel changed nothing: a round in state=${snapshot.state} is not cancellable. ${snapshot.state === "applied" ? "Its files are on disk, and undoing them depends on how the round was created: a continuity_local_* round is rolled back with continuity_local_control action=undo against the same project_path, while a round created by continuity_edit_propose and applied with continuity_edit_apply has no undo tool — continuity_develop_undo refuses it because only a development round carries the Git checkpoint a rollback needs, so restore the earlier content with a new round." : "Nothing of it was written, so there is nothing to cancel."}` };
  }
  /** Bytes of the content a change would write, or null for deletion. */
  private bytesFor(path: string, before: string | null, content: string | null): Buffer | null {
    return proposedBytes(path, before, content);
  }
  private async replace(p: Project, path: string, expectedSha: string | null, bytes: Buffer | null) {
    const current = await this.source(p, path, true);
    if ((current?.sha256 ?? null) !== expectedSha) failure("FILE_CHANGED", "File changed immediately before write; hashes compare exact bytes");
    const target = await this.checked(p, path, true);
    if (bytes === null) { await unlink(target); return; }
    await mkdir(dirname(target), { recursive: true });
    await this.checked(p, path, true);
    const temp = join(dirname(target), `.continuity-${randomUUID()}.tmp`);
    const mode = current === null ? 0o644 : (await lstat(target)).mode;
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      const recheck = await this.source(p, path, true);
      if ((recheck?.sha256 ?? null) !== expectedSha) failure("FILE_CHANGED", "Concurrent edit detected");
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => undefined); }
  }
  async apply(id: string) {
    this.available(); const t = this.task(id);
    if (t.state === "applied") return { ...this.result(id), previously_applied: true };
    if (t.state !== "pass" || t.validation_session !== this.session) failure("VALIDATION_REQUIRED", "Validate this proposal in the current server session first");
    this.busy = true;
    try { return await this.applyTask(t); } finally { this.busy = false; }
  }
  private async applyTask(t: Task) {
      const id = t.id;
      const p = this.project(t.project_id);
      if (this.fingerprint(await this.snapshot(p)) !== t.base_fingerprint) failure("FILE_CHANGED", "Project changed since validation; preserve existing edits and make a new proposal");
      t.state = "applying"; await this.save();
      // Exact bytes of both sides are decided once, before any write, so recovery
      // never has to re-derive them from possibly changed state.
      // One write per distinct path, guarded by the hash the path really has just
      // before that write. Replaying every change would write the round's final
      // content twice; leaving the guard at the per-change expectation would then
      // demand a state the path is never in.
      const plan = this.finalPerPath(t.changes).map(c => ({
        change: c, guard: this.guardFor(c.path, t.before[c.path] ?? null, c),
        original: originalFor(c.path, t.before[c.path] ?? null)?.bytes ?? null,
        proposed: proposedBytes(c.path, t.before[c.path] ?? null, c.content)
      }));
      const written: typeof plan = [];
      try {
        for (const step of plan) { await this.replace(p, step.change.path, step.guard, step.proposed); written.push(step); }
        t.state = "applied"; await this.save(); return this.result(id);
      } catch (e) {
        let recovered = true;
        for (const step of written.reverse()) {
          try { await this.replace(p, step.change.path, step.proposed === null ? null : sha256(step.proposed), step.original); } catch { recovered = false; }
        }
        t.state = recovered ? "fail" : "recovery_required";
        t.error = recovered ? "APPLY_FAILED_ROLLED_BACK" : "APPLY_INTERRUPTED_PRESERVE_EXTERNAL_EDITS";
        await this.save(); throw e;
      }
  }
  /** Same request ID plus the same request returns the stored round instead of running it
   * again. That is the right behaviour, but the stored round may be one the caller has no
   * use for — a round it already rolled back cannot be re-run by quoting its ID, and
   * resubmitting the identical request would just be a no-op. Say which case this is, so
   * the caller's next call is the one it needed rather than a guess. */
  private reuseHint(t: Task) {
    if (["validating", "applying", "rolling_back"].includes(t.state)) return `This round ID is already running (state=${t.state}); read it with continuity_local_result and wait_seconds up to 45. If that comes back ready=false the round is still running: call it again with the same task_id. Never raise the wait — an MCP client aborts at its own 60 s timeout and the tunnel drops anything past 120 s, so the caller only sees a transport error.`;
    if (t.state === "applied" || t.state === "pass") return `This round ID already PASSED and its files are on disk (state=${t.state}); read the files instead of resubmitting, or undo it with continuity_local_control action=undo.`;
    if (t.state === "rolled_back" || t.state === "cancelled" || t.state === "recovered") return `This round ID was undone (state=${t.state}), so resubmitting it changes nothing on disk. Send the same changes under a NEW request_id to run them again.`;
    return `This round ID already ran and ended in state=${t.state}${t.error ? ` (${t.error})` : ""}; a new request_id is required to run it again.`;
  }
  /** Same request ID plus the same request returns the stored round instead of running it
   * again — see reuseHint for what the caller should do with the answer.
   *
   * The round is published here and EXECUTED ELSEWHERE. That split is the whole point:
   * this process may be replaced while the round is still running, and the round must not
   * notice. The archive write below is the handover — it happens before the worker is
   * started, so a caller that arrives in between sees a round rather than nothing. */
  async develop(projectId: string, requestId: string, goal: string, changes: AuthoredChange[], validation?: Config["workspaces"][number]["validation"]) {
    // Per-round overrides are explicitly authorized. Retain the exact commands
    // in this task so later commands cannot reuse an earlier validation PASS.
    if (validation) validation = editorConfigSchema.shape.workspaces.element.shape.validation.parse(validation);
    const requestHash = digest({ projectId, goal, changes, ...(validation ? { validation } : {}) });
    // Retire any round that is already over BEFORE looking for a duplicate request. The
    // recovery pass at editor creation is not enough on its own: production keeps one
    // editor alive for the life of the tunnel, so a round killed after startup would keep
    // its `validating` state until something restarted the server — and a caller resending
    // the identical request would get that dead round back as a "duplicate" instead of a
    // round to run. Resolving it here costs one record read per task and makes the answer
    // depend on the evidence rather than on when the process last started.
    await this.recoverInterrupted();
    await this.reload();
    const existing = [...this.tasks.values()].find(t => t.development?.request_id === requestId);
    if (existing) {
      if (existing.development!.request_hash !== requestHash) failure("REQUEST_CONFLICT", "Reuse a request ID only for the identical request");
      return { ...await this.result(existing.id), duplicate_request: true, reuse_hint: this.reuseHint(existing) };
    }
    const proposed = await this.propose(projectId, changes), t = this.task(proposed.task_id);
    this.available();
    t.development = { request_id: requestId, request_hash: requestHash, goal, checkpoint: null, ...(validation ? { validation } : {}) };
    t.state = "validating";
    try { await this.save(); } catch (e) { await this.markUnstarted(t.id); throw e; }
    await audit(dirname(this.stateFile), { event: "development_started", task_id: t.id, request_id: requestId, request_hash: requestHash });
    try { await this.startRound(t.id, requestId); }
    catch (e) { await this.markUnstarted(t.id); throw e; }
    return { task_id: t.id, state: "validating", ready: false, next_tool: "continuity_local_result" };
  }
  /** Hand one round to its executor. The process path writes the session first so the
   * worker can rebuild this exact configuration; the inline path is the same round in
   * this process, used by tests and by any caller that has no reason to isolate. */
  private async startRound(id: string, requestId: string | null) {
    if (this.spawnMode === "inline") {
      const abort = new AbortController();
      const done = (async () => {
        try { await this.runRound(id, { signal: abort.signal }); }
        // A failure here is already recorded on the task by `runRound`; surfacing it again
        // would only duplicate it. It must never be silent though: an inline round that
        // dies before it records anything would otherwise leave a task that looks alive.
        catch (error) { console.error("[inline-round]", id, error instanceof Error ? error.message : String(error)); }
      })().finally(() => { this.active = undefined; });
      this.active = { id, abort, done };
      return { mode: "inline" as const };
    }
    // The worker re-derives the editor from these exact structures, so its authority is
    // limited to what this process already validated — the session file is input to
    // `ProjectEditor.create`, which re-checks every path rule on the way in.
    await this.runner.writeSession({ version: 1, editor: this.config, reader: this.reader });
    const started = await this.runner.spawn({ taskId: id, requestId, action: "develop", script: this.runner.scriptPath() });
    return { mode: "process" as const, ...started };
  }
  /** Undo through the executor, so an undo of a large round is not a blocking call in the
   * process that answers the tunnel. The task is moved to `rolling_back` first for the
   * same reason `develop` publishes `validating` first: the caller must see a round that
   * is moving even if this process dies mid-handover. */
  async startUndo(id: string) {
    // Same reason as `develop`: an undo decided against a round that is already over must
    // see it as over. Without this a killed round stays `validating` for the whole life of
    // the server and refuses both re-reading and undoing.
    await this.recoverInterrupted();
    // Ask the process that ran the round what happened to it. Its record is the one piece of
    // evidence this accepting process cannot have in memory — it was written by another
    // process — and it is definitive: a finished worker means the round is over, whatever
    // either copy of the table happens to say.
    const worker = await this.workerState(id);
    // A worker that is no longer executing — it reached `finished`, or its record has
    // outlived its own deadline — has no further say about this round, so the disk's copy
    // is the round's own last word. A record that still says `running` forever would
    // otherwise make a round that is genuinely over permanently un-undoable.
    const stopped = !worker || worker.over;
    // A round that is still moving must be refused, and so must one that stopped in the
    // middle of writing files: an undo would drive it backwards from an unknown position.
    // When the worker is done, and only then, reload — so the decision below is made
    // against the round's own final state and not a stale copy of it. `reload` keeps the
    // identity of a task this process already owns, so a locally advanced task is never
    // replaced by an older disk version.
    if (stopped) await this.reload();
    const t = this.task(id);
    // The disk is the round's own last word on itself. Take it when it is further along than
    // this process's copy and no worker is still moving: an acceptor that never re-read the
    // archive after handing the round over would otherwise refuse an undo of a round that
    // genuinely finished.
    const disk = (await this.diskView())?.get(id);
    const current = disk && stopped && !this.active ? disk : t;
    if (current.state === "rolled_back") return { ...await this.result(id), previously_rolled_back: true };
    if (worker?.running || ["validating", "applying", "rolling_back"].includes(current.state)) failure("TASK_STATE", `This round is still moving (state=${current.state}); wait for continuity_local_result to report it finished before undoing it`);
    if (current.state !== "applied" && current.state !== "recovery_required") failure("TASK_STATE", `This round cannot be undone from state=${current.state}; read it with continuity_local_result first`);
    const t2 = current;
    if (t2.state !== "applied" || !t2.development?.checkpoint) failure("TASK_STATE", "Only an applied development round with a Git checkpoint can be rolled back");
    // Refusals belong to the caller's turn: "a file has newer edits" must come back as an
    // error the caller can act on, not as a round that quietly fails later on its own.
    await this.undoPlan(t2);
    if (this.spawnMode === "inline") return await this.rollback(id);
    const requestId: string | null = t2.development!.request_id;
    await this.runner.writeSession({ version: 1, editor: this.config, reader: this.reader });
    const started = await this.runner.spawn({ taskId: id, requestId, action: "undo", script: this.runner.scriptPath() });
    return { task_id: id, state: t.state, ready: false, worker: await this.workerState(id), ...started };
  }
  /** A round whose worker never started has no effects to recover and must not keep a
   * `validating` record that would look like it might still move. It is reported as
   * failed-but-resendable: the identical request under the same request_id is safe. */
  private async markUnstarted(id: string) {
    await this.reload();
    const t = this.tasks.get(id);
    if (!t || t.state !== "validating") return;
    t.state = "fail";
    t.error = "ROUND_NOT_STARTED";
    await this.save().catch(() => undefined);
  }
  /** One write per distinct path. A path may legitimately appear twice in a round
   * (create it, then anchor a line), so replaying every change would restore the
   * path, then expect the file to still hold the round's final bytes and refuse the
   * whole rollback with FILE_CHANGED. What must be restored is the ORIGINAL, and it
   * has to be restored from the round's final content — which the caller's duplicate
   * rule already guarantees is the last change for that path. */
  private finalPerPath(changes: readonly Change[]): Change[] {
    const last = new Map<string, Change>();
    for (const c of changes) last.set(c.path.toLowerCase(), c);
    return [...last.values()];
  }
  /** The hash a write must find on disk before it runs, and therefore the hash that
   * describes a path up to this round. For a path changed once that is the change's
   * own expectation. For a path this round changes twice the last change's
   * expectation describes an intermediate draft written during the same round, so the
   * guard is the hash of that draft instead: the path is in that state immediately
   * before the final write, and never in the state the last change quoted. */
  private guardFor(path: string, before: string | null, change: Change): string | null {
    if (change.expected_sha256 === null || change.content === null) return change.expected_sha256;
    const draft = proposedBytes(path, before, originalFor(path, before)?.text ?? null);
    return draft === null ? null : sha256(draft);
  }
  /** What an undo would restore, and the guard each write needs. Building it is the part
   * that decides whether the undo is ALLOWED: a path with newer external edits, or a
   * checkpoint that no longer matches the retained originals, is refused here. It is
   * therefore built by the caller as well as by the worker, so a refusal is reported to the
   * caller immediately instead of being discovered minutes later in another process. */
  private async undoPlan(t: Task) {
    const p = this.project(t.project_id), cp = t.development!.checkpoint!;
    const before = await readCheckpoint(cp.repository, cp.before_commit);
    const plan = this.finalPerPath(t.changes).map(c => {
      const attempted = proposedBytes(c.path, t.before[c.path] ?? null, c.content);
      const retained = before[c.path];
      const original = retained ? sourceFile(c.path, Buffer.from(retained.bytes, "base64")) : null;
      // Compare the real retained bytes per path; a whole-record digest would also
      // fail on metadata that is deliberately re-derived.
      if ((original === null ? null : serializeSource(original)) !== t.before[c.path]) failure("CHECKPOINT_CHANGED", "Git backup does not match the retained original of this file");
      return { change: c, expected: attempted === null ? null : sha256(attempted), original: original?.bytes ?? null };
    });
    for (const step of plan) {
      const current = await this.source(p, step.change.path, true);
      if ((current?.sha256 ?? null) !== step.expected) failure("FILE_CHANGED", "A changed file has newer edits; preserve them and undo newer rounds first");
    }
    return { p, cp, plan };
  }
  async rollback(id: string, options: { onPhase?: (phase: RunnerPhase) => Promise<void> } = {}) {
    // Re-read first: a worker may have finished this round since this instance last
    // looked, and an undo decided from a stale table would refuse a valid undo.
    await this.reload();
    const t = this.task(id);
    if (t.state === "rolled_back") return { ...await this.result(id), previously_rolled_back: true };
    if (t.state !== "applied" || !t.development?.checkpoint) failure("TASK_STATE", "Only an applied development round with a Git checkpoint can be rolled back");
    try {
      const { p, cp, plan } = await this.undoPlan(t);
      await audit(dirname(this.stateFile), { event: "rollback_intent", task_id: id, before_commit: cp.before_commit });
      await options.onPhase?.("rolling_back");
      t.state = "rolling_back"; await this.save();
      try {
        for (const step of plan) await this.replace(p, step.change.path, step.expected, step.original);
        t.state = "rolled_back"; t.error = null; t.validation_session = null; await this.save();
      } catch (e) { t.state = "recovery_required"; t.error = "Interrupted rollback; inspect retained before/after content locally"; await this.save(); throw e; }
      await audit(dirname(this.stateFile), { event: "rolled_back", task_id: id });
      return await this.result(id);
    } finally { /* nothing to release: this instance's work is over */ }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    if (this.active) { this.active.abort.abort(); await this.active.done; }
    if (this.exclusive) {
      await unlink(join(this.legacyLock, "owner.json")).catch(() => undefined);
      // The lock directory may already be gone, and it may legitimately hold another
      // instance's files when two editors share one state path (test fixtures and
      // one-project-per-state setups do). Neither is this instance's error to raise:
      // tearing down must never fail because a sibling already cleaned up.
      await rmdir(this.legacyLock).catch(() => undefined);
    } else {
      // A shared instance never owned the archive, so it must not leave a claim behind
      // that makes the next owner think a second process is still using it.
      const marker = join(dirname(this.stateFile), "instance.shared");
      try { const owned = JSON.parse(await readFile(marker, "utf8")); if (owned.pid === process.pid) await unlink(marker); } catch { /* not ours or already gone */ }
    }
  }

  /** Local operator recovery only. Deliberately not exposed through MCP. */
  async inspectRecovery(id: string) {
    await this.reload();
    const t = this.task(id), p = this.project(t.project_id);
    const files = [];
    for (const c of t.changes) {
      const attempt = proposedBytes(c.path, t.before[c.path] ?? null, c.content);
      const current = await this.source(p, c.path, true);
      const currentSha = current?.sha256 ?? null;
      files.push({ path: c.path, current_sha256: currentSha, encoding: current?.encoding ?? null,
        matches_before: currentSha === c.expected_sha256, matches_proposal: currentSha === (attempt === null ? null : sha256(attempt)) });
    }
    return { ...await this.result(id), files };
  }
  /** The error prefixes that mean "this round stopped in the middle of writing files".
   * They are matched by prefix because the message now names WHERE it stopped (an
   * interrupted apply, an interrupted rollback, or a process that simply vanished), and a
   * fixed string comparison would have silently stopped recognising them. */
  private interruptedErrors() {
    return ["Round interrupted while applying", "Round interrupted while rolling back", "Interrupted apply", "Interrupted rollback", "SNAPSHOT_CLEANUP_FAILED"];
  }
  async recoverApply(id: string) {
    if (this.busy || this.closing) failure("EDITOR_BUSY", "Editor operation is active");
    const t = this.task(id), p = this.project(t.project_id);
    if (t.state !== "recovery_required" || !this.interruptedErrors().some(prefix => (t.error ?? "").startsWith(prefix))) failure("TASK_STATE", "Only interrupted file applications can be rolled back automatically");
    this.busy = true;
    try {
      const inspection = await this.inspectRecovery(id);
      if (inspection.files.some(f => !f.matches_before && !f.matches_proposal)) failure("FILE_CHANGED", "External changes found; preserve files and reconcile manually");
      for (const c of t.changes) {
        const attempt = proposedBytes(c.path, t.before[c.path] ?? null, c.content);
        const current = await this.source(p, c.path, true);
        if ((current?.sha256 ?? null) !== c.expected_sha256) {
          // The path currently holds this round's proposal, so that is the state the
          // recovery write finds — not the guard, which describes the pre-write state.
          await this.replace(p, c.path, attempt === null ? null : sha256(attempt), originalFor(c.path, t.before[c.path] ?? null)?.bytes ?? null);
        }
      }
      t.state = "fail"; t.validation_session = null; t.error = "INTERRUPTED_APPLY_ROLLED_BACK"; await this.save();
      return this.result(id);
    } finally { this.busy = false; }
  }
}

export function validationEnvironment(host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ"]) if (host[key]) env[key] = host[key]!;
  env.CI = "true";
  return env;
}
/** How much of one validation command's output survives. Both ends are kept on purpose: see
 * `append` below for the failure that made the head-only cut useless. */
const REPORT_HEAD_CHARS = 6_000, REPORT_TAIL_CHARS = 10_000;
async function runCommand(step: Config["workspaces"][number]["validation"][number], cwd: string, signal: AbortSignal): Promise<Report> {
  if (signal.aborted) return { name: step.name, exit_code: null, timed_out: false, cancelled: true, termination_confirmed: true, output: "", output_truncated: false };
  return new Promise(resolve => {
    const child = spawn(step.argv[0]!, step.argv.slice(1), { cwd, env: validationEnvironment(process.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32" });
    let head = "", tail = "", seen = 0, truncated = false, timedOut = false, cancelled = false, settled = false, terminationConfirmed = true;
    let grace: NodeJS.Timeout | undefined;
    // A long validation prints its failures LAST: `node --test` streams the ✔ lines as it goes
    // and puts the failing cases and the totals at the end. Keeping only the first 16000
    // characters therefore threw away exactly the part a caller needs — a real 6-minute round
    // failed on this project's own suite and came back as `output: "[truncated]"` with no reason
    // in it, so neither the client nor the user could tell what broke. Keep BOTH ends, and say
    // in the middle how much was dropped.
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      seen += text.length;
      head = (head + text).slice(0, REPORT_HEAD_CHARS + REPORT_TAIL_CHARS);
      tail = (tail + text).slice(-REPORT_TAIL_CHARS);
      truncated ||= seen > REPORT_HEAD_CHARS + REPORT_TAIL_CHARS;
    };
    const reportOutput = () => seen <= REPORT_HEAD_CHARS + REPORT_TAIL_CHARS
      ? head
      : `${head.slice(0, REPORT_HEAD_CHARS)}\n\n…[${seen - REPORT_HEAD_CHARS - REPORT_TAIL_CHARS} characters omitted from the middle of this output; the last ${REPORT_TAIL_CHARS} follow]…\n\n${tail}`;
    child.stdout.on("data", append); child.stderr.on("data", append);
    const stop = () => {
      if (!child.pid) return;
      if (!grace) grace = setTimeout(() => { terminationConfirmed = false; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null); }, 5000);
      if (process.platform === "win32") { const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("error", () => { child.kill(); }); }
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, step.timeout_seconds * 1000);
    const abort = () => { cancelled = true; stop(); }; signal.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); if (grace) clearTimeout(grace); signal.removeEventListener("abort", abort);
      resolve({ name: step.name, exit_code: code, timed_out: timedOut, cancelled, termination_confirmed: terminationConfirmed, output: reportOutput(), output_truncated: truncated });
    };
    child.once("error", () => { append(Buffer.from("\nCould not start configured validation command")); finish(null); });
    child.once("close", finish);
    if (signal.aborted) abort();
  });
}

