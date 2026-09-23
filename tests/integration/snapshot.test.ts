import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";
import { join } from "node:path";
import { ProjectEditor, parseSerializedSource, rawText } from "../../src/project-reader/editor.js";
import { detectSource } from "../../src/project-reader/encoding.js";

const exec = promisify(execFile);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const OPAQUE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe]);
const LARGE = Buffer.alloc(700 * 1024, 0x61);

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(t: test.TestContext, options: { limits?: Record<string, number>; command?: string } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "pro-snapshot-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root);
  const git = async (args: string[]) => (await exec("git", ["-C", root, "-c", "core.quotepath=false", ...args], { windowsHide: true })).stdout.trim();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }));
  await writeFile(join(root, "keep.txt"), "user dirty draft\n");
  await writeFile(join(root, "config.json"), iconv.encode("{\n  \"模式\": \"本地\"\n}\n", "gb18030"));
  await writeFile(join(root, "big-generated.js"), LARGE);
  await writeFile(join(root, "logo.png"), OPAQUE);
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work", "media-asr-real.json"), iconv.encode("{\"ok\": true, \"引擎\": \"本地\"}\n", "gb18030"));
  await writeFile(join(root, ".env"), "SECRET=fixture\n");
  await writeFile(join(root, ".gitignore"), "work/\n*.log\n");
  await git(["init", "--quiet"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["add", "package.json", "keep.txt", "config.json", "big-generated.js", "logo.png", ".gitignore"]);
  await git(["-c", "user.name=Snapshot Test", "-c", "user.email=snapshot@example.invalid", "commit", "-m", "fixture baseline"]);
  const validation = { name: options.command ? "custom assertion" : "fixture source assertion", argv: options.command ? [process.execPath, "-e", options.command] : [process.execPath, "-e", "require('node:fs')"], timeout_seconds: 20 };
  const config = { state_dir: state, workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [validation], ...(options.limits ? { limits: options.limits } : {}) }] };
  const reader = { version: 1 as const, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] };
  let editor = await ProjectEditor.create(config, reader, { spawn: "inline" });
  t.after(async () => { await editor.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, root, state, config, reader, git, get editor() { return editor; }, async restart() { await editor.close(); editor = await ProjectEditor.create(config, reader, { spawn: "inline" }); } };
}
const omission = (result: any, path: string) => result.snapshot_omissions.find((o: any) => o.path === path);
async function waitFor(editor: ProjectEditor, id: string): Promise<any> {
  for (let index = 0; index < 500; index++) {
    const result: any = await editor.result(id);
    if (result.ready) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Snapshot test timed out");
}

test("GB18030 and oversized generated files no longer block a development round", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, "config.json"));
  assert.equal(detectSource(before).encoding, "gb18030");
  const round = await f.editor.develop("demo", "legacy-encoding-round", "Edit legacy encoded config", [
    { path: "config.json", expected_sha256: sha(before), content: "{\n  \"模式\": \"本地\",\n  \"版本\": 2\n}\n" }
  ]);
  const done = await waitFor(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.snapshot_omissions));
  assert.equal(done.applied, true);
  const after = await readFile(join(f.root, "config.json"));
  assert.equal(detectSource(after).encoding, "gb18030", "the file keeps its original encoding");
  assert.equal(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, "no BOM is added");
  assert.equal(iconv.decode(after, "gb18030"), "{\n  \"模式\": \"本地\",\n  \"版本\": 2\n}\n");
  assert.deepEqual(done.changes[0].encoding, "gb18030");
  // The 700 KiB generated file stays inside the default 32 MiB per-file budget, so
  // it is copied byte for byte instead of becoming an omission.
  assert.equal(omission(done, "big-generated.js"), undefined);
  assert.equal(done.snapshot_scope.captured_files, 4, "every Git-visible file is captured by default");
  assert.equal(omission(done, "logo.png")?.reason, "BINARY_OR_UNKNOWN_ENCODING");
  assert.equal(omission(done, ".env")?.reason, "HIDDEN_PATH");
  assert.equal(omission(done, "work/media-asr-real.json"), undefined, "git-ignored generated output is outside the snapshot entirely");
  assert.equal(done.snapshot_scope.source, "git_index_and_untracked");
  assert.equal(done.snapshot_scope.ignored_paths_excluded, true);
  assert.equal((await readFile(join(f.root, "big-generated.js"))).equals(LARGE), true, "copied bytes stay untouched");
  assert.equal((await readFile(join(f.root, "logo.png"))).equals(OPAQUE), true, "binary bytes stay untouched");
  assert.equal(await readFile(join(f.root, ".env"), "utf8"), "SECRET=fixture\n");
});

test("generated files over the per-file budget are omitted without failing the round", { timeout: 60000 }, async (t) => {
  // The realistic worst case: an enormous generated artifact that the validation
  // copy cannot hold, next to a small source file that must still be editable.
  const f = await fixture(t, { limits: { file_bytes: 64 * 1024, total_bytes: 8 * 1024 * 1024, total_files: 500 }, command: "require('node:fs')" });
  const round = await f.editor.develop("demo", "per-file-budget", "Edit unrelated source", [
    { path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "edited\n" }
  ]);
  const done = await waitFor(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.snapshot_omissions));
  assert.equal(omission(done, "big-generated.js")?.reason, "FILE_LIMIT");
  assert.equal(omission(done, "big-generated.js")?.bytes, LARGE.length);
  assert.equal(await readFile(join(f.root, "big-generated.js")).then(bytes => bytes.equals(LARGE)), true);
  // Editing an omitted path is refused with the real reason, before any work.
  await assert.rejects(f.editor.develop("demo", "omitted-edit", "Edit an omitted file", [
    { path: "big-generated.js", expected_sha256: sha(LARGE), content: "small replacement\n" }
  ]), (error: { code?: string; message?: string }) => error.code === "FILE_LIMIT" && /per-file snapshot budget|not captured/.test(error.message ?? ""));
  assert.equal(await readFile(join(f.root, "big-generated.js")).then(bytes => bytes.equals(LARGE)), true, "a refused edit never writes");
});

test("a file inside the per-file budget is editable, and the total snapshot budget fails closed", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { command: "require('node:fs')" });
  // big-generated.js is decodable UTF-8 and inside the default per-file budget, so a
  // replacement for it is an ordinary round. The ceiling that binds is the file's own
  // snapshot budget, never a smaller number invented for the edit path.
  const replaced = await f.editor.develop("demo", "editable-limit", "Replace a large generated file", [
    { path: "big-generated.js", expected_sha256: sha(LARGE), content: "small replacement\n" }
  ]);
  assert.equal((await waitFor(f.editor, replaced.task_id)).state, "applied", "a file inside the budget must be editable");
  assert.equal(await readFile(join(f.root, "big-generated.js"), "utf8"), "small replacement\n");
  // Synthetic generated content of 600 KiB is a normal creation, not a payload error.
  const created = await f.editor.develop("demo", "editable-limit-2", "Create a synthetic large file", [
    { path: "generated.bundle.js", expected_sha256: null, content: "x".repeat(600 * 1024) }
  ]);
  assert.equal((await waitFor(f.editor, created.task_id)).state, "applied");
  assert.equal((await readFile(join(f.root, "generated.bundle.js"), "utf8")).length, 600 * 1024);
  const tight = await fixture(t, { limits: { file_bytes: 1024 * 1024, total_bytes: 1024 * 1024, total_files: 500 } });
  // The 700 KiB generated file is over the per-file budget of a smaller workspace,
  // so it is omitted and refused with its real reason rather than a generic failure.
  const narrow = await fixture(t, { limits: { file_bytes: 64 * 1024, total_bytes: 8 * 1024 * 1024, total_files: 500 } });
  await assert.rejects(narrow.editor.develop("demo", "over-per-file", "Edit an omitted file", [
    { path: "big-generated.js", expected_sha256: sha(LARGE), content: "small replacement\n" }
  ]), (error: { code?: string; message?: string }) => error.code === "FILE_LIMIT" && /per-file snapshot budget/.test(error.message ?? ""));
  // A project whose real source exceeds the total budget fails closed before any work.
  await writeFile(join(narrow.root, "budget-1.js"), "//".padEnd(400 * 1024, "a"));
  await writeFile(join(tight.root, "budget-1.js"), "//".padEnd(400 * 1024, "a"));
  await writeFile(join(tight.root, "budget-2.js"), "//".padEnd(400 * 1024, "b"));
  await writeFile(join(tight.root, "budget-3.js"), "//".padEnd(400 * 1024, "c"));
  await assert.rejects(tight.editor.develop("demo", "total-budget", "Edit unrelated source", [
    { path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "edited\n" }
  ]), (error: { code?: string; message?: string }) => error.code === "SNAPSHOT_LIMIT" && /1 MiB/.test(error.message ?? ""));
  assert.equal(await readFile(join(tight.root, "keep.txt"), "utf8"), "user dirty draft\n");
});

test("a test that depends on an omitted file fails for real instead of passing", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { command: "require('node:fs').readFileSync('logo.png')" });
  const round = await f.editor.develop("demo", "omitted-dependency", "Change source while a test needs a binary", [
    { path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "edited\n" }
  ]);
  const failed = await waitFor(f.editor, round.task_id);
  assert.equal(failed.state, "fail");
  assert.equal(failed.reports[0].exit_code, 1);
  assert.equal(failed.applied, false);
  assert.match(failed.reports[0].output, /logo\.png/);
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "user dirty draft\n");
});

test("UTF-16 and UTF-8 BOM files keep their exact bytes through edits and rollback", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { command: "require('node:fs')" });
  const utf16 = iconv.encode("\uFEFFalpha\n", "utf16le");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("beta\n", "utf8")]);
  await writeFile(join(f.root, "notes.txt"), utf16);
  await writeFile(join(f.root, "bom.txt"), bom);
  const round = await f.editor.develop("demo", "encodings-round", "Preserve encodings", [
    { path: "notes.txt", expected_sha256: sha(utf16), content: "alpha two\n" },
    { path: "bom.txt", expected_sha256: sha(bom), content: "beta two\n" }
  ]);
  const done = await waitFor(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.equal(detectSource(await readFile(join(f.root, "notes.txt"))).encoding, "utf16le");
  assert.equal(iconv.decode(await readFile(join(f.root, "notes.txt")), "utf16le"), "alpha two\n");
  assert.equal(detectSource(await readFile(join(f.root, "bom.txt"))).encoding, "utf8-bom");
  assert.equal((await readFile(join(f.root, "bom.txt"))).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true);
  // The private checkpoint keeps a readable copy and the exact original bytes.
  const checkpoint = JSON.parse((await exec("git", ["-C", done.development.checkpoint.repository, "show", `${done.development.checkpoint.before_commit}:snapshot.json`], { windowsHide: true })).stdout);
  assert.deepEqual(Object.keys(checkpoint), ["notes.txt", "bom.txt"]);
  assert.equal(checkpoint["notes.txt"].text, "alpha\n");
  assert.equal(checkpoint["notes.txt"].encoding, "utf16le");
  assert.equal(Buffer.from(checkpoint["notes.txt"].bytes, "base64").equals(utf16), true);
  assert.equal(checkpoint["bom.txt"].encoding, "utf8-bom");
  assert.equal(Buffer.from(checkpoint["bom.txt"].bytes, "base64").equals(bom), true);
  assert.equal((await f.editor.rollback(done.task_id)).state, "rolled_back");
  assert.equal((await readFile(join(f.root, "notes.txt"))).equals(utf16), true, "rollback restores original bytes");
  assert.equal((await readFile(join(f.root, "bom.txt"))).equals(bom), true);
  assert.equal(detectSource(await readFile(join(f.root, "config.json"))).encoding, "gb18030");
});

test("edits preserve the user's HEAD, index, dirty files and unrelated bytes", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "staged.txt"), "staged content\n");
  await f.git(["add", "staged.txt"]);
  const head = await f.git(["rev-parse", "HEAD"]);
  const index = await f.git(["diff", "--cached"]);
  const round = await f.editor.develop("demo", "workspace-protection", "Edit one tracked file", [
    { path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "user requested edit\n" }
  ]);
  const done = await waitFor(f.editor, round.task_id);
  assert.equal(done.applied, true);
  assert.equal(await f.git(["rev-parse", "HEAD"]), head, "private checkpoints never commit to the user's repository");
  assert.equal(await f.git(["diff", "--cached"]), index, "the user's index is untouched");
  assert.equal(await f.git(["diff", "--name-only"]), "keep.txt", "only the requested tracked file is modified");
  assert.equal(await readFile(join(f.root, "staged.txt"), "utf8"), "staged content\n");
  assert.equal((await readFile(join(f.root, "big-generated.js"))).equals(LARGE), true);
  assert.equal((await readFile(join(f.root, "logo.png"))).equals(OPAQUE), true);
  assert.equal(detectSource(await readFile(join(f.root, "work", "media-asr-real.json"))).encoding, "gb18030");
  assert.equal((await f.editor.rollback(done.task_id)).state, "rolled_back");
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "user dirty draft\n");
  assert.equal(await f.git(["rev-parse", "HEAD"]), head);
  assert.equal(await f.git(["diff", "--cached"]), index);
  // Rollback returns the tracked tree to its Git state without touching the user's
  // own untracked and staged work.
  assert.equal(await f.git(["diff", "--name-only"]), "", "the requested edit is fully undone");
  assert.equal(await f.git(["status", "--porcelain=v1", "--untracked-files=all"]), "A  staged.txt\n?? .env");
  assert.equal(await readFile(join(f.root, "staged.txt"), "utf8"), "staged content\n");
});

test("a second round refuses to overwrite a file edited after the first round", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.editor.develop("demo", "round-one", "First round", [
    { path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "first round\n" }
  ]);
  const done = await waitFor(f.editor, first.task_id);
  assert.equal(done.applied, true);
  await assert.rejects(f.editor.propose("demo", [{ path: "keep.txt", expected_sha256: sha("user dirty draft\n"), content: "stale overwrite\n" }]), /Read current file/);
  await writeFile(join(f.root, "keep.txt"), "newer external edit\n");
  await assert.rejects(f.editor.rollback(done.task_id), /newer edits/);
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "newer external edit\n", "the newer edit is preserved");
});
