import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { clone } from "../domain/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { LifecycleState, TaskLedger } from "../domain/types.js";
import { atomicWriteJson, readJson, resolveWithinRoot } from "./atomic-json.js";
import { redactRecord } from "./redaction.js";
import { EventLog } from "./event-log.js";

export interface IndexEntry {
  task_id: string;
  project_id: string;
  repository_id: string;
  state: LifecycleState;
  revision: number;
  web_chat_id: string | null;
  codex_thread_id: string | null;
  last_event: number;
}

export interface IndexDocument {
  schema_version: "continuity.index.v1";
  generated_at: string;
  entries: IndexEntry[];
}

export class IndexCache {
  readonly rootDir: string;
  readonly target: string;

  constructor(rootDir: string, target = "index-cache.json") {
    this.rootDir = resolveWithinRoot(rootDir, ".");
    this.target = target;
  }

  load(): IndexDocument {
    if (!existsSync(resolveWithinRoot(this.rootDir, this.target))) return { schema_version: "continuity.index.v1", generated_at: new Date(0).toISOString(), entries: [] };
    const value = readJson<IndexDocument>(this.rootDir, this.target);
    if (value.schema_version !== "continuity.index.v1" || !Array.isArray(value.entries)) throw new DomainError("MALFORMED_HANDOFF", "Malformed index cache");
    return clone(value);
  }

  save(document: IndexDocument): string {
    const sanitized = redactRecord({ ...document, schema_version: "continuity.index.v1" as const });
    return atomicWriteJson(this.rootDir, this.target, sanitized);
  }

  upsert(entry: IndexEntry): IndexDocument {
    const document = this.load();
    const index = document.entries.findIndex((candidate) => candidate.task_id === entry.task_id);
    if (index >= 0) document.entries[index] = clone(entry);
    else document.entries.push(clone(entry));
    document.entries.sort((a, b) => a.task_id.localeCompare(b.task_id));
    document.generated_at = new Date().toISOString();
    this.save(document);
    return clone(document);
  }

  remove(taskId: string): IndexDocument {
    const document = this.load();
    document.entries = document.entries.filter((entry) => entry.task_id !== taskId);
    document.generated_at = new Date().toISOString();
    this.save(document);
    return clone(document);
  }

  /** Rebuilds from repository-local state.json files. The cache is never treated as the source of truth. */
  rebuild(): IndexDocument {
    const handoffRoot = resolveWithinRoot(this.rootDir, ".ai-handoff");
    const entries: IndexEntry[] = [];
    if (existsSync(handoffRoot)) {
      for (const taskId of readdirSync(handoffRoot)) {
        const taskDir = join(handoffRoot, taskId);
        if (!statSync(taskDir).isDirectory()) continue;
        const stateTarget = join(".ai-handoff", taskId, "state.json");
        if (!existsSync(resolveWithinRoot(this.rootDir, stateTarget))) continue;
        const ledger = readJson<TaskLedger>(this.rootDir, stateTarget);
        entries.push(this.entryFromLedger(ledger, taskDir));
      }
    }
    entries.sort((a, b) => a.task_id.localeCompare(b.task_id));
    const document: IndexDocument = { schema_version: "continuity.index.v1", generated_at: new Date().toISOString(), entries };
    this.save(document);
    return clone(document);
  }

  rebuildFromTaskDirectories(taskDirectories: readonly string[]): IndexDocument {
    const entries: IndexEntry[] = [];
    for (const directory of taskDirectories) {
      const statePath = resolveWithinRoot(this.rootDir, join(directory, "state.json"));
      if (!existsSync(statePath)) continue;
      const ledger = readJson<TaskLedger>(this.rootDir, join(directory, "state.json"));
      entries.push(this.entryFromLedger(ledger, resolveWithinRoot(this.rootDir, directory)));
    }
    entries.sort((a, b) => a.task_id.localeCompare(b.task_id));
    const document: IndexDocument = { schema_version: "continuity.index.v1", generated_at: new Date().toISOString(), entries };
    this.save(document);
    return clone(document);
  }

  private entryFromLedger(ledger: TaskLedger, taskDir: string): IndexEntry {
    const eventPath = relative(this.rootDir, taskDir);
    const eventCount = new EventLog(taskDir).read().length;
    return {
      task_id: ledger.taskId,
      project_id: ledger.projectId,
      repository_id: ledger.repositoryId,
      state: ledger.lifecycleState,
      revision: ledger.revision,
      web_chat_id: ledger.web.chatId,
      codex_thread_id: ledger.codex.threadId,
      last_event: eventCount
    };
  }
}
