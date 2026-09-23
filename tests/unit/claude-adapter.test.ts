import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../src/domain/errors.js";
import { ClaudeOrchestratorAdapter, type ClaudeOrchestratorTransport, type DshFreshStartRequest, type ClaudeReplyRequest } from "../../src/adapters/claude-orchestrator.js";
import type { RealSessionRef } from "../../src/adapters/adapter-types.js";

const session: RealSessionRef = {
  kind: "real_session",
  backend: "claude",
  source: "claude_orchestrator",
  jobId: "claude-job-1",
  sessionId: "claude-session-1",
  threadId: null
};

test("Claude resume preserves the supplied real session reference and DSH uses a separate fresh turn reference", async () => {
  const replyRequest: { value: ClaudeReplyRequest | null } = { value: null };
  const startRequest: { value: DshFreshStartRequest | null } = { value: null };
  const transport: ClaudeOrchestratorTransport = {
    reply: (request) => {
      replyRequest.value = request;
      return { status: "waiting_for_supervisor_review", review_output: "review", evidence: ["receipt:claude"] };
    },
    start: (request) => {
      startRequest.value = request;
      return { status: "running", turn_id: "dsh-turn-1", job_id: "dsh-job-1", evidence: ["receipt:dsh"] };
    }
  };
  const adapter = new ClaudeOrchestratorAdapter({ transport, externalAssetsStatus: "LOCATED", transportKind: "mock" });
  const resumed = await adapter.resumeClaude({ task_id: "task-a", attempt_id: "claude-attempt", session, instruction_ref: "handoff:task-a", idempotency_key: "claude-1" });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.continuation, "claude_resume");
  assert.deepEqual(resumed.realSessionRef, session);
  assert.equal(resumed.freshTurnRef, null);
  assert.equal(resumed.idempotencyKey, "claude-1");
  assert.equal(replyRequest.value?.backend, "claude");
  assert.equal(replyRequest.value?.jobId, "claude-job-1");
  assert.equal(replyRequest.value?.sessionId, "claude-session-1");

  const fresh = await adapter.startDshFresh({ task_id: "task-a", attempt_id: "dsh-attempt", instruction_ref: "handoff:task-a", checkpoint_ref: "checkpoint:1", idempotency_key: "dsh-1" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.continuation, "dsh_fresh");
  assert.equal(fresh.realSessionRef, null);
  assert.equal(fresh.freshTurnRef?.turnId, "dsh-turn-1");
  assert.equal(fresh.freshTurnRef?.jobId, "dsh-job-1");
  assert.equal(fresh.freshTurnRef?.sessionId, null);
  assert.equal(fresh.freshTurnRef?.threadId, null);
  assert.equal(startRequest.value?.workerBackend, "deepseek-harness");
  assert.equal(Object.prototype.hasOwnProperty.call(startRequest.value ?? {}, "sessionId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(startRequest.value ?? {}, "threadId"), false);
});

test("DSH reply/resume calls are rejected and a returned replacement Claude session is not accepted", async () => {
  const adapter = new ClaudeOrchestratorAdapter({
    transport: {
      reply: () => ({ status: "completed", jobId: "replacement-job" })
    },
    externalAssetsStatus: "LOCATED"
  });
  await assert.rejects(() => adapter.replyDsh({ instruction_ref: "handoff:task-a", checkpoint_ref: "checkpoint:1" }), DomainError);
  await assert.rejects(() => adapter.resumeDsh({ instruction_ref: "handoff:task-a", checkpoint_ref: "checkpoint:1" }), /fresh turn/);
  const mismatch = await adapter.resumeClaude({ session, instruction_ref: "handoff:task-a" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error?.code, "SESSION_REF_MISMATCH");
  assert.equal(mismatch.status, "failed");
});

test("real calls fail closed when external assets are NOT_LOCATED, while injected mock calls remain local", async () => {
  let calls = 0;
  const transport: ClaudeOrchestratorTransport = {
    reply: () => { calls += 1; return { status: "completed" }; },
    start: () => { calls += 1; return { status: "completed", turn_id: "turn" }; }
  };
  const real = new ClaudeOrchestratorAdapter({ transport, externalAssetsStatus: "NOT_LOCATED", transportKind: "real" });
  const blocked = await real.resumeClaude({ session, instruction_ref: "handoff:task-a" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(calls, 0);

  const mock = new ClaudeOrchestratorAdapter({ transport, externalAssetsStatus: "NOT_LOCATED", transportKind: "mock" });
  const fresh = await mock.startDshFresh({ instruction_ref: "handoff:task-a", checkpoint_ref: "checkpoint:1" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.freshTurnRef?.turnId, "turn");
  assert.equal(calls, 1);
});

test("worker failure, partial output, and evidence-drop are preserved as structured non-success receipts", async () => {
  const adapter = new ClaudeOrchestratorAdapter({
    transport: {
      start: () => ({ status: "failed", partial_output: "partial", evidence_drop: { dropped: 3, reason: "bounded" } })
    },
    externalAssetsStatus: "LOCATED"
  });
  const receipt = await adapter.startDshFresh({ instruction_ref: "handoff:task-a", checkpoint_ref: "checkpoint:1" });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, "partial_output");
  assert.equal(receipt.partialOutput, "partial");
  assert.equal(receipt.evidenceDrop?.dropped, 3);
});
