/**
 * Audit receipt events for read-only registry tool calls.
 *
 * Every `continuity_codex_tasks_list` call carries an unpredictable
 * `receipt_id` (contract 1) that threads through a minimal set of structured
 * single-line JSON events on stderr (contract 2).  This module is the only
 * place events are serialized; the schema is fixed so a log consumer can
 * always parse one JSON object per line.
 *
 * Redaction is structural, not best-effort: each event declares exactly the
 * safe fields the contract allows (receipt id, page counts, cursor hashes,
 * status flags), and no event shape can ever carry a raw cursor, thread
 * title, path, prompt/summary text or command environment.  Events never
 * touch stdout (the MCP framing channel).
 */

import { createHash } from "node:crypto";

export const TASKS_LIST_SCHEMA_VERSION = "continuity.tasks-list.v1" as const;

export interface TasksListAuditEventBase {
  schema_version: typeof TASKS_LIST_SCHEMA_VERSION;
  event: string;
  timestamp: string;
  receipt_id: string;
}

export interface TasksListToolCallReceivedEvent extends TasksListAuditEventBase {
  event: "continuity_tool_call_received";
  tool: "continuity_codex_tasks_list";
  page_limit: number | null;
  limit: number | null;
}

export interface TasksListChildStartedEvent extends TasksListAuditEventBase {
  event: "codex_app_server_child_started";
  reused: boolean;
  child_instance_id: string;
}

export interface TasksListInitializedEvent extends TasksListAuditEventBase {
  event: "codex_app_server_initialized";
  initialized: true;
}

export interface TasksListRpcPageEvent extends TasksListAuditEventBase {
  event: "codex_app_server_rpc_page";
  method: "thread/list";
  page_index: number;
  cursor_in_present: boolean;
  cursor_in_sha256: string | null;
  cursor_out_present: boolean;
  cursor_out_sha256: string | null;
  item_count: number;
}

export interface TasksListCompletedEvent extends TasksListAuditEventBase {
  event: "continuity_tool_call_completed";
  method: "thread/list";
  page_count: number;
  unique_count: number;
  complete: boolean;
  duration_ms: number;
}

export interface TasksListFailedEvent extends TasksListAuditEventBase {
  event: "continuity_tool_call_failed";
  /** Safe error identity: a stable code plus the stage, never a stack/exception text. */
  code: string;
  stage: string;
}

export type TasksListAuditEvent =
  | TasksListToolCallReceivedEvent
  | TasksListChildStartedEvent
  | TasksListInitializedEvent
  | TasksListRpcPageEvent
  | TasksListCompletedEvent
  | TasksListFailedEvent;

/** Anything that accepts one serialized JSON line (typically process.stderr). */
export type TasksListReceiptSink = (line: string) => void;

export interface TasksListReceiptEmitterOptions {
  /** Replaces process.stderr in tests; write failures there are swallowed. */
  sink?: TasksListReceiptSink | null;
  /** Injectable clock for deterministic event timestamps. */
  now?: () => Date;
}

/**
 * One-shot structured stderr emitter for a single tool call.  Receipt events
 * are best-effort telemetry: a failing sink must never break the tool call,
 * so every write is wrapped and swallowed.
 */
export class TasksListReceiptEmitter {
  private readonly sink: TasksListReceiptSink;
  private readonly now: () => Date;
  /** Monotonic milliseconds at construction; duration_ms derives from it. */
  private readonly startedAt: number;
  /** Shared fields except the `event` discriminator, which every emission supplies. */
  private readonly base: Omit<TasksListAuditEventBase, "event">;

  constructor(receiptId: string, options: TasksListReceiptEmitterOptions = {}) {
    if (receiptId.length === 0) throw new Error("TasksListReceiptEmitter requires a non-empty receipt_id");
    const defaultSink = options.sink ?? null;
    this.sink = defaultSink ?? ((line) => { process.stderr.write(`${line}\n`); });
    this.now = options.now ?? (() => new Date());
    this.startedAt = Date.now();
    this.base = { schema_version: TASKS_LIST_SCHEMA_VERSION, timestamp: this.now().toISOString(), receipt_id: receiptId };
  }

  private emit(event: TasksListAuditEvent): void {
    let line: string;
    try {
      line = JSON.stringify(event);
    } catch {
      return; // an unserializable event is dropped, never thrown
    }
    if (typeof line !== "string") return;
    try {
      this.sink(line);
    } catch {
      // stderr failures never break the tool call that produced the receipt.
    }
  }

  toolCallReceived(pageLimit: number | null, limit: number | null): void {
    this.emit({ ...this.base, event: "continuity_tool_call_received", tool: "continuity_codex_tasks_list", page_limit: pageLimit, limit });
  }

  childStarted(reused: boolean, childInstanceId: string): void {
    this.emit({ ...this.base, event: "codex_app_server_child_started", reused, child_instance_id: childInstanceId });
  }

  initialized(): void {
    this.emit({ ...this.base, event: "codex_app_server_initialized", initialized: true });
  }

  rpcPage(page: { index: number; inputCursor: string | null; outputCursor: string | null; itemCount: number }): void {
    const digest = (value: string | null): { present: boolean; sha256: string | null } =>
      value === null ? { present: false, sha256: null } : { present: true, sha256: cursorSha256(value) };
    const input = digest(page.inputCursor);
    const output = digest(page.outputCursor);
    this.emit({
      ...this.base,
      event: "codex_app_server_rpc_page",
      method: "thread/list",
      page_index: page.index,
      cursor_in_present: input.present,
      cursor_in_sha256: input.sha256,
      cursor_out_present: output.present,
      cursor_out_sha256: output.sha256,
      item_count: page.itemCount
    });
  }

  completed(details: { pageCount: number; uniqueCount: number; complete: boolean; durationMs: number }): void {
    this.emit({
      ...this.base,
      event: "continuity_tool_call_completed",
      method: "thread/list",
      page_count: details.pageCount,
      unique_count: details.uniqueCount,
      complete: details.complete,
      duration_ms: details.durationMs
    });
  }

  failed(details: { code: string; stage: string }): void {
    this.emit({ ...this.base, event: "continuity_tool_call_failed", code: details.code, stage: details.stage });
  }

  /** Monotonic elapsed time in ms, computed against the emitter's start. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

/** Non-reversible, task-content-free identity of a cursor value. */
function cursorSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
