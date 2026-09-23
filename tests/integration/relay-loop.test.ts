/**
 * Relay (Plus) loop — integration coverage for the wiring that closed the
 * contract gaps, not for the adapters underneath it.
 *
 * Everything here is *local contract evidence*: the real drain / supervision /
 * resume code paths are exercised, but the Codex App Server and the worker
 * control upstream are mock transports.  No real web page, tunnel or account is
 * involved, and nothing below claims otherwise.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { ConfirmationGateRegistry } from "../../src/security/confirmations.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { HandoffStore, workSetHash } from "../../src/persistence/handoff-store.js";
import { FileRelayServerStore } from "../../src/persistence/runtime-durable-stores.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import { WorkerSupervisionController } from "../../src/workflow/supervision.js";
import { MockWebgptDriveTransport, WebgptDriveAdapter } from "../../src/adapters/webgpt-drive.js";
import { CodexAppServerAdapter, MockAppServerTransport } from "../../src/adapters/codex-app-server.js";
import { ContinuityMcpServer, type QuotaProvider, type WorkerControlBackend } from "../../src/mcp/server.js";
import { setTaskStatus, transitionLedger, updateLedger } from "../../src/domain/state-machine.js";
import type { ContinuityEnvelope } from "../../src/mcp/result.js";
import type { QuotaSnapshot } from "../../src/quota/quota-types.js";
import type { RemainingWorkItem, TaskLedger } from "../../src/domain/types.js";

const CLOCK = "2026-09-03T00:01:00.000Z";

function quotaSnapshot(primaryBps = 5_000, secondaryBps: number | null = 600): QuotaSnapshot {
  const updatedAt = "2026-09-03T00:00:00.000Z";
  return {
    sampleId: "sample-relay",
    sampledAt: updatedAt,
    updatedAt,
    source: "fixture",
    primary: { kind: "primary", windowId: "primary-window", remainingBps: primaryBps, usedBps: 10_000 - primaryBps, resetsAt: "2026-09-03T05:00:00.000Z", updatedAt, derivedRemaining: false, derivedUsed: false },
    secondary: secondaryBps === null ? null : { kind: "secondary", windowId: "secondary-window", remainingBps: secondaryBps, usedBps: 10_000 - secondaryBps, resetsAt: "2026-09-09T00:00:00.000Z", updatedAt, derivedRemaining: false, derivedUsed: false },
    rawHash: "fixture",
    conflict: false
  };
}

function workItems(): RemainingWorkItem[] {
  return [
    { taskId: "item-1", parentId: "task-1", status: "DONE", dependencies: [], acceptance: ["criterion one"], acceptancePassed: true, evidence: ["receipt:done"], lastCheckpoint: "checkpoint://item-1", sourceOfTruth: "source-plan" },
    { taskId: "item-2", parentId: "task-1", status: "PENDING", dependencies: ["item-1"], acceptance: ["criterion two"], acceptancePassed: false, evidence: [], lastCheckpoint: null, sourceOfTruth: "source-plan" }
  ];
}

/** Complete-scope thread list proving exactly one visible active thread. */
const COMPLETE_THREAD_LIST = {
  result: {
    visibility: "complete",
    threads: [{ threadId: "thread-original", turnId: "turn-original", projectId: "project-1", status: "active" }]
  }
};

const CONFIRMED_INTERRUPT = { ok: true, receiptId: "interrupt-1", threadId: "thread-original", turnId: "turn-original", status: "confirmed" };

/** A transport whose send dies after the dispatch point: the effect is unknown. */
class AmbiguousSendTransport extends MockWebgptDriveTransport {
  override async send(): Promise<never> {
    throw Object.assign(new Error("connection closed after dispatch"), { code: "UNKNOWN_IN_FLIGHT" });
  }
}

interface RigOptions {
  codexAppServer?: CodexAppServerAdapter;
  workerControl?: WorkerControlBackend;
  serverStore?: FileRelayServerStore;
  workerBackend?: ConstructorParameters<typeof ContinuityMcpServer>[0]["workerBackend"];
  supervision?: WorkerSupervisionController;
  transport?: MockWebgptDriveTransport;
  flags?: Partial<typeof DEFAULT_FLAGS>;
  root?: string;
}

interface Rig {
  root: string;
  server: ContinuityMcpServer;
  coordinator: TaskCoordinator;
  allowlist: Allowlist;
  store: HandoffStore;
}

function rig(options: RigOptions = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "continuity-relay-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const evidence = new EvidenceWriter(root, 16_384);
  const confirmations = new ConfirmationGateRegistry();
  const coordinator = new TaskCoordinator(store, allowlist, evidence);
  const provider: QuotaProvider = { snapshot: () => quotaSnapshot() };
  const serverOptions: ConstructorParameters<typeof ContinuityMcpServer>[0] = {
    coordinator,
    store,
    allowlist,
    confirmations,
    evidence,
    webgpt: new WebgptDriveAdapter(options.transport ?? new MockWebgptDriveTransport()),
    flags: {
      ...DEFAULT_FLAGS,
      CONTINUITY_ORCHESTRATOR_ENABLED: true,
      CONTINUITY_AUTO_DRAIN_ENABLED: true,
      CONTINUITY_RETURN_TO_CODEX_ENABLED: true,
      CONTINUITY_ENGINEERING_BRIDGE_ENABLED: true,
      ...options.flags
    },
    quotaProvider: provider,
    // The fixture sample is stamped 2026-09-03T00:00:00Z; a fixed clock one
    // minute later keeps it inside the freshness window.
    now: () => new Date(CLOCK),
    supervision: options.supervision ?? new WorkerSupervisionController()
  };
  if (options.codexAppServer) serverOptions.codexAppServer = options.codexAppServer;
  if (options.workerControl) serverOptions.workerControl = options.workerControl;
  if (options.serverStore) serverOptions.serverStore = options.serverStore;
  if (options.workerBackend) serverOptions.workerBackend = options.workerBackend;
  const server = new ContinuityMcpServer(serverOptions);
  return { root, server, coordinator, allowlist, store };
}

async function register(app: Rig): Promise<ContinuityEnvelope> {
  return app.server.call(
    "continuity_task_register",
    {
      task_id: "task-1",
      project_id: "project-1",
      repository_id: "repo-1",
      thread_id: "thread-original",
      scope_cutoff_at: "2026-09-03T00:00:00.000Z",
      remaining_work: workItems(),
      idempotency_key: "idem-register-1"
    },
    "req-register-1"
  );
}

/** Walk the ledger to RETURN_READY with the state machine, bypassing the web phase. */
function seedReturnReady(app: Rig): void {
  let ledger: TaskLedger = app.coordinator.get("task-1");
  ledger = setTaskStatus(ledger, "item-2", "DONE", { expectedRevision: ledger.revision, acceptancePassed: true, checkpointRef: "checkpoint://item-2" });
  ledger = app.coordinator.save(ledger, "runtime_complete", "runtime");
  ledger = app.coordinator.checkpoint("task-1", "checkpoint://return-1", ledger.revision);
  ledger = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
    for (const item of draft.remainingWork) item.evidence = ["receipt:manual"];
    // Test shortcut: the web phase itself is covered by the web session tests.
    draft.lifecycleState = "WEB_TERMINAL";
    draft.web.terminalReason = "HUMAN_STOP";
    draft.returnHash = "sha256:return";
  });
  ledger = transitionLedger(ledger, "RETURN_READY", {
    expectedRevision: ledger.revision,
    returnReady: true,
    codexQuotaReady: true,
    returnCheckpointComplete: true,
    originalThreadConfirmed: true
  });
  app.coordinator.save(ledger, "return_ready", "web");
}

test("task register binds the remaining-work hash and refuses a duplicate registration", async () => {
  const app = rig();
  const registered = await register(app);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const data = registered.data as { state: string; revision: number; counts: { total: number; remaining: number } };
  assert.equal(data.state, "CODEX_ACTIVE");
  assert.equal(data.revision, 1);
  // Completed work is registered but excluded from the handoff source set.
  assert.deepEqual(data.counts, { total: 2, remaining: 1 });
  const ledger = app.coordinator.get("task-1");
  assert.equal(ledger.sourceHashes["remaining_work"], workSetHash([workItems()[1]!]));

  // Registration is the allowlist gate's other half: every other relay tool
  // begins with assertRegisteredTaskId.
  const status = await app.server.call("continuity_task_status", { task_id: "task-1" }, "req-status-1");
  assert.equal(status.ok, true, JSON.stringify(status));

  const duplicate = await app.server.call(
    "continuity_task_register",
    {
      task_id: "task-1",
      project_id: "project-1",
      repository_id: "repo-1",
      thread_id: "thread-original",
      remaining_work: workItems(),
      idempotency_key: "idem-register-duplicate"
    },
    "req-register-duplicate"
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error?.code, "DUPLICATE_TASK");

  const unknown = await app.server.call("continuity_task_status", { task_id: "task-unknown" }, "req-status-2");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "RED_FLAGGED_INPUT");
});

test("drain runs the whole visible-thread fence and reaches HANDOFF_READY with a written handoff", async () => {
  const transport = new MockAppServerTransport({
    "thread/list": COMPLETE_THREAD_LIST,
    "turn/interrupt": CONFIRMED_INTERRUPT
  });
  const app = rig({ codexAppServer: new CodexAppServerAdapter(transport) });
  await register(app);

  const drained = await app.server.call(
    "continuity_drain",
    { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-drain-1" },
    "req-drain-1"
  );
  assert.equal(drained.ok, true, JSON.stringify(drained));
  const data = drained.data as { state: string; interrupted_threads: string[]; handoff_ref: string; handoff_hash: string; drain_proof_hash: string | null };
  assert.equal(data.state, "HANDOFF_READY");
  assert.deepEqual(data.interrupted_threads, ["thread-original"]);
  assert.equal(data.handoff_ref, ".ai-handoff/task-1/handoff.md");
  assert.ok(data.handoff_hash.length > 0);
  assert.ok(data.drain_proof_hash, "HANDOFF_READY must carry the drain proof");

  // The interrupt was really issued against the original turn, and the handoff
  // document exists on disk — the ledger hash comes from what was written.
  const interrupted = transport.calls.filter((call) => call.method === "turn/interrupt");
  assert.equal(interrupted.length, 1);
  assert.deepEqual(interrupted[0]?.params, { threadId: "thread-original", turnId: "turn-original" });
  assert.equal(existsSync(join(app.root, ".ai-handoff", "task-1", "handoff.md")), true);

  // The manifest is rebuilt from handoff.md, so it is readable without the
  // process that produced it.
  const manifest = await app.server.call("continuity_handoff_manifest_read", { task_id: "task-1" }, "req-drain-2");
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
});

test("drain refuses an unprovable scope, stays in DRAINING and writes no handoff", async () => {
  // No visibility proof: the App Server never established the complete set.
  const transport = new MockAppServerTransport({ "thread/list": { result: { threads: [] } } });
  const app = rig({ codexAppServer: new CodexAppServerAdapter(transport) });
  await register(app);

  const drained = await app.server.call(
    "continuity_drain",
    { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-drain-partial" },
    "req-drain-partial"
  );
  assert.equal(drained.ok, false);
  assert.equal(drained.error?.code, "DRAIN_FENCE_FAILED");
  const data = drained.data as { state: string; scope_known: boolean; faults: Array<{ code: string }> };
  assert.equal(data.state, "DRAINING", "an incomplete drain parks the task where a retry can resume");
  assert.equal(data.scope_known, false);
  assert.ok(data.faults.some((fault) => fault.code === "DRAIN_SCOPE_UNKNOWN"), JSON.stringify(data.faults));
  assert.equal(existsSync(join(app.root, ".ai-handoff", "task-1", "handoff.md")), false, "no handoff may be written for an unproven scope");
  const parked = app.coordinator.get("task-1");
  assert.equal(parked.lifecycleState, "DRAINING");
  assert.equal(parked.fault?.status, "blocked");

  // The drain gate is explicit: with the flag off nothing is attempted at all.
  const disabled = rig({ flags: { CONTINUITY_AUTO_DRAIN_ENABLED: false }, codexAppServer: new CodexAppServerAdapter(transport) });
  await register(disabled);
  const gated = await disabled.server.call("continuity_drain", { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-drain-off" }, "req-drain-off");
  assert.equal(gated.ok, false);
  assert.equal(gated.error?.code, "AUTO_DRAIN_DISABLED");
  assert.equal(disabled.coordinator.get("task-1").lifecycleState, "CODEX_ACTIVE", "a disabled drain must not move the ledger");
});

test("worker control performs the real action, rolls back an unconfirmed one, and refuses unsupported kinds", async () => {
  const calls: Array<{ action: string; attemptId: string }> = [];
  let confirm = true;
  const workerControl: WorkerControlBackend = {
    supportedKinds: ["bridge-dsh"],
    control: async (input) => {
      calls.push({ action: input.action, attemptId: input.attemptId });
      return confirm
        ? { confirmed: true, receipt: { control_task: "ok", action: input.action }, status: "interrupted", code: null, message: null }
        : { confirmed: false, receipt: { control_task: "failed" }, status: "running", code: "BRIDGE_CONTROL_FAILED", message: "the Bridge did not confirm" };
    }
  };
  const stateDir = mkdtempSync(join(tmpdir(), "continuity-relay-store-"));
  const app = rig({
    workerControl,
    serverStore: new FileRelayServerStore(stateDir),
    workerBackend: {
      run: async (input) => ({
        realJobId: "job-1",
        attemptId: input.workerKind === "claude" ? "attempt_claude" : "attempt_bridge",
        status: "running",
        evidenceRefs: []
      })
    }
  });
  await register(app);

  const started = await app.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "bridge-dsh", instruction_ref: { kind: "evidence_ref", ref: "evidence/plan.md" }, expected_revision: 1, idempotency_key: "idem-worker-1" },
    "req-worker-1"
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  const startedData = started.data as { attempt_id: string; attempt_revision: number };
  assert.equal(startedData.attempt_revision, 1);
  const store = new FileRelayServerStore(stateDir);
  assert.equal(store.getAttempt(startedData.attempt_id)?.revision, 1, "the supervised attempt is durable, not process memory");

  // A running worker cannot take `continue`; the guard rejects before any
  // upstream call is made.
  const wrongAction = await app.server.call(
    "continuity_worker_control",
    { attempt_id: startedData.attempt_id, action: "continue", instruction_ref: { kind: "evidence_ref", ref: "evidence/plan.md" }, expected_revision: 1, idempotency_key: "idem-control-wrong" },
    "req-control-wrong"
  );
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.error?.code, "INVALID_WORKER_STATE");
  assert.equal(calls.length, 0, "a rejected action must never reach the upstream");

  confirm = false;
  const unconfirmed = await app.server.call(
    "continuity_worker_control",
    { attempt_id: startedData.attempt_id, action: "interrupt", expected_revision: 1, idempotency_key: "idem-control-fail" },
    "req-control-fail"
  );
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error?.code, "BRIDGE_CONTROL_FAILED");
  assert.equal((unconfirmed.data as { rolled_back: boolean }).rolled_back, true);
  assert.equal(store.getAttempt(startedData.attempt_id)?.revision, 1, "an unconfirmed control must not advance the supervised revision");

  confirm = true;
  const interrupted = await app.server.call(
    "continuity_worker_control",
    { attempt_id: startedData.attempt_id, action: "interrupt", expected_revision: 1, idempotency_key: "idem-control-ok" },
    "req-control-ok"
  );
  assert.equal(interrupted.ok, true, JSON.stringify(interrupted));
  const interruptedData = interrupted.data as { status: string; terminal: boolean; attempt_revision: number };
  assert.equal(interruptedData.status, "failed");
  assert.equal(interruptedData.terminal, true);
  assert.equal(interruptedData.attempt_revision, 2);
  // Both interrupts did reach the upstream — the first one simply came back
  // unconfirmed and was rolled back; the guard-rejected `continue` never did.
  assert.deepEqual(calls, [
    { action: "interrupt", attemptId: startedData.attempt_id },
    { action: "interrupt", attemptId: startedData.attempt_id }
  ]);
  assert.equal(store.getAttempt(startedData.attempt_id)?.terminal, true);

  // A worker kind the wired backend cannot control is refused explicitly rather
  // than reported as stopped.
  const claudeRun = await app.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "claude", instruction_ref: { kind: "checkpoint_ref", ref: "checkpoint://x" }, expected_revision: 1, idempotency_key: "idem-worker-claude" },
    "req-worker-claude"
  );
  assert.equal(claudeRun.ok, true, JSON.stringify(claudeRun));
  const claudeAttempt = (claudeRun.data as { attempt_id: string }).attempt_id;
  const unsupported = await app.server.call(
    "continuity_worker_control",
    { attempt_id: claudeAttempt, action: "interrupt", expected_revision: 1, idempotency_key: "idem-control-claude" },
    "req-control-claude"
  );
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error?.code, "WORKER_CONTROL_UNSUPPORTED");

  // With no seam at all the original fail-closed answer is preserved.
  const bare = rig();
  await register(bare);
  bare.allowlist.registerAttemptId("attempt-known");
  const unwired = await bare.server.call(
    "continuity_worker_control",
    { attempt_id: "attempt-known", action: "interrupt", expected_revision: 1, idempotency_key: "idem-control-bare" },
    "req-control-bare"
  );
  assert.equal(unwired.ok, false);
  assert.equal(unwired.error?.code, "WORKER_CONTROL_BACKEND_UNAVAILABLE");
});

test("recovery after a restart restores tasks and replays durable receipts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "continuity-relay-restart-"));
  const root = mkdtempSync(join(tmpdir(), "continuity-relay-root-"));
  const first = rig({ root, serverStore: new FileRelayServerStore(stateDir) });
  await register(first);
  const checkpointed = await first.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://relay-1", expected_revision: 1, idempotency_key: "idem-cp-1" },
    "req-cp-1"
  );
  assert.equal(checkpointed.ok, true, JSON.stringify(checkpointed));
  const revisionAfterCheckpoint = first.coordinator.get("task-1").revision;

  // A brand new process: fresh coordinator and allowlist, same durable store and
  // the same on-disk ledgers.
  const second = rig({ root, serverStore: new FileRelayServerStore(stateDir) });
  const before = await second.server.call("continuity_task_status", { task_id: "task-1" }, "req-before");
  assert.equal(before.ok, false, "without recovery the restarted app knows nothing");

  const hydration = second.coordinator.hydrate({ workspaceId: "default" });
  assert.deepEqual(hydration.restored, ["task-1"]);
  assert.deepEqual(hydration.skipped, []);
  const recovered = await second.server.call("continuity_task_status", { task_id: "task-1" }, "req-after");
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal((recovered.data as { revision: number }).revision, revisionAfterCheckpoint);
  assert.equal((recovered.data as { checkpoint: string }).checkpoint, "checkpoint://relay-1", "the checkpoint survives the restart");

  // The idempotency receipt is durable: the same key returns the original
  // envelope instead of executing the mutation a second time.
  const replayed = await second.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://relay-1", expected_revision: 1, idempotency_key: "idem-cp-1" },
    "req-cp-replay"
  );
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  assert.ok(replayed.warnings.includes("idempotent replay"), JSON.stringify(replayed.warnings));
  assert.equal(second.coordinator.get("task-1").revision, revisionAfterCheckpoint, "a replay must not advance the ledger");

  // A different payload under the same key is still refused.
  const reused = await second.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://other", expected_revision: 1, idempotency_key: "idem-cp-1" },
    "req-cp-reuse"
  );
  assert.equal(reused.ok, false);
  assert.equal(reused.error?.code, "IDEMPOTENCY_KEY_REUSED");

  // A patched task stays controllable after a restart as well: the supervised
  // attempt is restored into both the store cache and the allowlist.
  const third = rig({
    root,
    serverStore: new FileRelayServerStore(stateDir),
    workerControl: {
      supportedKinds: ["bridge-dsh"],
      control: async () => ({ confirmed: true, receipt: { control_task: "ok" }, status: "interrupted", code: null, message: null })
    },
    workerBackend: { run: async () => ({ realJobId: "job-2", attemptId: "attempt_restart", status: "running", evidenceRefs: [] }) }
  });
  third.coordinator.hydrate({ workspaceId: "default" });
  const run = await third.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "bridge-dsh", instruction_ref: { kind: "evidence_ref", ref: "evidence/plan.md" }, expected_revision: third.coordinator.get("task-1").revision, idempotency_key: "idem-worker-restart" },
    "req-worker-restart"
  );
  assert.equal(run.ok, true, JSON.stringify(run));
  const attemptId = (run.data as { attempt_id: string }).attempt_id;

  const fourth = rig({
    root,
    serverStore: new FileRelayServerStore(stateDir),
    workerControl: {
      supportedKinds: ["bridge-dsh"],
      control: async () => ({ confirmed: true, receipt: { control_task: "ok" }, status: "interrupted", code: null, message: null })
    }
  });
  fourth.coordinator.hydrate({ workspaceId: "default" });
  const restoredControl = await fourth.server.call(
    "continuity_worker_control",
    { attempt_id: attemptId, action: "interrupt", expected_revision: 1, idempotency_key: "idem-control-restart" },
    "req-control-restart"
  );
  assert.equal(restoredControl.ok, true, JSON.stringify(restoredControl));
  assert.equal((restoredControl.data as { status: string }).status, "failed");
});

test("resume returns to the original Codex thread only on a confirmed receipt", async () => {
  const app = rig({
    codexAppServer: new CodexAppServerAdapter(new MockAppServerTransport({
      "thread/list": COMPLETE_THREAD_LIST,
      "turn/interrupt": CONFIRMED_INTERRUPT,
      "thread/resume": { ok: true, receiptId: "resume-1", threadId: "thread-original", newTurnId: "turn-new", status: "resumed" }
    }))
  });
  await register(app);
  seedReturnReady(app);

  const resumed = await app.server.call(
    "continuity_resume_codex",
    { task_id: "task-1", expected_revision: app.coordinator.get("task-1").revision, idempotency_key: "idem-resume-1" },
    "req-resume-1"
  );
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const data = resumed.data as { state: string; original_thread_id: string; resumed_thread_id: string; new_turn_id: string; resume_receipt_id: string };
  assert.equal(data.state, "CODEX_RESUMED");
  assert.equal(data.original_thread_id, "thread-original");
  assert.equal(data.resumed_thread_id, "thread-original", "a replacement thread is never accepted");
  assert.equal(data.new_turn_id, "turn-new");
  assert.equal(data.resume_receipt_id, "resume-1");
  const ledger = app.coordinator.get("task-1");
  assert.equal(ledger.codex.threadId, "thread-original");
  assert.equal(ledger.codex.activeTurnId, "turn-new", "the resumed turn becomes the active turn");
});

test("resume is refused while the return flag is off, and a replacement thread cannot fake it", async () => {
  const responses = {
    "thread/list": COMPLETE_THREAD_LIST,
    "turn/interrupt": CONFIRMED_INTERRUPT,
    "thread/resume": { ok: true, receiptId: "resume-bad", threadId: "replacement-thread", newTurnId: "turn-new", status: "resumed" }
  };
  const off = rig({ flags: { CONTINUITY_RETURN_TO_CODEX_ENABLED: false }, codexAppServer: new CodexAppServerAdapter(new MockAppServerTransport(responses)) });
  await register(off);
  seedReturnReady(off);
  const disabled = await off.server.call(
    "continuity_resume_codex",
    { task_id: "task-1", expected_revision: off.coordinator.get("task-1").revision, idempotency_key: "idem-resume-off" },
    "req-resume-off"
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error?.code, "RETURN_TO_CODEX_DISABLED");
  assert.equal(off.coordinator.get("task-1").lifecycleState, "RETURN_READY", "a disabled resume must not move the relay");

  const on = rig({ codexAppServer: new CodexAppServerAdapter(new MockAppServerTransport(responses)) });
  await register(on);
  seedReturnReady(on);
  const refused = await on.server.call(
    "continuity_resume_codex",
    { task_id: "task-1", expected_revision: on.coordinator.get("task-1").revision, idempotency_key: "idem-resume-bad" },
    "req-resume-bad"
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "RECEIPT_ID_MISMATCH");
  assert.equal((refused.data as { status: string }).status, "failed");
  assert.equal(on.coordinator.get("task-1").lifecycleState, "RETURN_READY", "a failed resume must not advance the relay");
});

test("a throwing web transport parks the task for reconciliation instead of retrying", async () => {
  const app = rig({ transport: new AmbiguousSendTransport() });
  await register(app);
  // Test shortcut for reaching the send precondition; the attach flow itself is
  // covered by the web session tests.
  const ledger = updateLedger(app.coordinator.get("task-1"), { expectedRevision: 1 }, (draft) => {
    draft.lifecycleState = "HANDOFF_READY";
    draft.web.chatId = "chat-1";
  });
  app.coordinator.save(ledger, "seed_handoff_ready", "webgpt");

  const ambiguous = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "send", payload: { message: "handoff" }, idempotency_key: "idem-send-ambiguous" },
    "req-send-ambiguous"
  );
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error?.code, "RECEIPT_LOSS_RECONCILE_REQUIRED");
  const data = ambiguous.data as { action: string; block_same_kind: boolean; substate: string };
  assert.equal(data.action, "halt_and_reconcile");
  assert.equal(data.block_same_kind, true);
  assert.equal(data.substate, "BLOCKED_WAITING");
  const parked = app.coordinator.get("task-1");
  assert.equal(parked.web.executionSubstate, "BLOCKED_WAITING");
  assert.equal(parked.fault?.status, "reconcile_required");
});
