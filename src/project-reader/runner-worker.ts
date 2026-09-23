/** The worker: one round, in its own process.
 *
 * Started detached by `RoundRunner.spawn` and told which job to run through
 * `CONTINUITY_RUNNER_JOB`, never through an argument list — a job file has no length
 * limit and no quoting rules, and it lets the record of what was asked survive the
 * process that asked.
 *
 * It re-derives everything from disk: the editor config, the reader config, and the task.
 * Nothing is inherited from the acceptor except the two config structures, and those go
 * through the same validation as any other call. That is what makes the round survivable:
 * by the time the worker starts, the acceptor is no longer needed.
 *
 * The exit code is only a diagnosis for a human reading a job log. The durable record is
 * `runner-<task>.json` and the task state in `tasks.json`, because the process that would
 * have read the exit status may itself be gone. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ProjectEditor } from "./editor.js";
import { RoundRunner, crashReason, type RunnerPhase } from "./runner.js";
import { audit } from "./checkpoint.js";

const jobSchema = z.object({
  version: z.literal(1), task_id: z.string(), request_id: z.string().nullable(), job: z.string(),
  action: z.enum(["develop", "undo"]), directory: z.string(), log: z.string(), deadline_ms: z.number().int().positive()
}).strict();

export async function runWorker() {
  const path = process.env.CONTINUITY_RUNNER_JOB;
  if (!path) throw new Error("CONTINUITY_RUNNER_JOB is not set; this entry point is started by the round runner, not by hand");
  const job = jobSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const runner = await RoundRunner.create(job.directory);
  const session = await runner.readSession();
  // From this instant this worker must be presumed stopped once its deadline passes,
  // whatever its pid says afterwards: a tree kill leaves the record behind, and the pid
  // it names can be recycled. Carrying the deadline in the record is what lets a later
  // reader retire it instead of reporting a round that can never move again.
  const deadlineAt = new Date(Date.now() + job.deadline_ms).toISOString();
  await runner.write(job.task_id, {
    version: 1, task_id: job.task_id, request_id: job.request_id, job: job.job, action: job.action,
    pid: process.pid, log: job.log, started_at: new Date().toISOString(), phase: "starting",
    status: "running", finished_at: null, error: null, deadline_at: deadlineAt
  });
  // Slow is not hung. This only exists so a worker that wedges cannot hold a project
  // forever; it is far above the longest measured round, and every command inside the
  // round has its own, tighter timeout.
  const deadline = setTimeout(() => {
    void finish("failed", `Worker exceeded ${Math.round(job.deadline_ms / 60000)} minutes and was stopped`);
  }, job.deadline_ms);
  deadline.unref();
  const phase = (value: RunnerPhase) => runner.update(job.task_id, { phase: value }).then(() => undefined);
  let settled = false;
  const finish = async (status: "done" | "failed", error: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    await runner.update(job.task_id, { status, phase: "finished", finished_at: new Date().toISOString(), error }).catch(() => undefined);
  };
  try {
    // Shared, exactly like the process that started this one: the archive's actual
    // exclusion is `state.lock`, held only around a write, so no process has to own the
    // directory for its whole life to use it. A worker that demanded the old crash lease
    // would be refused by the very process that spawned it.
    const editor = await ProjectEditor.create(session.editor, session.reader as never, { exclusive: false });
    try {
      await editor.reload();
      if (job.action === "undo") {
        await editor.rollback(job.task_id, { onPhase: phase });
      } else {
        await editor.runRound(job.task_id, { onPhase: phase });
      }
      await finish("done", null);
      await audit(job.directory, { event: "worker_finished", task_id: job.task_id, action: job.action, pid: process.pid }).catch(() => undefined);
    } finally { await editor.close(); }
    return 0;
  } catch (error) {
    const text = crashReason(error);
    console.error(`[round-worker] caught ${text}`);
    await finish("failed", text);
    await audit(job.directory, { event: "worker_failed", task_id: job.task_id, action: job.action, pid: process.pid, error: text }).catch(() => undefined);
    console.error(`[round-worker] ${job.task_id}: ${text}`);
    return 1;
  }
}

async function main() {
  return await runWorker().catch(error => { console.error(`[round-worker] ${crashReason(error)}`); return 1; });
}

// An explicit env marker rather than an argv comparison: the same file is imported by
// tests, and a path test that is subtly wrong on Windows would either start a real round
// during a test or refuse to start one in production. The marker is set by the only thing
// that spawns workers, and it cannot be true by accident.
if (process.env.CONTINUITY_RUNNER_JOB) process.exit(await main());
