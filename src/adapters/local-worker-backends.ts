/**
 * Wave B3 local adapter seams.
 *
 * This module does not discover, start, or configure a real worker.  The
 * caller supplies an explicit transport (the Wave C integration point), and
 * this module only normalizes its calls into durable, fail-closed receipts.
 * In particular, a missing transport is an error; there is no implicit mock
 * fallback.
 */

import { randomUUID } from "node:crypto";
import { sha256 } from "../domain/canonical.js";
import { sanitizeRuntimeValue } from "../runtime-config.js";
import type { WorkerRunBackend, PatchBackend } from "../mcp/server.js";
import type { WorkerKind, ContinuationKind } from "../domain/types.js";
import type { RealSessionRef, FreshTurnRef } from "./adapter-types.js";
import type {
  ClaudeReplyRequest,
  DshFreshStartRequest
} from "./claude-orchestrator.js";
import type {
  BridgePatchApplyInput,
  BridgePatchCommitInput,
  BridgePatchGenerateInput,
  BridgePatchValidateInput,
  BridgeRunTaskInput
} from "./engineering-bridge.js";

/** Error categories consumed by the Wave C workflow/reconcile layer. */
export type LocalBackendErrorClass =
  | "needs_attention"
  | "upstream_rate_limited"
  | "upstream_unavailable"
  | "blocked"
  | "unknown";

export type LocalOperationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "needs_attention"
  | "blocked"
  | "unknown";

export type DurableReferenceStatus = "present" | "missing" | "unknown" | "mismatch" | "error";

/**
 * The shared server seam currently carries only strings for evidenceRefs.
 * B3 keeps a narrow richer reference beside that seam so Wave C can persist
 * input/output evidence without claiming that a path exists from a bare
 * string.  `exists` and `resultStatus` are never inferred from a path alone.
 */
export interface DurableReference {
  path: string;
  hash: string;
  exists: boolean;
  resultStatus: DurableReferenceStatus;
}

export interface LocalBackendError {
  code: string;
  class: LocalBackendErrorClass;
  message: string;
  operation: string;
  at: string;
  details: Record<string, unknown>;
}

export class LocalBackendFailure extends Error {
  readonly detail: LocalBackendError;
  readonly receipt: LocalWorkerReceipt | LocalPatchReceipt | null;

  constructor(detail: LocalBackendError, receipt: LocalWorkerReceipt | LocalPatchReceipt | null = null) {
    const safeDetail = sanitizeRuntimeValue(detail);
    const safeReceipt = receipt === null ? null : sanitizeRuntimeValue(receipt);
    super(safeDetail.message);
    this.name = "LocalBackendFailure";
    this.detail = safeDetail;
    this.receipt = safeReceipt;
  }
}

export interface LocalWorkerBinding {
  /** Required for a Claude reply; never synthesized by this module. */
  claudeSession?: RealSessionRef;
  /** Required for a DSH fresh start. */
  checkpointRef?: string;
  /** Required for an Engineering Bridge worker call. */
  workspaceId?: string;
}

export type LocalWorkerBindingResolver = (taskId: string, workerKind: WorkerKind) => LocalWorkerBinding | undefined;

/** Request shapes intentionally retain the upstream naming and semantics. */
export type LocalClaudeReplyRequest = ClaudeReplyRequest & {
  continuation: "claude_resume";
  executor: "claude";
};

export type LocalDshFreshRequest = DshFreshStartRequest & {
  continuation: "dsh_fresh";
  executor: "dsh";
};

export interface LocalBridgeWorkerRequest extends BridgeRunTaskInput {
  executor: "dsh";
  task_id: string;
  attempt_id: string;
  idempotency_key: string;
  instruction_ref: { kind: string; ref: string };
}

/** Raw injected worker transport. It is the only boundary allowed to cause an upstream call. */
export interface LocalWorkerTransport {
  claudeReply?: (request: LocalClaudeReplyRequest) => unknown | Promise<unknown>;
  dshFreshStart?: (request: LocalDshFreshRequest) => unknown | Promise<unknown>;
  bridgeRunTask?: (request: LocalBridgeWorkerRequest) => unknown | Promise<unknown>;
}

export interface LocalReceiptSink {
  append(receipt: LocalWorkerReceipt | LocalPatchReceipt): void | Promise<void>;
}

export interface LocalWorkerReceipt {
  schemaVersion: "continuity.local-worker-receipt.v1";
  requestId: string;
  idempotencyKey: string;
  attemptId: string;
  taskId: string;
  workerKind: WorkerKind;
  source: "claude_orchestrator" | "engineering-bridge";
  executor: "claude" | "dsh";
  operation: "claude_code_reply" | "claude_code_start" | "engineering-bridge:run_task";
  continuation: ContinuationKind;
  status: LocalOperationStatus;
  ok: boolean;
  realJobId: string | null;
  realSessionRef: RealSessionRef | null;
  freshTurnRef: FreshTurnRef | null;
  bridgeTaskId: string | null;
  inputRefs: DurableReference[];
  outputRefs: DurableReference[];
  deliverable: DurableReference | null;
  evidenceRefs: string[];
  error: LocalBackendError | null;
  /** Always MOCK_PASS/UNKNOWN; B3 is not real external evidence. */
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  createdAt: string;
}

export interface LocalWorkerRunResult extends Awaited<ReturnType<WorkerRunBackend["run"]>> {
  receipt: LocalWorkerReceipt;
}

export interface LocalWorkerBackendOptions {
  transport?: LocalWorkerTransport;
  bindings?: Readonly<Record<string, LocalWorkerBinding>> | Map<string, LocalWorkerBinding>;
  resolveBinding?: LocalWorkerBindingResolver;
  /** Required for all successful calls. Use InMemoryLocalDurableStore only in tests. */
  durableStore?: LocalDurableStore;
  receiptSink?: LocalReceiptSink;
  now?: () => Date;
  evidenceLevel?: "MOCK_PASS" | "UNKNOWN";
}

export const LOCAL_WORKER_BACKEND_WAVE_C_GAPS = [
  "Wave C must construct the real claude_orchestrator/Engineering Bridge transport and inject it; B3 never discovers or starts a process.",
  "The shared WorkerRunBackend return shape has no error or receipt field; run() throws LocalBackendFailure on non-success and exposes the richer receipt through runDetailed().",
  "Wave C must inject a process-safe LocalDurableStore; omitting it is fail-closed. InMemoryLocalDurableStore is intentionally test-only.",
  "The shared PatchBackend shape has no confirmation or receipt fields; applyWithConfirmation/commitWithConfirmation preserve the exact gates until Wave C wires the server gate.",
  "Durable input/output references require a producer to supply path, hash, exists and resultStatus; this module never infers file existence from a path."
] as const;

export interface DurableWorkerAttemptRecord {
  payloadHash: string;
  receipt: LocalWorkerReceipt;
  failure: LocalBackendError | null;
}

export interface DurablePatchAttemptRecord {
  payloadHash: string;
  receipt: LocalPatchReceipt;
  failure: LocalBackendError | null;
  diff: string | null;
  diffHash: string | null;
  patchTaskId: string | null;
  workspaceId: string | null;
  baseHead: string | null;
  applied: boolean;
  committed: boolean;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | null;
  applyReceiptId: string | null;
  commitHash: string | null;
  commitReceiptId: string | null;
}

/**
 * Durable state boundary for Wave C. The default constructors intentionally
 * do not create one: production-capable wiring must inject a process-safe
 * implementation. The in-memory implementation is explicitly test-only.
 */
export interface LocalDurableStore {
  getWorkerAttempt(idempotencyKey: string): DurableWorkerAttemptRecord | undefined;
  putWorkerAttempt(idempotencyKey: string, record: DurableWorkerAttemptRecord): void;
  /**
   * Every retained worker attempt.  The worker-control tool only receives an
   * `attempt_id`, so resolving the parent task (and the routing kind) requires
   * a reverse lookup over the durable ledger rather than a caller-supplied id.
   */
  listWorkerAttempts(): DurableWorkerAttemptRecord[];
  getPatchAttempt(idempotencyKey: string): DurablePatchAttemptRecord | undefined;
  putPatchAttempt(idempotencyKey: string, record: DurablePatchAttemptRecord): void;
  getPatchTask(patchTaskId: string): DurablePatchAttemptRecord | undefined;
  putPatchTask(patchTaskId: string, record: DurablePatchAttemptRecord): void;
  findPatchByDiffHash(diffHash: string): DurablePatchAttemptRecord[];
  appendPatchReceipt(receipt: LocalPatchReceipt): void;
  listPatchReceipts(): LocalPatchReceipt[];
}

export class InMemoryLocalDurableStore implements LocalDurableStore {
  private readonly workerAttempts = new Map<string, DurableWorkerAttemptRecord>();
  private readonly patchAttempts = new Map<string, DurablePatchAttemptRecord>();
  private readonly patchTasks = new Map<string, DurablePatchAttemptRecord>();
  private readonly patchReceipts: LocalPatchReceipt[] = [];

  getWorkerAttempt(idempotencyKey: string): DurableWorkerAttemptRecord | undefined {
    const record = this.workerAttempts.get(idempotencyKey);
    return record ? cloneJson(record) : undefined;
  }

  putWorkerAttempt(idempotencyKey: string, record: DurableWorkerAttemptRecord): void {
    this.workerAttempts.set(idempotencyKey, cloneJson(record));
  }

  listWorkerAttempts(): DurableWorkerAttemptRecord[] {
    return cloneJson([...this.workerAttempts.values()]);
  }

  getPatchAttempt(idempotencyKey: string): DurablePatchAttemptRecord | undefined {
    const record = this.patchAttempts.get(idempotencyKey);
    return record ? cloneJson(record) : undefined;
  }

  putPatchAttempt(idempotencyKey: string, record: DurablePatchAttemptRecord): void {
    const copy = cloneJson(record);
    this.patchAttempts.set(idempotencyKey, copy);
    if (copy.patchTaskId) this.patchTasks.set(copy.patchTaskId, cloneJson(copy));
  }

  getPatchTask(patchTaskId: string): DurablePatchAttemptRecord | undefined {
    const record = this.patchTasks.get(patchTaskId);
    return record ? cloneJson(record) : undefined;
  }

  putPatchTask(patchTaskId: string, record: DurablePatchAttemptRecord): void {
    const copy = cloneJson({ ...record, patchTaskId });
    this.patchTasks.set(patchTaskId, copy);
    // Keep the proposal lookup in sync when state is advanced by APPLY/COMMIT.
    if (copy.payloadHash) {
      for (const [key, prior] of this.patchAttempts.entries()) {
        if (prior.patchTaskId === patchTaskId) this.patchAttempts.set(key, cloneJson(copy));
      }
    }
  }

  findPatchByDiffHash(diffHash: string): DurablePatchAttemptRecord[] {
    const records = [...this.patchTasks.values(), ...this.patchAttempts.values()].filter((record) => record.diffHash === diffHash);
    const unique = new Map<string, DurablePatchAttemptRecord>();
    for (const record of records) unique.set(`${record.payloadHash}:${record.patchTaskId ?? ""}`, record);
    return cloneJson([...unique.values()]);
  }

  appendPatchReceipt(receipt: LocalPatchReceipt): void {
    this.patchReceipts.push(cloneJson(receipt));
  }

  listPatchReceipts(): LocalPatchReceipt[] {
    return cloneJson(this.patchReceipts);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function valueAt(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }
  return undefined;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // BridgeToolReceipt and JSON-RPC envelopes have a stable wrapper. Do not
  // unwrap arbitrary `data` fields from a worker payload because data may be
  // the actual deliverable metadata.
  if (isRecord(value) && (value.schemaVersion === "continuity.bridge-receipt.v1" || value.tool !== undefined) && value.data !== undefined) {
    return unwrap(value.data);
  }
  if (value.result !== undefined && (value.jsonrpc !== undefined || value.id !== undefined || value.error !== undefined)) return unwrap(value.result);
  return value;
}

function idFrom(value: unknown, ...keys: string[]): string | null {
  return isRecord(value) ? nonEmptyString(valueAt(value, ...keys)) : null;
}

function statusFrom(value: unknown): LocalOperationStatus {
  const raw = isRecord(value) ? valueAt(value, "state", "status") : undefined;
  const state = typeof raw === "string" ? raw.toLowerCase().trim() : "unknown";
  if (state === "queued" || state === "pending" || state === "attempt") return "queued";
  if (state === "running" || state === "in_progress" || state === "in-progress") return "running";
  if (state === "completed" || state === "complete" || state === "success" || state === "succeeded" || state === "done") return "completed";
  if (state === "waiting_for_supervisor_review" || state === "needs_attention" || state === "review" || state === "attention") return "needs_attention";
  if (state === "blocked") return "blocked";
  if (state === "failed" || state === "error" || state === "cancelled" || state === "canceled") return "failed";
  if (state === "unknown_in_flight" || state === "reconcile_required" || state === "timeout" || state === "unknown") return "unknown";
  return "unknown";
}

function errorClassFrom(code: string, status: string | undefined, message: string): LocalBackendErrorClass {
  const normalized = `${code} ${status ?? ""} ${message}`.toLowerCase();
  if (/needs[_ -]?attention|waiting[_ -]?for[_ -]?supervisor|supervisor[_ -]?review|\breview\b/.test(normalized)) return "needs_attention";
  if (/upstream[_ -]?rate[_ -]?limited|rate[_ -]?limit|rate-limited|too many requests|\b429\b/.test(normalized)) return "upstream_rate_limited";
  if (/upstream[_ -]?unavailable|bad gateway|gateway timeout|\b502\b|\b503\b|\b504\b|econnrefused|service unavailable/.test(normalized)) return "upstream_unavailable";
  if (/blocked|capability[_ -]?unavailable|not[_ -]?located|routing[_ -]?rejected|permission|forbidden|deliverable[_ -]?missing|artifact[_ -]?ref/.test(normalized)) return "blocked";
  return "unknown";
}

function errorFromValue(value: unknown, operation: string, now: () => Date, fallbackCode: string): LocalBackendError | null {
  if (!isRecord(value)) return null;
  const rawError = isRecord(value.error) ? value.error : null;
  const rawStatus = rawError ? valueAt(rawError, "status", "class") : valueAt(value, "errorStatus", "errorClass");
  const code = nonEmptyString(rawError ? valueAt(rawError, "code") : valueAt(value, "errorCode", "code"));
  const message = nonEmptyString(rawError ? valueAt(rawError, "message") : valueAt(value, "errorMessage"));
  const rawState = valueAt(value, "state", "status");
  const state = typeof rawState === "string" ? rawState.toLowerCase() : "";
  const failedFlag = value.ok === false || value.success === false || state === "failed" || state === "error" || state === "unknown_in_flight" || state === "reconcile_required" || state === "timeout";
  if (!failedFlag && !code && !message) return null;
  const selectedCode = code ?? (state === "unknown_in_flight" ? "UPSTREAM_UNKNOWN_IN_FLIGHT" : fallbackCode);
  const selectedMessage = message ?? (state === "unknown_in_flight" ? "upstream outcome is unknown in flight" : "upstream worker returned a failure");
  const details: Record<string, unknown> = {};
  if (rawError) {
    for (const [key, item] of Object.entries(rawError)) {
      if (key !== "message" && key !== "code" && key !== "status" && key !== "class") details[key] = item;
    }
  }
  return {
    code: selectedCode,
    class: errorClassFrom(selectedCode, typeof rawStatus === "string" ? rawStatus : undefined, selectedMessage),
    message: selectedMessage,
    operation,
    at: nowIso(now),
    details
  };
}

function errorFromThrown(error: unknown, operation: string, now: () => Date): LocalBackendError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LocalBackendFailure ? error.detail.code : "UPSTREAM_CALL_FAILED";
  return {
    code,
    class: errorClassFrom(code, undefined, message),
    message,
    operation,
    at: nowIso(now),
    details: {}
  };
}

function logicalReference(ref: string): DurableReference {
  return {
    path: ref,
    hash: sha256(ref),
    exists: false,
    resultStatus: "unknown"
  };
}

function normalizeReference(value: unknown): DurableReference | null {
  if (!isRecord(value)) return null;
  const path = nonEmptyString(valueAt(value, "path", "filePath", "file_path"));
  const hash = nonEmptyString(valueAt(value, "hash", "sha256", "contentHash", "content_hash"));
  const exists = valueAt(value, "exists", "existence");
  const resultStatus = nonEmptyString(valueAt(value, "resultStatus", "result_status", "status"));
  if (!path || !hash || typeof exists !== "boolean" || !resultStatus || !["present", "missing", "unknown", "mismatch", "error"].includes(resultStatus)) return null;
  return { path, hash, exists, resultStatus: resultStatus as DurableReferenceStatus };
}

function extractReferences(payload: unknown): DurableReference[] {
  if (!isRecord(payload)) return [];
  const raw = valueAt(payload, "deliverable", "deliverable_ref", "deliverableRef", "artifact", "output_ref", "outputRef", "artifacts", "outputs");
  if (Array.isArray(raw)) return raw.map((item) => normalizeReference(item)).filter((item): item is DurableReference => item !== null);
  const one = normalizeReference(raw);
  return one ? [one] : [];
}

function invalidReferencePresent(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const raw = valueAt(payload, "deliverable", "deliverable_ref", "deliverableRef", "artifact", "output_ref", "outputRef", "artifacts", "outputs");
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return false;
  return extractReferences(payload).length === 0;
}

function deliverableError(payload: unknown, operation: string, now: () => Date, status: LocalOperationStatus): LocalBackendError | null {
  if (status !== "completed") return null;
  const refs = extractReferences(payload);
  if (refs.length === 0) {
    return {
      code: invalidReferencePresent(payload) ? "DELIVERABLE_REF_INVALID" : "DELIVERABLE_MISSING",
      class: "blocked",
      message: invalidReferencePresent(payload)
        ? "completed worker output did not contain a path/hash/existence/resultStatus reference"
        : "completed worker output has no deliverable reference",
      operation,
      at: nowIso(now),
      details: { required: ["path", "hash", "exists", "resultStatus"] }
    };
  }
  const invalid = refs.find((ref) => !ref.exists || ref.resultStatus !== "present");
  if (invalid) {
    return {
      code: "DELIVERABLE_NOT_READY",
      class: invalid.resultStatus === "unknown" ? "unknown" : "blocked",
      message: `deliverable ${invalid.path} is not present and verified`,
      operation,
      at: nowIso(now),
      details: { reference: invalid }
    };
  }
  return null;
}

function attemptIdFor(input: { taskId: string; workerKind: WorkerKind; idempotencyKey: string }): string {
  return `attempt-${sha256(input).slice("sha256:".length, "sha256:".length + 24)}`;
}

function requireString(value: unknown, name: string): string {
  const result = nonEmptyString(value);
  if (!result) throw new LocalBackendFailure({
    code: "INVALID_INPUT",
    class: "blocked",
    message: `${name} is required`,
    operation: "input",
    at: new Date().toISOString(),
    details: { field: name }
  });
  return result;
}

function bindingFor(options: LocalWorkerBackendOptions, taskId: string, kind: WorkerKind): LocalWorkerBinding | undefined {
  const resolved = options.resolveBinding?.(taskId, kind);
  if (resolved) return resolved;
  if (options.bindings instanceof Map) return options.bindings.get(taskId);
  return options.bindings?.[taskId];
}

function assertClaudeSession(value: RealSessionRef | undefined): RealSessionRef {
  if (!value || value.kind !== "real_session" || value.backend !== "claude" || value.source !== "claude_orchestrator" || !nonEmptyString(value.jobId) || !nonEmptyString(value.sessionId)) {
    throw new LocalBackendFailure({
      code: "CLAUDE_SESSION_MISSING",
      class: "blocked",
      message: "Claude resume requires a real claude_orchestrator job/session reference",
      operation: "claude_code_reply",
      at: new Date().toISOString(),
      details: {}
    });
  }
  return { ...value, jobId: value.jobId.trim(), sessionId: value.sessionId.trim(), threadId: value.threadId ?? null };
}

function assertPayloadIdentity(payload: unknown, session: RealSessionRef, operation: string, now: () => Date): LocalBackendError | null {
  const returnedJob = idFrom(payload, "jobId", "job_id", "realJobId", "real_job_id");
  const returnedSession = idFrom(payload, "sessionId", "session_id");
  const returnedThread = idFrom(payload, "threadId", "thread_id");
  if ((returnedJob && returnedJob !== session.jobId) || (returnedSession && returnedSession !== session.sessionId) || (returnedThread && session.threadId && returnedThread !== session.threadId)) {
    return {
      code: "SESSION_REF_MISMATCH",
      class: "blocked",
      message: "Claude reply returned a different job/session/thread identity",
      operation,
      at: nowIso(now),
      details: { requestedJobId: session.jobId, returnedJobId: returnedJob, requestedSessionId: session.sessionId, returnedSessionId: returnedSession, requestedThreadId: session.threadId ?? null, returnedThreadId: returnedThread }
    };
  }
  return null;
}

function extractFreshTurn(payload: unknown, operation: string, now: () => Date): { ref: FreshTurnRef | null; error: LocalBackendError | null } {
  const sessionId = idFrom(payload, "sessionId", "session_id");
  const threadId = idFrom(payload, "threadId", "thread_id");
  if (sessionId || threadId) return { ref: null, error: {
    code: "DSH_SESSION_FORBIDDEN",
    class: "blocked",
    message: "DSH fresh turns must not return session_id or thread_id",
    operation,
    at: nowIso(now),
    details: { sessionId, threadId }
  } };
  const turnId = idFrom(payload, "turnId", "turn_id", "freshTurnId", "fresh_turn_id");
  const jobId = idFrom(payload, "jobId", "job_id", "realJobId", "real_job_id", "id");
  if (!turnId || !jobId) return { ref: null, error: {
    code: "FRESH_TURN_ID_MISSING",
    class: "unknown",
    message: "DSH fresh start did not return both turn_id and job_id",
    operation,
    at: nowIso(now),
    details: { turnId, jobId }
  } };
  return { ref: { kind: "fresh_turn", backend: "deepseek-harness", source: "claude_orchestrator", turnId, jobId, sessionId: null, threadId: null }, error: null };
}

function outputRefsAndError(payload: unknown, operation: string, status: LocalOperationStatus, now: () => Date): { outputRefs: DurableReference[]; deliverable: DurableReference | null; error: LocalBackendError | null } {
  const outputRefs = extractReferences(payload);
  const deliverable = outputRefs[0] ?? null;
  const error = deliverableError(payload, operation, now, status);
  return { outputRefs, deliverable, error };
}

export class LocalWorkerBackend implements WorkerRunBackend {
  private readonly transport: LocalWorkerTransport;
  private readonly durableStore: LocalDurableStore | undefined;
  private readonly now: () => Date;
  private readonly evidenceLevel: "MOCK_PASS" | "UNKNOWN";

  constructor(private readonly options: LocalWorkerBackendOptions = {}) {
    this.transport = options.transport ?? {};
    this.durableStore = options.durableStore;
    this.now = options.now ?? (() => new Date());
    this.evidenceLevel = options.evidenceLevel ?? "MOCK_PASS";
  }

  /** Return the richer receipt without projecting it into the legacy server seam. */
  async runDetailed(input: Parameters<WorkerRunBackend["run"]>[0]): Promise<LocalWorkerReceipt> {
    const taskId = requireString(input.taskId, "taskId");
    const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey");
    if (!this.durableStore) throw new LocalBackendFailure({ code: "DURABLE_STORE_UNAVAILABLE", class: "blocked", message: "worker backend requires an injected durable store", operation: "worker_run", at: nowIso(this.now), details: { productionFailClosed: true } });
    const payloadIdentity = sha256({ taskId, workerKind: input.workerKind, instructionRef: input.instructionRef, idempotencyKey });
    const prior = this.durableStore.getWorkerAttempt(idempotencyKey);
    if (prior) {
      if (prior.payloadHash !== payloadIdentity) throw new LocalBackendFailure({
        code: "IDEMPOTENCY_KEY_REUSED",
        class: "blocked",
        message: "idempotency key was already used with a different worker request",
        operation: "worker_run",
        at: nowIso(this.now),
        details: { idempotencyKey }
      }, prior.receipt);
      if (prior.failure) throw new LocalBackendFailure(prior.failure, prior.receipt);
      return cloneJson(prior.receipt);
    }

    const attemptId = attemptIdFor({ taskId, workerKind: input.workerKind, idempotencyKey });
    const binding = bindingFor(this.options, taskId, input.workerKind);
    const inputRefs = [logicalReference(input.instructionRef.ref)];
    let receipt: LocalWorkerReceipt;
    try {
      receipt = await this.invokeWorker({ taskId, workerKind: input.workerKind, instructionRef: input.instructionRef, idempotencyKey, attemptId, binding, inputRefs });
    } catch (error) {
      const detail = error instanceof LocalBackendFailure ? error.detail : errorFromThrown(error, "worker_run", this.now);
      receipt = this.failedReceipt({ taskId, workerKind: input.workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: operationFor(input.workerKind), continuation: continuationFor(input.workerKind), source: input.workerKind === "bridge-dsh" ? "engineering-bridge" : "claude_orchestrator", executor: input.workerKind === "claude" ? "claude" : "dsh", detail });
    }
    receipt = sanitizeRuntimeValue(receipt);
    const failure = receipt.error ? sanitizeRuntimeValue(receipt.error) : null;
    this.durableStore.putWorkerAttempt(idempotencyKey, { payloadHash: payloadIdentity, receipt: cloneJson(receipt), failure });
    await this.persist(receipt);
    if (failure) throw new LocalBackendFailure(failure, receipt);
    return receipt;
  }

  async run(input: Parameters<WorkerRunBackend["run"]>[0]): Promise<LocalWorkerRunResult> {
    const receipt = await this.runDetailed(input);
    if (!receipt.realJobId) {
      const detail: LocalBackendError = {
        code: "JOB_ID_MISSING",
        class: "unknown",
        message: "successful worker receipt has no real job identifier",
        operation: receipt.operation,
        at: nowIso(this.now),
        details: {}
      };
      throw new LocalBackendFailure(detail, receipt);
    }
    // The server's legacy start seam has no completed status. A completed
    // immediate result is returned as running while the detailed receipt
    // remains the source of truth for Wave C.
    const status: "queued" | "running" | "failed" = receipt.status === "queued" ? "queued" : receipt.status === "failed" ? "failed" : "running";
    return { realJobId: receipt.realJobId, attemptId: receipt.attemptId, status, evidenceRefs: receipt.evidenceRefs, receipt };
  }

  /** Explicit convenience name for a Claude reply/resume operation. */
  async replyClaude(input: Parameters<WorkerRunBackend["run"]>[0]): Promise<LocalWorkerReceipt> {
    if (input.workerKind !== "claude") throw new LocalBackendFailure({ code: "ROUTING_REJECTED", class: "blocked", message: "replyClaude requires workerKind:claude", operation: "claude_code_reply", at: nowIso(this.now), details: {} });
    return this.runDetailed(input);
  }

  /** DSH resume aliases are deliberately absent; DSH is fresh-start only. */
  async resumeDsh(): Promise<never> {
    throw new LocalBackendFailure({ code: "DSH_RESUME_FORBIDDEN", class: "blocked", message: "deepseek-harness has no resume operation; use a fresh start", operation: "claude_code_start", at: nowIso(this.now), details: {} });
  }

  private async invokeWorker(args: {
    taskId: string;
    workerKind: WorkerKind;
    instructionRef: { kind: string; ref: string };
    idempotencyKey: string;
    attemptId: string;
    binding: LocalWorkerBinding | undefined;
    inputRefs: DurableReference[];
  }): Promise<LocalWorkerReceipt> {
    const { taskId, workerKind, instructionRef, idempotencyKey, attemptId, binding, inputRefs } = args;
    if (workerKind === "claude") {
      const session = assertClaudeSession(binding?.claudeSession);
      if (!this.transport.claudeReply) return this.unavailableReceipt(taskId, workerKind, idempotencyKey, attemptId, inputRefs, "claude_code_reply");
      const request: LocalClaudeReplyRequest = {
        jobId: session.jobId,
        sessionId: session.sessionId,
        threadId: session.threadId ?? null,
        instruction_ref: instructionRef.ref,
        idempotency_key: idempotencyKey,
        backend: "claude",
        continuation: "claude_resume",
        executor: "claude"
      };
      let raw: unknown;
      try { raw = await this.transport.claudeReply(request); } catch (error) {
        return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: "claude_code_reply", continuation: "claude_resume", source: "claude_orchestrator", executor: "claude", detail: errorFromThrown(error, "claude_code_reply", this.now) });
      }
      const payload = unwrap(raw);
      const status = statusFrom(payload);
      const upstreamError = errorFromValue(raw, "claude_code_reply", this.now, "CLAUDE_REPLY_FAILED") ?? errorFromValue(payload, "claude_code_reply", this.now, "CLAUDE_REPLY_FAILED");
      const identityError = assertPayloadIdentity(payload, session, "claude_code_reply", this.now);
      const output = outputRefsAndError(payload, "claude_code_reply", status, this.now);
      const detail = upstreamError ?? identityError ?? output.error ?? (status === "needs_attention" ? {
        code: "WORKER_NEEDS_ATTENTION", class: "needs_attention" as const, message: "Claude reply requires supervisor attention", operation: "claude_code_reply", at: nowIso(this.now), details: {}
      } : status === "blocked" ? {
        code: "WORKER_BLOCKED", class: "blocked" as const, message: "Claude reply is blocked", operation: "claude_code_reply", at: nowIso(this.now), details: {}
      } : status === "unknown" ? {
        code: "WORKER_STATUS_UNKNOWN", class: "unknown", message: "Claude reply returned no recognized status", operation: "claude_code_reply", at: nowIso(this.now), details: {}
      } : null);
      return this.workerReceipt({ taskId, workerKind, idempotencyKey, attemptId, operation: "claude_code_reply", continuation: "claude_resume", source: "claude_orchestrator", executor: "claude", status: detail ? (status === "needs_attention" ? "needs_attention" : status === "unknown" ? "unknown" : "failed") : status, realJobId: session.jobId, realSessionRef: session, freshTurnRef: null, bridgeTaskId: null, inputRefs, outputRefs: output.outputRefs, deliverable: output.deliverable, evidenceRefs: evidenceRefsFrom(payload), detail });
    }

    if (workerKind === "dsh") {
      const checkpointRef = nonEmptyString(binding?.checkpointRef);
      if (!checkpointRef) return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: "claude_code_start", continuation: "dsh_fresh", source: "claude_orchestrator", executor: "dsh", detail: { code: "CHECKPOINT_REF_MISSING", class: "blocked", message: "DSH fresh start requires a checkpoint reference", operation: "claude_code_start", at: nowIso(this.now), details: {} } });
      if (!this.transport.dshFreshStart) return this.unavailableReceipt(taskId, workerKind, idempotencyKey, attemptId, inputRefs, "claude_code_start");
      const request: LocalDshFreshRequest = {
        instruction_ref: instructionRef.ref,
        checkpoint_ref: checkpointRef,
        idempotency_key: idempotencyKey,
        workerBackend: "deepseek-harness",
        continuation: "dsh_fresh",
        executor: "dsh"
      };
      let raw: unknown;
      try { raw = await this.transport.dshFreshStart(request); } catch (error) {
        return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: "claude_code_start", continuation: "dsh_fresh", source: "claude_orchestrator", executor: "dsh", detail: errorFromThrown(error, "claude_code_start", this.now) });
      }
      const payload = unwrap(raw);
      const status = statusFrom(payload);
      const fresh = extractFreshTurn(payload, "claude_code_start", this.now);
      const upstreamError = errorFromValue(raw, "claude_code_start", this.now, "DSH_START_FAILED") ?? errorFromValue(payload, "claude_code_start", this.now, "DSH_START_FAILED");
      const output = outputRefsAndError(payload, "claude_code_start", status, this.now);
      const detail = upstreamError ?? fresh.error ?? output.error ?? (status === "needs_attention" ? {
        code: "WORKER_NEEDS_ATTENTION", class: "needs_attention" as const, message: "DSH fresh start requires supervisor attention", operation: "claude_code_start", at: nowIso(this.now), details: {}
      } : status === "blocked" ? {
        code: "WORKER_BLOCKED", class: "blocked" as const, message: "DSH fresh start is blocked", operation: "claude_code_start", at: nowIso(this.now), details: {}
      } : status === "unknown" ? {
        code: "WORKER_STATUS_UNKNOWN", class: "unknown", message: "DSH fresh start returned no recognized status", operation: "claude_code_start", at: nowIso(this.now), details: {}
      } : null);
      return this.workerReceipt({ taskId, workerKind, idempotencyKey, attemptId, operation: "claude_code_start", continuation: "dsh_fresh", source: "claude_orchestrator", executor: "dsh", status: detail ? (status === "needs_attention" ? "needs_attention" : status === "unknown" ? "unknown" : "failed") : status, realJobId: fresh.ref?.jobId ?? null, realSessionRef: null, freshTurnRef: fresh.ref, bridgeTaskId: null, inputRefs, outputRefs: output.outputRefs, deliverable: output.deliverable, evidenceRefs: evidenceRefsFrom(payload), detail });
    }

    const workspaceId = nonEmptyString(binding?.workspaceId);
    if (!workspaceId) return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: "engineering-bridge:run_task", continuation: "dsh_fresh", source: "engineering-bridge", executor: "dsh", detail: { code: "WORKSPACE_ID_MISSING", class: "blocked", message: "Engineering Bridge worker call requires a registered workspace id", operation: "engineering-bridge:run_task", at: nowIso(this.now), details: {} } });
    if (!this.transport.bridgeRunTask) return this.unavailableReceipt(taskId, workerKind, idempotencyKey, attemptId, inputRefs, "engineering-bridge:run_task");
    const request: LocalBridgeWorkerRequest = {
      workspace_id: workspaceId,
      instruction: `${instructionRef.kind}:${instructionRef.ref}`,
      instruction_ref: { kind: instructionRef.kind, ref: instructionRef.ref },
      executor: "dsh",
      task_id: taskId,
      attempt_id: attemptId,
      idempotency_key: idempotencyKey
    };
    let raw: unknown;
    try { raw = await this.transport.bridgeRunTask(request); } catch (error) {
      return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding, inputRefs, operation: "engineering-bridge:run_task", continuation: "dsh_fresh", source: "engineering-bridge", executor: "dsh", detail: errorFromThrown(error, "engineering-bridge:run_task", this.now) });
    }
    const payload = unwrap(raw);
    const status = statusFrom(payload);
    const bridgeTaskId = idFrom(payload, "task_id", "taskId", "bridgeTaskId", "bridge_task_id", "jobId", "job_id", "id");
    const upstreamError = errorFromValue(raw, "engineering-bridge:run_task", this.now, "BRIDGE_RUN_FAILED") ?? errorFromValue(payload, "engineering-bridge:run_task", this.now, "BRIDGE_RUN_FAILED");
    const output = outputRefsAndError(payload, "engineering-bridge:run_task", status, this.now);
    const detail = upstreamError ?? output.error ?? (status === "needs_attention" ? {
      code: "WORKER_NEEDS_ATTENTION", class: "needs_attention" as const, message: "Engineering Bridge worker requires supervisor attention", operation: "engineering-bridge:run_task", at: nowIso(this.now), details: {}
    } : status === "blocked" ? {
      code: "WORKER_BLOCKED", class: "blocked" as const, message: "Engineering Bridge worker is blocked", operation: "engineering-bridge:run_task", at: nowIso(this.now), details: {}
    } : status === "unknown" ? {
      code: "WORKER_STATUS_UNKNOWN", class: "unknown", message: "Engineering Bridge returned no recognized status", operation: "engineering-bridge:run_task", at: nowIso(this.now), details: {}
    } : null);
    return this.workerReceipt({ taskId, workerKind, idempotencyKey, attemptId, operation: "engineering-bridge:run_task", continuation: "dsh_fresh", source: "engineering-bridge", executor: "dsh", status: detail ? (status === "needs_attention" ? "needs_attention" : status === "unknown" ? "unknown" : "failed") : status, realJobId: bridgeTaskId, realSessionRef: null, freshTurnRef: null, bridgeTaskId, inputRefs, outputRefs: output.outputRefs, deliverable: output.deliverable, evidenceRefs: evidenceRefsFrom(payload), detail });
  }

  private workerReceipt(args: Omit<LocalWorkerReceipt, "schemaVersion" | "requestId" | "ok" | "error" | "createdAt" | "evidenceLevel"> & { detail: LocalBackendError | null }): LocalWorkerReceipt {
    const { detail, ...rest } = args;
    return sanitizeRuntimeValue({
      schemaVersion: "continuity.local-worker-receipt.v1",
      requestId: `${rest.operation}-${randomUUID()}`,
      ...rest,
      ok: detail === null && ["queued", "running", "completed"].includes(rest.status),
      error: detail,
      evidenceLevel: this.evidenceLevel,
      createdAt: nowIso(this.now)
    });
  }

  private failedReceipt(args: {
    taskId: string;
    workerKind: WorkerKind;
    idempotencyKey: string;
    attemptId: string;
    binding: LocalWorkerBinding | undefined;
    inputRefs: DurableReference[];
    operation: LocalWorkerReceipt["operation"];
    continuation: ContinuationKind;
    source: LocalWorkerReceipt["source"];
    executor: LocalWorkerReceipt["executor"];
    detail: LocalBackendError;
  }): LocalWorkerReceipt {
    return this.workerReceipt({ ...args, status: args.detail.class === "needs_attention" ? "needs_attention" : args.detail.class === "unknown" ? "unknown" : "failed", realJobId: null, realSessionRef: null, freshTurnRef: null, bridgeTaskId: null, inputRefs: args.inputRefs, outputRefs: [], deliverable: null, evidenceRefs: [], detail: args.detail });
  }

  private unavailableReceipt(taskId: string, workerKind: WorkerKind, idempotencyKey: string, attemptId: string, inputRefs: DurableReference[], operation: LocalWorkerReceipt["operation"]): LocalWorkerReceipt {
    return this.failedReceipt({ taskId, workerKind, idempotencyKey, attemptId, binding: undefined, inputRefs, operation, continuation: operation === "claude_code_reply" ? "claude_resume" : "dsh_fresh", source: operation === "engineering-bridge:run_task" ? "engineering-bridge" : "claude_orchestrator", executor: operation === "claude_code_reply" ? "claude" : "dsh", detail: { code: "WORKER_BACKEND_UNAVAILABLE", class: "blocked", message: `no injected transport is available for ${operation}`, operation, at: nowIso(this.now), details: { evidenceLevel: "UNKNOWN" } } });
  }

  private async persist(receipt: LocalWorkerReceipt): Promise<void> {
    if (!this.options.receiptSink) return;
    try { await this.options.receiptSink.append(cloneJson(receipt)); } catch (error) {
      throw new LocalBackendFailure(errorFromThrown(error, "receipt_persist", this.now), receipt);
    }
  }
}

function operationFor(kind: WorkerKind): LocalWorkerReceipt["operation"] {
  return kind === "claude" ? "claude_code_reply" : kind === "bridge-dsh" ? "engineering-bridge:run_task" : "claude_code_start";
}

function continuationFor(kind: WorkerKind): ContinuationKind {
  return kind === "claude" ? "claude_resume" : "dsh_fresh";
}

function evidenceRefsFrom(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const raw = valueAt(payload, "evidenceRefs", "evidence_refs", "evidence");
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => typeof item === "string" ? item.trim() : isRecord(item) ? nonEmptyString(valueAt(item, "ref", "path", "id")) : null).filter((item): item is string => Boolean(item)))];
}

function patchIdempotencyKey(operation: LocalPatchReceipt["operation"], patchTaskId: string | null, input: unknown): string {
  const explicit = isRecord(input) ? nonEmptyString(valueAt(input, "idempotencyKey", "idempotency_key")) : null;
  return explicit ?? `patch-${operation}-${patchTaskId ?? "unknown"}-${sha256(input).slice(-16)}`;
}

export interface LocalPatchTransport {
  propose?: (input: BridgePatchGenerateInput & { executor: "dsh" }) => unknown | Promise<unknown>;
  validate?: (input: BridgePatchValidateInput) => unknown | Promise<unknown>;
  apply?: (input: BridgePatchApplyInput) => unknown | Promise<unknown>;
  commit?: (input: BridgePatchCommitInput) => unknown | Promise<unknown>;
}

export interface LocalPatchReceipt {
  schemaVersion: "continuity.local-patch-receipt.v1";
  requestId: string;
  idempotencyKey: string;
  operation: "propose" | "validate" | "apply" | "commit";
  patchTaskId: string | null;
  workspaceId: string | null;
  executor: "dsh";
  status: LocalOperationStatus;
  ok: boolean;
  baseHead: string | null;
  diffRef: DurableReference | null;
  diffHash: string | null;
  /** The attempted literal is retained even when it is rejected. */
  confirmation: string | null;
  changedFiles: string[];
  applyReceiptId: string | null;
  commitHash: string | null;
  commitReceiptId: string | null;
  error: LocalBackendError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  createdAt: string;
}

export interface LocalPatchBackendOptions {
  transport?: LocalPatchTransport;
  /** Required for all successful calls; tests must pass an explicit store. */
  durableStore?: LocalDurableStore;
  receiptSink?: LocalReceiptSink;
  now?: () => Date;
  evidenceLevel?: "MOCK_PASS" | "UNKNOWN";
}

export const LOCAL_PATCH_BACKEND_WAVE_C_GAPS = [
  "Wave C must bind this transport to EngineeringBridgeAdapter's generate/validate/apply/commit methods; B3 does not construct a child MCP client.",
  "Wave C must inject the same process-safe LocalDurableStore across adapter restarts and forward the server idempotency/confirmation context when extending the shared seam.",
  "The shared PatchBackend propose result has no patch receipt/task id, so B3 keeps the structured receipt in its local ledger and accepts the server-issued patchTaskId on validate/apply/commit.",
  "COMMIT is never called from apply; only commitWithConfirmation with exact COMMIT may reach the injected commit transport."
] as const;

export class LocalPatchBackend implements PatchBackend {
  private readonly transport: LocalPatchTransport;
  private readonly durableStore: LocalDurableStore | undefined;
  private readonly now: () => Date;
  private readonly evidenceLevel: "MOCK_PASS" | "UNKNOWN";

  constructor(private readonly options: LocalPatchBackendOptions = {}) {
    this.transport = options.transport ?? {};
    this.durableStore = options.durableStore;
    this.now = options.now ?? (() => new Date());
    this.evidenceLevel = options.evidenceLevel ?? "MOCK_PASS";
  }

  async propose(input: Parameters<PatchBackend["propose"]>[0]): Promise<{ diff: string; baseHead: string }> {
    const changeRequest = input.changeRequest;
    const workspaceId = nonEmptyString(changeRequest.workspaceId ?? changeRequest.workspace_id);
    const baseHead = nonEmptyString(changeRequest.baseHead ?? changeRequest.base_head);
    const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey");
    if (input.executor !== "dsh" && input.executor !== "bridge-dsh") throw new LocalBackendFailure({ code: "ROUTING_REJECTED", class: "blocked", message: "Engineering Bridge controlled patches require explicit executor:dsh", operation: "propose", at: nowIso(this.now), details: { executor: input.executor } });
    if (!workspaceId || !baseHead) throw new LocalBackendFailure({ code: "PATCH_INPUT_INVALID", class: "blocked", message: "controlled patch requires workspaceId and baseHead", operation: "propose", at: nowIso(this.now), details: {} });
    const store = this.durableStore;
    if (!store) throw new LocalBackendFailure({ code: "DURABLE_STORE_UNAVAILABLE", class: "blocked", message: "patch backend requires an injected durable store", operation: "propose", at: nowIso(this.now), details: { productionFailClosed: true } });
    const payloadHash = sha256({ changeRequest, executor: input.executor, idempotencyKey });
    const prior = store.getPatchAttempt(idempotencyKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new LocalBackendFailure({ code: "IDEMPOTENCY_KEY_REUSED", class: "blocked", message: "patch idempotency key was already used with a different proposal", operation: "propose", at: nowIso(this.now), details: { idempotencyKey } }, prior.receipt);
      if (prior.failure) throw new LocalBackendFailure(prior.failure, prior.receipt);
      if (prior.diff !== null && prior.receipt.baseHead) return { diff: prior.diff, baseHead: prior.receipt.baseHead };
    }
    if (!this.transport.propose) {
      const detail: LocalBackendError = { code: "PATCH_BACKEND_UNAVAILABLE", class: "blocked", message: "no injected controlled-patch transport is available", operation: "propose", at: nowIso(this.now), details: { evidenceLevel: "UNKNOWN" } };
      const receipt = this.patchReceipt({ idempotencyKey, operation: "propose", patchTaskId: null, workspaceId, status: "failed", baseHead: null, diffRef: null, changedFiles: [], applyReceiptId: null, commitHash: null, commitReceiptId: null, detail });
      store.putPatchAttempt(idempotencyKey, { payloadHash, receipt, failure: detail, diff: null, diffHash: null, patchTaskId: null, workspaceId, baseHead: null, applied: false, committed: false, verdict: null, applyReceiptId: null, commitHash: null, commitReceiptId: null });
      await this.persist(receipt);
      throw new LocalBackendFailure(detail, receipt);
    }
    let raw: unknown;
    try {
      const request: BridgePatchGenerateInput & { executor: "dsh" } = { workspace_id: workspaceId, change_request: JSON.stringify(changeRequest), executor: "dsh", idempotency_key: idempotencyKey };
      raw = await this.transport.propose(request);
    } catch (error) {
      const detail = errorFromThrown(error, "propose", this.now);
      const receipt = this.patchReceipt({ idempotencyKey, operation: "propose", patchTaskId: null, workspaceId, status: "failed", baseHead: null, diffRef: null, changedFiles: [], applyReceiptId: null, commitHash: null, commitReceiptId: null, detail });
      store.putPatchAttempt(idempotencyKey, { payloadHash, receipt, failure: detail, diff: null, diffHash: null, patchTaskId: null, workspaceId, baseHead: null, applied: false, committed: false, verdict: null, applyReceiptId: null, commitHash: null, commitReceiptId: null });
      await this.persist(receipt);
      throw new LocalBackendFailure(detail, receipt);
    }
    const payload = unwrap(raw);
    // A diff is an opaque byte sequence. Do not trim or normalize it.
    const diff = isRecord(payload) && typeof valueAt(payload, "diff") === "string" && (valueAt(payload, "diff") as string).length > 0 ? valueAt(payload, "diff") as string : null;
    const returnedBaseHead = idFrom(payload, "baseHead", "base_head") ?? baseHead;
    const patchTaskId = idFrom(payload, "patchTaskId", "patch_task_id", "id");
    const rawStatus = statusFrom(payload);
    const status = rawStatus === "unknown" && diff ? "completed" : rawStatus;
    const upstreamError = errorFromValue(raw, "propose", this.now, "PATCH_PROPOSE_FAILED") ?? errorFromValue(payload, "propose", this.now, "PATCH_PROPOSE_FAILED");
    const detail = upstreamError ?? (!diff ? { code: "PATCH_DIFF_MISSING", class: "unknown" as const, message: "controlled patch proposal did not return a diff", operation: "propose", at: nowIso(this.now), details: {} } : null);
    const diffRef = diff ? { path: patchTaskId ? `patch://${patchTaskId}/diff/${sha256(diff).slice(-16)}` : `patch://proposal/diff/${sha256(diff).slice(-16)}`, hash: sha256(diff), exists: true, resultStatus: "present" as const } : null;
    const receipt = this.patchReceipt({ idempotencyKey, operation: "propose", patchTaskId, workspaceId, status: detail ? "failed" : status === "unknown" ? "unknown" : "completed", baseHead: returnedBaseHead, diffRef, changedFiles: [], applyReceiptId: null, commitHash: null, commitReceiptId: null, detail });
    store.putPatchAttempt(idempotencyKey, { payloadHash, receipt: cloneJson(receipt), failure: detail, diff: diff ?? null, diffHash: diff ? sha256(diff) : null, patchTaskId, workspaceId, baseHead: returnedBaseHead, applied: false, committed: false, verdict: null, applyReceiptId: null, commitHash: null, commitReceiptId: null });
    if (patchTaskId && diff) {
      store.putPatchTask(patchTaskId, { payloadHash, receipt: cloneJson(receipt), failure: detail, diff, diffHash: sha256(diff), patchTaskId, workspaceId, baseHead: returnedBaseHead, applied: false, committed: false, verdict: null, applyReceiptId: null, commitHash: null, commitReceiptId: null });
    }
    await this.persist(receipt);
    if (detail || !diff) throw new LocalBackendFailure(detail ?? { code: "PATCH_DIFF_MISSING", class: "unknown", message: "controlled patch proposal did not return a diff", operation: "propose", at: nowIso(this.now), details: {} }, receipt);
    return { diff, baseHead: returnedBaseHead };
  }

  async validate(input: Parameters<PatchBackend["validate"]>[0]): Promise<{ verdict: "PASS" | "FAIL" | "INCOMPLETE"; reasons: string[] }> {
    const patchTaskId = nonEmptyString(input.patchTaskId);
    const store = this.durableStore;
    if (!store) throw new LocalBackendFailure({ code: "DURABLE_STORE_UNAVAILABLE", class: "blocked", message: "patch backend requires an injected durable store", operation: "validate", at: nowIso(this.now), details: { productionFailClosed: true } });
    if (!patchTaskId) throw await this.patchFailure("validate", "PATCH_INPUT_INVALID", "patchTaskId is required", "blocked", null);
    let state = store.getPatchTask(patchTaskId);
    // The shared server currently generates its own patchTaskId after
    // propose, so bind that alias only when the exact diff identifies one and
    // only one durable proposal. Ambiguous matches remain fail-closed.
    if (!state) {
      const candidates = store.findPatchByDiffHash(sha256(input.diff)).filter((candidate) => candidate.diff === input.diff);
      const candidate = candidates[0];
      if (candidate) {
        state = { ...candidate, patchTaskId };
        store.putPatchTask(patchTaskId, state);
      }
    }
    if (!state || state.diff === null || state.diffHash === null) throw await this.patchFailure("validate", "PATCH_PROPOSAL_NOT_FOUND", "patch proposal is not durably bound to this patch task", "blocked", patchTaskId);
    // Validate consumes the exact proposal bytes. No trim, normalization, or
    // line-ending conversion is permitted here.
    if (input.diff !== state.diff || sha256(input.diff) !== state.diffHash) throw await this.patchFailure("validate", "PATCH_DIFF_MISMATCH", "validation diff does not exactly match the proposed diff", "blocked", patchTaskId, { expectedDiffHash: state.diffHash, receivedDiffHash: sha256(input.diff) });
    if (!this.transport.validate) throw await this.patchFailure("validate", "PATCH_BACKEND_UNAVAILABLE", "no injected controlled-patch transport is available", "blocked", patchTaskId);
    let raw: unknown;
    try { raw = await this.transport.validate({ workspace_id: state.workspaceId ?? "", patch_task_id: patchTaskId }); } catch (error) { throw await this.patchFailure("validate", "PATCH_VALIDATE_FAILED", error instanceof Error ? error.message : String(error), errorClassFrom("PATCH_VALIDATE_FAILED", undefined, String(error)), patchTaskId); }
    const payload = unwrap(raw);
    const verdictValue = idFrom(payload, "verdict", "status");
    const verdict = verdictValue === "PASS" || verdictValue === "FAIL" || verdictValue === "INCOMPLETE" ? verdictValue : null;
    const reasonsRaw = isRecord(payload) ? valueAt(payload, "reasons", "reason") : undefined;
    const reasons = Array.isArray(reasonsRaw) ? reasonsRaw.map((item) => String(item)) : reasonsRaw === undefined ? [] : [String(reasonsRaw)];
    const error = errorFromValue(raw, "validate", this.now, "PATCH_VALIDATE_FAILED") ?? errorFromValue(payload, "validate", this.now, "PATCH_VALIDATE_FAILED");
    if (!verdict || error) throw await this.patchFailure("validate", error?.code ?? "PATCH_VERDICT_MISSING", error?.message ?? "controlled patch did not return PASS/FAIL/INCOMPLETE", error?.class ?? "unknown", patchTaskId, error?.details);
    const next: DurablePatchAttemptRecord = { ...state, verdict };
    store.putPatchTask(patchTaskId, next);
    const receipt = this.patchReceipt({ idempotencyKey: `patch-validate-${patchTaskId}`, operation: "validate", patchTaskId, workspaceId: state.workspaceId, status: "completed", baseHead: state.baseHead, diffRef: state.receipt.diffRef, diffHash: state.diffHash, confirmation: null, changedFiles: [], applyReceiptId: null, commitHash: null, commitReceiptId: null, detail: null });
    await this.persistPatchReceipt(receipt);
    return { verdict, reasons };
  }

  async apply(input: Parameters<PatchBackend["apply"]>[0]): Promise<{ changedFiles: string[]; applyReceiptId: string }> {
    const suppliedConfirmation = (input as Parameters<PatchBackend["apply"]>[0] & { confirmation?: unknown }).confirmation;
    if (suppliedConfirmation !== undefined && suppliedConfirmation !== "APPLY") throw await this.patchFailure("apply", "APPLY_CONFIRMATION_REQUIRED", "controlled patch apply requires exact confirmation APPLY", "blocked", input.patchTaskId, { confirmation: suppliedConfirmation }, { confirmation: String(suppliedConfirmation) });
    return this.applyInternal(input, "APPLY");
  }

  async applyWithConfirmation(input: Parameters<PatchBackend["apply"]>[0] & { confirmation: string; workspaceId?: string }): Promise<{ changedFiles: string[]; applyReceiptId: string }> {
    if (input.confirmation !== "APPLY") throw await this.patchFailure("apply", "APPLY_CONFIRMATION_REQUIRED", "controlled patch apply requires exact confirmation APPLY", "blocked", input.patchTaskId, { confirmation: input.confirmation }, { confirmation: input.confirmation });
    return this.applyInternal(input, "APPLY", input.workspaceId);
  }

  private async applyInternal(input: Parameters<PatchBackend["apply"]>[0], confirmation: "APPLY", workspaceId = ""): Promise<{ changedFiles: string[]; applyReceiptId: string }> {
    const patchTaskId = nonEmptyString(input.patchTaskId);
    const store = this.durableStore;
    if (!store) throw await this.patchFailure("apply", "DURABLE_STORE_UNAVAILABLE", "patch backend requires an injected durable store", "blocked", patchTaskId, { productionFailClosed: true });
    if (!patchTaskId) throw await this.patchFailure("apply", "PATCH_INPUT_INVALID", "patchTaskId is required", "blocked", null);
    const state = store.getPatchTask(patchTaskId);
    if (!state || state.diff === null || state.diffHash === null) throw await this.patchFailure("apply", "PATCH_PROPOSAL_NOT_FOUND", "patch proposal is not durably bound to this patch task", "blocked", patchTaskId, {}, { confirmation });
    if (state.verdict !== "PASS") throw await this.patchFailure("apply", "PATCH_NOT_VALIDATED", `patch verdict is ${state.verdict ?? "unvalidated"}; only PASS may be applied`, "blocked", patchTaskId, {}, { confirmation });
    if (state.applied) throw await this.patchFailure("apply", "PATCH_ALREADY_APPLIED", "patch was already applied", "blocked", patchTaskId, {}, { confirmation });
    // Exact byte and hash checks protect the APPLY gate from a substituted
    // diff, including differences that only affect a final newline.
    if (input.diff !== state.diff || sha256(input.diff) !== state.diffHash) throw await this.patchFailure("apply", "PATCH_DIFF_MISMATCH", "apply diff does not exactly match the proposed diff", "blocked", patchTaskId, { expectedDiffHash: state.diffHash, receivedDiffHash: sha256(input.diff) }, { confirmation });
    if (!this.transport.apply) throw await this.patchFailure("apply", "PATCH_BACKEND_UNAVAILABLE", "no injected controlled-patch transport is available", "blocked", patchTaskId, {}, { confirmation });
    let raw: unknown;
    try { raw = await this.transport.apply({ workspace_id: workspaceId || state.workspaceId || "", patch_task_id: patchTaskId, confirmation }); } catch (error) { throw await this.patchFailure("apply", "PATCH_APPLY_FAILED", error instanceof Error ? error.message : String(error), errorClassFrom("PATCH_APPLY_FAILED", undefined, String(error)), patchTaskId, {}, { confirmation }); }
    const payload = unwrap(raw);
    const applyReceiptId = idFrom(payload, "applyReceiptId", "apply_receipt_id", "receiptId", "receipt_id");
    const filesRaw = isRecord(payload) ? valueAt(payload, "changedFiles", "changed_files", "files") : undefined;
    const changedFiles = Array.isArray(filesRaw) ? filesRaw.map(String) : [];
    const error = errorFromValue(raw, "apply", this.now, "PATCH_APPLY_FAILED") ?? errorFromValue(payload, "apply", this.now, "PATCH_APPLY_FAILED");
    if (!applyReceiptId || error) throw await this.patchFailure("apply", error?.code ?? "APPLY_RECEIPT_MISSING", error?.message ?? "controlled patch apply did not return an apply receipt", error?.class ?? "unknown", patchTaskId, error?.details, { confirmation, changedFiles });
    const next = { ...state, applied: true, applyReceiptId };
    store.putPatchTask(patchTaskId, next);
    const receipt = this.patchReceipt({ idempotencyKey: patchIdempotencyKey("apply", patchTaskId, input), operation: "apply", patchTaskId, workspaceId: next.workspaceId, status: "completed", baseHead: next.baseHead, diffRef: next.receipt.diffRef, diffHash: next.diffHash, confirmation, changedFiles, applyReceiptId, commitHash: null, commitReceiptId: null, detail: null });
    await this.persistPatchReceipt(receipt);
    return { changedFiles, applyReceiptId };
  }

  async commit(input: Parameters<PatchBackend["commit"]>[0]): Promise<{ commitHash: string; commitReceiptId: string }> {
    const suppliedConfirmation = (input as Parameters<PatchBackend["commit"]>[0] & { confirmation?: unknown }).confirmation;
    if (suppliedConfirmation !== undefined && suppliedConfirmation !== "COMMIT") throw await this.patchFailure("commit", "COMMIT_CONFIRMATION_REQUIRED", "controlled patch commit requires exact confirmation COMMIT", "blocked", input.patchTaskId, { confirmation: suppliedConfirmation }, { confirmation: String(suppliedConfirmation) });
    return this.commitInternal(input, "COMMIT");
  }

  async commitWithConfirmation(input: Parameters<PatchBackend["commit"]>[0] & { confirmation: string; workspaceId?: string }): Promise<{ commitHash: string; commitReceiptId: string }> {
    if (input.confirmation !== "COMMIT") throw await this.patchFailure("commit", "COMMIT_CONFIRMATION_REQUIRED", "controlled patch commit requires exact confirmation COMMIT", "blocked", input.patchTaskId, { confirmation: input.confirmation }, { confirmation: input.confirmation });
    return this.commitInternal(input, "COMMIT", input.workspaceId);
  }

  private async commitInternal(input: Parameters<PatchBackend["commit"]>[0], confirmation: "COMMIT", workspaceId = ""): Promise<{ commitHash: string; commitReceiptId: string }> {
    const patchTaskId = nonEmptyString(input.patchTaskId);
    const store = this.durableStore;
    if (!store) throw await this.patchFailure("commit", "DURABLE_STORE_UNAVAILABLE", "patch backend requires an injected durable store", "blocked", patchTaskId, { productionFailClosed: true });
    if (!patchTaskId) throw await this.patchFailure("commit", "PATCH_INPUT_INVALID", "patchTaskId is required", "blocked", null);
    const state = store.getPatchTask(patchTaskId);
    if (!state || state.diff === null || state.diffHash === null) throw await this.patchFailure("commit", "PATCH_PROPOSAL_NOT_FOUND", "patch proposal is not durably bound to this patch task", "blocked", patchTaskId, {}, { confirmation });
    if (!state.applied) throw await this.patchFailure("commit", "PATCH_NOT_APPLIED", "commit is a separate gate and requires a prior successful APPLY", "blocked", patchTaskId, {}, { confirmation });
    if (state.committed) throw await this.patchFailure("commit", "PATCH_ALREADY_COMMITTED", "patch was already committed", "blocked", patchTaskId, {}, { confirmation });
    if (!this.transport.commit) throw await this.patchFailure("commit", "PATCH_BACKEND_UNAVAILABLE", "no injected controlled-patch transport is available", "blocked", patchTaskId, {}, { confirmation });
    let raw: unknown;
    try { raw = await this.transport.commit({ workspace_id: workspaceId || state.workspaceId || "", patch_task_id: patchTaskId, message: input.message, confirmation }); } catch (error) { throw await this.patchFailure("commit", "PATCH_COMMIT_FAILED", error instanceof Error ? error.message : String(error), errorClassFrom("PATCH_COMMIT_FAILED", undefined, String(error)), patchTaskId, {}, { confirmation }); }
    const payload = unwrap(raw);
    const commitHash = idFrom(payload, "commitHash", "commit_hash", "hash");
    const commitReceiptId = idFrom(payload, "commitReceiptId", "commit_receipt_id", "receiptId", "receipt_id");
    const error = errorFromValue(raw, "commit", this.now, "PATCH_COMMIT_FAILED") ?? errorFromValue(payload, "commit", this.now, "PATCH_COMMIT_FAILED");
    if (!commitHash || !commitReceiptId || error) throw await this.patchFailure("commit", error?.code ?? "COMMIT_RECEIPT_MISSING", error?.message ?? "controlled patch commit did not return commit hash and receipt", error?.class ?? "unknown", patchTaskId, error?.details, { confirmation });
    const next = { ...state, committed: true, commitHash, commitReceiptId };
    store.putPatchTask(patchTaskId, next);
    const receipt = this.patchReceipt({ idempotencyKey: patchIdempotencyKey("commit", patchTaskId, input), operation: "commit", patchTaskId, workspaceId: next.workspaceId, status: "completed", baseHead: next.baseHead, diffRef: next.receipt.diffRef, diffHash: next.diffHash, confirmation, changedFiles: [], applyReceiptId: next.applyReceiptId, commitHash, commitReceiptId, detail: null });
    await this.persistPatchReceipt(receipt);
    return { commitHash, commitReceiptId };
  }

  private patchReceipt(args: { idempotencyKey: string; operation: LocalPatchReceipt["operation"]; patchTaskId: string | null; workspaceId: string | null; status: LocalOperationStatus; baseHead: string | null; diffRef: DurableReference | null; diffHash?: string | null; confirmation?: string | null; changedFiles: string[]; applyReceiptId: string | null; commitHash: string | null; commitReceiptId: string | null; detail: LocalBackendError | null }): LocalPatchReceipt {
    return sanitizeRuntimeValue({ schemaVersion: "continuity.local-patch-receipt.v1", requestId: `patch-${randomUUID()}`, idempotencyKey: args.idempotencyKey, operation: args.operation, patchTaskId: args.patchTaskId, workspaceId: args.workspaceId, executor: "dsh", status: args.status, ok: args.detail === null, baseHead: args.baseHead, diffRef: args.diffRef, diffHash: args.diffHash ?? args.diffRef?.hash ?? null, confirmation: args.confirmation ?? null, changedFiles: [...args.changedFiles], applyReceiptId: args.applyReceiptId, commitHash: args.commitHash, commitReceiptId: args.commitReceiptId, error: args.detail, evidenceLevel: this.evidenceLevel, createdAt: nowIso(this.now) });
  }

  private async patchFailure(operation: LocalPatchReceipt["operation"], code: string, message: string, errorClass: LocalBackendErrorClass, patchTaskId: string | null, details: Record<string, unknown> = {}, receiptExtra: { confirmation?: string; changedFiles?: string[] } = {}): Promise<never> {
    const detail: LocalBackendError = { code, class: errorClass, message, operation, at: nowIso(this.now), details: { patchTaskId, ...details } };
    const state = patchTaskId && this.durableStore ? this.durableStore.getPatchTask(patchTaskId) : undefined;
    const receipt = this.patchReceipt({ idempotencyKey: patchIdempotencyKey(operation, patchTaskId, details), operation, patchTaskId, workspaceId: state?.workspaceId ?? null, status: "failed", baseHead: state?.baseHead ?? null, diffRef: state?.receipt.diffRef ?? null, diffHash: state?.diffHash ?? null, confirmation: receiptExtra.confirmation ?? null, changedFiles: receiptExtra.changedFiles ?? [], applyReceiptId: state?.applyReceiptId ?? null, commitHash: state?.commitHash ?? null, commitReceiptId: state?.commitReceiptId ?? null, detail });
    await this.persistPatchReceipt(receipt);
    throw new LocalBackendFailure(detail, receipt);
  }

  private async persistPatchReceipt(receipt: LocalPatchReceipt): Promise<void> {
    this.durableStore?.appendPatchReceipt(receipt);
    await this.persist(receipt);
  }

  private async persist(receipt: LocalPatchReceipt): Promise<void> {
    if (!this.options.receiptSink) return;
    try { await this.options.receiptSink.append(cloneJson(receipt)); } catch (error) { throw new LocalBackendFailure(errorFromThrown(error, "receipt_persist", this.now), receipt); }
  }
}
