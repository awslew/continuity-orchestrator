import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../../src/domain/canonical.js";
import { InMemoryLocalDurableStore, LocalBackendFailure, LocalPatchBackend, LocalWorkerBackend, type LocalWorkerTransport } from "../../src/adapters/local-worker-backends.js";
import type { RealSessionRef } from "../../src/adapters/adapter-types.js";

const session: RealSessionRef = {
  kind: "real_session",
  backend: "claude",
  source: "claude_orchestrator",
  jobId: "claude-job-1",
  sessionId: "claude-session-1",
  threadId: "claude-thread-1"
};

const deliverable = {
  path: "evidence/out/report.md",
  hash: "sha256:report-hash",
  exists: true,
  resultStatus: "present" as const
};

function testStore(): InMemoryLocalDurableStore {
  return new InMemoryLocalDurableStore();
}

function input(workerKind: "claude" | "dsh" | "bridge-dsh", idempotencyKey = `${workerKind}-idem-001`) {
  return {
    taskId: "task-1",
    workerKind,
    instructionRef: { kind: "handoff_item", ref: "handoff:item-1" },
    idempotencyKey
  } as const;
}

test("Claude reply preserves reply/resume, job/session/attempt and durable output refs", async () => {
  let received: unknown = null;
  const transport: LocalWorkerTransport = {
    claudeReply: (request) => {
      received = request;
      return { status: "completed", jobId: session.jobId, sessionId: session.sessionId, threadId: session.threadId, deliverable };
    }
  };
  const backend = new LocalWorkerBackend({ transport, durableStore: testStore(), bindings: { "task-1": { claudeSession: session } } });
  const result = await backend.run(input("claude"));

  assert.equal(result.status, "running", "legacy server seam represents an immediate completion as a started/running attempt");
  assert.equal(result.realJobId, session.jobId);
  assert.equal(result.receipt.operation, "claude_code_reply");
  assert.equal(result.receipt.continuation, "claude_resume");
  assert.deepEqual(result.receipt.realSessionRef, session);
  assert.equal(result.receipt.attemptId, result.attemptId);
  assert.deepEqual(result.receipt.deliverable, deliverable);
  assert.deepEqual(received, {
    jobId: session.jobId,
    sessionId: session.sessionId,
    threadId: session.threadId,
    instruction_ref: "handoff:item-1",
    idempotency_key: "claude-idem-001",
    backend: "claude",
    continuation: "claude_resume",
    executor: "claude"
  });
});

test("DSH is an explicit fresh start and never accepts a resume alias", async () => {
  let received: Record<string, unknown> | null = null;
  const backend = new LocalWorkerBackend({
    transport: {
      dshFreshStart: (request) => {
        received = request as unknown as Record<string, unknown>;
        return { status: "running", turn_id: "dsh-turn-1", job_id: "dsh-job-1" };
      }
    },
    durableStore: testStore(),
    bindings: { "task-1": { checkpointRef: "checkpoint:1" } }
  });
  const result = await backend.run(input("dsh"));

  assert.equal(result.receipt.operation, "claude_code_start");
  assert.equal(result.receipt.continuation, "dsh_fresh");
  assert.equal(result.receipt.freshTurnRef?.turnId, "dsh-turn-1");
  assert.equal(result.receipt.freshTurnRef?.sessionId, null);
  assert.equal(result.receipt.freshTurnRef?.threadId, null);
  const dshRequest = received as unknown as Record<string, unknown>;
  assert.equal(dshRequest.executor, "dsh");
  assert.equal(dshRequest.workerBackend, "deepseek-harness");
  assert.equal("sessionId" in dshRequest, false);
  assert.equal("threadId" in dshRequest, false);
  await assert.rejects(() => backend.resumeDsh(), (error: unknown) => {
    assert.ok(error instanceof LocalBackendFailure);
    assert.equal(error.detail.code, "DSH_RESUME_FORBIDDEN");
    return true;
  });
});

test("Engineering Bridge worker keeps executor:dsh explicit and carries a structured instruction ref", async () => {
  let received: Record<string, unknown> | null = null;
  const backend = new LocalWorkerBackend({
    transport: {
      bridgeRunTask: (request) => {
        received = request as unknown as Record<string, unknown>;
        return { status: "queued", task_id: "bridge-task-1" };
      }
    },
    durableStore: testStore(),
    bindings: { "task-1": { workspaceId: "workspace-1" } }
  });
  const result = await backend.run(input("bridge-dsh"));
  assert.equal(result.receipt.source, "engineering-bridge");
  assert.equal(result.receipt.executor, "dsh");
  assert.equal(result.receipt.continuation, "dsh_fresh");
  assert.equal(result.realJobId, "bridge-task-1");
  const bridgeRequest = received as unknown as Record<string, unknown>;
  assert.equal(bridgeRequest.executor, "dsh");
  assert.deepEqual(bridgeRequest.instruction_ref, { kind: "handoff_item", ref: "handoff:item-1" });
});

test("completed output without a durable deliverable is deliverable_missing", async () => {
  const backend = new LocalWorkerBackend({
    transport: { claudeReply: () => ({ status: "completed", jobId: session.jobId, sessionId: session.sessionId, output: "text only" }) },
    durableStore: testStore(),
    bindings: { "task-1": { claudeSession: session } }
  });
  await assert.rejects(() => backend.runDetailed(input("claude", "missing-deliverable-001")), (error: unknown) => {
    assert.ok(error instanceof LocalBackendFailure);
    assert.equal(error.detail.code, "DELIVERABLE_MISSING");
    assert.equal(error.detail.class, "blocked");
    assert.ok(error.receipt && "outputRefs" in error.receipt);
    assert.equal(error.receipt.outputRefs.length, 0);
    return true;
  });
});

test("worker failures retain the five required error classes", async () => {
  const cases: Array<{ key: string; payload: unknown; expected: string }> = [
    { key: "needs-attention-001", payload: { status: "failed", error: { code: "NEEDS_ATTENTION", message: "supervisor review" } }, expected: "needs_attention" },
    { key: "rate-limit-001", payload: { status: "failed", error: { code: "upstream_rate_limited", message: "429" } }, expected: "upstream_rate_limited" },
    { key: "unavailable-001", payload: { status: "failed", error: { code: "upstream_unavailable", message: "502" } }, expected: "upstream_unavailable" },
    { key: "blocked-001", payload: { status: "blocked", error: { code: "CAPABILITY_UNAVAILABLE", message: "not wired" } }, expected: "blocked" },
    { key: "unknown-001", payload: { status: "unknown_in_flight" }, expected: "unknown" }
  ];
  for (const item of cases) {
    const backend = new LocalWorkerBackend({
      transport: { claudeReply: () => ({ ...item.payload as Record<string, unknown>, jobId: session.jobId, sessionId: session.sessionId }) },
      durableStore: testStore(),
      bindings: { "task-1": { claudeSession: session } }
    });
    const receipt = await backend.runDetailed(input("claude", item.key)).catch((error: unknown) => {
      assert.ok(error instanceof LocalBackendFailure);
      return error.receipt;
    });
    assert.equal(receipt?.error?.class, item.expected, item.key);
  }
});

test("repeated worker attempt idempotency returns one transport call and one attempt", async () => {
  let calls = 0;
  const backend = new LocalWorkerBackend({
    transport: {
      dshFreshStart: () => {
        calls += 1;
        return { status: "running", turn_id: "turn-1", job_id: "job-1" };
      }
    },
    durableStore: testStore(),
    bindings: { "task-1": { checkpointRef: "checkpoint:1" } }
  });
  const first = await backend.run(input("dsh", "same-attempt-001"));
  const second = await backend.run(input("dsh", "same-attempt-001"));
  assert.equal(calls, 1);
  assert.equal(first.attemptId, second.attemptId);
  assert.equal(first.receipt.requestId, second.receipt.requestId);
});

test("missing worker transport is fail-closed and never fabricates a job id", async () => {
  const backend = new LocalWorkerBackend({ durableStore: testStore(), bindings: { "task-1": { claudeSession: session } } });
  await assert.rejects(() => backend.runDetailed(input("claude", "no-transport-001")), (error: unknown) => {
    assert.ok(error instanceof LocalBackendFailure);
    assert.equal(error.detail.code, "WORKER_BACKEND_UNAVAILABLE");
    assert.equal(error.detail.class, "blocked");
    assert.ok(error.receipt && "realJobId" in error.receipt);
    assert.equal(error.receipt.realJobId, null);
    return true;
  });
});

test("durable store is mandatory by default; explicit in-memory store is test-only", async () => {
  const backend = new LocalWorkerBackend({
    transport: { claudeReply: () => ({ status: "running", jobId: session.jobId, sessionId: session.sessionId }) },
    bindings: { "task-1": { claudeSession: session } }
  });
  await assert.rejects(() => backend.runDetailed(input("claude", "no-store-001")), (error: unknown) => {
    assert.ok(error instanceof LocalBackendFailure);
    assert.equal(error.detail.code, "DURABLE_STORE_UNAVAILABLE");
    assert.equal(error.detail.class, "blocked");
    return true;
  });
});

test("controlled patch is diff-bound, APPLY-gated, and COMMIT remains separate", async () => {
  const calls: string[] = [];
  const diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const backend = new LocalPatchBackend({
    durableStore: testStore(),
    transport: {
      propose: (request) => {
        calls.push(`propose:${request.executor}`);
        return { patch_task_id: "patch-1", diff, base_head: "head-1" };
      },
      validate: (request) => {
        calls.push(`validate:${request.patch_task_id}`);
        return { verdict: "PASS", reasons: [] };
      },
      apply: (request) => {
        calls.push(`apply:${request.confirmation}`);
        return { apply_receipt_id: "apply-1", changed_files: ["file.txt"] };
      },
      commit: (request) => {
        calls.push(`commit:${request.confirmation}`);
        return { commit_hash: "commit-1", commit_receipt_id: "commit-receipt-1" };
      }
    }
  });
  const proposed = await backend.propose({ changeRequest: { workspaceId: "workspace-1", baseHead: "head-1", title: "t", motivation: "m", paths: ["file.txt"] }, executor: "dsh", idempotencyKey: "patch-idem-001" });
  assert.equal(proposed.diff, diff);
  const verdict = await backend.validate({ patchTaskId: "patch-1", diff });
  assert.equal(verdict.verdict, "PASS");
  await assert.rejects(() => backend.applyWithConfirmation({ patchTaskId: "patch-1", diff, confirmation: "please APPLY" }), /exact confirmation APPLY/);
  await assert.rejects(() => backend.commitWithConfirmation({ patchTaskId: "patch-1", message: "commit", confirmation: "COMMIT" }), /prior successful APPLY/);
  const applied = await backend.applyWithConfirmation({ patchTaskId: "patch-1", diff, confirmation: "APPLY" });
  assert.deepEqual(applied, { changedFiles: ["file.txt"], applyReceiptId: "apply-1" });
  const committed = await backend.commitWithConfirmation({ patchTaskId: "patch-1", message: "commit", confirmation: "COMMIT" });
  assert.deepEqual(committed, { commitHash: "commit-1", commitReceiptId: "commit-receipt-1" });
  assert.deepEqual(calls, ["propose:dsh", "validate:patch-1", "apply:APPLY", "commit:COMMIT"]);
});

test("missing patch transport is fail-closed and never silently replaced by a mock", async () => {
  const backend = new LocalPatchBackend({ durableStore: testStore() });
  await assert.rejects(() => backend.propose({ changeRequest: { workspaceId: "workspace-1", baseHead: "head-1" }, executor: "dsh", idempotencyKey: "patch-no-transport-001" }), (error: unknown) => {
    assert.ok(error instanceof LocalBackendFailure);
    assert.equal(error.detail.code, "PATCH_BACKEND_UNAVAILABLE");
    assert.equal(error.detail.class, "blocked");
    return true;
  });
});

test("durable worker idempotency survives a new adapter instance", async () => {
  const store = new InMemoryLocalDurableStore();
  let calls = 0;
  const transport: LocalWorkerTransport = {
    dshFreshStart: () => {
      calls += 1;
      return { status: "running", turn_id: "turn-durable", job_id: "job-durable" };
    }
  };
  const first = new LocalWorkerBackend({ transport, durableStore: store, bindings: { "task-1": { checkpointRef: "checkpoint:durable" } } });
  const second = new LocalWorkerBackend({ transport, durableStore: store, bindings: { "task-1": { checkpointRef: "checkpoint:durable" } } });
  const firstResult = await first.run(input("dsh", "cross-instance-001"));
  const secondResult = await second.run(input("dsh", "cross-instance-001"));
  assert.equal(calls, 1);
  assert.equal(firstResult.attemptId, secondResult.attemptId);
  assert.equal(firstResult.receipt.requestId, secondResult.receipt.requestId);
});

test("durable patch proposal idempotency survives a new adapter instance", async () => {
  const store = new InMemoryLocalDurableStore();
  let calls = 0;
  const transport = {
    propose: () => {
      calls += 1;
      return { patch_task_id: "patch-cross-instance", diff: "same bytes\n", base_head: "head-cross" };
    }
  };
  const request = { changeRequest: { workspaceId: "workspace-cross", baseHead: "head-cross" }, executor: "dsh", idempotencyKey: "patch-cross-idem" } as const;
  const first = new LocalPatchBackend({ transport, durableStore: store });
  const second = new LocalPatchBackend({ transport, durableStore: store });
  assert.deepEqual(await first.propose(request), await second.propose(request));
  assert.equal(calls, 1);
});

test("proposal, validation, and APPLY use exact diff bytes including the final newline", async () => {
  const store = new InMemoryLocalDurableStore();
  const diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n\n";
  let validateCalls = 0;
  const backend = new LocalPatchBackend({
    durableStore: store,
    transport: {
      propose: () => ({ patch_task_id: "patch-byte-exact", diff, base_head: "head-byte" }),
      validate: () => {
        validateCalls += 1;
        return { verdict: "PASS", reasons: [] };
      },
      apply: () => ({ apply_receipt_id: "apply-byte", changed_files: ["file.txt"] })
    }
  });
  const proposed = await backend.propose({ changeRequest: { workspaceId: "workspace-byte", baseHead: "head-byte" }, executor: "dsh", idempotencyKey: "patch-byte-idem-001" });
  assert.equal(proposed.diff, diff);
  await assert.rejects(() => backend.validate({ patchTaskId: "patch-byte-exact", diff: `${diff}\n` }), /exactly match/);
  assert.equal(validateCalls, 0);
  const verdict = await backend.validate({ patchTaskId: "patch-byte-exact", diff });
  assert.equal(verdict.verdict, "PASS");
  await assert.rejects(() => backend.applyWithConfirmation({ patchTaskId: "patch-byte-exact", diff: diff.slice(0, -1), confirmation: "APPLY" }), /exactly match/);
  assert.equal(store.listPatchReceipts().at(-1)?.operation, "apply");
  assert.equal(store.listPatchReceipts().at(-1)?.status, "failed");
  const applied = await backend.applyWithConfirmation({ patchTaskId: "patch-byte-exact", diff, confirmation: "APPLY" });
  assert.equal(applied.applyReceiptId, "apply-byte");
  const applyReceipts = store.listPatchReceipts().filter((receipt) => receipt.operation === "apply");
  assert.equal(applyReceipts.length, 2);
  assert.equal(applyReceipts.at(-1)?.ok, true);
  assert.equal(applyReceipts.at(-1)?.diffHash, sha256(diff));
  assert.equal(applyReceipts.at(-1)?.confirmation, "APPLY");
  assert.deepEqual(applyReceipts.at(-1)?.changedFiles, ["file.txt"]);
});

test("failed APPLY and successful COMMIT both write receipts; COMMIT is never folded into APPLY", async () => {
  const store = new InMemoryLocalDurableStore();
  let applyCalls = 0;
  let commitCalls = 0;
  const backend = new LocalPatchBackend({
    durableStore: store,
    transport: {
      propose: () => ({ patch_task_id: "patch-receipts", diff: "diff\n", base_head: "head" }),
      validate: () => ({ verdict: "PASS", reasons: [] }),
      apply: () => {
        applyCalls += 1;
        return applyCalls === 1 ? { error: { code: "upstream_unavailable", message: "502" } } : { apply_receipt_id: "apply-ok", changed_files: ["a.txt"] };
      },
      commit: () => {
        commitCalls += 1;
        return commitCalls === 1
          ? { error: { code: "upstream_unavailable", message: "502" } }
          : { commit_hash: "commit-ok", commit_receipt_id: "commit-receipt" };
      }
    }
  });
  await backend.propose({ changeRequest: { workspaceId: "workspace-receipts", baseHead: "head" }, executor: "dsh", idempotencyKey: "patch-receipts-idem" });
  await backend.validate({ patchTaskId: "patch-receipts", diff: "diff\n" });
  await assert.rejects(() => backend.applyWithConfirmation({ patchTaskId: "patch-receipts", diff: "diff\n", confirmation: "APPLY" }), /502/);
  const failedApply = [...store.listPatchReceipts()].reverse().find((receipt) => receipt.operation === "apply");
  assert.equal(failedApply?.ok, false);
  assert.equal(failedApply?.confirmation, "APPLY");
  assert.equal(failedApply?.diffHash, failedApply?.diffRef?.hash);
  assert.equal(commitCalls, 0);
  await backend.applyWithConfirmation({ patchTaskId: "patch-receipts", diff: "diff\n", confirmation: "APPLY" });
  await assert.rejects(() => backend.commitWithConfirmation({ patchTaskId: "patch-receipts", message: "save", confirmation: "COMMIT" }), /502/);
  const failedCommit = [...store.listPatchReceipts()].reverse().find((receipt) => receipt.operation === "commit");
  assert.equal(failedCommit?.ok, false);
  assert.equal(failedCommit?.confirmation, "COMMIT");
  assert.equal(failedCommit?.commitHash, null);
  const committed = await backend.commitWithConfirmation({ patchTaskId: "patch-receipts", message: "save", confirmation: "COMMIT" });
  assert.equal(committed.commitHash, "commit-ok");
  assert.equal(commitCalls, 2);
  const commitReceipt = [...store.listPatchReceipts()].reverse().find((receipt) => receipt.operation === "commit");
  assert.equal(commitReceipt?.ok, true);
  assert.equal(commitReceipt?.confirmation, "COMMIT");
  assert.equal(commitReceipt?.commitHash, "commit-ok");
  assert.equal(commitReceipt?.commitReceiptId, "commit-receipt");
});
