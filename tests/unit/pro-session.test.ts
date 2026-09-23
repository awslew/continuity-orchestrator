import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProSession, dshBridgeEnvironment } from "../../src/project-reader/pro.js";

async function setup(t: test.TestContext, bridge?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>, workers = false) {
  const root = await mkdtemp(join(tmpdir(), "pro-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return ProSession.create({ version: 1, reader: { version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] },
    bridge: { entry: join(root, "bridge.js"), workspaces_config: join(root, "workspaces.json"), workspace_ids: ["demo"], allow_workers: workers } }, bridge);
}
test("Pro prevents implicit Codex routes and rejects unknown tools/workspaces", async t => {
  let calls = 0;
  const s = await setup(t, async () => { calls++; return {}; });
  await assert.rejects(s.call("continuity_worker_start", { workspace_id: "demo", kind: "analysis", instruction: "inspect" }), /disabled/);
  await assert.rejects(s.call("run_task", { executor: "codex" }), /Unknown/);
  await assert.rejects(s.call("continuity_patch_submit", { workspace_id: "other", base_head: "a".repeat(40), diff: "x" }), /not enabled/);
  await assert.rejects(s.call("continuity_worker_start", { workspace_id: "demo", kind: "analysis", instruction: "inspect", executor: "codex" }));
  assert.equal(calls, 0);
});

test("DSH native configuration survives SDK filtering without Tunnel credentials or model overrides", async t => {
  const s = await setup(t, async () => ({}), true);
  const host = { DSH_HOME: "native-home", DSH_TOOLS_MODE: "native-tools", DEEPSEEK_API_KEY: "test-only-key", CONTROL_PLANE_API_KEY: "never-forward", OPENAI_API_KEY: "never-forward", DSH_MODEL: "never-override" };
  assert.deepEqual(dshBridgeEnvironment(s.config, host), { DSH_HOME: "native-home", DSH_TOOLS_MODE: "native-tools", DEEPSEEK_API_KEY: "test-only-key" });
  const disabled = await setup(t);
  assert.deepEqual(dshBridgeEnvironment(disabled.config, host), {});
});
test("explicit delegation pins DSH and controls only its own task IDs", async t => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const s = await setup(t, async (name, args) => { calls.push({ name, args }); return { task_id: "worker-1" }; }, true);
  await assert.rejects(s.call("continuity_worker_control", { task_id: "foreign", action: "continue" }), /Only DSH/);
  await s.call("continuity_worker_start", { workspace_id: "demo", kind: "patch", instruction: "fix" });
  assert.equal(calls[0]?.name, "generate_controlled_patch");
  assert.equal(calls[0]?.args.executor, "dsh");
  await s.call("continuity_worker_control", { task_id: "worker-1", action: "interrupt" });
  assert.equal(calls.length, 2);
});
test("validation is pollable and FAIL blocks apply; PASS permits only the exact patch", async t => {
  let resolve!: (value: Record<string, unknown>) => void;
  const s = await setup(t, async name => name === "validate_controlled_patch" ? new Promise(r => { resolve = r; }) : name === "submit_controlled_patch" ? { task_id: "p1" } : { applied: true });
  await s.call("continuity_patch_submit", { workspace_id: "demo", base_head: "a".repeat(40), diff: "mock proposal" });
  await assert.rejects(s.call("continuity_patch_validate", { patch_task_id: "foreign" }), /Only patches/);
  await assert.rejects(s.call("continuity_task_result", { task_id: "foreign" }), /not created/);
  const job = await s.call("continuity_patch_validate", { patch_task_id: "p1" }) as { task_id: string };
  assert.equal((await s.call("continuity_task_result", { task_id: job.task_id }) as { ready: boolean }).ready, false);
  await assert.rejects(s.call("continuity_patch_apply", { patch_task_id: "p1", confirmation: "APPLY" }), /PASS/);
  resolve({ status: "FAIL" }); await new Promise(r => setImmediate(r));
  await assert.rejects(s.call("continuity_patch_apply", { patch_task_id: "p1", confirmation: "APPLY" }), /PASS/);
  await s.call("continuity_patch_validate", { patch_task_id: "p1" });
  resolve({ status: "PASS" }); await new Promise(r => setImmediate(r));
  await assert.rejects(s.call("continuity_patch_apply", { patch_task_id: "p2", confirmation: "APPLY" }), /PASS/);
  assert.deepEqual(await s.call("continuity_patch_apply", { patch_task_id: "p1", confirmation: "APPLY" }), { applied: true });
  await assert.rejects(s.call("continuity_patch_apply", { patch_task_id: "p1", confirmation: "APPLY" }), /PASS/);
});
test("lost transport response blocks automatic retry", async t => {
  let count = 0;
  const s = await setup(t, async () => { count++; throw new Error("transport lost private path"); });
  const input = { workspace_id: "demo", base_head: "a".repeat(40), diff: "x" };
  await assert.rejects(s.call("continuity_patch_submit", input), /outcome may be unknown/);
  await assert.rejects(s.call("continuity_patch_submit", input), /response was lost/);
  assert.equal(count, 1);
});
test("continuing a generated patch invalidates its earlier validation", async t => {
  const s = await setup(t, async name => name === "validate_controlled_patch" ? { status: "PASS" } : { task_id: "generated" }, true);
  await s.call("continuity_worker_start", { workspace_id: "demo", kind: "patch", instruction: "fix" });
  await s.call("continuity_patch_validate", { patch_task_id: "generated" });
  await new Promise(r => setImmediate(r));
  await s.call("continuity_worker_control", { task_id: "generated", action: "continue", instruction: "different fix" });
  await assert.rejects(s.call("continuity_patch_apply", { patch_task_id: "generated", confirmation: "APPLY" }), /PASS/);
});
