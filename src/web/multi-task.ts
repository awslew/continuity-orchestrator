/**
 * MultiTaskRegistry — plan §9.3.2 (owner-w5).
 *
 * NOT MOUNTED (2026-09-23).  This module has no production caller, deliberately:
 * the registry is process memory only, so a task rehydrated after a restart
 * (`TaskCoordinator.hydrate`) would be an unknown task here and a task registered
 * here would not survive the restart; `withProjectLock` is likewise not
 * persistent across processes.  Task isolation is currently carried by the
 * durable ledger plus the allowlist, which both survive a restart.  See
 * docs/plus-mode-2026-09-23.md §4.9.
 *
 * Minimal isolation unit: `task_id / project_id / web_chat_id`.  Every task
 * owns exactly one web chat; a chat can never be owned by two tasks; live
 * chat references are re-verified against the registry so task A can never
 * read or write task B's chat or ledger.  Project write locks serialize
 * mutations inside one project (same repository, different tasks included)
 * without ever merging the tasks' chats or ledgers.
 */

import { fail } from "../domain/errors.js";

export interface TaskIsolation {
  taskId: string;
  projectId: string;
  /** The single web chat this task owns (never shared). */
  webChatId: string;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

export class MultiTaskRegistry {
  private readonly byTask = new Map<string, TaskIsolation>();
  private readonly chatOwners = new Map<string, string>();
  private readonly projectLocks = new Map<string, AsyncMutex>();

  /** Register (or re-assert) a task's isolation triple. */
  registerTask(isolation: TaskIsolation): void {
    if (!isolation.taskId || !isolation.projectId || !isolation.webChatId) {
      fail("INVALID_WORK_ITEM", "isolation requires taskId, projectId and webChatId");
    }
    const existing = this.byTask.get(isolation.taskId);
    if (existing && existing.webChatId !== isolation.webChatId) {
      fail("INVALID_TRANSITION", `task ${isolation.taskId} cannot silently switch chats (${existing.webChatId} -> ${isolation.webChatId})`);
    }
    const owner = this.chatOwners.get(isolation.webChatId);
    if (owner && owner !== isolation.taskId) {
      fail("DUPLICATE_TASK", `web chat ${isolation.webChatId} is already owned by task ${owner}; chats are never shared`);
    }
    this.byTask.set(isolation.taskId, { ...isolation });
    this.chatOwners.set(isolation.webChatId, isolation.taskId);
  }

  /** Verify a live chat reference belongs to this task (cross-task reads fail). */
  assertIsolation(taskId: string, webChatId: string): TaskIsolation {
    const isolation = this.byTask.get(taskId);
    if (!isolation) fail("RED_FLAGGED_INPUT", `task ${taskId} is not registered for multi-task isolation`);
    if (isolation.webChatId !== webChatId) {
      fail("RED_FLAGGED_INPUT", `task ${taskId} referenced chat ${webChatId} but owns ${isolation.webChatId}`);
    }
    return isolation;
  }

  isolationOf(taskId: string): TaskIsolation | null {
    const isolation = this.byTask.get(taskId);
    return isolation ? { ...isolation } : null;
  }

  /** Serialize a mutation inside one project (same repository included). */
  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    if (!projectId) fail("RED_FLAGGED_INPUT", "project lock requires a projectId");
    let lock = this.projectLocks.get(projectId);
    if (!lock) {
      lock = new AsyncMutex();
      this.projectLocks.set(projectId, lock);
    }
    return lock.run(fn);
  }

  releaseTask(taskId: string): void {
    const isolation = this.byTask.get(taskId);
    if (!isolation) return;
    if (this.chatOwners.get(isolation.webChatId) === taskId) this.chatOwners.delete(isolation.webChatId);
    this.byTask.delete(taskId);
  }
}
