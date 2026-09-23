/**
 * AutoWakeup — plan §9.3.1 (owner-w5).
 *
 * NOT MOUNTED (2026-09-23).  This module has no production caller, deliberately:
 *   - nothing in this process can drive it — the App is a stdio MCP server and
 *     `src/` contains no timer/scheduler host, so the "loop" has no clock;
 *   - its payload shape is rejected by the real transport: `buildPrompt`
 *     (adapters/webgpt-drive-http.ts) takes the `{message}`/`{bootstrap}`
 *     shapes produced by the web session handler, not a wakeup envelope;
 *   - the `instruction_ref` reference kind it carries is unreachable through the
 *     MCP boundary (`src/mcp/schemas.ts` allows only evidence_ref /
 *     checkpoint_ref / handoff_item).
 * See docs/plus-mode-2026-09-23.md §4.9.  Mounting it requires a scheduler host
 * and a transport payload contract, not just a wiring change.
 *
 * Sends pre-generated structured wakeups to the web chat while the task is in
 * unattended execution.  Design constraints (ADR-0003, plan §9.1/§9.2):
 *   - the wakeup idempotency key is DERIVED from the local ledger cursor, so
 *     re-preparing the same wakeup yields the same key and the adapter
 *     replays the original receipt — a duplicate message is impossible;
 *   - retries back off between attempts, but any send whose page state is
 *     unknown/loading/error or whose quota observation is not "none" stops
 *     the loop in BLOCKED_WAITING — an uncertain page never produces another
 *     dispatch, and nothing here ever reaches a terminal;
 *   - the real transport stays fail-closed behind the Wave 4 contract; the
 *     feature additionally requires CONTINUITY_WEB_AUTOWAKE_ENABLED, which
 *     defaults off and is never settable from the web.
 */

import type { AdapterResult, StructuredAdapterError } from "../adapters/adapter-types.js";
import type { WebMessageReceipt, WebgptDriveAdapter } from "../adapters/webgpt-drive.js";
import type { TaskLedger } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import type { StructuredInstructionRef } from "../workflow/supervision.js";

export interface WakeupMessage {
  kind: "wakeup";
  taskId: string;
  relayEpoch: string;
  /** Authoritative local cursor (ADR-0004 R-6); the web side never produces one. */
  cursor: { eventSeq: number; stateRevision: number };
  instructionRef: StructuredInstructionRef;
}

export interface AutoWakeupOptions {
  enabled: boolean;
  maxAttempts?: number;
  baseBackoffMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type WakeupSendResult =
  | { outcome: "sent"; receipt: WebMessageReceipt; attempts: number }
  | { outcome: "replay"; receipt: WebMessageReceipt; attempts: 0 }
  | { outcome: "blocked"; error: StructuredAdapterError | null; attempts: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function wakeupKey(ledger: Pick<TaskLedger, "taskId" | "relayEpoch" | "revision">, eventSeq: number): string {
  // Deterministic per (task, ledger revision, local cursor seq): re-preparing
  // the same wakeup can never mint a second key.
  return `wakeup_${ledger.taskId}_${ledger.relayEpoch}_r${ledger.revision}_e${eventSeq}`;
}

export function buildWakeupMessage(
  ledger: TaskLedger,
  instructionRef: StructuredInstructionRef,
  eventSeq: number
): { key: string; message: WakeupMessage } {
  if (!instructionRef || instructionRef.kind !== "instruction_ref" || !instructionRef.ref) {
    throw new DomainError("RED_FLAGGED_INPUT", "wakeup requires a structured instruction_ref; raw text is never sent");
  }
  return {
    key: wakeupKey(ledger, eventSeq),
    message: {
      kind: "wakeup",
      taskId: ledger.taskId,
      relayEpoch: ledger.relayEpoch,
      cursor: { eventSeq, stateRevision: ledger.revision },
      instructionRef
    }
  };
}

export class AutoWakeup {
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly webgpt: WebgptDriveAdapter,
    private readonly options: AutoWakeupOptions
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffMs = Math.max(0, options.baseBackoffMs ?? 2_000);
    this.clock = options.clock ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Send one wakeup with retry/backoff.  A `replay` outcome returns the
   * original receipt for the derived key without touching the transport.
   * Any blocked page state or non-clean quota observation aborts further
   * attempts and reports `blocked` — the caller parks BLOCKED_WAITING.
   */
  async send(chatId: string, key: string, message: WakeupMessage): Promise<WakeupSendResult> {
    if (!this.options.enabled) {
      throw new DomainError("RED_FLAGGED_INPUT", "auto wakeup is disabled (CONTINUITY_WEB_AUTOWAKE_ENABLED is off)");
    }
    if (!chatId) throw new DomainError("INVALID_TRANSITION", "auto wakeup requires an attached web chat");
    if (message.kind !== "wakeup" || message.taskId === "" || message.relayEpoch === "") {
      throw new DomainError("RED_FLAGGED_INPUT", "auto wakeup requires a pre-generated structured wakeup message");
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const result: AdapterResult<WebMessageReceipt> = await this.webgpt.send(chatId, key, message as unknown as Record<string, unknown>);
      if (result.ok && result.value) {
        if (result.value.blockedWaiting) {
          // Dispatched but the page/quota state is not clean: stop, wait for
          // reconcile — never fire another message into an uncertain page.
          return { outcome: "blocked", error: null, attempts: attempt };
        }
        return { outcome: "sent", receipt: result.value, attempts: attempt };
      }
      const refusedBeforeDispatch =
        result.error?.code === "WEB_CHAT_ID_MISMATCH" || result.error?.code === "WEB_CHAT_ID_UNVERIFIED";
      if (refusedBeforeDispatch || attempt === this.maxAttempts) {
        return { outcome: "blocked", error: result.error, attempts: attempt };
      }
      await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
    }
    return { outcome: "blocked", error: null, attempts: this.maxAttempts };
  }
}
