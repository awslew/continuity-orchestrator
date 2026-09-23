import assert from "node:assert/strict";
import test from "node:test";
import {
  addChildTask,
  allTasksCompleted,
  createInitialLedger,
  enterWebTerminal,
  observeQuotaRecovery,
  registerWorker,
  setExecutionSubstate,
  setTaskStatus,
  transitionLedger,
  updateWorker
} from "../../src/domain/state-machine.js";
import { workItemsHash } from "../../src/domain/canonical.js";
import type { HandoffReconciliationProof, QuotaGate, RemainingWorkItem, TaskLedger } from "../../src/domain/types.js";

function item(taskId: string, status: RemainingWorkItem["status"] = "PENDING"): RemainingWorkItem {
  return {
    taskId,
    parentId: null,
    status,
    dependencies: [],
    acceptance: [],
    acceptancePassed: true,
    evidence: [`receipt:${taskId}`],
    lastCheckpoint: null,
    sourceOfTruth: "test-plan"
  };
}

function ledgerWithTasks(ids = ["task-a", "task-b"]): TaskLedger {
  return createInitialLedger({
    taskId: "relay-task",
    projectId: "project",
    repositoryId: "repository",
    relayEpoch: "relay-1",
    threadId: "thread-original",
    remainingWork: ids.map((id) => item(id))
  });
}

function handoffProof(source: TaskLedger): HandoffReconciliationProof {
  const remainingWork = source.remainingWork.filter((work) => work.status !== "DONE").map((work) => ({ ...work, dependencies: [...work.dependencies], acceptance: [...work.acceptance], evidence: [...work.evidence] }));
  const counts = { total: remainingWork.length, remaining: remainingWork.length };
  const sourceHash = workItemsHash(remainingWork);
  return {
    snapshotId: "snapshot-1",
    scopeCutoffAt: source.scopeCutoffAt,
    visibility: "COMPLETE",
    sourceHashes: { ...source.sourceHashes },
    sourceHash,
    counts,
    remainingWork,
    reconciliationReceipt: {
      receiptId: "handoff-receipt-1",
      snapshotId: "snapshot-1",
      visibility: "COMPLETE",
      sourceHash,
      counts,
      checkedAt: "2026-09-01T00:00:00.000Z",
      accepted: true
    },
    handoffHash: "sha256:handoff-1"
  };
}

function webLedger(source = ledgerWithTasks()): TaskLedger {
  let ledger = transitionLedger(source, "DRAINING", { expectedRevision: 0 });
  ledger = transitionLedger(ledger, "HANDOFF_READY", { expectedRevision: 1, handoffProof: handoffProof(ledger), handoffReconciled: true, drainComplete: true, drainScopeKnown: true });
  return transitionLedger(ledger, "WEB_UNATTENDED_EXECUTING", { expectedRevision: 2, webAck: true });
}

function quotaGate(overrides: Partial<QuotaGate> = {}): QuotaGate {
  return {
    status: "depleted",
    primaryRemainingBps: 500,
    secondaryRemainingBps: null,
    sampleUpdatedAt: "2026-09-01T00:00:00.000Z",
    sampledAt: "2026-09-01T00:00:00.000Z",
    codexAvailable: false,
    secondaryGuard: false,
    exhaustedAt: null,
    exhaustedReceiptId: null,
    ...overrides
  };
}

test("seven lifecycle states accept only the forward path", () => {
  let ledger = ledgerWithTasks();
  assert.throws(() => transitionLedger(ledger, "WEB_UNATTENDED_EXECUTING", { expectedRevision: 0 }), { code: "INVALID_TRANSITION" });
  ledger = transitionLedger(ledger, "DRAINING", { expectedRevision: 0 });
  ledger = transitionLedger(ledger, "HANDOFF_READY", { expectedRevision: 1, handoffProof: handoffProof(ledger), handoffReconciled: true, drainComplete: true, drainScopeKnown: true });
  ledger = transitionLedger(ledger, "WEB_UNATTENDED_EXECUTING", { expectedRevision: 2, webAck: true });
  assert.equal(ledger.lifecycleState, "WEB_UNATTENDED_EXECUTING");
  assert.throws(() => transitionLedger(ledger, "CODEX_ACTIVE", { expectedRevision: 3 }), { code: "INVALID_TRANSITION" });
});

test("DRAINING requires all-scope and handoff reconciliation guards", () => {
  const draining = transitionLedger(ledgerWithTasks(), "DRAINING", { expectedRevision: 0 });
  assert.throws(() => transitionLedger(draining, "HANDOFF_READY", { expectedRevision: 1 }), { code: "HANDOFF_SOURCE_REQUIRED" });
  assert.throws(() => transitionLedger(draining, "HANDOFF_READY", { expectedRevision: 1, handoffReconciled: true, drainComplete: true, drainScopeKnown: true }), { code: "HANDOFF_SOURCE_REQUIRED" });
  assert.throws(() => transitionLedger(draining, "HANDOFF_READY", { expectedRevision: 1, handoffProof: handoffProof(draining), drainComplete: true, drainScopeKnown: false }), { code: "HANDOFF_RECONCILIATION_FAILED" });
  const ready = transitionLedger(draining, "HANDOFF_READY", { expectedRevision: 1, handoffProof: handoffProof(draining), handoffReconciled: true, drainComplete: true, drainScopeKnown: true });
  assert.equal(ready.lifecycleState, "HANDOFF_READY");
});

test("partial source snapshots cannot reach HANDOFF_READY even with a boolean hint", () => {
  const draining = transitionLedger(ledgerWithTasks(), "DRAINING", { expectedRevision: 0 });
  const partial = handoffProof(draining);
  partial.remainingWork = [partial.remainingWork[0]!];
  partial.counts = { total: 1, remaining: 1 };
  partial.reconciliationReceipt.counts = { total: 1, remaining: 1 };
  partial.sourceHash = workItemsHash(partial.remainingWork);
  partial.reconciliationReceipt.sourceHash = partial.sourceHash;
  assert.throws(() => transitionLedger(draining, "HANDOFF_READY", {
    expectedRevision: 1,
    handoffProof: partial,
    handoffReconciled: true,
    drainComplete: true,
    drainScopeKnown: true
  }), { code: "HANDOFF_RECONCILIATION_FAILED" });
});

test("WEB_UNATTENDED_EXECUTING substates are not lifecycle terminal states", () => {
  let ledger = webLedger();
  ledger = setExecutionSubstate(ledger, "RETRYING", { expectedRevision: 3 });
  assert.equal(ledger.lifecycleState, "WEB_UNATTENDED_EXECUTING");
  assert.equal(ledger.web.executionSubstate, "RETRYING");
  ledger = setExecutionSubstate(ledger, "BLOCKED_WAITING", { expectedRevision: 4 });
  assert.equal(ledger.web.executionSubstate, "BLOCKED_WAITING");
  ledger = setExecutionSubstate(ledger, "EXECUTING", { expectedRevision: 5 });
  assert.equal(ledger.lifecycleState, "WEB_UNATTENDED_EXECUTING");
  const terminal = enterWebTerminal(ledger, "HUMAN_STOP", {
    expectedRevision: 6,
    stopReceipt: { kind: "human_stop", actor: "user", intent: "STOP_RELAY", commandOrConfirmationId: "stop-substate", timestamp: new Date().toISOString(), relayEpoch: "relay-1", idempotencyKey: "idem-substate", accepted: true }
  });
  assert.throws(() => setExecutionSubstate(terminal, "RETRYING", { expectedRevision: 7 }), { code: "INVALID_TRANSITION" });
});

test("stage completion and empty ready work do not enter terminal", () => {
  let ledger = webLedger();
  ledger = setTaskStatus(ledger, "task-a", "DONE", { expectedRevision: 3 });
  const report = allTasksCompleted(ledger);
  assert.equal(report.ok, false);
  assert.throws(() => enterWebTerminal(ledger, "ALL_TASKS_COMPLETED", {
    expectedRevision: 4,
    completionReceipt: { kind: "all_tasks_completed", receiptId: "completion-1", relayEpoch: "relay-1", timestamp: new Date().toISOString(), intent: "ALL_TASKS_COMPLETED", reason: "ALL_TASKS_COMPLETED", accepted: true }
  }), { code: "TERMINAL_GUARD_FAILED" });
  ledger = setExecutionSubstate(ledger, "BLOCKED_WAITING", { expectedRevision: 4 });
  assert.equal(ledger.lifecycleState, "WEB_UNATTENDED_EXECUTING");
  assert.equal(ledger.counts.remaining, 1);
});

test("Codex recovery while webpage has work only records data and does not preempt", () => {
  const ledger = webLedger();
  const recovered = observeQuotaRecovery(ledger, quotaGate({ status: "available", primaryRemainingBps: 3000, codexAvailable: true }), { expectedRevision: 3 });
  assert.equal(recovered.lifecycleState, "WEB_UNATTENDED_EXECUTING");
  assert.equal(recovered.web.terminalReason, null);
  assert.equal(recovered.quotaGate.codexAvailable, true);
});

test("child tasks stay in the same ledger and prevent completion until done", () => {
  let ledger = webLedger(ledgerWithTasks(["root"]));
  ledger = addChildTask(ledger, { taskId: "child-1", parentId: "root", acceptance: ["child evidence"], evidence: ["receipt:child-1"] }, { expectedRevision: 3 });
  assert.equal(ledger.counts.total, 2);
  assert.equal(ledger.counts.remaining, 2);
  ledger = setTaskStatus(ledger, "root", "DONE", { expectedRevision: 4 });
  assert.equal(allTasksCompleted(ledger).ok, false);
  ledger = setTaskStatus(ledger, "child-1", "DONE", { expectedRevision: 5, acceptancePassed: true });
  assert.equal(allTasksCompleted(ledger).ok, true);
});

test("completion requires auditable evidence and a valid completion receipt", () => {
  let ledger = webLedger(ledgerWithTasks(["task-a"]));
  ledger = setTaskStatus(ledger, "task-a", "DONE", { expectedRevision: 3 });
  ledger.remainingWork[0]!.evidence = [];
  assert.equal(allTasksCompleted(ledger).ok, false);
  assert.match(allTasksCompleted(ledger).reasons.join(";"), /missing_auditable_evidence/);

  const complete = webLedger(ledgerWithTasks(["task-a"]));
  const done = setTaskStatus(complete, "task-a", "DONE", { expectedRevision: 3 });
  assert.equal(allTasksCompleted(done).ok, true);
  assert.throws(() => enterWebTerminal(done, "ALL_TASKS_COMPLETED", {
    expectedRevision: 4,
    completionReceipt: {
      kind: "all_tasks_completed",
      receiptId: "",
      relayEpoch: "relay-1",
      timestamp: "",
      intent: "ALL_TASKS_COMPLETED",
      reason: "ALL_TASKS_COMPLETED",
      accepted: true
    }
  }), { code: "HANDOFF_RECEIPT_INVALID" });
});

test("all tasks plus acceptance, gates, and workers are required for ALL_TASKS_COMPLETED", () => {
  let ledger = webLedger(ledgerWithTasks(["task-a"]));
  ledger = registerWorker(ledger, {
    attemptId: "worker-1",
    kind: "dsh",
    source: "engineering-bridge",
    realJobId: "job-1",
    bridgeTaskId: "bridge-1",
    continuation: "dsh_fresh",
    status: "running",
    evidenceRefs: [],
    terminal: false,
    reconciled: false,
    reaped: false
  }, { expectedRevision: 3 });
  ledger = setTaskStatus(ledger, "task-a", "DONE", { expectedRevision: 4 });
  assert.equal(allTasksCompleted(ledger).ok, false);
  ledger = updateWorker(ledger, "worker-1", "completed", { expectedRevision: 5, terminal: true, reconciled: true, reaped: true });
  assert.equal(allTasksCompleted(ledger).ok, true);
  const terminal = enterWebTerminal(ledger, "ALL_TASKS_COMPLETED", {
    expectedRevision: 6,
    completionReceipt: { kind: "all_tasks_completed", receiptId: "completion-1", relayEpoch: "relay-1", timestamp: new Date().toISOString(), intent: "ALL_TASKS_COMPLETED", reason: "ALL_TASKS_COMPLETED", accepted: true }
  });
  assert.equal(terminal.lifecycleState, "WEB_TERMINAL");
  assert.equal(terminal.web.terminalReason, "ALL_TASKS_COMPLETED");
});

test("failed workers remain unrecovered and block ALL_TASKS_COMPLETED", () => {
  let ledger = webLedger(ledgerWithTasks(["task-a"]));
  ledger = registerWorker(ledger, {
    attemptId: "worker-failed",
    kind: "dsh",
    source: "engineering-bridge",
    realJobId: "job-failed",
    bridgeTaskId: "bridge-failed",
    continuation: "dsh_fresh",
    status: "failed",
    evidenceRefs: [],
    terminal: true,
    reconciled: true,
    reaped: true
  }, { expectedRevision: 3 });
  ledger = setTaskStatus(ledger, "task-a", "DONE", { expectedRevision: 4 });
  const report = allTasksCompleted(ledger);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join(";"), /unrecovered_workers:worker-failed/);
});

test("terminal reasons are closed and human stop requires explicit STOP_RELAY receipt", () => {
  const ledger = webLedger();
  assert.throws(() => enterWebTerminal(ledger, "HUMAN_STOP", { expectedRevision: 3 }), { code: "HUMAN_STOP_REQUIRED" });
  assert.throws(() => enterWebTerminal(ledger, "HUMAN_STOP", {
    expectedRevision: 3,
    stopReceipt: { kind: "human_stop", actor: "user", intent: "STOP_RELAY", commandOrConfirmationId: "stop-1", timestamp: new Date().toISOString(), relayEpoch: "other-relay", idempotencyKey: "idem-1", accepted: true }
  }), { code: "HUMAN_STOP_REQUIRED" });
  const stopped = enterWebTerminal(ledger, "HUMAN_STOP", {
    expectedRevision: 3,
    stopReceipt: { kind: "human_stop", actor: "user", intent: "STOP_RELAY", commandOrConfirmationId: "stop-1", timestamp: new Date().toISOString(), relayEpoch: "relay-1", idempotencyKey: "idem-1", accepted: true }
  });
  assert.equal(stopped.web.terminalReason, "HUMAN_STOP");
});

test("web quota exhaustion is an absorbing terminal for the relay epoch", () => {
  const ledger = webLedger();
  const terminal = enterWebTerminal(ledger, "WEB_QUOTA_EXHAUSTED", {
    expectedRevision: 3,
    quotaReceipt: { kind: "quota_exhausted", receiptId: "web-quota-1", relayEpoch: "relay-1", timestamp: new Date().toISOString(), remainingBps: 0, accepted: true }
  });
  assert.equal(terminal.lifecycleState, "WEB_TERMINAL");
  const recovered = observeQuotaRecovery(terminal, quotaGate({ status: "available", primaryRemainingBps: 5000, codexAvailable: true }), { expectedRevision: 4 });
  assert.equal(recovered.lifecycleState, "WEB_TERMINAL");
  assert.equal(recovered.web.terminalReason, "WEB_QUOTA_EXHAUSTED");
  assert.throws(() => transitionLedger(recovered, "WEB_UNATTENDED_EXECUTING", { expectedRevision: 5, webAck: true }), { code: "INVALID_TRANSITION" });
});

test("return and resume require explicit gates and never invent an original thread", () => {
  const ledger = webLedger();
  const terminal = enterWebTerminal(ledger, "HUMAN_STOP", {
    expectedRevision: 3,
    stopReceipt: { kind: "human_stop", actor: "user", intent: "STOP_RELAY", commandOrConfirmationId: "stop-2", timestamp: new Date().toISOString(), relayEpoch: "relay-1", idempotencyKey: "idem-2", accepted: true }
  });
  assert.throws(() => transitionLedger(terminal, "RETURN_READY", { expectedRevision: 4 }), { code: "TERMINAL_GUARD_FAILED" });
  const ready = transitionLedger(terminal, "RETURN_READY", {
    expectedRevision: 4,
    returnReady: true,
    codexQuotaReady: true,
    returnCheckpointComplete: true,
    originalThreadConfirmed: true
  });
  assert.equal(ready.lifecycleState, "RETURN_READY");
  assert.throws(() => transitionLedger(ready, "CODEX_RESUMED", { expectedRevision: 5 }), { code: "TERMINAL_GUARD_FAILED" });
  const resumed = transitionLedger(ready, "CODEX_RESUMED", { expectedRevision: 5, resumeConfirmed: true });
  assert.equal(resumed.lifecycleState, "CODEX_RESUMED");
});

test("revision is compare-and-set for every state mutation", () => {
  const ledger = webLedger();
  assert.throws(() => setExecutionSubstate(ledger, "RETRYING", { expectedRevision: 0 }), { code: "REVISION_CONFLICT" });
});
