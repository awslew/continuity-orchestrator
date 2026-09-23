export type DomainErrorCode =
  | "INVALID_TRANSITION"
  | "REVISION_CONFLICT"
  | "INVALID_TERMINAL_REASON"
  | "TERMINAL_GUARD_FAILED"
  | "HUMAN_STOP_REQUIRED"
  | "QUOTA_RECEIPT_REQUIRED"
  | "DUPLICATE_TASK"
  | "UNKNOWN_PARENT"
  | "INVALID_WORK_ITEM"
  | "LEASE_HELD"
  | "LEASE_EXPIRED"
  | "LEASE_NOT_HELD"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_FLIGHT"
  | "PATH_OUTSIDE_ROOT"
  | "MALFORMED_HANDOFF"
  | "HANDOFF_RECONCILIATION_FAILED"
  | "HANDOFF_SOURCE_REQUIRED"
  | "HANDOFF_SCOPE_UNKNOWN"
  | "HANDOFF_RECEIPT_INVALID"
  | "RED_FLAGGED_INPUT"
  | "ROUTING_REJECTED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: DomainErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new DomainError(code, message, details);
}
