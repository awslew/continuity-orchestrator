import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ReaderError } from "./service.js";

const schema = z.object({ version: z.literal(1), scope: z.string(),
  patches: z.array(z.string()).max(5000),
  workers: z.array(z.string()).max(5000).default([]),
  worker_results: z.record(z.object({ observed_at: z.string(), data: z.record(z.unknown()) }).strict()).default({}),
  in_flight: z.object({ operation: z.string(), task_id: z.string().nullable() }).strict().nullable(),
  receipts: z.record(z.object({ applied: z.literal(true), changed_paths: z.array(z.string()) }).strict())
}).strict();
type State = z.infer<typeof schema>;

/** One lease for the exact Bridge config, shared by every Pro launcher. Never
 * auto-delete a stale lock: crash recovery must inspect effects before reuse. */
export class ProState {
  private constructor(readonly path: string, private lock: string, private state: State) {}
  static async acquire(path: string, scope: unknown, workspaceRoots: string[], options: { recoverIdleOwner?: boolean } = {}) {
    if (!isAbsolute(path)) throw new ReaderError("STATE_INVALID", "State path must be absolute");
    const directory = await realpath(dirname(path));
    if (directory !== dirname(path)) throw new ReaderError("STATE_INVALID", "State directory must use its canonical path");
    for (const root of workspaceRoots) {
      const rel = relative(await realpath(root), directory);
      if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))) throw new ReaderError("STATE_INVALID", "Keep Pro state outside Bridge workspaces");
    }
    const lock = path + ".lock";
    if (options.recoverIdleOwner) {
      try {
        const lockStat = await lstat(lock), ownerPath = join(lock, "owner.json"), ownerStat = await lstat(ownerPath);
        if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1 || ownerStat.size > 4096) throw new ReaderError("INSTANCE_LOCKED", "Invalid lease; inspect it manually");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new ReaderError("INSTANCE_LOCKED", "Invalid lease owner");
        try { process.kill(owner.pid, 0); throw new ReaderError("INSTANCE_LOCKED", "Owner is still alive; stop it normally"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new ReaderError("STATE_INVALID", "Invalid state");
          const retained = schema.parse(JSON.parse(await readFile(path, "utf8")));
          if (retained.scope !== createHash("sha256").update(JSON.stringify(scope)).digest("hex")) throw new ReaderError("STATE_SCOPE_CHANGED", "Scope changed; inspect locally");
          const unsettled = retained.workers.some(task => {
            const result = retained.worker_results[task]?.data;
            return !result || result.ready !== true || result.executor !== "dsh" || !["completed", "waiting_for_supervisor_review"].includes(String(result.state));
          });
          if (retained.in_flight || unsettled) throw new ReaderError("RECONCILE_REQUIRED", "Retained effects or unresolved worker tasks require local reconciliation");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(lock, `${lock}.stale.${randomUUID()}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { await mkdir(lock); } catch { throw new ReaderError("INSTANCE_LOCKED", "Pro state is in use or has a stale crash lock; inspect it locally before recovery"); }
    try {
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { flag: "wx" });
      const hash = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
      let state: State = { version: 1, scope: hash, patches: [], workers: [], worker_results: {}, in_flight: null, receipts: {} };
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4 * 1024 * 1024) throw new Error("Invalid state file");
        state = schema.parse(JSON.parse(await readFile(path, "utf8")));
        if (state.scope !== hash) throw new ReaderError("STATE_SCOPE_CHANGED", "Bridge configuration changed; review retained state before migration");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return new ProState(path, lock, state);
    } catch (error) {
      await unlink(join(lock, "owner.json")).catch(() => undefined);
      await rmdir(lock).catch(() => undefined);
      throw error;
    }
  }
  get patches() { return [...this.state.patches]; }
  get workers() { return [...this.state.workers]; }
  get inFlight() { return this.state.in_flight; }
  get receipts() { return { ...this.state.receipts }; }
  workerResult(task: string) {
    const result = this.state.worker_results[task];
    return result ? { ...result.data, historical: true, observed_at: result.observed_at, current_process_verified: false } : undefined;
  }
  async observeWorker(task: string, data: Record<string, unknown>) {
    if (!this.state.workers.includes(task)) return;
    this.state.worker_results[task] = { observed_at: new Date().toISOString(), data };
    await this.save();
  }
  async begin(operation: string, task: string | null) {
    // A later control can restart execution; an old terminal snapshot must not
    // authorize idle recovery after that control loses its response.
    if (operation === "control_task" && task) delete this.state.worker_results[task];
    this.state.in_flight = { operation, task_id: task };
    await this.save();
  }
  async finish(operation: string, args: Record<string, unknown>, result: Record<string, unknown>) {
    if (!result.error && typeof result.task_id === "string" && ["submit_controlled_patch", "generate_controlled_patch"].includes(operation)) {
      if (!this.state.patches.includes(result.task_id)) this.state.patches.push(result.task_id);
    }
    if (!result.error && typeof result.task_id === "string" && ["run_task", "generate_controlled_patch"].includes(operation)) {
      if (!this.state.workers.includes(result.task_id)) this.state.workers.push(result.task_id);
    }
    if (operation === "apply_controlled_patch" && result.applied === true && typeof args.patch_task_id === "string") {
      this.state.receipts[args.patch_task_id] = { applied: true, changed_paths: z.array(z.string()).parse(result.changed_paths) };
    }
    this.state.in_flight = null;
    await this.save();
  }
  private async save() {
    const value = JSON.stringify(schema.parse(this.state));
    if (Buffer.byteLength(value) > 4 * 1024 * 1024) throw new ReaderError("STATE_LIMIT", "State limit reached; archive reviewed history locally");
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(value); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temp, this.path); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  async close() {
    await unlink(join(this.lock, "owner.json"));
    await rmdir(this.lock);
  }
}
