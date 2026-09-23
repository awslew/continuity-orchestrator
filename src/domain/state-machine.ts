import { canonicalize, clone, workItemsHash } from "./canonical.js";
import { DomainError, fail } from "./errors.js";
import {
  EXECUTION_SUBSTATES,
  LIFECYCLE_STATES,
  TERMINAL_REASONS,
  type AddWorkItemInput,
  type CompletionReceipt,
  type ExecutionSubstate,
  type HandoffReconciliationProof,
  type LifecycleState,
  type QuotaExhaustedReceipt,
  type QuotaGate,
  type RemainingWorkItem,
  type StopRelayReceipt,
  type TaskLedger,
  type TerminalReason,
  type TransitionOptions,
  type WorkerAttempt,
  type WorkStatus
} from "./types.js";

const ALLOWED: Record<LifecycleState, readonly LifecycleState[]> = {
  CODEX_ACTIVE: ["DRAINING"],
  DRAINING: ["HANDOFF_READY"],
  HANDOFF_READY: ["WEB_UNATTENDED_EXECUTING"],
  WEB_UNATTENDED_EXECUTING: ["WEB_TERMINAL"],
  WEB_TERMINAL: ["RETURN_READY"],
  RETURN_READY: ["CODEX_RESUMED"],
  CODEX_RESUMED: []
};

const NONTERMINAL_WORK_STATUSES = new Set<WorkStatus>(["PENDING", "RUNNING", "BLOCKED", "FAILED"]);

export interface CreateLedgerInput {
  taskId: string;
  projectId: string;
  repositoryId: string;
  relayEpoch?: string;
  threadId?: string | null;
  activeTurnId?: string | null;
  chatId?: string | null;
  cursor?: string | null;
  remainingWork?: RemainingWorkItem[];
  scopeCutoffAt?: string;
  sourceHashes?: Record<string, string>;
  pendingGates?: string[];
  quotaGate?: QuotaGate;
  checkpointRef?: string;
}

export interface AdvanceGuards {
  /** Required when leaving DRAINING. */
  handoffProof?: HandoffReconciliationProof;
  /** Legacy hint is never a sufficient proof by itself. */
  handoffReconciled?: boolean;
  drainComplete?: boolean;
  drainScopeKnown?: boolean;
  /** Required when attaching a web Chat. */
  webAck?: boolean;
  /** Required when preparing return. */
  returnReady?: boolean;
  codexQuotaReady?: boolean;
  returnCheckpointComplete?: boolean;
  originalThreadConfirmed?: boolean;
  /** Required when claiming that the original Codex thread resumed. */
  resumeConfirmed?: boolean;
}

export interface EnterTerminalOptions extends TransitionOptions {
  quotaReceipt?: QuotaExhaustedReceipt;
  stopReceipt?: StopRelayReceipt;
  completionReceipt?: CompletionReceipt;
}

export interface UpdateOptions {
  expectedRevision: number;
  at?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertRevision(ledger: TaskLedger, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== ledger.revision) {
    fail("REVISION_CONFLICT", `Expected revision ${expectedRevision}, actual ${ledger.revision}`, {
      expectedRevision,
      actualRevision: ledger.revision
    });
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value.includes("\u0000") || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    fail("INVALID_WORK_ITEM", `${label} must be a non-empty logical identifier`, { value });
  }
}

function normalizedWorkItem(input: RemainingWorkItem): RemainingWorkItem {
  assertIdentifier(input.taskId, "taskId");
  if (input.parentId !== null) assertIdentifier(input.parentId, "parentId");
  if (!Array.isArray(input.dependencies) || !Array.isArray(input.acceptance) || !Array.isArray(input.evidence)) {
    fail("INVALID_WORK_ITEM", `Work item ${input.taskId} has invalid array fields`);
  }
  if (typeof input.acceptancePassed !== "boolean") {
    fail("INVALID_WORK_ITEM", `Work item ${input.taskId} must carry acceptancePassed`);
  }
  return {
    taskId: input.taskId,
    parentId: input.parentId,
    status: input.status,
    dependencies: [...input.dependencies],
    acceptance: [...input.acceptance],
    acceptancePassed: input.acceptancePassed,
    evidence: [...input.evidence],
    lastCheckpoint: input.lastCheckpoint,
    sourceOfTruth: input.sourceOfTruth
  };
}

function recomputeCounts(items: RemainingWorkItem[]): { total: number; remaining: number } {
  return {
    total: items.length,
    remaining: items.filter((item) => item.status !== "DONE").length
  };
}

function sourceWorkForHandoff(ledger: TaskLedger): RemainingWorkItem[] {
  return ledger.remainingWork.filter((item) => item.status !== "DONE").map((item) => clone(item));
}

function workItemComparable(item: RemainingWorkItem): unknown {
  return {
    taskId: item.taskId,
    parentId: item.parentId,
    status: item.status,
    dependencies: [...item.dependencies].sort(),
    acceptance: [...item.acceptance],
    acceptancePassed: item.acceptancePassed,
    evidence: [...item.evidence].sort(),
    lastCheckpoint: item.lastCheckpoint,
    sourceOfTruth: item.sourceOfTruth
  };
}

function workCounts(items: readonly RemainingWorkItem[]): { total: number; remaining: number } {
  return { total: items.length, remaining: items.filter((item) => item.status !== "DONE").length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validProofCounts(value: unknown): value is { total: number; remaining: number } {
  if (!isRecord(value)) return false;
  return typeof value.total === "number" && typeof value.remaining === "number" && Number.isSafeInteger(value.total) && Number.isSafeInteger(value.remaining) && value.total >= 0 && value.remaining >= 0 && value.remaining <= value.total;
}

function validProofWorkItem(value: unknown): value is RemainingWorkItem {
  if (!isRecord(value)) return false;
  return typeof value.taskId === "string" && value.taskId.trim().length > 0 &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.status === "string" && ["PENDING", "RUNNING", "BLOCKED", "DONE", "FAILED"].includes(value.status) &&
    Array.isArray(value.dependencies) && value.dependencies.every((entry) => typeof entry === "string") &&
    Array.isArray(value.acceptance) && value.acceptance.every((entry) => typeof entry === "string") &&
    typeof value.acceptancePassed === "boolean" &&
    Array.isArray(value.evidence) && value.evidence.every((entry) => typeof entry === "string") &&
    (value.lastCheckpoint === null || typeof value.lastCheckpoint === "string") &&
    typeof value.sourceOfTruth === "string";
}

function validSourceHashMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, hash]) => key.length > 0 && typeof hash === "string" && hash.trim().length > 0);
}

function validateHandoffProof(ledger: TaskLedger, proof: HandoffReconciliationProof | undefined): void {
  if (!proof || typeof proof !== "object") fail("HANDOFF_SOURCE_REQUIRED", "DRAINING requires a trusted source snapshot and reconciliation receipt");
  if (proof.visibility !== "COMPLETE") fail("HANDOFF_SCOPE_UNKNOWN", "Handoff source visibility is unknown");
  if (!proof.snapshotId || !proof.scopeCutoffAt || proof.scopeCutoffAt !== ledger.scopeCutoffAt) fail("HANDOFF_RECEIPT_INVALID", "Handoff source snapshot identity or cutoff is invalid");
  if (!Array.isArray(proof.remainingWork) || !proof.remainingWork.every(validProofWorkItem) || !validSourceHashMap(proof.sourceHashes) || !validProofCounts(proof.counts) || !isRecord(proof.reconciliationReceipt)) fail("HANDOFF_SOURCE_REQUIRED", "Handoff proof is incomplete");
  const expected = sourceWorkForHandoff(ledger);
  const expectedCounts = workCounts(expected);
  const proofCounts = proof.counts;
  if (proofCounts.total !== expectedCounts.total || proofCounts.remaining !== expectedCounts.remaining) {
    fail("HANDOFF_RECONCILIATION_FAILED", "Handoff source counts do not match all non-terminal ledger work", { expected: expectedCounts, actual: proofCounts });
  }
  if (canonicalize(proof.sourceHashes) !== canonicalize(ledger.sourceHashes)) fail("HANDOFF_RECONCILIATION_FAILED", "Handoff source hashes do not match ledger source hashes");
  const expectedHash = workItemsHash(expected);
  if (proof.sourceHash !== expectedHash || workItemsHash(proof.remainingWork) !== expectedHash || !proof.handoffHash) {
    fail("HANDOFF_RECONCILIATION_FAILED", "Handoff source or handoff work hash does not match the complete ledger set");
  }
  const sourceById = new Map(expected.map((item) => [item.taskId, item]));
  const proofIds = new Set<string>();
  for (const item of proof.remainingWork) {
    if (proofIds.has(item.taskId)) fail("HANDOFF_RECONCILIATION_FAILED", `Duplicate handoff task ${item.taskId}`);
    proofIds.add(item.taskId);
    const sourceItem = sourceById.get(item.taskId);
    if (!sourceItem || canonicalize(workItemComparable(sourceItem)) !== canonicalize(workItemComparable(item))) {
      fail("HANDOFF_RECONCILIATION_FAILED", `Handoff task set differs from source task ${item.taskId}`);
    }
  }
  for (const item of expected) if (!proofIds.has(item.taskId)) fail("HANDOFF_RECONCILIATION_FAILED", `Handoff omits source task ${item.taskId}`);
  const receipt = proof.reconciliationReceipt;
  if (typeof receipt.receiptId !== "string" || receipt.receiptId.trim().length === 0 || typeof receipt.snapshotId !== "string" || receipt.snapshotId !== proof.snapshotId || receipt.visibility !== "COMPLETE" || receipt.accepted !== true || typeof receipt.checkedAt !== "string" || receipt.checkedAt.trim().length === 0 || !Number.isFinite(Date.parse(receipt.checkedAt)) || receipt.sourceHash !== expectedHash || !validProofCounts(receipt.counts) || receipt.counts.total !== expectedCounts.total || receipt.counts.remaining !== expectedCounts.remaining) {
    fail("HANDOFF_RECEIPT_INVALID", "Handoff reconciliation receipt is missing a trusted hash/count/visibility assertion");
  }
}

function assertUniqueWork(items: RemainingWorkItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.taskId)) fail("DUPLICATE_TASK", `Duplicate task id ${item.taskId}`, { taskId: item.taskId });
    seen.add(item.taskId);
  }
}

export function createInitialLedger(input: CreateLedgerInput): TaskLedger {
  assertIdentifier(input.taskId, "taskId");
  assertIdentifier(input.projectId, "projectId");
  assertIdentifier(input.repositoryId, "repositoryId");
  const items = (input.remainingWork ?? []).map(normalizedWorkItem);
  assertUniqueWork(items);
  const at = input.scopeCutoffAt ?? nowIso();
  const quotaGate: QuotaGate = input.quotaGate ?? {
    status: "unknown",
    primaryRemainingBps: null,
    secondaryRemainingBps: null,
    sampleUpdatedAt: null,
    sampledAt: null,
    codexAvailable: true,
    secondaryGuard: false,
    exhaustedAt: null,
    exhaustedReceiptId: null
  };
  return {
    schemaVersion: "continuity.v1",
    taskId: input.taskId,
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    relayEpoch: input.relayEpoch ?? `relay-${Date.now().toString(36)}`,
    lifecycleState: "CODEX_ACTIVE",
    revision: 0,
    codex: { threadId: input.threadId ?? null, activeTurnId: input.activeTurnId ?? null },
    web: {
      chatId: input.chatId ?? null,
      cursor: input.cursor ?? null,
      executionSubstate: "EXECUTING",
      terminalReason: null,
      terminalReceipt: null
    },
    workers: [],
    remainingWork: items,
    scopeCutoffAt: at,
    sourceHashes: { ...(input.sourceHashes ?? {}) },
    counts: recomputeCounts(items),
    pendingGates: [...(input.pendingGates ?? [])],
    quotaGate,
    checkpointRef: input.checkpointRef ?? "",
    fault: null,
    lease: null,
    handoffHash: null,
    returnHash: null
  };
}

export function allowedTransitions(from: LifecycleState): readonly LifecycleState[] {
  return ALLOWED[from];
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return ALLOWED[from].includes(to);
}

function nextRevision(ledger: TaskLedger): number {
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    fail("INVALID_WORK_ITEM", "Ledger revision must be a non-negative safe integer");
  }
  return ledger.revision + 1;
}

export function updateLedger<T extends TaskLedger>(
  ledger: T,
  options: UpdateOptions,
  mutate: (next: T) => void
): T {
  assertRevision(ledger, options.expectedRevision);
  const next = clone(ledger) as T;
  mutate(next);
  next.revision = nextRevision(ledger);
  next.counts = recomputeCounts(next.remainingWork);
  return next;
}

export function transitionLedger(
  ledger: TaskLedger,
  to: LifecycleState,
  options: TransitionOptions & AdvanceGuards
): TaskLedger {
  assertRevision(ledger, options.expectedRevision);
  if (!LIFECYCLE_STATES.includes(to)) fail("INVALID_TRANSITION", `Unknown lifecycle state ${to}`);
  if (!canTransition(ledger.lifecycleState, to)) {
    fail("INVALID_TRANSITION", `${ledger.lifecycleState} cannot transition to ${to}`, {
      from: ledger.lifecycleState,
      to,
      allowed: ALLOWED[ledger.lifecycleState]
    });
  }
  if (to === "HANDOFF_READY") {
    // `handoffReconciled:true` was an unsafe pre-Wave-1 hint. It is intentionally
    // ignored unless a full, hash/count/visibility-bound proof is also present.
    validateHandoffProof(ledger, options.handoffProof);
    if (options.handoffReconciled === true && !options.handoffProof) {
      fail("HANDOFF_SOURCE_REQUIRED", "A bare handoffReconciled boolean cannot authorize HANDOFF_READY");
    }
    if (options.drainComplete === false || options.drainScopeKnown === false) {
      fail("HANDOFF_RECONCILIATION_FAILED", "Drain completion/scope guard is negative");
    }
  }
  if (to === "WEB_UNATTENDED_EXECUTING" && !options.webAck) {
    fail("TERMINAL_GUARD_FAILED", "HANDOFF_READY requires an identifiable web acknowledgement");
  }
  if (to === "WEB_TERMINAL") {
    fail("INVALID_TERMINAL_REASON", "Use enterWebTerminal with one of the closed terminal reasons");
  }
  if (to === "RETURN_READY" && (!options.returnReady || !options.codexQuotaReady || !options.returnCheckpointComplete || !options.originalThreadConfirmed)) {
    fail("TERMINAL_GUARD_FAILED", "Return gate requires fresh Codex quota, complete return checkpoint and original thread confirmation");
  }
  if (to === "CODEX_RESUMED" && !options.resumeConfirmed) {
    fail("TERMINAL_GUARD_FAILED", "CODEX_RESUMED requires a real original-thread resume receipt");
  }
  const next = clone(ledger);
  next.lifecycleState = to;
  next.revision = nextRevision(ledger);
  if (to === "WEB_UNATTENDED_EXECUTING") {
    next.web.executionSubstate = "EXECUTING";
    next.web.terminalReason = null;
    next.web.terminalReceipt = null;
  }
  return next;
}

export function setExecutionSubstate(
  ledger: TaskLedger,
  substate: ExecutionSubstate,
  options: UpdateOptions
): TaskLedger {
  if (!EXECUTION_SUBSTATES.includes(substate)) fail("INVALID_TRANSITION", `Unknown execution substate ${substate}`);
  if (ledger.lifecycleState !== "WEB_UNATTENDED_EXECUTING") {
    fail("INVALID_TRANSITION", "Execution substate can only change while web execution is active");
  }
  return updateLedger(ledger, options, (next) => {
    next.web.executionSubstate = substate;
  });
}

export function setTaskStatus(
  ledger: TaskLedger,
  taskId: string,
  status: WorkStatus,
  options: UpdateOptions & { acceptancePassed?: boolean; checkpointRef?: string }
): TaskLedger {
  const item = ledger.remainingWork.find((candidate) => candidate.taskId === taskId);
  if (!item) fail("INVALID_WORK_ITEM", `Unknown task ${taskId}`, { taskId });
  return updateLedger(ledger, options, (next) => {
    const target = next.remainingWork.find((candidate) => candidate.taskId === taskId);
    if (!target) fail("INVALID_WORK_ITEM", `Unknown task ${taskId}`, { taskId });
    target.status = status;
    if (options.acceptancePassed !== undefined) target.acceptancePassed = options.acceptancePassed;
    if (options.checkpointRef !== undefined) target.lastCheckpoint = options.checkpointRef;
  });
}

export function addChildTask(ledger: TaskLedger, input: AddWorkItemInput, options: UpdateOptions): TaskLedger {
  if (ledger.lifecycleState !== "WEB_UNATTENDED_EXECUTING") {
    fail("INVALID_TRANSITION", "Child tasks can only be appended during web execution");
  }
  assertIdentifier(input.taskId, "taskId");
  assertIdentifier(input.parentId, "parentId");
  if (!ledger.remainingWork.some((item) => item.taskId === input.parentId)) {
    fail("UNKNOWN_PARENT", `Parent task ${input.parentId} is not in the ledger`);
  }
  if (ledger.remainingWork.some((item) => item.taskId === input.taskId)) {
    fail("DUPLICATE_TASK", `Task ${input.taskId} already exists`);
  }
  const acceptance = [...(input.acceptance ?? [])];
  const item: RemainingWorkItem = {
    taskId: input.taskId,
    parentId: input.parentId,
    status: input.status ?? "PENDING",
    dependencies: [...(input.dependencies ?? [])],
    acceptance,
    acceptancePassed: input.acceptancePassed ?? acceptance.length === 0,
    evidence: [...(input.evidence ?? [])],
    lastCheckpoint: input.lastCheckpoint ?? null,
    sourceOfTruth: input.sourceOfTruth ?? "web-child-task"
  };
  return updateLedger(ledger, options, (next) => {
    next.remainingWork.push(item);
  });
}

export function registerWorker(ledger: TaskLedger, worker: WorkerAttempt, options: UpdateOptions): TaskLedger {
  if (ledger.workers.some((candidate) => candidate.attemptId === worker.attemptId)) {
    fail("DUPLICATE_TASK", `Worker attempt ${worker.attemptId} already exists`);
  }
  return updateLedger(ledger, options, (next) => {
    next.workers.push(clone(worker));
  });
}

export function updateWorker(
  ledger: TaskLedger,
  attemptId: string,
  status: WorkerAttempt["status"],
  options: UpdateOptions & Partial<Pick<WorkerAttempt, "terminal" | "reconciled" | "reaped">>
): TaskLedger {
  if (!ledger.workers.some((worker) => worker.attemptId === attemptId)) fail("INVALID_WORK_ITEM", `Unknown worker ${attemptId}`);
  return updateLedger(ledger, options, (next) => {
    const worker = next.workers.find((candidate) => candidate.attemptId === attemptId);
    if (!worker) fail("INVALID_WORK_ITEM", `Unknown worker ${attemptId}`);
    worker.status = status;
    if (options.terminal !== undefined) worker.terminal = options.terminal;
    if (options.reconciled !== undefined) worker.reconciled = options.reconciled;
    if (options.reaped !== undefined) worker.reaped = options.reaped;
    if ((status === "completed" || status === "failed") && options.at !== undefined) worker.finishedAt = options.at;
  });
}

export function allTasksCompleted(ledger: TaskLedger): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const expectedCounts = recomputeCounts(ledger.remainingWork);
  if (ledger.counts.total !== expectedCounts.total || ledger.counts.remaining !== expectedCounts.remaining) reasons.push("ledger_counts_mismatch");
  const incomplete = ledger.remainingWork.filter((item) => item.status !== "DONE");
  if (ledger.remainingWork.length === 0) reasons.push("no_tasks_registered");
  if (incomplete.length > 0) reasons.push(`incomplete_tasks:${incomplete.map((item) => item.taskId).join(",")}`);
  const unaccepted = ledger.remainingWork.filter((item) => item.acceptancePassed !== true);
  if (unaccepted.length > 0) reasons.push(`unaccepted_tasks:${unaccepted.map((item) => item.taskId).join(",")}`);
  const missingEvidence = ledger.remainingWork.filter((item) => !Array.isArray(item.evidence) || item.evidence.length === 0 || !item.evidence.some((reference) => typeof reference === "string" && reference.trim().length > 0 && /receipt|reference|evidence|event|evt[-_:]|\.json$|sha256:|urn:/i.test(reference)));
  if (missingEvidence.length > 0) reasons.push(`missing_auditable_evidence:${missingEvidence.map((item) => item.taskId).join(",")}`);
  if (ledger.pendingGates.length > 0) reasons.push(`pending_gates:${ledger.pendingGates.join(",")}`);
  const unrecoveredWorkers = ledger.workers.filter((worker) => worker.status !== "completed" || worker.terminal !== true || worker.reconciled !== true || worker.reaped !== true);
  if (unrecoveredWorkers.length > 0) reasons.push(`unrecovered_workers:${unrecoveredWorkers.map((worker) => worker.attemptId).join(",")}`);
  return { ok: reasons.length === 0, reasons };
}

function validStopReceipt(receipt: StopRelayReceipt | undefined, ledger: TaskLedger): receipt is StopRelayReceipt {
  return Boolean(
    receipt &&
      receipt.kind === "human_stop" &&
      receipt.accepted === true &&
      receipt.intent === "STOP_RELAY" &&
      receipt.actor &&
      receipt.commandOrConfirmationId &&
      receipt.timestamp &&
      Number.isFinite(Date.parse(receipt.timestamp)) &&
      receipt.relayEpoch === ledger.relayEpoch &&
      receipt.idempotencyKey
  );
}

function validCompletionReceipt(receipt: CompletionReceipt | undefined, ledger: TaskLedger): receipt is CompletionReceipt {
  return Boolean(
    receipt &&
      receipt.kind === "all_tasks_completed" &&
      receipt.accepted === true &&
      typeof receipt.receiptId === "string" &&
      receipt.receiptId.trim().length > 0 &&
      typeof receipt.timestamp === "string" &&
      receipt.timestamp.trim().length > 0 &&
      Number.isFinite(Date.parse(receipt.timestamp)) &&
      receipt.relayEpoch === ledger.relayEpoch &&
      receipt.intent === "ALL_TASKS_COMPLETED" &&
      receipt.reason === "ALL_TASKS_COMPLETED"
  );
}

function validQuotaReceipt(receipt: QuotaExhaustedReceipt | undefined, ledger: TaskLedger): receipt is QuotaExhaustedReceipt {
  return Boolean(
    receipt &&
      receipt.kind === "quota_exhausted" &&
      receipt.accepted === true &&
      typeof receipt.receiptId === "string" &&
      receipt.receiptId.trim().length > 0 &&
      typeof receipt.timestamp === "string" &&
      receipt.timestamp.trim().length > 0 &&
      Number.isFinite(Date.parse(receipt.timestamp)) &&
      receipt.relayEpoch === ledger.relayEpoch
  );
}

export function enterWebTerminal(
  ledger: TaskLedger,
  reason: TerminalReason,
  options: EnterTerminalOptions
): TaskLedger {
  assertRevision(ledger, options.expectedRevision);
  if (ledger.lifecycleState !== "WEB_UNATTENDED_EXECUTING") {
    fail("INVALID_TRANSITION", "Only active web execution can enter WEB_TERMINAL");
  }
  if (!TERMINAL_REASONS.includes(reason)) fail("INVALID_TERMINAL_REASON", `Unsupported terminal reason ${reason}`);
  let receipt: TaskLedger["web"]["terminalReceipt"];
  if (reason === "ALL_TASKS_COMPLETED") {
    const completion = allTasksCompleted(ledger);
    if (!completion.ok) fail("TERMINAL_GUARD_FAILED", `All-task completion guard failed: ${completion.reasons.join("; ")}`, { reasons: completion.reasons });
    const supplied = options.completionReceipt;
    if (!validCompletionReceipt(supplied, ledger)) {
      fail("HANDOFF_RECEIPT_INVALID", "ALL_TASKS_COMPLETED requires a non-empty, timestamped receipt with matching intent/reason and relay epoch");
    }
    receipt = supplied;
  } else if (reason === "WEB_QUOTA_EXHAUSTED") {
    const supplied = options.quotaReceipt;
    if (!validQuotaReceipt(supplied, ledger)) {
      fail("QUOTA_RECEIPT_REQUIRED", "WEB_QUOTA_EXHAUSTED requires an accepted web quota receipt");
    }
    receipt = supplied;
  } else {
    if (!validStopReceipt(options.stopReceipt, ledger)) {
      fail("HUMAN_STOP_REQUIRED", "HUMAN_STOP requires explicit STOP_RELAY or a positive confirmation-gate receipt");
    }
    receipt = options.stopReceipt;
  }
  const next = clone(ledger);
  next.lifecycleState = "WEB_TERMINAL";
  next.web.terminalReason = reason;
  next.web.terminalReceipt = receipt;
  if (reason === "WEB_QUOTA_EXHAUSTED") {
    next.quotaGate.status = "depleted";
    next.quotaGate.codexAvailable = false;
    next.quotaGate.exhaustedAt = options.quotaReceipt?.timestamp ?? options.at ?? nowIso();
    next.quotaGate.exhaustedReceiptId = options.quotaReceipt?.receiptId ?? null;
  }
  next.revision = nextRevision(ledger);
  return next;
}

export function observeQuotaRecovery(
  ledger: TaskLedger,
  quotaGate: QuotaGate,
  options: UpdateOptions
): TaskLedger {
  return updateLedger(ledger, options, (next) => {
    next.quotaGate = clone(quotaGate);
    next.quotaGate.codexAvailable = true;
    // A quota terminal is an absorbing state for this relay epoch. Recovery is data only.
    if (next.lifecycleState === "WEB_TERMINAL" && next.web.terminalReason === "WEB_QUOTA_EXHAUSTED") {
      next.quotaGate.status = "available";
    }
  });
}

export function setFault(ledger: TaskLedger, fault: TaskLedger["fault"], options: UpdateOptions): TaskLedger {
  return updateLedger(ledger, options, (next) => {
    next.fault = clone(fault);
  });
}

export function clearFault(ledger: TaskLedger, options: UpdateOptions): TaskLedger {
  return updateLedger(ledger, options, (next) => {
    next.fault = null;
  });
}

export function stateMachineError(error: unknown): DomainError | null {
  return error instanceof DomainError ? error : null;
}
