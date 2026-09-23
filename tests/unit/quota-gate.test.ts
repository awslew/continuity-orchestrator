import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRateLimits,
  normalizeRateLimitsRead,
  normalizeRateLimitsUpdated,
  type NormalizedQuotaSnapshot
} from "../../src/quota/quota-normalizer.js";
import {
  evaluateQuotaGate,
  quotaRecoveryObservation,
  toLedgerQuotaGate
} from "../../src/quota/quota-gate.js";

const NOW = "2026-09-01T02:00:00.000Z";

function message(primaryRemaining: number, primaryUsed = 100 - primaryRemaining, secondaryRemaining: number | null = 60, updatedAt = "2026-09-01T01:59:00.000Z"): Record<string, unknown> {
  const primary = {
    windowId: "five-hour",
    usedPercent: primaryUsed,
    remainingPercent: primaryRemaining,
    updatedAt,
    resetsAt: "2026-09-01T05:00:00.000Z"
  };
  const rateLimits: Record<string, unknown> = { primary };
  if (secondaryRemaining !== null) {
    rateLimits.secondary = {
      windowId: "weekly",
      usedPercent: 100 - secondaryRemaining,
      remainingPercent: secondaryRemaining,
      updatedAt,
      resetsAt: "2026-09-07T00:00:00.000Z"
    };
  }
  return { method: "account/rateLimits/read", result: { rateLimits } };
}

function normalized(input: Record<string, unknown>, previous?: NormalizedQuotaSnapshot): NormalizedQuotaSnapshot {
  return normalizeRateLimits(input, previous === undefined ? { source: "fixture" } : { source: "fixture", previous });
}

test("normalizer stores primary/secondary integer basis points and a sample hash", () => {
  const snapshot = normalized(message(5));
  assert.equal(snapshot.status, "fresh");
  assert.equal(snapshot.primary?.remainingBps, 500);
  assert.equal(snapshot.primary?.usedBps, 9500);
  assert.equal(snapshot.secondary?.remainingBps, 6000);
  assert.equal(snapshot.primary?.derivedRemaining, false);
  assert.equal(snapshot.primary?.derivedUsed, false);
  assert.match(snapshot.sampleHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.rawHash.startsWith("sha256:"), true);
  assert.equal(snapshot.operation, "account/rateLimits/read");
});

test("5.1 percent is above the down-going threshold while 95 used is equivalent to 5 remaining", () => {
  const atFive = normalized(message(5, 95));
  const atFivePointOne = normalized(message(5.1, 94.9));
  const depleted = evaluateQuotaGate(atFive, { now: NOW });
  const available = evaluateQuotaGate(atFivePointOne, { now: NOW });
  assert.equal(depleted.status, "depleted");
  assert.equal(depleted.drainRequired, true);
  assert.equal(available.status, "available");
  assert.equal(available.drainRequired, false);
});

test("one supplied percentage is derived and over-precise quota floats are rejected", () => {
  const onlyRemaining = normalized({
    method: "account/rateLimits/read",
    result: { rateLimits: { primary: { windowId: "five-hour", remainingPercent: 20, updatedAt: NOW } } }
  });
  assert.equal(onlyRemaining.status, "fresh");
  assert.equal(onlyRemaining.primary?.usedBps, 8000);
  assert.equal(onlyRemaining.primary?.derivedUsed, true);
  const float = normalized(message(5.123, 94.877));
  assert.equal(float.status, "unknown");
  assert.equal(float.primary, null);
});

test("conflicting percentages and invalid/missing structured fields fail closed", () => {
  const conflict = normalized({
    method: "account/rateLimits/read",
    result: { rateLimits: { primary: { windowId: "five-hour", usedPercent: 90, remainingPercent: 5, updatedAt: NOW } } }
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflict, true);
  const missingUpdated = normalized({
    method: "account/rateLimits/read",
    result: { rateLimits: { primary: { windowId: "five-hour", remainingPercent: 5, usedPercent: 95 } } }
  });
  assert.equal(missingUpdated.status, "unknown");
  const unsupported = normalizeRateLimits("95% remaining");
  assert.equal(unsupported.status, "unknown");
  assert.equal(unsupported.primary, null);
});

test("updated notification is accepted only under its structured operation", () => {
  const updated = normalizeRateLimitsUpdated({
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { windowId: "five-hour", usedPercent: 80, remainingPercent: 20, updatedAt: NOW } } }
  }, { source: "fixture" });
  assert.equal(updated.status, "fresh");
  assert.equal(updated.operation, "account/rateLimits/updated");
  const readViaConvenience = normalizeRateLimitsRead({ result: { rateLimits: { primary: { windowId: "five-hour", usedPercent: 80, remainingPercent: 20, updatedAt: NOW } } } }, { source: "fixture" });
  assert.equal(readViaConvenience.status, "fresh");
});

test("stale, future, and time-regressed samples remain unknown/conflict", () => {
  const stale = normalized(message(1, 99, 60, "2026-08-31T00:00:00.000Z"));
  assert.equal(evaluateQuotaGate(stale, { now: NOW, freshnessWindowMs: 300_000 }).status, "unknown");
  const first = normalized(message(5, 95, 60, "2026-09-01T01:30:00.000Z"));
  const regressed = normalized(message(20, 80, 60, "2026-09-01T01:00:00.000Z"), first);
  assert.equal(regressed.status, "conflict");
  assert.equal(evaluateQuotaGate(regressed, { now: NOW }).status, "conflict");
  const noClock = evaluateQuotaGate(first);
  assert.equal(noClock.status, "unknown");
});

test("primary 20 percent and secondary strictly above 5 percent are required for return", () => {
  const primary20 = normalized(message(20, 80, 60));
  const ready = evaluateQuotaGate(primary20, { now: NOW });
  assert.equal(ready.returnReady, true);
  const secondaryAtFive = normalized(message(20, 80, 5));
  const held = evaluateQuotaGate(secondaryAtFive, { now: NOW });
  assert.equal(held.returnReady, false);
  assert.equal(held.secondaryGuard, true);
  assert.equal(held.reason, "SECONDARY_REMAINING_AT_OR_BELOW_5_PERCENT");
  const noSecondary = normalized(message(20, 80, null));
  assert.equal(evaluateQuotaGate(noSecondary, { now: NOW }).returnReady, false);
});

test("reset time alone cannot recover; recovery needs a newer sample", () => {
  const depleted = normalized(message(5, 95, 60, "2026-09-01T00:00:00.000Z"));
  assert.equal(evaluateQuotaGate(depleted, { now: NOW, freshnessWindowMs: 10_800_000 }).status, "depleted");
  const sameSampleAfterReset = normalized(message(20, 80, 60, "2026-09-01T00:00:00.000Z"));
  const held = evaluateQuotaGate(sameSampleAfterReset, { now: NOW, freshnessWindowMs: 10_800_000, depletedSampleUpdatedAt: depleted.updatedAt });
  assert.equal(held.status, "available");
  assert.equal(held.returnReady, false);
  assert.equal(held.reason, "QUOTA_SAMPLE_NOT_NEWER_THAN_DEPLETION");
  const newer = normalized(message(20, 80, 60, "2026-09-01T01:00:00.000Z"));
  assert.equal(evaluateQuotaGate(newer, { now: NOW, freshnessWindowMs: 10_800_000, depletedSampleUpdatedAt: depleted.updatedAt }).returnReady, true);
});

test("quota recovery observation has no interrupt/return side effect and ledger conversion preserves gates", () => {
  const snapshot = normalized(message(20, 80, 60));
  const observation = quotaRecoveryObservation(snapshot, { now: NOW });
  assert.equal(observation.action, "record_codex_available");
  assert.equal(observation.preemptWeb, false);
  assert.equal(observation.returnOrInterruptIssued, false);
  const gate = toLedgerQuotaGate(snapshot, observation);
  assert.equal(gate.primaryRemainingBps, 2000);
  assert.equal(gate.secondaryRemainingBps, 6000);
  assert.equal(gate.codexAvailable, true);
});

test("weekly depletion triggers the gate even with a healthy short window, without issuing effects", () => {
  for (const remaining of [0, 5]) {
    const snapshot = normalized(message(90, 10, remaining));
    const decision = evaluateQuotaGate(snapshot, { now: NOW });
    assert.equal(decision.drainRequired, true);
    assert.equal(decision.codexAvailable, false);
    assert.equal(decision.returnReady, false);
    assert.equal(decision.reason, "SECONDARY_REMAINING_AT_OR_BELOW_5_PERCENT");
    const observation = quotaRecoveryObservation(snapshot, { now: NOW });
    assert.equal(observation.action, "hold_codex_depleted");
    assert.equal(observation.returnOrInterruptIssued, false);
  }
  assert.equal(evaluateQuotaGate(normalized(message(90, 10, 5.1)), { now: NOW }).drainRequired, false);
});

test("weekly recovery requires a newer sample, and refreshing only the short window cannot recover", () => {
  const previous = normalized(message(90, 10, 0));
  const unchangedTime = normalized(message(90, 10, 60));
  assert.equal(evaluateQuotaGate(unchangedTime, { now: NOW, previous }).returnReady, false);
  const newerTime = new Date(Date.parse(NOW) + 1_000).toISOString();
  const recovered = normalized(message(90, 10, 60, newerTime));
  assert.equal(evaluateQuotaGate(recovered, { now: newerTime, previous }).returnReady, true);
  const stillExhausted = normalized(message(100, 0, 0, newerTime));
  assert.equal(evaluateQuotaGate(stillExhausted, { now: newerTime, previous }).returnReady, false);
  const staleWeekly = { ...recovered, secondary: { ...recovered.secondary!, updatedAt: "2026-08-01T00:00:00.000Z" } };
  assert.equal(evaluateQuotaGate(staleWeekly, { now: newerTime }).status, "unknown");
});
