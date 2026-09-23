import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAppServerStdioTransport,
  type AppServerRpcRequest,
  type DedicatedTaskGuard
} from "../../src/adapters/codex-app-server-stdio.js";
import { FixtureAppServerChild, fixtureSpawn } from "../fixtures/app-server-stdio/mock-child.js";

function initializeResult() {
  return {
    serverInfo: { name: "fixture-app-server", version: "0.0.0" },
    capabilities: {}
  };
}

function transportFor(
  child: FixtureAppServerChild,
  specs: Array<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>>; envAllowlist: readonly string[] }>,
  options: Partial<ConstructorParameters<typeof CodexAppServerStdioTransport>[0]> = {}
): CodexAppServerStdioTransport {
  return new CodexAppServerStdioTransport({
    command: "codex",
    args: ["app-server"],
    env: { PATH: "C:\\safe\\bin" },
    envAllowlist: ["PATH"],
    spawn: fixtureSpawn(child, specs),
    ...options
  });
}

async function initializedTransport(
  handler: (request: AppServerRpcRequest, child: FixtureAppServerChild) => void | Promise<void>,
  options: Partial<ConstructorParameters<typeof CodexAppServerStdioTransport>[0]> = {}
) {
  const child = new FixtureAppServerChild(handler);
  const specs: Array<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>>; envAllowlist: readonly string[] }> = [];
  const transport = transportFor(child, specs, options);
  const initialized = await transport.initialize();
  assert.equal(initialized.ok, true);
  return { child, specs, transport };
}

test("spawn spec is explicit and initialize is followed by an initialized notification", async () => {
  const child = new FixtureAppServerChild((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult(), { chunkSize: 3 });
  });
  const specs: Array<{ command: string; args: readonly string[]; cwd?: string; env: Readonly<Record<string, string>>; envAllowlist: readonly string[] }> = [];
  const transport = transportFor(child, specs, { cwd: "D:\\fixture-repo" });
  const receipt = await transport.initialize();

  assert.equal(receipt.ok, true);
  assert.equal(receipt.requestId, 1);
  assert.equal(transport.lifecycle, "initialized");
  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.command, "codex");
  assert.deepEqual(specs[0]?.args, ["app-server"]);
  assert.equal(specs[0]?.cwd, "D:\\fixture-repo");
  assert.deepEqual(specs[0]?.env, { PATH: "C:\\safe\\bin" });
  assert.deepEqual(specs[0]?.envAllowlist, ["PATH"]);
  const wire = child.writes.flatMap((write) => write.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
  assert.equal(wire[0]?.method, "initialize");
  assert.equal(wire[0]?.id, 1);
  assert.equal(wire[1]?.method, "initialized");
  assert.equal(Object.prototype.hasOwnProperty.call(wire[1] ?? {}, "id"), false);
});

test("thread/list parses result.data, follows 21 pages, and treats it as registry scope", async () => {
  const { transport, child } = await initializedTransport((request, current) => {
    if (request.method !== "initialize" && request.method !== "thread/list") return;
    if (request.method === "initialize") { current.reply(request.id, initializeResult()); return; }
    const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : null;
    const page = cursor === null ? 0 : Number(cursor.slice(1));
    current.reply(request.id, { data: [{ id: `registry-thread-${page}`, status: { type: "notLoaded" }, source: "subAgent" }], nextCursor: page < 20 ? `c${page + 1}` : null });
  });

  const result = await transport.listRegistryThreads();
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.scope, "registry");
  assert.equal(result.pages, 21);
  assert.equal(result.threads.length, 21);
  assert.equal(result.cursors.length, 20);
  assert.deepEqual(result.duplicateThreadIds, []);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 21);
  assert.equal(result.threads[0]?.status, "notLoaded");
});

test("thread/list null cursor completes in one page", async () => {
  const { transport } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "thread/list") current.reply(request.id, { data: [{ id: "only-thread" }], nextCursor: null });
  });
  const result = await transport.listRegistryThreads();
  assert.equal(result.ok, true);
  assert.equal(result.pages, 1);
  assert.equal(result.threads[0]?.threadId, "only-thread");
});

test("repeated cursor fails closed before an unbounded loop", async () => {
  const { transport, child } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "thread/list") current.reply(request.id, { data: [{ id: `thread-${request.id}` }], nextCursor: "same-cursor" });
  });
  const result = await transport.listRegistryThreads();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fault?.code, "CURSOR_LOOP");
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 2);
});

test("duplicate thread IDs are returned once and fail closed", async () => {
  const { transport } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const page = typeof request.params === "object" && request.params !== null && (request.params as Record<string, unknown>).cursor ? 1 : 0;
      current.reply(request.id, { data: [{ id: page === 0 ? "duplicate-thread" : "duplicate-thread" }], nextCursor: page === 0 ? "next" : null });
    }
  });
  const result = await transport.listRegistryThreads();
  assert.equal(result.ok, false);
  assert.equal(result.fault?.code, "DUPLICATE_THREAD_ID");
  assert.deepEqual(result.duplicateThreadIds, ["duplicate-thread"]);
  assert.equal(result.threads.length, 1);
});

test("loaded/active probe does not infer scope from a registry notLoaded status", async () => {
  const { transport } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "thread/loaded/list") current.reply(request.id, { data: [{ id: "registry-thread", status: { type: "notLoaded" } }], nextCursor: null });
  });
  const probe = await transport.probeLoadedActiveScope();
  assert.equal(probe.known, false);
  assert.equal(probe.scope, "unknown");
  assert.equal(probe.fault?.code, "DRAIN_SCOPE_UNKNOWN");
});

test("rate-limit read and updated notifications use the normalization seam and redact event data", async () => {
  const { transport, child } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "account/rateLimits/read") current.reply(request.id, {
      rateLimits: {
        primary: { windowId: "five-hour", usedPercent: 80, remainingPercent: 20, updatedAt: "2026-09-05T00:00:00.000Z" }
      }
    });
  });
  const events: string[] = [];
  transport.onEvent((event) => events.push(JSON.stringify(event)));
  const read = await transport.readRateLimits();
  assert.equal(read.ok, true);
  assert.equal(read.snapshot.primary?.remainingBps, 2_000);

  child.notification("account/rateLimits/updated", {
    rateLimits: { primary: { windowId: "five-hour", usedPercent: 81, remainingPercent: 19, updatedAt: "2026-09-05T00:01:00.000Z" } },
    api_key: "super-secret"
  });
  assert.equal(transport.latestRateLimits?.primary?.remainingBps, 1_900);
  assert.equal(events.some((event) => event.includes("super-secret")), false);
  assert.equal(events.some((event) => event.includes("[REDACTED]")), true);
});

function dedicatedGuard(targetTaskId: string, protectedTaskIds: readonly string[] = []): DedicatedTaskGuard {
  return { targetTaskId, currentTaskId: "current-task", protectedTaskIds, dedicated: true, confirmation: "explicit" };
}

test("interrupt/resume require a dedicated non-current target and return request/response receipts", async () => {
  const { transport, child } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "turn/interrupt") current.reply(request.id, { ok: true, status: "interrupted", receiptId: "interrupt-receipt", threadId: "dedicated-thread", turnId: "turn-1" });
    if (request.method === "thread/resume") current.reply(request.id, { ok: true, status: "resumed", receiptId: "resume-receipt", threadId: "dedicated-thread", newTurnId: "turn-2" });
  }, { currentTaskId: "current-task", protectedTaskIds: ["protected-task"] });

  const interrupted = await transport.interruptTurn({
    targetTaskId: "dedicated-task",
    threadId: "dedicated-thread",
    turnId: "turn-1",
    idempotencyKey: "interrupt-idem",
    guard: dedicatedGuard("dedicated-task")
  });
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.requestId, 2);
  assert.equal(interrupted.responseId, 2);
  assert.equal(interrupted.receiptId, "interrupt-receipt");
  assert.equal((interrupted.rawResponse as { threadId?: string }).threadId, "dedicated-thread");

  const resumed = await transport.resumeThread({
    targetTaskId: "dedicated-task",
    threadId: "dedicated-thread",
    checkpointRef: "checkpoint-1",
    idempotencyKey: "resume-idem",
    guard: dedicatedGuard("dedicated-task")
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.requestId, 3);
  assert.equal(resumed.responseId, 3);
  assert.equal(resumed.receiptId, "resume-receipt");
  assert.equal(resumed.newTurnId, "turn-2");
  assert.deepEqual(child.requests.filter((request) => request.method === "turn/interrupt")[0]?.params, { threadId: "dedicated-thread", turnId: "turn-1" });
});

test("current and protected targets are rejected before any interrupt/resume RPC", async () => {
  const { transport, child } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
  }, { currentTaskId: "current-task", protectedTaskIds: ["protected-task"] });
  const current = await transport.interruptTurn({ targetTaskId: "current-task", threadId: "thread", turnId: "turn", idempotencyKey: "i1", guard: dedicatedGuard("current-task") });
  const protectedTarget = await transport.resumeThread({ targetTaskId: "protected-task", threadId: "thread", checkpointRef: "cp", idempotencyKey: "i2", guard: dedicatedGuard("protected-task") });
  const missingGuard = await transport.interruptTurn({ targetTaskId: "dedicated-task", threadId: "thread", turnId: "turn", idempotencyKey: "i3", guard: undefined as never });
  assert.equal(current.fault?.code, "CURRENT_TASK_PROTECTED");
  assert.equal(protectedTarget.fault?.code, "PROTECTED_TASK");
  assert.equal(missingGuard.fault?.code, "CONTROL_GUARD_REQUIRED");
  assert.equal(child.requests.filter((request) => request.method === "turn/interrupt" || request.method === "thread/resume").length, 0);
});

test("timeout becomes reconcile-required and controlled shutdown resolves pending requests", async () => {
  const first = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
  }, { requestTimeoutMs: 10 });
  const timedOut = await first.transport.request("thread/list", {});
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error?.code, "APP_SERVER_TIMEOUT");
  assert.deepEqual(first.transport.unknownInFlightRequestIds, [2]);
  const blocked = await first.transport.request("thread/list", {});
  assert.equal(blocked.error?.code, "RECONCILE_REQUIRED");
  await first.transport.shutdown({ timeoutMs: 20 });

  const second = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
  });
  const pending = second.transport.request("thread/list", {});
  const shutdown = await second.transport.shutdown({ timeoutMs: 20 });
  const cancelled = await pending;
  assert.equal(shutdown.status, "closed");
  assert.equal(cancelled.error?.code, "APP_SERVER_SHUTDOWN");
  assert.equal(second.child.closed, true);
});

test("loaded/active scope duplicate IDs fail closed instead of claiming a complete scope", async () => {
  const { transport } = await initializedTransport((request, current) => {
    if (request.method === "initialize") current.reply(request.id, initializeResult());
    if (request.method === "thread/active/list") current.reply(request.id, {
      scope: "active",
      data: [{ id: "active-duplicate" }, { id: "active-duplicate" }],
      nextCursor: null
    });
  });
  const probe = await transport.probeLoadedActiveScope("thread/active/list");
  assert.equal(probe.ok, false);
  assert.equal(probe.known, false);
  assert.equal(probe.scope, "unknown");
  assert.equal(probe.fault?.code, "DUPLICATE_THREAD_ID");
  assert.equal(probe.threads.length, 1);
});

test("interrupt receipt must carry matching thread, turn, and receipt identifiers", async () => {
  const cases: Array<{ name: string; response: unknown; code: string }> = [
    { name: "missing thread", response: { ok: true, status: "interrupted", receiptId: "receipt", turnId: "turn-1" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "wrong thread", response: { ok: true, status: "interrupted", receiptId: "receipt", threadId: "other-thread", turnId: "turn-1" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "missing turn", response: { ok: true, status: "interrupted", receiptId: "receipt", threadId: "dedicated-thread" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "wrong turn", response: { ok: true, status: "interrupted", receiptId: "receipt", threadId: "dedicated-thread", turnId: "other-turn" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "missing receipt", response: { ok: true, status: "interrupted", threadId: "dedicated-thread", turnId: "turn-1" }, code: "RECEIPT_INVALID" }
  ];
  for (const current of cases) {
    const { transport, child } = await initializedTransport((request, fixtureChild) => {
      if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
      if (request.method === "turn/interrupt") fixtureChild.reply(request.id, current.response);
    });
    const receipt = await transport.interruptTurn({
      targetTaskId: "dedicated-task",
      threadId: "dedicated-thread",
      turnId: "turn-1",
      idempotencyKey: `interrupt-${current.name}`,
      guard: dedicatedGuard("dedicated-task")
    });
    assert.equal(receipt.ok, false, current.name);
    assert.equal(receipt.fault?.code, current.code, current.name);
    await transport.shutdown();
    assert.equal(child.closed, true);
  }
});

test("resume receipt must carry the requested original thread plus new turn and receipt", async () => {
  const cases: Array<{ name: string; response: unknown; code: string }> = [
    { name: "missing thread", response: { ok: true, status: "resumed", receiptId: "receipt", newTurnId: "turn-2" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "wrong thread", response: { ok: true, status: "resumed", receiptId: "receipt", threadId: "replacement", newTurnId: "turn-2" }, code: "RECEIPT_ID_MISMATCH" },
    { name: "missing new turn", response: { ok: true, status: "resumed", receiptId: "receipt", threadId: "dedicated-thread" }, code: "RECEIPT_INVALID" },
    { name: "missing receipt", response: { ok: true, status: "resumed", threadId: "dedicated-thread", newTurnId: "turn-2" }, code: "RECEIPT_INVALID" }
  ];
  for (const current of cases) {
    const { transport, child } = await initializedTransport((request, fixtureChild) => {
      if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
      if (request.method === "thread/resume") fixtureChild.reply(request.id, current.response);
    });
    const receipt = await transport.resumeThread({
      targetTaskId: "dedicated-task",
      threadId: "dedicated-thread",
      checkpointRef: "checkpoint-1",
      idempotencyKey: `resume-${current.name}`,
      guard: dedicatedGuard("dedicated-task")
    });
    assert.equal(receipt.ok, false, current.name);
    assert.equal(receipt.fault?.code, current.code, current.name);
    await transport.shutdown();
    assert.equal(child.closed, true);
  }
});

test("concurrent responses correlate by exact numeric id, not arrival order", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
  });
  const first = transport.request("thread/list", {});
  const second = transport.request("account/rateLimits/read", {});
  child.raw({ jsonrpc: "2.0", id: 3, result: { marker: "second" } });
  child.raw({ jsonrpc: "2.0", id: 2, result: { marker: "first" } });
  const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
  assert.equal(firstReceipt.ok, true);
  assert.equal(firstReceipt.requestId, 2);
  assert.equal((firstReceipt.result as { marker?: string }).marker, "first");
  assert.equal(secondReceipt.ok, true);
  assert.equal(secondReceipt.requestId, 3);
  assert.equal((secondReceipt.result as { marker?: string }).marker, "second");
  await transport.shutdown();
});

test("missing, string-typed, cross-method, and duplicate response IDs fail closed for all pending requests", async () => {
  const missing = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
  });
  const missingRequest = missing.transport.request("thread/list", {});
  missing.child.raw({ jsonrpc: "2.0", result: { marker: "no-id" } });
  const missingReceipt = await missingRequest;
  assert.equal(missingReceipt.error?.code, "RESPONSE_ID_INVALID");
  assert.equal(missing.transport.lifecycle, "reconcile_required");
  await missing.transport.shutdown();

  const stringId = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
  });
  const stringRequest = stringId.transport.request("thread/list", {});
  stringId.child.raw({ jsonrpc: "2.0", id: "2", result: { marker: "string-id" } });
  const stringReceipt = await stringRequest;
  assert.equal(stringReceipt.error?.code, "RESPONSE_ID_INVALID");
  await stringId.transport.shutdown();

  const crossed = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
  });
  const crossedFirst = crossed.transport.request("thread/list", {});
  const crossedSecond = crossed.transport.request("account/rateLimits/read", {});
  crossed.child.raw({ jsonrpc: "2.0", id: 3, method: "thread/list", result: { marker: "crossed" } });
  const [crossedFirstReceipt, crossedSecondReceipt] = await Promise.all([crossedFirst, crossedSecond]);
  assert.equal(crossedFirstReceipt.error?.code, "RESPONSE_ID_MISMATCH");
  assert.equal(crossedSecondReceipt.error?.code, "RESPONSE_ID_MISMATCH");
  await crossed.transport.shutdown();

  const duplicate = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
  });
  const completed = duplicate.transport.request("thread/list", {});
  duplicate.child.raw({ jsonrpc: "2.0", id: 2, result: { marker: "first" } });
  assert.equal((await completed).ok, true);
  const stillPending = duplicate.transport.request("account/rateLimits/read", {});
  duplicate.child.raw({ jsonrpc: "2.0", id: 2, result: { marker: "duplicate" } });
  assert.equal((await stillPending).error?.code, "DUPLICATE_RESPONSE_ID");
  await duplicate.transport.shutdown();
});

test("loaded/active scope follows three pages and only becomes known at a terminal null cursor", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/loaded/list") {
      const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
      const cursor = typeof params.cursor === "string" ? params.cursor : null;
      if (cursor === null) fixtureChild.reply(request.id, { scope: "loaded_active", data: [{ id: "loaded-1" }], nextCursor: "loaded-cursor-2" });
      else if (cursor === "loaded-cursor-2") fixtureChild.reply(request.id, { scope: "loaded_active", data: [{ id: "loaded-2" }], nextCursor: "loaded-cursor-3" });
      else fixtureChild.reply(request.id, { scope: "loaded_active", data: [{ id: "loaded-3" }], nextCursor: null });
    }
  });
  const probe = await transport.probeLoadedActiveScope();
  assert.equal(probe.ok, true);
  assert.equal(probe.known, true);
  assert.equal(probe.scope, "loaded_active");
  assert.equal(probe.pages, 3);
  assert.deepEqual(probe.threads.map((thread) => thread.threadId), ["loaded-1", "loaded-2", "loaded-3"]);
  assert.equal(child.requests.filter((request) => request.method === "thread/loaded/list").length, 3);
});

test("loaded/active pagination cursor loop fails closed", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/active/list") fixtureChild.reply(request.id, {
      scope: "active",
      data: [{ id: `active-${request.id}` }],
      nextCursor: "same-active-cursor"
    });
  });
  const probe = await transport.probeLoadedActiveScope("thread/active/list");
  assert.equal(probe.ok, false);
  assert.equal(probe.known, false);
  assert.equal(probe.scope, "unknown");
  assert.equal(probe.fault?.code, "CURSOR_LOOP");
  assert.equal(probe.pages, 2);
  assert.equal(child.requests.filter((request) => request.method === "thread/active/list").length, 2);
});

test("loaded/active pagination duplicate across pages fails closed", async () => {
  const { transport } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/loaded/list") {
      const hasCursor = typeof request.params === "object" && request.params !== null && typeof (request.params as Record<string, unknown>).cursor === "string";
      fixtureChild.reply(request.id, {
        scope: "loaded_active",
        data: [{ id: "same-loaded-thread" }],
        nextCursor: hasCursor ? null : "loaded-next"
      });
    }
  });
  const probe = await transport.probeLoadedActiveScope();
  assert.equal(probe.ok, false);
  assert.equal(probe.known, false);
  assert.equal(probe.scope, "unknown");
  assert.equal(probe.fault?.code, "DUPLICATE_THREAD_ID");
  assert.equal(probe.threads.length, 1);
});

test("loaded/active pagination scope marker changes fail closed", async () => {
  const { transport } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/loaded/list") {
      const hasCursor = typeof request.params === "object" && request.params !== null && typeof (request.params as Record<string, unknown>).cursor === "string";
      fixtureChild.reply(request.id, {
        scope: hasCursor ? "active" : "loaded_active",
        data: [{ id: hasCursor ? "active-thread" : "loaded-thread" }],
        nextCursor: hasCursor ? null : "marker-next"
      });
    }
  });
  const probe = await transport.probeLoadedActiveScope();
  assert.equal(probe.ok, false);
  assert.equal(probe.known, false);
  assert.equal(probe.scope, "unknown");
  assert.equal(probe.fault?.code, "SCOPE_MARKER_CHANGED");
});

test("incomplete non-terminal loaded/active page fails closed", async () => {
  const { transport } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/active/list") fixtureChild.reply(request.id, { scope: "active", data: [], nextCursor: "active-next" });
  });
  const probe = await transport.probeLoadedActiveScope("thread/active/list");
  assert.equal(probe.ok, false);
  assert.equal(probe.known, false);
  assert.equal(probe.fault?.code, "DRAIN_SCOPE_UNKNOWN");
});

// ---- read-only registry enumeration for the externally visible tool (contract 4B) ----

function toolPageRequestData(request: AppServerRpcRequest): { hasCursor: boolean; cursor: string | null } {
  const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
  const cursor = typeof params.cursor === "string" ? params.cursor : null;
  return { hasCursor: cursor !== null, cursor };
}

function toolThread(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, status: "notLoaded", source: "subAgent", ...extra };
}

test("registry tool enumeration completes with per-page metadata and only thread/list RPCs", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { cursor } = toolPageRequestData(request);
      fixtureChild.reply(request.id, { data: [toolThread(cursor === null ? "a" : "b")], nextCursor: cursor === null ? "cursor-b" : null });
    }
  });
  const result = await transport.listRegistryThreadsForTool();
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.scope, "registry");
  assert.deepEqual(result.actualRpcMethodsObserved, ["thread/list"]);
  assert.equal(result.threads.length, 2);
  assert.deepEqual(result.threads.map((thread) => thread.threadId), ["a", "b"]);
  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.pages[0], { index: 1, inputCursor: null, outputCursor: "cursor-b", itemCount: 1 });
  assert.deepEqual(result.pages[1], { index: 2, inputCursor: "cursor-b", outputCursor: null, itemCount: 1 });
  assert.deepEqual(result.cursors, ["cursor-b"]);
  assert.deepEqual(result.duplicateThreadIds, []);
  assert.deepEqual(result.conflictingThreadIds, []);
  assert.equal(result.fault, null);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 2);
  assert.equal(child.requests.filter((request) => request.id !== undefined).every((request) => request.method === "initialize" || request.method === "thread/list"), true);
});

test("registry tool enumeration accepts limit and pageLimit options", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { cursor } = toolPageRequestData(request);
      fixtureChild.reply(request.id, {
        data: [toolThread(cursor === null ? "thread-1" : "thread-2"), toolThread("extra-per-page")],
        nextCursor: cursor === null ? "cursor-2" : null
      });
    }
  });
  // One page already supplies two items, exceeding the bound, so the walk
  // cannot claim server-side completion; it fails closed with an explicit
  // item-limit stop (complete stays false rather than lying about the tail).
  const limited = await transport.listRegistryThreadsForTool({ limit: 1 });
  assert.equal(limited.ok, false);
  assert.equal(limited.complete, false);
  assert.equal(limited.fault?.code, "CURSOR_LOOP");
  assert.equal(limited.threads.length, 2);
  assert.deepEqual(limited.threads.map((thread) => thread.threadId), ["thread-1", "extra-per-page"]);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 1);

  const { transport: pageLimitedTransport, child: pageLimitedChild } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { cursor } = toolPageRequestData(request);
      const page = cursor === null ? 1 : Number(cursor.replace("c", ""));
      fixtureChild.reply(request.id, { data: [toolThread(`thread-${page}`)], nextCursor: `c${page + 1}` });
    }
  });
  const pageLimited = await pageLimitedTransport.listRegistryThreadsForTool({ pageLimit: 3 });
  assert.equal(pageLimited.ok, false);
  assert.equal(pageLimited.complete, false);
  assert.equal(pageLimited.fault?.code, "CURSOR_LOOP");
  assert.equal(pageLimited.pages.length, 3);
  assert.equal(pageLimited.threads.length, 3);
  assert.equal(pageLimitedChild.requests.filter((request) => request.method === "thread/list").length, 3);
});

test("registry tool enumeration fails when the RPC itself fails", async () => {
  const { transport } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") fixtureChild.error(request.id, "INTERNAL_ERROR", "boom");
  });
  const result = await transport.listRegistryThreadsForTool();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fault?.code, "INTERNAL_ERROR");
  assert.equal(result.fault?.operation, "thread/list");
  assert.equal(result.fault?.requestId, 2);
  assert.equal(result.pages.length, 0);
  assert.deepEqual(result.actualRpcMethodsObserved, ["thread/list"]);
});

test("registry tool enumeration returns a shape fault when the RPC result is missing", async () => {
  const { transport } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") fixtureChild.reply(request.id, { nextCursor: null });
  });
  const result = await transport.listRegistryThreadsForTool();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fault?.code, "APP_SERVER_LIST_SHAPE_INVALID");
  assert.equal(result.pages.length, 0);
});

test("registry tool enumeration fails closed on a repeated cursor", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") fixtureChild.reply(request.id, { data: [toolThread(`thread-${request.id}`)], nextCursor: "same-cursor" });
  });
  const result = await transport.listRegistryThreadsForTool();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fault?.code, "CURSOR_LOOP");
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 2);
  assert.equal(result.pages.length, 2);
});

test("registry tool enumeration merges identical cross-page repeats and fails on conflicts", async () => {
  const identical = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { hasCursor } = toolPageRequestData(request);
      fixtureChild.reply(request.id, {
        data: [{ id: "shared-thread", status: "notLoaded" }, ...(hasCursor ? [toolThread("second-thread")] : [])],
        nextCursor: hasCursor ? null : "cursor-2"
      });
    }
  });
  const merged = await identical.transport.listRegistryThreadsForTool();
  assert.equal(merged.ok, true);
  assert.equal(merged.complete, true);
  // An identical cross-page repeat is merged: the record appears once (page 2
  // adds only second-thread) and is reported as a duplicate.
  assert.equal(merged.threads.length, 2);
  assert.deepEqual(merged.threads.map((thread) => thread.threadId), ["shared-thread", "second-thread"]);
  assert.deepEqual(merged.duplicateThreadIds, ["shared-thread"]);
  assert.deepEqual(merged.conflictingThreadIds, []);
  assert.equal(merged.threads[0]?.status, "notLoaded");
  assert.equal(merged.pages.length, 2);
  assert.deepEqual(merged.pages[0], { index: 1, inputCursor: null, outputCursor: "cursor-2", itemCount: 1 });
  // Page 2 carries two records: the repeated shared-thread and new second-thread.
  assert.deepEqual(merged.pages[1], { index: 2, inputCursor: "cursor-2", outputCursor: null, itemCount: 2 });
  await identical.transport.shutdown();

  const conflicting = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { hasCursor } = toolPageRequestData(request);
      fixtureChild.reply(request.id, {
        data: [toolThread("shared-thread", { status: hasCursor ? "loaded" : "notLoaded" })],
        nextCursor: hasCursor ? null : "cursor-2"
      });
    }
  });
  const failed = await conflicting.transport.listRegistryThreadsForTool();
  assert.equal(failed.ok, false);
  assert.equal(failed.complete, false);
  // The fault message names the conflicting thread id even though the fault
  // object itself carries no payload fields.
  assert.equal(failed.fault?.code, "CONFLICTING_THREAD_RECORD");
  assert.equal(failed.fault?.message.includes("shared-thread"), true);
  assert.equal(failed.threads.length, 1);
  await conflicting.transport.shutdown();
});

test("registry tool enumeration stops at the MAX_TOOL_PAGES cap", async () => {
  const { transport, child } = await initializedTransport((request, fixtureChild) => {
    if (request.method === "initialize") fixtureChild.reply(request.id, initializeResult());
    if (request.method === "thread/list") {
      const { cursor } = toolPageRequestData(request);
      const page = cursor === null ? 1 : Number(cursor.replace("c", ""));
      fixtureChild.reply(request.id, { data: [toolThread(`thread-${page}`)], nextCursor: `c${page + 1}` });
    }
  });
  const result = await transport.listRegistryThreadsForTool();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fault?.code, "CURSOR_LOOP");
  assert.equal(result.pages.length, 100);
  assert.equal(result.threads.length, 100);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 100);
  assert.equal(child.requests.filter((request) => request.id !== undefined).every((request) => request.method === "initialize" || request.method === "thread/list"), true);
});
