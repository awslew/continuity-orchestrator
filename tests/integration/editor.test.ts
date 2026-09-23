import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEditor, validationEnvironment } from "../../src/project-reader/editor.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
test("validation excludes model credentials, Tunnel credentials and Node injection options", () => {
  const env = validationEnvironment({ PATH: "tools", TEMP: "temp", CONTROL_PLANE_API_KEY: "not-forwarded", DEEPSEEK_API_KEY: "not-forwarded", OPENAI_API_KEY: "not-forwarded", NODE_OPTIONS: "--require malicious.js" });
  assert.deepEqual(env, { PATH: "tools", TEMP: "temp", CI: "true" });
});
async function fixture(t: test.TestContext, code = "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'good\\n')", timeout = 10, spawn: "inline" | "process" = "inline") {
  const parent = await mkdtemp(join(tmpdir(), "pro-editor-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root); await writeFile(join(root, "a.txt"), "user draft\n"); await writeFile(join(root, "b.txt"), "keep me\n");
  const reader = { version: 1 as const, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] };
  const config = { state_dir: state, workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [{ name: "actual source assertion", argv: [process.execPath, "-e", code], timeout_seconds: timeout }] }] };
  const options = { recoverDeadOwner: true, spawn };
  let editor = await ProjectEditor.create(config, reader, options);
  t.after(async () => { await editor.close(); await rm(parent, { recursive: true, force: true }); });
  return { root, state, config, reader, get editor() { return editor; }, async restart() { await editor.close(); editor = await ProjectEditor.create(config, reader, options); } };
}
async function validate(editor: ProjectEditor, id: string) {
  await editor.validate(id);
  for (let i = 0; i < 300; i++) {
    const r = await editor.result(id); if (r.ready) return r;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Editor validation timed out");
}
test("non-Git source: real FAIL blocks writes, PASS preserves drafts, second edit and restart work", async t => {
  const f = await fixture(t);
  const bad = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "wrong\n" }]);
  assert.equal((await validate(f.editor, bad.task_id)).state, "fail");
  await assert.rejects(f.editor.apply(bad.task_id), /Validate/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user draft\n");
  const good = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  assert.equal((await validate(f.editor, good.task_id)).state, "pass");
  await f.restart();
  assert.equal((await f.editor.result(good.task_id)).validation_current_session, false);
  await assert.rejects(f.editor.apply(good.task_id), /Validate/);
  assert.equal((await validate(f.editor, good.task_id)).state, "pass");
  assert.equal((await f.editor.apply(good.task_id)).applied, true);
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "keep me\n");
  // No commit or clean baseline is needed for subsequent edits, additions or deletion.
  const second = await f.editor.propose("demo", [
    { path: "b.txt", expected_sha256: sha("keep me\n"), content: "user requested second edit\n" },
    { path: "nested/new.txt", expected_sha256: null, content: "new file\n" }
  ]);
  assert.equal((await validate(f.editor, second.task_id)).state, "pass");
  await f.editor.apply(second.task_id);
  assert.equal(await readFile(join(f.root, "nested/new.txt"), "utf8"), "new file\n");
  const deletion = await f.editor.propose("demo", [{ path: "nested/new.txt", expected_sha256: sha("new file\n"), content: null }]);
  assert.equal((await validate(f.editor, deletion.task_id)).state, "pass");
  await f.editor.apply(deletion.task_id);
  await assert.rejects(readFile(join(f.root, "nested/new.txt")), { code: "ENOENT" });
  await f.restart();
  const replay = await f.editor.apply(good.task_id);
  assert.ok("previously_applied" in replay && replay.previously_applied);
  assert.equal((await f.editor.result(good.task_id)).current_files_verified, false);
});

test("source fingerprints reject concurrent changes even outside the proposal", async t => {
  const f = await fixture(t);
  await assert.rejects(f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("old"), content: "good\n" }]), /Read current/);
  const p = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  assert.equal((await validate(f.editor, p.task_id)).state, "pass");
  await writeFile(join(f.root, "b.txt"), "external edit\n");
  await assert.rejects(f.editor.apply(p.task_id), /Project changed/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user draft\n");
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "external edit\n");
  assert.equal((await validate(f.editor, p.task_id)).error, "FILE_CHANGED");
});

test("real dirty Git workspace preserves the user's unstaged change and HEAD", async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile), f = await fixture(t);
  const git = async (args: string[]) => (await exec("git", ["-C", f.root, ...args], { windowsHide: true })).stdout.trim();
  await git(["init"]);
  await git(["-c", "core.autocrlf=false", "add", "a.txt", "b.txt"]);
  await git(["-c", "user.name=Editor Test", "-c", "user.email=editor-test@example.invalid", "commit", "-m", "fixture baseline"]);
  const head = await git(["rev-parse", "HEAD"]);
  await writeFile(join(f.root, "b.txt"), "uncommitted user notes\n");
  const p = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  assert.equal((await validate(f.editor, p.task_id)).state, "pass");
  await f.editor.apply(p.task_id);
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "uncommitted user notes\n");
  assert.equal(await git(["rev-parse", "HEAD"]), head);
  assert.match(await git(["diff", "--name-only"]), /a.txt/);
  assert.match(await git(["diff", "--name-only"]), /b.txt/);
  assert.equal(await git(["diff", "--cached", "--name-only"]), "");
});

test("multi-file apply rolls back its writes without overwriting a concurrent external edit", async t => {
  const f = await fixture(t);
  const p = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }, { path: "b.txt", expected_sha256: sha("keep me\n"), content: "second\n" }]);
  assert.equal((await validate(f.editor, p.task_id)).state, "pass");
  // Fault injection performs a real external file edit between the two writes.
  const internal = f.editor as unknown as { replace: (project: unknown, path: string, before: string | null, after: string | null) => Promise<void> };
  const original = internal.replace.bind(f.editor);
  internal.replace = async (project, path, before, after) => {
    if (path === "b.txt") await writeFile(join(f.root, "b.txt"), "external concurrent edit\n");
    return original(project, path, before, after);
  };
  await assert.rejects(f.editor.apply(p.task_id), /changed/);
  assert.equal((await f.editor.result(p.task_id)).error, "APPLY_FAILED_ROLLED_BACK");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user draft\n");
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "external concurrent edit\n");
});

test("write scope, traversal, hidden files, hard links and duplicate paths fail closed", async t => {
  const f = await fixture(t);
  for (const path of ["../outside.txt", "a.txt:stream", ".env", "node_modules/x.js", "NUL.txt"]) {
    await assert.rejects(f.editor.propose("demo", [{ path, expected_sha256: null, content: "no" }]));
  }
  await assert.rejects(f.editor.propose("demo", [
    { path: "a.txt", expected_sha256: sha("user draft\n"), content: "one" },
    { path: "A.txt", expected_sha256: sha("user draft\n"), content: "two" }
  ]), /only once/);
  await link(join(f.root, "a.txt"), join(f.root, "linked.txt"));
  await assert.rejects(f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]), /Links/);
});

test("junctions in shared source cannot escape snapshot scope", async t => {
  const f = await fixture(t), outside = join(f.state, "outside");
  await mkdir(outside); await writeFile(join(outside, "secret.txt"), "private");
  await symlink(outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  // The write scope check and the snapshot both refuse the junction: it never
  // becomes an editable source file and never reaches the validation copy.
  await assert.rejects(f.editor.propose("demo", [{ path: "linked/secret.txt", expected_sha256: sha("private"), content: "no" }]), /shared source files|link/i);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
  // A junction inside the shared tree is recorded as an omission and is never
  // traversed, so the validation copy cannot contain the linked target.
  const linked = await fixture(t);
  const target = join(linked.state, "outside");
  await mkdir(target, { recursive: true }); await writeFile(join(target, "secret.txt"), "private");
  await symlink(target, join(linked.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(linked.editor.propose("demo", [{ path: "linked/secret.txt", expected_sha256: sha("private"), content: "no" }]), /shared source files/);
  const round = await linked.editor.develop("demo", "junction-scope", "Develop next to a junction", [
    { path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }
  ]);
  let result: any;
  for (let index = 0; index < 300; index++) { result = await linked.editor.result(round.task_id); if (result.ready) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(result.snapshot_omissions.some((o: any) => o.path === "linked" && o.reason === "LINK"), true, JSON.stringify(result.snapshot_omissions));
  assert.equal(result.state, "applied", JSON.stringify(result.reports));
  assert.equal(await readFile(join(linked.root, "a.txt"), "utf8"), "good\n", "an unrelated real edit still applies");
  assert.equal(await readFile(join(target, "secret.txt"), "utf8"), "private");
});

test("tests cannot obtain PASS by changing candidate source; timeout and cancellation never pass", async t => {
  const f = await fixture(t, "require('node:fs').writeFileSync('a.txt','tampered')");
  const p = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  assert.equal((await validate(f.editor, p.task_id)).error, "VALIDATION_CHANGED_SOURCE");
  await assert.rejects(f.editor.apply(p.task_id), /Validate/);
  const slow = await fixture(t, "setInterval(()=>{},1000)", 1);
  const q = await slow.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  const timeout = await validate(slow.editor, q.task_id);
  assert.equal(timeout.state, "fail"); assert.equal(timeout.reports[0]?.timed_out, true);
  await slow.editor.validate(q.task_id);
  const cancelled = await slow.editor.cancel(q.task_id);
  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(slow.editor.apply(q.task_id), /Validate/);
});

test("same-state instance lock and interrupted apply recovery fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(ProjectEditor.create(f.config, f.reader), /active or has a crash lock/);
  const p = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  const file = join(f.state, "tasks.json"), retained = JSON.parse(await readFile(file, "utf8"));
  retained.tasks[0].state = "applying";
  await writeFile(file, JSON.stringify(retained));
  await f.restart();
  assert.equal((await f.editor.result(p.task_id)).state, "recovery_required");
  await assert.rejects(f.editor.propose("demo", [{ path: "b.txt", expected_sha256: sha("keep me\n"), content: "no" }]), /interrupted/);
  // Model a crash after the first actual write; local recovery verifies hashes.
  await writeFile(join(f.root, "a.txt"), "good\n");
  assert.equal((await f.editor.inspectRecovery(p.task_id)).files[0]?.matches_proposal, true);
  await f.editor.recoverApply(p.task_id);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user draft\n");
  assert.equal((await f.editor.result(p.task_id)).error, "INTERRUPTED_APPLY_ROLLED_BACK");
});

test("a killed worker's record is retired rather than reported as running for ever", async t => {
  const { digest } = await import("../../src/project-reader/checkpoint.js");
  const { spawn } = await import("node:child_process");
  const f = await fixture(t);
  const goal = "survive a tree kill";
  const changes = [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }];
  const requestHash = digest({ projectId: "demo", goal, changes });
  const p = await f.editor.propose("demo", changes);
  const file = join(f.state, "tasks.json"), record = join(f.state, `runner-${p.task_id}.json`);
  // A finished worker is left alone by every recovery pass below; it is here to prove the
  // passes are selective rather than rewriting whatever they find.
  const done = await f.editor.propose("demo", [{ path: "b.txt", expected_sha256: sha("keep me\n"), content: "second\n" }]);
  const doneFile = join(f.state, `runner-${done.task_id}.json`);
  /** A REAL dead pid: what a tree kill leaves in the record. Recycling cannot fake this. */
  const deadPid = await new Promise<number>(resolve => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid ?? 1));
  });
  /** Publish a round into the state a killed worker leaves it in. */
  const publishValidating = async () => {
    const store = JSON.parse(await readFile(file, "utf8"));
    const task = store.tasks.find((x: { id: string }) => x.id === p.task_id);
    task.state = "validating";
    task.development = { request_id: "stale-round", request_hash: requestHash, goal, checkpoint: null };
    await writeFile(file, JSON.stringify(store));
  };
  /** The record a `taskkill /T /F` leaves behind: the whole tree is down, so nothing will
   * ever rewrite it, and it names a pid that is now free. */
  const killedRecord = (deadlineMs: number, pid = deadPid) => ({
    version: 1, task_id: p.task_id, request_id: "stale-round", job: "job-stale", action: "develop",
    pid, log: join(f.state, "worker-jobs", "job-stale.log"), started_at: new Date(Date.now() - 3600_000).toISOString(),
    phase: "validating", status: "running", finished_at: null, error: null,
    deadline_at: new Date(Date.now() + deadlineMs).toISOString()
  });
  await writeFile(doneFile, JSON.stringify({
    version: 1, task_id: done.task_id, request_id: null, job: "job-done", action: "develop", pid: process.pid,
    log: join(f.state, "worker-jobs", "job-done.log"), started_at: new Date().toISOString(), phase: "finished",
    status: "done", finished_at: new Date().toISOString(), error: null
  }));

  // A record whose process is still alive is a round that is still running, whatever its
  // deadline says: it must not be touched.
  await publishValidating();
  await writeFile(record, JSON.stringify(killedRecord(120_000, process.pid)));
  await f.restart();
  const live = await f.editor.result(p.task_id);
  assert.equal(live.state, "validating");
  assert.equal(live.ready, false);
  assert.equal(live.worker?.running, true);
  assert.equal(live.worker?.over, false);

  // The same round with the worker actually killed: retired on the spot, so the caller is
  // told the interruption instead of polling a round that can never move again.
  await publishValidating();
  await writeFile(record, JSON.stringify(killedRecord(120_000)));
  await f.restart();
  const retired = await f.editor.result(p.task_id);
  assert.equal(retired.state, "cancelled");
  assert.equal(retired.ready, true);
  assert.equal(retired.worker?.status, "running", "the record itself is kept as evidence");
  assert.equal(retired.worker?.running, false);
  assert.equal(retired.worker?.over, true);
  assert.match(retired.error ?? "", /pid .* is gone/);
  assert.equal((await f.editor.result(done.task_id)).state, "proposed", "an unrelated finished round is untouched");

  // Production keeps ONE editor for the life of the tunnel, so recovery at editor creation
  // is not enough: a round killed AFTER that point must still be resolved. Nothing is
  // reopened below on purpose — this editor was opened before the record was written, which
  // is exactly the production shape.
  await publishValidating();
  await writeFile(record, JSON.stringify(killedRecord(120_000)));
  assert.equal((await f.editor.result(p.task_id)).state, "validating", "a bare read resolves nothing");
  const waited = await f.editor.awaited(p.task_id, 1);
  assert.equal(waited.state, "cancelled");
  assert.equal(waited.ready, true);
  assert.equal(waited.wait_timed_out, false);
  // And the request may then be resubmitted, which is what a caller does after being told
  // the round was interrupted: before this change the dead round answered
  // `duplicate_request` for ever, so the work could never be run again at all.
  await publishValidating();
  const resent = await f.editor.develop("demo", "stale-round-2", goal, changes);
  assert.equal(resent.state, "validating");
  assert.ok(!("duplicate_request" in resent));
});

test("actual stdio MCP exposes and executes the configured continuous editor", async t => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { resolve } = await import("node:path");
  const f = await fixture(t);
  await f.editor.close();
  const config = join(f.state, "pro.json");
  await writeFile(config, JSON.stringify({ version: 1, reader: f.reader, editor: f.config }));
  const client = new Client({ name: "editor-real-mcp", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/src/project-reader/pro.js")], env: { CONTINUITY_PRO_CONFIG: config }, stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 17);
  assert.equal(tools.find(t => t.name === "continuity_edit_apply")?.annotations?.readOnlyHint, false);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const body = JSON.parse((r.content as { text: string }[])[0]!.text);
    assert.equal(r.isError, false, JSON.stringify(body));
    return body.data;
  };
  const status = await call("continuity_pro_status", {});
  assert.equal(status.codex_routing, "disabled");
  assert.equal(status.continuous_editor.projects[0].project_id, "demo");
  const read = await call("continuity_project_read", { project_id: "demo", path: "a.txt" });
  const p = await call("continuity_edit_propose", { project_id: "demo", changes: [{ path: "a.txt", expected_sha256: read.data.sha256, content: "good\n" }] });
  await call("continuity_edit_validate", { task_id: p.task_id });
  let state;
  for (let i = 0; i < 200; i++) { state = await call("continuity_edit_result", { task_id: p.task_id }); if (state.ready) break; await new Promise(r => setTimeout(r, 25)); }
  assert.equal(state.state, "pass");
  assert.equal((await call("continuity_edit_apply", { task_id: p.task_id, confirmation: "APPLY" })).applied, true);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "good\n");
  await client.close();
  for (let i = 0; i < 100; i++) { try { await readFile(join(f.state, "instance.lock/owner.json")); } catch { return; } await new Promise(r => setTimeout(r, 25)); }
  assert.fail("stdio shutdown did not release editor instance lease");
});

test("the hash convention the tool description promises is the one actually enforced", async t => {
  // A validation that always passes: this test is about the hash convention, not about
  // whether the fixture's source assertion holds.
  const f = await fixture(t, "process.exit(0)");
  // A null hash creates a file that does not exist yet. This is the half of the convention
  // the description used to leave out, which pushed callers into guessing or into being told
  // by hand.
  const created = await f.editor.propose("demo", [{ path: "generated/new.txt", expected_sha256: null, content: "made\n" }]);
  assert.equal((await validate(f.editor, created.task_id)).state, "pass");
  await f.editor.apply(created.task_id);
  assert.equal(await readFile(join(f.root, "generated/new.txt"), "utf8"), "made\n");
  // The same null hash against a file that now exists is refused, so a caller can never
  // silently clobber a file by guessing that null means "whatever is there".
  await assert.rejects(f.editor.propose("demo", [{ path: "generated/new.txt", expected_sha256: null, content: "clobbered\n" }]), /Read current file/);
  assert.equal(await readFile(join(f.root, "generated/new.txt"), "utf8"), "made\n");
  // A real hash replaces, and a null content deletes.
  const replaced = await f.editor.propose("demo", [{ path: "generated/new.txt", expected_sha256: sha("made\n"), content: "replaced\n" }]);
  assert.equal((await validate(f.editor, replaced.task_id)).state, "pass");
  await f.editor.apply(replaced.task_id);
  assert.equal(await readFile(join(f.root, "generated/new.txt"), "utf8"), "replaced\n");
  const removed = await f.editor.propose("demo", [{ path: "generated/new.txt", expected_sha256: sha("replaced\n"), content: null }]);
  assert.equal((await validate(f.editor, removed.task_id)).state, "pass");
  await f.editor.apply(removed.task_id);
  await assert.rejects(readFile(join(f.root, "generated/new.txt")), { code: "ENOENT" });
});

test("every answer names the next action, including the wait that expired mid-round", async t => {
  const f = await fixture(t);
  const changes = [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }];
  const p = await f.editor.propose("demo", changes);
  // The long-task shape: the round is still running in another process, so the first wait
  // expires long before the round does. The response itself must say so — this is the call
  // that a caller would otherwise have to be coached through by a human reading a prompt.
  await writeFile(join(f.state, `runner-${p.task_id}.json`), JSON.stringify({
    version: 1, task_id: p.task_id, request_id: null, job: "job-live", action: "develop", pid: process.pid,
    log: join(f.state, "worker-jobs", "job-live.log"), started_at: new Date().toISOString(), phase: "validating",
    status: "running", finished_at: null, error: null, deadline_at: new Date(Date.now() + 600_000).toISOString()
  }));
  const store = JSON.parse(await readFile(join(f.state, "tasks.json"), "utf8"));
  store.tasks.find((x: { id: string }) => x.id === p.task_id).state = "validating";
  await writeFile(join(f.state, "tasks.json"), JSON.stringify(store));
  await f.restart();
  const waited = await f.editor.awaited(p.task_id, 0);
  assert.equal(waited.ready, false, "a live worker still owns the outcome");
  assert.equal(waited.wait_timed_out, true);
  assert.equal(waited.next_tool, "continuity_local_result");
  assert.match(waited.next_hint, /SAME task_id/);
  assert.match(waited.next_hint, /Do not raise the wait/);
  assert.match(waited.next_hint, /do not resend continuity_local_develop/);

  // A settled round answers with what its own state means, not with a generic success: the
  // `fail` branch is the one that has to stop a caller from reusing the dead request_id.
  const bad = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "wrong\n" }]);
  assert.equal((await validate(f.editor, bad.task_id)).state, "fail");
  const failed = await f.editor.awaited(bad.task_id, 0);
  assert.equal(failed.wait_timed_out, false);
  assert.equal(failed.next_tool, "continuity_local_develop");
  assert.match(failed.next_hint, /NEW request_id/);
  assert.match(failed.next_hint, /NOTHING was written/);

  const good = await f.editor.propose("demo", changes);
  assert.equal((await validate(f.editor, good.task_id)).state, "pass");
  await f.editor.apply(good.task_id);
  const applied = await f.editor.awaited(good.task_id, 0);
  assert.equal(applied.state, "applied");
  assert.equal(applied.next_tool, null, "a landed round needs no follow-up call");
  assert.match(applied.next_hint, /Landed and verified/);

  // Cancelling is the escape hatch for a round left stuck by a killed worker, so its answer
  // must also say what to do with it.
  const stuck = await f.editor.propose("demo", [{ path: "b.txt", expected_sha256: sha("keep me\n"), content: "changed\n" }]);
  const cancelled = await f.editor.cancel(stuck.task_id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.next_tool, "continuity_local_develop");
  assert.match(cancelled.next_hint, /request_id is accepted when the request is byte-identical/);
});

test("a refusal says what to do about it, and a finished round says to stop asking", async (t) => {
  const f = await fixture(t, "process.exit(0)");

  // NO_CHANGE is the one refusal a caller hits while following the guidance it was given: a
  // failed round writes nothing, so the file on disk can already hold the very content the
  // repair was about to send. A real client reported exactly that wall — the fail hint said
  // "send it again under a NEW request_id" and the new send earned a bare "Proposal contains
  // no change for a path", which reads as "your call was malformed" when the truth is "there
  // is nothing left to do". The refusal has to name that case.
  const same = await f.editor.develop("demo", "no-change-round", "Rewrite b.txt with what it already says", [
    { path: "b.txt", expected_sha256: sha("keep me\n"), content: "keep me\n" }
  ]).catch((error: Error) => error);
  assert.ok(same instanceof Error, "an edit whose content is what the file already holds is refused");
  assert.match(same.message, /already holds exactly this content/);
  assert.match(same.message, /Drop this path from the round/);
  assert.match(same.message, /what a REPAIR looks like/, "the refusal names the failed-round case that produces it");
  assert.match(same.message, /nothing to send/, "it says the repair may be unnecessary, not just that the call was wrong");

  // And an answer for a round that is over must say so, so a caller following next_hint does
  // not keep polling a task that will never change again.
  const round = await f.editor.develop("demo", "terminal-round", "Replace the placeholder", [
    { path: "b.txt", expected_sha256: sha("keep me\n"), content: "changed\n" }
  ]);
  const applied = await f.editor.awaited(round.task_id, 30);
  assert.equal(applied.state, "applied", "the round finishes before its terminal guidance is read");
  assert.equal(applied.next_tool, null, "null is what tells the caller the round needs no further call");
  assert.match(applied.next_hint, /do not call continuity_local_result for this task again/);
});

test("changing a project's validation profile does not lock the project out", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pro-scope-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root); await writeFile(join(root, "a.txt"), "user draft\n");
  const reader = { version: 1 as const, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] };
  const config = (code: string) => ({ state_dir: state, workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [{ name: "v", argv: [process.execPath, "-e", code], timeout_seconds: 30 }] }] });

  // A round settles under the original profile.
  const first = await ProjectEditor.create(config("0"), reader, { recoverDeadOwner: true, spawn: "inline" });
  const settled = await first.develop("demo", "scope-round", "Rewrite a.txt", [{ path: "a.txt", expected_sha256: sha("user draft\n"), content: "good\n" }]);
  assert.equal((await first.awaited(settled.task_id, 30)).state, "applied", "the retained round settles as applied");
  await first.close();

  // The scope is a hash of the ENTIRE configuration, so editing one validation command changes
  // it. With every retained task settled the archive is history, and the project has to open:
  // refusing here locked a real project out of every tool, and since nothing in the surface
  // reviews or clears a retained task, the caller could not resolve it either.
  const second = await ProjectEditor.create(config("process.exit(0)"), reader, { recoverDeadOwner: true, spawn: "inline" });
  t.after(() => rm(parent, { recursive: true, force: true }));
  assert.equal(second.status().tasks.length, 1, "history survives the configuration change");
  assert.equal(second.status().tasks[0]!.state, "applied");
  await second.close();

  // The guard still holds where it matters: a round whose worker is ALIVE was launched under
  // the old profile and can still write, so its outcome must not be reinterpreted under a new
  // one. Its state is published directly rather than raced against a real worker, because every
  // timing-dependent version of this assertion was flaky.
  const armed = await ProjectEditor.create(config("0"), reader, { recoverDeadOwner: true, spawn: "inline" });
  const pending = await armed.propose("demo", [{ path: "a.txt", expected_sha256: sha("good\n"), content: "bad\n" }]);
  await armed.close();
  const file = join(state, "tasks.json");
  const store = JSON.parse(await readFile(file, "utf8"));
  store.tasks.find((x: { id: string }) => x.id === pending.task_id).state = "validating";
  await writeFile(file, JSON.stringify(store));
  await writeFile(join(state, `runner-${pending.task_id}.json`), JSON.stringify({
    version: 1, task_id: pending.task_id, request_id: null, job: "job-scope", action: "develop", pid: process.pid,
    log: join(state, "worker-jobs", "job-scope.log"), started_at: new Date().toISOString(), phase: "validating",
    status: "running", finished_at: null, error: null, deadline_at: new Date(Date.now() + 120_000).toISOString()
  }));

  // Created shared, exactly as production does, so the scope check answers rather than the lock.
  await assert.rejects(ProjectEditor.create(config("process.exit(0)"), reader, { recoverDeadOwner: false, spawn: "inline", exclusive: false }),
    /may still be changing this project/);
  await assert.rejects(ProjectEditor.create(config("process.exit(0)"), reader, { recoverDeadOwner: false, spawn: "inline", exclusive: false }),
    new RegExp(pending.task_id.slice(0, 8)), "the refusal names the round that is blocking it");
});


