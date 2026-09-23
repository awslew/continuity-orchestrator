import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectReader, READER_LIMITS, visible } from "../../src/project-reader/service.js";
import { callReader } from "../../src/project-reader/mcp.js";
import { buildTestApp } from "../../src/main.js";
import { DEFAULT_FLAGS } from "../../src/flags.js";

async function fixture(t: test.TestContext, share = ["src", "README.md"]) {
  const root = await mkdtemp(join(tmpdir(), "continuity-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "// 你好\r\nexport const answer = 42;\r\n");
  await writeFile(join(root, "README.md"), "Example project\n");
  const config = { version: 1, projects: [{ id: "demo", name: "Demo", root, share }] };
  return { root, config, reader: await ProjectReader.create(config) };
}

test("reader lists only registered project labels and paginates shared paths", async (t) => {
  const { reader, root } = await fixture(t);
  assert.ok(!JSON.stringify(reader.listProjects()).includes(root));
  const first = await reader.listFiles("demo", ".", undefined, 1);
  assert.equal(first.entries[0]?.path, "README.md");
  assert.equal(first.next_after, "README.md");
  const second = await reader.listFiles("demo", ".", first.next_after!, 1);
  assert.deepEqual(second.entries, [{ path: "src", kind: "directory" }]);
  assert.equal(second.next_after, null);
});

test("reader returns real Unicode lines and rejects changed-file pagination", async (t) => {
  const { reader, root } = await fixture(t);
  const first = await reader.readFile("demo", "src/main.ts", 1, 1);
  assert.equal(first.lines[0], "// 你好");
  assert.equal(first.next_start_line, 2);
  const second = await reader.readFile("demo", "src/main.ts", 2, 1, first.sha256);
  assert.equal(second.start_line, 2);
  assert.equal(second.lines[0], "export const answer = 42;");
  assert.equal(second.next_start_line, 3, "the page names the next line to read");
  const last = await reader.readFile("demo", "src/main.ts", 4);
  assert.equal(last.next_start_line, undefined, "the final page carries no next page marker");
  await writeFile(join(root, "src", "main.ts"), "changed");
  await assert.rejects(reader.readFile("demo", "src/main.ts", 2, 1, first.sha256), { code: "FILE_CHANGED" });
});

test("reader rejects traversal, Windows alternate paths, devices, and unshared files", async (t) => {
  const { reader, root } = await fixture(t);
  await writeFile(join(root, "outside.txt"), "private");
  for (const path of ["../outside.txt", "src/../outside.txt", "src/../../outside.txt", "C:/private.txt", "//server/x.txt", "src\\main.ts", "src/main.ts:secret", "src/CON.txt", "src/main.ts.", "outside.txt", "src//main.ts", "src/./main.ts", "src/CREDEN~1.JSON"]) {
    const result = await callReader(reader, "continuity_project_read", { project_id: "demo", path });
    assert.equal(result.ok, false, path);
    assert.ok(!JSON.stringify(result).includes(root), path);
  }
});

test("hidden files, credentials, generated directories and unknown file types are excluded", async (t) => {
  const { reader, root } = await fixture(t, ["."]);
  for (const name of [".env", ".git", "node_modules", "evidence"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "private.txt"), "secret needle");
  }
  for (const name of ["credentials.json", "workspaces.json", "private.pem", "archive.zip"]) await writeFile(join(root, name), "secret needle");
  const list = await reader.listFiles("demo");
  assert.deepEqual(list.entries.map((e) => e.path), ["README.md", "src"]);
  assert.equal((await reader.search("demo", "secret needle")).match_count, 0);
  await assert.rejects(reader.readFile("demo", "credentials.json"), { code: "PATH_DENIED" });
  await assert.rejects(reader.readFile("demo", "private.pem"), { code: "FILE_TYPE_DENIED" });
});

test("the visibility denylist blocks secrets without blocking ordinary source", () => {
  // Real regression, found on a real project: an unanchored credential rule
  // blocked `tokens.css`, so a frontend build could never run in a snapshot, and
  // exclusion by name made `.env.example` and a project's own build output
  // unreachable — which their own tests assert against.
  for (const path of [".env", ".env.local", "credentials.json", "secrets/api.txt", "secrets", "secrets/README.md", "token.json", "staging-tokens.txt", "cookies.json", "client.password.ini", "workspaces.json", "auth.json", "session.json", "private/token.env", "node_modules/pkg/index.js", "vendor/lib/x.ts", "evidence/run.json", "secrets/.env.example", "private/.env.sample", "node_modules/.env.example"]) {
    assert.equal(visible(path), false, `${path} must stay hidden`);
  }
  for (const path of [".env.example", ".env.sample", ".env.template", "src/.env.example", "studio/web/src/styles/tokens.css", "src/tokens.ts", "src/theme/tokens.scss", "studio/web/dist/index.html", "build/output.js", "src/credentials-store.mjs", "secrets.test.mjs", "README.md"]) {
    assert.equal(visible(path), true, `${path} must be shareable`);
  }
});

test("junctions cannot expose paths outside or inside the shared tree", async (t) => {
  const { reader, root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "continuity-reader-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reader.readFile("demo", "src/linked/secret.txt"), { code: "PATH_DENIED" });
  assert.ok(!(await reader.listFiles("demo", "src")).entries.some((entry) => entry.path.includes("linked")));
});

test("hardlinked content is not readable through an innocent path", async (t) => {
  const { reader, root } = await fixture(t);
  await link(join(root, "README.md"), join(root, "src", "linked.txt"));
  await assert.rejects(reader.readFile("demo", "src/linked.txt"), { code: "FILE_TYPE_DENIED" });
});

test("binary, invalid UTF-8 and oversized files fail with bounded errors", async (t) => {
  const { reader, root } = await fixture(t);
  for (const [name, content] of [["binary.ts", Buffer.from([0, 1, 2])], ["invalid.ts", Buffer.from([0xff])], ["large.ts", Buffer.alloc(READER_LIMITS.fileBytes + 1, 65)]] as const) {
    await writeFile(join(root, "src", name), content);
    const result = await callReader(reader, "continuity_project_read", { project_id: "demo", path: `src/${name}` });
    assert.equal(result.ok, false);
    assert.ok(["NON_TEXT_FILE", "FILE_TOO_LARGE"].includes(result.error!.code));
  }
  const result = await reader.search("demo", "answer");
  assert.equal(result.match_count, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.skipped_files, 3);
  assert.equal(result.truncated, true);
});

test("long lines are explicitly truncated, empty files and out-of-range reads are empty", async (t) => {
  const { reader, root } = await fixture(t);
  await writeFile(join(root, "src", "long.ts"), "x".repeat(20_000));
  const result = await reader.readFile("demo", "src/long.ts");
  assert.deepEqual(result.lines_truncated, [1], "the cut line is named, not wrapped in an object");
  assert.equal(result.lines[0]?.length, READER_LIMITS.outputChars);
  await writeFile(join(root, "src", "empty.ts"), "");
  assert.deepEqual((await reader.readFile("demo", "src/empty.ts")).lines, []);
  assert.deepEqual((await reader.readFile("demo", "src/main.ts", 100)).lines, []);
});

test("search is literal, case-sensitive, bounded and returns actual line locations", async (t) => {
  const { reader, root } = await fixture(t);
  await writeFile(join(root, "src", "literal.ts"), "a.*b\nAxB\na.*b\n");
  const result = await reader.search("demo", "a.*b", "src", 1);
  assert.equal(result.files[0]?.path, "src/literal.ts");
  assert.equal(result.files[0]?.hits[0]?.line, 1);
  assert.equal(result.truncated, true);
  assert.equal((await reader.search("demo", "A.*B")).match_count, 0);
});

test("tool schemas reject injected fields and enforce limits; errors omit private paths", async (t) => {
  const { reader, root } = await fixture(t);
  for (const [tool, args] of [["continuity_project_read", { project_id: "demo", path: "src/main.ts", command: "anything" }], ["continuity_project_files", { project_id: "demo", limit: 101 }], ["continuity_project_search", { project_id: "demo", query: "" }], ["continuity_projects_list", { root: "C:/" }]] as const) {
    assert.equal((await callReader(reader, tool, args)).error?.code, "INPUT_INVALID");
  }
  assert.equal((await callReader(reader, "__proto__", {})).error?.code, "TOOL_UNKNOWN");
  const missing = await callReader(reader, "continuity_project_read", { project_id: "demo", path: "src/missing.ts" });
  assert.equal(missing.error?.code, "FILE_UNAVAILABLE");
  assert.ok(!JSON.stringify(missing).includes(root));
  assert.equal((await callReader(reader, "continuity_project_files", { project_id: "unknown" })).error?.code, "PROJECT_UNKNOWN");
});

test("configuration is explicit, strict and rejects duplicate ids or unsafe scopes", async (t) => {
  const { config } = await fixture(t);
  await assert.rejects(ProjectReader.create({ ...config, projects: [...config.projects, ...config.projects] }), { code: "CONFIG_INVALID" });
  await assert.rejects(ProjectReader.create({ ...config, projects: [{ ...config.projects[0], root: "relative" }] }), { code: "CONFIG_INVALID" });
  await assert.rejects(ProjectReader.create({ ...config, projects: [{ ...config.projects[0], share: ["../"] }] }));
  await assert.rejects(ProjectReader.create({ ...config, projects: [{ ...config.projects[0], share: [".env"] }] }));
});

test("search file budget marks partial coverage instead of returning a false exhaustive miss", async (t) => {
  const { root, reader } = await fixture(t);
  for (let index = 0; index < 105; index++) await writeFile(join(root, "src", `${index.toString().padStart(3, "0")}.ts`), "example");
  const result = await reader.search("demo", "missing");
  assert.equal(result.attempted_files, READER_LIMITS.searchFiles);
  assert.equal(result.truncated, true);
  assert.equal(result.files.length, 0);
  assert.equal(result.match_count, 0);
});

test("a shared nested file exposes ancestors but never its unshared sibling", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "src", "other.ts"), "not shared");
  const reader = await ProjectReader.create({ version: 1, projects: [{ id: "demo", name: "Demo", root, share: ["src/main.ts"] }] });
  assert.deepEqual((await reader.listFiles("demo")).entries, [{ path: "src", kind: "directory" }]);
  assert.deepEqual((await reader.listFiles("demo", "src")).entries, [{ path: "src/main.ts", kind: "file" }]);
  await assert.rejects(reader.readFile("demo", "src/other.ts"), { code: "PATH_DENIED" });
});

test("worker controls report unavailable instead of pretending to interrupt or accept", async (t) => {
  const { root } = await fixture(t);
  const app = buildTestApp(root, { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true });
  app.allowlist.registerAttemptId("attempt-known");
  for (const action of ["continue", "steer", "interrupt", "accept"]) {
    const result = await app.server.call("continuity_worker_control", { attempt_id: "attempt-known", action, expected_revision: 0, idempotency_key: `control-${action}` }, `req-${action}`);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "WORKER_CONTROL_BACKEND_UNAVAILABLE");
  }
});
