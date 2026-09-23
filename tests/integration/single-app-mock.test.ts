import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { ConfirmationGateRegistry } from "../../src/security/confirmations.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { HandoffStore, workSetHash } from "../../src/persistence/handoff-store.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import { MockWebgptDriveTransport, WebgptDriveAdapter } from "../../src/adapters/webgpt-drive.js";
import { ContinuityMcpServer, type QuotaProvider } from "../../src/mcp/server.js";
import type { QuotaSnapshot } from "../../src/quota/quota-types.js";
import { setTaskStatus, updateLedger } from "../../src/domain/state-machine.js";
import type { ContinuityEnvelope } from "../../src/mcp/result.js";
import type { RemainingWorkItem } from "../../src/domain/types.js";

function quotaSnapshot(primaryBps: number, secondaryBps: number | null, updatedAt = "2026-09-03T00:00:00.000Z"): QuotaSnapshot {
  return {
    sampleId: "sample-int",
    sampledAt: updatedAt,
    updatedAt,
    source: "fixture",
    primary: {
      kind: "primary",
      windowId: "primary-window",
      remainingBps: primaryBps,
      usedBps: 10_000 - primaryBps,
      resetsAt: "2026-09-03T05:00:00.000Z",
      updatedAt,
      derivedRemaining: false,
      derivedUsed: false
    },
    secondary: secondaryBps === null ? null : {
      kind: "secondary",
      windowId: "secondary-window",
      remainingBps: secondaryBps,
      usedBps: 10_000 - secondaryBps,
      resetsAt: "2026-09-09T00:00:00.000Z",
      updatedAt,
      derivedRemaining: false,
      derivedUsed: false
    },
    rawHash: "fixture",
    conflict: false
  };
}

interface Rig {
  root: string;
  server: ContinuityMcpServer;
  coordinator: TaskCoordinator;
  allowlist: Allowlist;
}

function rig(options: { primaryBps?: number; secondaryBps?: number | null; flags?: Partial<typeof DEFAULT_FLAGS>; workerBackend?: ConstructorParameters<typeof ContinuityMcpServer>[0]["workerBackend"] } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "continuity-single-app-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const evidence = new EvidenceWriter(root, 16_384);
  const confirmations = new ConfirmationGateRegistry();
  const coordinator = new TaskCoordinator(store, allowlist, evidence);
  const webgpt = new WebgptDriveAdapter(new MockWebgptDriveTransport());
  const primaryBps = options.primaryBps ?? 2_000;
  const secondaryBps = options.secondaryBps === undefined ? 600 : options.secondaryBps;
  const provider: QuotaProvider = {
    snapshot: () => quotaSnapshot(primaryBps, secondaryBps)
  };
  const serverOptions: ConstructorParameters<typeof ContinuityMcpServer>[0] = {
    coordinator,
    store,
    allowlist,
    confirmations,
    evidence,
    webgpt,
    flags: { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true, ...options.flags },
    quotaProvider: provider,
    // The fixture sample is stamped 2026-09-03T00:00:00Z; a fixed clock one
    // minute later keeps the sample inside the freshness window.
    now: () => new Date("2026-09-03T00:01:00.000Z")
  };
  if (options.workerBackend) serverOptions.workerBackend = options.workerBackend;
  const server = new ContinuityMcpServer(serverOptions);
  return { root, server, coordinator, allowlist };
}

function workItems(): RemainingWorkItem[] {
  return [
    {
      taskId: "item-1",
      parentId: "task-1",
      status: "PENDING",
      dependencies: [],
      acceptance: ["criterion one"],
      acceptancePassed: false,
      evidence: [],
      lastCheckpoint: null,
      sourceOfTruth: "source-plan"
    },
    {
      taskId: "item-2",
      parentId: "task-1",
      status: "PENDING",
      dependencies: ["item-1"],
      acceptance: ["criterion two"],
      acceptancePassed: false,
      evidence: [],
      lastCheckpoint: null,
      sourceOfTruth: "source-plan"
    }
  ];
}

function registerTask(rig: Rig, items: RemainingWorkItem[] = workItems()): string {
  rig.coordinator.registerTask({
    ledger: {
      taskId: "task-1",
      projectId: "project-1",
      repositoryId: "repo-1",
      threadId: "thread-original",
      remainingWork: items,
      sourceHashes: { remaining_work: workSetHash(items.filter((item) => item.status !== "DONE")) }
    },
    workspaceId: "default",
    actor: "codex"
  });
  return "task-1";
}

async function prepareAndAttach(rig: Rig): Promise<ContinuityEnvelope> {
  registerTask(rig);
  const prepared = await rig.server.call("continuity_prepare_handoff", { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-handoff-1" }, "req-1");
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const created = await rig.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "create", payload: {}, expected_revision: 4, idempotency_key: "idem-create-1" },
    "req-3"
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const attached = await rig.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "attach", payload: {}, idempotency_key: "idem-attach-1" },
    "req-4"
  );
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.equal((attached.data as { state: string }).state, "WEB_UNATTENDED_EXECUTING");
  return attached;
}

test("the single app exposes only high-level tools and stays fail-closed when disabled", async () => {
  const app = rig();
  const tools = app.server.listTools();
  assert.ok(tools.length >= 17);
  assert.ok(tools.every((tool) => tool.name.startsWith("continuity_")));
  assert.ok(!tools.some((tool) => tool.name.includes("bridge") || tool.name.includes("child")), "child MCP tools are hidden");

  const disabled = rig({ flags: { CONTINUITY_ORCHESTRATOR_ENABLED: false } });
  const denied = await disabled.server.call("continuity_task_status", { task_id: "task-1" }, "req-0");
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "FEATURE_DISABLED");

  const unknown = await app.server.call("totally_unknown_tool", {}, "req-0");
  assert.equal(unknown.error?.code, "TOOL_UNKNOWN");
});

test("quota snapshot reflects the provider and refuses stale samples", async () => {
  const app = rig();
  const fresh = await app.server.call("continuity_quota_snapshot", {}, "req-q1");
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal((fresh.data as { status: string }).status, "available", "2000bps (20 percent) is above the depletion threshold");
  assert.equal((fresh.data as { drain_required: boolean }).drain_required, false);

  const depletedApp = rig({ primaryBps: 500 });
  const depleted = await depletedApp.server.call("continuity_quota_snapshot", {}, "req-q1b");
  assert.equal(depleted.ok, true, JSON.stringify(depleted));
  assert.equal((depleted.data as { status: string }).status, "depleted", "500bps (5 percent) is the depletion threshold");
  assert.equal((depleted.data as { drain_required: boolean }).drain_required, true);

  const staleRoot = mkdtempSync(join(tmpdir(), "continuity-stale-"));
  const staleStore = new HandoffStore(staleRoot);
  const staleAllowlist = new Allowlist();
  staleAllowlist.registerWorkspace({ workspaceId: "default", root: staleRoot });
  const staleCoordinator = new TaskCoordinator(staleStore, staleAllowlist, new EvidenceWriter(staleRoot, 16_384));
  const staleServer = new ContinuityMcpServer({
    coordinator: staleCoordinator,
    store: staleStore,
    allowlist: staleAllowlist,
    confirmations: new ConfirmationGateRegistry(),
    evidence: new EvidenceWriter(staleRoot, 16_384),
    webgpt: new WebgptDriveAdapter(new MockWebgptDriveTransport()),
    flags: { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true },
    quotaProvider: { snapshot: () => quotaSnapshot(2_000, 600, "2020-01-01T00:00:00.000Z") },
    now: () => new Date("2026-09-03T06:00:00.000Z")
  });
  const stale = await staleServer.call("continuity_quota_snapshot", {}, "req-q2");
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, "RED_FLAGGED_INPUT");
  assert.match(stale.error?.message ?? "", /stale/);
});

test("task lifecycle: status, checkpoint, revision conflict and idempotent replay", async () => {
  const app = rig();
  registerTask(app);

  const status = await app.server.call("continuity_task_status", { task_id: "task-1" }, "req-s1");
  assert.equal(status.ok, true);
  assert.equal((status.data as { state: string }).state, "CODEX_ACTIVE");
  assert.equal((status.data as { next_action: string }).next_action, "quota_watch_or_drain");

  const checkpoint = await app.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://1", expected_revision: 1, idempotency_key: "idem-cp-1" },
    "req-s2"
  );
  assert.equal(checkpoint.ok, true);
  assert.equal((checkpoint.data as { revision: number }).revision, 2);

  const conflict = await app.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://2", expected_revision: 1, idempotency_key: "idem-cp-2" },
    "req-s3"
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, "REVISION_CONFLICT");

  const replay = await app.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://1", expected_revision: 1, idempotency_key: "idem-cp-1" },
    "req-s4"
  );
  assert.equal(replay.ok, true);
  assert.ok((replay.warnings as string[]).includes("idempotent replay"));
  assert.equal((replay.data as { revision: number }).revision, 2, "replay returns the original receipt, not a new mutation");

  const reused = await app.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://different", expected_revision: 2, idempotency_key: "idem-cp-1" },
    "req-s5"
  );
  assert.equal(reused.ok, false);
  assert.equal(reused.error?.code, "IDEMPOTENCY_KEY_REUSED");

  const unknownTask = await app.server.call("continuity_task_status", { task_id: "task-unregistered" }, "req-s6");
  assert.equal(unknownTask.ok, false);
  assert.equal(unknownTask.error?.code, "RED_FLAGGED_INPUT");
});

test("handoff delivery loop: manifest, chunk reads, tamper rejection and web acceptance", async () => {
  const app = rig();
  registerTask(app);
  const prepared = await app.server.call(
    "continuity_prepare_handoff",
    { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-handoff-1" },
    "req-h1"
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal((prepared.data as { state: string }).state, "HANDOFF_READY");
  const manifestHash = (prepared.data as { manifest_hash: string }).manifest_hash;
  const chunkCount = (prepared.data as { chunk_count: number }).chunk_count;

  const manifest = await app.server.call("continuity_handoff_manifest_read", { task_id: "task-1" }, "req-h2");
  assert.equal(manifest.ok, true);
  const manifestData = manifest.data as { manifest: { chunks: Array<{ index: number; sha256: string }>; manifest_hash: string } };
  assert.equal(manifestData.manifest.chunks.length, chunkCount);
  assert.equal(manifestData.manifest.manifest_hash, manifestHash);

  let content = "";
  for (const chunk of manifestData.manifest.chunks) {
    const read = await app.server.call(
      "continuity_handoff_chunk_read",
      { task_id: "task-1", chunk_index: chunk.index, chunk_hash: chunk.sha256 },
      `req-h3-${chunk.index}`
    );
    assert.equal(read.ok, true, JSON.stringify(read));
    content += (read.data as { chunk: { content: string } }).chunk.content;
  }
  assert.ok(content.includes("continuity.handoff.v1"), "chunks reassemble the handoff document");

  const tampered = await app.server.call(
    "continuity_handoff_chunk_read",
    { task_id: "task-1", chunk_index: 0, chunk_hash: "sha256:tampered0000" },
    "req-h4"
  );
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error?.code, "HANDOFF_RECONCILIATION_FAILED");

  const accepted = await app.server.call(
    "continuity_handoff_accept",
    { task_id: "task-1", manifest_hash: manifestHash, client_ref: "web-client-1", idempotency_key: "idem-accept-1" },
    "req-h5"
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal((accepted.data as { accept_receipt: { accepted: boolean } }).accept_receipt.accepted, true);

  const wrongHash = await app.server.call(
    "continuity_handoff_accept",
    { task_id: "task-1", manifest_hash: "sha256:wrong000000", client_ref: "web-client-2", idempotency_key: "idem-accept-2" },
    "req-h6"
  );
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.error?.code, "HANDOFF_RECONCILIATION_FAILED");
});

test("web session actions: create is revision-guarded, attach requires ack, send carries receipts", async () => {
  const app = rig();
  registerTask(app);
  await app.server.call("continuity_prepare_handoff", { task_id: "task-1", expected_revision: 1, idempotency_key: "idem-handoff-1" }, "req-w0");

  const badRevision = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "create", payload: {}, expected_revision: 99, idempotency_key: "idem-create-bad" },
    "req-w1"
  );
  assert.equal(badRevision.ok, false);
  assert.equal(badRevision.error?.code, "REVISION_CONFLICT");

  const created = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "create", payload: {}, expected_revision: 4, idempotency_key: "idem-create-1" },
    "req-w2"
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const chatId = (created.data as { web_chat_id: string }).web_chat_id;
  assert.match(chatId, /^chat_mock_task-1_/);

  const sendBeforeAttach = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "send", payload: { message: "hello" }, idempotency_key: "idem-send-early" },
    "req-w3"
  );
  assert.equal(sendBeforeAttach.ok, true, "send is allowed in HANDOFF_READY for the bootstrap message");

  const attach = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "attach", payload: {}, idempotency_key: "idem-attach-1" },
    "req-w4"
  );
  assert.equal(attach.ok, true, JSON.stringify(attach));
  assert.equal((attach.data as { state: string }).state, "WEB_UNATTENDED_EXECUTING");
  assert.match((attach.data as { bootstrap_message_id: string }).bootstrap_message_id, /^msg_mock_/);

  const execution = await app.server.call("continuity_task_status", { task_id: "task-1" }, "req-w5");
  assert.equal((execution.data as { execution_substate: string }).execution_substate, "EXECUTING");

  const send = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "send", payload: { message: "continue with item-1" }, idempotency_key: "idem-send-1" },
    "req-w6"
  );
  assert.equal(send.ok, true);
  assert.equal((send.data as { terminal: boolean }).terminal, false);

  const read = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "read", payload: {} },
    "req-w7"
  );
  assert.equal(read.ok, true);
  assert.equal((read.data as { terminal: boolean }).terminal, false, "reads are never terminal");

  const stopped = await app.server.call(
    "continuity_web_session",
    { task_id: "task-1", action: "stop", payload: {}, idempotency_key: "idem-stop-1" },
    "req-w8"
  );
  assert.equal(stopped.ok, true);
  assert.equal((stopped.data as { terminal: boolean }).terminal, false, "stop records a receipt but is not a terminal reason");
});

test("worker run routes through the executor policy and needs a backend", async () => {
  const app = rig({ flags: { CONTINUITY_CLAUDE_ENABLED: true } });
  registerTask(app);
  const noBackend = await app.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "claude", instruction_ref: { kind: "checkpoint_ref", ref: "checkpoint://1" }, expected_revision: 1, idempotency_key: "idem-worker-1" },
    "req-k1"
  );
  assert.equal(noBackend.ok, false);
  assert.equal(noBackend.error?.code, "WORKER_BACKEND_UNAVAILABLE");
  assert.equal(noBackend.error?.retryable, true);

  const attempts: Array<{ workerKind: string; idempotencyKey: string }> = [];
  const backendApp = rig({
    flags: { CONTINUITY_CLAUDE_ENABLED: true, CONTINUITY_DSH_ENABLED: true },
    workerBackend: {
      async run(input) {
        attempts.push({ workerKind: input.workerKind, idempotencyKey: input.idempotencyKey });
        return { realJobId: `job-${attempts.length}`, attemptId: `attempt-${attempts.length}`, status: "queued", evidenceRefs: [".ai-handoff/task-1/evidence/worker.json"] };
      }
    }
  });
  registerTask(backendApp);
  const run = await backendApp.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "claude", instruction_ref: { kind: "checkpoint_ref", ref: "checkpoint://1" }, expected_revision: 1, idempotency_key: "idem-worker-2" },
    "req-k2"
  );
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal((run.data as { real_job_id: string }).real_job_id, "job-1");
  assert.deepEqual(attempts.map((attempt) => attempt.workerKind), ["claude"]);

  const dshRun = await backendApp.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "dsh", instruction_ref: { kind: "handoff_item", ref: ".ai-handoff/task-1/handoff.md" }, expected_revision: 1, idempotency_key: "idem-worker-3" },
    "req-k3"
  );
  assert.equal(dshRun.ok, true, JSON.stringify(dshRun));
  assert.deepEqual(attempts.map((attempt) => attempt.workerKind), ["claude", "dsh"]);

  const flagsOff = rig({ flags: { CONTINUITY_CLAUDE_ENABLED: false, CONTINUITY_DSH_ENABLED: false, CONTINUITY_ENGINEERING_BRIDGE_ENABLED: false } });
  registerTask(flagsOff);
  const disabled = await flagsOff.server.call(
    "continuity_worker_run",
    { task_id: "task-1", worker_kind: "claude", instruction_ref: { kind: "checkpoint_ref", ref: "checkpoint://1" }, expected_revision: 1, idempotency_key: "idem-worker-4" },
    "req-k4"
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error?.code, "WORKER_BACKEND_DISABLED");
});

test("prepare return refuses active execution, then returns after completion and quota hysteresis", async () => {
  const app = rig();
  await prepareAndAttach(app);

  const tooEarly = await app.server.call(
    "continuity_prepare_return",
    { task_id: "task-1", idempotency_key: "idem-return-1" },
    "req-r1"
  );
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error?.code, "TERMINAL_GUARD_FAILED", "incomplete work is never terminal");

  // The runtime marks all work complete with auditable evidence.
  let ledger = app.coordinator.get("task-1");
  for (const item of [...ledger.remainingWork]) {
    ledger = setTaskStatus(ledger, item.taskId, "DONE", { expectedRevision: ledger.revision, acceptancePassed: true, checkpointRef: "checkpoint://done" });
  }
  ledger = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
    for (const item of draft.remainingWork) item.evidence = ["receipt:mock-complete"];
  });
  app.coordinator.save(ledger, "runtime_complete", "runtime");

  // The return gate refuses to declare a complete return checkpoint when the
  // ledger has none.  RETURN_READY is what the original Codex thread resumes
  // from, so a missing checkpoint reference is a blocker, not a formality —
  // the gate used to assert `returnCheckpointComplete: true` unconditionally.
  const noCheckpoint = await app.server.call(
    "continuity_prepare_return",
    { task_id: "task-1", idempotency_key: "idem-return-nocp" },
    "req-r1b"
  );
  assert.equal(noCheckpoint.ok, false);
  assert.equal(noCheckpoint.error?.code, "RETURN_GATE_NOT_READY");
  assert.ok(
    (noCheckpoint.data as { blockers: string[] }).blockers.some((blocker) => blocker.includes("checkpoint")),
    JSON.stringify(noCheckpoint.data)
  );

  const checkpointed = await app.server.call(
    "continuity_checkpoint",
    { task_id: "task-1", checkpoint: "checkpoint://return-1", expected_revision: app.coordinator.get("task-1").revision, idempotency_key: "idem-cp-return" },
    "req-r1c"
  );
  assert.equal(checkpointed.ok, true, JSON.stringify(checkpointed));

  const prepared = await app.server.call(
    "continuity_prepare_return",
    { task_id: "task-1", idempotency_key: "idem-return-2" },
    "req-r2"
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal((prepared.data as { state: string }).state, "RETURN_READY");
  assert.equal((prepared.data as { terminal_reason: string }).terminal_reason, "ALL_TASKS_COMPLETED");

  const resume = await app.server.call(
    "continuity_resume_codex",
    { task_id: "task-1", expected_revision: (prepared.data as { revision: number }).revision, idempotency_key: "idem-resume-1" },
    "req-r3"
  );
  assert.equal(resume.ok, false);
  assert.equal(resume.error?.code, "RESUME_BACKEND_UNAVAILABLE", "no substitute thread may fake a resume");
  assert.equal((resume.data as { original_thread_id: string }).original_thread_id, "thread-original");
});
