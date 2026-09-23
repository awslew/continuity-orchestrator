import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256, clone, canonicalize, workItemsHash } from "../domain/canonical.js";
import { DomainError } from "../domain/errors.js";
import type {
  HandoffCounts,
  HandoffDocument,
  HandoffReconciliationProof,
  HandoffSourceSnapshot,
  RemainingWorkItem,
  TaskLedger,
  TerminalReason,
  WorkSetReconciliation
} from "../domain/types.js";
import { atomicWriteJson, atomicWriteText, readJson, readText, resolveWithinRoot } from "./atomic-json.js";
import { redactRecord, REDACTION_VERSION } from "./redaction.js";
import { EventLog } from "./event-log.js";

function assertTaskId(taskId: string): void {
  if (!taskId || taskId.includes("\u0000") || taskId.includes("/") || taskId.includes("\\") || taskId === "." || taskId === "..") {
    throw new DomainError("PATH_OUTSIDE_ROOT", `Invalid task id ${taskId}`);
  }
}

function activeWork(items: readonly RemainingWorkItem[]): RemainingWorkItem[] {
  return items.filter((item) => item.status !== "DONE").map((item) => clone(item));
}

function countsFor(items: readonly RemainingWorkItem[]): HandoffCounts {
  return { total: items.length, remaining: items.filter((item) => item.status !== "DONE").length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validCounts(value: unknown): value is HandoffCounts {
  if (!isRecord(value)) return false;
  return typeof value.total === "number" && typeof value.remaining === "number" && Number.isSafeInteger(value.total) && Number.isSafeInteger(value.remaining) && value.total >= 0 && value.remaining >= 0 && value.remaining <= value.total;
}

function validSourceHashes(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, hash]) => key.length > 0 && typeof hash === "string" && hash.trim().length > 0);
}

function validWorkItem(value: unknown): value is RemainingWorkItem {
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

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function duplicateIds(items: readonly RemainingWorkItem[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.taskId)) duplicates.add(item.taskId);
    seen.add(item.taskId);
  }
  return [...duplicates].sort();
}

function normalizedWorkForHash(items: readonly RemainingWorkItem[]): RemainingWorkItem[] {
  return [...items].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((item) => ({
    taskId: item.taskId,
    parentId: item.parentId,
    status: item.status,
    dependencies: [...item.dependencies].sort(),
    acceptance: [...item.acceptance],
    acceptancePassed: item.acceptancePassed,
    evidence: [...item.evidence].sort(),
    lastCheckpoint: item.lastCheckpoint,
    sourceOfTruth: item.sourceOfTruth
  }));
}

export function workSetHash(items: readonly RemainingWorkItem[]): string {
  return workItemsHash(items);
}

export function reconcileWorkSets(
  source: readonly RemainingWorkItem[],
  handoff: readonly RemainingWorkItem[],
  sourceCounts: HandoffCounts = countsFor(source),
  handoffCounts: HandoffCounts = countsFor(handoff)
): WorkSetReconciliation {
  const sourceIds = new Set(source.map((item) => item.taskId));
  const handoffIds = new Set(handoff.map((item) => item.taskId));
  const missing = [...sourceIds].filter((id) => !handoffIds.has(id)).sort();
  const extra = [...handoffIds].filter((id) => !sourceIds.has(id)).sort();
  const sourceById = new Map(source.map((item) => [item.taskId, item]));
  const handoffById = new Map(handoff.map((item) => [item.taskId, item]));
  const mismatched: string[] = [];
  for (const id of sourceIds) {
    const sourceItem = sourceById.get(id);
    const handoffItem = handoffById.get(id);
    if (sourceItem && handoffItem && canonicalize(normalizedWorkForHash([sourceItem])) !== canonicalize(normalizedWorkForHash([handoffItem]))) {
      mismatched.push(id);
    }
  }
  const duplicateSource = duplicateIds(source);
  const duplicateHandoff = duplicateIds(handoff);
  const sourceHash = workSetHash(source);
  const handoffHash = workSetHash(handoff);
  const errors: string[] = [];
  if (missing.length) errors.push(`missing:${missing.join(",")}`);
  if (extra.length) errors.push(`extra:${extra.join(",")}`);
  if (mismatched.length) errors.push(`mismatched:${mismatched.join(",")}`);
  if (duplicateSource.length) errors.push(`duplicate_source:${duplicateSource.join(",")}`);
  if (duplicateHandoff.length) errors.push(`duplicate_handoff:${duplicateHandoff.join(",")}`);
  if (sourceCounts.total !== handoffCounts.total) errors.push(`total_count:${sourceCounts.total}!=${handoffCounts.total}`);
  if (sourceCounts.remaining !== handoffCounts.remaining) errors.push(`remaining_count:${sourceCounts.remaining}!=${handoffCounts.remaining}`);
  if (sourceHash !== handoffHash) errors.push("work_hash_mismatch");
  return {
    ok: errors.length === 0,
    missing,
    extra,
    mismatched,
    duplicateSource,
    duplicateHandoff,
    sourceCount: sourceCounts,
    handoffCount: handoffCounts,
    sourceHash,
    handoffHash,
    sourceHashesMatch: true,
    errors
  };
}

/**
 * Validate the complete source snapshot before it can be used to write or
 * reconcile handoff.md. A raw task array, a sidecar hint, or an unknown
 * visibility value is deliberately rejected here.
 */
function validateSourceSnapshot(ledger: TaskLedger, snapshot: HandoffSourceSnapshot): WorkSetReconciliation {
  if (!isRecord(snapshot) || Array.isArray(snapshot)) {
    throw new DomainError("HANDOFF_SOURCE_REQUIRED", "A trusted source snapshot is required; a raw or partial work array is not sufficient");
  }
  if (snapshot.visibility !== "COMPLETE") {
    throw new DomainError("HANDOFF_SCOPE_UNKNOWN", "Handoff source visibility is unknown");
  }
  if (typeof snapshot.snapshotId !== "string" || snapshot.snapshotId.trim().length === 0 ||
      typeof snapshot.scopeCutoffAt !== "string" || snapshot.scopeCutoffAt !== ledger.scopeCutoffAt) {
    throw new DomainError("HANDOFF_RECEIPT_INVALID", "Handoff source snapshot identity or scope cutoff is invalid");
  }
  if (!validSourceHashes(snapshot.sourceHashes) || !validCounts(snapshot.counts) || !Array.isArray(snapshot.remainingWork) || !snapshot.remainingWork.every(validWorkItem)) {
    throw new DomainError("HANDOFF_SOURCE_REQUIRED", "Handoff source snapshot is incomplete or contains invalid work");
  }
  const receipt = snapshot.reconciliationReceipt;
  if (!isRecord(receipt) || typeof receipt.receiptId !== "string" || receipt.receiptId.trim().length === 0 ||
      typeof receipt.snapshotId !== "string" || receipt.snapshotId !== snapshot.snapshotId ||
      receipt.visibility !== "COMPLETE" || receipt.accepted !== true || !validTimestamp(receipt.checkedAt) ||
      typeof receipt.sourceHash !== "string" || !validCounts(receipt.counts)) {
    throw new DomainError("HANDOFF_RECEIPT_INVALID", "Handoff source snapshot lacks a valid reconciliation receipt");
  }

  const expected = activeWork(ledger.remainingWork);
  const expectedCounts = countsFor(expected);
  const actualSnapshotCounts = countsFor(snapshot.remainingWork);
  if (actualSnapshotCounts.total !== snapshot.counts.total || actualSnapshotCounts.remaining !== snapshot.counts.remaining) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff source counts do not match its remaining_work", {
      actual: actualSnapshotCounts,
      declared: snapshot.counts
    });
  }
  if (snapshot.counts.total !== expectedCounts.total || snapshot.counts.remaining !== expectedCounts.remaining) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff source counts do not cover all non-terminal ledger work", {
      expected: expectedCounts,
      actual: snapshot.counts
    });
  }
  const reconciliation = reconcileWorkSets(expected, snapshot.remainingWork, expectedCounts, snapshot.counts);
  if (!reconciliation.ok) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff source work set failed reconciliation", { ...reconciliation });
  }
  const expectedHash = workSetHash(expected);
  if (typeof snapshot.sourceHash !== "string" || snapshot.sourceHash !== expectedHash ||
      receipt.sourceHash !== expectedHash || receipt.counts.total !== expectedCounts.total || receipt.counts.remaining !== expectedCounts.remaining ||
      canonicalize(snapshot.sourceHashes) !== canonicalize(ledger.sourceHashes)) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff source hashes or receipt counts do not match the complete ledger set", {
      expectedHash,
      snapshotHash: snapshot.sourceHash,
      receiptHash: receipt.sourceHash
    });
  }
  return reconciliation;
}

function markdownBlock(marker: string, document: unknown): string {
  return `# Continuity ${marker}\n\n<!-- ${marker.toLowerCase()}:v1 -->\n\n\`\`\`json\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
}

function extractMarkdownDocument(text: string, marker: string): unknown {
  const expectedMarker = `<!-- ${marker.toLowerCase()}:v1 -->`;
  if (!text.includes(expectedMarker)) throw new DomainError("MALFORMED_HANDOFF", `Missing ${marker} marker`);
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) throw new DomainError("MALFORMED_HANDOFF", `Missing ${marker} JSON block`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new DomainError("MALFORMED_HANDOFF", `Invalid ${marker} JSON: ${String(error)}`);
  }
}

function validateDocument(value: unknown): HandoffDocument {
  if (!value || typeof value !== "object") throw new DomainError("MALFORMED_HANDOFF", "Handoff document is not an object");
  const document = value as Partial<HandoffDocument>;
  if (document.schema_version !== "continuity.handoff.v1" || document.status !== "HANDOFF_READY" || !document.task_id || !document.relay_epoch || !document.scope_cutoff_at || !Array.isArray(document.remaining_work) || !validSourceHashes(document.source_hashes) || !validCounts(document.counts)) {
    throw new DomainError("MALFORMED_HANDOFF", "Handoff document is missing required fields");
  }
  const work = document.remaining_work as RemainingWorkItem[];
  for (const item of work) {
    if (!validWorkItem(item)) {
      throw new DomainError("MALFORMED_HANDOFF", "Handoff contains an invalid remaining_work item");
    }
  }
  const actualCounts = countsFor(work);
  if (actualCounts.total !== document.counts.total || actualCounts.remaining !== document.counts.remaining) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff counts do not match remaining_work", { actualCounts, declared: document.counts });
  }
  return clone(document as HandoffDocument);
}

export interface HandoffWriteResult {
  path: string;
  hash: string;
  document: HandoffDocument;
  reconciliation: WorkSetReconciliation;
  proof: HandoffReconciliationProof;
}

export interface ReturnDocument {
  schema_version: "continuity.return.v1";
  task_id: string;
  relay_epoch: string;
  terminal_reason: TerminalReason;
  last_web_cursor: string | null;
  last_checkpoint: string;
  quota_snapshot: TaskLedger["quotaGate"];
  counts: HandoffCounts;
  remaining_work: RemainingWorkItem[];
  evidence_refs: string[];
}

/** Repository-local persistence facade. It never falls back from handoff.md to a sidecar. */
export class HandoffStore {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = resolveWithinRoot(repositoryRoot, ".");
  }

  taskDirectory(taskId: string): string {
    assertTaskId(taskId);
    return resolveWithinRoot(this.repositoryRoot, join(".ai-handoff", taskId));
  }

  statePath(taskId: string): string {
    return resolveWithinRoot(this.repositoryRoot, join(".ai-handoff", taskId, "state.json"));
  }

  eventLog(taskId: string): EventLog {
    return new EventLog(this.taskDirectory(taskId));
  }

  writeState(ledger: TaskLedger): string {
    const path = this.statePath(ledger.taskId);
    mkdirSync(this.taskDirectory(ledger.taskId), { recursive: true });
    return atomicWriteJson(this.repositoryRoot, join(".ai-handoff", ledger.taskId, "state.json"), redactRecord(ledger));
  }

  readState(taskId: string): TaskLedger {
    return readJson<TaskLedger>(this.repositoryRoot, join(".ai-handoff", taskId, "state.json"));
  }

  /**
   * Every task that has a persisted ledger, derived from the on-disk
   * `.ai-handoff/<taskId>/state.json` layout.  This is the recovery source for
   * a restarted process: the coordinator's in-memory registry is rebuilt from
   * these ledgers instead of starting empty.  A directory without a readable
   * state file is skipped, never synthesised.
   */
  listTaskIds(): string[] {
    const root = resolveWithinRoot(this.repositoryRoot, ".ai-handoff");
    if (!existsSync(root)) return [];
    const taskIds: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        assertTaskId(entry.name);
      } catch {
        // A directory that cannot be a task id is not a task; skip it instead
        // of failing the whole recovery.
        continue;
      }
      const statePath = join(root, entry.name, "state.json");
      try {
        if (!statSync(statePath).isFile()) continue;
      } catch {
        continue;
      }
      taskIds.push(entry.name);
    }
    return taskIds.sort();
  }

  writeHandoff(ledger: TaskLedger, sourceSnapshot: HandoffSourceSnapshot): HandoffWriteResult {
    if (ledger.lifecycleState !== "DRAINING" && ledger.lifecycleState !== "HANDOFF_READY") {
      throw new DomainError("INVALID_TRANSITION", "handoff.md can only be written while draining or handoff-ready");
    }
    const sourceReconciliation = validateSourceSnapshot(ledger, sourceSnapshot);
    const handoffWork = sourceSnapshot.remainingWork.map((item) => clone(item));
    const counts = clone(sourceSnapshot.counts);
    const document: HandoffDocument = {
      schema_version: "continuity.handoff.v1",
      task_id: ledger.taskId,
      parent_id: null,
      status: "HANDOFF_READY",
      relay_epoch: ledger.relayEpoch,
      scope_cutoff_at: ledger.scopeCutoffAt,
      source_of_truth: [
        { kind: "source_plan", ref: `.ai-handoff/${ledger.taskId}/evidence/source-plan.json` },
        { kind: "task_ledger", ref: `.ai-handoff/${ledger.taskId}/state.json` }
      ],
      source_hashes: { ...sourceSnapshot.sourceHashes },
      counts,
      remaining_work: handoffWork
    };
    const reconciliation = reconcileWorkSets(sourceSnapshot.remainingWork, document.remaining_work, sourceSnapshot.counts, document.counts);
    if (!reconciliation.ok) throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "handoff.md work set failed reconciliation", { ...reconciliation });
    const text = markdownBlock("Continuity Handoff", document);
    const path = atomicWriteText(this.repositoryRoot, join(".ai-handoff", ledger.taskId, "handoff.md"), text);
    const hash = sha256(text);
    const proof: HandoffReconciliationProof = {
      ...clone(sourceSnapshot),
      remainingWork: clone(document.remaining_work),
      handoffHash: hash
    };
    return { path, hash, document: clone(document), reconciliation: sourceReconciliation, proof };
  }

  readHandoff(taskId: string): HandoffDocument {
    // Deliberately read the Markdown source of truth. A sidecar is never a fallback.
    const target = join(".ai-handoff", taskId, "handoff.md");
    const text = readText(this.repositoryRoot, target);
    return validateDocument(extractMarkdownDocument(text, "Continuity Handoff"));
  }

  reconcileHandoff(ledger: TaskLedger, sourceSnapshot: HandoffSourceSnapshot): WorkSetReconciliation {
    const sourceReconciliation = validateSourceSnapshot(ledger, sourceSnapshot);
    const document = this.readHandoff(ledger.taskId);
    if (document.task_id !== ledger.taskId || document.relay_epoch !== ledger.relayEpoch) {
      throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Handoff identity does not match ledger");
    }
    const reconciliation = reconcileWorkSets(sourceSnapshot.remainingWork, document.remaining_work, sourceSnapshot.counts, document.counts);
    const sourceHashesMatch = canonicalize(sourceSnapshot.sourceHashes) === canonicalize(document.source_hashes) && sourceReconciliation.sourceHashesMatch !== false;
    reconciliation.sourceHashesMatch = sourceHashesMatch;
    if (!sourceHashesMatch) {
      reconciliation.ok = false;
      reconciliation.errors.push("source_hashes_mismatch");
    }
    return reconciliation;
  }

  writeHandoffSidecar(taskId: string, document: HandoffDocument): string {
    // Optional acceleration artifact; readHandoff intentionally ignores it.
    return atomicWriteJson(this.repositoryRoot, join(".ai-handoff", taskId, "handoff.sidecar.json"), redactRecord(document));
  }

  writeReturn(ledger: TaskLedger, terminalReason: TerminalReason, evidenceRefs: string[] = []): { path: string; hash: string; document: ReturnDocument } {
    if (ledger.lifecycleState !== "WEB_TERMINAL" && ledger.lifecycleState !== "RETURN_READY") {
      throw new DomainError("INVALID_TRANSITION", "return.md requires a web terminal or return-ready ledger");
    }
    if (ledger.web.terminalReason !== terminalReason) throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "Return reason does not match ledger terminal reason");
    const work = activeWork(ledger.remainingWork);
    const document: ReturnDocument = {
      schema_version: "continuity.return.v1",
      task_id: ledger.taskId,
      relay_epoch: ledger.relayEpoch,
      terminal_reason: terminalReason,
      last_web_cursor: ledger.web.cursor,
      last_checkpoint: ledger.checkpointRef,
      quota_snapshot: clone(ledger.quotaGate),
      counts: countsFor(work),
      remaining_work: work,
      evidence_refs: [...evidenceRefs]
    };
    const text = markdownBlock("Continuity Return", document);
    const path = atomicWriteText(this.repositoryRoot, join(".ai-handoff", ledger.taskId, "return.md"), text);
    return { path, hash: sha256(text), document };
  }

  hasHandoff(taskId: string): boolean {
    return existsSync(resolveWithinRoot(this.repositoryRoot, join(".ai-handoff", taskId, "handoff.md")));
  }
}
