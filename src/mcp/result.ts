/**
 * Unified MCP result envelope (design §5.1).
 *
 * Every externally visible tool result uses this shell.  `data` may only carry
 * declared fields, errors are structured `{code, message, retryable,
 * needs_human}` objects whose messages explain instead of carrying shell input,
 * and evidence refs point at redacted repository evidence.
 */

import { canonicalize } from "../domain/canonical.js";
import type { DomainError } from "../domain/errors.js";
import type { LifecycleState } from "../domain/types.js";
import type { StructuredAdapterError } from "../adapters/adapter-types.js";

export const ENVELOPE_SCHEMA_VERSION = "continuity.v1" as const;

export interface EnvelopeError {
  code: string;
  message: string;
  retryable: boolean;
  needs_human: boolean;
}

export interface ContinuityEnvelope<T = Record<string, unknown>> {
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  request_id: string;
  idempotency_key: string | null;
  ok: boolean;
  task_id: string | null;
  project_id: string | null;
  state: LifecycleState | null;
  revision: number | null;
  data: T;
  evidence_refs: string[];
  next_action: string | null;
  warnings: string[];
  error: EnvelopeError | null;
}

/** Error codes that indicate a caller-side problem and can be retried verbatim. */
const RETRYABLE_CODES = new Set([
  "QUOTA_STALE",
  "TUNNEL_UNAVAILABLE",
  "WEB_SEND_TIMEOUT",
  "PAGE_STATE_UNKNOWN",
  "IN_FLIGHT",
  "LEASE_EXPIRED"
]);

/** Error codes that must never be resolved automatically. */
const NEEDS_HUMAN_CODES = new Set([
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_INVALID",
  "HUMAN_STOP_REQUIRED",
  "MANAGE_PERMISSION_REQUESTED",
  "RED_FLAGGED_INPUT",
  "DRAIN_SCOPE_UNKNOWN",
  "RECONCILE_REQUIRED"
]);

const ALLOWED_ENVELOPE_KEYS = new Set([
  "schema_version",
  "request_id",
  "idempotency_key",
  "ok",
  "task_id",
  "project_id",
  "state",
  "revision",
  "data",
  "evidence_refs",
  "next_action",
  "warnings",
  "error"
]);

export function envelopeError(
  code: string,
  message: string,
  options: { retryable?: boolean; needs_human?: boolean } = {}
): EnvelopeError {
  return {
    code,
    message,
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    needs_human: options.needs_human ?? NEEDS_HUMAN_CODES.has(code)
  };
}

export function errorFromDomainError(error: DomainError): EnvelopeError {
  const retryable = error.code === "REVISION_CONFLICT" || error.code === "IDEMPOTENCY_IN_FLIGHT" || RETRYABLE_CODES.has(error.code);
  const needsHuman =
    NEEDS_HUMAN_CODES.has(error.code) ||
    error.code === "LEASE_HELD" ||
    error.code === "TERMINAL_GUARD_FAILED" ||
    error.code === "INVALID_TERMINAL_REASON";
  return envelopeError(error.code, error.message, { retryable, needs_human: needsHuman });
}

export function errorFromAdapterError(error: StructuredAdapterError): EnvelopeError {
  return envelopeError(error.code, error.message, {
    retryable: error.status === "retryable",
    needs_human: error.status === "blocked" || error.status === "reconcile_required"
  });
}

export interface EnvelopeContext {
  requestId: string;
  idempotencyKey?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  state?: LifecycleState | null;
  revision?: number | null;
  evidenceRefs?: string[];
  nextAction?: string | null;
  warnings?: string[];
}

function baseEnvelope<T>(context: EnvelopeContext, ok: boolean, data: T, error: EnvelopeError | null): ContinuityEnvelope<T> {
  const envelope: ContinuityEnvelope<T> = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    request_id: context.requestId,
    idempotency_key: context.idempotencyKey ?? null,
    ok,
    task_id: context.taskId ?? null,
    project_id: context.projectId ?? null,
    state: context.state ?? null,
    revision: context.revision ?? null,
    data,
    evidence_refs: [...(context.evidenceRefs ?? [])],
    next_action: context.nextAction ?? null,
    warnings: [...(context.warnings ?? [])],
    error
  };
  assertNoUndeclaredEnvelopeFields(envelope);
  return envelope;
}

export function okEnvelope<T extends Record<string, unknown>>(context: EnvelopeContext, data: T): ContinuityEnvelope<T> {
  return baseEnvelope(context, true, data, null);
}

export function errorEnvelope<T extends Record<string, unknown> = Record<string, unknown>>(
  context: EnvelopeContext,
  error: EnvelopeError,
  data: T = {} as T
): ContinuityEnvelope<T> {
  return baseEnvelope(context, false, data, error);
}

/**
 * Envelopes are a closed shape: an envelope that grew extra keys (for example
 * by spreading unvalidated input into `data`) is rejected instead of shipped.
 */
export function assertNoUndeclaredEnvelopeFields(envelope: object): void {
  for (const key of Object.keys(envelope as Record<string, unknown>)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
      throw new Error(`Undeclared envelope field: ${key}`);
    }
  }
}

export function isContinuityEnvelope(value: unknown): value is ContinuityEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) return false;
  }
  return (
    record.schema_version === ENVELOPE_SCHEMA_VERSION &&
    typeof record.request_id === "string" &&
    typeof record.ok === "boolean" &&
    (record.error === null || typeof record.error === "object") &&
    (record.ok ? record.error === null : record.error !== null) &&
    Array.isArray(record.evidence_refs) &&
    Array.isArray(record.warnings)
  );
}

/** Deterministic identity of an envelope, used for idempotent replay receipts. */
export function envelopeFingerprint(envelope: ContinuityEnvelope): string {
  return canonicalize(envelope);
}
