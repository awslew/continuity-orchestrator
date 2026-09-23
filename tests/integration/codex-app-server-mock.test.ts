import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workItemsHash } from "../../src/domain/canonical.js";
import { createInitialLedger, transitionLedger } from "../../src/domain/state-machine.js";
import type { HandoffSourceSnapshot, RemainingWorkItem, TaskLedger } from "../../src/domain/types.js";
import { HandoffStore } from "../../src/persistence/handoff-store.js";
import { CodexAppServerAdapter, MockAppServerTransport } from "../../src/adapters/codex-app-server.js";
import { drainAllVisibleActiveThreads, drainFencePassed } from "../../src/workflow/drain.js";

function work(taskId: string): RemainingWorkItem {
  return {
    taskId,
    parentId: null,
    status: "PENDING",
    dependencies: [],
    acceptance: ["receipt"],
    acceptancePassed: false,
    evidence: [`evidence:${taskId}`],
    lastCheckpoint: null,
    sourceOfTruth: "test-plan"
  };
}

function drainingLedger(): TaskLedger {
  return transitionLedger(createInitialLedger({
    taskId: "drain-task",
    projectId: "project-a",
    repositoryId: "repo",
    relayEpoch: "relay-test",
    threadId: "thread-a",
    remainingWork: [work("task-a"), work("task-b")],
    sourceHashes: { source_plan: "sha256:plan", task_ledger: "sha256:ledger" },
    scopeCutoffAt: "2026-09-01T00:00:00.000Z"
  }), "DRAINING", { expectedRevision: 0 });
}

function sourceSnapshot(ledger: TaskLedger, items = ledger.remainingWork): HandoffSourceSnapshot {
  const remainingWork = items.map((item) => ({ ...item, dependencies: [...item.dependencies], acceptance: [...item.acceptance], evidence: [...item.evidence] }));
  const counts = { total: remainingWork.length, remaining: remainingWork.length };
  const sourceHash = workItemsHash(remainingWork);
  return {
    snapshotId: "snapshot-drain-1",
    scopeCutoffAt: ledger.scopeCutoffAt,
    visibility: "COMPLETE",
    sourceHashes: { ...ledger.sourceHashes },
    sourceHash,
    counts,
    remainingWork,
    reconciliationReceipt: {
      receiptId: "handoff-source-receipt-1",
      snapshotId: "snapshot-drain-1",
      visibility: "COMPLETE",
      sourceHash,
      counts,
      checkedAt: "2026-09-01T00:01:00.000Z",
      accepted: true
    }
  };
}

function adapterFor(listResponse: unknown, interruptResponse: unknown = undefined): { adapter: CodexAppServerAdapter; mock: MockAppServerTransport } {
  const mock = new MockAppServerTransport({
    "thread/list": listResponse,
    "turn/interrupt": interruptResponse ?? ((() => ({ ok: true, receiptId: "interrupt-default", status: "confirmed" })) as () => unknown)
  });
  return { adapter: new CodexAppServerAdapter(mock, { timeoutMs: 100 }), mock };
}

const allThreads = { result: { visibility: "complete", threads: [
  { threadId: "thread-a", turnId: "turn-a", projectId: "project-a", status: "active" },
  { threadId: "thread-b", turnId: "turn-b", projectId: "project-b", status: "active" }
] } };

test("valid drain snapshots every visible thread, confirms every interrupt, and reconciles handoff.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-codex-mock-"));
  try {
    const ledger = drainingLedger();
    const { adapter, mock } = adapterFor(allThreads, () => ({ ok: true, receiptId: "interrupt-" + (mock.calls.length + 1), status: "confirmed" }));
    const result = await drainAllVisibleActiveThreads({
      ledger,
      adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, "HANDOFF_READY");
    assert.equal(result.scopeKnown, true);
    assert.deepEqual(result.visibleThreads.map((thread) => thread.threadId), ["thread-a", "thread-b"]);
    assert.equal(result.interruptReceipts.length, 2);
    assert.equal(result.stopConfirmation.confirmed, true);
    assert.equal(result.handoffReconciliation?.ok, true);
    assert.ok(result.handoffSourceReconciliationProof?.handoffHash);
    assert.equal(drainFencePassed(result), true);
    assert.equal(mock.calls.filter((call) => call.method === "turn/interrupt").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed subset and registration differences are fail-closed and do not interrupt a partial set", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-codex-mock-subset-"));
  try {
    const ledger = drainingLedger();
    const { adapter, mock } = adapterFor(allThreads);
    const subset = await drainAllVisibleActiveThreads({
      ledger,
      adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      managedThreadIds: ["thread-a"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(subset.ok, false);
    assert.equal(subset.managedSubsetRejected, true);
    assert.equal(subset.state, "DRAINING");
    assert.equal(mock.calls.filter((call) => call.method === "turn/interrupt").length, 0);

    const incomplete = await drainAllVisibleActiveThreads({
      ledger,
      adapter,
      registeredThreadIds: ["thread-a"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(incomplete.ok, false);
    assert.deepEqual(incomplete.unregisteredThreadIds, ["thread-b"]);
    assert.equal(incomplete.state, "DRAINING");
    assert.equal(mock.calls.filter((call) => call.method === "turn/interrupt").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown visible scope blocks before side effects; project mapping differences also block", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-codex-mock-scope-"));
  try {
    const ledger = drainingLedger();
    const unknown = adapterFor({ result: { threads: [{ threadId: "thread-a", turnId: "turn-a", projectId: "project-a", status: "active" }] } });
    const unknownResult = await drainAllVisibleActiveThreads({
      ledger,
      adapter: unknown.adapter,
      registeredThreadIds: ["thread-a"],
      projectMapping: { "thread-a": "project-a" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(unknownResult.scopeKnown, false);
    assert.equal(unknownResult.state, "DRAINING");
    assert.equal(unknown.mock.calls.filter((call) => call.method === "turn/interrupt").length, 0);

    const mapped = adapterFor(allThreads);
    const mappingResult = await drainAllVisibleActiveThreads({
      ledger,
      adapter: mapped.adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      projectMapping: { "thread-a": "project-a", "extra": "project-extra" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(mappingResult.ok, false);
    assert.deepEqual(mappingResult.projectMappingMissing, ["thread-b"]);
    assert.deepEqual(mappingResult.projectMappingExtra, ["extra"]);
    assert.equal(mapped.mock.calls.filter((call) => call.method === "turn/interrupt").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout/unknown-in-flight receipts keep the operation in DRAINING", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-codex-mock-interrupt-"));
  try {
    const ledger = drainingLedger();
    const timeout = adapterFor(allThreads, () => new Promise<unknown>(() => undefined));
    const timeoutResult = await drainAllVisibleActiveThreads({
      ledger,
      adapter: timeout.adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.state, "DRAINING");
    assert.equal(timeoutResult.stopConfirmation.confirmed, false);
    assert.equal(timeoutResult.interruptReceipts.every((receipt) => receipt.status === "timeout"), true);

    const unknown = adapterFor(allThreads, { error: { code: "IN_FLIGHT", message: "unknown" } });
    const unknownResult = await drainAllVisibleActiveThreads({
      ledger,
      adapter: unknown.adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger)
    });
    assert.equal(unknownResult.ok, false);
    assert.equal(unknownResult.interruptReceipts.every((receipt) => receipt.status === "unknown_in_flight"), true);
    assert.equal(unknownResult.faults.some((fault) => fault.code === "UNKNOWN_IN_FLIGHT"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff omission/hash mismatch cannot cross the drain fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-codex-mock-handoff-"));
  try {
    const ledger = drainingLedger();
    const { adapter } = adapterFor(allThreads);
    const omission = await drainAllVisibleActiveThreads({
      ledger,
      adapter,
      registeredThreadIds: ["thread-a", "thread-b"],
      projectMapping: { "thread-a": "project-a", "thread-b": "project-b" },
      handoffStore: new HandoffStore(root),
      sourceSnapshot: sourceSnapshot(ledger, [ledger.remainingWork[0]!])
    });
    assert.equal(omission.ok, false);
    assert.equal(omission.state, "DRAINING");
    assert.equal(omission.handoff, null);
    assert.equal(omission.faults.some((fault) => fault.code === "HANDOFF_RECONCILIATION_FAILED"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
