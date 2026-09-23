import { sha256 } from "../domain/canonical.js";
import {
  normalizeRateLimitsRead,
  normalizeRateLimitsUpdated,
  type NormalizedQuotaSnapshot
} from "../quota/quota-normalizer.js";

export type AppServerMethod =
  | "account/rateLimits/read"
  | "account/rateLimits/updated"
  | "thread/list"
  | "turn/interrupt"
  | "thread/resume";

export interface AppServerRequestOptions {
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** Injected transport boundary. There is deliberately no URL/fetch/default transport. */
export interface AppServerTransport {
  request(method: AppServerMethod, params?: unknown, options?: AppServerRequestOptions): unknown | Promise<unknown>;
  capabilities?: Iterable<string>;
}

export type AdapterFaultStatus = "retryable" | "blocked" | "reconcile_required" | "unknown";

export interface AdapterFault {
  code: string;
  status: AdapterFaultStatus;
  message: string;
  operation: AppServerMethod;
  at: string;
  externalId?: string | null;
}

export interface AdapterOptions {
  /** Mock fixtures use fixture; real capability evidence remains unverified. */
  source?: "app-server" | "fixture";
  timeoutMs?: number;
}

export interface ThreadSummary {
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  repositoryId: string | null;
  status: "active";
}

export type ThreadListVisibility = "complete" | "unknown";

/** Array-compatible result: callers can iterate it, while metadata carries scope proof. */
export type VisibleThreadList = ThreadSummary[] & {
  threads: ThreadSummary[];
  visibility: ThreadListVisibility;
  visibilityKnown: boolean;
  scope: "all_visible_active" | "unknown";
  listHash: string;
  invalidThreadIndexes: number[];
  fault: AdapterFault | null;
};

interface ThreadListMetadata {
  visibility: ThreadListVisibility;
  visibilityKnown: boolean;
  scope: "all_visible_active" | "unknown";
  listHash: string;
  invalidThreadIndexes: number[];
  fault: AdapterFault | null;
}

export type InterruptStatus = "confirmed" | "timeout" | "unknown_in_flight" | "failed";

export interface InterruptReceipt {
  kind: "turn_interrupt";
  operation: "turn/interrupt";
  threadId: string;
  turnId: string;
  idempotencyKey: string;
  receiptId: string | null;
  status: InterruptStatus;
  confirmed: boolean;
  accepted: boolean;
  fault: AdapterFault | null;
}

export type ResumeStatus = "confirmed" | "timeout" | "unknown_in_flight" | "failed";

export interface ResumeReceipt {
  kind: "thread_resume";
  operation: "thread/resume";
  originalThreadId: string;
  resumedThreadId: string | null;
  newTurnId: string | null;
  checkpointRef: string;
  idempotencyKey: string;
  receiptId: string | null;
  status: ResumeStatus;
  confirmed: boolean;
  accepted: boolean;
  fault: AdapterFault | null;
  observedThreadId: string | null;
  observedOriginalThreadId: string | null;
  observedResumedThreadId: string | null;
}

export interface CapabilityProbe {
  source: "mock" | "injected";
  methods: Record<AppServerMethod, "present" | "absent" | "unverified">;
  realEvidence: "UNVERIFIED";
}

interface RecordValue {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function valueAt(record: RecordValue, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function operationError(operation: AppServerMethod, code: string, message: string, status: AdapterFaultStatus = "unknown", externalId: string | null = null): AdapterFault {
  return { code, status, message, operation, at: nowIso(), externalId };
}

function errorCode(error: unknown): string | null {
  if (error instanceof Error && error.name) return error.name;
  if (isRecord(error)) {
    const direct = valueAt(error, "code", "name");
    if (typeof direct === "string") return direct;
    if (isRecord(error.error)) {
      const nested = valueAt(error.error, "code", "name");
      if (typeof nested === "string") return nested;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function timeoutError(operation: AppServerMethod): AdapterFault {
  return operationError(operation, "APP_SERVER_TIMEOUT", `${operation} timed out`, "retryable");
}

function mapTransportFault(operation: AppServerMethod, error: unknown): AdapterFault {
  const code = errorCode(error)?.toUpperCase() ?? "APP_SERVER_REQUEST_FAILED";
  const message = errorMessage(error);
  if (code.includes("TIMEOUT") || code === "ETIMEDOUT") return timeoutError(operation);
  if (["IN_FLIGHT", "UNKNOWN_IN_FLIGHT", "REQUEST_LOST", "CONNECTION_CLOSED"].includes(code)) {
    return operationError(operation, "UNKNOWN_IN_FLIGHT", message, "reconcile_required");
  }
  if (["METHOD_NOT_FOUND", "CAPABILITY_UNAVAILABLE", "NOT_IMPLEMENTED"].includes(code)) {
    return operationError(operation, "CAPABILITY_UNAVAILABLE", message, "blocked");
  }
  return operationError(operation, code, message, "unknown");
}

function responseError(operation: AppServerMethod, response: unknown): AdapterFault | null {
  if (!isRecord(response) || !isRecord(response.error)) return null;
  const code = typeof response.error.code === "string" ? response.error.code : "APP_SERVER_ERROR";
  const message = typeof response.error.message === "string" ? response.error.message : "App Server returned an error";
  const upper = code.toUpperCase();
  if (upper.includes("TIMEOUT")) return timeoutError(operation);
  if (["IN_FLIGHT", "UNKNOWN_IN_FLIGHT", "REQUEST_LOST"].includes(upper)) return operationError(operation, "UNKNOWN_IN_FLIGHT", message, "reconcile_required");
  if (["METHOD_NOT_FOUND", "CAPABILITY_UNAVAILABLE", "NOT_IMPLEMENTED"].includes(upper)) return operationError(operation, "CAPABILITY_UNAVAILABLE", message, "blocked");
  return operationError(operation, code, message, "unknown");
}

function responsePayload(response: unknown): unknown {
  if (isRecord(response) && Object.prototype.hasOwnProperty.call(response, "result")) return response.result;
  return response;
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number, operation: AppServerMethod): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(operation)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function attachFault<T extends object>(value: T, fault: AdapterFault | null): T & { fault: AdapterFault | null } {
  Object.defineProperty(value, "fault", { value: fault, enumerable: false, configurable: true });
  return value as T & { fault: AdapterFault | null };
}

function unknownQuotaSnapshot(operation: "account/rateLimits/read" | "account/rateLimits/updated", fault: AdapterFault, source: "app-server" | "fixture"): NormalizedQuotaSnapshot {
  const snapshot = operation === "account/rateLimits/read"
    ? normalizeRateLimitsRead({ method: operation, result: {} }, { source })
    : normalizeRateLimitsUpdated({ method: operation, result: {} }, { source });
  snapshot.reason = fault.code;
  snapshot.errors = [...new Set([...snapshot.errors, fault.code])];
  return attachFault(snapshot, fault);
}

function listResponsePayload(response: unknown): { threads: unknown[] | null; visibilityKnown: boolean; visibility: ThreadListVisibility } {
  const payload = responsePayload(response);
  if (Array.isArray(payload)) return { threads: payload, visibilityKnown: false, visibility: "unknown" };
  if (!isRecord(payload)) return { threads: null, visibilityKnown: false, visibility: "unknown" };
  const threads = Array.isArray(payload.threads) ? payload.threads : Array.isArray(payload.items) ? payload.items : null;
  const visibility = valueAt(payload, "visibility", "scope");
  const visibilityKnown = payload.visibilityKnown === true || payload.complete === true || visibility === "complete" || visibility === "all_visible_active";
  return { threads, visibilityKnown, visibility: visibilityKnown ? "complete" : "unknown" };
}

function decorateThreadList(threads: ThreadSummary[], metadata: ThreadListMetadata): VisibleThreadList {
  const list = threads as VisibleThreadList;
  Object.defineProperties(list, {
    threads: { value: list, enumerable: false, configurable: true },
    visibility: { value: metadata.visibility, enumerable: false, configurable: true },
    visibilityKnown: { value: metadata.visibilityKnown, enumerable: false, configurable: true },
    scope: { value: metadata.scope, enumerable: false, configurable: true },
    listHash: { value: metadata.listHash, enumerable: false, configurable: true },
    invalidThreadIndexes: { value: metadata.invalidThreadIndexes, enumerable: false, configurable: true },
    fault: { value: metadata.fault, enumerable: false, configurable: true }
  });
  return list;
}

function threadFrom(value: unknown): ThreadSummary | null {
  if (!isRecord(value)) return null;
  const threadId = nonEmptyString(valueAt(value, "threadId", "thread_id", "id"));
  if (!threadId) return null;
  const turnValue = valueAt(value, "turnId", "turn_id", "activeTurnId", "active_turn_id");
  const projectValue = valueAt(value, "projectId", "project_id", "workspaceId", "workspace_id");
  const repositoryValue = valueAt(value, "repositoryId", "repository_id");
  return {
    threadId,
    turnId: nonEmptyString(turnValue),
    projectId: nonEmptyString(projectValue),
    repositoryId: nonEmptyString(repositoryValue),
    status: "active"
  };
}

function receiptId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = nonEmptyString(valueAt(value, "receiptId", "receipt_id"));
  if (direct) return direct;
  return isRecord(value.receipt) ? nonEmptyString(valueAt(value.receipt, "receiptId", "receipt_id")) : null;
}

function responseThreadId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return nonEmptyString(valueAt(value, "threadId", "thread_id", "originalThreadId", "original_thread_id"));
}

function responseTurnId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = nonEmptyString(valueAt(value, "newTurnId", "new_turn_id", "turnId", "turn_id", "activeTurnId", "active_turn_id"));
  if (direct) return direct;
  return isRecord(value.receipt)
    ? nonEmptyString(valueAt(value.receipt, "newTurnId", "new_turn_id", "turnId", "turn_id", "activeTurnId", "active_turn_id"))
    : null;
}

interface ResumeThreadIdentity {
  threadId: string | null;
  originalThreadId: string | null;
  resumedThreadId: string | null;
  present: boolean;
  invalid: boolean;
  conflict: boolean;
  values: string[];
}

function identityValue(record: RecordValue, aliases: string[]): { present: boolean; value: string | null; invalid: boolean } {
  const presentValues: unknown[] = aliases.filter((alias) => Object.prototype.hasOwnProperty.call(record, alias)).map((alias) => record[alias]);
  if (!presentValues.length) return { present: false, value: null, invalid: false };
  const values = presentValues.map((value) => nonEmptyString(value));
  if (values.some((value) => value === null)) return { present: true, value: null, invalid: true };
  const unique = [...new Set(values as string[])];
  return { present: true, value: unique[0] ?? null, invalid: unique.length > 1 };
}

/**
 * Collect every supported identity field from the response and its optional
 * receipt object.  No field is filled from the requested ID.
 */
function resumeThreadIdentity(value: unknown): ResumeThreadIdentity {
  const records: RecordValue[] = [];
  if (isRecord(value)) {
    records.push(value);
    if (isRecord(value.receipt)) records.push(value.receipt);
  }
  const collect = (aliases: string[]): { present: boolean; value: string | null; invalid: boolean } => {
    const fields = records.map((record) => identityValue(record, aliases)).filter((field) => field.present);
    if (!fields.length) return { present: false, value: null, invalid: false };
    const values = fields.flatMap((field) => field.value ? [field.value] : []);
    const unique = [...new Set(values)];
    return { present: true, value: unique[0] ?? null, invalid: fields.some((field) => field.invalid) || unique.length > 1 };
  };
  const thread = collect(["threadId", "thread_id"]);
  const original = collect(["originalThreadId", "original_thread_id"]);
  const resumed = collect(["resumedThreadId", "resumed_thread_id"]);
  const values = [thread.value, original.value, resumed.value].filter((value): value is string => value !== null);
  return {
    threadId: thread.value,
    originalThreadId: original.value,
    resumedThreadId: resumed.value,
    present: thread.present || original.present || resumed.present,
    invalid: thread.invalid || original.invalid || resumed.invalid,
    conflict: new Set(values).size > 1,
    values
  };
}

function responseCheckpointRef(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = nonEmptyString(valueAt(value, "checkpointRef", "checkpoint_ref"));
  if (direct) return direct;
  return isRecord(value.receipt) ? nonEmptyString(valueAt(value.receipt, "checkpointRef", "checkpoint_ref")) : null;
}

function explicitSuccess(response: unknown): boolean {
  if (!isRecord(response)) return false;
  if (response.ok === true || response.accepted === true || response.confirmed === true) return true;
  const status = valueAt(response, "status", "state");
  if (status === "completed" || status === "success" || status === "confirmed" || status === "interrupted" || status === "resumed") return true;
  return isRecord(response.receipt) && explicitSuccess(response.receipt);
}

export class CodexAppServerAdapter {
  private readonly transport: AppServerTransport;
  private readonly options: Required<AdapterOptions>;

  constructor(transport: AppServerTransport, options: AdapterOptions = {}) {
    if (!transport || typeof transport.request !== "function") throw new TypeError("CodexAppServerAdapter requires an injected transport");
    this.transport = transport;
    this.options = { source: options.source ?? "fixture", timeoutMs: options.timeoutMs ?? 30_000 };
  }

  /** Static/injected capability information only; it is never real App Server evidence. */
  capabilityProbe(): CapabilityProbe {
    const methods = {} as Record<AppServerMethod, "present" | "absent" | "unverified">;
    const capabilities = this.transport.capabilities ? new Set(this.transport.capabilities) : null;
    for (const method of ["account/rateLimits/read", "account/rateLimits/updated", "thread/list", "turn/interrupt", "thread/resume"] as AppServerMethod[]) {
      methods[method] = capabilities ? capabilities.has(method) ? "present" : "absent" : "unverified";
    }
    return { source: capabilities ? "mock" : "injected", methods, realEvidence: "UNVERIFIED" };
  }

  async readRateLimits(previous?: NormalizedQuotaSnapshot | null): Promise<NormalizedQuotaSnapshot> {
    const operation = "account/rateLimits/read" as const;
    try {
      const response = await withTimeout(this.transport.request(operation, {}, { timeoutMs: this.options.timeoutMs }), this.options.timeoutMs, operation);
      const fault = responseError(operation, response);
      if (fault) return unknownQuotaSnapshot(operation, fault, this.options.source);
      const normalizerOptions = previous === undefined
        ? { source: this.options.source }
        : { source: this.options.source, previous };
      const snapshot = normalizeRateLimitsRead(response, normalizerOptions);
      if (snapshot.status !== "fresh") {
        const shapeFault = operationError(operation, snapshot.conflict ? "QUOTA_DATA_CONFLICT" : "QUOTA_DATA_UNKNOWN", snapshot.reason, snapshot.conflict ? "blocked" : "unknown");
        return attachFault(snapshot, shapeFault);
      }
      return attachFault(snapshot, null);
    } catch (error) {
      const fault = error instanceof Object && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? mapTransportFault(operation, error)
        : mapTransportFault(operation, error);
      return unknownQuotaSnapshot(operation, fault, this.options.source);
    }
  }

  /** Handle a structured notification without making any transport call. */
  rateLimitsUpdated(message: unknown, previous?: NormalizedQuotaSnapshot | null): NormalizedQuotaSnapshot {
    const operation = "account/rateLimits/updated" as const;
    const normalizerOptions = previous === undefined
      ? { source: this.options.source }
      : { source: this.options.source, previous };
    const snapshot = normalizeRateLimitsUpdated(message, normalizerOptions);
    if (snapshot.status !== "fresh") {
      const fault = operationError(operation, snapshot.conflict ? "QUOTA_DATA_CONFLICT" : "QUOTA_DATA_UNKNOWN", snapshot.reason, snapshot.conflict ? "blocked" : "unknown");
      return attachFault(snapshot, fault);
    }
    return attachFault(snapshot, null);
  }

  /** Alias matching the notification vocabulary used by the design. */
  handleRateLimitsUpdated(message: unknown, previous?: NormalizedQuotaSnapshot | null): NormalizedQuotaSnapshot {
    return this.rateLimitsUpdated(message, previous);
  }

  /** Enumerate every active thread returned by the injected transport. */
  async listVisibleActiveThreads(): Promise<VisibleThreadList> {
    const operation = "thread/list" as const;
    try {
      const response = await withTimeout(this.transport.request(operation, { status: "active" }, { timeoutMs: this.options.timeoutMs }), this.options.timeoutMs, operation);
      const responseFault = responseError(operation, response);
      if (responseFault) {
        return decorateThreadList([], { visibility: "unknown", visibilityKnown: false, scope: "unknown", listHash: sha256([]), invalidThreadIndexes: [], fault: responseFault });
      }
      const parsed = listResponsePayload(response);
      if (!parsed.threads) {
        const fault = operationError(operation, "DRAIN_SCOPE_UNKNOWN", "thread/list did not return a structured threads collection", "blocked");
        return decorateThreadList([], { visibility: "unknown", visibilityKnown: false, scope: "unknown", listHash: sha256([]), invalidThreadIndexes: [], fault });
      }
      const invalidThreadIndexes: number[] = [];
      const threads: ThreadSummary[] = [];
      parsed.threads.forEach((item, index) => {
        if (!threadFrom(item)) invalidThreadIndexes.push(index);
        else threads.push(threadFrom(item)!);
      });
      let fault: AdapterFault | null = null;
      if (!parsed.visibilityKnown) fault = operationError(operation, "DRAIN_SCOPE_UNKNOWN", "thread/list did not prove complete visible-thread scope", "blocked");
      if (invalidThreadIndexes.length) fault = operationError(operation, "UNMAPPED_THREAD", "thread/list contained an object without a stable thread id", "blocked");
      const list = decorateThreadList(threads, {
        visibility: parsed.visibility,
        visibilityKnown: parsed.visibilityKnown,
        scope: parsed.visibilityKnown ? "all_visible_active" : "unknown",
        listHash: sha256(threads),
        invalidThreadIndexes,
        fault
      });
      return list;
    } catch (error) {
      const fault = mapTransportFault(operation, error);
      return decorateThreadList([], { visibility: "unknown", visibilityKnown: false, scope: "unknown", listHash: sha256([]), invalidThreadIndexes: [], fault });
    }
  }

  async interruptTurn(threadId: string, turnId: string, idempotencyKey: string): Promise<InterruptReceipt> {
    const operation = "turn/interrupt" as const;
    const base = { kind: "turn_interrupt" as const, operation, threadId, turnId, idempotencyKey, receiptId: null, status: "failed" as InterruptStatus, confirmed: false, accepted: false, fault: null as AdapterFault | null };
    if (!nonEmptyString(threadId) || !nonEmptyString(turnId)) return { ...base, fault: operationError(operation, "INVALID_THREAD_ID", "interrupt requires the original thread and active turn ids", "blocked") };
    if (!nonEmptyString(idempotencyKey)) return { ...base, fault: operationError(operation, "IDEMPOTENCY_KEY_REQUIRED", "interrupt requires an idempotency key", "blocked") };
    try {
      const response = await withTimeout(this.transport.request(operation, { threadId, turnId }, { timeoutMs: this.options.timeoutMs, idempotencyKey }), this.options.timeoutMs, operation);
      const fault = responseError(operation, response);
      if (fault) {
        const unknown = fault.code === "UNKNOWN_IN_FLIGHT";
        return { ...base, status: unknown ? "unknown_in_flight" : fault.code === "APP_SERVER_TIMEOUT" ? "timeout" : "failed", fault };
      }
      const payload = responsePayload(response);
      const returnedThread = responseThreadId(payload);
      const returnedTurn = responseTurnId(payload);
      if ((returnedThread && returnedThread !== threadId) || (returnedTurn && returnedTurn !== turnId)) {
        return { ...base, fault: operationError(operation, "RECEIPT_ID_MISMATCH", "interrupt receipt ids do not match the requested original object", "reconcile_required") };
      }
      const id = receiptId(payload);
      if (!explicitSuccess(payload) || !id) return { ...base, fault: operationError(operation, "INTERRUPT_RECEIPT_INVALID", "interrupt did not return an explicit success receipt", "reconcile_required") };
      return { ...base, receiptId: id, status: "confirmed", confirmed: true, accepted: true };
    } catch (error) {
      const fault = error instanceof Object && "code" in error && (error as { code?: unknown }).code === "APP_SERVER_TIMEOUT" ? error as AdapterFault : mapTransportFault(operation, error);
      return { ...base, status: fault.code === "UNKNOWN_IN_FLIGHT" ? "unknown_in_flight" : fault.code === "APP_SERVER_TIMEOUT" ? "timeout" : "failed", fault };
    }
  }

  async resumeThread(threadId: string, checkpointRef: string, idempotencyKey: string): Promise<ResumeReceipt> {
    const operation = "thread/resume" as const;
    const base = { kind: "thread_resume" as const, operation, originalThreadId: threadId, resumedThreadId: null, newTurnId: null, checkpointRef, idempotencyKey, receiptId: null, status: "failed" as ResumeStatus, confirmed: false, accepted: false, fault: null as AdapterFault | null, observedThreadId: null, observedOriginalThreadId: null, observedResumedThreadId: null };
    if (!nonEmptyString(threadId)) return { ...base, fault: operationError(operation, "ORIGINAL_THREAD_MISSING", "resume requires the original thread id; no replacement thread is allowed", "blocked") };
    if (!nonEmptyString(checkpointRef)) return { ...base, fault: operationError(operation, "CHECKPOINT_REQUIRED", "resume requires a persisted checkpoint reference", "blocked") };
    if (!nonEmptyString(idempotencyKey)) return { ...base, fault: operationError(operation, "IDEMPOTENCY_KEY_REQUIRED", "resume requires an idempotency key", "blocked") };
    try {
      const response = await withTimeout(this.transport.request(operation, { threadId, checkpointRef }, { timeoutMs: this.options.timeoutMs, idempotencyKey }), this.options.timeoutMs, operation);
      const fault = responseError(operation, response);
      if (fault) {
        const unknown = fault.code === "UNKNOWN_IN_FLIGHT";
        return { ...base, status: unknown ? "unknown_in_flight" : fault.code === "APP_SERVER_TIMEOUT" ? "timeout" : "failed", fault };
      }
      const payload = responsePayload(response);
      const identity = resumeThreadIdentity(payload);
      const returnedThread = identity.resumedThreadId ?? identity.threadId ?? identity.originalThreadId;
      const newTurn = responseTurnId(payload);
      const id = receiptId(payload);
      const observed = { observedThreadId: identity.threadId, observedOriginalThreadId: identity.originalThreadId, observedResumedThreadId: identity.resumedThreadId };
      if (!identity.present || identity.invalid || identity.conflict) return { ...base, ...observed, resumedThreadId: returnedThread, newTurnId: newTurn, receiptId: id, fault: operationError(operation, identity.invalid || identity.conflict ? "THREAD_ID_FIELDS_CONFLICT" : "ORIGINAL_THREAD_MISSING", identity.invalid || identity.conflict ? "resume returned conflicting thread identity fields" : "resume response did not identify the original thread", "reconcile_required") };
      if (identity.values.some((value) => value !== threadId)) return { ...base, ...observed, resumedThreadId: returnedThread, newTurnId: newTurn, receiptId: id, fault: operationError(operation, "RECEIPT_ID_MISMATCH", "resume returned a thread identity different from the requested original thread; replacement threads are not accepted", "reconcile_required") };
      const returnedCheckpoint = responseCheckpointRef(payload);
      if (returnedCheckpoint !== null && returnedCheckpoint !== checkpointRef) return { ...base, ...observed, resumedThreadId: returnedThread, newTurnId: newTurn, receiptId: id, fault: operationError(operation, "CHECKPOINT_MISMATCH", "resume receipt checkpoint does not match the requested checkpoint", "reconcile_required") };
      if (!explicitSuccess(payload) || !id || !newTurn) return { ...base, ...observed, resumedThreadId: returnedThread, newTurnId: newTurn, receiptId: id, fault: operationError(operation, "RESUME_RECEIPT_INVALID", "resume did not return an explicit receipt and new turn id", "reconcile_required") };
      return { ...base, ...observed, resumedThreadId: returnedThread, newTurnId: newTurn, receiptId: id, status: "confirmed", confirmed: true, accepted: true };
    } catch (error) {
      const fault = error instanceof Object && "code" in error && (error as { code?: unknown }).code === "APP_SERVER_TIMEOUT" ? error as AdapterFault : mapTransportFault(operation, error);
      return { ...base, status: fault.code === "UNKNOWN_IN_FLIGHT" ? "unknown_in_flight" : fault.code === "APP_SERVER_TIMEOUT" ? "timeout" : "failed", fault };
    }
  }
}

/** Pure in-memory transport for unit/integration tests. It has no network path. */
export class MockAppServerTransport implements AppServerTransport {
  readonly calls: Array<{ method: AppServerMethod; params: unknown; options?: AppServerRequestOptions }> = [];
  readonly capabilities: Set<string>;
  private readonly responses: Map<AppServerMethod, unknown | (() => unknown | Promise<unknown>)>;

  constructor(responses: Partial<Record<AppServerMethod, unknown | (() => unknown | Promise<unknown>)>>, capabilities?: Iterable<string>) {
    this.responses = new Map(Object.entries(responses) as Array<[AppServerMethod, unknown | (() => unknown | Promise<unknown>)]>);
    this.capabilities = new Set(capabilities ?? Object.keys(responses));
  }

  async request(method: AppServerMethod, params: unknown = {}, options?: AppServerRequestOptions): Promise<unknown> {
    if (options === undefined) this.calls.push({ method, params });
    else this.calls.push({ method, params, options });
    if (!this.responses.has(method)) throw Object.assign(new Error(`${method} is not implemented by mock`), { code: "METHOD_NOT_FOUND" });
    const response = this.responses.get(method);
    return typeof response === "function" ? await response() : response;
  }
}

export type CodexAppServer = CodexAppServerAdapter;
