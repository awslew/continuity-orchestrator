/**
 * codex-chatgpt-web fallback — plan §9.3.3 (owner-w5).
 *
 * The fallback is an explicit, opt-in surface (`CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK`).
 * It is never selected automatically, never runs beside the primary App as a
 * second mounted server, and never changes the state machine or the safety
 * gates.  On fallback failure the affected flags are closed and the ledger is
 * frozen in place: HANDOFF_READY or WEB_UNATTENDED_EXECUTING/BLOCKED_WAITING —
 * no manual execution, no terminal, no re-attach, no permission change.
 */

import { fail } from "../domain/errors.js";
import type { FeatureFlags, FlagName } from "../flags.js";

export const CODEX_CHATGPT_WEB_FALLBACK_FLAG: FlagName = "CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK";

export type FallbackSelection =
  | { selected: false; reason: "flag_off" }
  | { selected: true; surface: "codex-chatgpt-web"; reason: "explicit_flag" };

/** Explicit selection only: the flag must be true; nothing auto-selects. */
export function selectCodexChatgptWebFallback(flags: FeatureFlags): FallbackSelection {
  return flags[CODEX_CHATGPT_WEB_FALLBACK_FLAG]
    ? { selected: true, surface: "codex-chatgpt-web", reason: "explicit_flag" }
    : { selected: false, reason: "flag_off" };
}

export function assertFallbackAllowed(flags: FeatureFlags): void {
  if (!flags[CODEX_CHATGPT_WEB_FALLBACK_FLAG]) {
    fail("RED_FLAGGED_INPUT", "codex-chatgpt-web fallback requires the explicit CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK flag");
  }
}

export interface FallbackFreezePlan {
  /** Flags closed after a fallback failure (applied by the protected config owner). */
  closeFlags: FlagName[];
  /** Ledger states the freeze preserves — none of them terminal. */
  freezeStates: readonly string[];
  terminal: false;
  reattach: false;
  permissionChange: false;
  manualExecution: false;
}

export const FALLBACK_FREEZE_PLAN: FallbackFreezePlan = {
  closeFlags: [CODEX_CHATGPT_WEB_FALLBACK_FLAG],
  freezeStates: ["HANDOFF_READY", "WEB_UNATTENDED_EXECUTING", "BLOCKED_WAITING"],
  terminal: false,
  reattach: false,
  permissionChange: false,
  manualExecution: false
};

/**
 * Failure path: refuse any further fallback use and hand back the freeze
 * plan.  The caller persists the flag closure (protected config) and leaves
 * the ledger in its current non-terminal state; web quota recovery and
 * fallback retries never resume execution on their own.
 */
export function closeFallbackAfterFailure(flags: FeatureFlags): FallbackFreezePlan {
  assertFallbackAllowed(flags);
  return FALLBACK_FREEZE_PLAN;
}
