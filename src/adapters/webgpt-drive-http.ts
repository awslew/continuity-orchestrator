/**
 * HTTP transport for a locally running web-drive bridge.
 *
 * This module deliberately contains no default URL, token, tab, or browser
 * discovery.  A caller must inject an explicit base URL, tab id and timeout.
 * The transport only sends text/chunk/hash metadata that it was given; it
 * never reads a local path and never asks the web page to read one.
 *
 * The upstream HTTP API is not a receipt-complete continuity protocol yet.
 * Missing upstream identifiers therefore remain null and are annotated with
 * a local contract-gap marker.  In particular, clientOperationId is never
 * copied into an upstream message/complete receipt field.
 */

import type {
  TransportReadResult,
  TransportSendResult,
  WebPageState,
  WebQuotaObservation,
  WebgptDriveTransport
} from "./webgpt-drive.js";

const DEFAULT_MAX_PAYLOAD_CHARS = 200_000;
const MAX_OPERATION_ID_LENGTH = 256;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

type FetchResponse = Pick<Response, "ok" | "status" | "text">;
export type WebgptDriveFetch = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>;

export interface WebgptDriveHttpConfig {
  /** Explicit loopback/relay URL. There is intentionally no default. */
  baseUrl: string;
  /** Explicit bridge tab id. There is intentionally no default tab. */
  tabId: string;
  /** Per-request timeout. Must be explicit and bounded. */
  timeoutMs: number;
  /** Optional key accepted by the bridge for tab resolution. */
  key?: string;
  /** Local HTTP auth token, if the relay requires one. */
  token?: string;
  /** Injectable fetch for tests and a future supervised local relay. */
  fetch?: WebgptDriveFetch;
  /** Maximum structured text sent to the web relay. */
  maxPayloadChars?: number;
  /** Clock injection keeps receipt tests deterministic. */
  now?: () => string;
  /** Optional process-local persistence for task/chat, sends, and cursors. */
  store?: WebgptDriveHttpStore;
}

export interface WebgptDriveHttpStore {
  getChatId?(taskId: string): string | null;
  setChatId?(taskId: string, chatId: string): void;
  getSend?(idempotencyKey: string): HttpTransportSendResult | null;
  setSend?(idempotencyKey: string, result: HttpTransportSendResult): void;
  getCursor?(chatId: string): string | null;
  setCursor?(chatId: string, cursor: string): void;
}

/**
 * A local result extension.  The shared transport contract cannot yet carry
 * the reason a result is incomplete, so Wave C can use this narrow field when
 * it wires the adapter.  It is never a success signal and is not an upstream
 * receipt.
 */
export interface HttpTransportSendResult extends TransportSendResult {
  contractGap?:
    | "missing_upstream_message_id"
    | "missing_send_receipt_id"
    | "missing_complete_receipt_id"
    | "client_operation_echo_mismatch"
    | "web_chat_id_unverified"
    | "http_error"
    | "timeout"
    | "invalid_payload";
  /** Explicit account-level evidence only; never synthesized locally. */
  quotaReceipt?: WebQuotaReceipt | null;
  /** Where the normalized page state came from. */
  pageStateSource?: "upstream" | "status" | "http_success" | "unknown";
}

type HttpPageStateSource = "upstream" | "status" | "http_success" | "unknown";

export interface HttpTransportReadResult extends TransportReadResult {
  contractGap?: "cursor_not_authoritative" | "http_error" | "timeout" | "invalid_payload";
  cursorSource?: "upstream" | "input_echo" | "stored" | "missing";
  quotaReceipt?: WebQuotaReceipt | null;
}

export interface HttpTransportStopResult {
  stopReceiptId: string | null;
  pageState: WebPageState;
  contractGap?: "missing_stop_receipt_id" | "http_error" | "timeout" | "chat_id_unverified";
}

/** Evidence required before classifying a web response as account-limited. */
export interface WebQuotaReceipt {
  schemaVersion: "continuity.web-quota-receipt.v1";
  scope: "account";
  code: string;
  model: string;
  capturedAt: string;
  resetAt: string | null;
  externalReceiptId: string | null;
}

export interface WebgptDriveHttpStatus {
  webChatId: string | null;
  pageState: WebPageState;
  quota: WebQuotaObservation;
  quotaReceipt: WebQuotaReceipt | null;
  status: number;
  ok: boolean;
  body: Record<string, unknown> | null;
}

interface JsonResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown> | null;
  raw: string;
  timedOut: boolean;
}

interface MemoryState {
  chats: Map<string, string>;
  sends: Map<string, HttpTransportSendResult>;
  cursors: Map<string, string>;
}

/** Useful for callers that want to persist state without taking a filesystem dependency. */
export class MemoryWebgptDriveHttpStore implements WebgptDriveHttpStore {
  private readonly state: MemoryState = {
    chats: new Map(),
    sends: new Map(),
    cursors: new Map()
  };

  getChatId(taskId: string): string | null {
    return this.state.chats.get(taskId) ?? null;
  }

  setChatId(taskId: string, chatId: string): void {
    this.state.chats.set(taskId, chatId);
  }

  getSend(idempotencyKey: string): HttpTransportSendResult | null {
    const value = this.state.sends.get(idempotencyKey);
    return value ? cloneSend(value) : null;
  }

  setSend(idempotencyKey: string, result: HttpTransportSendResult): void {
    this.state.sends.set(idempotencyKey, cloneSend(result));
  }

  getCursor(chatId: string): string | null {
    return this.state.cursors.get(chatId) ?? null;
  }

  setCursor(chatId: string, cursor: string): void {
    this.state.cursors.set(chatId, cursor);
  }
}

function cloneSend(result: HttpTransportSendResult): HttpTransportSendResult {
  const clone: HttpTransportSendResult = {
    ...result,
    ...(result.quotaReceipt === undefined
      ? {}
      : { quotaReceipt: result.quotaReceipt ? { ...result.quotaReceipt } : null })
  };
  return clone;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedRecords(body: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!body) return [];
  const result: Record<string, unknown>[] = [body];
  for (const key of ["result", "data", "payload", "response", "status", "meta", "receipt", "messageReceipt", "message_receipt", "completion"]) {
    const nested = asRecord(body[key]);
    if (nested) result.push(nested);
  }
  return result;
}

function firstString(body: Record<string, unknown> | null, keys: readonly string[]): string | null {
  for (const record of nestedRecords(body)) {
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function firstBoolean(body: Record<string, unknown> | null, keys: readonly string[]): boolean | null {
  for (const record of nestedRecords(body)) {
    for (const key of keys) {
      if (typeof record[key] === "boolean") return record[key] as boolean;
    }
  }
  return null;
}

function validIso(value: unknown): string | null {
  const stringValue = nonEmptyString(value);
  if (!stringValue || !Number.isFinite(Date.parse(stringValue))) return null;
  return new Date(stringValue).toISOString();
}

function parsePositiveTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("baseUrl is required and must be explicit");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function isPathKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (new Set([
    "path",
    "paths",
    "filepath",
    "filepaths",
    "localpath",
    "localpaths",
    "directorypath",
    "directorypaths",
    "workdir",
    "workingdir",
    "cwd",
    "attachment",
    "attachments",
    "root",
    "directory",
    "directories",
    "filename",
    "filenames",
    "file",
    "files"
  ]).has(normalized)) return true;
  // Structural keys such as sourcePath/source_path are paths even when the
  // caller chooses a spelling that is not in the fixed list above.
  return normalized.endsWith("path") || normalized.endsWith("paths");
}

/** Reject structural local-path inputs; message text itself remains opaque text. */
function assertNoLocalPathFields(value: unknown, parentKey = "payload"): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoLocalPathFields(item, parentKey);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (isPathKey(key)) {
      throw new Error(`local path field is not accepted: ${parentKey}.${key}`);
    }
    assertNoLocalPathFields(child, `${parentKey}.${key}`);
  }
}

interface NormalizedChunk {
  text: string;
  hash?: string;
  id?: string;
}

function normalizeChunks(value: unknown): NormalizedChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: NormalizedChunk[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      chunks.push({ text: item });
      continue;
    }
    const record = asRecord(item);
    const text = nonEmptyString(record?.text);
    if (text) {
      const chunk: NormalizedChunk = { text };
      const hash = nonEmptyString(record?.hash) ?? nonEmptyString(record?.contentHash) ?? nonEmptyString(record?.content_hash);
      const id = nonEmptyString(record?.id);
      if (hash) chunk.hash = hash;
      if (id) chunk.id = id;
      chunks.push(chunk);
    }
  }
  return chunks;
}

function buildPrompt(payload: Record<string, unknown>, maxChars: number): { prompt: string; continuity: Record<string, unknown> } {
  assertNoLocalPathFields(payload);
  const direct = nonEmptyString(payload.message) ?? nonEmptyString(payload.text);
  const chunks = normalizeChunks(payload.chunks);
  const prompt = direct ?? (chunks.length ? chunks.map((chunk) => chunk.text).join("\n") : null);
  if (!prompt) throw new Error("structured payload must contain message, text, or non-empty chunks");
  if (prompt.length > maxChars) throw new Error(`structured payload exceeds ${maxChars} characters`);

  const continuity: Record<string, unknown> = {};
  const hash = nonEmptyString(payload.hash) ?? nonEmptyString(payload.contentHash);
  if (hash) continuity.hash = hash;
  if (chunks.length) continuity.chunks = chunks.map((chunk) => ({ ...chunk }));
  const metadata = asRecord(payload.metadata);
  if (metadata) {
    assertNoLocalPathFields(metadata, "payload.metadata");
    continuity.metadata = { ...metadata };
  }
  const taskId = nonEmptyString(payload.taskId) ?? nonEmptyString(payload.task_id);
  if (taskId) continuity.taskId = taskId;
  return { prompt, continuity };
}

function webChatIdFrom(body: Record<string, unknown> | null): string | null {
  const explicit = firstString(body, ["web_chat_id", "webChatId"]);
  if (explicit) return explicit;
  const url = firstString(body, ["url", "pageUrl", "page_url"]);
  const match = url?.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return match?.[1] ?? null;
}

function normalizePageState(body: Record<string, unknown> | null): { state: WebPageState; source: HttpPageStateSource } {
  const raw = firstString(body, ["pageState", "page_state", "state"]);
  if (raw) {
    const normalized = raw.toLowerCase();
    if (["loaded", "ready", "idle", "ok"].includes(normalized)) return { state: "loaded", source: "upstream" };
    if (["loading", "busy", "generating"].includes(normalized)) return { state: "loading", source: "upstream" };
    if (["error", "blocked", "challenge"].includes(normalized)) return { state: "error", source: "upstream" };
    if (["unknown", "unavailable"].includes(normalized)) return { state: "unknown", source: "upstream" };
  }
  const blocked = firstBoolean(body, ["blocked", "challenge", "requiresChallenge"]);
  if (blocked === true) return { state: "error", source: "status" };
  const promptVisible = firstBoolean(body, ["promptVisible", "prompt_visible"]);
  if (promptVisible === true) return { state: "loaded", source: "status" };
  // The bridge's current /query and /read-page envelopes carry `ok:true` but
  // do not expose a dedicated pageState field.  A successful HTTP operation
  // is enough to describe the relay request as loaded, while receipt/cursor
  // gaps remain independently fail-closed below.
  const ok = firstBoolean(body, ["ok"]);
  if (ok === true) return { state: "loaded", source: "http_success" };
  return { state: "unknown", source: "unknown" };
}

function explicitQuotaReceipt(body: Record<string, unknown> | null, now: string): WebQuotaReceipt | null {
  if (!body) return null;
  const candidates: Record<string, unknown>[] = [];
  const pushRecord = (value: unknown) => {
    const record = asRecord(value);
    if (record) candidates.push(record);
  };
  pushRecord(body.quota);
  pushRecord(body.quotaReceipt);
  pushRecord(body.quota_receipt);
  for (const record of nestedRecords(body)) {
    pushRecord(record.quota);
    pushRecord(record.quotaReceipt);
    pushRecord(record.quota_receipt);
  }

  for (const candidate of candidates) {
    const scope = nonEmptyString(candidate.scope)?.toLowerCase();
    const accountLevel = candidate.accountLevel === true || candidate.account_level === true;
    if (scope !== "account" && !accountLevel) continue;
    const code = nonEmptyString(candidate.code) ?? nonEmptyString(candidate.errorCode) ?? nonEmptyString(candidate.error_code);
    const model = nonEmptyString(candidate.model);
    const capturedAt = validIso(candidate.capturedAt) ?? validIso(candidate.captured_at) ?? validIso(now);
    if (!code || !model || !capturedAt) continue;
    return {
      schemaVersion: "continuity.web-quota-receipt.v1",
      scope: "account",
      code,
      model,
      capturedAt,
      resetAt: validIso(candidate.resetAt) ?? validIso(candidate.reset_at),
      externalReceiptId: nonEmptyString(candidate.receiptId) ?? nonEmptyString(candidate.receipt_id) ?? null
    };
  }
  return null;
}

function quotaFor(body: Record<string, unknown> | null, status: number, now: string): { quota: WebQuotaObservation; receipt: WebQuotaReceipt | null } {
  const receipt = explicitQuotaReceipt(body, now);
  if (receipt) return { quota: "account_limit", receipt };
  // HTTP 429 alone does not establish account-level exhaustion (it can be a
  // relay throttle, transient upstream error, or a per-request failure).
  // Keep the quota verdict UNKNOWN until an explicit account receipt exists.
  if (status === 429) return { quota: "unknown", receipt: null };
  const explicit = firstString(body, ["quota", "quotaStatus", "quota_status"]);
  if (explicit?.toLowerCase() === "none") return { quota: "none", receipt: null };
  if (explicit && ["ordinary_error", "rate_limited", "timeout", "unknown"].includes(explicit.toLowerCase())) {
    return { quota: explicit.toLowerCase() === "ordinary_error" ? "ordinary_error" : "unknown", receipt: null };
  }
  return { quota: status >= 200 && status < 300 ? "none" : "unknown", receipt: null };
}

function resultRecord(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body) return null;
  return asRecord(body.result) ?? asRecord(body.data) ?? body;
}

function stringFromResult(body: Record<string, unknown> | null, keys: readonly string[]): string | null {
  const result = resultRecord(body);
  for (const record of [result, ...nestedRecords(body)]) {
    if (!record) continue;
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function arrayFromResult(body: Record<string, unknown> | null, keys: readonly string[]): unknown[] {
  const result = resultRecord(body);
  for (const record of [result, ...nestedRecords(body)]) {
    if (!record) continue;
    for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function messageIdsFrom(body: Record<string, unknown> | null): string[] {
  const values = arrayFromResult(body, ["observedMessageIds", "messageIds", "message_ids", "messages"]);
  const ids: string[] = [];
  for (const value of values) {
    const id = typeof value === "string" ? nonEmptyString(value) : nonEmptyString(asRecord(value)?.id) ?? nonEmptyString(asRecord(value)?.messageId) ?? nonEmptyString(asRecord(value)?.message_id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const last = stringFromResult(body, ["lastMessageId", "last_message_id"]);
  if (last && !ids.includes(last)) ids.push(last);
  return ids;
}

function cursorFrom(body: Record<string, unknown> | null): string | null {
  return stringFromResult(body, ["cursor", "nextCursor", "next_cursor", "lastCursor", "last_cursor", "readCursor", "read_cursor"]);
}

function payloadRefsFrom(body: Record<string, unknown> | null): string[] {
  return arrayFromResult(body, ["payloadRefs", "payload_refs"])
    .map((value) => nonEmptyString(value))
    .filter((value): value is string => value !== null);
}

function responseBody(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function fetchJson(
  fetchImpl: WebgptDriveFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<JsonResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    return { status: response.status, ok: response.ok, body: responseBody(raw), raw, timedOut: false };
  } catch (error) {
    if (!timedOut && (error as { name?: unknown })?.name === "AbortError") timedOut = true;
    return { status: 0, ok: false, body: null, raw: "", timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function safeFailure(
  clientOperationId: string,
  observedChatId: string | null,
  reason: HttpTransportSendResult["contractGap"],
  quota: WebQuotaObservation = "unknown",
  quotaReceipt: WebQuotaReceipt | null = null
): HttpTransportSendResult {
  const result: HttpTransportSendResult = {
    clientOperationId,
    upstreamMessageId: null,
    sendReceiptId: null,
    completeReceiptId: null,
    pageState: "unknown",
    quota,
    observedChatId,
    quotaReceipt,
    pageStateSource: "unknown"
  };
  if (reason) result.contractGap = reason;
  return result;
}

export class WebgptDriveHttpTransport implements WebgptDriveTransport {
  readonly kind = "real" as const;
  private readonly baseUrl: string;
  private readonly tabId: string;
  private readonly timeoutMs: number;
  private readonly key: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchImpl: WebgptDriveFetch;
  private readonly maxPayloadChars: number;
  private readonly now: () => string;
  private readonly store: WebgptDriveHttpStore;

  constructor(config: WebgptDriveHttpConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.tabId = nonEmptyString(config.tabId) ?? (() => { throw new Error("tabId is required and must be explicit"); })();
    this.timeoutMs = parsePositiveTimeout(config.timeoutMs);
    this.key = nonEmptyString(config.key) ?? undefined;
    this.token = nonEmptyString(config.token) ?? undefined;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxPayloadChars = config.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS;
    if (!Number.isInteger(this.maxPayloadChars) || this.maxPayloadChars <= 0) {
      throw new Error("maxPayloadChars must be a positive integer");
    }
    this.now = config.now ?? (() => new Date().toISOString());
    // Each transport gets an isolated default store.  Callers that need
    // restart/process persistence must inject a durable implementation.
    this.store = config.store ?? new MemoryWebgptDriveHttpStore();
  }

  private headers(): HeadersInit {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
    };
  }

  private statusUrl(): string {
    const query = new URLSearchParams({ tabId: this.tabId });
    if (this.key) query.set("key", this.key);
    return `${joinUrl(this.baseUrl, "/status")}?${query.toString()}`;
  }

  private commonBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { tabId: this.tabId, ...(this.key ? { key: this.key } : {}), ...extra };
  }

  async createOrAttachChat(taskId: string): Promise<{ chatId: string | null; attachReceiptId: string | null; pageState: WebPageState }> {
    const response = await fetchJson(this.fetchImpl, this.statusUrl(), { method: "GET", headers: this.headers() }, this.timeoutMs);
    const chatId = webChatIdFrom(response.body);
    const page = normalizePageState(response.body);
    const previous = this.store.getChatId?.(taskId) ?? null;
    if (!response.ok || response.timedOut || !chatId || (previous !== null && previous !== chatId)) {
      return { chatId: null, attachReceiptId: null, pageState: response.timedOut ? "unknown" : page.state };
    }
    // Only an upstream attach/status receipt is accepted.  A local timestamp
    // or task id is not a receipt and must not be synthesized here.
    const attachReceiptId = firstString(response.body, ["attachReceiptId", "attach_receipt_id", "receiptId", "receipt_id"]);
    // The chat id itself came from the live status response, so it is safe to
    // persist even when the upstream has not yet supplied an attach receipt.
    // The adapter still fail-closes the attach operation until that receipt
    // exists; persistence here avoids losing a verified mapping on retry.
    this.store.setChatId?.(taskId, chatId);
    if (!attachReceiptId) return { chatId, attachReceiptId: null, pageState: page.state };
    return { chatId, attachReceiptId, pageState: page.state };
  }

  /** Read the relay status without exposing its raw page text as executable data. */
  async status(): Promise<WebgptDriveHttpStatus> {
    const response = await fetchJson(this.fetchImpl, this.statusUrl(), { method: "GET", headers: this.headers() }, this.timeoutMs);
    const now = this.now();
    const quota = quotaFor(response.body, response.status, now);
    return {
      webChatId: webChatIdFrom(response.body),
      pageState: normalizePageState(response.body).state,
      quota: quota.quota,
      quotaReceipt: quota.receipt,
      status: response.status,
      ok: response.ok && !response.timedOut,
      body: response.body
    };
  }

  async resolveChatId(chatId: string): Promise<string | null> {
    const response = await fetchJson(this.fetchImpl, this.statusUrl(), { method: "GET", headers: this.headers() }, this.timeoutMs);
    if (!response.ok || response.timedOut) return null;
    const observed = webChatIdFrom(response.body);
    return observed === chatId ? observed : null;
  }

  async send(chatId: string, clientOperationId: string, structuredPayload: Record<string, unknown>): Promise<HttpTransportSendResult> {
    const cached = this.store.getSend?.(clientOperationId);
    if (cached) return cloneSend(cached);
    if (!nonEmptyString(chatId)) return safeFailure(clientOperationId, null, "web_chat_id_unverified");
    if (!nonEmptyString(clientOperationId) || clientOperationId.length > MAX_OPERATION_ID_LENGTH || /\s/.test(clientOperationId)) {
      return safeFailure(clientOperationId, chatId, "invalid_payload");
    }

    let built: { prompt: string; continuity: Record<string, unknown> };
    try {
      built = buildPrompt(structuredPayload, this.maxPayloadChars);
    } catch {
      return safeFailure(clientOperationId, chatId, "invalid_payload");
    }

    const response = await fetchJson(
      this.fetchImpl,
      joinUrl(this.baseUrl, "/query"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.commonBody({
          prompt: built.prompt,
          clientOperationId,
          timeoutMs: this.timeoutMs,
          continuity: built.continuity
        }))
      },
      this.timeoutMs
    );
    const now = this.now();
    const quota = quotaFor(response.body, response.status, now);
    const observedChatId = webChatIdFrom(response.body);
    if (response.timedOut) return safeFailure(clientOperationId, observedChatId, "timeout", quota.quota, quota.receipt);
    if (!response.ok) return safeFailure(clientOperationId, observedChatId, "http_error", quota.quota, quota.receipt);
    if (firstString(response.body, ["clientOperationId", "client_operation_id"]) !== clientOperationId) {
      return safeFailure(clientOperationId, observedChatId, "client_operation_echo_mismatch", quota.quota, quota.receipt);
    }

    const page = normalizePageState(response.body);
    const upstreamMessageId = stringFromResult(response.body, ["upstreamMessageId", "upstream_message_id", "messageId", "message_id", "userMessageId", "user_message_id"]);
    const sendReceiptId = stringFromResult(response.body, ["sendReceiptId", "send_receipt_id", "operationReceiptId", "operation_receipt_id"]);
    const completeReceiptId = stringFromResult(response.body, ["completeReceiptId", "complete_receipt_id", "completionReceiptId", "completion_receipt_id"]);
    let contractGap: HttpTransportSendResult["contractGap"];
    if (!upstreamMessageId) contractGap = "missing_upstream_message_id";
    else if (!sendReceiptId) contractGap = "missing_send_receipt_id";
    else if (!completeReceiptId) contractGap = "missing_complete_receipt_id";
    else if (observedChatId !== chatId) contractGap = "web_chat_id_unverified";

    const result: HttpTransportSendResult = {
      clientOperationId,
      upstreamMessageId,
      sendReceiptId,
      completeReceiptId,
      pageState: page.state,
      quota: quota.quota,
      observedChatId,
      ...(contractGap ? { contractGap } : {}),
      quotaReceipt: quota.receipt,
      pageStateSource: page.source
    };
    // Only complete, target-verified receipts may be replayed as idempotent
    // success.  Incomplete results are deliberately retried/reconciled.
    if (!contractGap) this.store.setSend?.(clientOperationId, result);
    return result;
  }

  /**
   * Explicit query alias for callers that distinguish query from the
   * interface's `send` name.  Both use the bridge's receipt-waiting `/query`
   * endpoint; the legacy `/send` endpoint only reports dispatch and cannot
   * prove completion.
   */
  async query(chatId: string, clientOperationId: string, structuredPayload: Record<string, unknown>): Promise<HttpTransportSendResult> {
    return this.send(chatId, clientOperationId, structuredPayload);
  }

  async read(chatId: string, cursor: string | null): Promise<HttpTransportReadResult> {
    const inputCursor = cursor ?? this.store.getCursor?.(chatId) ?? null;
    const response = await fetchJson(
      this.fetchImpl,
      joinUrl(this.baseUrl, "/read-page"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.commonBody({ web_chat_id: chatId, cursor: inputCursor }))
      },
      this.timeoutMs
    );
    const now = this.now();
    const quota = quotaFor(response.body, response.status, now);
    if (response.timedOut) {
      return { cursor: inputCursor, pageState: "unknown", quota: quota.quota, observedMessageIds: [], payloadRefs: [], contractGap: "timeout", cursorSource: inputCursor ? "input_echo" : "missing", quotaReceipt: quota.receipt };
    }
    if (!response.ok) {
      return { cursor: inputCursor, pageState: "unknown", quota: quota.quota, observedMessageIds: [], payloadRefs: [], contractGap: "http_error", cursorSource: inputCursor ? "input_echo" : "missing", quotaReceipt: quota.receipt };
    }
    const upstreamCursor = cursorFrom(response.body);
    const nextCursor = upstreamCursor ?? inputCursor;
    const page = normalizePageState(response.body);
    const result: HttpTransportReadResult = {
      cursor: nextCursor,
      pageState: page.state,
      quota: quota.quota,
      observedMessageIds: messageIdsFrom(response.body),
      payloadRefs: payloadRefsFrom(response.body),
      ...(upstreamCursor || !inputCursor ? {} : { contractGap: "cursor_not_authoritative" as const }),
      cursorSource: upstreamCursor ? "upstream" : inputCursor ? "input_echo" : "missing",
      quotaReceipt: quota.receipt
    };
    if (nextCursor) this.store.setCursor?.(chatId, nextCursor);
    return result;
  }

  async stop(chatId: string): Promise<HttpTransportStopResult> {
    const response = await fetchJson(
      this.fetchImpl,
      joinUrl(this.baseUrl, "/query/stop"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.commonBody({ web_chat_id: chatId }))
      },
      this.timeoutMs
    );
    if (response.timedOut) return { stopReceiptId: null, pageState: "unknown", contractGap: "timeout" };
    if (!response.ok) return { stopReceiptId: null, pageState: "unknown", contractGap: "http_error" };
    const page = normalizePageState(response.body);
    const stopReceiptId = firstString(response.body, ["stopReceiptId", "stop_receipt_id", "receiptId", "receipt_id"]);
    return stopReceiptId
      ? { stopReceiptId, pageState: page.state }
      : { stopReceiptId: null, pageState: "unknown", contractGap: "missing_stop_receipt_id" };
  }
}
