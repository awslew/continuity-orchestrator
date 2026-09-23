import assert from "node:assert/strict";
import test from "node:test";
import {
  MockWebgptDriveTransport,
  REAL_WEBGPT_DRIVE_CAPABILITIES,
  WebgptDriveAdapter,
  type WebgptDriveTransport
} from "../../src/adapters/webgpt-drive.js";

const fixedAt = "2026-09-03T00:00:00.000Z";

test("mock transport closed loop produces chat, message and read receipts", async () => {
  const adapter = new WebgptDriveAdapter(new MockWebgptDriveTransport());
  const session = await adapter.createOrAttach("task-1", fixedAt);
  assert.ok(session.ok && session.value);
  assert.match(session.value.webChatId, /^chat_mock_task-1_/);
  assert.match(session.value.attachReceiptId, /^attach_mock_/);
  assert.equal(adapter.sessionReceipt("task-1")?.webChatId, session.value.webChatId);

  const send = await adapter.send(session.value.webChatId, "idem-send-1", { message: "handoff bootstrap" }, fixedAt);
  assert.ok(send.ok && send.value);
  assert.match(send.value.upstreamMessageId ?? "", /^msg_mock_/);
  assert.match(send.value.sendReceiptId ?? "", /^send_mock_/);
  assert.match(send.value.completeReceiptId ?? "", /^complete_mock_/);
  assert.equal(send.value.blockedWaiting, false);

  const replay = await adapter.send(session.value.webChatId, "idem-send-1", { message: "handoff bootstrap" }, fixedAt);
  assert.equal(replay.value?.upstreamMessageId, send.value.upstreamMessageId, "same idempotency key returns the original receipt");

  const read = await adapter.read(session.value.webChatId, "cursor_mock_1", fixedAt);
  assert.ok(read.ok && read.value);
  assert.equal(read.value.cursor, "cursor_mock_1");
  assert.equal(read.value.blockedWaiting, false);
});

test("send without receipts is a blocked fault, never a success", async () => {
  const adapter = new WebgptDriveAdapter(new MockWebgptDriveTransport({ failReceipts: true }));
  const session = await adapter.createOrAttach("task-2", fixedAt);
  assert.ok(session.ok && session.value);
  const send = await adapter.send(session.value.webChatId, "idem-send-2", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CONTRACT_GAP");
  assert.equal(send.error?.status, "blocked");
  assert.equal(send.value, null);
  assert.equal(adapter.messageReceipt("idem-send-2"), null, "failed sends leave no receipt");
});

test("unknown or error page state marks the receipt BLOCKED_WAITING, not terminal", async () => {
  const adapter = new WebgptDriveAdapter(new MockWebgptDriveTransport({ pageState: "unknown" }));
  const session = await adapter.createOrAttach("task-3", fixedAt);
  assert.ok(session.ok && session.value);
  const send = await adapter.send(session.value.webChatId, "idem-send-3", { message: "x" }, fixedAt);
  assert.ok(send.ok && send.value);
  assert.equal(send.value.blockedWaiting, true);
  const read = await adapter.read(session.value.webChatId, null, fixedAt);
  assert.ok(read.ok && read.value);
  assert.equal(read.value.blockedWaiting, true);
});

test("the real transport is refused while the 4A capability matrix shows contract gaps", async () => {
  const realTransport: WebgptDriveTransport = {
    kind: "real",
    async createOrAttachChat() {
      return { chatId: "chat-real", attachReceiptId: "attach-real", pageState: "loaded" };
    },
    async send() {
      return {
        clientOperationId: "c1",
        upstreamMessageId: "m1",
        sendReceiptId: "s1",
        completeReceiptId: "c2",
        pageState: "loaded",
        quota: "none",
        observedChatId: "chat-real"
      };
    },
    async read() {
      return { cursor: "cur", pageState: "loaded", quota: "none", observedMessageIds: [], payloadRefs: [] };
    },
    async stop() {
      return { stopReceiptId: "stop", pageState: "loaded" };
    }
  };
  assert.deepEqual(REAL_WEBGPT_DRIVE_CAPABILITIES, {
    chatId: false,
    sendReceipt: false,
    cursor: false,
    quotaReceipt: false
  });
  const adapter = new WebgptDriveAdapter(realTransport);
  const session = await adapter.createOrAttach("task-4", fixedAt);
  assert.equal(session.ok, false, "create/attach is fail-closed without an evidenced chat id contract");
  assert.equal(session.error?.code, "WEB_CONTRACT_GAP");
  assert.equal(session.evidenceLevel, "UNKNOWN");

  // Even with a chat id, send stays fail-closed until receipts are evidenced.
  const lenient = new WebgptDriveAdapter(realTransport, { chatId: true, sendReceipt: false, cursor: false, quotaReceipt: false });
  const send = await lenient.send("chat-real", "idem-real-1", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CONTRACT_GAP");

  const withFullContract = new WebgptDriveAdapter(realTransport, { chatId: true, sendReceipt: true, cursor: true, quotaReceipt: true });
  const okSend = await withFullContract.send("chat-real", "idem-real-2", { message: "x" }, fixedAt);
  assert.equal(okSend.ok, true);
  assert.equal(okSend.evidenceLevel, "UNKNOWN", "real transport evidence is never marked MOCK_PASS");
});

test("send refuses to dispatch when the live chat id diverges from the mapped chat (ADR-0004 R-5)", async () => {
  const dispatched: string[] = [];
  const transport: WebgptDriveTransport = {
    kind: "mock",
    async createOrAttachChat() {
      return { chatId: "chat-a", attachReceiptId: "attach-a", pageState: "loaded" };
    },
    async resolveChatId(chatId) {
      return chatId === "chat-a" ? "chat-b" : chatId;
    },
    async send(chatId, clientOperationId) {
      dispatched.push(clientOperationId);
      return {
        clientOperationId,
        upstreamMessageId: "m1",
        sendReceiptId: "s1",
        completeReceiptId: "c1",
        pageState: "loaded",
        quota: "none",
        observedChatId: chatId
      };
    },
    async read() {
      return { cursor: null, pageState: "loaded", quota: "none", observedMessageIds: [], payloadRefs: [] };
    },
    async stop() {
      return { stopReceiptId: "stop", pageState: "loaded" };
    }
  };
  const adapter = new WebgptDriveAdapter(transport);
  const send = await adapter.send("chat-a", "idem-r5-before", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CHAT_ID_MISMATCH");
  assert.deepEqual(dispatched, [], "nothing may be dispatched against a diverged mapping");
  assert.equal(adapter.messageReceipt("idem-r5-before"), null, "a blocked verification leaves no receipt");
});

test("send refuses to dispatch when the live chat id cannot be resolved (ADR-0004 R-5 fail-closed)", async () => {
  const transport: WebgptDriveTransport = {
    kind: "mock",
    async createOrAttachChat() {
      return { chatId: "chat-a", attachReceiptId: "attach-a", pageState: "loaded" };
    },
    async resolveChatId() {
      return null;
    },
    async send(chatId, clientOperationId) {
      return {
        clientOperationId,
        upstreamMessageId: "m1",
        sendReceiptId: "s1",
        completeReceiptId: "c1",
        pageState: "loaded",
        quota: "none",
        observedChatId: chatId
      };
    },
    async read() {
      return { cursor: null, pageState: "loaded", quota: "none", observedMessageIds: [], payloadRefs: [] };
    },
    async stop() {
      return { stopReceiptId: "stop", pageState: "loaded" };
    }
  };
  const adapter = new WebgptDriveAdapter(transport);
  const send = await adapter.send("chat-a", "idem-r5-null", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CHAT_ID_MISMATCH");
  assert.equal(send.error?.details.phase, "before_send");
  assert.equal(send.error?.details.observedChatId, null);
});

test("a send response from a different chat is rejected and leaves no receipt (ADR-0004 R-5)", async () => {
  const transport: WebgptDriveTransport = {
    kind: "mock",
    async createOrAttachChat() {
      return { chatId: "chat-a", attachReceiptId: "attach-a", pageState: "loaded" };
    },
    async send(_chatId, clientOperationId) {
      return {
        clientOperationId,
        upstreamMessageId: "m1",
        sendReceiptId: "s1",
        completeReceiptId: "c1",
        pageState: "loaded",
        quota: "none",
        observedChatId: "chat-other"
      };
    },
    async read() {
      return { cursor: null, pageState: "loaded", quota: "none", observedMessageIds: [], payloadRefs: [] };
    },
    async stop() {
      return { stopReceiptId: "stop", pageState: "loaded" };
    }
  };
  const adapter = new WebgptDriveAdapter(transport);
  const send = await adapter.send("chat-a", "idem-r5-after", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CHAT_ID_MISMATCH");
  assert.equal(send.error?.details.phase, "after_send");
  assert.equal(adapter.messageReceipt("idem-r5-after"), null);
});

test("a send response without a verifiable web_chat_id is fail-closed (ADR-0004 R-5)", async () => {
  const transport: WebgptDriveTransport = {
    kind: "mock",
    async createOrAttachChat() {
      return { chatId: "chat-a", attachReceiptId: "attach-a", pageState: "loaded" };
    },
    async send(_chatId, clientOperationId) {
      return {
        clientOperationId,
        upstreamMessageId: "m1",
        sendReceiptId: "s1",
        completeReceiptId: "c1",
        pageState: "loaded",
        quota: "none",
        observedChatId: null
      };
    },
    async read() {
      return { cursor: null, pageState: "loaded", quota: "none", observedMessageIds: [], payloadRefs: [] };
    },
    async stop() {
      return { stopReceiptId: "stop", pageState: "loaded" };
    }
  };
  const adapter = new WebgptDriveAdapter(transport);
  const send = await adapter.send("chat-a", "idem-r5-unverified", { message: "x" }, fixedAt);
  assert.equal(send.ok, false);
  assert.equal(send.error?.code, "WEB_CHAT_ID_UNVERIFIED");
  assert.equal(adapter.messageReceipt("idem-r5-unverified"), null);
});

test("ordinary and account-level quota observations keep sends BLOCKED_WAITING, never terminal (ADR-0004 R-9)", async () => {
  const ordinary = new WebgptDriveAdapter(new MockWebgptDriveTransport({ quota: "ordinary_error" }));
  const ordinarySession = await ordinary.createOrAttach("task-r9-ordinary", fixedAt);
  assert.ok(ordinarySession.ok && ordinarySession.value);
  const ordinarySend = await ordinary.send(ordinarySession.value.webChatId, "idem-r9-ordinary", { message: "x" }, fixedAt);
  assert.ok(ordinarySend.ok && ordinarySend.value);
  assert.equal(ordinarySend.value.quota, "ordinary_error");
  assert.equal(ordinarySend.value.blockedWaiting, true);

  const accountLimit = new WebgptDriveAdapter(new MockWebgptDriveTransport({ quota: "account_limit" }));
  const limitSession = await accountLimit.createOrAttach("task-r9-limit", fixedAt);
  assert.ok(limitSession.ok && limitSession.value);
  const limitSend = await accountLimit.send(limitSession.value.webChatId, "idem-r9-limit", { message: "x" }, fixedAt);
  assert.ok(limitSend.ok && limitSend.value);
  assert.equal(limitSend.value.quota, "account_limit");
  assert.equal(limitSend.value.blockedWaiting, true);
});
