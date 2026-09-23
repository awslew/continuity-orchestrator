#!/usr/bin/env node
/**
 * Wave 6 restart/reconcile verification drill (plan §10.3.2, §10.4).
 *
 * Runs the full restart cycle against a DEDICATED state root supplied by the
 * caller — never the user's repository state:
 *
 *   node scripts/verify-restart.mjs --state-root "<专用临时状态目录>"
 *
 * Stages: seed (task + mutations + receipts + lease) → restart (fresh
 * in-memory instances over the same root) → verify (fingerprint replay,
 * event continuity, index rebuild, receipt three-branch reconciliation,
 * lease renewal + recovery) → JSON verdict on stdout, exit 1 on any failure.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "../dist/src/domain/canonical.js";
import { IdempotencyRegistry } from "../dist/src/domain/idempotency.js";
import { LeaseManager } from "../dist/src/domain/leases.js";
import { EventLog } from "../dist/src/persistence/event-log.js";
import { HandoffStore, workSetHash } from "../dist/src/persistence/handoff-store.js";
import { IndexCache } from "../dist/src/persistence/index-cache.js";
import { EvidenceWriter } from "../dist/src/evidence/evidence-writer.js";
import { TaskCoordinator } from "../dist/src/workflow/task-coordinator.js";
import { Allowlist } from "../dist/src/security/allowlist.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-root") {
      args.stateRoot = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.stateRoot) {
  process.stderr.write("usage: node scripts/verify-restart.mjs --state-root <dedicated temp state directory>\n");
  process.exit(2);
}
const stateRoot = resolve(args.stateRoot);
if (existsSync(join(stateRoot, ".ai-handoff")) && readdirSync(join(stateRoot, ".ai-handoff")).length > 0) {
  process.stderr.write(`refusing to run: ${stateRoot} already contains .ai-handoff state; use a dedicated empty directory\n`);
  process.exit(2);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  return ok;
}

function fingerprint(ledger) {
  return sha256(JSON.parse(JSON.stringify(ledger)));
}

const TASK = "drill-task-1";
const items = [{
  taskId: "drill-item-1",
  parentId: TASK,
  status: "PENDING",
  dependencies: [],
  acceptance: ["drill criterion"],
  acceptancePassed: false,
  evidence: [],
  lastCheckpoint: null,
  sourceOfTruth: "source-plan"
}];

// ---------------------------------------------------------------- stage: seed
const store = new HandoffStore(stateRoot);
const allowlist = new Allowlist();
allowlist.registerWorkspace({ workspaceId: "default", root: stateRoot });
const coordinator = new TaskCoordinator(store, allowlist, new EvidenceWriter(stateRoot, 16_384));
const ledger = coordinator.registerTask({
  ledger: { taskId: TASK, projectId: "drill-project", repositoryId: "drill-repo", threadId: "thread-original", remainingWork: items, sourceHashes: { remaining_work: workSetHash(items) } },
  workspaceId: "default",
  actor: "drill"
});
coordinator.checkpoint(TASK, "drill-checkpoint-1", ledger.revision, "drill");
const preRestart = coordinator.get(TASK);
const preFingerprint = fingerprint(preRestart);

const eventLog = store.eventLog(TASK);
eventLog.append({ task_id: TASK, operation: "drain_observed", from_state: "CODEX_ACTIVE", to_state: "DRAINING", result: "observed" });
const eventCountBefore = eventLog.read().length;

const receipts = new IdempotencyRegistry();
const payload = { taskId: TASK, operation: "web_send" };
receipts.begin("drill-key-completed", payload);
receipts.complete("drill-key-completed", payload, { ok: true, receiptId: "drill-receipt-1" });
receipts.begin("drill-key-inflight", { ...payload, leg: "unknown" });

let millis = Date.parse("2026-09-03T00:00:00.000Z");
const clock = { now: () => new Date(millis) };
const leases = new LeaseManager();
const lease = leases.acquireTask(TASK, "drill-worker", 60_000, clock);

// -------------------------------------------------------------- stage: restart
const storeAfter = new HandoffStore(stateRoot);
const allowlistAfter = new Allowlist();
allowlistAfter.registerWorkspace({ workspaceId: "default", root: stateRoot });
const evidenceAfter = new EvidenceWriter(stateRoot, 16_384);
const coordinatorAfter = new TaskCoordinator(storeAfter, allowlistAfter, evidenceAfter);
const indexAfter = new IndexCache(stateRoot);
const receiptsAfter = new IdempotencyRegistry();
receiptsAfter.load(receipts.snapshot());
const leasesAfter = new LeaseManager();

// ---------------------------------------------------------------- stage: verify
let ok = true;

const stateRead = storeAfter.readState(TASK);
ok = check("state_replay_fingerprint", fingerprint(stateRead) === preFingerprint) && ok;

const eventsAfter = new EventLog(stateRoot, join(".ai-handoff", TASK, "events.jsonl")).read();
ok = check("event_replay_no_gaps", eventsAfter.length === eventCountBefore && eventsAfter.every((event, index) => event.seq === index + 1), `events=${eventsAfter.length}`) && ok;

const rebuilt = indexAfter.rebuild();
const entry = rebuilt.entries.find((candidate) => candidate.task_id === TASK);
ok = check("index_rebuild_from_task_dirs", Boolean(entry) && entry.revision === preRestart.revision && entry.state === preRestart.lifecycleState) && ok;

const completed = receiptsAfter.begin("drill-key-completed", payload);
ok = check("receipt_completed_replays_original", completed.kind === "replay") && ok;
const fresh = receiptsAfter.begin("drill-key-unknown", { ...payload, leg: "fresh" });
ok = check("receipt_unknown_starts_fresh", fresh.kind === "new") && ok;
const inflight = receiptsAfter.begin("drill-key-inflight", { ...payload, leg: "unknown" });
ok = check("receipt_inflight_requires_reconcile", inflight.kind === "in_flight") && ok;

// Lease renewal path (explicit check): the same token extends expiry while
// the lease is live; a foreign token can neither renew nor steal it; an
// expired lease refuses renewal instead of silently re-extending.
millis += 30_000;
const renewed = leases.renewTask(TASK, lease.token, 60_000, clock);
ok = check("lease_renew_extends_expiry", renewed.token === lease.token && renewed.expiresAt > lease.expiresAt, `expiresAt ${lease.expiresAt} -> ${renewed.expiresAt}`) && ok;
let renewForeign = null;
try { leases.renewTask(TASK, "foreign-token", 60_000, clock); } catch (error) { renewForeign = error; }
ok = check("lease_renew_rejects_foreign_token", renewForeign !== null && renewForeign.code === "LEASE_NOT_HELD") && ok;
let stealHeld = null;
try { leases.acquireTask(TASK, "drill-worker-c", 60_000, clock); } catch (error) { stealHeld = error; }
ok = check("lease_held_blocks_second_owner", stealHeld !== null && stealHeld.code === "LEASE_HELD") && ok;

millis += 120_000;
const expiredOk = !leasesAfter.isValid(leasesAfter.getTask(TASK), "drill-worker", lease.token, clock);
let renewExpired = null;
try { leases.renewTask(TASK, lease.token, 60_000, clock); } catch (error) { renewExpired = error; }
ok = check("lease_renew_rejects_expired", renewExpired !== null && renewExpired.code === "LEASE_EXPIRED" && !leases.isValid(lease, "drill-worker", lease.token, clock)) && ok;
let recovered = null;
try {
  recovered = leasesAfter.acquireTask(TASK, "drill-worker-b", 60_000, clock);
} catch { /* recovered stays null */ }
ok = check("lease_expired_then_recovered", expiredOk && recovered !== null && recovered.owner === "drill-worker-b") && ok;
ok = check("lease_recovery_not_terminal", storeAfter.readState(TASK).lifecycleState === preRestart.lifecycleState && preRestart.lifecycleState !== "WEB_TERMINAL") && ok;

const summary = {
  drill: "continuity-restart-reconcile-v1",
  stateRoot,
  at: new Date().toISOString(),
  task: TASK,
  preRestartState: preRestart.lifecycleState,
  preRestartRevision: preRestart.revision,
  events: eventsAfter.length,
  checks,
  verdict: ok ? "PASS" : "FAIL"
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(ok ? 0 : 1);
