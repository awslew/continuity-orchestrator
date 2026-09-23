import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { Allowlist } from "../../src/security/allowlist.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { HandoffStore, workSetHash } from "../../src/persistence/handoff-store.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import {
  acceptHandoff,
  buildHandoffManifest,
  prepareHandoff,
  readHandoffChunk
} from "../../src/workflow/handoff.js";
import type { HandoffSourceSnapshot, RemainingWorkItem } from "../../src/domain/types.js";

interface Fixture {
  root: string;
  store: HandoffStore;
  allowlist: Allowlist;
  evidence: EvidenceWriter;
  coordinator: TaskCoordinator;
  work: RemainingWorkItem[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "continuity-coordinator-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const evidence = new EvidenceWriter(root, 16_384);
  const coordinator = new TaskCoordinator(store, allowlist, evidence);
  const work: RemainingWorkItem[] = [
    {
      taskId: "item-1",
      parentId: "task-1",
      status: "PENDING",
      dependencies: [],
      acceptance: ["acceptance criterion one"],
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
      acceptance: ["acceptance criterion two"],
      acceptancePassed: false,
      evidence: [],
      lastCheckpoint: null,
      sourceOfTruth: "source-plan"
    }
  ];
  return { root, store, allowlist, evidence, coordinator, work };
}

function registerDefaultTask(parts: Fixture): string {
  const taskId = "task-1";
  parts.coordinator.registerTask({
    ledger: {
      taskId,
      projectId: "project-1",
      repositoryId: "repo-1",
      threadId: "thread-123",
      remainingWork: parts.work,
      sourceHashes: { remaining_work: workSetHash(parts.work) }
    },
    workspaceId: "default",
    actor: "codex"
  });
  return taskId;
}

test("task registration persists ledger, event and evidence under .ai-handoff/<taskId>/", () => {
  const parts = fixture();
  const taskId = registerDefaultTask(parts);
  const ledger = parts.coordinator.get(taskId);
  assert.equal(ledger.lifecycleState, "CODEX_ACTIVE");
  assert.equal(ledger.revision, 1, "registration writes state and event evidence");
  assert.ok(existsSync(join(parts.root, ".ai-handoff", taskId, "state.json")));
  assert.ok(existsSync(join(parts.root, ".ai-handoff", taskId, "events.jsonl")));
  assert.ok(existsSync(join(parts.root, ".ai-handoff", taskId, "evidence")));
  assert.throws(() => parts.coordinator.registerTask({
    ledger: { taskId, projectId: "project-1", repositoryId: "repo-1", remainingWork: [] },
    workspaceId: "default"
  }), /already registered/);
  assert.throws(() => parts.coordinator.get("task-unknown"), /not registered/);

  const summaries = parts.coordinator.listTasks({ projectId: "project-1" });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.taskId, taskId);
});

test("checkpoint and transitions are revision controlled", () => {
  const parts = fixture();
  const taskId = registerDefaultTask(parts);
  const ledger = parts.coordinator.get(taskId);
  assert.throws(
    () => parts.coordinator.checkpoint(taskId, "cp-1", ledger.revision + 5),
    /REVISION_CONFLICT|Expected revision/
  );
  const saved = parts.coordinator.checkpoint(taskId, "cp-1", ledger.revision);
  assert.equal(saved.checkpointRef, "cp-1");
  assert.equal(saved.revision, ledger.revision + 1);
  assert.throws(
    () => parts.coordinator.transition(taskId, "HANDOFF_READY", { expectedRevision: saved.revision, handoffProof: undefined as never }),
    /CODEX_ACTIVE cannot transition to HANDOFF_READY/
  );
});

test("prepareHandoff drives the ledger to HANDOFF_READY and delivers a verifiable manifest", () => {
  const parts = fixture();
  const taskId = registerDefaultTask(parts);
  const ledger = parts.coordinator.get(taskId);
  const snapshot = {
    snapshotId: `snapshot_${taskId}_${ledger.revision}`,
    scopeCutoffAt: ledger.scopeCutoffAt,
    visibility: "COMPLETE" as const,
    sourceHashes: { remaining_work: workSetHash(parts.work) },
    sourceHash: workSetHash(parts.work),
    counts: { total: 2, remaining: 2 },
    remainingWork: parts.work,
    reconciliationReceipt: {
      receiptId: `reconcile_snapshot_${taskId}`,
      snapshotId: `snapshot_${taskId}_${ledger.revision}`,
      visibility: "COMPLETE" as const,
      sourceHash: workSetHash(parts.work),
      counts: { total: 2, remaining: 2 },
      checkedAt: "2026-09-03T00:00:00.000Z",
      accepted: true as const
    }
  };
  const result = prepareHandoff(parts.coordinator, parts.store, taskId, snapshot, ledger.revision, "codex");
  assert.equal(result.ledger.lifecycleState, "HANDOFF_READY");
  assert.ok(existsSync(join(parts.root, ".ai-handoff", taskId, "handoff.md")));
  assert.equal(result.ledger.handoffHash, result.proof.handoffHash);

  const document = parts.store.readHandoff(taskId);
  // A small chunk size forces multiple chunks so partial coverage is testable.
  const { manifest, text } = buildHandoffManifest(document, 64);
  assert.equal(manifest.chunk_count, manifest.chunks.length);
  assert.ok(manifest.chunk_count >= 2, "the fixture document spans several chunks");
  assert.equal(manifest.task_id, taskId);

  // Every chunk verifies; a tampered hash is a reconciliation failure.
  for (const chunk of manifest.chunks) {
    const verified = readHandoffChunk(manifest, text, chunk.index, chunk.sha256);
    assert.equal(verified.verified, true);
  }
  assert.throws(() => readHandoffChunk(manifest, text, 0, "sha256:deadbeef"), /hash mismatch/);
  assert.throws(() => readHandoffChunk(manifest, text, manifest.chunk_count + 3, manifest.chunks[0]!.sha256), /outside the manifest/);

  // Acceptance re-verifies the manifest and every chunk locally.
  const receipt = acceptHandoff(
    parts.coordinator,
    parts.evidence,
    manifest,
    text,
    manifest.manifest_hash,
    manifest.chunks.map((chunk) => ({ index: chunk.index, sha256: chunk.sha256 })),
    "client-ref-1"
  );
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.manifest_hash, manifest.manifest_hash);
  assert.ok(existsSync(join(parts.root, ".ai-handoff", taskId, "evidence", `handoff-accept-${result.ledger.revision + 1}.json`)));

  assert.throws(
    () => acceptHandoff(parts.coordinator, parts.evidence, manifest, text, "sha256:tampered", manifest.chunks.map((chunk) => ({ index: chunk.index, sha256: chunk.sha256 })), "client-ref-2"),
    /manifest hash does not match/
  );
  assert.throws(
    () => acceptHandoff(parts.coordinator, parts.evidence, manifest, text, manifest.manifest_hash, [{ index: 0, sha256: manifest.chunks[0]!.sha256 }], "client-ref-3"),
    /chunk receipts cover/
  );
});

test("handoff preparation refuses unknown scope and incomplete snapshots", () => {
  const parts = fixture();
  const taskId = registerDefaultTask(parts);
  const ledger = parts.coordinator.get(taskId);
  const badSnapshot = {
    snapshotId: "snapshot-bad",
    scopeCutoffAt: ledger.scopeCutoffAt,
    visibility: "UNKNOWN" as const,
    sourceHashes: { remaining_work: workSetHash(parts.work) },
    sourceHash: workSetHash(parts.work),
    counts: { total: 2, remaining: 2 },
    remainingWork: parts.work,
    reconciliationReceipt: {
      receiptId: "reconcile-bad",
      snapshotId: "snapshot-bad",
      visibility: "COMPLETE" as const,
      sourceHash: workSetHash(parts.work),
      counts: { total: 2, remaining: 2 },
      checkedAt: "2026-09-03T00:00:00.000Z",
      accepted: true as const
    }
  };
  assert.throws(
    () => prepareHandoff(parts.coordinator, parts.store, taskId, badSnapshot as unknown as HandoffSourceSnapshot, ledger.revision, "codex"),
    /unknown|reconciliation|Handoff/i
  );
  // The rejected preparation must not have moved the ledger out of CODEX_ACTIVE.
  assert.equal(parts.coordinator.get(taskId).lifecycleState, "CODEX_ACTIVE");
});

test("evidence writer is append-only, redacted and size capped", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-evidence-"));
  const writer = new EvidenceWriter(root, 512);
  const ref = writer.write("task-e", "evt-1", { password: "hunter2", note: "hello" });
  assert.match(ref.sha256, /^sha256:[0-9a-f]{64}$/);
  const file = readFileSync(ref.ref, "utf8");
  assert.ok(file.includes("[REDACTED]"), "sensitive keys are redacted on disk");
  assert.ok(!file.includes("hunter2"));

  // Same id and content is an idempotent replay.
  const replay = writer.write("task-e", "evt-1", { password: "hunter2", note: "hello" });
  assert.equal(replay.sha256, ref.sha256);
  // Same id with different content refuses to rewrite history.
  assert.throws(() => writer.write("task-e", "evt-1", { password: "hunter2", note: "changed" }), /already exists with different content/);

  // Oversized payloads are truncated rather than stored raw.
  const big = writer.write("task-e", "evt-big", { blob: "x".repeat(4096) });
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(readFileSync(big.ref, "utf8"), "utf8") <= 2048);

  // A fresh writer (simulated restart) recovers the stored truncation fact and
  // replay-by-hash works across instances instead of rewriting history.
  const restarted = new EvidenceWriter(root, 512);
  const plainReplay = restarted.write("task-e", "evt-1", { password: "hunter2", note: "hello" });
  assert.equal(plainReplay.sha256, ref.sha256);
  assert.equal(plainReplay.truncated, false);
  assert.equal(plainReplay.createdAt, ref.createdAt, "createdAt is recovered from the envelope");
  const bigReplay = restarted.write("task-e", "evt-big", { blob: "x".repeat(4096) });
  assert.equal(bigReplay.sha256, big.sha256);
  assert.equal(bigReplay.truncated, true, "truncation flag is recovered from the envelope");
});
