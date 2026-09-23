import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAppServerAdapter,
  MockAppServerTransport,
  type AppServerMethod
} from "../../src/adapters/codex-app-server.js";

const readMessage = {
  method: "account/rateLimits/read",
  result: {
    rateLimits: {
      primary: { windowId: "five-hour", usedPercent: 95, remainingPercent: 5, updatedAt: "2026-09-01T00:00:00.000Z", resetsAt: "2026-09-01T05:00:00.000Z" },
      secondary: { windowId: "weekly", usedPercent: 40, remainingPercent: 60, updatedAt: "2026-09-01T00:00:00.000Z", resetsAt: "2026-09-07T00:00:00.000Z" }
    }
  }
};

function transport(responses: Partial<Record<AppServerMethod, unknown | (() => unknown | Promise<unknown>)>>) {
  return new MockAppServerTransport(responses, [
    "account/rateLimits/read",
    "account/rateLimits/updated",
    "thread/list",
    "turn/interrupt",
    "thread/resume"
  ]);
}

test("readRateLimits calls only injected account/rateLimits/read and normalizes the structured response", async () => {
  const mock = transport({ "account/rateLimits/read": readMessage });
  const adapter = new CodexAppServerAdapter(mock);
  const snapshot = await adapter.readRateLimits();
  assert.equal(snapshot.status, "fresh");
  assert.equal(snapshot.source, "fixture");
  assert.equal(snapshot.primary?.remainingBps, 500);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.method, "account/rateLimits/read");
});

test("updated notification is handled locally and does not call transport", () => {
  const mock = transport({});
  const adapter = new CodexAppServerAdapter(mock);
  const snapshot = adapter.rateLimitsUpdated({
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { windowId: "five-hour", usedPercent: 80, remainingPercent: 20, updatedAt: "2026-09-01T01:00:00.000Z" } } }
  });
  assert.equal(snapshot.status, "fresh");
  assert.equal(snapshot.primary?.remainingBps, 2000);
  assert.equal(mock.calls.length, 0);
});

test("thread/list returns all structured active threads and carries explicit scope proof", async () => {
  const mock = transport({
    "thread/list": { result: { visibility: "complete", threads: [
      { threadId: "thread-a", turnId: "turn-a", projectId: "project-a", status: "active" },
      { threadId: "thread-b", turnId: "turn-b", projectId: "project-b", status: "active" }
    ] } }
  });
  const list = await new CodexAppServerAdapter(mock).listVisibleActiveThreads();
  assert.equal(list.length, 2);
  assert.equal(list.threads, list);
  assert.equal(list.visibilityKnown, true);
  assert.equal(list.scope, "all_visible_active");
  assert.equal(list[1]?.threadId, "thread-b");
  assert.equal(mock.calls[0]?.method, "thread/list");
  assert.deepEqual(mock.calls[0]?.params, { status: "active" });
});

test("thread/list without complete visibility and without stable ids remains unknown", async () => {
  const mock = transport({ "thread/list": { result: { threads: [{ turnId: "turn-a" }] } } });
  const list = await new CodexAppServerAdapter(mock).listVisibleActiveThreads();
  assert.equal(list.visibilityKnown, false);
  assert.equal(list.scope, "unknown");
  assert.equal(list.fault?.code, "UNMAPPED_THREAD");
  assert.deepEqual(list.invalidThreadIndexes, [0]);
});

test("interrupt success preserves original ids and receipt; timeout and unknown in-flight are distinct", async () => {
  const successMock = transport({ "turn/interrupt": { ok: true, receiptId: "interrupt-1", threadId: "thread-a", turnId: "turn-a", status: "confirmed" } });
  const success = await new CodexAppServerAdapter(successMock).interruptTurn("thread-a", "turn-a", "idem-1");
  assert.equal(success.confirmed, true);
  assert.equal(success.receiptId, "interrupt-1");
  assert.equal(success.status, "confirmed");
  assert.deepEqual(successMock.calls[0]?.params, { threadId: "thread-a", turnId: "turn-a" });

  const timeoutMock = transport({ "turn/interrupt": () => new Promise<unknown>(() => undefined) });
  const timeout = await new CodexAppServerAdapter(timeoutMock, { timeoutMs: 10 }).interruptTurn("thread-a", "turn-a", "idem-timeout");
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.confirmed, false);
  assert.equal(timeout.fault?.code, "APP_SERVER_TIMEOUT");

  const unknownMock = transport({ "turn/interrupt": { error: { code: "IN_FLIGHT", message: "request may have arrived" } } });
  const unknown = await new CodexAppServerAdapter(unknownMock).interruptTurn("thread-a", "turn-a", "idem-unknown");
  assert.equal(unknown.status, "unknown_in_flight");
  assert.equal(unknown.fault?.status, "reconcile_required");
});

test("interrupt never fabricates a missing turn id and resume validates original-thread receipt", async () => {
  const mock = transport({});
  const invalid = await new CodexAppServerAdapter(mock).interruptTurn("thread-a", "", "idem-invalid");
  assert.equal(invalid.confirmed, false);
  assert.equal(invalid.fault?.code, "INVALID_THREAD_ID");
  assert.equal(mock.calls.length, 0);

  const missing = await new CodexAppServerAdapter(transport({
    "thread/resume": { ok: true, receiptId: "resume-1", newTurnId: "turn-new", status: "resumed" }
  })).resumeThread("thread-a", "checkpoint-1", "idem-resume-missing");
  assert.equal(missing.status, "failed");
  assert.equal(missing.fault?.code, "ORIGINAL_THREAD_MISSING");

  const mismatch = await new CodexAppServerAdapter(transport({
    "thread/resume": { ok: true, receiptId: "resume-2", threadId: "replacement", newTurnId: "turn-new", status: "resumed" }
  })).resumeThread("thread-a", "checkpoint-1", "idem-resume-mismatch");
  assert.equal(mismatch.confirmed, false);
  assert.equal(mismatch.fault?.code, "RECEIPT_ID_MISMATCH");
});

test("resume success requires original thread, new turn, and explicit receipt", async () => {
  const mock = transport({ "thread/resume": { ok: true, receiptId: "resume-1", threadId: "thread-a", newTurnId: "turn-new", status: "resumed" } });
  const receipt = await new CodexAppServerAdapter(mock).resumeThread("thread-a", "checkpoint-1", "idem-resume");
  assert.equal(receipt.status, "confirmed");
  assert.equal(receipt.confirmed, true);
  assert.equal(receipt.originalThreadId, "thread-a");
  assert.equal(receipt.resumedThreadId, "thread-a");
  assert.equal(receipt.newTurnId, "turn-new");
  assert.equal(mock.calls[0]?.method, "thread/resume");
  assert.deepEqual(mock.calls[0]?.params, { threadId: "thread-a", checkpointRef: "checkpoint-1" });
});

test("resume identity fields are table-driven and never hide a replacement thread", async () => {
  const cases: Array<{ name: string; payload: unknown; ok: boolean; code?: string; resumed?: string | null }> = [
    {
      name: "camel resumed replacement",
      payload: { ok: true, receiptId: "resume-camel-replacement", originalThreadId: "thread-a", resumedThreadId: "replacement", newTurnId: "turn-new", status: "resumed" },
      ok: false,
      code: "THREAD_ID_FIELDS_CONFLICT",
      resumed: "replacement"
    },
    {
      name: "snake resumed replacement",
      payload: { ok: true, receipt_id: "resume-snake-replacement", original_thread_id: "thread-a", resumed_thread_id: "replacement", new_turn_id: "turn-new", status: "resumed" },
      ok: false,
      code: "THREAD_ID_FIELDS_CONFLICT",
      resumed: "replacement"
    },
    {
      name: "identity fields conflict with each other",
      payload: { ok: true, receiptId: "resume-conflict", threadId: "thread-a", originalThreadId: "other", resumedThreadId: "thread-a", newTurnId: "turn-new", status: "resumed" },
      ok: false,
      code: "THREAD_ID_FIELDS_CONFLICT",
      resumed: "thread-a"
    },
    {
      name: "all camel identities agree",
      payload: { ok: true, receiptId: "resume-camel-ok", threadId: "thread-a", originalThreadId: "thread-a", resumedThreadId: "thread-a", newTurnId: "turn-new", status: "resumed" },
      ok: true,
      resumed: "thread-a"
    },
    {
      name: "all snake identities agree",
      payload: { ok: true, receipt_id: "resume-snake-ok", thread_id: "thread-a", original_thread_id: "thread-a", resumed_thread_id: "thread-a", new_turn_id: "turn-new", status: "resumed" },
      ok: true,
      resumed: "thread-a"
    }
  ];
  for (const current of cases) {
    const mock = transport({ "thread/resume": current.payload });
    const receipt = await new CodexAppServerAdapter(mock).resumeThread("thread-a", "checkpoint-1", `idem-${current.name}`);
    assert.equal(receipt.confirmed, current.ok, current.name);
    assert.equal(receipt.resumedThreadId, current.resumed ?? null, current.name);
    if (current.code) assert.equal(receipt.fault?.code, current.code, current.name);
  }
});

test("the previous original-thread response shape now rejects resumedThreadId replacement and keeps unknown in-flight structured", async () => {
  const replacement = await new CodexAppServerAdapter(transport({
    "thread/resume": { ok: true, receiptId: "resume-old-shape", originalThreadId: "thread-a", resumedThreadId: "replacement", newTurnId: "turn-new", status: "resumed" }
  })).resumeThread("thread-a", "checkpoint-1", "idem-old-shape");
  assert.equal(replacement.confirmed, false);
  assert.equal(replacement.resumedThreadId, "replacement");
  assert.equal(replacement.fault?.code, "THREAD_ID_FIELDS_CONFLICT");

  const unknown = await new CodexAppServerAdapter(transport({
    "thread/resume": { error: { code: "UNKNOWN_IN_FLIGHT", message: "may have arrived" } }
  })).resumeThread("thread-a", "checkpoint-1", "idem-resume-unknown");
  assert.equal(unknown.status, "unknown_in_flight");
  assert.equal(unknown.confirmed, false);
  assert.equal(unknown.fault?.code, "UNKNOWN_IN_FLIGHT");
});

test("capability probe is explicitly static/unverified and injected transport is mandatory", () => {
  const mock = transport({});
  const probe = new CodexAppServerAdapter(mock).capabilityProbe();
  assert.equal(probe.realEvidence, "UNVERIFIED");
  assert.equal(probe.methods["thread/resume"], "present");
  assert.throws(() => new CodexAppServerAdapter(null as never), /injected transport/);
});
