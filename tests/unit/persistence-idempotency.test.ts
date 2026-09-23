import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workItemsHash } from "../../src/domain/canonical.js";
import { createInitialLedger, transitionLedger } from "../../src/domain/state-machine.js";
import { IdempotencyRegistry } from "../../src/domain/idempotency.js";
import { LeaseManager, type LeaseClock } from "../../src/domain/leases.js";
import type { HandoffSourceSnapshot, RemainingWorkItem, Receipt, TaskLedger } from "../../src/domain/types.js";
import { atomicWriteJson, atomicWriteText, readJson, resolveWithinRoot } from "../../src/persistence/atomic-json.js";
import { EventLog } from "../../src/persistence/event-log.js";
import { HandoffStore, reconcileWorkSets, workSetHash } from "../../src/persistence/handoff-store.js";
import { IndexCache } from "../../src/persistence/index-cache.js";
import { REDACTION_VERSION, redactRecord, truncateText } from "../../src/persistence/redaction.js";

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

function ledger() {
  return createInitialLedger({
    taskId: "persist-task",
    projectId: "project",
    repositoryId: "repository",
    relayEpoch: "relay-persist",
    threadId: "thread-1",
    remainingWork: [item("a"), item("b")],
    sourceHashes: { source_plan: "sha256:source" }
  });
}

function sourceSnapshot(source: TaskLedger): HandoffSourceSnapshot {
  const remainingWork = source.remainingWork.filter((work) => work.status !== "DONE").map((work) => ({ ...work, dependencies: [...work.dependencies], acceptance: [...work.acceptance], evidence: [...work.evidence] }));
  const counts = { total: remainingWork.length, remaining: remainingWork.length };
  const sourceHash = workItemsHash(remainingWork);
  return {
    snapshotId: "snapshot-persist-1",
    scopeCutoffAt: source.scopeCutoffAt,
    visibility: "COMPLETE",
    sourceHashes: { ...source.sourceHashes },
    sourceHash,
    counts,
    remainingWork,
    reconciliationReceipt: {
      receiptId: "handoff-receipt-persist-1",
      snapshotId: "snapshot-persist-1",
      visibility: "COMPLETE",
      sourceHash,
      counts,
      checkedAt: "2026-09-01T00:00:00.000Z",
      accepted: true
    }
  };
}

test("atomic JSON replacement stays inside root and preserves readable state", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-atomic-"));
  try {
    atomicWriteJson(root, "nested/state.json", { version: 1, value: "ok" });
    assert.deepEqual(readJson(root, "nested/state.json"), { version: 1, value: "ok" });
    atomicWriteJson(root, "nested/state.json", { version: 2 });
    assert.deepEqual(readJson(root, "nested/state.json"), { version: 2 });
    assert.throws(() => resolveWithinRoot(root, "../escape.json"), { code: "PATH_OUTSIDE_ROOT" });
    assert.throws(() => atomicWriteText(root, "..\\escape.json", "no"), { code: "PATH_OUTSIDE_ROOT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append-only event log assigns continuous sequence and replays after reload", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-events-"));
  try {
    const log = new EventLog(root);
    const first = log.append({ task_id: "task-1", operation: "state_transition", from_state: "CODEX_ACTIVE", to_state: "DRAINING", result: "completed" });
    const second = log.append({ task_id: "task-1", operation: "checkpoint", result: "completed" });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(log.read().length, 2);
    assert.equal(log.replay(0, (state) => state + 1), 2);
    assert.throws(() => log.append({ task_id: "task-1", operation: "bad", seq: 4 }), { code: "REVISION_CONFLICT" });
    const before = readFileSync(log.path(), "utf8");
    assert.match(before, /"seq":1/);
    assert.match(before, /"seq":2/);
    assert.equal(log.assertAppendOnly(), true);
    assert.throws(() => log.append({ task_id: "task-1", operation: "human_stop", terminal_reason: "HUMAN_STOP" }), { code: "HUMAN_STOP_REQUIRED" });
    const stop = log.append({
      task_id: "task-1",
      operation: "human_stop",
      terminal_reason: "HUMAN_STOP",
      actor: "user",
      intent: "STOP_RELAY",
      command_or_confirmation_id: "confirm-1",
      timestamp: "2026-09-01T00:00:00.000Z",
      relay_epoch: "relay-1",
      idempotency_key: "idem-stop"
    });
    assert.equal(stop.intent, "STOP_RELAY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff Markdown is complete source of truth and sidecar cannot repair omission", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-handoff-"));
  try {
    const store = new HandoffStore(root);
    let current = transitionLedger(ledger(), "DRAINING", { expectedRevision: 0 });
    const source = current.remainingWork.map((work) => ({ ...work }));
    assert.throws(() => store.writeHandoff(current, source.slice(0, 1) as unknown as HandoffSourceSnapshot), { code: "HANDOFF_SOURCE_REQUIRED" });
    const snapshot = sourceSnapshot(current);
    const written = store.writeHandoff(current, snapshot);
    assert.equal(written.reconciliation.ok, true);
    assert.equal(written.proof.handoffHash, written.hash);
    store.writeHandoffSidecar(current.taskId, written.document);
    const parsed = store.readHandoff(current.taskId);
    assert.deepEqual(parsed.remaining_work.map((work) => work.taskId), ["a", "b"]);
    assert.equal(store.reconcileHandoff(current, snapshot).ok, true);

    const hashMismatch = { ...written.document, source_hashes: { source_plan: "sha256:tampered" } };
    atomicWriteText(root, join(".ai-handoff", current.taskId, "handoff.md"), `# Continuity Handoff\n\n<!-- continuity handoff:v1 -->\n\n\`\`\`json\n${JSON.stringify(hashMismatch)}\n\`\`\`\n`);
    const hashReconciliation = store.reconcileHandoff(current, snapshot);
    assert.equal(hashReconciliation.ok, false);
    assert.equal(hashReconciliation.sourceHashesMatch, false);

    const incomplete = { ...written.document, counts: { total: 1, remaining: 1 }, remaining_work: [source[0]!] };
    atomicWriteText(root, join(".ai-handoff", current.taskId, "handoff.md"), `# Continuity Handoff\n\n<!-- continuity handoff:v1 -->\n\n\`\`\`json\n${JSON.stringify(incomplete)}\n\`\`\`\n`);
    const reconciliation = store.reconcileHandoff(current, snapshot);
    assert.equal(reconciliation.ok, false);
    assert.deepEqual(reconciliation.missing, ["b"]);

    unlinkSync(resolveWithinRoot(root, join(".ai-handoff", current.taskId, "handoff.md")));
    assert.throws(() => store.readHandoff(current.taskId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work-set reconciliation detects IDs, content, counts, and hash mismatch", () => {
  const source = [item("a"), item("b")];
  const missing = reconcileWorkSets(source, [source[0]!]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["b"]);
  const changed = { ...source[0]!, status: "RUNNING" as const };
  const mismatch = reconcileWorkSets(source, [changed, source[1]!]);
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.mismatched, ["a"]);
  assert.notEqual(workSetHash(source), workSetHash([changed, source[1]! ]));
});

test("index cache rebuilds from repository state and event log, never from stale cache", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-index-"));
  try {
    const store = new HandoffStore(root);
    const current = ledger();
    store.writeState(current);
    const log = store.eventLog(current.taskId);
    log.append({ task_id: current.taskId, operation: "checkpoint", result: "completed" });
    log.append({ task_id: current.taskId, operation: "checkpoint", result: "completed" });
    const cache = new IndexCache(root);
    cache.upsert({ task_id: "stale", project_id: "old", repository_id: "old", state: "CODEX_ACTIVE", revision: 99, web_chat_id: null, codex_thread_id: null, last_event: 99 });
    const rebuilt = cache.rebuild();
    assert.deepEqual(rebuilt.entries.map((entry) => entry.task_id), [current.taskId]);
    assert.equal(rebuilt.entries[0]?.last_event, 2);
    assert.equal(cache.load().entries[0]?.revision, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same idempotency payload returns original receipt; different payload is rejected", () => {
  const registry = new IdempotencyRegistry();
  const first = registry.begin("idem-1", { action: "checkpoint", value: 1 });
  assert.equal(first.kind, "new");
  const receipt: Receipt = {
    schemaVersion: "continuity.receipt.v1",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    operation: "checkpoint",
    ok: true,
    revision: 1,
    state: "CODEX_ACTIVE",
    data: { accepted: true },
    evidenceRefs: [],
    createdAt: "2026-09-01T00:00:00.000Z"
  };
  registry.complete("idem-1", { action: "checkpoint", value: 1 }, receipt);
  const replay = registry.begin("idem-1", { value: 1, action: "checkpoint" });
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.receipt, receipt);
  assert.throws(() => registry.begin("idem-1", { action: "checkpoint", value: 2 }), { code: "IDEMPOTENCY_KEY_REUSED" });
  const inFlight = registry.begin("idem-2", { action: "unknown" });
  assert.equal(inFlight.kind, "new");
  assert.equal(registry.begin("idem-2", { action: "unknown" }).kind, "in_flight");
});

test("lease and workspace write lock expire and can be recovered", () => {
  let millis = Date.parse("2026-09-01T00:00:00.000Z");
  const clock: LeaseClock = { now: () => new Date(millis) };
  const manager = new LeaseManager();
  const taskLease = manager.acquireTask("task", "owner-a", 1000, clock);
  assert.equal(manager.isValid(taskLease, "owner-a", taskLease.token, clock), true);
  assert.throws(() => manager.acquireTask("task", "owner-b", 1000, clock), { code: "LEASE_HELD" });
  const renewed = manager.renewTask("task", taskLease.token, 2000, clock);
  assert.equal(renewed.expiresAt, new Date(millis + 2000).toISOString());
  const workspace = manager.acquireWorkspace("workspace", "owner-a", 1000, clock);
  assert.equal(manager.isValid(workspace, "owner-a", workspace.token, clock), true);
  millis += 3000;
  assert.equal(manager.isValid(renewed, "owner-a", renewed.token, clock), false);
  const recovered = manager.acquireTask("task", "owner-b", 1000, clock);
  assert.equal(recovered.owner, "owner-b");
  assert.throws(() => manager.releaseWorkspace("workspace", workspace.token, clock), { code: "LEASE_EXPIRED" });
});

test("redaction strips credentials/transcript and truncates large evidence", () => {
  const redacted = redactRecord({ api_key: "super-secret", cookie: "session=abc", transcript: "private text", nested: { password: "pw" }, safe: "value" });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /super-secret|session=abc|private text|\"pw\"/);
  assert.equal((redacted as { safe: string }).safe, "value");
  // v2: credentials embedded in query strings (API errors, OAuth redirects) are redacted too.
  const urls = redactRecord({
    oauth: "https://accounts.example.com/callback?code=4%2F0AXXTOKEN&state=ok",
    apiError: "request failed: https://api.example.com/v1/x?key=AIzaSyABCDEF123456&prettyPrint=false"
  });
  const urlSerialized = JSON.stringify(urls);
  assert.doesNotMatch(urlSerialized, /4%2F0AXXTOKEN|AIzaSyABCDEF123456/);
  assert.ok(urlSerialized.includes("state=ok") && urlSerialized.includes("prettyPrint=false"), "non-credential query parts survive");
  // Real OpenAI/GitHub tokens (long, boundary-prefixed) are still redacted.
  // The values are assembled at runtime so that this file contains no literal a
  // provider secret scanner (or GitHub push protection) would flag as a real key.
  const openaiLike = "sk-proj" + "AbCdEf1234567890AbCdEf1234567890";
  const githubLike = "ghp_" + "AbCdEf1234567890AbCdEf1234567890";
  const tokens = redactRecord({ openai: openaiLike, github: githubLike });
  assert.doesNotMatch(JSON.stringify(tokens), /sk-projAbCdEf|ghp_AbCdEf/);
  // ...while ordinary identifiers that merely contain "sk-" are not mangled
  // (regression guard: this exact bug corrupted state.json task ids).
  const ids = redactRecord({ taskId: "task-restart-1", note: "task-sk-1 and desk-chair stay intact" });
  assert.equal((ids as { taskId: string }).taskId, "task-restart-1");
  assert.doesNotMatch(JSON.stringify(ids), /\[REDACTED\]/);
  assert.equal(REDACTION_VERSION, "continuity.redaction.v2");
  assert.match(truncateText("x".repeat(500), 100), /TRUNCATED/);
});
