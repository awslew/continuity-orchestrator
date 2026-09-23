import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEditor, applyAnchor } from "../../src/project-reader/editor.js";
import { ProjectReader } from "../../src/project-reader/service.js";
import { WorkBudget } from "../../src/project-reader/budget.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const anchor = (old_string: string, new_string: string, replace_all = false) => ({ old_string, new_string, replace_all });

/** The round-economy capabilities exist to make one Chat session go further, so
 * every test here measures the same thing: how much text the caller must send or
 * receive to get one unit of verified work. */
async function fixture(t: test.TestContext, check = "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'BETA\\n')") {
  const parent = await mkdtemp(join(tmpdir(), "pro-economy-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root);
  await writeFile(join(root, "a.txt"), "ALPHA\n");
  await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  const reader = { version: 1 as const, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] };
  const config = { state_dir: state, workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [{ name: "written content assertion", argv: [process.execPath, "-e", check], timeout_seconds: 20 }] }] };
  const editor = await ProjectEditor.create(config, reader, { spawn: "inline" });
  t.after(async () => { await editor.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, root, state, config, reader, editor };
}
async function wait(editor: ProjectEditor, id: string, timeoutMs = 15000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await editor.result(id);
    if (result.ready) return result;
    if (Date.now() > deadline) throw new Error(`round ${id} did not finish: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("an anchored edit sends only the replaced span and still validates the whole round", async (t) => {
  const f = await fixture(t);
  const before = "ALPHA\n";
  const round = await f.editor.develop("demo", "anchor-round", "Rename the placeholder", [
    { path: "a.txt", expected_sha256: sha(before), anchor: anchor("ALPHA", "BETA") }
  ]);
  const done = await wait(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "BETA\n");
  // The retained change is complete text: receipts and rollback never depend on the
  // anchor having been understood later.
  assert.equal(done.changes[0].after_sha256, sha("BETA\n"));
  assert.equal(done.changes[0].operation, "replace");
  // The caller sent 4 + 4 characters instead of the whole file.
  assert.ok(anchor("ALPHA", "BETA").old_string.length + anchor("ALPHA", "BETA").new_string.length < before.length + 4);
});

test("anchors refuse ambiguity, absence and creation, each with its own reason", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "dup.txt"), "x\nx\n");
  await assert.rejects(
    f.editor.propose("demo", [{ path: "dup.txt", expected_sha256: sha("x\nx\n"), anchor: anchor("x", "y") }]),
    { code: "ANCHOR_AMBIGUOUS" });
  await assert.rejects(
    f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("GAMMA", "BETA") }]),
    { code: "ANCHOR_NOT_FOUND" });
  await assert.rejects(
    f.editor.propose("demo", [{ path: "new.txt", expected_sha256: null, anchor: anchor("A", "B") }]),
    { code: "NO_CHANGE" });
  await assert.rejects(
    f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("ALPHA", "BETA"), content: "BETA\n" }]),
    { code: "INPUT_INVALID" });
  await assert.rejects(
    f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("ALPHA\n") }]),
    { code: "INPUT_INVALID" });
  // replace_all is the escape hatch when the same text really occurs repeatedly.
  await assert.rejects(
    f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("stale"), anchor: anchor("ALPHA", "BETA") }]),
    { code: "FILE_CHANGED" });
});

test("replace_all replaces every occurrence and a CRLF file is matched across line endings", async (t) => {
  const f = await fixture(t, "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'BETA\\n')");
  const round = await f.editor.develop("demo", "replace-all", "Replace every duplicate", [
    { path: "dup.txt", expected_sha256: null, content: "x\nx\n" },
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("ALPHA", "BETA") }
  ]);
  const done = await wait(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));

  // A Windows file: the caller quoted the text as it appeared in a paginated read
  // (LF), while the bytes on disk are CRLF. Matching bridges only that difference,
  // and the file keeps its own line endings on disk.
  const crlf = await fixture(t, "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'ALPHA\\n')");
  const before = await readFile(join(crlf.root, "crlf.txt"), "utf8");
  const edit = await crlf.editor.propose("demo", [{ path: "crlf.txt", expected_sha256: sha(before), anchor: anchor("two\nthree", "TWO\nTHREE") }]);
  assert.equal(edit.state, "proposed");
  assert.equal((edit as any).changes[0].after_sha256, sha("one\r\nTWO\r\nTHREE\r\n"));
  await crlf.editor.validate(edit.task_id);
  assert.equal((await wait(crlf.editor, edit.task_id)).state, "pass");
  await crlf.editor.apply(edit.task_id);
  assert.equal(await readFile(join(crlf.root, "crlf.txt"), "utf8"), "one\r\nTWO\r\nTHREE\r\n");
});

test("applyAnchor is literal, counts occurrences and reports each refusal", () => {
  assert.equal(applyAnchor("a\nb\nc\n", anchor("b", "B")), "a\nB\nc\n");
  assert.equal(applyAnchor("x x x", anchor("x", "y", true)), "y y y");
  // An LF anchor in a CRLF file matches, and the file keeps CRLF afterwards.
  assert.equal(applyAnchor("one\r\ntwo\r\nthree\r\n", anchor("two\nthree", "TWO\nTHREE")), "one\r\nTWO\r\nTHREE\r\n");
  // A single-line anchor has no ending of its own, so the file's own ending is the
  // one that must survive the write.
  assert.equal(applyAnchor("one\r\ntwo\r\n", anchor("two", "TWO")), "one\r\nTWO\r\n");
  assert.throws(() => applyAnchor("a\n", anchor("zz", "b")), /ANCHOR_NOT_FOUND|does not appear/);
  assert.throws(() => applyAnchor("x x", anchor("x", "y")), /ANCHOR_AMBIGUOUS|appears 2 times/);
});

test("meta_only confirms a hash without paying for the body", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pro-meta-")), root = join(parent, "project");
  await mkdir(root);
  // Content that is large enough for the saving to be the point: a body the caller
  // does not need is replayed in its context on every later turn.
  const body = `${"const value = 'a fairly ordinary line of source';\n".repeat(2000)}`;
  await writeFile(join(root, "big.txt"), body);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const reader = await ProjectReader.create({ version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] });
  const full = await reader.readFile("demo", "big.txt");
  const meta = await reader.readFile("demo", "big.txt", 1, 100, undefined, true);
  assert.equal(meta.sha256, full.sha256);
  assert.equal(meta.bytes, full.bytes);
  assert.equal(meta.total_lines, full.total_lines);
  assert.deepEqual(meta.lines, []);
  assert.equal(meta.meta_only, true);
  const metaBytes = JSON.stringify(meta).length, bodyBytes = JSON.stringify(full).length;
  assert.ok(metaBytes * 2 < bodyBytes, `metadata must be far cheaper than the body: ${metaBytes} vs ${bodyBytes}`);
  // The hash still guards pagination, so a stale expected hash is still refused.
  await assert.rejects(reader.readFile("demo", "big.txt", 1, 100, sha("stale"), true), { code: "FILE_CHANGED" });
});

test("listing a directory costs less when it stops repeating the directory name", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pro-list-")), root = join(parent, "project");
  await mkdir(join(root, "topics", "archive"), { recursive: true });
  for (let index = 0; index < 40; index++) await writeFile(join(root, "topics", `topic-${String(index).padStart(2, "0")}.md`), `# topic ${index}\n`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const reader = await ProjectReader.create({ version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] });
  const full = await reader.listFiles("demo", "topics", undefined, 100);
  const compact = await reader.listFiles("demo", "topics", undefined, 100, true);
  // Same information about what is there and what it is; what is dropped is the prefix
  // every entry repeats plus the per-entry keys, both stated once instead.
  const restore = (name: string) => `topics/${name}`;
  assert.deepEqual(compact.files.map(restore), full.entries.filter(e => e.kind === "file").map(e => e.path));
  assert.deepEqual(compact.directories.map(restore), full.entries.filter(e => e.kind === "directory").map(e => e.path));
  assert.deepEqual(compact.directories, ["archive"], "a caller can still see what is a directory");
  const fullBytes = JSON.stringify(full).length, compactBytes = JSON.stringify(compact).length;
  assert.ok(compactBytes < fullBytes * 0.7, `listing must cost markedly less: ${compactBytes} vs ${fullBytes}`);
  // The cursor belongs to the mode that produced it: names in, names out.
  await writeFile(join(root, "topics", "aaaaa.md"), "# first alphabetically\n");
  const first = await reader.listFiles("demo", "topics", undefined, 1, true);
  assert.equal(first.files[0], "aaaaa.md");
  assert.equal(first.next_after, "aaaaa.md");
  const second = await reader.listFiles("demo", "topics", first.next_after!, 1, true);
  assert.notEqual(second.files[0], "aaaaa.md");
  // The default shape is unchanged, so existing callers keep working byte for byte.
  assert.equal(full.entries[0]?.path?.startsWith("topics/"), true);
  assert.ok(full.next_after === null || full.next_after.startsWith("topics/"));
});

test("a resubmitted round says which case it is instead of returning a state the caller cannot use", async (t) => {
  const f = await fixture(t);
  const before = "ALPHA\n", change = { path: "a.txt", expected_sha256: sha(before), anchor: anchor("ALPHA", "BETA") };
  const first = await f.editor.develop("demo", "reuse-round", "Rename the placeholder", [change]);
  const done = await wait(f.editor, first.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  await f.editor.rollback(first.task_id);
  // Resubmitting a request ID whose work was already undone returns the stored round.
  // That is correct, but the caller asked to run a round and got `rolled_back` back, so
  // the answer must say what to do instead of leaving it to guess.
  const repeat = await f.editor.develop("demo", "reuse-round", "Rename the placeholder", [change]) as any;
  assert.equal(repeat.duplicate_request, true);
  assert.equal(repeat.state, "rolled_back");
  assert.match(repeat.reuse_hint, /undone.*NEW request_id/s);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), before, "resubmitting must not quietly reapply");
  // The same changes under a fresh ID are a fresh round, and they run.
  const fresh = await f.editor.develop("demo", "reuse-round-2", "Rename the placeholder", [change]) as any;
  assert.notEqual(fresh.duplicate_request, true);
  const applied = await wait(f.editor, fresh.task_id);
  assert.equal(applied.state, "applied", JSON.stringify(applied.reports));
});

test("a resubmitted round with different content is a conflict, not a silent reuse", async (t) => {
  const f = await fixture(t);
  await f.editor.develop("demo", "conflict-round", "Rename the placeholder", [
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("ALPHA", "BETA") }
  ]);
  await assert.rejects(f.editor.develop("demo", "conflict-round", "Something else entirely", [
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("ALPHA", "GAMMA") }
  ]), { code: "REQUEST_CONFLICT" });
});

test("undoing an anchor on a file that already existed restores its content rather than deleting it", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, "a.txt"), "utf8");
  const round = await f.editor.develop("demo", "restore-round", "Rename the placeholder", [
    { path: "a.txt", expected_sha256: sha(before), anchor: anchor("ALPHA", "BETA") }
  ]);
  const done = await wait(f.editor, round.task_id);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "BETA\n");
  await f.editor.rollback(round.task_id);
  // A file the round created must disappear on undo; a file it merely changed must come
  // back byte for byte. Conflating the two would either delete the user's file or leave
  // the edit behind, so both directions are pinned here.
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), before);
  assert.equal(sha(await readFile(join(f.root, "a.txt"))), done.changes[0]!.before_sha256);
});

test("wait_seconds returns the finished round in one call instead of polling", async (t) => {
  const f = await fixture(t);
  const round = await f.editor.develop("demo", "waited-round", "Rename the placeholder", [
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), anchor: anchor("ALPHA", "BETA") }
  ]);
  const finished = await f.editor.awaited(round.task_id, 30);
  assert.equal(finished.ready, true);
  assert.equal(finished.wait_timed_out, false);
  assert.equal(finished.state, "applied");
  // `waited_seconds` is the real time this call blocked, NOT the budget it was handed. Pinning
  // the requested number here would re-hide the thing that misled a real client: it saw
  // `waited_seconds=45` beside `ready=true` and could not tell whether the round had finished
  // while it waited or had already been over when it asked. This round completes a few seconds
  // into a 30 s budget, so the honest answer is that small number — never the 30 that the old
  // code echoed back, which is exactly what this assertion caught when it was first written.
  assert.ok(finished.waited_seconds > 0 && finished.waited_seconds < 30,
    `waited_seconds must be the time actually spent waiting, not the 30 s budget it was given; got ${finished.waited_seconds}`);
  // A round that never becomes ready still answers, and says so rather than hanging.
  const idle = await f.editor.awaited("8c4b6f9e-0000-4000-8000-000000000000", 0).catch((error: Error) => error);
  assert.ok(idle instanceof Error, "an unknown task is still an error, not a silent wait");
});

test("one round carries far more than a hand-picked batch of changes", { timeout: 300000 }, async (t) => {
  const f = await fixture(t, "process.exit(0)");
  // 60 files in ONE develop call: the ceiling must be the work itself, not a number
  // someone chose to keep rounds small. Each extra round costs the user a whole turn.
  const changes = [];
  await mkdir(join(f.root, "bulk"), { recursive: true });
  for (let index = 0; index < 60; index++) {
    const path = `bulk/module-${String(index).padStart(2, "0")}.js`;
    // expected_sha256: null marks each as a creation in THIS round; the round must
    // still be allowed to write real content into all sixty of them at once.
    changes.push({ path, expected_sha256: null as string | null, content: `export const value${index} = ${index};\n` });
  }
  const round = await f.editor.develop("demo", "bulk-60", "Land sixty related files in one round", changes);
  const done = await f.editor.awaited(round.task_id, 240);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.equal(done.changes.length, 60);
  for (const index of [0, 59]) {
    assert.equal(await readFile(join(f.root, `bulk/module-${String(index).padStart(2, "0")}.js`), "utf8"), `export const value${index} = ${index};\n`);
  }
});

test("one call may create a file and then anchor into it, and ordered repeats are refused only when they lose work", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, "process.exit(0)");
  const big = `// filler\n`.repeat(20_000);
  const first = "const tail = 1;", second = "const tail = 2;";
  // A path may appear twice when the second change builds on the first: this is one
  // intention, and charging it a second round was the limit nobody chose.
  const round = await f.editor.develop("demo", "create-then-anchor", "Create a large file and fix one line", [
    { path: "gen/big.js", expected_sha256: null, content: `${big}${first}\n` },
    { path: "gen/big.js", expected_sha256: null, anchor: anchor(first, second) }
  ]);
  const done = await f.editor.awaited(round.task_id, 120);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.equal(await readFile(join(f.root, "gen/big.js"), "utf8"), `${big}${second}\n`);
  // The retained original is the state before the round, not an intermediate draft,
  // so undo still restores reality.
  assert.equal((done as any).changes[0].before_sha256, null);

  // ...and a round that touched one path twice must still be undoable. Restoring the
  // path for the first change made the second change's precondition fail, so the whole
  // rollback was refused even though nothing else had been edited.
  assert.equal((await f.editor.rollback(round.task_id)).state, "rolled_back");
  assert.equal(await readFile(join(f.root, "gen/big.js"), "utf8").catch(() => null), null);

  // Two whole-file writes to one path would silently discard the first, so that stays
  // refused; a delete after a write would too.
  await assert.rejects(f.editor.propose("demo", [
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), content: "one\n" },
    { path: "a.txt", expected_sha256: sha("ALPHA\n"), content: "two\n" }
  ]), { code: "DUPLICATE_PATH" });
  const replaced = await f.editor.propose("demo", [{ path: "a.txt", expected_sha256: sha("ALPHA\n"), content: "one\n" }]);
  assert.equal(replaced.state, "proposed");
  await assert.rejects(f.editor.propose("demo", [
    { path: "b.txt", expected_sha256: sha("keep me\n"), content: "changed\n" },
    { path: "b.txt", expected_sha256: sha("changed\n"), content: null }
  ]), { code: "DUPLICATE_PATH" });
});

test("a .gitignore'd path can never be edited, so no round passes validation without its file", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pro-ignored-")), root = join(parent, "project"), state = join(parent, "state");
  await mkdir(root);
  await writeFile(join(root, ".gitignore"), "build/\nscratch/\n");
  await writeFile(join(root, "a.txt"), "ALPHA\n");
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build", "old.txt"), "generated\n");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const git = (args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`)));
  });
  // The engine switch matters: only inside a repository does .gitignore decide the
  // snapshot, and only then is an ignored path absent from the file set.
  await git(["init", "-q"]); await git(["add", "-A"]); await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "base"]);
  const reader = { version: 1 as const, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] };
  const editor = await ProjectEditor.create({
    state_dir: state,
    workspaces: [{ project_id: "demo", writable_paths: ["."], validation: [{ name: "noop", argv: [process.execPath, "-e", "process.exit(0)"], timeout_seconds: 20 }] }]
  }, reader, { spawn: "inline" });
  t.after(async () => { await editor.close(); });

  for (const path of ["scratch/new.txt", "build/fresh.txt"]) {
    await assert.rejects(editor.develop("demo", `ignored-${path.replace(/\W/g, "-")}`, "Try to write ignored generated output", [
      { path, expected_sha256: null, content: "should never land\n" }
    ]), (error: any) => error.code === "FILE_LIMIT" && error.message.includes(path), `${path} must be refused as unverifiable`);
    assert.equal(await readFile(join(root, path), "utf8").catch(() => null), null, `${path} must not exist on disk`);
  }
  // A creation in a directory the snapshot really does cover keeps working: Git never
  // lists this path, so it is absent from BOTH the file set and the omission list, and
  // only the .gitignore rule can tell the two cases apart.
  const round = await editor.develop("demo", "covered-create", "Create a file in a covered directory", [
    { path: "app/new.txt", expected_sha256: null, content: "covers me\n" }
  ]);
  assert.equal((await editor.awaited(round.task_id, 60)).state, "applied");
  assert.equal(await readFile(join(root, "app/new.txt"), "utf8"), "covers me\n");
  assert.equal((await editor.rollback(round.task_id)).state, "rolled_back");
});

test("the session budget counts returned work and starts advising before the window is full", () => {
  const budget = new WorkBudget();
  assert.equal(budget.sample().calls, 0);
  assert.equal(budget.sample().average_chars_per_call, null);
  for (let i = 0; i < 24; i++) budget.record({ ok: true, files: ["a.txt"] });
  assert.match(budget.sample().hint, /comfortable/i);
  const small = budget.sample().returned_chars;
  // 9000-char results are what an oversized whole-file round costs; ten of them must
  // be what makes the advice change, so the scale of the signal is asserted, not the
  // exact sentence.
  for (let i = 0; i < 10; i++) budget.record({ body: "x".repeat(9000) });
  const grown = budget.sample();
  assert.equal(grown.calls, 34);
  assert.ok(grown.returned_chars > small + 90000, "large results must dominate the measured cost");
  assert.ok(grown.average_chars_per_call! > 2000, `average was ${grown.average_chars_per_call}`);
  assert.match(grown.hint, /anchor/i, `hint should advise anchors once whole-file results dominate: ${grown.hint}`);
  assert.match(grown.hint, /handoff|window/i);
  assert.ok(grown.elapsed_minutes >= 0);
});

test("a mixed-line-ending file is never normalized, so no anchor silently rewrites its endings", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pro-mixed-")), root = join(parent, "project");
  await mkdir(root);
  const mixed = "one\r\ntwo\nthree\r\n";
  await writeFile(join(root, "mixed.txt"), mixed);
  t.after(() => rm(parent, { recursive: true, force: true }));
  // A span that really is spelled with LF in the file is matched literally and the
  // file keeps its mixed endings.
  assert.equal(applyAnchor(mixed, anchor("two\nthree", "TWO\nTHREE")), "one\r\nTWO\nTHREE\r\n");
  // A span that sits inside the CRLF region is genuinely unmatched when the caller
  // spells it with LF, and this file is mixed, so the bridge is refused instead of
  // normalizing a file whose endings are deliberate.
  assert.throws(() => applyAnchor(mixed, anchor("one\ntwo", "X")), /does not appear/);
  const reader = await ProjectReader.create({ version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["."] }] });
  // Each paginated line already has its own ending stripped, so text quoted from a
  // read is LF-shaped: that is precisely why the CRLF bridge above must exist, and
  // why it must restore the file's own endings on the way back.
  const page = await reader.readFile("demo", "mixed.txt");
  assert.deepEqual(page.lines, ["one", "two", "three", ""]);
});
