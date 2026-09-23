import type { QuotaSnapshot as LegacyQuotaSnapshot } from "./quota-types.js";
import type { TaskLedger } from "../domain/types.js";
import type { NormalizedQuotaSnapshot, NormalizedRateLimitWindow } from "./quota-normalizer.js";

export type QuotaGateStatus = "fresh" | "depleted" | "available" | "unknown" | "conflict";

/** Options deliberately require an observed time; the gate never reads a local clock by itself. */
export interface QuotaGateOptions {
  now?: Date | string;
  freshnessWindowMs?: number;
  previous?: QuotaGateSnapshot | null;
  /** Updated timestamp of the sample that caused the Codex down-going drain. */
  depletedSampleUpdatedAt?: string | null;
  /** Alias used by callers that store the drain fence under a different name. */
  lastDepletedUpdatedAt?: string | null;
}

export type QuotaGateSnapshot = NormalizedQuotaSnapshot | LegacyQuotaSnapshot;

export interface QuotaGateDecision {
  status: QuotaGateStatus;
  codexAvailable: boolean;
  drainRequired: boolean;
  returnReady: boolean;
  secondaryGuard: boolean;
  sampleFresh: boolean;
  reason: string;
  faults: string[];
  sampleId: string | null;
  updatedAt: string | null;
  primaryRemainingBps: number | null;
  secondaryRemainingBps: number | null;
}

export interface QuotaRecoveryObservation extends QuotaGateDecision {
  action: "record_codex_available" | "hold_codex_depleted" | "hold_unknown";
  preemptWeb: false;
  returnOrInterruptIssued: false;
}

type GateWindow = NormalizedRateLimitWindow | NonNullable<LegacyQuotaSnapshot["primary"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowValid(window: GateWindow | null, label: string, faults: string[]): window is GateWindow {
  if (!window || !isRecord(window)) {
    faults.push(`${label}_missing`);
    return false;
  }
  if (typeof window.windowId !== "string" || window.windowId.trim().length === 0) faults.push(`${label}_window_id_missing`);
  if (!Number.isSafeInteger(window.remainingBps) || window.remainingBps < 0 || window.remainingBps > 10_000) faults.push(`${label}_remaining_invalid`);
  if (!Number.isSafeInteger(window.usedBps) || window.usedBps < 0 || window.usedBps > 10_000) faults.push(`${label}_used_invalid`);
  if (window.remainingBps + window.usedBps !== 10_000) faults.push(`${label}_percentage_conflict`);
  if (parseTime(window.updatedAt) === null) faults.push(`${label}_updated_at_invalid`);
  if (window.resetsAt !== null && window.resetsAt !== undefined && parseTime(window.resetsAt) === null) faults.push(`${label}_resets_at_invalid`);
  if ("exhausted" in window && typeof window.exhausted !== "boolean") faults.push(`${label}_exhausted_invalid`);
  return true;
}

function snapshotStatus(snapshot: QuotaGateSnapshot): string | null {
  return isRecord(snapshot) && typeof snapshot.status === "string" ? snapshot.status : null;
}

function sampleUpdatedAt(snapshot: QuotaGateSnapshot): string | null {
  return isRecord(snapshot) && typeof snapshot.updatedAt === "string" && snapshot.updatedAt.trim() ? snapshot.updatedAt : null;
}

function sampleId(snapshot: QuotaGateSnapshot): string | null {
  return isRecord(snapshot) && typeof snapshot.sampleId === "string" && snapshot.sampleId.trim() ? snapshot.sampleId : null;
}

function failure(
  status: "unknown" | "conflict",
  reason: string,
  faults: string[],
  snapshot: QuotaGateSnapshot
): QuotaGateDecision {
  const record: Record<string, unknown> = isRecord(snapshot) ? snapshot : {};
  const primary = isRecord(record.primary) ? record.primary : null;
  const secondary = isRecord(record.secondary) ? record.secondary : null;
  return {
    status,
    codexAvailable: false,
    drainRequired: false,
    returnReady: false,
    secondaryGuard: true,
    sampleFresh: false,
    reason,
    faults: [...new Set(faults)],
    sampleId: sampleId(snapshot),
    updatedAt: sampleUpdatedAt(snapshot),
    primaryRemainingBps: primary && typeof primary.remainingBps === "number" && Number.isSafeInteger(primary.remainingBps) ? primary.remainingBps : null,
    secondaryRemainingBps: secondary && typeof secondary.remainingBps === "number" && Number.isSafeInteger(secondary.remainingBps) ? secondary.remainingBps : null
  };
}

function freshness(snapshot: QuotaGateSnapshot, options: QuotaGateOptions, faults: string[]): boolean {
  const now = parseTime(options.now);
  if (now === null) {
    faults.push("observed_now_required");
    return false;
  }
  const maxAge = options.freshnessWindowMs ?? 300_000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    faults.push("freshness_window_invalid");
    return false;
  }
  const sampleAt = parseTime(snapshotUpdatedAt(snapshot));
  if (sampleAt === null || sampleAt > now || now - sampleAt > maxAge) {
    faults.push("sample_stale_or_from_future");
    return false;
  }
  for (const [label, window] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
    if (!window) continue;
    const updatedAt = parseTime(window.updatedAt);
    if (updatedAt === null || updatedAt > now || now - updatedAt > maxAge) faults.push(`${label}_sample_stale_or_from_future`);
  }
  return faults.length === 0;
}

function snapshotUpdatedAt(snapshot: QuotaGateSnapshot): string | null {
  return sampleUpdatedAt(snapshot);
}

function compareWithPrevious(snapshot: QuotaGateSnapshot, previous: QuotaGateSnapshot | null | undefined, faults: string[]): void {
  if (!previous) return;
  const currentAt = parseTime(snapshotUpdatedAt(snapshot));
  const previousAt = parseTime(snapshotUpdatedAt(previous));
  if (currentAt === null || previousAt === null) return;
  if (currentAt < previousAt) faults.push("updated_at_regressed");
  for (const [label, current, old] of [
    ["primary", snapshot.primary, previous.primary],
    ["secondary", snapshot.secondary, previous.secondary]
  ] as const) {
    if (current && old && current.windowId !== old.windowId) faults.push(`${label}_window_unmappable`);
    if (old && !current) faults.push(`${label}_window_disappeared`);
  }
}

/**
 * Evaluate down-going and return gates from a normalized structured sample.
 * This function is pure: in particular it cannot interrupt a thread or
 * preempt a web relay when a sample changes.
 */
export function evaluateQuotaGate(snapshot: QuotaGateSnapshot, options: QuotaGateOptions = {}): QuotaGateDecision {
  const faults: string[] = [];
  if (!isRecord(snapshot)) return failure("unknown", "QUOTA_DATA_UNKNOWN", ["snapshot_not_object"], snapshot as QuotaGateSnapshot);
  if (snapshotStatus(snapshot) === "conflict" || ("conflict" in snapshot && snapshot.conflict === true)) {
    return failure("conflict", "QUOTA_DATA_CONFLICT", ["snapshot_conflict"], snapshot);
  }
  if (snapshotStatus(snapshot) === "unknown") return failure("unknown", "QUOTA_DATA_UNKNOWN", ["snapshot_unknown"], snapshot);

  const primary = snapshot.primary as GateWindow | null;
  const secondary = snapshot.secondary as GateWindow | null;
  if (!windowValid(primary, "primary", faults)) return failure("unknown", "PRIMARY_DATA_UNKNOWN", faults, snapshot);
  if (secondary && !windowValid(secondary, "secondary", faults)) return failure("unknown", "SECONDARY_DATA_UNKNOWN", faults, snapshot);
  if (faults.length) {
    const conflict = faults.some((fault) => fault.includes("conflict"));
    return failure(conflict ? "conflict" : "unknown", conflict ? "QUOTA_DATA_CONFLICT" : "QUOTA_DATA_UNKNOWN", faults, snapshot);
  }

  compareWithPrevious(snapshot, options.previous, faults);
  if (faults.some((fault) => fault.includes("regressed"))) return failure("conflict", "QUOTA_TIME_REGRESSION", faults, snapshot);
  if (faults.some((fault) => fault.includes("unmappable") || fault.includes("disappeared"))) return failure("unknown", "QUOTA_WINDOW_UNMAPPABLE", faults, snapshot);
  if (!freshness(snapshot, options, faults)) return failure("unknown", "QUOTA_STALE_OR_MISSING", faults, snapshot);

  const primaryExhausted = "exhausted" in primary && primary.exhausted === true;
  if (primaryExhausted && primary.remainingBps > 500) return failure("conflict", "PRIMARY_EXHAUSTION_CONFLICT", ["primary_exhaustion_conflict"], snapshot);
  const secondaryExhausted = Boolean(secondary && "exhausted" in secondary && secondary.exhausted === true);
  if (secondaryExhausted && secondary!.remainingBps > 500) return failure("conflict", "SECONDARY_EXHAUSTION_CONFLICT", ["secondary_exhaustion_conflict"], snapshot);
  const primaryDepleted = primary.remainingBps <= 500 || primaryExhausted;
  const secondaryDepleted = Boolean(secondary && (secondary.remainingBps <= 500 || secondaryExhausted));
  const depleted = primaryDepleted || secondaryDepleted;
  const secondaryGuard = !secondary || secondaryDepleted;
  const depletionAt = options.depletedSampleUpdatedAt ?? options.lastDepletedUpdatedAt ??
    (options.previous && ((options.previous.primary && options.previous.primary.remainingBps <= 500)
      || (options.previous.secondary && options.previous.secondary.remainingBps <= 500)) ? snapshotUpdatedAt(options.previous) : null);
  const currentAt = parseTime(snapshotUpdatedAt(snapshot));
  const depletionSampleAt = parseTime(depletionAt);
  const newerThanDepletion = depletionSampleAt === null || (currentAt !== null && currentAt > depletionSampleAt);
  const observedNow = parseTime(options.now);
  const sampleBeforeReset = [primary, secondary].some((window) => {
    const resetAt = window ? parseTime(window.resetsAt) : null;
    return resetAt !== null && observedNow !== null && resetAt <= observedNow && currentAt !== null && resetAt >= currentAt;
  });
  const resetNeedsNewSample = sampleBeforeReset && depletionSampleAt === null;
  const returnReady = !depleted && primary.remainingBps >= 2_000 && !secondaryGuard && newerThanDepletion && !resetNeedsNewSample;
  let reason = "PRIMARY_AVAILABLE_BUT_RETURN_GATE_NOT_READY";
  if (primaryDepleted) reason = "PRIMARY_REMAINING_AT_OR_BELOW_5_PERCENT";
  else if (secondaryDepleted) reason = "SECONDARY_REMAINING_AT_OR_BELOW_5_PERCENT";
  else if (depletionSampleAt !== null && !newerThanDepletion) reason = "QUOTA_SAMPLE_NOT_NEWER_THAN_DEPLETION";
  else if (resetNeedsNewSample) reason = "QUOTA_RESET_REQUIRES_NEW_SAMPLE";
  else if (returnReady) reason = "PRIMARY_AND_SECONDARY_RETURN_GATE_PASSED";
  else if (secondaryGuard) reason = secondary ? "SECONDARY_QUOTA_GUARD" : "SECONDARY_DATA_REQUIRED_FOR_RETURN";

  return {
    status: depleted ? "depleted" : "available",
    codexAvailable: !depleted,
    drainRequired: depleted,
    returnReady,
    secondaryGuard,
    sampleFresh: true,
    reason,
    faults: [],
    sampleId: sampleId(snapshot),
    updatedAt: snapshotUpdatedAt(snapshot),
    primaryRemainingBps: primary.remainingBps,
    secondaryRemainingBps: secondary?.remainingBps ?? null
  };
}

export function quotaRecoveryObservation(snapshot: QuotaGateSnapshot, options: QuotaGateOptions = {}): QuotaRecoveryObservation {
  const decision = evaluateQuotaGate(snapshot, options);
  return {
    ...decision,
    action: decision.status === "available" ? "record_codex_available" : decision.status === "depleted" ? "hold_codex_depleted" : "hold_unknown",
    preemptWeb: false,
    returnOrInterruptIssued: false
  };
}

/** Convert a decision into the Wave 1 ledger quota shape without issuing effects. */
export function decisionToLedgerQuotaGate(snapshot: QuotaGateSnapshot, decision = evaluateQuotaGate(snapshot, {})): TaskLedger["quotaGate"] {
  return {
    status: decision.status,
    primaryRemainingBps: decision.primaryRemainingBps,
    secondaryRemainingBps: decision.secondaryRemainingBps,
    primaryWindowId: snapshot.primary?.windowId ?? null,
    secondaryWindowId: snapshot.secondary?.windowId ?? null,
    sampleId: decision.sampleId,
    sampleUpdatedAt: decision.updatedAt,
    sampledAt: "sampledAt" in snapshot && typeof snapshot.sampledAt === "string" ? snapshot.sampledAt : decision.updatedAt,
    codexAvailable: decision.codexAvailable,
    secondaryGuard: decision.secondaryGuard,
    exhaustedAt: decision.status === "depleted" ? decision.updatedAt : null,
    exhaustedReceiptId: null
  };
}

/** Names used by callers that prefer the shorter vocabulary. */
export const evaluateQuota = evaluateQuotaGate;
export const decideQuotaGate = evaluateQuotaGate;
export const toLedgerQuotaGate = decisionToLedgerQuotaGate;
export const quotaDecisionToGate = decisionToLedgerQuotaGate;
