import { createInitialLedger, transitionLedger } from "../../../src/domain/state-machine.js";
import { workItemsHash } from "../../../src/domain/canonical.js";
import type { HandoffReconciliationProof, RemainingWorkItem, TaskLedger } from "../../../src/domain/types.js";

export function item(taskId: string, status: RemainingWorkItem["status"] = "PENDING"): RemainingWorkItem {
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

export function ledgerWithTasks(ids = ["task-a", "task-b"]): TaskLedger {
  return createInitialLedger({
    taskId: "relay-task",
    projectId: "project",
    repositoryId: "repository",
    relayEpoch: "relay-1",
    threadId: "thread-original",
    remainingWork: ids.map((id) => item(id))
  });
}

export function handoffProof(source: TaskLedger): HandoffReconciliationProof {
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

export function webLedger(source = ledgerWithTasks()): TaskLedger {
  let ledger = transitionLedger(source, "DRAINING", { expectedRevision: 0 });
  ledger = transitionLedger(ledger, "HANDOFF_READY", { expectedRevision: 1, handoffProof: handoffProof(ledger), handoffReconciled: true, drainComplete: true, drainScopeKnown: true });
  return transitionLedger(ledger, "WEB_UNATTENDED_EXECUTING", { expectedRevision: 2, webAck: true });
}
