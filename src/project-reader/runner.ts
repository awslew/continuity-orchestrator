import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ReaderError } from "./service.js";

/** One round's execution, outside the process that accepted it.
 *
 * Why this exists: a round used to run in the background of the MCP process that
 * received `continuity_local_develop`. Its state lived in that process's memory
 * (`active`, `busy`), so when the process went away the round went away with it and
 * the next startup marked it `cancelled` — tokens spent, nothing on disk. Measured:
 * killing the parent by exact pid leaves a detached child running to completion,
 * while a process-internal round dies with its process.
 *
 * What the boundary does and does not buy, measured on Windows rather than assumed:
 *   - parent exits normally, or is killed by exact pid → the worker survives and finishes;
 *   - parent is killed as a process TREE (`taskkill /T /F`) → the worker dies too.
 * So a worker survives a crash, a plugin reload that only replaces the MCP child, or
 * the parent returning first. It does NOT survive a tunnel restart, which kills the
 * tree. What survives a tree kill is the *evidence*: the worker records its pid and
 * phase in `runner-<task>.json`, so the next startup can tell "the process that owned
 * this round is gone" (an honest interruption, safe to resubmit) from "a worker is
 * still running this round" (leave it alone and keep reading its reports).
 *
 * The trade for durability is that nothing here may trust memory: every view of a
 * round is read from disk, because the process holding the other view may be gone. */
export const RUNNER_VERSION = 1;
const SESSION_FILE = "worker-session.json";
const JOB_DIR = "worker-jobs";
/** A round is a real test suite on a real project: measured 385 s for the target
 * repository. 45 minutes separates "slow" from "hung" without ever cutting a
 * legitimate run, and it is a backstop only — every command has its own timeout. */
export const WORKER_DEADLINE_MS = 45 * 60 * 1000;
/** How long one `continuity_local_result` call may block. It belongs here, next to the
 * execution it observes, because it is a property of the transport rather than of any
 * one tool: the Secure MCP Tunnel dispatcher drops a polled command 120 s after it was
 * polled, and an MCP client aborts at its own request timeout, whose SDK default is 60 s
 * (observed as -32001). A wait asked for 60 s was measured returning at 60.197 s — past
 * that abort. 45 s keeps 15 s of margin under the client and 75 s under the tunnel while
 * still being long enough that a slow round costs a handful of calls, not a poll loop.
 * It is a lease on the caller's turn, never a limit on the round: a timed-out call leaves
 * the round running and the next call with the same task_id reads it. */
export const MAX_WAIT_SECONDS = 45;
/** How long the spawning call waits for the worker to prove it started. It is a
 * liveness check, not a progress check: the worker writes its record before it does
 * any work, so this only waits for process startup. */
export const WORKER_ARM_MS = 15_000;

/** What one worker is doing, as the accepting process reads it.
 *
 * `deadline_at` is when this worker must be presumed STOPPED no matter what its pid
 * says. Without it a record is unkillable evidence: `taskkill /T /F` (the tunnel
 * restart) takes the worker's whole tree down, so nothing ever rewrites the record,
 * and the pid it names is either free or recycled. A reader then treats a round that
 * will never move again as one that is still running — for ever, because the only
 * recovery pass runs at editor creation. The deadline is the worker's own watchdog
 * (`WORKER_DEADLINE_MS`), so a worker that is still alive past it has already been
 * stopped by itself; no legitimate round is cut short by this. */
export const runnerSchema = z.object({
  version: z.literal(1), task_id: z.string(), request_id: z.string().nullable(), job: z.string(),
  action: z.enum(["develop", "undo"]), pid: z.number().int().positive(), log: z.string(),
  started_at: z.string(), phase: z.enum(["starting", "validating", "applying", "rolling_back", "finished"]),
  status: z.enum(["running", "done", "failed"]), finished_at: z.string().nullable(), error: z.string().nullable(),
  deadline_at: z.string().nullable().optional()
}).strict();
export type RunnerRecord = z.infer<typeof runnerSchema>;
export type RunnerPhase = RunnerRecord["phase"];

/** Everything a worker needs to rebuild the exact editor the acceptor used. Stored
 * rather than passed on the command line: a Windows argument list is bounded and
 * shell-quoted, and this object contains absolute paths and a user's project list.
 * It is not trusted — the worker re-runs the full editor validation over it. */
export const workerSessionSchema = z.object({ version: z.literal(1), editor: z.unknown(), reader: z.unknown() }).strict();
export type WorkerSession = { version: 1; editor: unknown; reader: unknown };

const fail = (code: string, message: string): never => { throw new ReaderError(code, message); };

/** Is the process that wrote this record still running? `process.kill(pid, 0)` is a
 * signal-less existence probe on both platforms. A recycled pid reads as alive, which is
 * a safe answer only in the direction that keeps a round running; it is never a safe
 * answer for a round that is over, which is why every caller pairs it with `workerOver`. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Has this worker's own deadline passed? A worker runs a watchdog on exactly this
 * instant and stops itself when it fires, so a record still marked `running` past it no
 * longer describes anything executing. A record written by an older build carries no
 * `deadline_at` and is therefore never stale. */
export function workerStale(record: Pick<RunnerRecord, "deadline_at">, now = Date.now()): boolean {
  if (!record.deadline_at) return false;
  const deadline = Date.parse(record.deadline_at);
  return Number.isFinite(deadline) && now > deadline;
}

/** Is this record definitively FINISHED WITH the round, whatever its status says?
 *
 * Two different questions are asked about a worker record, and conflating them is how a
 * killed round becomes unreadable. They need different tests:
 *
 *   - "has the evidence stopped speaking?" — `recoverInterrupted`. A tree kill takes the
 *     worker down with its parent, so nothing ever rewrites its record; the round must be
 *     resolved by a later process instead of looking live for ever. Either "the pid is
 *     gone" or "the record outlived its own deadline" settles it.
 *   - "can this round still change?" — `result.ready`. The same test, so a caller polling
 *     for the outcome and a process resolving leftovers can never disagree about whether a
 *     round is still live — which is what produced a task that was retired by one and
 *     reported as unfinished by the other.
 *
 * The deadline is what makes this safe to ask from a LONG-LIVED process, where a pid that
 * looks dead may simply have been recycled out from under the probe. A worker runs its own
 * watchdog on that instant and stops itself, so a record past it describes nothing that is
 * still executing whatever the pid test answers — and a record written by an older build,
 * which carries no `deadline_at`, is judged by the pid test alone as that build did. */
export function workerOver(record: RunnerRecord | undefined, now = Date.now()): boolean {
  if (!record) return true;
  if (record.status !== "running") return true;
  return workerStale(record, now) || !processAlive(record.pid);
}

/** Is a live worker still behind this record, as far as the archive can tell? The strict
 * question, for reporting what a worker is DOING right now. */
export function workerRunning(record: RunnerRecord | undefined, now = Date.now()): boolean {
  return !workerOver(record, now);
}

/** Why this round is being judged as leftovers, in a form the caller can act on. */
export function stopReason(record: RunnerRecord | undefined, now = Date.now()): string {
  if (!record) return "the owning process disappeared";
  if (workerStale(record, now)) return `the worker passed its own deadline (state=${record.phase}, pid=${record.pid})`;
  return `pid ${record.pid} is gone (state=${record.phase})`;
}

/** Read-modify-write exclusion for one directory's JSON state, held by `open(..., "wx")`.
 * It replaces the old `instance.lock` DIRECTORY, which had to be held for the whole
 * life of a process and therefore made "one writer" and "one process" the same
 * statement — the reason a second, short-lived process could not share the archive.
 * A lease is taken only around a write, so the acceptor and the worker can both own
 * the same state. Every acquisition is bounded and inspects its owner: a lease left by
 * a killed writer is reclaimed by the next writer instead of needing a human, and a
 * lease whose owner is alive is reported rather than waited out. */
export class StateLock {
  private constructor(private path: string) {}
  static at(directory: string) { return new StateLock(join(directory, "state.lock")); }
  get file() { return this.path; }
  async with<T>(work: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
    const waitMs = options.waitMs ?? 20_000, started = Date.now();
    for (;;) {
      let handle;
      try { handle = await open(this.path, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reclaim()) continue;
        if (Date.now() - started >= waitMs) fail("STATE_BUSY", "Another process is writing this editor state; retry the call");
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); await handle.sync(); }
      finally { await handle.close(); }
      try { return await work(); } finally { await unlink(this.path).catch(() => undefined); }
    }
  }
  /** True when a dead writer's lease was removed and the caller may try again. A
   * malformed lease is treated as a crash artifact: it cannot describe a live owner,
   * and leaving it in place would wedge the project permanently. */
  private async reclaim(): Promise<boolean> {
    let owner: { pid?: unknown } = {};
    try { owner = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if (!(error instanceof SyntaxError)) return false;
    }
    if (typeof owner.pid === "number" && processAlive(owner.pid)) return false;
    await rm(this.path, { force: true });
    return true;
  }
}

/** A crash reason short enough to store. Node reports an uncaught failure as
 * `code`/`errno`/`syscall`, so the operation that failed survives in the record
 * instead of only in a log file an operator has to go find. */
export const crashReason = (value: unknown, limit = 600): string => {
  const text = value instanceof Error
    ? (value.message + (typeof (value as NodeJS.ErrnoException).syscall === "string" ? ` (${(value as NodeJS.ErrnoException).syscall}${(value as NodeJS.ErrnoException).code ? ` ${(value as NodeJS.ErrnoException).code}` : ""})` : ""))
    : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** Replace one file with new content, atomically, tolerating the one way Windows says no.
 *
 * POSIX rename over an open file is always allowed; Windows returns EPERM/EACCES when a
 * reader happens to hold the target at that instant. A reader here is the normal case, not
 * a bug: a caller polls `continuity_local_result` while a round writes its progress. The
 * retry is bounded and short, and a final failure is still reported rather than hidden. */
export async function atomicWrite(target: string, value: string, options: { attempts?: number } = {}): Promise<void> {
  const attempts = options.attempts ?? 12;
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, target); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EACCES") || attempt >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 + attempt * 15));
      }
    }
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Read a file that another process may be replacing at this instant. The same Windows
 * sharing rule applies to readers: a replace can make an otherwise healthy read fail, so a
 * transient refusal is retried instead of being reported as a broken archive. */
export async function tolerantRead(path: string, options: { attempts?: number } = {}): Promise<string> {
  const attempts = options.attempts ?? 12;
  for (let attempt = 0; ; attempt++) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "ENOENT") || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 + attempt * 15));
    }
  }
}

/** What one caller sees about the process behind one round. */
export class RoundRunner {
  private constructor(readonly directory: string, private deadlineMs: number) {}
  static async create(directory: string, options: { deadlineMs?: number } = {}) {
    await mkdir(join(directory, JOB_DIR), { recursive: true });
    return new RoundRunner(directory, options.deadlineMs ?? WORKER_DEADLINE_MS);
  }
  private recordPath(taskId: string) { return join(this.directory, `runner-${taskId}.json`); }
  private jobPath(job: string) { return join(this.directory, JOB_DIR, `${job}.json`); }
  logPath(job: string) { return join(this.directory, JOB_DIR, `${job}.log`); }
  /** One round's record, or undefined when no worker was ever started for it. */
  async record(taskId: string): Promise<RunnerRecord | undefined> {
    try { return runnerSchema.parse(JSON.parse(await tolerantRead(this.recordPath(taskId)))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  /** The worker executable, resolved from this module's own location so the acceptor and
   * the worker can never disagree about which build is running. */
  scriptPath() { return join(dirname(fileURLToPath(import.meta.url)), "runner-worker.js"); }
  async write(taskId: string, value: RunnerRecord) { await this.atomic(this.recordPath(taskId), JSON.stringify(runnerSchema.parse(value))); }
  /** Change only the named fields of a record that must already exist. Read-modify-write
   * is safe here because both writers (worker, cancelling acceptor) pass through it and
   * the last write wins on an intentionally discarded round. */
  async update(taskId: string, patch: Partial<Omit<RunnerRecord, "version" | "task_id">>) {
    const record = await this.record(taskId);
    if (!record) return undefined;
    const next = runnerSchema.parse({ ...record, ...patch });
    await this.atomic(this.recordPath(taskId), JSON.stringify(next));
    return next;
  }
  /** The session file is written by the acceptor before each spawn, so it always
   * describes the config of the process that is starting a round now. */
  async writeSession(session: WorkerSession) { await this.atomic(SESSION_FILE, JSON.stringify(workerSessionSchema.parse(session))); }
  async readSession(): Promise<WorkerSession> {
    try { return workerSessionSchema.parse(JSON.parse(await readFile(join(this.directory, SESSION_FILE), "utf8"))) as WorkerSession; }
    catch { return fail("RUNNER_SESSION", "The worker session record is missing or unreadable; reopen the project and start the round again"); }
  }
  /** Start one round out of process and return as soon as the worker owns it.
   *
   * The wait is for the worker's pid, not for its work: `develop` must return quickly
   * enough that a Chat turn can go on reading status. A worker that dies before it
   * records itself is reported here instead — a round that never started must not be
   * handed back as if it were running. */
  async spawn(input: { taskId: string; requestId: string | null; action: "develop" | "undo"; script: string }) {
    const job = randomUUID(), log = this.logPath(job), record = this.recordPath(input.taskId);
    await unlink(record).catch(() => undefined);
    await this.atomic(this.jobPath(job), JSON.stringify({ version: 1, task_id: input.taskId, request_id: input.requestId, job, action: input.action, directory: this.directory, log, deadline_ms: this.deadlineMs }));
    // The log descriptor is opened here rather than asking a shell to redirect: the
    // spawn stays shell-free, project paths with spaces never reach a command line,
    // and the worker's own stderr lands next to its job.
    const handle = await open(log, "a", 0o600);
    const child = spawn(process.execPath, [input.script], {
      detached: true, windowsHide: true, cwd: this.directory, stdio: ["ignore", handle.fd, handle.fd],
      env: { ...process.env, CONTINUITY_RUNNER_JOB: this.jobPath(job) }
    });
    const spawned = new Promise<void>(resolve => { child.once("spawn", () => resolve()); child.once("error", () => resolve()); });
    child.unref();
    await spawned;
    await handle.close();
    const pid = child.pid ?? 0;
    if (!await this.arm(record, pid)) fail("RUNNER_UNCONFIRMED", "The round's worker did not confirm startup; nothing was started, so the same request can be sent again");
    return { job, pid, log };
  }
  /** Wait for the worker to record itself. Polling a small file is the only signal that
   * does not need an IPC channel, and an IPC channel is exactly the thing that dies
   * with the parent whose death the worker is supposed to survive.
   *
   * The wait is also where the record is stamped with the instant it stops counting as
   * a live round. The worker knows the deadline too, and this is the same value: the
   * job file holds `deadline_ms` and the worker starts its watchdog from it. Stamping
   * here rather than only in the worker matters for the case this exists for — a worker
   * killed before it ever gets to write anything must still leave a record that a later
   * reader can retire. */
  private async arm(record: string, pid: number): Promise<boolean> {
    if (!pid) return false;
    const deadline = Date.now() + WORKER_ARM_MS;
    for (;;) {
      try {
        const parsed = runnerSchema.parse(JSON.parse(await readFile(record, "utf8")));
        if (parsed.pid > 0) {
          // Only fills a gap: a worker that wrote its own deadline (and a record from a
          // build that wrote none) must never be overwritten by this fallback.
          if (!parsed.deadline_at) await this.update(parsed.task_id, { deadline_at: new Date(Date.now() + this.deadlineMs).toISOString() });
          return true;
        }
      } catch { /* not written yet */ }
      if (!processAlive(pid)) return false;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /** Stop one round out of process. A detached child is its own process group, so the
   * validation command it already spawned is unreachable from here; /T addresses the
   * tree, and only an exact pid is ever named. */
  async kill(record: RunnerRecord): Promise<boolean> {
    if (!processAlive(record.pid)) return true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>(resolve => { killer.once("close", () => resolve()); killer.once("error", () => resolve()); });
    } else {
      try { process.kill(-record.pid, "SIGKILL"); } catch { try { process.kill(record.pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    return !processAlive(record.pid);
  }
  /** Single-file atomic replace: a reader sees either the previous content or the new
   * one and never a half-written record, which is what lets readers stay lock-free.
   * An already-absolute path is used as given, so the runner can also address a file it
   * was handed rather than one derived from its own directory. */
  private async atomic(target: string, value: string) {
    const resolved = isAbsolute(target) ? target : join(this.directory, target);
    await mkdir(dirname(resolved), { recursive: true });
    await atomicWrite(resolved, value);
  }
}

