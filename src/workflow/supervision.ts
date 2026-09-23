import { randomUUID } from "node:crypto";
import { canonicalize, sha256, workItemsHash } from "../domain/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { LifecycleState, RemainingWorkItem, TaskLedger, WorkerKind, WorkerStatus } from "../domain/types.js";
import type { DrainResult } from "./drain.js";
import type { StructuredAdapterError } from "../adapters/adapter-types.js";
import { structuredAdapterError } from "../adapters/adapter-types.js";

export type WorkerControlAction = "continue" | "steer" | "interrupt" | "accept";

export interface StructuredInstructionRef {
  kind: "instruction_ref";
  ref: string;
  source: string;
  hash?: string;
}

export interface Wave2ThreadProof {
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  repositoryId: string | null;
  status: "active";
}

export interface Wave2ThreadSnapshotProof {
  snapshotId: string;
  visibilityKnown: true;
  scope: "all_visible_active";
  threads: Wave2ThreadProof[];
  listHash: string;
}

export interface Wave2DrainSetProof {
  threadId: string;
  turnId: string | null;
  projectId: string;
  registered: true;
  mapped: true;
}

export interface Wave2InterruptProof {
  threadId: string;
  turnId: string;
  receiptId: string;
  kind: "turn_interrupt";
  operation: "turn/interrupt";
  idempotencyKey: string;
  status: "confirmed";
  confirmed: true;
  accepted: true;
  fault: null;
}

export interface Wave2HandoffProof {
  visibility: "COMPLETE";
  snapshotId: string;
  scopeCutoffAt: string;
  sourceHashes: Record<string, string>;
  handoffHash: string;
  sourceHash: string;
  counts: { total: number; remaining: number };
  remainingWork: RemainingWorkItem[];
  reconciliationReceipt: {
    receiptId: string;
    snapshotId: string;
    visibility: "COMPLETE";
    sourceHash: string;
    counts: { total: number; remaining: number };
    checkedAt: string;
    accepted: true;
  };
  reconciliation: { ok: true };
}

export interface Wave2WorkSetReconciliationProof {
  ok: true;
  missing: [];
  extra: [];
  mismatched: [];
  duplicateSource: [];
  duplicateHandoff: [];
  sourceCount: { total: number; remaining: number };
  handoffCount: { total: number; remaining: number };
  sourceHash: string;
  handoffHash: string;
  sourceHashesMatch: true;
  errors: [];
}

export interface Wave2HandoffDocumentProof {
  schema_version: "continuity.handoff.v1";
  task_id: string;
  parent_id: string | null;
  status: "HANDOFF_READY";
  relay_epoch: string;
  scope_cutoff_at: string;
  source_of_truth: Array<{ kind: string; ref: string }>;
  source_hashes: Record<string, string>;
  counts: { total: number; remaining: number };
  remaining_work: RemainingWorkItem[];
}

export interface Wave2HandoffRecordProof {
  path: string;
  hash: string;
  document: Wave2HandoffDocumentProof;
  reconciliation: Wave2WorkSetReconciliationProof;
  proof: Wave2HandoffProof;
}

/** A normalized, auditable subset of the Wave 2 DrainResult. */
export interface Wave2DrainProof {
  ok: true;
  state: "HANDOFF_READY";
  scopeKnown: true;
  visibility: "COMPLETE";
  visibilityKnown: true;
  scope: "all_visible_active";
  threadSnapshot: Wave2ThreadSnapshotProof;
  visibleThreadSnapshot: Wave2ThreadSnapshotProof;
  visibleThreads: Wave2ThreadProof[];
  drainSet: Wave2DrainSetProof[];
  visibleThreadIds: string[];
  registeredThreadIds: string[];
  unregisteredThreadIds: [];
  registeredNotVisibleThreadIds: [];
  projectMappingMissing: [];
  projectMappingExtra: [];
  interruptReceipts: Wave2InterruptProof[];
  stopConfirmation: { confirmed: true; receiptIds: string[]; pendingThreadIds: [] };
  handoff: Wave2HandoffRecordProof | null;
  handoffReconciliation: Wave2WorkSetReconciliationProof;
  handoffSourceReconciliationProof: Wave2HandoffProof;
  proofHash: string;
}

export interface SupervisionGateResult {
  ok: boolean;
  proof: Wave2DrainProof | null;
  error: StructuredAdapterError | null;
  missing: string[];
}

export interface WebWorkerStartRequest {
  taskId: string;
  attemptId: string;
  workerKind: WorkerKind;
  drainProof: unknown;
  ledger?: TaskLedger;
}

export interface WebWorkerStartReceipt {
  schemaVersion: "continuity.web-worker-start.v1";
  requestId: string;
  taskId: string;
  attemptId: string;
  workerKind: WorkerKind;
  accepted: boolean;
  state: "HANDOFF_READY" | "WEB_UNATTENDED_EXECUTING" | "BLOCKED";
  drainProofHash: string | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  createdAt: string;
}

export interface SupervisionAttemptState {
  taskId: string;
  attemptId: string;
  kind: WorkerKind;
  source: "claude_orchestrator" | "engineering-bridge";
  continuation: "claude_resume" | "dsh_fresh";
  status: WorkerStatus;
  revision: number;
  terminal: boolean;
}

export interface WorkerControlRequest {
  taskId: string;
  attemptId: string;
  action: WorkerControlAction;
  expectedRevision: number;
  idempotencyKey: string;
  /** Only this structured reference is accepted; raw web text is rejected. */
  instruction?: unknown;
  /**
   * Evidence level to stamp on an accepted receipt.  Defaults to `MOCK_PASS`
   * for the mock/in-memory supervision harness; a caller driving a real
   * upstream process must pass `UNKNOWN` rather than claim mock validation.
   */
  evidenceLevel?: "MOCK_PASS" | "UNKNOWN";
}

export interface WorkerControlReceipt {
  schemaVersion: "continuity.worker-control.v1";
  requestId: string;
  taskId: string;
  attemptId: string;
  action: WorkerControlAction;
  accepted: boolean;
  replayed: boolean;
  previousStatus: WorkerStatus;
  status: WorkerStatus;
  previousRevision: number;
  revision: number;
  requiresFreshTurn: boolean;
  instructionRef: StructuredInstructionRef | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  createdAt: string;
}

interface StoredControl {
  payloadHash: string;
  receipt: WorkerControlReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isWorkerControlAction(value: unknown): value is WorkerControlAction {
  return value === "continue" || value === "steer" || value === "interrupt" || value === "accept";
}

function nowIso(): string {
  return new Date().toISOString();
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function invalidGate(missing: string[], message: string): SupervisionGateResult {
  return {
    ok: false,
    proof: null,
    error: structuredAdapterError("DRAIN_PROOF_INCOMPLETE", "blocked", message, "supervision.start", { missing }),
    missing
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))].sort();
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | null {
  if (!hasOwn(record, key) || !Array.isArray(record[key])) return null;
  const values = record[key] as unknown[];
  if (!values.every((value) => typeof value === "string" && value.trim().length > 0)) return null;
  return values.map((value) => (value as string).trim());
}

function readEmptyStringArray(record: Record<string, unknown>, key: string): [] | null {
  const values = readStringArray(record, key);
  return values !== null && values.length === 0 ? [] : null;
}

function readCounts(value: unknown): { total: number; remaining: number } | null {
  if (!isRecord(value) || !hasOwn(value, "total") || !hasOwn(value, "remaining")) return null;
  if (typeof value.total !== "number" || typeof value.remaining !== "number" ||
      !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.remaining) ||
      value.total < 0 || value.remaining < 0 || value.remaining > value.total) return null;
  return { total: value.total, remaining: value.remaining };
}

function readSourceHashes(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([key, hash]) => key.trim().length > 0 && typeof hash === "string" && hash.trim().length > 0)) return null;
  return Object.fromEntries(entries.map(([key, hash]) => [key, (hash as string).trim()]));
}

function readThread(value: unknown): Wave2ThreadProof | null {
  if (!isRecord(value) || !hasOwn(value, "threadId") || !hasOwn(value, "turnId") || !hasOwn(value, "projectId") || !hasOwn(value, "repositoryId") || !hasOwn(value, "status")) return null;
  const threadId = nonEmptyString(value.threadId);
  const turnId = value.turnId === null ? null : nonEmptyString(value.turnId);
  const projectId = value.projectId === null ? null : nonEmptyString(value.projectId);
  const repositoryId = value.repositoryId === null ? null : nonEmptyString(value.repositoryId);
  if (!threadId || (value.turnId !== null && !turnId) || (value.projectId !== null && !projectId) || (value.repositoryId !== null && !repositoryId) || value.status !== "active") return null;
  return { threadId, turnId, projectId, repositoryId, status: "active" };
}

function readThreads(value: unknown): Wave2ThreadProof[] | null {
  if (!Array.isArray(value)) return null;
  const threads = value.map(readThread);
  return threads.every((thread): thread is Wave2ThreadProof => thread !== null) ? threads : null;
}

function readSnapshot(value: unknown): Wave2ThreadSnapshotProof | null {
  if (!isRecord(value) || !hasOwn(value, "snapshotId") || !hasOwn(value, "visibilityKnown") || !hasOwn(value, "scope") || !hasOwn(value, "threads") || !hasOwn(value, "listHash")) return null;
  if (value.visibilityKnown !== true || value.scope !== "all_visible_active") return null;
  const snapshotId = nonEmptyString(value.snapshotId);
  const listHash = nonEmptyString(value.listHash);
  const threads = readThreads(value.threads);
  if (!snapshotId || !listHash || !threads || new Set(threads.map((thread) => thread.threadId)).size !== threads.length) return null;
  if (listHash !== sha256(threads)) return null;
  const expectedSnapshotId = sha256({ visibilityKnown: true, scope: "all_visible_active", threads, listHash });
  if (snapshotId !== expectedSnapshotId) return null;
  return { snapshotId, visibilityKnown: true, scope: "all_visible_active", threads, listHash };
}

function readDrainSet(value: unknown): Wave2DrainSetProof[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry): Wave2DrainSetProof | null => {
    if (!isRecord(entry) || !hasOwn(entry, "threadId") || !hasOwn(entry, "turnId") || !hasOwn(entry, "projectId") || !hasOwn(entry, "registered") || !hasOwn(entry, "mapped")) return null;
    const threadId = nonEmptyString(entry.threadId);
    const turnId = entry.turnId === null ? null : nonEmptyString(entry.turnId);
    const projectId = nonEmptyString(entry.projectId);
    if (!threadId || (entry.turnId !== null && !turnId) || !projectId || entry.registered !== true || entry.mapped !== true) return null;
    return { threadId, turnId, projectId, registered: true, mapped: true };
  });
  return entries.every((entry): entry is Wave2DrainSetProof => entry !== null) ? entries : null;
}

function readInterrupt(value: unknown): Wave2InterruptProof | null {
  if (!isRecord(value) || !hasOwn(value, "kind") || !hasOwn(value, "operation") || !hasOwn(value, "threadId") || !hasOwn(value, "turnId") || !hasOwn(value, "idempotencyKey") || !hasOwn(value, "receiptId") || !hasOwn(value, "status") || !hasOwn(value, "confirmed") || !hasOwn(value, "accepted") || !hasOwn(value, "fault")) return null;
  const threadId = nonEmptyString(value.threadId);
  const turnId = nonEmptyString(value.turnId);
  const idempotencyKey = nonEmptyString(value.idempotencyKey);
  const receiptId = nonEmptyString(value.receiptId);
  if (value.kind !== "turn_interrupt" || value.operation !== "turn/interrupt" || !threadId || !turnId || !idempotencyKey || !receiptId || value.status !== "confirmed" || value.confirmed !== true || value.accepted !== true || value.fault !== null) return null;
  return { threadId, turnId, receiptId, kind: "turn_interrupt", operation: "turn/interrupt", idempotencyKey, status: "confirmed", confirmed: true, accepted: true, fault: null };
}

function readWorkItems(value: unknown): RemainingWorkItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((entry): RemainingWorkItem | null => {
    if (!isRecord(entry) || !hasOwn(entry, "taskId") || !hasOwn(entry, "parentId") || !hasOwn(entry, "status") || !hasOwn(entry, "dependencies") || !hasOwn(entry, "acceptance") || !hasOwn(entry, "acceptancePassed") || !hasOwn(entry, "evidence") || !hasOwn(entry, "lastCheckpoint") || !hasOwn(entry, "sourceOfTruth")) return null;
    const taskId = nonEmptyString(entry.taskId);
    const status = entry.status;
    const dependencies = entry.dependencies;
    const acceptance = entry.acceptance;
    const evidence = entry.evidence;
    const sourceOfTruth = nonEmptyString(entry.sourceOfTruth);
    if (!taskId || (entry.parentId !== null && typeof entry.parentId !== "string") || typeof status !== "string" || !["PENDING", "RUNNING", "BLOCKED", "FAILED"].includes(status) || !Array.isArray(dependencies) || !dependencies.every((item) => typeof item === "string") || !Array.isArray(acceptance) || !acceptance.every((item) => typeof item === "string") || typeof entry.acceptancePassed !== "boolean" || !Array.isArray(evidence) || !evidence.every((item) => typeof item === "string") || (entry.lastCheckpoint !== null && typeof entry.lastCheckpoint !== "string") || !sourceOfTruth) return null;
    return {
      taskId,
      parentId: entry.parentId === null ? null : entry.parentId,
      status: status as RemainingWorkItem["status"],
      dependencies: [...dependencies] as string[],
      acceptance: [...acceptance] as string[],
      acceptancePassed: entry.acceptancePassed,
      evidence: [...evidence] as string[],
      lastCheckpoint: entry.lastCheckpoint === null ? null : entry.lastCheckpoint,
      sourceOfTruth
    };
  });
  if (!items.every((item): item is RemainingWorkItem => item !== null)) return null;
  if (new Set(items.map((item) => item.taskId)).size !== items.length) return null;
  return items;
}

function sameCounts(left: { total: number; remaining: number }, right: { total: number; remaining: number }): boolean {
  return left.total === right.total && left.remaining === right.remaining;
}

function readReconciliation(value: unknown): Wave2WorkSetReconciliationProof | null {
  if (!isRecord(value) || value.ok !== true || value.sourceHashesMatch !== true) return null;
  const emptyFields = ["missing", "extra", "mismatched", "duplicateSource", "duplicateHandoff", "errors"];
  const arrays = emptyFields.map((key) => readEmptyStringArray(value, key));
  if (arrays.some((array) => array === null)) return null;
  const sourceCount = readCounts(value.sourceCount);
  const handoffCount = readCounts(value.handoffCount);
  const sourceHash = nonEmptyString(value.sourceHash);
  const handoffHash = nonEmptyString(value.handoffHash);
  if (!sourceCount || !handoffCount || !sourceHash || !handoffHash) return null;
  return {
    ok: true,
    missing: [],
    extra: [],
    mismatched: [],
    duplicateSource: [],
    duplicateHandoff: [],
    sourceCount,
    handoffCount,
    sourceHash,
    handoffHash,
    sourceHashesMatch: true,
    errors: []
  };
}

function readHandoffSourceProof(value: unknown): Wave2HandoffProof | null {
  if (!isRecord(value) || !hasOwn(value, "visibility") || !hasOwn(value, "snapshotId") || !hasOwn(value, "scopeCutoffAt") || !hasOwn(value, "sourceHashes") || !hasOwn(value, "sourceHash") || !hasOwn(value, "counts") || !hasOwn(value, "remainingWork") || !hasOwn(value, "reconciliationReceipt") || !hasOwn(value, "handoffHash")) return null;
  if (value.visibility !== "COMPLETE") return null;
  const snapshotId = nonEmptyString(value.snapshotId);
  const scopeCutoffAt = nonEmptyString(value.scopeCutoffAt);
  const sourceHashes = readSourceHashes(value.sourceHashes);
  const sourceHash = nonEmptyString(value.sourceHash);
  const counts = readCounts(value.counts);
  const remainingWork = readWorkItems(value.remainingWork);
  const handoffHash = nonEmptyString(value.handoffHash);
  if (!snapshotId || !scopeCutoffAt || !sourceHashes || !sourceHash || !counts || !remainingWork || !handoffHash || counts.total !== remainingWork.length || counts.remaining !== remainingWork.length) return null;
  const receiptValue = value.reconciliationReceipt;
  if (!isRecord(receiptValue) || !hasOwn(receiptValue, "receiptId") || !hasOwn(receiptValue, "snapshotId") || !hasOwn(receiptValue, "visibility") || !hasOwn(receiptValue, "sourceHash") || !hasOwn(receiptValue, "counts") || !hasOwn(receiptValue, "checkedAt") || !hasOwn(receiptValue, "accepted")) return null;
  const receiptId = nonEmptyString(receiptValue.receiptId);
  const receiptSnapshotId = nonEmptyString(receiptValue.snapshotId);
  const receiptSourceHash = nonEmptyString(receiptValue.sourceHash);
  const receiptCounts = readCounts(receiptValue.counts);
  if (!receiptId || !receiptSnapshotId || receiptSnapshotId !== snapshotId || receiptValue.visibility !== "COMPLETE" || !receiptSourceHash || !receiptCounts || !sameCounts(receiptCounts, counts) || !validTimestamp(receiptValue.checkedAt) || receiptValue.accepted !== true) return null;
  const workHash = workItemsHash(remainingWork);
  if (sourceHash !== workHash || receiptSourceHash !== sourceHash) return null;
  return {
    visibility: "COMPLETE",
    snapshotId,
    scopeCutoffAt,
    sourceHashes,
    handoffHash,
    sourceHash,
    counts,
    remainingWork,
    reconciliationReceipt: { receiptId, snapshotId: receiptSnapshotId, visibility: "COMPLETE", sourceHash: receiptSourceHash, counts: receiptCounts, checkedAt: receiptValue.checkedAt as string, accepted: true },
    reconciliation: { ok: true }
  };
}

function readHandoffDocument(value: unknown): Wave2HandoffDocumentProof | null {
  if (!isRecord(value) || value.schema_version !== "continuity.handoff.v1" || value.status !== "HANDOFF_READY" || !hasOwn(value, "task_id") || !hasOwn(value, "parent_id") || !hasOwn(value, "relay_epoch") || !hasOwn(value, "scope_cutoff_at") || !hasOwn(value, "source_of_truth") || !hasOwn(value, "source_hashes") || !hasOwn(value, "counts") || !hasOwn(value, "remaining_work")) return null;
  const taskId = nonEmptyString(value.task_id);
  const relayEpoch = nonEmptyString(value.relay_epoch);
  const scopeCutoffAt = nonEmptyString(value.scope_cutoff_at);
  const counts = readCounts(value.counts);
  const sourceHashes = readSourceHashes(value.source_hashes);
  const remainingWork = readWorkItems(value.remaining_work);
  const sourceOfTruth = Array.isArray(value.source_of_truth) ? value.source_of_truth.map((entry) => {
    if (!isRecord(entry)) return null;
    const kind = nonEmptyString(entry.kind);
    const ref = nonEmptyString(entry.ref);
    return kind && ref ? { kind, ref } : null;
  }) : null;
  if (!taskId || (value.parent_id !== null && typeof value.parent_id !== "string") || !relayEpoch || !scopeCutoffAt || !counts || !sourceHashes || !remainingWork || !sourceOfTruth || sourceOfTruth.length === 0 || sourceOfTruth.some((entry) => entry === null) || counts.total !== remainingWork.length || counts.remaining !== remainingWork.length) return null;
  return { schema_version: "continuity.handoff.v1", task_id: taskId, parent_id: value.parent_id === null ? null : value.parent_id, status: "HANDOFF_READY", relay_epoch: relayEpoch, scope_cutoff_at: scopeCutoffAt, source_of_truth: sourceOfTruth as Array<{ kind: string; ref: string }>, source_hashes: sourceHashes, counts, remaining_work: remainingWork };
}

function readHandoffRecord(value: unknown): Wave2HandoffRecordProof | null {
  if (!isRecord(value) || !hasOwn(value, "path") || !hasOwn(value, "hash") || !hasOwn(value, "document") || !hasOwn(value, "reconciliation") || !hasOwn(value, "proof")) return null;
  const path = nonEmptyString(value.path);
  const hash = nonEmptyString(value.hash);
  const document = readHandoffDocument(value.document);
  const reconciliation = readReconciliation(value.reconciliation);
  const proof = readHandoffSourceProof(value.proof);
  if (!path || !hash || !document || !reconciliation || !proof) return null;
  return { path, hash, document, reconciliation, proof };
}

function normalizeDrainProof(input: unknown): Wave2DrainProof | null {
  if (!isRecord(input)) return null;
  const result = input as Partial<DrainResult> & Record<string, unknown>;
  if (result.ok !== true || result.state !== "HANDOFF_READY" || result.scopeKnown !== true) return null;
  const snapshot = readSnapshot(result.threadSnapshot);
  const visibleSnapshot = readSnapshot(result.visibleThreadSnapshot);
  const visibleThreads = readThreads(result.visibleThreads);
  const drainSet = readDrainSet(result.drainSet);
  const registeredThreadIds = readStringArray(result, "registeredThreadIds");
  const unregisteredThreadIds = readEmptyStringArray(result, "unregisteredThreadIds");
  const registeredNotVisibleThreadIds = readEmptyStringArray(result, "registeredNotVisibleThreadIds");
  const projectMappingMissing = readEmptyStringArray(result, "projectMappingMissing");
  const projectMappingExtra = readEmptyStringArray(result, "projectMappingExtra");
  const interruptValues = hasOwn(result, "interruptReceipts") && Array.isArray(result.interruptReceipts) ? result.interruptReceipts : null;
  const interruptReceipts = interruptValues?.map(readInterrupt) ?? null;
  const stop = isRecord(result.stopConfirmation) ? result.stopConfirmation : null;
  const handoffReconciliation = readReconciliation(result.handoffReconciliation);
  const handoffSourceReconciliationProof = readHandoffSourceProof(result.handoffSourceReconciliationProof);
  const handoff = hasOwn(result, "handoff") && result.handoff !== null ? readHandoffRecord(result.handoff) : hasOwn(result, "handoff") ? null : null;
  if (!snapshot || !visibleSnapshot || !visibleThreads || !drainSet || !registeredThreadIds || !unregisteredThreadIds || !registeredNotVisibleThreadIds || !projectMappingMissing || !projectMappingExtra || !interruptReceipts || !interruptReceipts.every((receipt): receipt is Wave2InterruptProof => receipt !== null) || !stop || !handoffReconciliation || !handoffSourceReconciliationProof) return null;
  if (canonicalize(snapshot) !== canonicalize(visibleSnapshot) || canonicalize(snapshot.threads) !== canonicalize(visibleThreads)) return null;
  const visibleThreadIds = snapshot.threads.map((thread) => thread.threadId);
  if (new Set(visibleThreadIds).size !== visibleThreadIds.length || new Set(registeredThreadIds).size !== registeredThreadIds.length) return null;
  const visibleSet = new Set(visibleThreadIds);
  const registeredSet = new Set(registeredThreadIds);
  if (visibleSet.size !== registeredSet.size || [...visibleSet].some((threadId) => !registeredSet.has(threadId))) return null;
  if (unregisteredThreadIds.length !== 0 || registeredNotVisibleThreadIds.length !== 0 || projectMappingMissing.length !== 0 || projectMappingExtra.length !== 0) return null;
  if (drainSet.length !== visibleThreads.length || new Set(drainSet.map((entry) => entry.threadId)).size !== drainSet.length) return null;
  for (const thread of visibleThreads) {
    const entry = drainSet.find((candidate) => candidate.threadId === thread.threadId);
    if (!entry || entry.turnId !== thread.turnId || !entry.projectId || entry.registered !== true || entry.mapped !== true) return null;
  }
  if (interruptReceipts.length !== visibleThreads.length || new Set(interruptReceipts.map((receipt) => receipt.threadId)).size !== interruptReceipts.length || new Set(interruptReceipts.map((receipt) => receipt.receiptId)).size !== interruptReceipts.length) return null;
  const interruptThreadSet = new Set(interruptReceipts.map((receipt) => receipt.threadId));
  for (const thread of visibleThreads) {
    const receipt = interruptReceipts.find((candidate) => candidate.threadId === thread.threadId);
    if (!receipt || receipt.turnId !== thread.turnId || !interruptThreadSet.has(thread.threadId)) return null;
  }
  if (!hasOwn(stop, "confirmed") || !hasOwn(stop, "source") || !hasOwn(stop, "receiptIds") || !hasOwn(stop, "pendingThreadIds") || stop.confirmed !== true || stop.source !== "interrupt_receipts") return null;
  const stopReceiptIds = readStringArray(stop, "receiptIds");
  const pendingThreadIds = readEmptyStringArray(stop, "pendingThreadIds");
  if (!stopReceiptIds || !pendingThreadIds || new Set(stopReceiptIds).size !== stopReceiptIds.length || stopReceiptIds.length !== interruptReceipts.length || [...new Set(interruptReceipts.map((receipt) => receipt.receiptId))].some((receiptId) => !stopReceiptIds.includes(receiptId))) return null;
  const sourceProof = handoffSourceReconciliationProof;
  const workHash = workItemsHash(sourceProof.remainingWork);
  if (!sameCounts(handoffReconciliation.sourceCount, sourceProof.counts) || !sameCounts(handoffReconciliation.handoffCount, sourceProof.counts) || handoffReconciliation.sourceHash !== workHash || handoffReconciliation.handoffHash !== workHash || sourceProof.sourceHash !== workHash || sourceProof.reconciliationReceipt.sourceHash !== workHash || sourceProof.reconciliationReceipt.snapshotId !== sourceProof.snapshotId || !sameCounts(sourceProof.reconciliationReceipt.counts, sourceProof.counts)) return null;
  if (handoff) {
    if (handoff.hash !== sourceProof.handoffHash || canonicalize(handoff.reconciliation) !== canonicalize(handoffReconciliation) || canonicalize(handoff.proof) !== canonicalize(sourceProof) || !sameCounts(handoff.document.counts, sourceProof.counts) || canonicalize(handoff.document.remaining_work) !== canonicalize(sourceProof.remainingWork) || canonicalize(handoff.document.source_hashes) !== canonicalize(sourceProof.sourceHashes)) return null;
  }
  if (hasOwn(result, "proofHash") && typeof result.proofHash !== "string") return null;
  const proofPayload = {
    ok: true as const,
    state: "HANDOFF_READY" as const,
    scopeKnown: true as const,
    visibility: "COMPLETE" as const,
    visibilityKnown: true as const,
    scope: "all_visible_active" as const,
    threadSnapshot: snapshot,
    visibleThreadSnapshot: visibleSnapshot,
    visibleThreads,
    drainSet,
    visibleThreadIds,
    registeredThreadIds: sortedUnique(registeredThreadIds),
    unregisteredThreadIds: [] as [],
    registeredNotVisibleThreadIds: [] as [],
    projectMappingMissing: [] as [],
    projectMappingExtra: [] as [],
    interruptReceipts,
    stopConfirmation: { confirmed: true as const, receiptIds: sortedUnique(stopReceiptIds), pendingThreadIds: [] as [] },
    handoff,
    handoffReconciliation,
    handoffSourceReconciliationProof: sourceProof
  };
  const proofHash = sha256(proofPayload);
  if (typeof result.proofHash === "string" && result.proofHash !== proofHash) return null;
  return { ...proofPayload, proofHash };
}

/**
 * Validate every Wave 2 drain fence required before a web worker can start.
 * A bare `ok` flag or a managed subset is never sufficient.
 */
export function validateWave2DrainProof(input: unknown): SupervisionGateResult {
  if (!input) return invalidGate(["drain_receipt"], "A Wave 2 drain receipt is required before starting a web worker");
  const normalized = normalizeDrainProof(input);
  if (!normalized) return invalidGate(["visibility", "interrupt_receipts", "stop_confirmation", "handoff_proof"], "Wave 2 drain receipt is incomplete or not HANDOFF_READY");
  const missing: string[] = [];
  if (normalized.visibility !== "COMPLETE" || normalized.visibilityKnown !== true || normalized.scope !== "all_visible_active") missing.push("complete_visibility");
  if (normalized.unregisteredThreadIds.length > 0) missing.push("unregistered_threads_empty");
  if (normalized.registeredNotVisibleThreadIds.length > 0) missing.push("registered_not_visible_empty");
  if (normalized.projectMappingMissing.length > 0) missing.push("project_mapping_missing_empty");
  if (normalized.projectMappingExtra.length > 0) missing.push("project_mapping_extra_empty");
  const visibleSet = new Set(normalized.visibleThreadIds);
  const receiptSet = new Set(normalized.interruptReceipts.map((receipt) => receipt.threadId));
  for (const threadId of normalized.visibleThreadIds) if (!receiptSet.has(threadId)) missing.push(`interrupt_receipt:${threadId}`);
  for (const threadId of normalized.interruptReceipts.map((receipt) => receipt.threadId)) if (!visibleSet.has(threadId)) missing.push(`unexpected_interrupt_receipt:${threadId}`);
  const interruptReceiptIds = new Set(normalized.interruptReceipts.map((receipt) => receipt.receiptId));
  for (const receiptId of normalized.stopConfirmation.receiptIds) if (!interruptReceiptIds.has(receiptId)) missing.push(`stop_receipt:${receiptId}`);
  const stopReceiptIds = new Set(normalized.stopConfirmation.receiptIds);
  for (const receiptId of interruptReceiptIds) if (!stopReceiptIds.has(receiptId)) missing.push(`stop_receipt_missing:${receiptId}`);
  if (normalized.stopConfirmation.confirmed !== true || normalized.stopConfirmation.pendingThreadIds.length > 0) missing.push("stop_confirmation");
  if (!normalized.handoffSourceReconciliationProof.handoffHash || !normalized.handoffSourceReconciliationProof.sourceHash || normalized.handoffReconciliation.ok !== true) missing.push("handoff_hash_count_proof");
  if (missing.length > 0) return invalidGate([...new Set(missing)], "Wave 2 drain fence is not complete; web worker start remains blocked");
  return { ok: true, proof: normalized, error: null, missing: [] };
}

export function isWave2DrainProofComplete(input: unknown): input is Wave2DrainProof {
  return validateWave2DrainProof(input).ok;
}

export const validateDrainReceipt = validateWave2DrainProof;
export const isDrainProofComplete = isWave2DrainProofComplete;

export function startWebWorker(input: WebWorkerStartRequest): WebWorkerStartReceipt {
  const gate = validateWave2DrainProof(input.drainProof);
  const taskId = nonEmptyString(input.taskId) ?? "";
  const attemptId = nonEmptyString(input.attemptId) ?? "";
  const state: WebWorkerStartReceipt["state"] = gate.ok
    ? input.ledger && input.ledger.lifecycleState === "WEB_UNATTENDED_EXECUTING" ? "WEB_UNATTENDED_EXECUTING" : "HANDOFF_READY"
    : "BLOCKED";
  if (!taskId || !attemptId || (input.ledger && input.ledger.lifecycleState !== "HANDOFF_READY" && input.ledger.lifecycleState !== "WEB_UNATTENDED_EXECUTING")) {
    return {
      schemaVersion: "continuity.web-worker-start.v1",
      requestId: `supervision-${randomUUID()}`,
      taskId,
      attemptId,
      workerKind: input.workerKind,
      accepted: false,
      state: "BLOCKED",
      drainProofHash: gate.proof?.proofHash ?? null,
      error: structuredAdapterError(!taskId || !attemptId ? "INVALID_ATTEMPT" : "INVALID_TRANSITION", "blocked", !taskId || !attemptId ? "Web worker start requires taskId and attemptId" : "Web workers can start only from HANDOFF_READY or active web execution", "supervision.start"),
      evidenceLevel: "UNKNOWN",
      createdAt: nowIso()
    };
  }
  return {
    schemaVersion: "continuity.web-worker-start.v1",
    requestId: `supervision-${randomUUID()}`,
    taskId,
    attemptId,
    workerKind: input.workerKind,
    accepted: gate.ok,
    state,
    drainProofHash: gate.proof?.proofHash ?? null,
    error: gate.error,
    evidenceLevel: gate.ok ? "MOCK_PASS" : "UNKNOWN",
    createdAt: nowIso()
  };
}

export const prepareWebWorkerStart = startWebWorker;

export class WorkerSupervisionController {
  private readonly attempts = new Map<string, SupervisionAttemptState>();
  private readonly controls = new Map<string, StoredControl>();

  constructor(initialAttempts: readonly SupervisionAttemptState[] = []) {
    for (const attempt of initialAttempts) this.registerAttempt(attempt);
  }

  registerAttempt(attempt: SupervisionAttemptState): void {
    if (!nonEmptyString(attempt.taskId) || !nonEmptyString(attempt.attemptId)) throw new DomainError("RED_FLAGGED_INPUT", "Worker attempt requires taskId and attemptId");
    if (this.attempts.has(attempt.attemptId)) throw new DomainError("DUPLICATE_TASK", `Worker attempt ${attempt.attemptId} already exists`);
    if ((attempt.kind === "dsh" || attempt.kind === "bridge-dsh") && attempt.continuation !== "dsh_fresh") throw new DomainError("ROUTING_REJECTED", "DSH attempts must use dsh_fresh continuation semantics");
    if (attempt.kind === "claude" && attempt.continuation !== "claude_resume") throw new DomainError("ROUTING_REJECTED", "Claude attempts must use claude_resume continuation semantics");
    this.attempts.set(attempt.attemptId, { ...attempt });
  }

  getAttempt(attemptId: string): SupervisionAttemptState | null {
    const attempt = this.attempts.get(attemptId);
    return attempt ? { ...attempt } : null;
  }

  /**
   * Insert or overwrite an attempt from durable state.  Used at recovery: the
   * controller is created empty in a fresh process, while the attempt it is
   * asked to control may have been started by the previous one.
   */
  restoreAttempt(attempt: SupervisionAttemptState): void {
    if (!nonEmptyString(attempt.taskId) || !nonEmptyString(attempt.attemptId)) throw new DomainError("RED_FLAGGED_INPUT", "Worker attempt requires taskId and attemptId");
    this.attempts.set(attempt.attemptId, { ...attempt });
  }

  control(request: WorkerControlRequest): WorkerControlReceipt {
    const attempt = this.attempts.get(request.attemptId);
    const previousStatus = attempt?.status ?? "unknown";
    const previousRevision = attempt?.revision ?? 0;
    const instruction = normalizeInstruction(request.instruction);
    const payloadHash = sha256({ taskId: request.taskId, attemptId: request.attemptId, action: request.action, expectedRevision: request.expectedRevision, instruction });
    const previous = this.controls.get(request.idempotencyKey);
    if (!isWorkerControlAction(request.action)) return this.rejected(request, previousStatus, previousRevision, structuredAdapterError("ACTION_NOT_ALLOWED", "blocked", "Worker control action is outside the closed allowlist", "supervision.control"));
    if (previous) {
      if (previous.payloadHash !== payloadHash) return this.rejected(request, previousStatus, previousRevision, structuredAdapterError("IDEMPOTENCY_KEY_REUSED", "blocked", "Idempotency key was reused for another worker control payload", "supervision.control"));
      return { ...previous.receipt, replayed: true };
    }
    if (!nonEmptyString(request.idempotencyKey)) return this.rejected(request, previousStatus, previousRevision, structuredAdapterError("INVALID_IDEMPOTENCY_KEY", "blocked", "Worker control requires a non-empty idempotency key", "supervision.control"));
    if (!attempt || attempt.taskId !== request.taskId) return this.rejected(request, previousStatus, previousRevision, structuredAdapterError("UNKNOWN_ATTEMPT", "blocked", "Worker attempt is not registered for this task", "supervision.control"));
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== attempt.revision) return this.rejected(request, previousStatus, previousRevision, structuredAdapterError("REVISION_CONFLICT", "blocked", "Worker control revision does not match the registered attempt", "supervision.control", { expectedRevision: request.expectedRevision, actualRevision: attempt.revision }));
    if (!instruction.valid) return this.rejected(request, previousStatus, previousRevision, instruction.error);
    const guard = this.guardAction(attempt, request.action, instruction.value);
    if (guard) return this.rejected(request, previousStatus, previousRevision, guard);
    const nextStatus = request.action === "continue" || request.action === "steer" ? "running" : request.action === "interrupt" ? "failed" : "completed";
    const nextRevision = attempt.revision + 1;
    const receipt: WorkerControlReceipt = {
      schemaVersion: "continuity.worker-control.v1",
      requestId: `control-${randomUUID()}`,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      action: request.action,
      accepted: true,
      replayed: false,
      previousStatus,
      status: nextStatus,
      previousRevision,
      revision: nextRevision,
      requiresFreshTurn: attempt.kind === "dsh" || attempt.kind === "bridge-dsh",
      instructionRef: instruction.value,
      error: null,
      evidenceLevel: request.evidenceLevel === "UNKNOWN" ? "UNKNOWN" : "MOCK_PASS",
      createdAt: nowIso()
    };
    attempt.status = nextStatus;
    attempt.revision = nextRevision;
    attempt.terminal = request.action === "interrupt" || request.action === "accept";
    this.controls.set(request.idempotencyKey, { payloadHash, receipt });
    return { ...receipt };
  }

  continue(request: Omit<WorkerControlRequest, "action">): WorkerControlReceipt {
    return this.control({ ...request, action: "continue" });
  }

  steer(request: Omit<WorkerControlRequest, "action">): WorkerControlReceipt {
    return this.control({ ...request, action: "steer" });
  }

  interrupt(request: Omit<WorkerControlRequest, "action">): WorkerControlReceipt {
    return this.control({ ...request, action: "interrupt" });
  }

  accept(request: Omit<WorkerControlRequest, "action">): WorkerControlReceipt {
    return this.control({ ...request, action: "accept" });
  }

  /**
   * Undo an accepted control whose real upstream action was not confirmed.
   * Supervision owns the attempt state machine, so only it may revert a
   * transition; recording a control that never reached the worker would be a
   * fabricated success.  The idempotency key is released so a later retry with
   * the same key is not answered from a rolled-back receipt.
   */
  unwindControl(input: { attemptId: string; idempotencyKey: string; status: WorkerStatus; revision: number; terminal: boolean }): void {
    const attempt = this.attempts.get(input.attemptId);
    if (attempt) {
      attempt.status = input.status;
      attempt.revision = input.revision;
      attempt.terminal = input.terminal;
    }
    this.controls.delete(input.idempotencyKey);
  }

  private guardAction(attempt: SupervisionAttemptState, action: WorkerControlAction, instruction: StructuredInstructionRef | null): StructuredAdapterError | null {
    if (attempt.terminal) return structuredAdapterError("INVALID_WORKER_STATE", "blocked", "Terminal worker attempts cannot receive further controls", "supervision.control");
    if ((action === "continue" || action === "steer") && instruction === null) return structuredAdapterError("INSTRUCTION_REF_REQUIRED", "blocked", `${action} requires a structured instruction reference`, "supervision.control");
    if (action === "continue" && attempt.status !== "review") return structuredAdapterError("INVALID_WORKER_STATE", "blocked", "continue is valid only for a worker awaiting supervisor review", "supervision.control");
    if (action === "steer" && attempt.status !== "running") return structuredAdapterError("INVALID_WORKER_STATE", "blocked", "steer is valid only for a running worker", "supervision.control");
    if (action === "steer" && (attempt.kind === "dsh" || attempt.kind === "bridge-dsh")) return structuredAdapterError("ROUTING_REJECTED", "blocked", "DSH has no steer/resume seam; start a fresh turn", "supervision.control");
    if (action === "interrupt" && attempt.status !== "running") return structuredAdapterError("INVALID_WORKER_STATE", "blocked", "interrupt is valid only for a running worker", "supervision.control");
    if (action === "accept" && attempt.status !== "review") return structuredAdapterError("INVALID_WORKER_STATE", "blocked", "accept is valid only for a worker awaiting supervisor review", "supervision.control");
    return null;
  }

  private rejected(request: WorkerControlRequest, previousStatus: WorkerStatus, previousRevision: number, error: StructuredAdapterError): WorkerControlReceipt {
    return {
      schemaVersion: "continuity.worker-control.v1",
      requestId: `control-rejected-${randomUUID()}`,
      taskId: request.taskId,
      attemptId: request.attemptId,
      action: request.action,
      accepted: false,
      replayed: false,
      previousStatus,
      status: previousStatus,
      previousRevision,
      revision: previousRevision,
      requiresFreshTurn: false,
      instructionRef: null,
      error,
      evidenceLevel: "UNKNOWN",
      createdAt: nowIso()
    };
  }
}

function normalizeInstruction(value: unknown): { valid: true; value: StructuredInstructionRef | null } | { valid: false; value: null; error: StructuredAdapterError } {
  if (value === undefined) return { valid: true, value: null };
  const ref = isRecord(value) ? nonEmptyString(value.ref) : null;
  const source = isRecord(value) ? nonEmptyString(value.source) : null;
  if (!isRecord(value) || value.kind !== "instruction_ref" || !ref || !source) return { valid: false, value: null, error: structuredAdapterError("ARBITRARY_TEXT_REJECTED", "blocked", "Worker supervision accepts only a structured instruction_ref, never arbitrary web text", "supervision.control") };
  const hash = value.hash === undefined ? undefined : nonEmptyString(value.hash);
  return { valid: true, value: { kind: "instruction_ref", ref, source, ...(hash ? { hash } : {}) } };
}

export type Supervision = WorkerSupervisionController;
