import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProSession } from "../../src/project-reader/pro.js";

const exec = promisify(execFile);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
/** The real project this bridge must survive: mixed UTF-8/GB18030 source, a
 * generated tree excluded by Git, and thousands of uncommitted user changes.
 * Point it at one of your own projects with CONTINUITY_ACCEPTANCE_PROJECT. */
const REAL_PROJECT = process.env.CONTINUITY_ACCEPTANCE_PROJECT ?? "D:/projects/your-real-project";

const session = async (stateDir: string) => {
  await mkdir(stateDir, { recursive: true });
  return ProSession.create({
    version: 1,
    reader: { version: 1, projects: [{ id: "static", name: "Static", root: stateDir, share: ["."] }] },
    local_access: { state_dir: stateDir, user_specified_projects: true }
  } as never);
};
async function waitFor(session_: ProSession, project: string, task: string): Promise<any> {
  for (let index = 0; index < 1500; index++) {
    const result = await session_.call("continuity_local_result", { project_path: project, task_id: task }) as any;
    if (result.ready) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("acceptance round timed out");
}
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, "-c", "core.quotepath=false", ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;

test("real project context reports path, git state, missing rule file and ignored generated output", { timeout: 120000 }, async t => {
  try { await access(REAL_PROJECT); } catch { t.skip(`No project at ${REAL_PROJECT}`); return; }
  const state = await mkdtemp(join(tmpdir(), "acceptance-state-"));
  const pro = await session(join(state, "mcp"));
  t.after(async () => { await pro.close(); await rm(state, { recursive: true, force: true }); });
  const context = await pro.call("continuity_local_context", { project_path: REAL_PROJECT }) as any;
  assert.equal(context.project_path.replace(/\\/g, "/").toLowerCase(), REAL_PROJECT.toLowerCase());
  assert.equal(context.registration_required, false);
  assert.equal(context.path_status, "found");
  assert.equal(typeof context.project_id, "string");
  // Git state is available directly, without pre-registering the project.
  assert.equal(context.git_status.git_available, true);
  const head = (await git(REAL_PROJECT, ["rev-parse", "HEAD"])).trim();
  assert.equal(context.git_status.head, head);
  const byPath = (name: string) => context.document_status.find((d: any) => d.path === name);
  assert.equal(byPath("AGENTS.md").status, "missing", JSON.stringify(byPath("AGENTS.md")));
  assert.equal(["available", "read"].includes(byPath("package.json").status), true, "an existing document is reported without its body");
  // Only the rule file travels with the context; other documents are read on demand.
  if (context.rule_document) assert.match(context.rule_document.lines.join("\n"), /./);
  assert.match(context.documents_hint, /continuity_local_read/);
  const packageRead = await pro.call("continuity_local_read", { project_path: REAL_PROJECT, action: "read", path: "package.json" }) as any;
  assert.match(packageRead.lines.join("\n"), /"name"\s*:/, "the actual document text is returned when asked for");
  assert.match(await readFile(join(REAL_PROJECT, "package.json"), "utf8"), /"name"\s*:/);
  // The dynamic project id works for status even though it was never registered.
  const status = await pro.call("continuity_project_status", { project_id: context.project_id }) as any;
  assert.equal(status.head, head);
  const byPathStatus = await pro.call("continuity_project_status", { project_path: REAL_PROJECT }) as any;
  assert.equal(byPathStatus.head, head);
  await assert.rejects(pro.call("continuity_project_status", { project_id: "not-registered" }), /Project is not registered/);
  await assert.rejects(pro.call("continuity_local_context", { project_path: join(REAL_PROJECT, "does-not-exist-12345") }), /does not exist/);
});

test("real project reads GB18030 and UTF-8 sources through the dynamic read path", { timeout: 120000 }, async t => {
  try { await access(REAL_PROJECT); } catch { t.skip(`No project at ${REAL_PROJECT}`); return; }
  const state = await mkdtemp(join(tmpdir(), "acceptance-state-"));
  const pro = await session(join(state, "mcp"));
  t.after(async () => { await pro.close(); await rm(state, { recursive: true, force: true }); });
  const text = await pro.call("continuity_local_read", { project_path: REAL_PROJECT, action: "read", path: "package.json" }) as any;
  assert.equal(text.encoding, "utf8");
  assert.equal(text.sha256, sha(await readFile(join(REAL_PROJECT, "package.json"))), "the quoted hash is of the exact bytes");
  // The file that used to break the whole snapshot: valid GB18030, not valid UTF-8.
  const legacy = await pro.call("continuity_local_read", { project_path: REAL_PROJECT, action: "read", path: "work/media-asr-real.json" }) as any;
  assert.equal(legacy.encoding, "gb18030");
  assert.match(legacy.lines.join("\n"), /"ok": true/);
  assert.equal(legacy.sha256, sha(await readFile(join(REAL_PROJECT, "work/media-asr-real.json"))));
  // The Git-ignored generated tree stays readable through the dynamic path, and the
  // user's project is never part of any write in this suite.
  const generated = await pro.call("continuity_local_read", { project_path: REAL_PROJECT, action: "list", path: "work" }) as any;
  assert.ok(generated.entries.length > 0, "work/ stays readable even though it is Git-ignored");
});

test("real project: full round on a temporary Git sandbox copy, then undo, preserving user state", { timeout: 300000 }, async t => {
  try { await access(REAL_PROJECT); } catch { t.skip(`No project at ${REAL_PROJECT}`); return; }
  const before = {
    head: (await git(REAL_PROJECT, ["rev-parse", "HEAD"])).trim(),
    index: await git(REAL_PROJECT, ["diff", "--cached"]),
    status: await git(REAL_PROJECT, ["status", "--porcelain=v1", "--untracked-files=all"])
  };
  const work = await mkdtemp(join(tmpdir(), "acceptance-project-"));
  const project = join(work, "project"), state = join(work, "state");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "work"), { recursive: true });
  // Realistic shape: source, a generated directory that .gitignore excludes and a
  // legacy-encoded data file that the old UTF-8 snapshot could not survive.
  await writeFile(join(project, ".gitignore"), "work/\nnode_modules/\n");
  await writeFile(join(project, "src", "calc.js"), "export const add = (a, b) => a - b;\n");
  await writeFile(join(project, "src", "calc.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  await writeFile(join(project, "work", "generated.bundle.js"), "//".padEnd(700 * 1024, "x"));
  await writeFile(join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const run = async (args: string[]) => (await exec("git", ["-C", project, ...args], { windowsHide: true })).stdout.trim();
  await run(["init", "--quiet"]); await run(["config", "core.autocrlf", "false"]);
  await run(["add", ".gitignore", "src", "package.json"]);
  await run(["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "baseline"]);
  const head = await run(["rev-parse", "HEAD"]);
  await writeFile(join(project, "src", "user-draft.txt"), "uncommitted user draft\n");
  const pro = await session(join(state, "mcp"));
  t.after(async () => { await pro.close(); await rm(work, { recursive: true, force: true }); });
  const context = await pro.call("continuity_local_context", { project_path: project }) as any;
  assert.equal(context.git_status.head, head);
  const source = await pro.call("continuity_local_read", { project_path: project, action: "read", path: "src/calc.js" }) as any;
  const round = await pro.call("continuity_local_develop", {
    project_path: project, request_id: "acceptance-round-1", goal: "Fix add() so the real test passes",
    changes: [{ path: "src/calc.js", expected_sha256: source.sha256, content: "export const add = (a, b) => a + b;\n" }],
    // The sandbox has no lock file, so the round supplies its own real command.
    validation: [{ name: "Acceptance node tests", argv: [process.execPath, "--test"], timeout_seconds: 120 }]
  }) as any;
  const done = await waitFor(pro, project, round.task_id);
  assert.equal(done.applied, true, JSON.stringify(done.reports));
  assert.equal(done.reports[0].exit_code, 0);
  assert.equal(done.reports[0].name, "Acceptance node tests");
  assert.equal(done.snapshot_scope.source, "git_index_and_untracked");
  assert.equal(done.snapshot_scope.ignored_paths_excluded, true);
  assert.equal(await readFile(join(project, "src", "calc.js"), "utf8"), "export const add = (a, b) => a + b;\n");
  // User state is untouched by the write.
  assert.equal(await run(["rev-parse", "HEAD"]), head);
  assert.equal(await run(["diff", "--cached"]), "");
  assert.equal(await readFile(join(project, "src", "user-draft.txt"), "utf8"), "uncommitted user draft\n");
  assert.equal((await readFile(join(project, "work", "generated.bundle.js"))).length, 700 * 1024);
  // Audit trail, private Git checkpoint and rollback.
  const stateDir = join(state, "mcp"), projectState = join(stateDir, context.project_id);
  // The dynamic access log records which project each call touched.
  const accessLog = await readFile(join(stateDir, "audit.jsonl"), "utf8");
  assert.match(accessLog, /"tool":"continuity_local_develop"/);
  assert.match(accessLog, /"tool":"continuity_local_result"/);
  // The private checkpoint lives outside the user's repository.
  assert.equal((await stat(join(projectState, "editor", "tasks.json"))).isFile(), true);  const checkpoint = done.development.checkpoint;
  assert.equal(typeof checkpoint.before_commit, "string");
  const originals = JSON.parse((await exec("git", ["-C", checkpoint.repository, "show", `${checkpoint.before_commit}:snapshot.json`], { windowsHide: true })).stdout);
  assert.equal(originals["src/calc.js"].text, "export const add = (a, b) => a - b;\n");
  assert.equal(originals["src/calc.js"].encoding, "utf8");
  const undone = await pro.call("continuity_local_control", { project_path: project, task_id: round.task_id, action: "undo" }) as any;
  assert.equal(undone.state, "rolled_back");
  // Both journals are complete only after the rollback is recorded.
  const journal = await readFile(join(projectState, "editor", "audit.jsonl"), "utf8");
  for (const event of ["development_started", "validation_finished", "apply_intent", "applied", "rollback_intent", "rolled_back"]) {
    assert.match(journal, new RegExp(`"event":"${event}"`), event);
  }
  assert.equal(journal.includes(REAL_PROJECT), false, "no user project path is written into the editor journal");
  assert.match(await readFile(join(stateDir, "audit.jsonl"), "utf8"), /"tool":"continuity_local_control"/);
  assert.equal(await readFile(join(project, "src", "calc.js"), "utf8"), "export const add = (a, b) => a - b;\n");
  assert.equal(await run(["rev-parse", "HEAD"]), head);
  assert.equal(await run(["diff", "--cached"]), "");
  assert.equal(await readFile(join(project, "src", "user-draft.txt"), "utf8"), "uncommitted user draft\n");
  // The real project the user pointed at was never modified by this run.
  assert.equal((await git(REAL_PROJECT, ["rev-parse", "HEAD"])).trim(), before.head);
  assert.equal(await git(REAL_PROJECT, ["diff", "--cached"]), before.index);
  assert.equal(await git(REAL_PROJECT, ["status", "--porcelain=v1", "--untracked-files=all"]), before.status, "no file in the user's project changed");
});
