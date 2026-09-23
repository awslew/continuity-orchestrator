import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { ConfirmationGateRegistry } from "../../src/security/confirmations.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { HandoffStore } from "../../src/persistence/handoff-store.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import { MockWebgptDriveTransport, WebgptDriveAdapter } from "../../src/adapters/webgpt-drive.js";
import { ContinuityMcpServer, type PatchBackend } from "../../src/mcp/server.js";

interface BackendLog {
  proposed: number;
  validated: number;
  applied: number;
  committed: number;
  pushed: number;
}

function patchRig(verdict: "PASS" | "FAIL" | "INCOMPLETE" = "PASS"): { server: ContinuityMcpServer; log: BackendLog } {
  const root = mkdtempSync(join(tmpdir(), "continuity-patch-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const evidence = new EvidenceWriter(root, 16_384);
  const coordinator = new TaskCoordinator(store, allowlist, evidence);
  coordinator.registerTask({
    ledger: { taskId: "task-1", projectId: "project-1", repositoryId: "repo-1" },
    workspaceId: "default"
  });
  const log: BackendLog = { proposed: 0, validated: 0, applied: 0, committed: 0, pushed: 0 };
  const backend: PatchBackend = {
    async propose() {
      log.proposed += 1;
      return { diff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n", baseHead: "basehead-123" };
    },
    async validate() {
      log.validated += 1;
      return { verdict, reasons: verdict === "PASS" ? [] : [`mock verdict ${verdict}`] };
    },
    async apply() {
      log.applied += 1;
      return { changedFiles: ["file.txt"], applyReceiptId: `apply-${log.applied}` };
    },
    async commit() {
      log.committed += 1;
      return { commitHash: "commit-sha-1", commitReceiptId: `commit-${log.committed}` };
    }
  };
  const server = new ContinuityMcpServer({
    coordinator,
    store,
    allowlist,
    confirmations: new ConfirmationGateRegistry(),
    evidence,
    webgpt: new WebgptDriveAdapter(new MockWebgptDriveTransport()),
    flags: { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true, CONTINUITY_DSH_ENABLED: true },
    patchBackend: backend
  });
  return { server, log };
}

const changeRequest = {
  title: "flip the greeting",
  motivation: "the greeting is stale",
  workspaceId: "default",
  paths: ["file.txt"],
  baseHead: "basehead-123"
};

test("controlled patch loop: propose, validate, APPLY gate, COMMIT gate, no push", async () => {
  const { server, log } = patchRig();

  const proposed = await server.call(
    "continuity_patch_propose",
    { task_id: "task-1", change_request: changeRequest, executor: "dsh", idempotency_key: "idem-patch-1" },
    "req-p1"
  );
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const patchTaskId = (proposed.data as { patch_task_id: string }).patch_task_id;
  assert.match(patchTaskId, /^patch_[0-9a-f]{12}$/);
  assert.ok((proposed.data as { diff: string }).diff.includes("+new"));

  const invalidVerdict = await server.call("continuity_patch_apply", { patch_task_id: patchTaskId, confirmation: "APPLY", expected_revision: 1, idempotency_key: "idem-apply-0" }, "req-p2");
  assert.equal(invalidVerdict.ok, false);
  assert.equal(invalidVerdict.error?.code, "PATCH_NOT_VALIDATED", "unvalidated patches are never applied");

  const validated = await server.call("continuity_patch_validate", { patch_task_id: patchTaskId }, "req-p3");
  assert.equal(validated.ok, true);
  assert.equal((validated.data as { verdict: string }).verdict, "PASS");

  const fuzzyConfirmation = await server.call(
    "continuity_patch_apply",
    { patch_task_id: patchTaskId, confirmation: "please APPLY", expected_revision: 1, idempotency_key: "idem-apply-1" },
    "req-p4"
  );
  assert.equal(fuzzyConfirmation.ok, false);
  assert.equal(fuzzyConfirmation.error?.code, "TOOL_INPUT_INVALID", "the confirmation word is an exact literal at schema level");

  const applied = await server.call(
    "continuity_patch_apply",
    { patch_task_id: patchTaskId, confirmation: "APPLY", expected_revision: 1, idempotency_key: "idem-apply-2" },
    "req-p5"
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual((applied.data as { changed_files: string[] }).changed_files, ["file.txt"]);

  const reapply = await server.call(
    "continuity_patch_apply",
    { patch_task_id: patchTaskId, confirmation: "APPLY", expected_revision: 1, idempotency_key: "idem-apply-3" },
    "req-p6"
  );
  assert.equal(reapply.ok, false);
  assert.equal(reapply.error?.code, "PATCH_ALREADY_APPLIED");

  const commitBeforeGate = await server.call(
    "continuity_patch_commit",
    { patch_task_id: patchTaskId, message: "flip greeting", confirmation: "COMMIT", expected_revision: 1, idempotency_key: "idem-commit-1" },
    "req-p7"
  );
  assert.equal(commitBeforeGate.ok, true, JSON.stringify(commitBeforeGate));
  assert.equal((commitBeforeGate.data as { commit_hash: string }).commit_hash, "commit-sha-1");
  assert.equal((commitBeforeGate.data as { push_deploy: string }).push_deploy, "rejected_by_design");

  const recommit = await server.call(
    "continuity_patch_commit",
    { patch_task_id: patchTaskId, message: "flip greeting", confirmation: "COMMIT", expected_revision: 1, idempotency_key: "idem-commit-2" },
    "req-p8"
  );
  assert.equal(recommit.ok, false);
  assert.equal(recommit.error?.code, "PATCH_ALREADY_COMMITTED");

  assert.deepEqual(log, { proposed: 1, validated: 1, applied: 1, committed: 1, pushed: 0 });
});

test("a FAIL or INCOMPLETE verdict blocks the apply gate", async () => {
  const { server } = patchRig("INCOMPLETE");
  const proposed = await server.call(
    "continuity_patch_propose",
    { task_id: "task-1", change_request: changeRequest, executor: "bridge-dsh", idempotency_key: "idem-patch-inc" },
    "req-i1"
  );
  assert.equal(proposed.ok, true);
  const patchTaskId = (proposed.data as { patch_task_id: string }).patch_task_id;
  await server.call("continuity_patch_validate", { patch_task_id: patchTaskId }, "req-i2");
  const applied = await server.call(
    "continuity_patch_apply",
    { patch_task_id: patchTaskId, confirmation: "APPLY", expected_revision: 1, idempotency_key: "idem-apply-inc" },
    "req-i3"
  );
  assert.equal(applied.ok, false);
  assert.equal(applied.error?.code, "PATCH_NOT_VALIDATED");
  assert.match(applied.error?.message ?? "", /INCOMPLETE/);
});

test("unknown patch ids and unregistered tasks are rejected before any backend call", async () => {
  const { server, log } = patchRig();
  const unknownPatch = await server.call("continuity_patch_validate", { patch_task_id: "patch-does-not-exist" }, "req-u1");
  assert.equal(unknownPatch.ok, false);
  assert.equal(unknownPatch.error?.code, "RED_FLAGGED_INPUT");

  const unknownTask = await server.call(
    "continuity_patch_propose",
    { task_id: "task-unknown", change_request: changeRequest, executor: "dsh", idempotency_key: "idem-patch-u2" },
    "req-u2"
  );
  assert.equal(unknownTask.ok, false);
  assert.equal(unknownTask.error?.code, "RED_FLAGGED_INPUT");
  assert.equal(log.proposed, 0, "no backend call happened");
});
