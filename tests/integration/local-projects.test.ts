import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProjects } from "../../src/project-reader/local-projects.js";
import { ProSession, createProMcp } from "../../src/project-reader/pro.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

async function fixture(t: test.TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "local-projects-")), state = join(parent, "state"), a = join(parent, "unregistered a"), b = join(parent, "unregistered b");
  for (const root of [a, b]) {
    await mkdir(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    await writeFile(join(root, "math.js"), "export const add = (a,b) => a-b;\n");
    await writeFile(join(root, "math.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('add',()=>assert.equal(add(2,3),5));\n");
    await writeFile(join(root, ".env"), "DO_NOT_READ=fixture");
  }
  let local = await LocalProjects.create(state);
  // `CONTINUITY_KEEP_TEMP=1` keeps the fixture on disk after a failed run. A round that
  // wedges two processes is exactly the case where the only useful evidence is the files
  // they left behind, and a fixture that always cleans up destroys it.
  t.after(async () => { await local.close(); if (!process.env.CONTINUITY_KEEP_TEMP) await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); else console.error(`[fixture] ${parent}`); });
  return { a, b, state, get local() { return local; }, async restart() { await local.close(); local = await LocalProjects.create(state); } };
}
async function result(local: LocalProjects, root: string, id: string): Promise<any> {
  for (let i = 0; i < 1000; i++) {
    const r = await local.call("continuity_local_result", { project_path: root, task_id: id }) as any;
    if (r.ready) return r;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Timed out");
}
test("unregistered paths: auto-detected real npm tests, apply, restart, Git undo and project isolation", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const context = await f.local.call("continuity_local_context", { project_path: f.a }) as any;
  assert.equal(context.registration_required, false); assert.ok(context.validation?.length);
  const file = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js" }) as any;
  const input = { project_path: f.a, request_id: "unregistered-1", goal: "Fix add", changes: [{ path: "math.js", expected_sha256: file.sha256, content: "export const add = (a,b) => a+b;\n" }] };
  const started = await f.local.call("continuity_local_develop", input) as any;
  const done = await result(f.local, f.a, started.task_id);
  assert.equal(done.applied, true, JSON.stringify(done));
  assert.equal(done.reports[0].exit_code, 0);
  assert.match(await readFile(join(f.b, "math.js"), "utf8"), /a-b/);
  await assert.rejects(f.local.call("continuity_local_result", { project_path: f.b, task_id: started.task_id }), /Unknown editor task/);
  await f.restart();
  assert.equal((await f.local.call("continuity_local_develop", input) as any).task_id, started.task_id);
  const undone = await f.local.call("continuity_local_control", { project_path: f.a, task_id: started.task_id, action: "undo" }) as any;
  // An undo is the same size of work as the apply it reverses, so it runs in its own
  // process too: the control call returns the moment the undo owns the round, and the
  // outcome is read the same way any other round's outcome is read.
  assert.match(undone.result_hint, /continuity_local_result/);
  const rolled = await result(f.local, f.a, started.task_id);
  assert.equal(rolled.state, "rolled_back", JSON.stringify(rolled));
  assert.match(await readFile(join(f.a, "math.js"), "utf8"), /a-b/);
  await assert.rejects(f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "../unregistered b/math.js" }));
  await assert.rejects(f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: ".env" }));
  await assert.rejects(f.local.call("continuity_local_context", { project_path: f.state }), /bridge state/);
});
test("Chat can supply real validation when detection is unavailable; FAIL leaves originals intact", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.a, "package.json"), '{}');
  const file = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js" }) as any;
  const input = { project_path: f.a, request_id: "supplied-1", goal: "Test inferred validation", changes: [{ path: "math.js", expected_sha256: file.sha256, content: "invalid JS!" }] };
  await assert.rejects(f.local.call("continuity_local_develop", input), /supply meaningful/);
  const started = await f.local.call("continuity_local_develop", { ...input, validation: [{ name: "Syntax check from Chat", argv: [process.execPath, "--check", "math.js"], timeout_seconds: 10 }] }) as any;
  const done = await result(f.local, f.a, started.task_id);
  assert.equal(done.state, "fail"); assert.equal(done.applied, false);
  assert.match(await readFile(join(f.a, "math.js"), "utf8"), /a-b/);
});
test("per-round test overrides persist, cannot reuse PASS, and survive restart without mutating older tasks", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const read = async () => await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js" }) as any;
  const first = await f.local.call("continuity_local_develop", { project_path: f.a, request_id: "original-tests", goal: "Fix add", changes: [{ path: "math.js", expected_sha256: (await read()).sha256, content: "export const add=(a,b)=>a+b;\n" }] }) as any;
  const firstResult = await result(f.local, f.a, first.task_id);
  assert.equal(firstResult.applied, true);
  const commands = [{ name: "Round-specific arithmetic assertion", argv: [process.execPath, "--input-type=module", "-e", "import {add} from './math.js'; import assert from 'node:assert/strict'; assert.equal(add(2,3),999)"], timeout_seconds: 10 }];
  const input = { project_path: f.a, request_id: "override-tests", goal: "Check second-round changes", changes: [{ path: "math.js", expected_sha256: (await read()).sha256, content: "export const add=(a,b)=>a+b; // round two\n" }], validation: commands };
  const second = await f.local.call("continuity_local_develop", input) as any;
  const failed = await result(f.local, f.a, second.task_id);
  assert.equal(failed.state, "fail"); assert.equal(failed.applied, false);
  assert.deepEqual(failed.validation_commands, commands);
  assert.equal(failed.reports[0].name, commands[0]!.name);
  assert.doesNotMatch(await readFile(join(f.a, "math.js"), "utf8"), /round two/);
  const fixedCommands = [{ ...commands[0]!, argv: [process.execPath, "--test"] }];
  await assert.rejects(f.local.call("continuity_local_develop", { ...input, validation: fixedCommands }), /identical request/);
  await f.restart();
  assert.equal((await f.local.call("continuity_local_develop", input) as any).task_id, second.task_id);
  assert.deepEqual((await result(f.local, f.a, first.task_id)).validation_commands, firstResult.validation_commands);
  assert.deepEqual((await result(f.local, f.a, second.task_id)).validation_commands, commands);
  const third = await f.local.call("continuity_local_develop", { ...input, request_id: "corrected-tests", validation: fixedCommands }) as any;
  assert.equal((await result(f.local, f.a, third.task_id)).applied, true);
  assert.match(await readFile(join(f.a, "math.js"), "utf8"), /round two/);
});

test("the Chat boundary accepts anchors, meta_only and wait_seconds in one round each", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const page = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js" }) as any;
  assert.equal(page.sha256.length, 64);
  // Meta read: same hash, no body, one call.
  const meta = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js", meta_only: true }) as any;
  assert.equal(meta.sha256, page.sha256);
  assert.equal(meta.meta_only, true);
  assert.deepEqual(meta.lines, []);
  assert.ok(JSON.stringify(meta).length < JSON.stringify(page).length);
  // Anchored round through the real tool schema, then a blocking result call.
  const anchor = { old_string: "a-b", new_string: "a+b" };
  const started = await f.local.call("continuity_local_develop", { project_path: f.a, request_id: "anchor-1", goal: "Fix add through an anchor", changes: [{ path: "math.js", expected_sha256: page.sha256, anchor }] }) as any;
  assert.match(started.result_hint, /call continuity_local_result with wait_seconds \d+/);
  assert.match(started.result_hint, /120 s/);
  const done = await f.local.call("continuity_local_result", { project_path: f.a, task_id: started.task_id, wait_seconds: 30 }) as any;
  assert.equal(done.ready, true, JSON.stringify(done));
  assert.equal(done.wait_timed_out, false);
  assert.equal(done.state, "applied", JSON.stringify(done.reports));
  assert.match(await readFile(join(f.a, "math.js"), "utf8"), /a\+b/);
  assert.ok(anchor.old_string.length + anchor.new_string.length < "export const add = (a,b) => a-b;\n".length, "an anchor must cost less than the file it edits");
  // Both modes at once is refused at the boundary, naming the path.
  const current = await readFile(join(f.a, "math.js"), "utf8");
  await assert.rejects(
    f.local.call("continuity_local_develop", { project_path: f.a, request_id: "anchor-2", goal: "Refuse both", changes: [{ path: "math.js", expected_sha256: createHash("sha256").update(current).digest("hex"), content: "x\n", anchor }] }),
    /supply either content or anchor, not both/);
});

test("MCP exposes dynamic tools only after machine opt-in, with honest write annotations", async t => {
  const f = await fixture(t);
  const session = await ProSession.create({ version: 1, reader: { version: 1, projects: [{ id: "static", name: "Static", root: f.a, share: ["."] }] }, local_access: { state_dir: join(f.state, "mcp"), user_specified_projects: true } });
  t.after(() => session.close());
  const server = createProMcp(session), client = new Client({ name: "local-test", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(t => t.name === "continuity_local_develop")?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === "continuity_local_result")?.annotations?.readOnlyHint, true);
  // The advertised schema is generated from the same zod object that validates the
  // call, so this is the contract a Chat client actually sees.
  const read = tools.find(t => t.name === "continuity_local_read")?.inputSchema as any;
  assert.equal(read.properties.meta_only.type, "boolean");
  const result = tools.find(t => t.name === "continuity_local_result")?.inputSchema as any;
  assert.equal(result.properties.wait_seconds.type, "integer");
  // The wait ceiling exists to stay under two real ceilings: an MCP client aborts at its
  // own request timeout (SDK default 60 s, observed as -32001) and the tunnel drops any
  // command that blocks past its 120 s deadline. A wait of 60 s was measured returning at
  // 60.197 s, i.e. past the client abort, so the ceiling must leave margin under the
  // nearer one. It is a lease on the caller's turn, never a limit on the round.
  assert.ok(result.properties.wait_seconds.maximum <= 45, `wait ceiling is ${result.properties.wait_seconds.maximum}`);
  assert.ok(result.properties.wait_seconds.maximum > 0);
  const develop = tools.find(t => t.name === "continuity_local_develop")?.inputSchema as any;
  assert.ok(develop.properties.changes.items.properties.anchor, "anchor must be advertised per change");
  assert.deepEqual(Object.keys(develop.properties.changes.items.properties.anchor.properties).sort(), ["new_string", "old_string", "replace_all"]);
  // No count of changes may stand between a Chat turn and a round's real work. The
  // advertised schema does not carry the array ceiling, so the bound that matters is
  // asserted where it is real: the 60-file round in round-economy.test.ts.
  assert.ok(develop.properties.changes, "changes must be advertised");
  assert.ok((develop.properties.validation?.items?.properties?.timeout_seconds?.maximum ?? 0) >= 3600, "a validation step must be allowed to run longer than an hour");
  const r = await client.callTool({ name: "continuity_local_context", arguments: { project_path: f.b } });
  assert.ok(!r.isError); assert.equal(JSON.parse((r.content as any)[0].text).data.project_path, f.b);
  // A client whose cached tool list predates the server sends arguments this server
  // never declared. The refusal must say which argument and which schema, because
  // "arguments do not match schema" costs a whole Chat turn to diagnose.
  // A client whose cached tool list predates the server sends arguments this server
  // never declared. The refusal must say which argument and which schema, because
  // "arguments do not match schema" costs a whole Chat turn to diagnose. The protocol
  // layer is deliberately permissive so this diagnostic is reachable at all; zod stays
  // the authority, so the round is still refused.
  const fingerprint = JSON.parse((r.content as any)[0].text).data.tool_schema_fingerprint;
  assert.match(fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(read.additionalProperties, true, "the advertised schema must let an undeclared key reach the diagnostic instead of being rejected anonymously");
  const stale = await (client as any).request({ method: "tools/call", params: { name: "continuity_local_develop", arguments: {
    project_path: f.b, request_id: "stale-client", goal: "Send an argument this server does not declare",
    changes: [{ path: "new.md", expected_sha256: null, content: "x", unknown_top_level: true }]
  } } }, CallToolResultSchema) as any;
  assert.equal(stale.isError, true);
  const mismatch = JSON.parse(stale.content[0].text).schema_mismatch;
  assert.equal(mismatch.tool, "continuity_local_develop");
  assert.ok(mismatch.unrecognized_arguments.includes("changes.0.unknown_top_level"), JSON.stringify(mismatch));
  assert.equal(mismatch.schema_fingerprint, fingerprint, "the error must report the same digest the context call advertises");
  assert.match(mismatch.hint, /cached|refresh/i);
  // The advertised schema really does accept an anchored round, so a caller holding it
  // can never be told by this server that anchor is unrecognized.
  const anchored = await client.callTool({ name: "continuity_local_develop", arguments: {
    project_path: f.b, request_id: "fresh-client", goal: "Send the schema this server advertises",
    changes: [{ path: "new.md", expected_sha256: null, content: "line one\nline two\n" },
      { path: "new.md", expected_sha256: null, anchor: { old_string: "line two", new_string: "LINE TWO" } }],
    validation: [{ name: "noop", argv: [process.execPath, "-e", "process.exit(0)"], timeout_seconds: 20 }]
  } });
  assert.ok(!anchored.isError, JSON.stringify((anchored.content as any)[0].text));
});

// The wait is a lease on the caller's turn, never a limit on the round, and its ceiling
// is bounded by the transport rather than by patience: an MCP client aborts at its own
// request timeout (SDK default 60 s) and the Secure MCP Tunnel drops a command 120 s
// after it is polled and answers 502. A wait that reaches either one loses the result of
// a round that actually succeeded. This pins the behaviour that keeps a real round
// observable from Chat: what the schema advertises is accepted, one second more is
// refused at the boundary, the call returns as soon as the round settles, and reads stay
// answerable while it waits.
test("the wait ceiling leaves margin under both transport deadlines and never makes a read wait", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const page = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.js" }) as any;
  const started = await f.local.call("continuity_local_develop", {
    project_path: f.a, request_id: "wait-ceiling-1", goal: "Pin the wait ceiling",
    changes: [{ path: "math.js", expected_sha256: page.sha256, content: "export const add = (a,b) => a+b;\n" }],
    validation: [{ name: "slow enough to observe a wait", argv: [process.execPath, "-e", "setTimeout(() => {}, 3000)"], timeout_seconds: 30 }]
  }) as any;
  const ceiling = 45, over = ceiling + 1;
  // The advertised ceiling must be usable exactly as advertised, and must leave 15 s of
  // margin under the 60 s client abort that a 60 s wait was measured to overrun.
  const waiting = f.local.call("continuity_local_result", { project_path: f.a, task_id: started.task_id, wait_seconds: ceiling });
  // A read issued while that call is still waiting must answer now, not queue behind it.
  const readStarted = Date.now();
  const during = await f.local.call("continuity_local_read", { project_path: f.a, action: "read", path: "math.test.js" }) as any;
  const readMs = Date.now() - readStarted;
  assert.equal(typeof during.sha256, "string");
  assert.ok(readMs < 1000, `a read must not wait for a result poll; took ${readMs} ms`);
  const done = await waiting as any;
  assert.equal(done.ready, true, JSON.stringify(done));
  assert.equal(done.wait_timed_out, false);
  assert.equal(done.applied, true, JSON.stringify(done.reports));
  // One second past the ceiling is refused at the boundary instead of blocking the caller
  // into a transport timeout, which is how the previous ceiling lost a finished round.
  await assert.rejects(
    f.local.call("continuity_local_result", { project_path: f.a, task_id: started.task_id, wait_seconds: over }),
    /wait_seconds/);
});
