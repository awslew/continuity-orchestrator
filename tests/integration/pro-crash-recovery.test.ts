import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** A real MCP session over stdio, so the server is a separate process that can be killed. */
async function session(t: test.TestContext, config: string) {
  const client = new Client({ name: "pro-crash-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/project-reader/pro.js")], env: { ...process.env, CONTINUITY_PRO_CONFIG: config }, stderr: "pipe" });
  await client.connect(transport);
  t.after(() => client.close().catch(() => undefined));
  return { client, pid: transport.pid!, transport };
}
/** One MCP round, with the round's own validation deliberately slow enough that the kill
 * below lands while it is still running. */
test("a killed server leaves a finished round and a fresh server can start and read it", { timeout: 240000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pro-crash-"));
  const project = join(parent, "project"), state = join(parent, "state"), local = join(parent, "local");
  await mkdir(project);
  await writeFile(join(project, "app.txt"), "original\n");
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "crash-fixture", type: "module", scripts: { test: "node --test" } }));
  const config = join(parent, "pro.json");
  await writeFile(config, JSON.stringify({ version: 1,
    reader: { version: 1, projects: [{ id: "crash", name: "Crash", root: project, share: ["."] }] },
    editor: { state_dir: state, workspaces: [{ project_id: "crash", writable_paths: ["."],
      validation: [{ name: "noop", argv: [process.execPath, "-e", "process.exit(0)"], timeout_seconds: 20 }] }] },
    development: { default_project: "crash", auto_apply: true },
    // Both fields are required, and the schema is strict: without them the server exits at
    // startup and the failure looks like a client-side hang instead of a config error.
    local_access: { state_dir: local, user_specified_projects: true } }));
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const envelope = JSON.parse((response.content as { text: string }[])[0]!.text);
    if (response.isError) throw new Error(`${name}: ${JSON.stringify(envelope)}`);
    return envelope.data ?? envelope;
  };

  const first = await session(t, config);
  const before = await call(first.client, "continuity_local_read", { project_path: project, action: "read", path: "app.txt" }) as any;
  assert.equal(before.sha256, sha("original\n"));
  const started = await call(first.client, "continuity_local_develop", { project_path: project, request_id: "crash-1",
    goal: "A round must outlive the process that accepted it",
    changes: [{ path: "app.txt", expected_sha256: before.sha256, content: "rewritten by the worker\n" }],
    validation: [{ name: "project tests in the candidate copy", argv: [process.execPath, "--test"], timeout_seconds: 60 }] }) as any;
  // Acceptance returns as soon as the round is published, not when it finishes.
  assert.equal(started.state, "validating");
  assert.equal(started.ready, false);

  // SIGKILL the server: no shutdown path runs, so its crash lease stays on disk.
  first.transport.onerror = () => undefined;
  first.transport.onclose = () => undefined;
  first.client.onerror = () => undefined;
  first.client.onclose = () => undefined;
  process.kill(first.pid, "SIGKILL");
  await new Promise(r => setTimeout(r, 500));
  const lease = join(state, "instance.lock", "owner.json");
  assert.equal(JSON.parse(await readFile(lease, "utf8")).pid, first.pid, "the killed owner must still hold its lease");

  // A fresh server must come up against that dead lease rather than refusing to serve.
  const second = await session(t, config);
  let settled: any;
  for (let i = 0; i < 80; i++) {
    settled = await call(second.client, "continuity_local_result", { project_path: project, task_id: started.task_id });
    if (settled.ready) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(settled.state, "applied", JSON.stringify(settled));
  assert.equal(settled.applied, true);
  assert.equal(settled.worker.status, "done");
  assert.equal(settled.reports[0].exit_code, 0);
  assert.equal(await readFile(join(project, "app.txt"), "utf8"), "rewritten by the worker\n");
  // The dead lease is superseded, not deleted: it stays as evidence of the crash.
  const leases = await readdir(state);
  assert.ok(leases.some(name => name.startsWith("instance.lock.stale.")), `expected a stale lease, saw ${leases.join(",")}`);
  assert.equal(JSON.parse(await readFile(lease, "utf8")).pid, second.pid);
  await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
