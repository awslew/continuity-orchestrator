/**
 * Return readiness — plan §9.3.4 (owner-w5).
 *
 * A pure decision function for the return gate: RETURN_READY may only be
 * approached when the web side entered WEB_TERMINAL through one of the three
 * closed reasons, the return checkpoint / remaining ledger is complete, and
 * the CODEX quota satisfies the primary ≥ 20% and secondary gates (the same
 * thresholds evaluateQuotaGate enforces).  Quota recovery on the web side can
 * never reverse a web terminal — a WEB_QUOTA_EXHAUSTED terminal is absorbing
 * for the relay epoch; the return gate below reads only the Codex quota.
 *
 * This module decides; `continuity_prepare_return` (Wave 4) persists.  It is
 * deliberately pure so the gate is testable without touching the MCP server.
 */

import { TERMINAL_REASONS, type TerminalReason } from "../domain/types.js";
import type { TaskLedger } from "../domain/types.js";

export interface ReturnQuotaSnapshot {
  /** evaluateQuotaGate verdict on the CODEX quota (primary ≥ 20% + secondary gate). */
  returnReady: boolean;
  primaryRemainingBps: number | null;
  secondaryGuard: boolean;
  sampleFresh: boolean;
}

export interface ReturnReadiness {
  ready: boolean;
  blockers: string[];
}

function isClosedTerminalReason(reason: string | null): reason is TerminalReason {
  return reason !== null && (TERMINAL_REASONS as readonly string[]).includes(reason);
}

export function assessReturnReadiness(
  ledger: TaskLedger,
  quota: ReturnQuotaSnapshot | null
): ReturnReadiness {
  const blockers: string[] = [];

  if (ledger.lifecycleState !== "WEB_TERMINAL") {
    blockers.push(`lifecycle is ${ledger.lifecycleState}, not WEB_TERMINAL`);
  } else if (!isClosedTerminalReason(ledger.web.terminalReason)) {
    blockers.push(`terminal reason ${String(ledger.web.terminalReason)} is not one of the three closed reasons`);
  }

  if (!ledger.checkpointRef) blockers.push("no return checkpoint reference on the ledger");
  if (ledger.returnHash) blockers.push("return was already written for this ledger");

  if (ledger.counts.remaining > ledger.counts.total) {
    blockers.push("remaining work count exceeds total (ledger inconsistent)");
  }
  if (ledger.lifecycleState === "WEB_TERMINAL" && ledger.web.terminalReason === "ALL_TASKS_COMPLETED" && ledger.counts.remaining > 0) {
    blockers.push("ALL_TASKS_COMPLETED terminal still has remaining work");
  }
  if (ledger.web.executionSubstate === "BLOCKED_WAITING") {
    blockers.push("web execution is parked in BLOCKED_WAITING; resolve or wait before return");
  }

  if (!quota) {
    blockers.push("no fresh codex quota sample; the return gate stays closed");
  } else {
    if (!quota.sampleFresh) blockers.push("codex quota sample is stale");
    if (!quota.returnReady) {
      blockers.push(
        quota.primaryRemainingBps !== null && quota.primaryRemainingBps < 2_000
          ? `codex primary quota below the 20% return threshold (${quota.primaryRemainingBps} bps)`
          : "codex quota return gate (primary/secondary/hysteresis) not ready"
      );
    }
    if (quota.secondaryGuard) blockers.push("codex secondary guard active");
  }

  return { ready: blockers.length === 0, blockers };
}
