/** Core, persistence-friendly domain contracts for one relay ledger. */

export const LIFECYCLE_STATES = [
  "CODEX_ACTIVE",
  "DRAINING",
  "HANDOFF_READY",
  "WEB_UNATTENDED_EXECUTING",
  "WEB_TERMINAL",
  "RETURN_READY",
  "CODEX_RESUMED"
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const EXECUTION_SUBSTATES = ["EXECUTING", "RETRYING", "BLOCKED_WAITING"] as const;
export type ExecutionSubstate = (typeof EXECUTION_SUBSTATES)[number];

export const TERMINAL_REASONS = [
  "ALL_TASKS_COMPLETED",
  "WEB_QUOTA_EXHAUSTED",
  "HUMAN_STOP"
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

export const WORK_STATUSES = ["PENDING", "RUNNING", "BLOCKED", "DONE", "FAILED"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORKER_STATUSES = ["queued", "running", "review", "completed", "failed", "unknown"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export type WorkerKind = "claude" | "dsh" | "bridge-dsh";
export type WorkerSource = "claude_orchestrator" | "engineering-bridge";
export type ContinuationKind = "claude_resume" | "dsh_fresh";

export interface RemainingWorkItem {
  taskId: string;
  parentId: string | null;
  status: WorkStatus;
  dependencies: string[];
  acceptance: string[];
  /** Explicit evidence that all acceptance criteria for this item passed. */
  acceptancePassed: boolean;
  evidence: string[];
  lastCheckpoint: string | null;
  sourceOfTruth: string;
}

export interface WorkerAttempt {
  attemptId: string;
  kind: WorkerKind;
  source: WorkerSource;
  realJobId: string | null;
  bridgeTaskId: string | null;
  continuation: ContinuationKind;
  status: WorkerStatus;
  evidenceRefs: string[];
  /** Explicit terminal/reconcile/reap evidence is required for completion. */
  terminal?: boolean;
  reconciled?: boolean;
  reaped?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export type QuotaStatus = "fresh" | "depleted" | "available" | "unknown" | "conflict";

export interface QuotaGate {
  status: QuotaStatus;
  primaryRemainingBps: number | null;
  secondaryRemainingBps: number | null;
  primaryWindowId?: string | null;
  secondaryWindowId?: string | null;
  sampleId?: string | null;
  sampleUpdatedAt: string | null;
  sampledAt?: string | null;
  codexAvailable: boolean;
  secondaryGuard: boolean;
  exhaustedAt?: string | null;
  exhaustedReceiptId?: string | null;
}

export type FaultStatus = "retryable" | "blocked" | "reconcile_required" | "unknown";

export interface Fault {
  code: string;
  status: FaultStatus;
  message: string;
  at: string;
  operation?: string;
  externalId?: string | null;
}

export interface Lease {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  token: string;
}

export interface TaskLedger {
  schemaVersion: "continuity.v1";
  taskId: string;
  projectId: string;
  repositoryId: string;
  relayEpoch: string;
  lifecycleState: LifecycleState;
  revision: number;
  codex: { threadId: string | null; activeTurnId: string | null };
  web: {
    chatId: string | null;
    cursor: string | null;
    executionSubstate: ExecutionSubstate;
    terminalReason: TerminalReason | null;
    /** Last human stop receipt is kept as evidence, never inferred from text. */
    terminalReceipt: TerminalReceipt | null;
  };
  workers: WorkerAttempt[];
  /** The complete task ledger, including DONE records, so child work remains auditable. */
  remainingWork: RemainingWorkItem[];
  scopeCutoffAt: string;
  sourceHashes: Record<string, string>;
  counts: { total: number; remaining: number };
  /** Acceptance/gate identifiers that remain unresolved for this ledger. */
  pendingGates: string[];
  quotaGate: QuotaGate;
  checkpointRef: string;
  fault: Fault | null;
  lease: Lease | null;
  handoffHash?: string | null;
  returnHash?: string | null;
}

export interface StopRelayReceipt {
  kind: "human_stop";
  actor: string;
  intent: "STOP_RELAY";
  commandOrConfirmationId: string;
  timestamp: string;
  relayEpoch: string;
  idempotencyKey: string;
  accepted: true;
}

export interface QuotaExhaustedReceipt {
  kind: "quota_exhausted";
  receiptId: string;
  relayEpoch: string;
  timestamp: string;
  remainingBps?: number | null;
  accepted: true;
}

export interface CompletionReceipt {
  kind: "all_tasks_completed";
  receiptId: string;
  relayEpoch: string;
  timestamp: string;
  intent: "ALL_TASKS_COMPLETED";
  reason: "ALL_TASKS_COMPLETED";
  accepted: true;
}

export type TerminalReceipt = StopRelayReceipt | QuotaExhaustedReceipt | CompletionReceipt;

export interface TransitionOptions {
  expectedRevision: number;
  at?: string;
  actor?: string;
  evidenceRefs?: string[];
}

export interface AddWorkItemInput {
  taskId: string;
  parentId: string;
  status?: WorkStatus;
  dependencies?: string[];
  acceptance?: string[];
  acceptancePassed?: boolean;
  evidence?: string[];
  lastCheckpoint?: string | null;
  sourceOfTruth?: string;
}

export interface HandoffCounts {
  total: number;
  remaining: number;
}

export type HandoffVisibility = "COMPLETE" | "UNKNOWN";

export interface HandoffReconciliationReceipt {
  receiptId: string;
  snapshotId: string;
  visibility: "COMPLETE";
  sourceHash: string;
  counts: HandoffCounts;
  checkedAt: string;
  accepted: true;
}

/** Trusted snapshot captured from the complete non-terminal source task set. */
export interface HandoffSourceSnapshot {
  snapshotId: string;
  scopeCutoffAt: string;
  visibility: HandoffVisibility;
  sourceHashes: Record<string, string>;
  sourceHash: string;
  counts: HandoffCounts;
  remainingWork: RemainingWorkItem[];
  reconciliationReceipt: HandoffReconciliationReceipt;
}

/** Proof consumed by the state machine; a bare boolean is never sufficient. */
export interface HandoffReconciliationProof extends HandoffSourceSnapshot {
  handoffHash: string;
}

export interface WorkSetReconciliation {
  ok: boolean;
  missing: string[];
  extra: string[];
  mismatched: string[];
  duplicateSource: string[];
  duplicateHandoff: string[];
  sourceCount: HandoffCounts;
  handoffCount: HandoffCounts;
  sourceHash: string;
  handoffHash: string;
  sourceHashesMatch?: boolean;
  errors: string[];
}

export interface HandoffDocument {
  schema_version: "continuity.handoff.v1";
  task_id: string;
  parent_id: string | null;
  status: "HANDOFF_READY";
  relay_epoch: string;
  scope_cutoff_at: string;
  source_of_truth: Array<{ kind: string; ref: string }>;
  source_hashes: Record<string, string>;
  counts: HandoffCounts;
  remaining_work: RemainingWorkItem[];
}

export interface ContinuityEvent {
  event_id: string;
  task_id: string;
  seq: number;
  at: string;
  actor: string;
  operation: string;
  from_state: LifecycleState | null;
  to_state: LifecycleState | null;
  expected_revision: number | null;
  result: "started" | "completed" | "rejected" | "in_flight" | "observed";
  external_ids: Record<string, string>;
  evidence_refs: string[];
  redaction_version: string;
  relay_epoch?: string;
  execution_substate?: ExecutionSubstate;
  terminal_reason?: TerminalReason;
  child_task_id?: string;
  scope_cutoff_at?: string;
  source_hashes?: Record<string, string>;
  counts?: HandoffCounts;
  idempotency_key?: string;
  [key: string]: unknown;
}

export interface Receipt<T = unknown> {
  schemaVersion: "continuity.receipt.v1";
  requestId: string;
  idempotencyKey: string;
  operation: string;
  ok: boolean;
  revision: number;
  state: LifecycleState;
  data: T;
  evidenceRefs: string[];
  createdAt: string;
}

export interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  status: "in_flight" | "completed";
  receipt?: Receipt;
  startedAt: string;
  updatedAt: string;
}

export function isTerminalState(state: LifecycleState): boolean {
  return state === "WEB_TERMINAL" || state === "CODEX_RESUMED";
}

export function isKnownLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isKnownTerminalReason(value: string): value is TerminalReason {
  return (TERMINAL_REASONS as readonly string[]).includes(value);
}
