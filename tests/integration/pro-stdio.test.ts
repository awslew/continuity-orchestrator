import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
test("real Pro stdio: caller diff -> failing/passing local validation -> apply -> reread, without LLM", { timeout: 90000 }, async t => {
  const entry = process.env.CONTINUITY_TEST_BRIDGE_ENTRY ?? resolve("../_research/upstream-1.4.4/engineering-bridge-1.4.4/dist/src/mcp-stdio.js");
  try { await access(entry); } catch { t.skip("Build Bridge and set CONTINUITY_TEST_BRIDGE_ENTRY for this real integration"); return; }
  const parent = await mkdtemp(join(tmpdir(), "continuity-pro-real-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project"); await mkdir(root);
  const git = async (args: string[]) => (await exec("git", ["-C", root, ...args], { windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "README.md"), "old\n");
  await git(["add", "README.md"]);
  await git(["-c", "user.name=Pro Test", "-c", "user.email=pro-test@example.invalid", "commit", "-m", "fixture"]);
  const head = await git(["rev-parse", "HEAD"]);
  const workspaces = join(parent, "workspaces.json");
  await writeFile(workspaces, JSON.stringify([{ id: "demo", root, allow_write: true }]));
  await writeFile(`${workspaces}.validation-profiles.json`, JSON.stringify({ version: 1, profiles: [{ workspace_id: "demo", preparation: [], validation: [{ name: "actual content assertion", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('README.md','utf8'),'new\\n')"] }], default_step_timeout_seconds: 10, total_timeout_seconds: 20 }] }));
  const config = join(parent, "pro.json");
  await writeFile(config, JSON.stringify({ version: 1, reader: { version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["README.md"] }] }, bridge: { entry, workspaces_config: workspaces, workspace_ids: ["demo"], allow_workers: false } }));
  let client = new Client({ name: "pro-real-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/project-reader/pro.js")], env: { CONTINUITY_PRO_CONFIG: config }, stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 12);
  assert.equal(tools.some(x => /commit|configure|codex|run_task/.test(x.name)), false);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as { text: string }[])[0]!.text;
    const envelope = JSON.parse(text);
    return { error: response.isError === true, data: envelope.data ?? envelope };
  };
  assert.equal((await call("continuity_pro_status")).data.codex_routing, "disabled");
  assert.equal((await call("continuity_project_status", { project_id: "demo" })).data.head, head);
  assert.equal((await call("continuity_worker_start", { workspace_id: "demo", kind: "analysis", instruction: "test" })).error, true);
  const diff = (value: string) => `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+${value}\n`;
  assert.equal((await call("continuity_patch_submit", { workspace_id: "demo", base_head: "0".repeat(40), diff: diff("new") })).error, true);
  const validate = async (patch: string) => {
    const started = await call("continuity_patch_validate", { patch_task_id: patch });
    assert.equal(started.error, false);
    for (let i = 0; i < 200; i++) {
      const result = await call("continuity_task_result", { task_id: started.data.task_id });
      if (result.data.ready) return result.data.report;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("validation did not finish");
  };
  const bad = await call("continuity_patch_submit", { workspace_id: "demo", base_head: head, diff: diff("bad") });
  assert.equal(bad.error, false);
  assert.equal((await validate(bad.data.task_id)).status, "FAIL");
  assert.equal((await call("continuity_patch_apply", { patch_task_id: bad.data.task_id, confirmation: "APPLY" })).error, true);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "old\n");
  const good = await call("continuity_patch_submit", { workspace_id: "demo", base_head: head, diff: diff("new") });
  assert.equal(good.error, false);
  const report = await validate(good.data.task_id);
  assert.equal(report.status, "PASS", JSON.stringify(report));
  await client.close();
  // Wait for the old server to finish closing its Bridge child and release its lease.
  for (let i = 0; i < 100; i++) {
    try { await access(`${workspaces}.pro-state.json.lock`); }
    catch { break; }
    await new Promise(r => setTimeout(r, 30));
  }
  client = new Client({ name: "pro-restart-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/project-reader/pro.js")], env: { CONTINUITY_PRO_CONFIG: config }, stderr: "pipe" }));
  const restored = await call("continuity_pro_status");
  assert.ok(restored.data.retained_patch_tasks.includes(good.data.task_id));
  assert.equal((await call("continuity_task_result", { task_id: good.data.task_id })).error, false);
  assert.equal((await call("continuity_patch_apply", { patch_task_id: good.data.task_id, confirmation: "APPLY" })).error, true, "restart must not reuse earlier PASS");
  assert.equal((await validate(good.data.task_id)).status, "PASS");
  const apply = await call("continuity_patch_apply", { patch_task_id: good.data.task_id, confirmation: "APPLY" });
  assert.equal(apply.error, false);
  assert.equal(apply.data.applied, true);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "new\n");
  const reread = await call("continuity_project_read", { project_id: "demo", path: "README.md" });
  assert.equal(reread.data.data.lines[0], "new");
  assert.equal(await git(["rev-parse", "HEAD"]), head, "must never commit");
  const replay = await call("continuity_patch_apply", { patch_task_id: good.data.task_id, confirmation: "APPLY" });
  assert.equal(replay.error, false);
  assert.equal(replay.data.previously_applied, true);
  assert.equal(replay.data.current_files_verified, false);
});
