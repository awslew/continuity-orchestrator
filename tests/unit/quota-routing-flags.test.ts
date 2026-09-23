import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLAGS, isFlagEnabled, parseFlags } from "../../src/flags.js";
import { parseConfig } from "../../src/config.js";
import { evaluateQuota, quotaDecisionToGate, type QuotaSnapshot } from "../../src/quota/quota-types.js";
import { canRouteExecutor, validateExecutorRequest } from "../../src/routing/executor-policy.js";

function snapshot(primaryRemainingBps: number, secondaryRemainingBps: number | null = null, updatedAt = "2026-09-01T00:00:00.000Z"): QuotaSnapshot {
  return {
    sampleId: "sample",
    sampledAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    source: "fixture",
    primary: {
      kind: "primary",
      windowId: "primary-window",
      remainingBps: primaryRemainingBps,
      usedBps: 10_000 - primaryRemainingBps,
      resetsAt: "2026-09-01T05:00:00.000Z",
      updatedAt,
      derivedRemaining: false,
      derivedUsed: false
    },
    secondary: secondaryRemainingBps === null ? null : {
      kind: "secondary",
      windowId: "secondary-window",
      remainingBps: secondaryRemainingBps,
      usedBps: 10_000 - secondaryRemainingBps,
      resetsAt: "2026-09-07T00:00:00.000Z",
      updatedAt,
      derivedRemaining: false,
      derivedUsed: false
    },
    rawHash: "fixture",
    conflict: false
  };
}

test("all feature flags are safe by default and web cannot mutate them", () => {
  assert.equal(DEFAULT_FLAGS.CONTINUITY_DRY_RUN, true);
  for (const [name, value] of Object.entries(DEFAULT_FLAGS)) {
    if (name !== "CONTINUITY_DRY_RUN") assert.equal(value, false, name);
  }
  assert.equal(isFlagEnabled(DEFAULT_FLAGS, "CONTINUITY_DRY_RUN"), true);
  assert.throws(() => parseFlags({ CONTINUITY_DRY_RUN: false }, "web"), { code: "RED_FLAGGED_INPUT" });
  assert.throws(() => parseFlags({ UNKNOWN_FLAG: true }), { code: "RED_FLAGGED_INPUT" });
  const configured = parseConfig({ flags: { CONTINUITY_DRY_RUN: false } });
  assert.equal(configured.flags.CONTINUITY_DRY_RUN, false);
});

test("quota guard uses integer 5 percent/20 percent boundaries and freshness", () => {
  const depleted = evaluateQuota(snapshot(500), { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(depleted.status, "depleted");
  assert.equal(depleted.drainRequired, true);
  const above = evaluateQuota(snapshot(501), { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(above.drainRequired, false);
  const returnReady = evaluateQuota(snapshot(2000, 6000), { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(returnReady.returnReady, true);
  const secondaryGuard = evaluateQuota(snapshot(3000, 500), { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(secondaryGuard.returnReady, false);
  assert.equal(secondaryGuard.secondaryGuard, true);
  assert.equal(secondaryGuard.drainRequired, true);
  assert.equal(secondaryGuard.codexAvailable, false);
  assert.equal(evaluateQuota(snapshot(2000), { now: new Date("2026-09-01T00:01:00.000Z") }).returnReady, false);
  const stale = evaluateQuota(snapshot(0, null, "2026-08-31T00:00:00.000Z"), { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(stale.status, "unknown");
  const conflict = evaluateQuota({ ...snapshot(3000), conflict: true }, { now: new Date("2026-09-01T00:01:00.000Z") });
  assert.equal(conflict.status, "conflict");
  assert.equal(quotaDecisionToGate(snapshot(500), { now: new Date("2026-09-01T00:01:00.000Z") }).status, "depleted");
});

test("executor policy blocks depleted Codex/Luna and requires explicit Bridge DSH", () => {
  assert.throws(() => validateExecutorRequest({ executor: "codex", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.throws(() => validateExecutorRequest({ executor: "luna", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.throws(() => validateExecutorRequest({ executor: "codex", continuation: "claude_resume", source: "engineering-bridge", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.throws(() => validateExecutorRequest({ executor: "dsh", continuation: "claude_resume", source: "engineering-bridge", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.throws(() => validateExecutorRequest({ executor: "bridge-dsh", continuation: "claude_resume", source: "engineering-bridge", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.throws(() => validateExecutorRequest({ executor: "claude", continuation: "dsh_fresh", source: "claude_orchestrator", quotaDepleted: true }), { code: "ROUTING_REJECTED" });
  assert.equal(canRouteExecutor({ executor: "claude", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted: true }), true);
  assert.equal(canRouteExecutor({ executor: "dsh", continuation: "dsh_fresh", source: "engineering-bridge", quotaDepleted: true }), true);
  assert.equal(canRouteExecutor({ executor: "dsh", continuation: "dsh_fresh", source: "claude_orchestrator", quotaDepleted: true }), true);
});
