import { sha256, clone } from "../domain/canonical.js";
import { evaluateQuotaGate } from "./quota-gate.js";

export type QuotaGuardStatus = "fresh" | "depleted" | "available" | "unknown" | "conflict";

export interface NormalizedQuotaWindow {
  kind: "primary" | "secondary";
  windowId: string;
  remainingBps: number;
  usedBps: number;
  resetsAt: string | null;
  updatedAt: string;
  derivedRemaining: boolean;
  derivedUsed: boolean;
}

export interface QuotaSnapshot {
  sampleId: string;
  sampledAt: string;
  updatedAt: string;
  primary: NormalizedQuotaWindow | null;
  secondary: NormalizedQuotaWindow | null;
  source: "app-server" | "fixture";
  rawHash: string;
  conflict: boolean;
}

export interface QuotaDecision {
  status: QuotaGuardStatus;
  codexAvailable: boolean;
  drainRequired: boolean;
  returnReady: boolean;
  secondaryGuard: boolean;
  reason: string;
}

export interface QuotaGuardOptions {
  now?: Date;
  freshnessWindowMs?: number;
}

/** Pure guard only; no App Server calls or local-clock-only recovery. */
export function evaluateQuota(snapshot: QuotaSnapshot, options: QuotaGuardOptions = {}): QuotaDecision {
  // Keep the legacy API, but use one authoritative policy for both windows,
  // freshness and missing data. No independent, weaker recovery gate.
  const { status, codexAvailable, drainRequired, returnReady, secondaryGuard, reason } = evaluateQuotaGate(snapshot, options);
  return { status, codexAvailable, drainRequired, returnReady, secondaryGuard, reason };
}

export function snapshotHash(snapshot: Omit<QuotaSnapshot, "rawHash">): string {
  return sha256(snapshot);
}

export function quotaDecisionToGate(snapshot: QuotaSnapshot, options: QuotaGuardOptions = {}) {
  const decision = evaluateQuota(snapshot, options);
  return {
    status: decision.status,
    primaryRemainingBps: snapshot.primary?.remainingBps ?? null,
    secondaryRemainingBps: snapshot.secondary?.remainingBps ?? null,
    primaryWindowId: snapshot.primary?.windowId ?? null,
    secondaryWindowId: snapshot.secondary?.windowId ?? null,
    sampleId: snapshot.sampleId,
    sampleUpdatedAt: snapshot.updatedAt,
    sampledAt: snapshot.sampledAt,
    codexAvailable: decision.codexAvailable,
    secondaryGuard: decision.secondaryGuard,
    exhaustedAt: decision.status === "depleted" ? snapshot.sampledAt : null,
    exhaustedReceiptId: null
  } as const;
}

export function cloneQuotaSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  return clone(snapshot);
}
