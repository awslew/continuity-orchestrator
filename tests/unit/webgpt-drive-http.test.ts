import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryWebgptDriveHttpStore,
  WebgptDriveHttpTransport,
  type WebgptDriveFetch
} from "../../src/adapters/webgpt-drive-http.js";

type FakeResponse = {
  status?: number;
  ok?: boolean;
  body?: unknown;
};

type Call = { url: string; init: RequestInit | undefined };

function queuedFetch(items: FakeResponse[]): { fetch: WebgptDriveFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: WebgptDriveFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const item = items.shift();
    if (!item) throw new Error("unexpected_fetch");
    const status = item.status ?? 200;
    return {
      ok: item.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => item.body === undefined ? "" : JSON.stringify(item.body)
    };
  };
  return { fetch, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body || "{}")) as Record<string, unknown>;
}

function transport(
  fetch: WebgptDriveFetch,
  store = new MemoryWebgptDriveHttpStore(),
  overrides: Partial<{ timeoutMs: number; now: () => string }> = {}
): WebgptDriveHttpTransport {
  return new WebgptDriveHttpTransport({
    baseUrl: "http://127.0.0.1:4173",
    tabId: "tab-continuity-test",
    timeoutMs: overrides.timeoutMs ?? 1_000,
    key: "continuity-test",
    fetch,
    store,
    now: overrides.now ?? (() => "2026-09-05T00:00:00.000Z")
  });
}

test("configuration requires explicit baseUrl, tabId and bounded timeout", () => {
  assert.throws(() => new WebgptDriveHttpTransport({ baseUrl: "", tabId: "tab", timeoutMs: 1 }), /baseUrl/);
  assert.throws(() => new WebgptDriveHttpTransport({ baseUrl: "http://127.0.0.1:1", tabId: "", timeoutMs: 1 }), /tabId/);
  assert.throws(() => new WebgptDriveHttpTransport({ baseUrl: "http://127.0.0.1:1", tabId: "tab", timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => new WebgptDriveHttpTransport({ baseUrl: "file:///tmp/relay", tabId: "tab", timeoutMs: 1 }), /http/);
});

test("create/attach normalizes and persists web_chat_id from status", async () => {
  const { fetch, calls } = queuedFetch([
    {
      body: {
        ok: true,
        web_chat_id: "8d5f9a0a-1234-4a5e-8f33-0123456789ab",
        attachReceiptId: "attach-upstream-1",
        promptVisible: true
      }
    }
  ]);
  const store = new MemoryWebgptDriveHttpStore();
  const relay = transport(fetch, store);
  const attached = await relay.createOrAttachChat("task-1");
  assert.deepEqual(attached, {
    chatId: "8d5f9a0a-1234-4a5e-8f33-0123456789ab",
    attachReceiptId: "attach-upstream-1",
    pageState: "loaded"
  });
  assert.equal(store.getChatId?.("task-1"), attached.chatId);
  assert.match(calls[0]?.url ?? "", /tabId=tab-continuity-test/);
});

test("send forwards text/chunk/hash metadata, echoes operation id, and deduplicates replay", async () => {
  const { fetch, calls } = queuedFetch([
    {
      body: {
        ok: true,
        clientOperationId: "op-1",
        web_chat_id: "chat-1",
        result: {
          pageState: "loaded",
          upstreamMessageId: "msg-1",
          sendReceiptId: "send-1",
          completeReceiptId: "complete-1"
        }
      }
    }
  ]);
  const relay = transport(fetch);
  const payload = {
    message: "handoff text",
    chunks: [{ text: "handoff text", hash: "sha256:abc" }],
    hash: "sha256:abc",
    metadata: { source: "handoff", sequence: 4 }
  };
  const first = await relay.send("chat-1", "op-1", payload);
  const second = await relay.send("chat-1", "op-1", payload);
  assert.equal(calls.length, 1, "same clientOperationId must not dispatch twice in one transport store");
  assert.deepEqual(second, first);
  assert.equal(first.upstreamMessageId, "msg-1");
  assert.equal(first.sendReceiptId, "send-1");
  assert.equal(first.completeReceiptId, "complete-1");
  assert.equal(first.quota, "none");
  assert.equal(first.contractGap, undefined);
  assert.equal(bodyOf(calls[0]!).prompt, "handoff text");
  assert.deepEqual(bodyOf(calls[0]!).continuity, {
    hash: "sha256:abc",
    chunks: [{ text: "handoff text", hash: "sha256:abc" }],
    metadata: { source: "handoff", sequence: 4 }
  });
});

test("missing upstream message or completion identifiers is an explicit contract gap", async () => {
  const { fetch } = queuedFetch([
    { body: { ok: true, clientOperationId: "op-missing", web_chat_id: "chat-1", result: { pageState: "loaded", text: "reply" } } }
  ]);
  const relay = transport(fetch);
  const result = await relay.send("chat-1", "op-missing", { message: "x" });
  assert.equal(result.upstreamMessageId, null);
  assert.equal(result.sendReceiptId, null);
  assert.equal(result.completeReceiptId, null);
  assert.equal(result.contractGap, "missing_upstream_message_id");
  assert.equal(result.clientOperationId, "op-missing");
});

test("ordinary 429 and timeout are blocked/unknown and never quota exhausted", async () => {
  const ordinary = queuedFetch([{ status: 429, body: { error: "rate_limited" } }]);
  const ordinaryResult = await transport(ordinary.fetch).send("chat-1", "op-429", { message: "x" });
  assert.equal(ordinaryResult.quota, "unknown");
  assert.equal(ordinaryResult.quotaReceipt, null);
  assert.equal(ordinaryResult.contractGap, "http_error");

  const timeoutFetch: WebgptDriveFetch = async (_input, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      Object.assign(error, { name: "AbortError" });
      reject(error);
    }, { once: true });
  });
  const timeoutResult = await transport(timeoutFetch, new MemoryWebgptDriveHttpStore(), { timeoutMs: 5 }).send("chat-1", "op-timeout", { message: "x" });
  assert.equal(timeoutResult.quota, "unknown");
  assert.equal(timeoutResult.contractGap, "timeout");
  assert.equal(timeoutResult.quotaReceipt, null);
});

test("only explicit account-level quota receipt is classified account_limit", async () => {
  const { fetch } = queuedFetch([
    {
      status: 429,
      body: {
        error: "rate_limited",
        quotaReceipt: {
          scope: "account",
          code: "usage_limit_reached",
          model: "chatgpt-5.5",
          capturedAt: "2026-09-05T00:00:01.000Z",
          resetAt: "2026-09-05T01:00:00.000Z",
          receiptId: "quota-receipt-1"
        }
      }
    }
  ]);
  const result = await transport(fetch).send("chat-1", "op-quota", { message: "x" });
  assert.equal(result.quota, "account_limit");
  assert.equal(result.quotaReceipt?.scope, "account");
  assert.equal(result.quotaReceipt?.code, "usage_limit_reached");
  assert.equal(result.quotaReceipt?.model, "chatgpt-5.5");
  assert.equal(result.quotaReceipt?.externalReceiptId, "quota-receipt-1");
  assert.equal(result.contractGap, "http_error");
});

test("cursor and last message ids normalize, then input cursor is retained when upstream omits one", async () => {
  const { fetch, calls } = queuedFetch([
    { body: { ok: true, pageState: "loaded", cursor: "cursor-2", messages: [{ id: "msg-2" }], payloadRefs: ["receipt://msg-2"] } },
    { body: { ok: true, pageState: "loaded", messages: [{ message_id: "msg-3" }] } }
  ]);
  const store = new MemoryWebgptDriveHttpStore();
  const relay = transport(fetch, store);
  const first = await relay.read("chat-1", "cursor-1");
  assert.equal(first.cursor, "cursor-2");
  assert.equal(first.cursorSource, "upstream");
  assert.deepEqual(first.observedMessageIds, ["msg-2"]);
  assert.deepEqual(first.payloadRefs, ["receipt://msg-2"]);
  assert.equal(store.getCursor?.("chat-1"), "cursor-2");

  const second = await relay.read("chat-1", null);
  assert.equal(bodyOf(calls[1]!).cursor, "cursor-2", "stored cursor is sent on a null input cursor");
  assert.equal(second.cursor, "cursor-2");
  assert.equal(second.cursorSource, "input_echo");
  assert.equal(second.contractGap, "cursor_not_authoritative");
  assert.deepEqual(second.observedMessageIds, ["msg-3"]);
});

test("local path fields are rejected before any HTTP dispatch", async () => {
  const queued = queuedFetch([]);
  const relay = transport(queued.fetch);
  const blockedPayloads: Record<string, unknown>[] = [
    { message: "use the supplied handoff", attachments: ["D:\\work\\handoff.md"] },
    { message: "use the supplied handoff", directoryPath: "D:\\work" },
    { message: "use the supplied handoff", directory_path: "D:\\work" },
    { message: "use the supplied handoff", workdir: "D:\\work" },
    { message: "use the supplied handoff", cwd: "D:\\work" },
    { message: "use the supplied handoff", filePath: "D:\\work\\handoff.md" },
    { message: "use the supplied handoff", file_path: "D:\\work\\handoff.md" },
    { message: "use the supplied handoff", metadata: { nested: [{ directoryPath: "D:\\work" }] } }
  ];
  for (const [index, payload] of blockedPayloads.entries()) {
    const result = await relay.send("chat-1", `op-path-${index}`, payload);
    assert.equal(result.contractGap, "invalid_payload");
  }
  const ordinaryText = await relay.send("chat-1", "op-path-text-only", {
    message: "The handoff text mentions D:\\work\\handoff.md but carries no local path field."
  });
  assert.equal(ordinaryText.contractGap, "http_error", "plain text may mention a path because it is already supplied content");
  assert.equal(queued.calls.length, 1, "only the plain-text case reaches HTTP; structural path fields are rejected first");
});

test("unsupported stop endpoint response is fail-closed without a synthetic receipt", async () => {
  const { fetch } = queuedFetch([{ body: { ok: true, requested: true, clicked: true } }]);
  const result = await transport(fetch).stop("chat-1");
  assert.equal(result.stopReceiptId, null);
  assert.equal(result.pageState, "unknown");
  assert.equal(result.contractGap, "missing_stop_receipt_id");
});
