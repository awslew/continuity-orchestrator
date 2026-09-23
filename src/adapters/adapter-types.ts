/**
 * Stable, persistence-friendly contracts shared by the local adapters.
 *
 * The adapters are deliberately transport agnostic.  A receipt produced by a
 * fixture or an injected fake is still useful for state-machine tests, but it
 * is never evidence that the real web/Tunnel/worker path passed.
 */

import type {
  ContinuationKind,
  LifecycleState,
  WorkerKind,
  WorkerSource,
  WorkerStatus
} from "../domain/types.js";

export const WORKER_RECEIPT_SCHEMA = "continuity.worker-receipt.v1" as const;
export const CHILD_MCP_RECEIPT_SCHEMA = "continuity.child-mcp-receipt.v1" as const;

export type AdapterErrorStatus = "retryable" | "blocked" | "reconcile_required" | "unknown";

/** Structured errors are safe to expose to the orchestrator/web envelope. */
export interface StructuredAdapterError {
  code: string;
  status: AdapterErrorStatus;
  message: string;
  operation: string;
  at: string;
  externalId: string | null;
  details: Record<string, unknown>;
}

export function structuredAdapterError(
  code: string,
  status: AdapterErrorStatus,
  message: string,
  operation: string,
  details: Record<string, unknown> = {},
  externalId: string | null = null,
  at = new Date().toISOString()
): StructuredAdapterError {
  return { code, status, message, operation, at, externalId, details };
}

export function isStructuredAdapterError(value: unknown): value is StructuredAdapterError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" &&
    typeof record.status === "string" &&
    ["retryable", "blocked", "reconcile_required", "unknown"].includes(record.status) &&
    typeof record.message === "string" &&
    typeof record.operation === "string" &&
    typeof record.at === "string" &&
    Number.isFinite(Date.parse(record.at));
}

export type WorkerReceiptStatus =
  | "attempt"
  | "queued"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "partial_output"
  | "evidence_drop"
  | "unknown";

/** The status names received from engineering-bridge/claude_orchestrator. */
export type ExternalWorkerStatus =
  | "queued"
  | "running"
  | "waiting_for_supervisor_review"
  | "completed"
  | "failed"
  | "partial_output"
  | "evidence-drop"
  | "unknown";

export interface RealSessionRef {
  kind: "real_session";
  backend: "claude";
  source: "claude_orchestrator";
  /** Real identifiers returned by the Claude orchestrator. */
  jobId: string;
  sessionId: string;
  /** A Claude-native thread identifier, when the upstream returns one. */
  threadId?: string | null;
}

export interface FreshTurnRef {
  kind: "fresh_turn";
  backend: "deepseek-harness";
  source: "claude_orchestrator";
  /** A new external turn/job identifier; it is never presented as a session. */
  turnId: string;
  jobId: string;
  sessionId: null;
  threadId: null;
}

export interface WorkerEvidence {
  kind: "evidence" | "review" | "partial_output" | "evidence_drop";
  ref: string;
  complete: boolean;
  redacted: true;
}

export interface WorkerReview {
  status: "waiting_for_supervisor_review";
  output: string | null;
  evidenceRefs: string[];
}

export interface WorkerEvidenceDrop {
  kind: "evidence-drop";
  dropped: number;
  reason: string;
  marker: "evidence-drop";
}

/**
 * One normalized worker observation.  `realSessionRef` and `freshTurnRef`
 * are mutually exclusive, and the latter explicitly carries null session and
 * thread fields to prevent accidental DSH resume semantics.
 */
export interface WorkerReceipt {
  schemaVersion: typeof WORKER_RECEIPT_SCHEMA;
  requestId: string;
  idempotencyKey: string;
  operation: string;
  ok: boolean;
  taskId: string | null;
  attemptId: string;
  kind: WorkerKind;
  source: WorkerSource;
  continuation: ContinuationKind;
  status: WorkerReceiptStatus;
  externalStatus: ExternalWorkerStatus;
  workerStatus: WorkerStatus;
  realSessionRef: RealSessionRef | null;
  freshTurnRef: FreshTurnRef | null;
  realJobId: string | null;
  bridgeTaskId: string | null;
  evidence: WorkerEvidence[];
  evidenceRefs: string[];
  review: WorkerReview | null;
  output: string | null;
  partialOutput: string | null;
  evidenceDrop: WorkerEvidenceDrop | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  state: LifecycleState | null;
  revision: number | null;
  createdAt: string;
}

export type ChildMcpOperation = "start" | "initialize" | "tools/list" | "tools/call" | "notify" | "exit" | "reconcile";

export type ChildMcpStatus =
  | "started"
  | "initialized"
  | "tools_listed"
  | "completed"
  | "failed"
  | "timeout"
  | "exited"
  | "unknown_in_flight"
  | "reconcile_required";

export interface ChildMcpReceipt<T = unknown> {
  schemaVersion: typeof CHILD_MCP_RECEIPT_SCHEMA;
  /** JSON-RPC id; notifications intentionally have null ids. */
  requestId: number | null;
  id: number | null;
  operation: ChildMcpOperation;
  method: string;
  toolName: string | null;
  status: ChildMcpStatus;
  ok: boolean;
  result: T | null;
  error: StructuredAdapterError | null;
  stderr: string[];
  createdAt: string;
  generation: number;
}

export interface ChildMcpReconcileReceipt {
  schemaVersion: typeof CHILD_MCP_RECEIPT_SCHEMA;
  operation: "reconcile";
  requestId: null;
  id: null;
  method: "reconcile";
  toolName: null;
  status: "completed" | "reconcile_required";
  ok: boolean;
  result: null;
  error: StructuredAdapterError | null;
  stderr: string[];
  createdAt: string;
  generation: number;
  unknownRequestIds: number[];
  reconciledRequestIds: number[];
  restartAllowed: boolean;
}

export interface AdapterResult<T> {
  ok: boolean;
  value: T | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
}
