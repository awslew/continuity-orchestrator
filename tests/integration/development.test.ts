import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProSession, createProMcp } from "../../src/project-reader/pro.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const exec = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(t: test.TestContext, command = "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'good\\r\\n')") {
  const parent = await mkdtemp(join(tmpdir(), "pro-development-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root); await writeFile(join(root, "a.txt"), "dirty original\r\n"); await writeFile(join(root, "keep.txt"), "unchanged\n");
  const config = { version: 1, reader: { version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] },
    editor: { state_dir: state, workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [{ name: "real source assertion", argv: [process.execPath, "-e", command], timeout_seconds: 10 }] }] },
    development: { default_project: "demo", auto_apply: true } };
  let session = await ProSession.create(config);
  // Closing first, then deleting: a worker still settling holds handles inside this tree,
  // and on Windows a recursive delete that meets one fails with EBUSY. The retry makes the
  // cleanup as patient as the operating system requires instead of failing the test in its
  // own teardown — that failure says nothing about the behaviour under test.
  t.after(async () => { await session.close(); await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, state, config, get session() { return session; }, async restart() { await session.close(); session = await ProSession.create(config); } };
}
const proposal = (request_id: string, content = "good\r\n") => ({ request_id, goal: "Implement requested local change", changes: [{ path: "a.txt", expected_sha256: hash("dirty original\r\n"), content }] });
async function wait(session: ProSession, task: string): Promise<any> {
  for (let i = 0; i < 1000; i++) {
    const r = await session.call("continuity_edit_result", { task_id: task }) as any;
    if (r.ready) return r;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Development did not complete");
}
test("automatic MCP round: real Git backups, validate/apply, duplicate request, restart and rollback preserve dirty Git", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const git = async (args: string[]) => (await exec("git", ["-C", f.root, ...args], { windowsHide: true })).stdout.trim();
  await git(["init"]); await git(["-c", "core.autocrlf=false", "add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@localhost.invalid", "commit", "-m", "baseline"]);
  await writeFile(join(f.root, "keep.txt"), "user staged change\n"); await git(["add", "keep.txt"]);
  await writeFile(join(f.root, "keep.txt"), "user unstaged change\n");
  const head = await git(["rev-parse", "HEAD"]), index = await git(["diff", "--cached"]);
  const server = createProMcp(f.session), client = new Client({ name: "development-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(t => t.name === "continuity_develop")?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === "continuity_develop_context")?.annotations?.readOnlyHint, true);
  const context = await f.session.call("continuity_develop_context", {}) as any;
  assert.equal(context.project_id, "demo");
  const args = proposal("round-1");
  args.changes.push({ path: "new.txt", expected_sha256: null as any, content: "created\n" });
  const response = await client.callTool({ name: "continuity_develop", arguments: args });
  assert.ok(!response.isError);
  const started = JSON.parse((response.content as any)[0].text).data;
  const duplicate = await f.session.call("continuity_develop", args) as any;
  assert.equal(duplicate.task_id, started.task_id);
  await assert.rejects(f.session.call("continuity_develop", { ...args, goal: "different" }), /identical/);
  const done = await wait(f.session, started.task_id);
  assert.equal(done.applied, true, JSON.stringify(done));
  assert.equal(done.reports[0].exit_code, 0);
  const cp = done.development.checkpoint;
  const originals = JSON.parse((await exec("git", ["-C", cp.repository, "show", `${cp.before_commit}:snapshot.json`], { windowsHide: true })).stdout);
  // Private checkpoints keep a readable copy and the exact bytes of each original.
  assert.equal(originals["a.txt"].text, "dirty original\r\n");
  assert.equal(Buffer.from(originals["a.txt"].bytes, "base64").toString("utf8"), "dirty original\r\n");
  assert.equal(originals["a.txt"].encoding, "utf8");
  assert.equal(originals["new.txt"], null);
  await client.close(); await server.close(); await f.restart();
  assert.equal((await f.session.call("continuity_develop", args) as any).task_id, started.task_id);
  // An undo of a whole round is as big as the round, so it is handed to the same
  // out-of-process executor and its outcome is read like any other round's.
  await f.session.call("continuity_develop_undo", { task_id: started.task_id });
  assert.equal((await wait(f.session, started.task_id)).state, "rolled_back");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "dirty original\r\n");
  await assert.rejects(readFile(join(f.root, "new.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "user unstaged change\n");
  assert.equal(await git(["rev-parse", "HEAD"]), head); assert.equal(await git(["diff", "--cached"]), index);
  const log = (await readFile(join(f.state, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const event of ["tool_call", "validation_finished", "apply_intent", "applied", "rollback_intent", "rolled_back"]) assert.ok(log.some(l => l.event === event), event);
});
test("failed validation never auto-applies; rollback refuses newer edits", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const bad = await f.session.call("continuity_develop", proposal("bad", "wrong")) as any;
  assert.equal((await wait(f.session, bad.task_id)).state, "fail");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "dirty original\r\n");
  const good = await f.session.call("continuity_develop", proposal("good")) as any;
  assert.equal((await wait(f.session, good.task_id)).state, "applied");
  await writeFile(join(f.root, "a.txt"), "newer external edit");
  await assert.rejects(f.session.call("continuity_develop_undo", { task_id: good.task_id }), /newer edits/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "newer external edit");
});
test("a round keeps running when the process that accepted it is replaced", { timeout: 60000 }, async t => {
  // Deliberately slow validation, so the restart below lands while the round is mid-flight.
  const f = await fixture(t, "setTimeout(()=>{},3000)");
  const started = await f.session.call("continuity_develop", proposal("survive-restart")) as any;
  // Replacing the session is what a plugin reload or an MCP crash does to the accepting
  // process. The round is executed by its own worker, so it is expected to finish rather
  // than be cancelled — and the fresh session must be able to read it from disk.
  await f.restart();
  const result = await wait(f.session, started.task_id);
  assert.equal(result.state, "applied", JSON.stringify(result.reports));
  assert.equal(result.applied, true);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "good\r\n");
});
