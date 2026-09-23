/**
 * TaskCoordinator — per-task `.ai-handoff/<taskId>/` orchestration (plan §8.3.5).
 *
 * One task owns one directory, one ledger, one event log and one web chat.
 * The coordinator is the single writer of task ledgers and keeps the
 * allowlist registry in sync with the ledgers it manages.
 */

import { DomainError } from "../domain/errors.js";
import {
  createInitialLedger,
  transitionLedger,
  updateLedger,
  type AdvanceGuards,
  type CreateLedgerInput
} from "../domain/state-machine.js";
import type { TransitionOptions } from "../domain/types.js";
import type { TaskLedger } from "../domain/types.js";
import { sha256 } from "../domain/canonical.js";
import { HandoffStore } from "../persistence/handoff-store.js";
import { EventLog } from "../persistence/event-log.js";
import type { Allowlist } from "../security/allowlist.js";
import type { EvidenceWriter } from "../evidence/evidence-writer.js";

export interface RegisterTaskOptions {
  ledger: CreateLedgerInput;
  /** Registered workspace the task operates on. */
  workspaceId: string;
  actor?: string;
}

export interface TaskSummary {
  taskId: string;
  projectId: string;
  repositoryId: string;
  workspaceId: string;
  lifecycleState: TaskLedger["lifecycleState"];
  revision: number;
  webChatId: string | null;
  executionSubstate: TaskLedger["web"]["executionSubstate"];
  terminalReason: TaskLedger["web"]["terminalReason"];
  counts: TaskLedger["counts"];
}

export class TaskCoordinator {
  private readonly ledgers = new Map<string, TaskLedger>();
  private readonly workspaces = new Map<string, string>();

  constructor(
    private readonly store: HandoffStore,
    private readonly allowlist: Allowlist,
    private readonly evidence: EvidenceWriter
  ) {}

  /** Register a task with a complete initial ledger and persist it. */
  registerTask(options: RegisterTaskOptions, at = new Date().toISOString()): TaskLedger {
    const created = createInitialLedger(options.ledger);
    if (this.ledgers.has(created.taskId)) {
      throw new DomainError("DUPLICATE_TASK", `Task ${created.taskId} is already registered`);
    }
    // Registration itself is a mutation: the persisted ledger starts at revision 1.
    const ledger = updateLedger(created, { expectedRevision: created.revision, at }, () => {});
    this.allowlist.registerTaskId(ledger.taskId);
    this.ledgers.set(ledger.taskId, ledger);
    this.workspaces.set(ledger.taskId, options.workspaceId);
    this.store.writeState(ledger);
    this.evidence.write(ledger.taskId, `evt-register-${ledger.revision}`, {
      operation: "task_register",
      actor: options.actor ?? "coordinator",
      workspaceId: options.workspaceId,
      taskId: ledger.taskId,
      relayEpoch: ledger.relayEpoch
    }, at);
    this.eventLog(ledger.taskId).append({
      task_id: ledger.taskId,
      operation: "task_register",
      actor: options.actor ?? "coordinator",
      at,
      result: "completed",
      from_state: null,
      to_state: ledger.lifecycleState
    });
    return this.get(ledger.taskId);
  }

  workspaceIdOf(taskId: string): string {
    const workspaceId = this.workspaces.get(taskId);
    if (!workspaceId) throw new DomainError("RED_FLAGGED_INPUT", `task ${taskId} has no registered workspace`);
    return workspaceId;
  }

  /**
   * Rebuild the in-memory registry from the persisted ledgers.  A restart used
   * to leave the app with zero tasks: every tool then failed
   * `RED_FLAGGED_INPUT: task X is not registered` even though the ledger, the
   * handoff and the event log were all still on disk.
   *
   * Recovery is read-only and fail-closed: a task whose state file is
   * unreadable, belongs to another schema version or fails the identifier
   * rules is reported in `skipped` instead of being invented, and it is never
   * silently repaired.  The per-task workspace mapping is not part of the
   * ledger, so restored tasks are attributed to `workspaceId` (the single
   * workspace this app registers).
   */
  hydrate(options: { workspaceId?: string; taskIds?: readonly string[] } = {}): { restored: string[]; skipped: Array<{ taskId: string; reason: string }> } {
    const workspaceId = options.workspaceId ?? "default";
    const restored: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    const candidates = options.taskIds ?? this.store.listTaskIds();
    for (const taskId of candidates) {
      if (this.ledgers.has(taskId)) continue;
      let ledger: TaskLedger;
      try {
        ledger = this.store.readState(taskId);
      } catch (error) {
        skipped.push({ taskId, reason: error instanceof Error ? error.message : "state file is unreadable" });
        continue;
      }
      if (!ledger || typeof ledger !== "object" || ledger.schemaVersion !== "continuity.v1" || ledger.taskId !== taskId) {
        skipped.push({ taskId, reason: "state file is not a continuity.v1 ledger for this task id" });
        continue;
      }
      if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 1) {
        skipped.push({ taskId, reason: "persisted ledger has an invalid revision" });
        continue;
      }
      this.allowlist.registerTaskId(ledger.taskId);
      this.ledgers.set(ledger.taskId, ledger);
      this.workspaces.set(ledger.taskId, workspaceId);
      restored.push(ledger.taskId);
    }
    return { restored, skipped };
  }

  has(taskId: string): boolean {
    return this.ledgers.has(taskId);
  }

  /** Current in-memory ledger; fails closed for unknown tasks. */
  get(taskId: string): TaskLedger {
    const ledger = this.ledgers.get(taskId);
    if (!ledger) throw new DomainError("RED_FLAGGED_INPUT", `task ${taskId} is not registered`);
    return ledger;
  }

  /** Persist the ledger and keep the in-memory copy in sync. */
  save(next: TaskLedger, operation: string, actor = "coordinator", at = new Date().toISOString(), extra: Record<string, unknown> = {}): TaskLedger {
    const current = this.ledgers.get(next.taskId);
    if (!current) throw new DomainError("RED_FLAGGED_INPUT", `task ${next.taskId} is not registered`);
    if (next.revision <= current.revision) {
      throw new DomainError("REVISION_CONFLICT", ` refusing to persist revision ${next.revision} over ${current.revision}`);
    }
    this.ledgers.set(next.taskId, next);
    this.store.writeState(next);
    this.evidence.write(next.taskId, `evt-${operation}-${next.revision}`, {
      operation,
      actor,
      taskId: next.taskId,
      revision: next.revision,
      lifecycleState: next.lifecycleState,
      ...extra
    }, at);
    return next;
  }

  /** Apply one lifecycle transition with revision control and persistence. */
  transition(taskId: string, to: TaskLedger["lifecycleState"], options: TransitionOptions & AdvanceGuards, actor = "coordinator"): TaskLedger {
    const current = this.get(taskId);
    const next = transitionLedger(current, to, options);
    return this.save(next, `transition_${to.toLowerCase()}`, actor, options.at, { from_state: current.lifecycleState, to_state: to });
  }

  checkpoint(taskId: string, checkpointRef: string, expectedRevision: number, actor = "web", at = new Date().toISOString()): TaskLedger {
    const current = this.get(taskId);
    const next = updateLedger(current, { expectedRevision, at }, (draft) => {
      draft.checkpointRef = checkpointRef;
    });
    return this.save(next, "checkpoint", actor, at, { checkpointRef });
  }

  setExecutionSubstate(taskId: string, substate: TaskLedger["web"]["executionSubstate"], expectedRevision: number, at = new Date().toISOString()): TaskLedger {
    const current = this.get(taskId);
    const next = updateLedger(current, { expectedRevision, at }, (draft) => {
      draft.web.executionSubstate = substate;
    });
    return this.save(next, "execution_substate", "coordinator", at, { executionSubstate: substate });
  }

  listTasks(filter: { projectId?: string | undefined; state?: TaskLedger["lifecycleState"] | undefined } = {}): TaskSummary[] {
    const summaries: TaskSummary[] = [];
    for (const ledger of this.ledgers.values()) {
      if (filter.projectId && ledger.projectId !== filter.projectId) continue;
      if (filter.state && ledger.lifecycleState !== filter.state) continue;
      summaries.push({
        taskId: ledger.taskId,
        projectId: ledger.projectId,
        repositoryId: ledger.repositoryId,
        workspaceId: this.workspaces.get(ledger.taskId) ?? "",
        lifecycleState: ledger.lifecycleState,
        revision: ledger.revision,
        webChatId: ledger.web.chatId,
        executionSubstate: ledger.web.executionSubstate,
        terminalReason: ledger.web.terminalReason,
        counts: ledger.counts
      });
    }
    return summaries.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  eventLog(taskId: string): EventLog {
    return this.store.eventLog(taskId);
  }

  /** Stable fingerprint of the current ledger, used in receipts. */
  ledgerFingerprint(taskId: string): string {
    return sha256(this.get(taskId));
  }
}
