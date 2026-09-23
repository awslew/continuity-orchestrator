import assert from "node:assert/strict";
import test from "node:test";
import { sha256, workItemsHash } from "../../src/domain/canonical.js";
import type { RemainingWorkItem } from "../../src/domain/types.js";
import { DomainError } from "../../src/domain/errors.js";
import { canRouteExecutor, validateExecutorRequest } from "../../src/routing/executor-policy.js";
import {
  WorkerSupervisionController,
  startWebWorker,
  validateWave2DrainProof,
  type SupervisionAttemptState
} from "../../src/workflow/supervision.js";

function attempt(overrides: Partial<SupervisionAttemptState> = {}): SupervisionAttemptState {
  return {
    taskId: "task-a",
    attemptId: "attempt-a",
    kind: "claude",
    source: "claude_orchestrator",
    continuation: "claude_resume",
    status: "review",
    revision: 0,
    terminal: false,
    ...overrides
  };
}

function completeDrainProof(): Record<string, unknown> {
  const visibleThreads = [{ threadId: "thread-a", turnId: "turn-a", projectId: "project-a", repositoryId: "repo-a", status: "active" }];
  const listHash = sha256(visibleThreads);
  const snapshot = { snapshotId: sha256({ visibilityKnown: true, scope: "all_visible_active", threads: visibleThreads, listHash }), visibilityKnown: true, scope: "all_visible_active", threads: visibleThreads, listHash };
  const remainingWork: RemainingWorkItem[] = [{ taskId: "task-a", parentId: null, status: "PENDING", dependencies: [], acceptance: ["done"], acceptancePassed: false, evidence: [], lastCheckpoint: null, sourceOfTruth: "ledger" }];
  const counts = { total: 1, remaining: 1 };
  const sourceHash = workItemsHash(remainingWork);
  const reconciliationReceipt = { receiptId: "source-receipt-a", snapshotId: "source-snapshot-a", visibility: "COMPLETE", sourceHash, counts, checkedAt: "2026-09-01T00:00:00.000Z", accepted: true };
  const handoffSourceReconciliationProof = { snapshotId: "source-snapshot-a", scopeCutoffAt: "2026-09-01T00:00:00.000Z", visibility: "COMPLETE", sourceHashes: { source_plan: "sha256:plan" }, sourceHash, counts, remainingWork, reconciliationReceipt, handoffHash: "sha256:handoff" };
  const handoffReconciliation = { ok: true, missing: [], extra: [], mismatched: [], duplicateSource: [], duplicateHandoff: [], sourceCount: counts, handoffCount: counts, sourceHash, handoffHash: sourceHash, sourceHashesMatch: true, errors: [] };
  return {
    ok: true,
    state: "HANDOFF_READY",
    scopeKnown: true,
    threadSnapshot: snapshot,
    visibleThreadSnapshot: snapshot,
    visibleThreads,
    drainSet: [{ threadId: "thread-a", turnId: "turn-a", projectId: "project-a", registered: true, mapped: true }],
    registeredThreadIds: ["thread-a"],
    unregisteredThreadIds: [],
    registeredNotVisibleThreadIds: [],
    projectMappingMissing: [],
    projectMappingExtra: [],
    interruptReceipts: [{ kind: "turn_interrupt", operation: "turn/interrupt", threadId: "thread-a", turnId: "turn-a", idempotencyKey: "drain-a", receiptId: "interrupt-a", status: "confirmed", confirmed: true, accepted: true, fault: null }],
    stopConfirmation: { confirmed: true, source: "interrupt_receipts", receiptIds: ["interrupt-a"], pendingThreadIds: [] },
    handoffReconciliation,
    handoffSourceReconciliationProof
  };
}

test("executor policy fail-closes Codex/Luna at depleted quota and requires explicit Bridge DSH", () => {
  assert.equal(canRouteExecutor({ executor: "codex", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted: true }), false);
  assert.equal(canRouteExecutor({ executor: "luna", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted: true }), false);
  assert.deepEqual(validateExecutorRequest({ executor: "dsh", continuation: "dsh_fresh", source: "engineering-bridge", quotaDepleted: true }), {
    allowed: true,
    executor: "dsh",
    continuation: "dsh_fresh",
    explicit: true
  });
  assert.throws(() => validateExecutorRequest({ executor: "dsh", continuation: "claude_resume", source: "engineering-bridge", quotaDepleted: true }), DomainError);
});

test("supervision accepts only structured controls, guards state, and makes duplicate controls idempotent", () => {
  const controller = new WorkerSupervisionController([attempt()]);
  const rejectedText = controller.control({
    taskId: "task-a",
    attemptId: "attempt-a",
    action: "continue",
    expectedRevision: 0,
    idempotencyKey: "control-text",
    instruction: "run arbitrary web text"
  });
  assert.equal(rejectedText.accepted, false);
  assert.equal(rejectedText.error?.code, "ARBITRARY_TEXT_REJECTED");

  const accepted = controller.continue({
    taskId: "task-a",
    attemptId: "attempt-a",
    expectedRevision: 0,
    idempotencyKey: "control-1",
    instruction: { kind: "instruction_ref", ref: "handoff:task-a", source: "ledger" }
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, "running");
  assert.equal(accepted.revision, 1);
  const replay = controller.continue({
    taskId: "task-a",
    attemptId: "attempt-a",
    expectedRevision: 0,
    idempotencyKey: "control-1",
    instruction: { kind: "instruction_ref", ref: "handoff:task-a", source: "ledger" }
  });
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 1);
  assert.equal(controller.getAttempt("attempt-a")?.revision, 1);

  const stale = controller.control({
    taskId: "task-a",
    attemptId: "attempt-a",
    action: "steer",
    expectedRevision: 0,
    idempotencyKey: "control-stale",
    instruction: { kind: "instruction_ref", ref: "steer:task-a", source: "ledger" }
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.error?.code, "REVISION_CONFLICT");
});

test("supervision rejects runtime action values outside the allowlist and terminal attempts", () => {
  const controller = new WorkerSupervisionController([attempt()]);
  const bogus = controller.control({
    taskId: "task-a",
    attemptId: "attempt-a",
    action: "bogus" as never,
    expectedRevision: 0,
    idempotencyKey: "control-bogus"
  });
  assert.equal(bogus.accepted, false);
  assert.equal(bogus.error?.code, "ACTION_NOT_ALLOWED");

  const terminalController = new WorkerSupervisionController([attempt({ terminal: true })]);
  const terminal = terminalController.continue({
    taskId: "task-a",
    attemptId: "attempt-a",
    expectedRevision: 0,
    idempotencyKey: "control-terminal",
    instruction: { kind: "instruction_ref", ref: "handoff:task-a", source: "ledger" }
  });
  assert.equal(terminal.accepted, false);
  assert.equal(terminal.error?.code, "INVALID_WORKER_STATE");
});

test("DSH supervision control records fresh-turn semantics and does not offer steer", () => {
  const controller = new WorkerSupervisionController([attempt({ kind: "dsh", source: "claude_orchestrator", continuation: "dsh_fresh" })]);
  const continued = controller.continue({
    taskId: "task-a",
    attemptId: "attempt-a",
    expectedRevision: 0,
    idempotencyKey: "dsh-continue",
    instruction: { kind: "instruction_ref", ref: "checkpoint:task-a", source: "ledger" }
  });
  assert.equal(continued.accepted, true);
  assert.equal(continued.requiresFreshTurn, true);
  const steer = controller.steer({
    taskId: "task-a",
    attemptId: "attempt-a",
    expectedRevision: 1,
    idempotencyKey: "dsh-steer",
    instruction: { kind: "instruction_ref", ref: "steer:task-a", source: "ledger" }
  });
  assert.equal(steer.accepted, false);
  assert.equal(steer.error?.code, "ROUTING_REJECTED");
});

test("web worker start remains blocked unless Wave 2 has complete visibility, all interrupts, stop and handoff proof", () => {
  const incomplete = validateWave2DrainProof({ ok: true, state: "HANDOFF_READY", scopeKnown: true });
  assert.equal(incomplete.ok, false);
  const blocked = startWebWorker({ taskId: "task-a", attemptId: "attempt-a", workerKind: "dsh", drainProof: { ok: true } });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.state, "BLOCKED");

  const complete = validateWave2DrainProof(completeDrainProof());
  assert.equal(complete.ok, true);
  const started = startWebWorker({ taskId: "task-a", attemptId: "attempt-a", workerKind: "bridge-dsh", drainProof: completeDrainProof() });
  assert.equal(started.accepted, true);
  assert.equal(started.state, "HANDOFF_READY");
  assert.match(started.drainProofHash ?? "", /^sha256:/);
});

test("drain proof does not trust an isolated hash or incomplete visibility/receipt fields", () => {
  assert.equal(validateWave2DrainProof({ proofHash: sha256({ ok: true, state: "HANDOFF_READY" }) }).ok, false);
  const complete = completeDrainProof();
  const generated = validateWave2DrainProof(complete);
  assert.equal(generated.ok, true);
  complete.proofHash = generated.proof?.proofHash;
  assert.equal(validateWave2DrainProof(complete).ok, true);
  complete.proofHash = "sha256:caller-tampered";
  assert.equal(validateWave2DrainProof(complete).ok, false);
  const unknownVisibility = completeDrainProof();
  (unknownVisibility.threadSnapshot as Record<string, unknown>).visibilityKnown = false;
  assert.equal(validateWave2DrainProof(unknownVisibility).ok, false);
  const missingReceipt = completeDrainProof();
  (missingReceipt.interruptReceipts as unknown[]).length = 0;
  assert.equal(validateWave2DrainProof(missingReceipt).ok, false);
});

test("drain proof rejects all remaining-work/count/hash mismatches", () => {
  const cases: Array<[string, (proof: Record<string, unknown>) => void]> = [
    ["remaining count does not equal item count", (proof) => {
      const source = proof.handoffSourceReconciliationProof as Record<string, unknown>;
      source.counts = { total: 1, remaining: 0 };
    }],
    ["total count does not cover exactly the source set", (proof) => {
      const source = proof.handoffSourceReconciliationProof as Record<string, unknown>;
      source.counts = { total: 2, remaining: 1 };
    }],
    ["source and reconciliation counts differ", (proof) => {
      const reconciliation = proof.handoffReconciliation as Record<string, unknown>;
      reconciliation.sourceCount = { total: 2, remaining: 1 };
    }],
    ["source hash does not match the canonical work set", (proof) => {
      const source = proof.handoffSourceReconciliationProof as Record<string, unknown>;
      source.sourceHash = "sha256:tampered";
    }]
  ];
  for (const [name, mutate] of cases) {
    const proof = JSON.parse(JSON.stringify(completeDrainProof())) as Record<string, unknown>;
    mutate(proof);
    assert.equal(validateWave2DrainProof(proof).ok, false, name);
  }
});
