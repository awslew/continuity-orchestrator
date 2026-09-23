import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { clone } from "../domain/canonical.js";
import { DomainError } from "../domain/errors.js";
import { atomicWriteText, resolveWithinRoot } from "./atomic-json.js";
import { redactRecord, REDACTION_VERSION } from "./redaction.js";
import { TERMINAL_REASONS, type ContinuityEvent } from "../domain/types.js";

export type EventInput = Partial<ContinuityEvent> & {
  task_id: string;
  operation: string;
};

export class EventLog {
  readonly rootDir: string;
  readonly target: string;

  constructor(rootDir: string, target = "events.jsonl") {
    this.rootDir = rootDir;
    this.target = target;
  }

  path(): string {
    return resolveWithinRoot(this.rootDir, this.target);
  }

  read(): ContinuityEvent[] {
    const path = this.path();
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    if (text.length === 0) return [];
    const events: ContinuityEvent[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ContinuityEvent;
        if (!event || typeof event !== "object") throw new Error("not an object");
        if (!Number.isInteger(event.seq) || event.seq !== events.length + 1) {
          throw new Error(`expected seq ${events.length + 1}, got ${String(event.seq)}`);
        }
        events.push(event);
      } catch (error) {
        throw new DomainError("MALFORMED_HANDOFF", `Malformed event at line ${index + 1}: ${String(error)}`);
      }
    }
    return events;
  }

  append(input: EventInput): ContinuityEvent {
    if (input.terminal_reason !== undefined && !TERMINAL_REASONS.includes(input.terminal_reason)) {
      throw new DomainError("INVALID_TERMINAL_REASON", `Unsupported terminal reason ${String(input.terminal_reason)}`);
    }
    if (input.terminal_reason === "HUMAN_STOP" || input.operation === "human_stop") {
      const candidate = input as Record<string, unknown>;
      if (candidate.intent !== "STOP_RELAY" || typeof candidate.command_or_confirmation_id !== "string" || !candidate.command_or_confirmation_id || typeof candidate.timestamp !== "string" || !candidate.timestamp || typeof candidate.relay_epoch !== "string" || !candidate.relay_epoch || typeof candidate.idempotency_key !== "string" || !candidate.idempotency_key) {
        throw new DomainError("HUMAN_STOP_REQUIRED", "HUMAN_STOP events require explicit STOP_RELAY confirmation fields");
      }
    }
    const previous = this.read();
    const requestedSeq = input.seq;
    const seq = previous.length + 1;
    if (requestedSeq !== undefined && requestedSeq !== seq) {
      throw new DomainError("REVISION_CONFLICT", `Event sequence conflict: expected ${seq}, got ${requestedSeq}`);
    }
    const known = {
      event_id: input.event_id ?? randomUUID(),
      task_id: input.task_id,
      seq,
      at: input.at ?? new Date().toISOString(),
      actor: input.actor ?? "system",
      operation: input.operation,
      from_state: input.from_state ?? null,
      to_state: input.to_state ?? null,
      expected_revision: input.expected_revision ?? null,
      result: input.result ?? "observed",
      external_ids: input.external_ids ?? {},
      evidence_refs: input.evidence_refs ?? [],
      redaction_version: REDACTION_VERSION,
      ...(input.relay_epoch === undefined ? {} : { relay_epoch: input.relay_epoch }),
      ...(input.execution_substate === undefined ? {} : { execution_substate: input.execution_substate }),
      ...(input.terminal_reason === undefined ? {} : { terminal_reason: input.terminal_reason }),
      ...(input.child_task_id === undefined ? {} : { child_task_id: input.child_task_id }),
      ...(input.scope_cutoff_at === undefined ? {} : { scope_cutoff_at: input.scope_cutoff_at }),
      ...(input.source_hashes === undefined ? {} : { source_hashes: input.source_hashes }),
      ...(input.counts === undefined ? {} : { counts: input.counts }),
      ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key })
    } as Record<string, unknown>;
    const reserved = new Set(Object.keys(known));
    for (const [key, value] of Object.entries(input)) {
      if (!reserved.has(key)) known[key] = value;
    }
    const event = redactRecord(known) as ContinuityEvent;
    const serialized = `${JSON.stringify(event)}\n`;
    mkdirSync(dirname(this.path()), { recursive: true });
    appendFileSync(this.path(), serialized, { encoding: "utf8", mode: 0o600 });
    return clone(event);
  }

  /** Replay is reducer-driven so the event log remains append-only and domain-neutral. */
  replay<T>(initial: T, reducer: (state: T, event: ContinuityEvent) => T): T {
    return replayEvents(initial, this.read(), reducer);
  }

  /** Repair is intentionally not offered: events are append-only. */
  assertAppendOnly(): boolean {
    return true;
  }
}

export function replayEvents<T>(initial: T, events: readonly ContinuityEvent[], reducer: (state: T, event: ContinuityEvent) => T): T {
  let state = initial;
  let expected = 1;
  for (const event of events) {
    if (event.seq !== expected) throw new DomainError("MALFORMED_HANDOFF", `Event replay gap at sequence ${expected}`);
    state = reducer(state, clone(event));
    expected += 1;
  }
  return state;
}

/** Write a complete event stream only for test fixtures or first-time migration. */
export function writeEventFixture(rootDir: string, target: string, events: readonly ContinuityEvent[]): string {
  let expected = 1;
  for (const event of events) {
    if (event.seq !== expected) throw new DomainError("MALFORMED_HANDOFF", `Fixture sequence expected ${expected}`);
    expected += 1;
  }
  return atomicWriteText(rootDir, target, events.map((event) => JSON.stringify(redactRecord(event))).join("\n") + (events.length ? "\n" : ""));
}
