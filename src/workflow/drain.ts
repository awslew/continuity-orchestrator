import { sha256 } from "../domain/canonical.js";
import type { HandoffCounts, HandoffReconciliationProof, HandoffSourceSnapshot, TaskLedger } from "../domain/types.js";
import { HandoffStore, reconcileWorkSets, type HandoffWriteResult } from "../persistence/handoff-store.js";
import { DomainError } from "../domain/errors.js";
import type {
  AdapterFault,
  CodexAppServerAdapter,
  InterruptReceipt,
  ThreadSummary,
  VisibleThreadList
} from "../adapters/codex-app-server.js";

export interface DrainProjectMapping {
  [threadId: string]: string | null | undefined;
}

export interface DrainOptions {
  ledger: TaskLedger;
  adapter: Pick<CodexAppServerAdapter, "listVisibleActiveThreads" | "interruptTurn">;
  /** The exact set already registered in this drain operation. */
  registeredThreadIds?: readonly string[];
  /** Legacy caller input; any strict subset of visible threads is rejected. */
  managedThreadIds?: readonly string[];
  projectMapping?: DrainProjectMapping | ReadonlyMap<string, string | null | undefined>;
  handoffStore?: HandoffStore;
  sourceSnapshot?: HandoffSourceSnapshot;
  interruptIdempotencyPrefix?: string;
}

export interface DrainFault {
  code: string;
  status: "blocked" | "reconcile_required" | "unknown" | "retryable";
  message: string;
  threadId?: string;
  externalId?: string | null;
}

export interface DrainSetEntry {
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  registered: boolean;
  mapped: boolean;
}

export interface StopConfirmation {
  confirmed: boolean;
  source: "interrupt_receipts";
  receiptIds: string[];
  pendingThreadIds: string[];
}

export interface DrainThreadSnapshot {
  snapshotId: string;
  visibilityKnown: boolean;
  scope: "all_visible_active" | "unknown";
  threads: ThreadSummary[];
  listHash: string;
}

export interface DrainResult {
  ok: boolean;
  state: "DRAINING" | "HANDOFF_READY";
  scopeKnown: boolean;
  /** Immutable-in-result snapshot of the complete list response used by this drain. */
  threadSnapshot: DrainThreadSnapshot;
  /** Alias retained for evidence consumers that call the object a full snapshot. */
  visibleThreadSnapshot: DrainThreadSnapshot;
  visibleThreads: ThreadSummary[];
  drainSet: DrainSetEntry[];
  registeredThreadIds: string[];
  unregisteredThreadIds: string[];
  registeredNotVisibleThreadIds: string[];
  managedSubsetRejected: boolean;
  projectMappingMissing: string[];
  projectMappingExtra: string[];
  interruptReceipts: InterruptReceipt[];
  stopConfirmation: StopConfirmation;
  handoff: HandoffWriteResult | null;
  handoffReconciliation: ReturnType<typeof reconcileWorkSets> | null;
  handoffSourceReconciliationProof: HandoffReconciliationProof | null;
  faults: DrainFault[];
  evidenceHash: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))].sort();
}

function mappingValue(mapping: DrainOptions["projectMapping"], thread: ThreadSummary): string | null {
  if (mapping instanceof Map) return mapping.has(thread.threadId) ? mapping.get(thread.threadId) ?? null : null;
  if (mapping !== undefined && mapping !== null) {
    return Object.prototype.hasOwnProperty.call(mapping, thread.threadId) ? (mapping as DrainProjectMapping)[thread.threadId] ?? null : null;
  }
  return thread.projectId;
}

function mappingKeys(mapping: DrainOptions["projectMapping"]): string[] {
  if (mapping instanceof Map) return [...mapping.keys()];
  return mapping ? Object.keys(mapping) : [];
}

function adapterFaultToDrainFault(fault: AdapterFault, threadId?: string): DrainFault {
  return {
    code: fault.code,
    status: fault.status,
    message: fault.message,
    ...(threadId === undefined ? {} : { threadId }),
    ...(fault.externalId === undefined ? {} : { externalId: fault.externalId })
  };
}

function invalidInterrupt(threadId: string, turnId: string | null, idempotencyKey: string): InterruptReceipt {
  return {
    kind: "turn_interrupt",
    operation: "turn/interrupt",
    threadId,
    turnId: turnId ?? "",
    idempotencyKey,
    receiptId: null,
    status: "failed",
    confirmed: false,
    accepted: false,
    fault: {
      code: "INVALID_TURN_ID",
      status: "blocked",
      message: "The active thread has no stable turn id; no id was fabricated",
      operation: "turn/interrupt",
      at: new Date().toISOString(),
      externalId: threadId
    }
  };
}

function readThreadList(value: VisibleThreadList | ThreadSummary[] | { threads?: ThreadSummary[]; visibilityKnown?: boolean; visibility?: string; fault?: AdapterFault | null }): {
  threads: ThreadSummary[];
  scopeKnown: boolean;
  fault: AdapterFault | null;
} {
  if (Array.isArray(value)) {
    return {
      threads: value,
      scopeKnown: "visibilityKnown" in value && value.visibilityKnown === true,
      fault: "fault" in value ? value.fault ?? null : null
    };
  }
  const threads = Array.isArray(value.threads) ? value.threads : [];
  return {
    threads,
    scopeKnown: value.visibilityKnown === true || value.visibility === "complete" || value.visibility === "all_visible_active",
    fault: value.fault ?? null
  };
}

function validThread(value: ThreadSummary): boolean {
  return Boolean(value && typeof value.threadId === "string" && value.threadId.trim() && (value.turnId === null || typeof value.turnId === "string"));
}

function asFault(error: unknown): DrainFault {
  if (error instanceof DomainError) return { code: error.code, status: "blocked", message: error.message };
  if (error instanceof Error) return { code: "DRAIN_OPERATION_FAILED", status: "unknown", message: error.message };
  return { code: "DRAIN_OPERATION_FAILED", status: "unknown", message: String(error) };
}

function emptyHandoffReconciliation(): ReturnType<typeof reconcileWorkSets> {
  const empty: HandoffCounts = { total: 0, remaining: 0 };
  return reconcileWorkSets([], [], empty, empty);
}

/**
 * Enumerate, register, map, interrupt, and reconcile the complete visible
 * active-thread set.  Any uncertainty leaves the operation in DRAINING.
 */
export async function drainAllVisibleActiveThreads(options: DrainOptions): Promise<DrainResult> {
  const registered = sortedUnique(options.registeredThreadIds ?? (options.ledger.codex.threadId ? [options.ledger.codex.threadId] : []));
  const prefix = options.interruptIdempotencyPrefix ?? `${options.ledger.taskId}:${options.ledger.relayEpoch}`;
  const faults: DrainFault[] = [];
  let listValue: VisibleThreadList | ThreadSummary[] | { threads?: ThreadSummary[]; visibilityKnown?: boolean; visibility?: string; fault?: AdapterFault | null };
  try {
    listValue = await options.adapter.listVisibleActiveThreads();
  } catch (error) {
    faults.push(asFault(error));
    return {
      ok: false,
      state: "DRAINING",
      scopeKnown: false,
      threadSnapshot: { snapshotId: sha256({ threads: [], scopeKnown: false }), visibilityKnown: false, scope: "unknown", threads: [], listHash: sha256([]) },
      visibleThreadSnapshot: { snapshotId: sha256({ threads: [], scopeKnown: false }), visibilityKnown: false, scope: "unknown", threads: [], listHash: sha256([]) },
      visibleThreads: [],
      drainSet: [],
      registeredThreadIds: registered,
      unregisteredThreadIds: [],
      registeredNotVisibleThreadIds: registered,
      managedSubsetRejected: false,
      projectMappingMissing: [],
      projectMappingExtra: [],
      interruptReceipts: [],
      stopConfirmation: { confirmed: false, source: "interrupt_receipts", receiptIds: [], pendingThreadIds: [] },
      handoff: null,
      handoffReconciliation: null,
      handoffSourceReconciliationProof: null,
      faults,
      evidenceHash: sha256({ state: "DRAINING", faults })
    };
  }

  const parsed = readThreadList(listValue);
  const visibleThreads = parsed.threads.filter(validThread);
  if (parsed.fault) faults.push(adapterFaultToDrainFault(parsed.fault));
  if (!parsed.scopeKnown) faults.push({ code: "DRAIN_SCOPE_UNKNOWN", status: "blocked", message: "App Server did not prove the complete visible active-thread scope" });
  if (visibleThreads.length !== parsed.threads.length) faults.push({ code: "UNMAPPED_THREAD", status: "blocked", message: "thread/list contained an object without a stable thread id" });

  const visibleIds = sortedUnique(visibleThreads.map((thread) => thread.threadId));
  const visibleIdSet = new Set(visibleIds);
  const duplicateVisibleThreadIds = visibleThreads.map((thread) => thread.threadId).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateVisibleThreadIds.length) faults.push({ code: "DUPLICATE_VISIBLE_THREAD", status: "blocked", message: "thread/list returned the same visible thread more than once" });
  const registeredIdSet = new Set(registered);
  const unregisteredThreadIds = visibleIds.filter((id) => !registeredIdSet.has(id));
  const registeredNotVisibleThreadIds = registered.filter((id) => !visibleIdSet.has(id));
  if (unregisteredThreadIds.length || registeredNotVisibleThreadIds.length) {
    faults.push({ code: "DRAIN_REGISTRATION_DIFFERENCE", status: "blocked", message: "Registered drain set differs from all visible active threads" });
  }

  const managed = sortedUnique(options.managedThreadIds ?? []);
  const managedSet = new Set(managed);
  const managedSubsetRejected = managed.length > 0 && (managed.length !== visibleIds.length || visibleIds.some((id) => !managedSet.has(id)));
  if (managedSubsetRejected) faults.push({ code: "MANAGED_SUBSET_NOT_ALLOWED", status: "blocked", message: "A managed thread subset cannot stand in for all visible active threads" });

  const mappingById = new Map<string, string | null>();
  const projectMappingMissing: string[] = [];
  for (const thread of visibleThreads) {
    const projectId = mappingValue(options.projectMapping, thread);
    mappingById.set(thread.threadId, projectId);
    if (!projectId) projectMappingMissing.push(thread.threadId);
  }
  const projectMappingExtra = mappingKeys(options.projectMapping).filter((id) => !visibleIdSet.has(id)).sort();
  if (projectMappingMissing.length || projectMappingExtra.length) faults.push({ code: "PROJECT_MAPPING_DIFFERENCE", status: "blocked", message: "Project mapping does not exactly cover the visible drain set" });

  const drainSet: DrainSetEntry[] = visibleThreads.map((thread) => ({
    threadId: thread.threadId,
    turnId: thread.turnId,
    projectId: mappingById.get(thread.threadId) ?? null,
    registered: registeredIdSet.has(thread.threadId),
    mapped: Boolean(mappingById.get(thread.threadId))
  }));
  const threadSnapshot: DrainThreadSnapshot = {
    snapshotId: sha256({ visibilityKnown: parsed.scopeKnown, scope: parsed.scopeKnown ? "all_visible_active" : "unknown", threads: visibleThreads, listHash: sha256(visibleThreads) }),
    visibilityKnown: parsed.scopeKnown,
    scope: parsed.scopeKnown ? "all_visible_active" : "unknown",
    threads: visibleThreads.map((thread) => ({ ...thread })),
    listHash: sha256(visibleThreads)
  };

  const canInterrupt = parsed.scopeKnown && faults.length === 0;
  const interruptReceipts: InterruptReceipt[] = [];
  if (canInterrupt) {
    for (const thread of visibleThreads) {
      const idempotencyKey = `${prefix}:interrupt:${thread.threadId}`;
      const receipt = thread.turnId
        ? await options.adapter.interruptTurn(thread.threadId, thread.turnId, idempotencyKey)
        : invalidInterrupt(thread.threadId, thread.turnId, idempotencyKey);
      interruptReceipts.push(receipt);
      if (!receipt.confirmed) {
        if (receipt.fault) faults.push(adapterFaultToDrainFault(receipt.fault, thread.threadId));
        else faults.push({ code: "INTERRUPT_NOT_CONFIRMED", status: "reconcile_required", message: "Interrupt returned without confirmation", threadId: thread.threadId });
      }
    }
  }

  const stopConfirmation: StopConfirmation = {
    confirmed: visibleThreads.length === interruptReceipts.length && interruptReceipts.length === visibleThreads.length && interruptReceipts.every((receipt) => receipt.confirmed),
    source: "interrupt_receipts",
    receiptIds: interruptReceipts.filter((receipt) => receipt.confirmed && receipt.receiptId).map((receipt) => receipt.receiptId!),
    pendingThreadIds: visibleThreads.filter((thread) => !interruptReceipts.find((receipt) => receipt.threadId === thread.threadId && receipt.confirmed)).map((thread) => thread.threadId)
  };
  if (!stopConfirmation.confirmed) faults.push({ code: "STOP_NOT_CONFIRMED", status: "reconcile_required", message: "Every visible active thread requires an explicit interrupt receipt" });

  let handoff: HandoffWriteResult | null = null;
  let handoffReconciliation: ReturnType<typeof reconcileWorkSets> | null = null;
  let handoffSourceReconciliationProof: HandoffReconciliationProof | null = null;
  if (!options.handoffStore || !options.sourceSnapshot) {
    faults.push({ code: "HANDOFF_RECONCILIATION_REQUIRED", status: "blocked", message: "A complete source snapshot and handoff store are required before HANDOFF_READY" });
  } else if (faults.length === 0) {
    try {
      handoff = options.handoffStore.writeHandoff(options.ledger, options.sourceSnapshot);
      handoffReconciliation = handoff.reconciliation;
      handoffSourceReconciliationProof = handoff.proof;
      if (!handoffReconciliation.ok) faults.push({ code: "HANDOFF_RECONCILIATION_FAILED", status: "blocked", message: "handoff.md work set did not reconcile" });
    } catch (error) {
      faults.push(asFault(error));
      handoffReconciliation = emptyHandoffReconciliation();
    }
  }

  const ok = parsed.scopeKnown && faults.length === 0 && stopConfirmation.confirmed &&
    Boolean(handoff && handoffReconciliation?.ok && handoffSourceReconciliationProof);
  const result: DrainResult = {
    ok,
    state: ok ? "HANDOFF_READY" : "DRAINING",
    scopeKnown: parsed.scopeKnown,
    threadSnapshot,
    visibleThreadSnapshot: threadSnapshot,
    visibleThreads,
    drainSet,
    registeredThreadIds: registered,
    unregisteredThreadIds,
    registeredNotVisibleThreadIds,
    managedSubsetRejected,
    projectMappingMissing: sortedUnique(projectMappingMissing),
    projectMappingExtra,
    interruptReceipts,
    stopConfirmation,
    handoff,
    handoffReconciliation,
    handoffSourceReconciliationProof,
    faults,
    evidenceHash: sha256({
      scopeKnown: parsed.scopeKnown,
      visibleThreads,
      drainSet,
      registered,
      unregisteredThreadIds,
      registeredNotVisibleThreadIds,
      projectMappingMissing,
      projectMappingExtra,
      interruptReceipts,
      stopConfirmation,
      handoffHash: handoff?.hash ?? null,
      faults
    })
  };
  return result;
}

/** Exported reconciliation helper for callers that already have handoff.md data. */
export function reconcileHandoffWorkSet(
  source: HandoffSourceSnapshot["remainingWork"],
  handoff: HandoffSourceSnapshot["remainingWork"],
  sourceCounts?: HandoffCounts,
  handoffCounts?: HandoffCounts
): ReturnType<typeof reconcileWorkSets> {
  return reconcileWorkSets(source, handoff, sourceCounts, handoffCounts);
}

export function drainFencePassed(result: DrainResult): boolean {
  return result.ok && result.state === "HANDOFF_READY" && result.scopeKnown &&
    result.unregisteredThreadIds.length === 0 && result.registeredNotVisibleThreadIds.length === 0 &&
    result.projectMappingMissing.length === 0 && result.projectMappingExtra.length === 0 &&
    result.stopConfirmation.confirmed && Boolean(result.handoffReconciliation?.ok && result.handoffSourceReconciliationProof);
}

export const prepareDrain = drainAllVisibleActiveThreads;
export const drainCodexThreads = drainAllVisibleActiveThreads;
