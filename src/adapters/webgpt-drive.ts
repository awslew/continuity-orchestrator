/**
 * WebgptDriveAdapter — automatic handoff closed-loop baseline (plan §8.3.4).
 *
 * The adapter is transport agnostic: a mock transport proves the contract
 * (G1), the real webgpt-drive transport stays fail-closed until the external
 * capability contract (message/operation receipts, authoritative cursor,
 * account-level quota receipt) is evidenced per plan 4C.  Missing receipts
 * never become success, and unknown page state becomes BLOCKED_WAITING, not
 * a terminal or a command execution.
 *
 * ADR-0004 decisions implemented here:
 *   R-5 — the persisted taskKey → web_chat_id mapping is verified before
 *         every send and against every send response; a mismatch (or an
 *         unverifiable target) is fail-closed and the chat is never switched.
 *   R-9 — any quota observation other than "none" keeps the task in
 *         BLOCKED_WAITING; only account-level evidence may ever be classified
 *         `account_limit`, and a terminal WEB_QUOTA_EXHAUSTED is never
 *         declared here (it belongs to an explicit user confirmation gate).
 */

import type { AdapterResult, StructuredAdapterError } from "./adapter-types.js";
import { structuredAdapterError } from "./adapter-types.js";

export const WEB_SESSION_RECEIPT_SCHEMA = "continuity.web-session-receipt.v1" as const;
export const WEB_MESSAGE_RECEIPT_SCHEMA = "continuity.web-message-receipt.v1" as const;
export const WEB_READ_RECEIPT_SCHEMA = "continuity.web-read-receipt.v1" as const;
export const WEB_STOP_RECEIPT_SCHEMA = "continuity.web-stop-receipt.v1" as const;

export type WebPageState = "loaded" | "loading" | "unknown" | "error";
export type WebQuotaObservation = "none" | "account_limit" | "ordinary_error" | "unknown";

export interface WebgptDriveCapabilities {
  /** Stable web chat identifier (`web_chat_id`) resolvable before send. */
  chatId: boolean;
  /** Per-send operation/message/complete receipts with real upstream IDs. */
  sendReceipt: boolean;
  /** Authoritative read cursor (local ledger seq/stateRevision mirrors it). */
  cursor: boolean;
  /** Account-level quota receipt (error code + model + capturedAt [+ resetAt]). */
  quotaReceipt: boolean;
}

/**
 * Capability matrix currently evidenced by plan 4A for the real webgpt-drive:
 * chat id is only a lead (`UNKNOWN` stability); receipts, cursor and quota
 * are ABSENT.  Until 4C evidence closes the gaps the real transport is refused.
 */
export const REAL_WEBGPT_DRIVE_CAPABILITIES: WebgptDriveCapabilities = {
  chatId: false,
  sendReceipt: false,
  cursor: false,
  quotaReceipt: false
};

export interface TransportSendResult {
  clientOperationId: string;
  upstreamMessageId: string | null;
  sendReceiptId: string | null;
  completeReceiptId: string | null;
  pageState: WebPageState;
  quota: WebQuotaObservation;
  /**
   * Live `web_chat_id` captured by the transport in the same response
   * (plan 4C category A exposure on /query /send /status).  `null` means
   * "looked and not resolvable" — it is fail-closed, never a wildcard that
   * matches the mapped chat (ADR-0004 R-5).
   */
  observedChatId: string | null;
}

export interface TransportReadResult {
  cursor: string | null;
  pageState: WebPageState;
  quota: WebQuotaObservation;
  observedMessageIds: string[];
  /** Structured, trusted payload refs; page text is never executed. */
  payloadRefs: string[];
}

export interface WebgptDriveTransport {
  kind: "mock" | "real";
  createOrAttachChat(taskId: string): Promise<{ chatId: string | null; attachReceiptId: string | null; pageState: WebPageState }>;
  send(chatId: string, clientOperationId: string, structuredPayload: Record<string, unknown>): Promise<TransportSendResult>;
  read(chatId: string, cursor: string | null): Promise<TransportReadResult>;
  stop(chatId: string): Promise<{ stopReceiptId: string | null; pageState: WebPageState; contractGap?: string }>;
  /**
   * ADR-0004 R-5 verify-before-send: resolve the LIVE web_chat_id the
   * transport would target right now.  When provided, send refuses to
   * dispatch unless the resolved id equals the mapped one; `null` is
   * fail-closed, never "proceed blind".
   */
  resolveChatId?(chatId: string): Promise<string | null>;
}

export interface WebSessionReceipt {
  schemaVersion: typeof WEB_SESSION_RECEIPT_SCHEMA;
  taskId: string;
  webChatId: string;
  attachReceiptId: string;
  pageState: WebPageState;
  createdAt: string;
}

export interface WebMessageReceipt {
  schemaVersion: typeof WEB_MESSAGE_RECEIPT_SCHEMA;
  chatId: string;
  clientOperationId: string;
  idempotencyKey: string;
  upstreamMessageId: string | null;
  sendReceiptId: string | null;
  completeReceiptId: string | null;
  pageState: WebPageState;
  quota: WebQuotaObservation;
  blockedWaiting: boolean;
  createdAt: string;
}

export interface WebReadReceipt {
  schemaVersion: typeof WEB_READ_RECEIPT_SCHEMA;
  chatId: string;
  cursor: string | null;
  pageState: WebPageState;
  quota: WebQuotaObservation;
  observedMessageIds: string[];
  payloadRefs: string[];
  blockedWaiting: boolean;
  createdAt: string;
}

export interface WebStopReceipt {
  schemaVersion: typeof WEB_STOP_RECEIPT_SCHEMA;
  chatId: string;
  stopReceiptId: string | null;
  pageState: WebPageState;
  createdAt: string;
}

const RECEIPT_REQUIRED: WebgptDriveCapabilities = {
  chatId: true,
  sendReceipt: true,
  cursor: true,
  quotaReceipt: true
};

function sendBlocked(reason: string, operation: string, code = "WEB_CONTRACT_GAP", details: Record<string, unknown> = {}): AdapterResult<never> {
  const error: StructuredAdapterError = structuredAdapterError(code, "blocked", reason, operation, details);
  return { ok: false, value: null, error, evidenceLevel: "UNKNOWN" };
}

/**
 * The closed handoff loop over webgpt-drive.  Every operation returns a
 * receipt or a structured blocked error; nothing infers success from page
 * text, and every real ID is preserved as received.
 */
export class WebgptDriveAdapter {
  private readonly sessions = new Map<string, WebSessionReceipt>();
  private readonly sends = new Map<string, WebMessageReceipt>();

  constructor(
    private readonly transport: WebgptDriveTransport,
    private readonly capabilities: WebgptDriveCapabilities = transport.kind === "mock"
      ? RECEIPT_REQUIRED
      : REAL_WEBGPT_DRIVE_CAPABILITIES
  ) {}

  sessionReceipt(taskId: string): WebSessionReceipt | null {
    const receipt = this.sessions.get(taskId);
    return receipt ? { ...receipt } : null;
  }

  messageReceipt(idempotencyKey: string): WebMessageReceipt | null {
    const receipt = this.sends.get(idempotencyKey);
    return receipt ? { ...receipt } : null;
  }

  async createOrAttach(taskId: string, at = new Date().toISOString()): Promise<AdapterResult<WebSessionReceipt>> {
    const operation = "webgpt.createOrAttach";
    if (this.transport.kind === "real" && !this.capabilities.chatId) {
      return sendBlocked("real webgpt-drive chat id contract is not evidenced yet (plan 4C)", operation);
    }
    const result = await this.transport.createOrAttachChat(taskId);
    if (!result.chatId || !result.attachReceiptId) {
      return sendBlocked("transport returned no chat id or attach receipt", operation);
    }
    const receipt: WebSessionReceipt = {
      schemaVersion: WEB_SESSION_RECEIPT_SCHEMA,
      taskId,
      webChatId: result.chatId,
      attachReceiptId: result.attachReceiptId,
      pageState: result.pageState,
      createdAt: at
    };
    this.sessions.set(taskId, receipt);
    return { ok: true, value: receipt, error: null, evidenceLevel: this.transport.kind === "mock" ? "MOCK_PASS" : "UNKNOWN" };
  }

  /**
   * Send one pre-generated structured payload.  A send without a real send
   * receipt is a blocked fault, never a success; unknown page state becomes
   * BLOCKED_WAITING via `blockedWaiting` and is not treated as terminal.
   * The taskKey → web_chat_id mapping is verified before dispatch and again
   * on the response (ADR-0004 R-5); a mismatch or an unverifiable target
   * leaves no receipt behind so a later retry re-verifies from scratch.
   */
  async send(
    chatId: string,
    idempotencyKey: string,
    structuredPayload: Record<string, unknown>,
    at = new Date().toISOString()
  ): Promise<AdapterResult<WebMessageReceipt>> {
    const operation = "webgpt.send";
    const replay = this.sends.get(idempotencyKey);
    if (replay) return { ok: true, value: { ...replay }, error: null, evidenceLevel: this.transport.kind === "mock" ? "MOCK_PASS" : "UNKNOWN" };
    if (this.transport.kind === "real" && !this.capabilities.sendReceipt) {
      return sendBlocked("real webgpt-drive send/complete receipt contract is not evidenced yet (plan 4C)", operation);
    }
    // ADR-0004 R-5: verify the mapped chat against the live target BEFORE
    // dispatching; never send blind and never silently switch chats.
    if (this.transport.resolveChatId) {
      const live = await this.transport.resolveChatId(chatId);
      if (live !== chatId) {
        return sendBlocked(
          live === null
            ? "web chat id could not be resolved before send; refusing to dispatch blind (ADR-0004 R-5)"
            : `web chat id mismatch before send: ledger targets ${chatId}, live target is ${live}`,
          operation,
          "WEB_CHAT_ID_MISMATCH",
          { mappedChatId: chatId, observedChatId: live, phase: "before_send" }
        );
      }
    }
    const clientOperationId = `wsend_${idempotencyKey}`;
    const result = await this.transport.send(chatId, clientOperationId, structuredPayload);
    if (!result.sendReceiptId || !result.completeReceiptId || !result.upstreamMessageId) {
      return sendBlocked("send completed without upstream message id or send/complete receipts", operation);
    }
    // ADR-0004 R-5: the response must confirm the message landed in the
    // mapped chat.  `null` is fail-closed, never a wildcard match.
    if (result.observedChatId !== chatId) {
      return sendBlocked(
        result.observedChatId === null
          ? "send response carried no verifiable web_chat_id (ADR-0004 R-5)"
          : `send landed in web chat ${result.observedChatId}, expected ${chatId}`,
        operation,
        result.observedChatId === null ? "WEB_CHAT_ID_UNVERIFIED" : "WEB_CHAT_ID_MISMATCH",
        { mappedChatId: chatId, observedChatId: result.observedChatId, phase: "after_send" }
      );
    }
    const receipt: WebMessageReceipt = {
      schemaVersion: WEB_MESSAGE_RECEIPT_SCHEMA,
      chatId,
      clientOperationId,
      idempotencyKey,
      upstreamMessageId: result.upstreamMessageId,
      sendReceiptId: result.sendReceiptId,
      completeReceiptId: result.completeReceiptId,
      pageState: result.pageState,
      quota: result.quota,
      // ADR-0004 R-9: only a loaded page AND a clean quota observation is a
      // green send; account limits, ordinary errors and unknown states all
      // keep the task in BLOCKED_WAITING.
      blockedWaiting: result.pageState !== "loaded" || result.quota !== "none",
      createdAt: at
    };
    this.sends.set(idempotencyKey, receipt);
    return { ok: true, value: receipt, error: null, evidenceLevel: this.transport.kind === "mock" ? "MOCK_PASS" : "UNKNOWN" };
  }

  async read(chatId: string, cursor: string | null, at = new Date().toISOString()): Promise<AdapterResult<WebReadReceipt>> {
    const operation = "webgpt.read";
    if (this.transport.kind === "real" && !this.capabilities.cursor) {
      return sendBlocked("real webgpt-drive cursor contract is not evidenced yet (plan 4C)", operation);
    }
    const result = await this.transport.read(chatId, cursor);
    const receipt: WebReadReceipt = {
      schemaVersion: WEB_READ_RECEIPT_SCHEMA,
      chatId,
      cursor: result.cursor,
      pageState: result.pageState,
      quota: result.quota,
      observedMessageIds: [...result.observedMessageIds],
      payloadRefs: [...result.payloadRefs],
      // ADR-0004 R-9: ordinary 429/timeout/challenge/UI-change observations
      // (quota != "none") and non-loaded pages are BLOCKED_WAITING, never a
      // terminal and never a quota verdict.
      blockedWaiting: result.pageState !== "loaded" || result.quota !== "none",
      createdAt: at
    };
    return { ok: true, value: receipt, error: null, evidenceLevel: this.transport.kind === "mock" ? "MOCK_PASS" : "UNKNOWN" };
  }

  async stop(chatId: string, at = new Date().toISOString()): Promise<AdapterResult<WebStopReceipt>> {
    const result = await this.transport.stop(chatId);
    // A stop acknowledgement without an upstream receipt is not evidence that
    // the web generation stopped.  Preserve the fail-closed contract even when
    // a concrete transport annotates the response with a contractGap field.
    if (!result.stopReceiptId || result.contractGap) {
      return sendBlocked(
        result.contractGap
          ? `web stop contract gap: ${result.contractGap}`
          : "web stop returned no stop receipt; refusing to report a successful stop",
        "webgpt.stop",
        result.contractGap ? "WEB_STOP_CONTRACT_GAP" : "WEB_STOP_RECEIPT_MISSING",
        { chatId, pageState: result.pageState, ...(result.contractGap ? { contractGap: result.contractGap } : {}) }
      );
    }
    const receipt: WebStopReceipt = {
      schemaVersion: WEB_STOP_RECEIPT_SCHEMA,
      chatId,
      stopReceiptId: result.stopReceiptId,
      pageState: result.pageState,
      createdAt: at
    };
    return { ok: true, value: receipt, error: null, evidenceLevel: this.transport.kind === "mock" ? "MOCK_PASS" : "UNKNOWN" };
  }
}

/** Deterministic in-memory transport used for mock contract evidence. */
export class MockWebgptDriveTransport implements WebgptDriveTransport {
  readonly kind = "mock" as const;
  private readonly chats = new Map<string, number>();
  private readonly lastSent = new Map<string, string>();
  private counter = 0;

  constructor(private readonly options: {
    failReceipts?: boolean;
    pageState?: WebPageState;
    quota?: WebQuotaObservation;
    /** Overrides the pre-send verify hook; return a different id to test the R-5 mismatch path. */
    resolveChatId?: (chatId: string) => string | null;
  } = {}) {}

  async createOrAttachChat(taskId: string): Promise<{ chatId: string | null; attachReceiptId: string | null; pageState: WebPageState }> {
    const index = (this.chats.get(taskId) ?? 0) + 1;
    this.chats.set(taskId, index);
    return {
      chatId: `chat_mock_${taskId}_${index}`,
      attachReceiptId: `attach_mock_${taskId}_${index}`,
      pageState: this.options.pageState ?? "loaded"
    };
  }

  async resolveChatId(chatId: string): Promise<string | null> {
    return this.options.resolveChatId ? this.options.resolveChatId(chatId) : chatId;
  }

  async send(chatId: string, clientOperationId: string): Promise<TransportSendResult> {
    if (this.options.failReceipts) {
      return {
        clientOperationId,
        upstreamMessageId: null,
        sendReceiptId: null,
        completeReceiptId: null,
        pageState: "unknown",
        quota: "unknown",
        observedChatId: null
      };
    }
    this.counter += 1;
    const messageId = `msg_mock_${this.counter}`;
    this.lastSent.set(chatId, messageId);
    return {
      clientOperationId,
      upstreamMessageId: messageId,
      sendReceiptId: `send_mock_${this.counter}`,
      completeReceiptId: `complete_mock_${this.counter}`,
      pageState: this.options.pageState ?? "loaded",
      quota: this.options.quota ?? "none",
      observedChatId: chatId
    };
  }

  async read(chatId: string, cursor: string | null): Promise<TransportReadResult> {
    this.counter += 1;
    const observed = this.lastSent.get(chatId);
    return {
      cursor: cursor ? `${cursor}` : `cursor_mock_${this.counter}`,
      pageState: this.options.pageState ?? "loaded",
      quota: "none",
      observedMessageIds: observed ? [observed] : [`msg_mock_${this.counter}`],
      payloadRefs: [`.ai-handoff/evidence/web-read-${this.counter}.json`]
    };
  }

  async stop(chatId: string): Promise<{ stopReceiptId: string | null; pageState: WebPageState }> {
    return { stopReceiptId: `stop_mock_${chatId}`, pageState: "loaded" };
  }
}
