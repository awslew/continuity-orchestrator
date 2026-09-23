import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type {
  FreshTurnRef,
  RealSessionRef,
  StructuredAdapterError,
  WorkerEvidence,
  WorkerReceipt,
  WorkerReceiptStatus
} from "./adapter-types.js";
import { structuredAdapterError } from "./adapter-types.js";

export type ExternalAssetsStatus = "LOCATED" | "NOT_LOCATED";
export type OrchestratorTransportKind = "mock" | "real";

export interface ClaudeReplyRequest {
  jobId: string;
  sessionId: string;
  threadId: string | null;
  instruction_ref: string;
  idempotency_key: string;
  backend: "claude";
}

export interface DshFreshStartRequest {
  instruction_ref: string;
  checkpoint_ref: string;
  idempotency_key: string;
  workerBackend: "deepseek-harness";
}

/** Injected seam; no CLI, network, or real worker is started by this adapter. */
export interface ClaudeOrchestratorTransport {
  reply?: (request: ClaudeReplyRequest) => unknown | Promise<unknown>;
  start?: (request: DshFreshStartRequest) => unknown | Promise<unknown>;
  claude_code_reply?: (request: ClaudeReplyRequest) => unknown | Promise<unknown>;
  claude_code_start?: (request: DshFreshStartRequest) => unknown | Promise<unknown>;
}

export interface ClaudeOrchestratorHttpConfig {
  /** Explicit local/loopback endpoint; no endpoint is guessed. */
  baseUrl: string;
  /** Explicit operation paths so an API shape change cannot be hidden. */
  replyPath: string;
  startPath: string;
  timeoutMs: number;
  /** Token is read at runtime and is never written to a receipt/config dump. */
  token?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;
}

/**
 * Explicit HTTP seam for a local claude_orchestrator relay.  Construction is
 * side-effect free; requests happen only when a worker operation is invoked.
 * A missing/invalid upstream response is returned as a structured failure so
 * the higher adapter can preserve its real-session/fresh-turn rules.
 */
export class ClaudeOrchestratorHttpTransport implements ClaudeOrchestratorTransport {
  private readonly baseUrl: string;
  private readonly replyPath: string;
  private readonly startPath: string;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;

  constructor(config: ClaudeOrchestratorHttpConfig) {
    let base: URL;
    try { base = new URL(config.baseUrl); } catch { throw new Error("claude baseUrl must be an absolute http(s) URL"); }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("claude baseUrl must use http or https");
    if (!nonEmptyString(config.replyPath) || !nonEmptyString(config.startPath)) throw new Error("claude replyPath and startPath are required");
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30 * 60 * 1_000) throw new Error("claude timeoutMs is outside the allowed range");
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.replyPath = config.replyPath.trim();
    this.startPath = config.startPath.trim();
    this.timeoutMs = config.timeoutMs;
    this.token = nonEmptyString(config.token) ?? undefined;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  reply(request: ClaudeReplyRequest): Promise<unknown> {
    return this.post(this.replyPath, request);
  }

  claude_code_reply(request: ClaudeReplyRequest): Promise<unknown> {
    return this.reply(request);
  }

  start(request: DshFreshStartRequest): Promise<unknown> {
    return this.post(this.startPath, request);
  }

  claude_code_start(request: DshFreshStartRequest): Promise<unknown> {
    return this.start(request);
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const pathValue = path.startsWith("/") ? path : `/${path}`;
      const response = await this.fetchImpl(`${this.baseUrl}${pathValue}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw.trim() ? JSON.parse(raw) : null; } catch { parsed = { error: { code: "WORKER_RESPONSE_INVALID", message: "claude_orchestrator returned non-JSON" } }; }
      if (!response.ok) return { error: { code: `HTTP_${response.status}`, message: "claude_orchestrator request failed" }, result: parsed };
      return parsed;
    } catch (error) {
      const code = (error as { name?: unknown })?.name === "AbortError" ? "WORKER_TIMEOUT" : "WORKER_TRANSPORT_FAILED";
      return { error: { code, message: "claude_orchestrator transport request failed" } };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ClaudeOrchestratorOptions {
  transport: ClaudeOrchestratorTransport;
  /** `NOT_LOCATED` blocks only real calls; injected mock tests remain local. */
  externalAssetsStatus?: ExternalAssetsStatus;
  assetsStatus?: ExternalAssetsStatus;
  transportKind?: OrchestratorTransportKind;
  runtime?: OrchestratorTransportKind;
}

export interface ResumeClaudeInput {
  task_id?: string;
  attempt_id?: string;
  session: RealSessionRef;
  instruction_ref: string;
  idempotency_key?: string;
}

export interface StartDshFreshInput {
  task_id?: string;
  attempt_id?: string;
  instruction_ref: string;
  checkpoint_ref: string;
  idempotency_key?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function valueAt(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.result !== undefined) return unwrap(value.result);
  if (value.data !== undefined) return unwrap(value.data);
  return value;
}

function redacted(value: string): string {
  return value
    .replace(/(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|API[_ -]?KEY|AUTHORIZATION|BEARER|COOKIE|SESSION[_ -]?TOKEN|ACCESS[_ -]?TOKEN|SECRET)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

function statusFrom(payload: unknown): { status: WorkerReceiptStatus; external: WorkerReceipt["externalStatus"]; workerStatus: WorkerReceipt["workerStatus"] } {
  const rawState = isRecord(payload) ? valueAt(payload, "state", "status") : undefined;
  const state = typeof rawState === "string"
    ? rawState.toLowerCase()
    : "unknown";
  if (isRecord(payload) && valueAt(payload, "partial_output", "partialOutput") !== undefined) return { status: "partial_output", external: "partial_output", workerStatus: "failed" };
  if (state === "queued") return { status: "queued", external: "queued", workerStatus: "queued" };
  if (state === "running") return { status: "running", external: "running", workerStatus: "running" };
  if (state === "waiting_for_supervisor_review" || state === "review") return { status: "review", external: "waiting_for_supervisor_review", workerStatus: "review" };
  if (state === "completed" || state === "success") return { status: "completed", external: "completed", workerStatus: "completed" };
  if (state === "failed" || state === "error") return { status: "failed", external: "failed", workerStatus: "failed" };
  if (isRecord(payload) && /evidence[-_ ]drop/i.test(JSON.stringify(payload))) return { status: "evidence_drop", external: "evidence-drop", workerStatus: "failed" };
  if (isRecord(payload) && (nonEmptyString(valueAt(payload, "jobId", "job_id", "turnId", "turn_id", "freshTurnId", "fresh_turn_id")) !== null)) return { status: "attempt", external: "queued", workerStatus: "queued" };
  return { status: "unknown", external: "unknown", workerStatus: "unknown" };
}

function evidenceFrom(payload: unknown): { evidence: WorkerEvidence[]; refs: string[]; drop: WorkerReceipt["evidenceDrop"] } {
  const evidence: WorkerEvidence[] = [];
  const refs: string[] = [];
  const raw = isRecord(payload) ? valueAt(payload, "evidence", "evidence_refs", "evidenceRefs") : undefined;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const ref = typeof item === "string" ? nonEmptyString(item) : isRecord(item) ? nonEmptyString(valueAt(item, "ref", "id", "path")) : null;
      if (!ref) continue;
      const clean = redacted(ref);
      refs.push(clean);
      evidence.push({ kind: "evidence", ref: clean, complete: true, redacted: true });
    }
  }
  const dropValue = isRecord(payload) ? valueAt(payload, "evidence_drop", "evidenceDrop") : undefined;
  const dropCount = isRecord(dropValue) && typeof dropValue.dropped === "number" ? dropValue.dropped : 0;
  const detected = dropCount > 0 || (typeof payload === "string" && /evidence[-_ ]drop/i.test(payload)) || (isRecord(payload) && /evidence[-_ ]drop/i.test(JSON.stringify(payload)));
  const drop = detected ? {
    kind: "evidence-drop" as const,
    dropped: dropCount > 0 ? dropCount : 1,
    reason: isRecord(dropValue) && typeof dropValue.reason === "string" ? redacted(dropValue.reason) : "upstream evidence was truncated or dropped",
    marker: "evidence-drop" as const
  } : null;
  if (drop) evidence.push({ kind: "evidence_drop", ref: "evidence-drop", complete: false, redacted: true });
  return { evidence, refs: [...new Set(refs)], drop };
}

function responseError(payload: unknown, operation: string): StructuredAdapterError | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = typeof payload.error.code === "string" ? payload.error.code : "WORKER_FAILED";
  const message = typeof payload.error.message === "string" ? redacted(payload.error.message) : "Worker returned a structured error";
  return structuredAdapterError(code, "unknown", message, operation);
}

function validateSession(value: RealSessionRef): RealSessionRef {
  if (!value || value.kind !== "real_session" || value.backend !== "claude" || value.source !== "claude_orchestrator" || !nonEmptyString(value.jobId) || !nonEmptyString(value.sessionId) || (value.threadId !== undefined && value.threadId !== null && !nonEmptyString(value.threadId))) {
    throw new DomainError("ROUTING_REJECTED", "Claude resume requires a real claude_orchestrator session reference");
  }
  return { ...value, jobId: value.jobId.trim(), sessionId: value.sessionId.trim(), threadId: value.threadId === undefined || value.threadId === null ? null : value.threadId.trim() };
}

function extractRealSession(payload: unknown, requested: RealSessionRef): { ref: RealSessionRef; error: StructuredAdapterError | null } {
  const record = isRecord(payload) ? payload : {};
  const returnedJob = nonEmptyString(valueAt(record, "jobId", "job_id", "realJobId", "real_job_id"));
  const returnedSession = nonEmptyString(valueAt(record, "sessionId", "session_id"));
  const returnedThreadValue = valueAt(record, "threadId", "thread_id");
  const returnedThread = returnedThreadValue === null || returnedThreadValue === undefined ? null : nonEmptyString(returnedThreadValue);
  if ((returnedJob && returnedJob !== requested.jobId) || (returnedSession && returnedSession !== requested.sessionId) || (returnedThread && requested.threadId && returnedThread !== requested.threadId)) {
    return {
      ref: requested,
      error: structuredAdapterError("SESSION_REF_MISMATCH", "blocked", "Claude reply returned a different session identity", "claude_code_reply", { requestedJobId: requested.jobId, returnedJobId: returnedJob, requestedSessionId: requested.sessionId, returnedSessionId: returnedSession })
    };
  }
  return { ref: requested, error: null };
}

function extractFreshTurn(payload: unknown): { ref: FreshTurnRef | null; error: StructuredAdapterError | null } {
  if (!isRecord(payload)) return { ref: null, error: structuredAdapterError("FRESH_TURN_ID_MISSING", "reconcile_required", "DSH fresh start did not return a structured turn reference", "claude_code_start") };
  const forbiddenSession = valueAt(payload, "sessionId", "session_id");
  const forbiddenThread = valueAt(payload, "threadId", "thread_id");
  if ((forbiddenSession !== undefined && forbiddenSession !== null && nonEmptyString(forbiddenSession)) || (forbiddenThread !== undefined && forbiddenThread !== null && nonEmptyString(forbiddenThread))) {
    return { ref: null, error: structuredAdapterError("DSH_SESSION_FORBIDDEN", "blocked", "DSH fresh turns must not return a session_id or thread_id", "claude_code_start") };
  }
  const turnId = nonEmptyString(valueAt(payload, "turnId", "turn_id", "freshTurnId", "fresh_turn_id"));
  const jobId = nonEmptyString(valueAt(payload, "jobId", "job_id", "id"));
  const selectedTurn = turnId ?? jobId;
  const selectedJob = jobId ?? turnId;
  if (!selectedTurn || !selectedJob) return { ref: null, error: structuredAdapterError("FRESH_TURN_ID_MISSING", "reconcile_required", "DSH fresh start did not return a turn/job identifier", "claude_code_start") };
  return {
    ref: { kind: "fresh_turn", backend: "deepseek-harness", source: "claude_orchestrator", turnId: selectedTurn, jobId: selectedJob, sessionId: null, threadId: null },
    error: null
  };
}

export class ClaudeOrchestratorAdapter {
  private readonly transport: ClaudeOrchestratorTransport;
  private readonly externalAssetsStatus: ExternalAssetsStatus;
  private readonly transportKind: OrchestratorTransportKind;

  constructor(options: ClaudeOrchestratorOptions);
  constructor(transport: ClaudeOrchestratorTransport, options?: Omit<ClaudeOrchestratorOptions, "transport">);
  constructor(optionsOrTransport: ClaudeOrchestratorOptions | ClaudeOrchestratorTransport, options: Omit<ClaudeOrchestratorOptions, "transport"> = {}) {
    if ("transport" in optionsOrTransport) {
      this.transport = optionsOrTransport.transport;
      this.externalAssetsStatus = optionsOrTransport.externalAssetsStatus ?? optionsOrTransport.assetsStatus ?? "NOT_LOCATED";
      this.transportKind = optionsOrTransport.transportKind ?? optionsOrTransport.runtime ?? "mock";
    } else {
      this.transport = optionsOrTransport;
      this.externalAssetsStatus = options.externalAssetsStatus ?? options.assetsStatus ?? "NOT_LOCATED";
      this.transportKind = options.transportKind ?? options.runtime ?? "mock";
    }
    if (!this.transport || typeof this.transport !== "object") throw new TypeError("ClaudeOrchestratorAdapter requires an injected transport");
  }

  get assetsStatus(): ExternalAssetsStatus {
    return this.externalAssetsStatus;
  }

  get runtime(): OrchestratorTransportKind {
    return this.transportKind;
  }

  async resumeClaude(input: ResumeClaudeInput): Promise<WorkerReceipt> {
    const session = validateSession(input.session);
    this.requireInstruction(input.instruction_ref);
    const idempotencyKey = input.idempotency_key ?? `claude-resume-${randomUUID()}`;
    const transportCall = this.transport.reply ?? this.transport.claude_code_reply;
    if (this.transportKind === "real" && this.externalAssetsStatus !== "LOCATED") return this.unavailableReceipt("claude_code_reply", input.task_id ?? null, input.attempt_id, "claude_resume", idempotencyKey, "External claude_orchestrator assets are NOT_LOCATED; real calls are blocked");
    if (!transportCall) return this.unavailableReceipt("claude_code_reply", input.task_id ?? null, input.attempt_id, "claude_resume", idempotencyKey, "claude_code_reply transport is unavailable");
    const request: ClaudeReplyRequest = { jobId: session.jobId, sessionId: session.sessionId, threadId: session.threadId ?? null, instruction_ref: input.instruction_ref.trim(), idempotency_key: idempotencyKey, backend: "claude" };
    try {
      const payload = unwrap(await transportCall(request));
      const identity = extractRealSession(payload, session);
      const error = identity.error ?? responseError(payload, "claude_code_reply");
      return this.workerReceipt("claude_code_reply", input.task_id ?? null, input.attempt_id, idempotencyKey, "claude", "claude_resume", payload, identity.ref, null, error);
    } catch (error) {
      return this.unavailableReceipt("claude_code_reply", input.task_id ?? null, input.attempt_id, "claude_resume", idempotencyKey, error instanceof Error ? redacted(error.message) : "Claude reply failed");
    }
  }

  async replyClaude(input: ResumeClaudeInput): Promise<WorkerReceipt> {
    return this.resumeClaude(input);
  }

  async startDshFresh(input: StartDshFreshInput): Promise<WorkerReceipt> {
    this.requireInstruction(input.instruction_ref);
    this.requireInstruction(input.checkpoint_ref);
    const idempotencyKey = input.idempotency_key ?? `dsh-fresh-${randomUUID()}`;
    const transportCall = this.transport.start ?? this.transport.claude_code_start;
    if (this.transportKind === "real" && this.externalAssetsStatus !== "LOCATED") return this.unavailableReceipt("claude_code_start", input.task_id ?? null, input.attempt_id, "dsh_fresh", idempotencyKey, "External claude_orchestrator assets are NOT_LOCATED; real calls are blocked");
    if (!transportCall) return this.unavailableReceipt("claude_code_start", input.task_id ?? null, input.attempt_id, "dsh_fresh", idempotencyKey, "claude_code_start transport is unavailable");
    const request: DshFreshStartRequest = { instruction_ref: input.instruction_ref.trim(), checkpoint_ref: input.checkpoint_ref.trim(), idempotency_key: idempotencyKey, workerBackend: "deepseek-harness" };
    try {
      const payload = unwrap(await transportCall(request));
      const fresh = extractFreshTurn(payload);
      const error = fresh.error ?? responseError(payload, "claude_code_start");
      return this.workerReceipt("claude_code_start", input.task_id ?? null, input.attempt_id, idempotencyKey, "dsh", "dsh_fresh", payload, null, fresh.ref, error);
    } catch (error) {
      return this.unavailableReceipt("claude_code_start", input.task_id ?? null, input.attempt_id, "dsh_fresh", idempotencyKey, error instanceof Error ? redacted(error.message) : "DSH fresh start failed");
    }
  }

  async startDsh(input: StartDshFreshInput): Promise<WorkerReceipt> {
    return this.startDshFresh(input);
  }

  async resumeDsh(_input: StartDshFreshInput): Promise<never> {
    throw new DomainError("ROUTING_REJECTED", "DSH has no resume seam; use startDshFresh for a fresh turn");
  }

  async replyDsh(_input: StartDshFreshInput): Promise<never> {
    throw new DomainError("ROUTING_REJECTED", "DSH cannot use claude_code_reply; use a fresh start");
  }

  private workerReceipt(operation: string, taskId: string | null, suppliedAttemptId: string | undefined, idempotencyKey: string, kind: "claude" | "dsh", continuation: "claude_resume" | "dsh_fresh", payload: unknown, realSessionRef: RealSessionRef | null, freshTurnRef: FreshTurnRef | null, suppliedError: StructuredAdapterError | null): WorkerReceipt {
    const mapped = statusFrom(payload);
    const evidenceData = evidenceFrom(payload);
    const error = suppliedError;
    const status = error && mapped.status !== "partial_output" && mapped.status !== "evidence_drop" ? "failed" : mapped.status;
    const output = isRecord(payload) ? nonEmptyString(valueAt(payload, "output", "review_output", "reviewOutput")) : null;
    const partialOutput = isRecord(payload) ? nonEmptyString(valueAt(payload, "partial_output", "partialOutput")) : null;
    const externalStatus = error ? "failed" : mapped.external;
    return {
      schemaVersion: "continuity.worker-receipt.v1",
      requestId: `${operation}-${randomUUID()}`,
      idempotencyKey,
      operation,
      ok: !error && status !== "failed" && status !== "unknown" && status !== "partial_output" && status !== "evidence_drop",
      taskId,
      attemptId: suppliedAttemptId ?? `attempt-${randomUUID()}`,
      kind,
      source: "claude_orchestrator",
      continuation,
      status,
      externalStatus,
      workerStatus: error ? "failed" : mapped.workerStatus,
      realSessionRef,
      freshTurnRef,
      realJobId: realSessionRef?.jobId ?? freshTurnRef?.jobId ?? null,
      bridgeTaskId: null,
      evidence: evidenceData.evidence,
      evidenceRefs: evidenceData.refs,
      review: externalStatus === "waiting_for_supervisor_review" ? { status: "waiting_for_supervisor_review", output, evidenceRefs: evidenceData.refs } : null,
      output,
      partialOutput,
      evidenceDrop: evidenceData.drop,
      error,
      evidenceLevel: "MOCK_PASS",
      state: null,
      revision: null,
      createdAt: nowIso()
    };
  }

  private unavailableReceipt(operation: string, taskId: string | null, attemptId: string | undefined, continuation: "claude_resume" | "dsh_fresh", idempotencyKey: string, message: string): WorkerReceipt {
    const error = structuredAdapterError("CAPABILITY_UNAVAILABLE", "blocked", message, operation);
    const kind = continuation === "claude_resume" ? "claude" : "dsh";
    const receipt = this.workerReceipt(operation, taskId, attemptId, idempotencyKey, kind, continuation, { status: "failed", error: { code: error.code, message: error.message } }, null, null, error);
    return { ...receipt, evidenceLevel: "UNKNOWN" };
  }

  private requireInstruction(value: string): void {
    if (!nonEmptyString(value)) throw new DomainError("RED_FLAGGED_INPUT", "Worker calls require a non-empty structured instruction reference");
  }
}

export type ClaudeOrchestrator = ClaudeOrchestratorAdapter;
