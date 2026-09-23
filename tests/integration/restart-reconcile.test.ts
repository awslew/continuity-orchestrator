/**
 * Wave 6 restart/reconcile drill (plan §10.3.2).
 *
 * Simulates a full process restart over a repository-local state root and
 * proves, at mock level:
 *   1. state + event replay reproduce the pre-restart ledger fingerprint;
 *   2. the index cache is rebuilt from task directories, never trusted;
 *   3. receipts have exactly three post-restart branches — completed
 *      (replay the original receipt), never-started (fresh execution is
 *      allowed) and unknown/in-flight (reconcile, never blind re-execution);
 *   4. lease expiry/recoval reconnection and renewal happen without any
 *      terminal lifecycle transition;
 *   5. a corrupted append-only event log is detected, never silently healed.
 *
 * This suite exercises the local persistence/domain machinery only.  It is
 * not real-web evidence (plan §10.5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { HandoffStore } from "../../src/persistence/handoff-store.js";
import { IndexCache } from "../../src/persistence/index-cache.js";
import { EventLog } from "../../src/persistence/event-log.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import { IdempotencyRegistry } from "../../src/domain/idempotency.js";
import { LeaseManager, type LeaseClock } from "../../src/domain/leases.js";
import { canonicalize, sha256 } from "../../src/domain/canonical.js";
import { workSetHash } from "../../src/persistence/handoff-store.js";
import type { RemainingWorkItem, TaskLedger } from "../../src/domain/types.js";

interface DrillState {
  lastSeq: number;
  lastToState: string | null;
  operations: string[];
}

function drillReducer(state: DrillState, event: { seq: number; operation: string; to_state: string | null }): DrillState {
  return {
    lastSeq: event.seq,
    lastToState: event.to_state ?? state.lastToState,
    operations: [...state.operations, event.operation]
  };
}

function workItems(): RemainingWorkItem[] {
  return [
    {
      taskId: "item-1",
      parentId: "task-restart-1",
      status: "PENDING",
      dependencies: [],
      acceptance: ["restart drill criterion"],
      acceptancePassed: false,
      evidence: [],
      lastCheckpoint: null,
      sourceOfTruth: "source-plan"
    }
  ];
}

interface DrillRig {
  root: string;
  store: HandoffStore;
  coordinator: TaskCoordinator;
  ledger: TaskLedger;
}

function freshRig(): DrillRig {
  const root = mkdtempSync(join(tmpdir(), "continuity-restart-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const coordinator = new TaskCoordinator(store, allowlist, new EvidenceWriter(root, 16_384));
  const ledger = coordinator.registerTask({
    ledger: {
      taskId: "task-restart-1",
      projectId: "project-restart",
      repositoryId: "repo-restart",
      threadId: "thread-original",
      remainingWork: workItems(),
      sourceHashes: { remaining_work: workSetHash(workItems()) }
    },
    workspaceId: "default",
    actor: "codex"
  });
  coordinator.checkpoint("task-restart-1", "checkpoint-before-restart", ledger.revision, "codex");
  const current = coordinator.get("task-restart-1");
  return { root, store, coordinator, ledger: current };
}

function fingerprint(ledger: TaskLedger): string {
  return sha256(canonicalize(JSON.parse(JSON.stringify(ledger))) as unknown);
}

test("state and event replay reproduce the pre-restart ledger fingerprint", () => {
  const before = freshRig();
  // Lifecycle mutations (checkpoint) record evidence, not event-log entries;
  // append two observed events so the replay exercises a multi-entry log.
  const log = before.store.eventLog("task-restart-1");
  log.append({ task_id: "task-restart-1", operation: "drain_observed", from_state: "CODEX_ACTIVE", to_state: "DRAINING", result: "observed" });
  log.append({ task_id: "task-restart-1", operation: "handoff_prepared", from_state: "DRAINING", to_state: "HANDOFF_READY", result: "completed" });
  const eventsBefore = log.read();
  assert.equal(eventsBefore.length, 3, "register + two observed events, no sequence gaps");
  const preRestartFingerprint = fingerprint(before.ledger);

  // --- process restart: everything below uses fresh instances on the same root ---
  const storeAfter = new HandoffStore(before.root);
  const ledgerAfter = storeAfter.readState("task-restart-1");
  assert.equal(fingerprint(ledgerAfter), preRestartFingerprint, "state.json round-trips exactly");

  const eventLog = new EventLog(before.root, join(".ai-handoff", "task-restart-1", "events.jsonl"));
  const replayed = eventLog.replay<DrillState>({ lastSeq: 0, lastToState: null, operations: [] }, drillReducer as never);
  assert.equal(replayed.lastSeq, eventsBefore.length, "replay consumed the whole log with no sequence gaps");
  assert.equal(replayed.operations[0], "task_register");
  assert.equal(replayed.lastToState, "HANDOFF_READY");
});

test("index cache is rebuilt from task directories and never trusted", () => {
  const rig = freshRig();
  const index = new IndexCache(rig.root);
  index.upsert({
    task_id: "task-restart-1",
    project_id: "project-restart",
    repository_id: "repo-restart",
    state: "CODEX_ACTIVE",
    revision: 1,
    web_chat_id: null,
    codex_thread_id: "thread-original",
    last_event: 1
  });

  // The upserted cache is now stale (revision moved on).  A restart must not
  // trust it: rebuild from the task directories.
  const rebuilt = index.rebuild();
  const entry = rebuilt.entries.find((candidate) => candidate.task_id === "task-restart-1");
  assert.ok(entry, "rebuilt index contains the task");
  assert.equal(entry.state, rig.ledger.lifecycleState);
  assert.equal(entry.revision, rig.ledger.revision);
  assert.equal(entry.last_event, rig.store.eventLog("task-restart-1").read().length);

  // A corrupted cache file is discarded by a rebuild, not surfaced as truth.
  writeFileSync(join(rig.root, "index-cache.json"), "{ this is not json", "utf8");
  const recovered = index.rebuild();
  assert.equal(recovered.entries.some((candidate) => candidate.task_id === "task-restart-1"), true);
});

test("receipts have exactly three post-restart branches: replay, fresh, reconcile", () => {
  const rig = freshRig();
  const registry = new IdempotencyRegistry();
  const payload = { taskId: "task-restart-1", operation: "web_send", at: "2026-09-03T00:00:00.000Z" };

  const receipt = { ok: true, receiptId: "receipt-completed-1", taskId: "task-restart-1" };
  registry.begin("key-completed", payload);
  registry.complete("key-completed", payload, receipt as never);
  // key-unknown never touched the registry before the restart.

  // --- restart: rebuild the registry from its persisted snapshot ---
  const snapshot = registry.snapshot();
  const reloaded = new IdempotencyRegistry();
  reloaded.load(snapshot);

  // Branch 1 — completed: replay the original receipt, never re-execute.
  const completed = reloaded.begin("key-completed", payload);
  assert.equal(completed.kind, "replay");
  assert.equal((completed as unknown as { receipt: { receiptId: string } }).receipt.receiptId, "receipt-completed-1");

  // Branch 2 — never started: fresh execution is allowed.
  const fresh = reloaded.begin("key-unknown", payload);
  assert.equal(fresh.kind, "new");

  // Branch 3 — in-flight before the crash: outcome unknown; the record comes
  // back as in_flight and must be reconciled, never blindly re-executed.
  registry.begin("key-inflight", { ...payload, at: "2026-09-03T00:00:01.000Z" });
  const reloadedUnknown = new IdempotencyRegistry();
  reloadedUnknown.load(registry.snapshot());
  const unknown = reloadedUnknown.begin("key-inflight", { ...payload, at: "2026-09-03T00:00:01.000Z" });
  assert.equal(unknown.kind, "in_flight");
  assert.equal((unknown as unknown as { record: { status: string } }).record.status, "in_flight");
  assert.equal(reloadedUnknown.get("key-inflight")?.receipt, undefined, "an in-flight record carries no receipt to replay");
});

test("lease expiry, recovery and renewal never produce a terminal transition", () => {
  const rig = freshRig();
  const stateBefore = rig.coordinator.get("task-restart-1").lifecycleState;
  let millis = Date.parse("2026-09-03T00:00:00.000Z");
  const clock: LeaseClock = { now: () => new Date(millis) };
  const leases = new LeaseManager();

  const lease = leases.acquireTask("task-restart-1", "worker-a", 1_000, clock);
  assert.throws(() => leases.acquireTask("task-restart-1", "worker-b", 1_000, clock), { code: "LEASE_HELD" });

  // Heartbeat/renewal extends the lease for the holder.
  millis += 500;
  const renewed = leases.renewTask("task-restart-1", lease.token, 1_000, clock);
  assert.equal(renewed.token, lease.token);

  // Expiry: the old holder loses it (watchdog alert), a new holder recovers.
  millis += 2_000;
  assert.equal(leases.isValid(leases.getTask("task-restart-1"), "worker-a", lease.token, clock), false, "expired lease is invalid — alert, do not terminate");
  assert.throws(() => leases.releaseTask("task-restart-1", lease.token, clock), { code: "LEASE_EXPIRED" });
  const recovered = leases.acquireTask("task-restart-1", "worker-b", 1_000, clock);
  assert.equal(recovered.owner, "worker-b");

  // Wrong token releases nothing.
  assert.throws(() => leases.releaseTask("task-restart-1", "forged-token", clock), { code: "LEASE_NOT_HELD" });

  // None of the lease events moved the lifecycle state machine.
  assert.equal(rig.coordinator.get("task-restart-1").lifecycleState, stateBefore);
  assert.notEqual(stateBefore, "WEB_TERMINAL");
});

test("a corrupted event log is detected as malformed and never silently healed", () => {
  const rig = freshRig();
  const logPath = join(rig.root, ".ai-handoff", "task-restart-1", "events.jsonl");
  appendFileSync(logPath, "{not valid json}\n", "utf8");
  assert.throws(() => new EventLog(join(rig.root, ".ai-handoff", "task-restart-1")).read(), { code: "MALFORMED_HANDOFF" });
  // The event log offers no repair: events stay append-only.
  assert.equal(new EventLog(join(rig.root, ".ai-handoff", "task-restart-1")).assertAppendOnly(), true);
});

// ---------------------------------------------------------------------------
// Wave 5 additions (plan §9, owner-w5): receipt three-branch reconciliation
// over the new web/return modules, the absorbing web terminal, and the return
// gate.  Mock evidence only — never a real PASS.

import { enterWebTerminal, observeQuotaRecovery, transitionLedger } from "../../src/domain/state-machine.js";
import { assessReturnReadiness } from "../../src/workflow/return.js";
import { planForSnapshotEntries, planReconciliation } from "../../src/workflow/reconcile.js";
import { closeFallbackAfterFailure, selectCodexChatgptWebFallback } from "../../src/adapters/codex-chatgpt-web-fallback.js";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { ledgerWithTasks, webLedger } from "../unit/helpers/ledgers.js";
import { readFileSync } from "node:fs";

function loadWebReceiptFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "web-receipts", name), "utf8")) as Record<string, unknown>;
}

function quotaExhaustedReceipt(ledger: TaskLedger) {
  return {
    kind: "quota_exhausted" as const,
    receiptId: "quota-receipt-1",
    relayEpoch: ledger.relayEpoch,
    timestamp: "2026-09-01T00:00:00.000Z",
    remainingBps: 0,
    accepted: true as const
  };
}

test("wave5: receipt branches across a restart — completed replays, in-flight halts, missing retries", () => {
  const receipts = new IdempotencyRegistry();
  const payload = { taskId: "relay-task", operation: "web_send" };
  const storedReceipt = {
    schemaVersion: "continuity.receipt.v1" as const,
    requestId: "req-1",
    idempotencyKey: "key-completed",
    operation: "web_send",
    ok: true,
    revision: 1,
    state: "WEB_UNATTENDED_EXECUTING" as const,
    data: loadWebReceiptFixture("web-message-receipt.completed.json"),
    evidenceRefs: [],
    createdAt: "2026-09-01T00:00:00.000Z"
  };
  receipts.begin("key-completed", payload);
  receipts.complete("key-completed", payload, storedReceipt);
  receipts.begin("key-inflight", { ...payload, leg: "second" });

  const snapshot = receipts.snapshot();
  const afterRestart = new IdempotencyRegistry();
  afterRestart.load(snapshot);

  const snapshotEntries = Object.fromEntries(snapshot.map((record) => [record.key, record]));
  const plans = planForSnapshotEntries("web_message", snapshotEntries as Record<string, { status: "in_flight" | "completed" }>);
  const byKey = new Map(plans.map((p) => [p.key, p]));
  assert.equal(byKey.get("key-completed")?.branch, "completed");
  assert.equal(byKey.get("key-completed")?.plan.action, "reuse_receipt");
  assert.equal(byKey.get("key-completed")?.plan.blockSameKind, false);

  assert.equal(byKey.get("key-inflight")?.branch, "in_flight");
  assert.equal(byKey.get("key-inflight")?.plan.action, "halt_and_reconcile");
  assert.equal(byKey.get("key-inflight")?.plan.blockSameKind, true);
  assert.equal(byKey.get("key-inflight")?.plan.substate, "BLOCKED_WAITING");

  assert.equal(afterRestart.begin("key-missing", payload).kind, "new");
  assert.equal(planReconciliation("web_message", "missing").action, "retry_with_same_key");
  assert.equal(planReconciliation("web_read", "missing").action, "halt_and_reconcile");
  assert.equal(planReconciliation("web_read", "missing").blockSameKind, true);
});

test("wave5: web receipt fixtures stay schema-consistent with the adapter contracts", () => {
  const completed = loadWebReceiptFixture("web-message-receipt.completed.json");
  const blocked = loadWebReceiptFixture("web-message-receipt.blocked.json");
  const read = loadWebReceiptFixture("web-read-receipt.json");
  assert.equal(completed.schemaVersion, "continuity.web-message-receipt.v1");
  assert.equal(blocked.blockedWaiting, true, "unknown page state blocks");
  assert.equal(read.cursor, null, "the web side never produces an authoritative cursor");
});

test("wave5: a WEB_QUOTA_EXHAUSTED terminal is absorbing; quota recovery cannot reverse it", () => {
  let ledger = webLedger();
  ledger = enterWebTerminal(ledger, "WEB_QUOTA_EXHAUSTED", {
    expectedRevision: ledger.revision,
    quotaReceipt: quotaExhaustedReceipt(ledger)
  });
  assert.equal(ledger.lifecycleState, "WEB_TERMINAL");
  const recovered = observeQuotaRecovery(ledger, {
    status: "available",
    primaryRemainingBps: 9_000,
    secondaryRemainingBps: null,
    sampleUpdatedAt: "2026-09-01T02:00:00.000Z",
    codexAvailable: true,
    secondaryGuard: false
  }, { expectedRevision: ledger.revision });
  assert.equal(recovered.lifecycleState, "WEB_TERMINAL", "still terminal");
  assert.equal(recovered.web.terminalReason, "WEB_QUOTA_EXHAUSTED", "reason unchanged");
});

function readyQuota() {
  return { returnReady: true, primaryRemainingBps: 3_000, secondaryGuard: false, sampleFresh: true };
}

test("wave5: return gate opens only on closed terminal reason + complete ledger + fresh codex quota", () => {
  let ledger = webLedger();
  ledger = enterWebTerminal(ledger, "HUMAN_STOP", {
    expectedRevision: ledger.revision,
    stopReceipt: {
      kind: "human_stop",
      actor: "user",
      intent: "STOP_RELAY" as const,
      commandOrConfirmationId: "confirm-stop-1",
      timestamp: "2026-09-01T03:00:00.000Z",
      relayEpoch: ledger.relayEpoch,
      idempotencyKey: "stop-key-1",
      accepted: true as const
    }
  });
  // Incomplete ledger first: without a return checkpoint the gate stays shut.
  const incomplete = assessReturnReadiness(ledger, readyQuota());
  assert.equal(incomplete.ready, false);
  assert.ok(incomplete.blockers.some((b) => b.includes("checkpoint")));
  const terminal = { ...ledger, checkpointRef: "checkpoint-1" };
  const blockedByQuota = assessReturnReadiness(terminal, { returnReady: false, primaryRemainingBps: 1_000, secondaryGuard: false, sampleFresh: true });
  assert.equal(blockedByQuota.ready, false);
  assert.ok(blockedByQuota.blockers.some((b) => b.includes("20%")));
  assert.equal(assessReturnReadiness(terminal, readyQuota()).ready, true);
  const notTerminal = transitionLedger(ledgerWithTasks(), "DRAINING", { expectedRevision: 0 });
  assert.ok(assessReturnReadiness(notTerminal, readyQuota()).blockers.some((b) => b.includes("WEB_TERMINAL")));
});

test("wave5: fallback is explicit-only; failure closes flags and freezes without terminal", () => {
  assert.deepEqual(selectCodexChatgptWebFallback({ ...DEFAULT_FLAGS }), { selected: false, reason: "flag_off" });
  const enabled = { ...DEFAULT_FLAGS, CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK: true };
  assert.deepEqual(selectCodexChatgptWebFallback(enabled), { selected: true, surface: "codex-chatgpt-web", reason: "explicit_flag" });
  const plan = closeFallbackAfterFailure(enabled);
  assert.deepEqual(plan.closeFlags, ["CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK"]);
  assert.equal(plan.terminal, false);
  assert.equal(plan.reattach, false);
  assert.equal(plan.permissionChange, false);
  assert.equal(plan.manualExecution, false);
  assert.ok(plan.freezeStates.includes("BLOCKED_WAITING"));
  assert.throws(() => closeFallbackAfterFailure({ ...DEFAULT_FLAGS }), /explicit/);
  assert.equal(planReconciliation("worker", "in_flight").blockSameKind, true, "no blind worker re-creation");
});
