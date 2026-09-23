import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  ContinuityEnvelope,
  assertNoUndeclaredEnvelopeFields,
  envelopeError,
  errorEnvelope,
  errorFromDomainError,
  isContinuityEnvelope,
  okEnvelope
} from "../../src/mcp/result.js";
import { Allowlist, TUNNEL_PERMISSIONS } from "../../src/security/allowlist.js";
import { ConfirmationGateRegistry, assertExactConfirmation } from "../../src/security/confirmations.js";
import { DomainError } from "../../src/domain/errors.js";
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES, MUTATING_TOOLS } from "../../src/mcp/schemas.js";

test("envelope is a closed shape and ok/error pairing is consistent", () => {
  const ok = okEnvelope({ requestId: "req_1", taskId: "t1", projectId: "p1", state: "HANDOFF_READY", revision: 3, idempotencyKey: "idem-key-1" }, { value: 42 });
  assert.equal(ok.ok, true);
  assert.equal(ok.error, null);
  assert.equal(ok.schema_version, "continuity.v1");
  assert.ok(isContinuityEnvelope(ok));
  assert.throws(() => assertNoUndeclaredEnvelopeFields({ ...ok, sneaky: true }), /Undeclared envelope field: sneaky/);

  const failure = errorEnvelope({ requestId: "req_2" }, envelopeError("TOOL_UNKNOWN", "nope", { needs_human: false }));
  assert.equal(failure.ok, false);
  assert.ok(failure.error);
  assert.equal(failure.error.code, "TOOL_UNKNOWN");
  assert.ok(isContinuityEnvelope(failure));

  const tampered = { ...ok, error: { code: "X", message: "m", retryable: false, needs_human: false } } as ContinuityEnvelope;
  assert.equal(isContinuityEnvelope(tampered), false, "ok envelope with an error object is invalid");
});

test("domain errors map to retryable/needs_human envelope errors", () => {
  const conflict = errorFromDomainError(new DomainError("REVISION_CONFLICT", "stale revision"));
  assert.equal(conflict.retryable, true);
  assert.equal(conflict.needs_human, false);

  const confirmation = errorFromDomainError(new DomainError("RED_FLAGGED_INPUT", "bad"));
  assert.equal(conflict.needs_human, false);
  assert.equal(confirmation.needs_human, true);
});

test("tool schemas are strict about unknown fields and path-like identifiers", () => {
  // The relay tool surface is a closed, counted contract: the original 18 tools
  // plus the two entry points the relay could not run without. A silent change
  // here changes the advertised MCP tools/list response.
  assert.equal(TOOL_NAMES.length, 20);
  assert.ok(TOOL_NAMES.includes("continuity_task_register"));
  assert.ok(TOOL_NAMES.includes("continuity_drain"));
  assert.equal(MUTATING_TOOLS.has("continuity_task_register"), true);
  assert.equal(MUTATING_TOOLS.has("continuity_drain"), true);
  const status = TOOL_INPUT_SCHEMAS.continuity_task_status.parse({ task_id: "task-a" });
  assert.equal(status.task_id, "task-a");
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_task_status.parse({ task_id: "task-a", extra: 1 }), /Unrecognized key/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_task_status.parse({ task_id: "../escape" }), /path separators or traversal/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_task_status.parse({ task_id: "a/b" }), /path separators or traversal/);
  assert.throws(
    () => TOOL_INPUT_SCHEMAS.continuity_checkpoint.parse({ task_id: "t", checkpoint: "c", expected_revision: 1, idempotency_key: "short" }),
    /at least 8/
  );
  // mutation tools require an idempotency key at schema level (web_session handles it per action)
  for (const tool of TOOL_NAMES) {
    if (tool === "continuity_web_session" || !MUTATING_TOOLS.has(tool)) continue;
    const schema = TOOL_INPUT_SCHEMAS[tool] as unknown as { shape: Record<string, { isOptional?: () => boolean }> };
    assert.ok(schema.shape["idempotency_key"], `${tool} must declare idempotency_key`);
  }
  // confirmation literals are exact
  assert.throws(
    () => TOOL_INPUT_SCHEMAS.continuity_patch_apply.parse({ patch_task_id: "p1", confirmation: "apply", expected_revision: 1, idempotency_key: "idem-key-2" }),
    /Invalid literal value/
  );
  assert.equal(
    TOOL_INPUT_SCHEMAS.continuity_patch_apply.parse({ patch_task_id: "p1", confirmation: "APPLY", expected_revision: 1, idempotency_key: "idem-key-2" }).confirmation,
    "APPLY"
  );
});

test("allowlist contains paths, ids and tunnel permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-allowlist-"));
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  assert.throws(() => allowlist.registerWorkspace({ workspaceId: "bad/name", root }), /logical identifier/);
  assert.throws(() => allowlist.registerWorkspace({ workspaceId: "rel", root: "relative/path" }), /absolute path/);

  const resolved = allowlist.resolveWorkspacePath("default", join("sub", "file.txt"));
  assert.ok(resolved.startsWith(root));
  assert.throws(() => allowlist.resolveWorkspacePath("default", "C:\\Windows\\system32"), /absolute paths are not accepted/);
  assert.throws(() => allowlist.resolveWorkspacePath("default", "https://evil.example/payload"), /URL-like paths/);
  assert.throws(() => allowlist.resolveWorkspacePath("unknown", "sub/file.txt"), /not registered/);

  allowlist.registerTaskId("task-1");
  allowlist.assertRegisteredTaskId("task-1");
  assert.throws(() => allowlist.assertRegisteredTaskId("task-2"), /not registered/);

  assert.deepEqual(Allowlist.parseTunnelPermissions(["Read", "Use"]), TUNNEL_PERMISSIONS);
  assert.throws(() => Allowlist.parseTunnelPermissions(["Read", "Manage"]), /Manage never enters runtime/);
  assert.throws(() => allowlist.assertAllowedExecutor("luna"), /not allowlisted/);
  assert.doesNotThrow(() => allowlist.assertAllowedExecutor("dsh"));
});

test("confirmation gates accept only exact literals and are consumed once", () => {
  assertExactConfirmation("APPLY", "APPLY");
  assert.throws(() => assertExactConfirmation("APPLY", "apply"), /exact literal "APPLY"/);
  assert.throws(() => assertExactConfirmation("APPLY", "  APPLY"), /exact literal/);
  assert.throws(() => assertExactConfirmation("COMMIT", "APPLY"), /exact literal "COMMIT"/);

  const gates = new ConfirmationGateRegistry();
  const first = gates.open("APPLY", "patch-1", "idem-apply-1", "web");
  assert.equal(first.confirmed, true);
  assert.equal(first.kind, "APPLY");
  const replay = gates.open("APPLY", "patch-1", "idem-apply-1", "web");
  assert.equal(replay.gateId, first.gateId);
  assert.throws(() => gates.open("COMMIT", "patch-1", "idem-apply-1", "web"), /already used for another gate/);

  const consumed = gates.require("APPLY", "patch-1");
  assert.equal(consumed.gateId, first.gateId);
  assert.equal(gates.has("APPLY", "patch-1"), false, "gate is consumed by require");
  assert.throws(() => gates.require("APPLY", "patch-1"), /no open APPLY confirmation gate/);
  assert.throws(() => gates.require("COMMIT", "patch-1"), /no open COMMIT confirmation gate/);
});
