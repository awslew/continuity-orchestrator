import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { ConfirmationGateRegistry } from "../../src/security/confirmations.js";
import { EvidenceWriter } from "../../src/evidence/evidence-writer.js";
import { HandoffStore } from "../../src/persistence/handoff-store.js";
import { TaskCoordinator } from "../../src/workflow/task-coordinator.js";
import { MockWebgptDriveTransport, WebgptDriveAdapter } from "../../src/adapters/webgpt-drive.js";
import { CodexAppServerStdioTransport, createCodexAppServerLazySeam, type AppServerRpcRequest, type CodexAppServerLazySeam } from "../../src/adapters/codex-app-server-stdio.js";
import { FixtureAppServerChild, fixtureSpawn } from "../fixtures/app-server-stdio/mock-child.js";
import { ContinuityMcpServer } from "../../src/mcp/server.js";
import { TOOL_DESCRIPTORS, TOOL_INPUT_SCHEMAS } from "../../src/mcp/schemas.js";
import type { ContinuityEnvelope } from "../../src/mcp/result.js";
import { TASKS_LIST_SCHEMA_VERSION, type TasksListReceiptSink } from "../../src/mcp/tasks-list-receipt.js";

function initializeResult() {
  return { serverInfo: { name: "fixture-app-server", version: "0.0.0" }, capabilities: {} };
}

function fixtureChild(handler: (request: AppServerRpcRequest, child: FixtureAppServerChild) => void | Promise<void>): FixtureAppServerChild {
  return new FixtureAppServerChild((request, current) => {
    if (request.method === "initialize") {
      current.reply(request.id, initializeResult());
      return;
    }
    handler(request, current);
  });
}
function childTransport(child: FixtureAppServerChild): CodexAppServerStdioTransport {
  const transport = new CodexAppServerStdioTransport({
    command: "codex",
    args: ["app-server"],
    env: { PATH: "C:\\safe\\bin" },
    envAllowlist: ["PATH"],
    spawn: fixtureSpawn(child, [])
  });
  return transport;
}

/** Transport whose child is already running and initialized (fixture replies). */
async function initializedTransport(child: FixtureAppServerChild): Promise<CodexAppServerStdioTransport> {
  const transport = childTransport(child);
  const receipt = await transport.initialize();
  assert.equal(receipt.ok, true);
  return transport;
}

/**
 * Registry test server.  A stdio seam is optional: when supplied, the raw
 * transport and its lazy single-flight gate are wired into the MCP server so
 * the tool's real lazy start behavior is observable through `spawns`.
 */
function registryServer(stdio: CodexAppServerStdioTransport | null, receiptSink?: TasksListReceiptSink | null): {
  server: ContinuityMcpServer;
  seam: CodexAppServerLazySeam | null;
} {
  const root = mkdtempSync(join(tmpdir(), "continuity-mcp-codex-threads-"));
  const store = new HandoffStore(root);
  const allowlist = new Allowlist();
  allowlist.registerWorkspace({ workspaceId: "default", root });
  const coordinator = new TaskCoordinator(store, allowlist, new EvidenceWriter(root, 16_384));
  let seam: CodexAppServerLazySeam | null = null;
  if (stdio) seam = createCodexAppServerLazySeam(stdio);
  const options: ConstructorParameters<typeof ContinuityMcpServer>[0] = {
    coordinator,
    store,
    allowlist,
    confirmations: new ConfirmationGateRegistry(),
    evidence: new EvidenceWriter(root, 16_384),
    webgpt: new WebgptDriveAdapter(new MockWebgptDriveTransport()),
    flags: { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true }
  };
  if (seam) options.codexAppServerStdioLazy = seam;
  if (receiptSink) options.tasksListReceiptSink = receiptSink;
  return { server: new ContinuityMcpServer(options), seam };
}

function captureSink(): { lines: string[]; events: Array<Record<string, unknown>>; sink: TasksListReceiptSink } {
  const lines: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const sink: TasksListReceiptSink = (line) => {
    lines.push(line);
    events.push(JSON.parse(line) as Record<string, unknown>);
  };
  return { lines, events, sink };
}

function cursorSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Child that always replies to thread/list with one terminating empty page. */
function emptyRegistryChild(): FixtureAppServerChild {
  return fixtureChild((request, current) => {
    if (request.method === "thread/list") current.reply(request.id, { data: [], nextCursor: null });
  });
}

/**
 * A registry child whose thread/list walk spans two pages and terminates.  The
 * first page returns one thread and a cursor that contains a marker string; the
 * second returns a thread whose turnId embeds the same marker plus a secret
 * sentinel.  The marker doubles as a searchable raw value that must never
 * surface in the receipt stream.
 */
function pageScaffold(): { child: FixtureAppServerChild; secret: string } {
  const secret = "SENTINEL-DEADBEEF-secret";
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : null;
    if (cursor === null) current.reply(request.id, { data: [{ id: "thread-1", status: "notLoaded", source: "subAgent" }], nextCursor: "cursor-secret-1" });
    else current.reply(request.id, { data: [{ id: "thread-2", status: "notLoaded", source: "subAgent", turnId: `title-secret-${secret}`, projectId: "project-1" }], nextCursor: null });
  });
  return { child, secret };
}

test("receipt stream is one JSON object per line with a fixed schema and no raw cursor, title, path or secret", async () => {
  const { child } = pageScaffold();
  const { lines, events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-json");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  // Every emission is exactly one JSON object on its own line (single-line
  // JSON), and the whole stream belongs to one schema_version.
  const firstReceiptId = envelope.data.receipt_id;
  assert.equal(typeof firstReceiptId, "string");
  assert.equal(events.length > 0, true);
  for (const line of lines) {
    assert.equal(line.includes("\n"), false, "each event is exactly one line");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.schema_version, TASKS_LIST_SCHEMA_VERSION);
    assert.equal(typeof parsed.timestamp, "string");
    assert.equal(typeof parsed.receipt_id, "string");
    assert.equal(parsed.receipt_id, firstReceiptId, "every event in a call shares the receipt");
  }
  // The raw cursor value and the secret marker must never appear in any event;
  // only their sha256 digests are permitted.
  const raw = JSON.stringify(events);
  assert.equal(raw.includes("cursor-secret-1"), false, "no raw input cursor in the stream");
  assert.equal(raw.includes("title-secret-SENTINEL-DEADBEEF-secret"), false, "no thread title in the stream");
  assert.equal(raw.includes("SENTINEL-DEADBEEF-secret"), false, "no secret in the stream");
});

test("receipt stream pages carry input and output cursor sha256 digests, never the raw cursor", async () => {
  const { child } = pageScaffold();
  const { events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-cursor");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const firstReceiptId = envelope.data.receipt_id;
  const pageEvents = events.filter((event) => event.event === "codex_app_server_rpc_page");
  assert.equal(pageEvents.length, 2);
  const [first, second] = pageEvents as Array<Record<string, unknown>>;
  assert.equal(first?.method, "thread/list");
  assert.equal(first?.page_index, 1);
  assert.equal(first?.cursor_in_present, false);
  assert.equal(first?.cursor_in_sha256, null);
  assert.equal(first?.cursor_out_present, true);
  assert.equal(first?.cursor_out_sha256, cursorSha256("cursor-secret-1"));
  assert.equal(first?.item_count, 1);
  assert.equal(second?.page_index, 2);
  assert.equal(second?.cursor_in_present, true);
  assert.equal(second?.cursor_in_sha256, cursorSha256("cursor-secret-1"));
  assert.equal(second?.cursor_out_present, false);
  assert.equal(second?.cursor_out_sha256, null);
  assert.equal(second?.item_count, 1);
  for (const event of pageEvents) assert.equal(event.receipt_id, firstReceiptId);
});

test("receipt stream is complete and the completed receipt matches the envelope data receipt id", async () => {
  const child = emptyRegistryChild();
  const { events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-complete");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const receiptId = envelope.data.receipt_id;
  const last = events[events.length - 1];
  assert.equal(last?.event, "continuity_tool_call_completed");
  assert.equal(last?.receipt_id, receiptId);
  assert.equal(last?.method, "thread/list");
  assert.equal(last?.page_count, 1);
  assert.equal(last?.unique_count, 0);
  assert.equal(last?.complete, true);
  assert.equal(typeof last?.duration_ms, "number");
  assert.equal(last?.schema_version, TASKS_LIST_SCHEMA_VERSION);
  assert.equal(events.every((event) => event.receipt_id === receiptId), true, "the receipt threads through every event");
});

test("a throwing receipt sink never breaks the tool call", async () => {
  const child = emptyRegistryChild();
  const throwSink: TasksListReceiptSink = () => { throw new Error("sink exploded"); };
  const { server } = registryServer(childTransport(child), throwSink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-throw-sink");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.data.complete, true);
  assert.equal(envelope.data.unique_thread_count, 0);
});

test("first call receipt chain records a fresh child_started then initialized, page and completed events", async () => {
  const child = emptyRegistryChild();
  const { events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink); // lazy: the first call spawns
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-chain-first");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const receiptId = envelope.data.receipt_id;
  assert.deepEqual(events.map((event) => event.event), [
    "continuity_tool_call_received",
    "codex_app_server_child_started",
    "codex_app_server_initialized",
    "codex_app_server_rpc_page",
    "continuity_tool_call_completed"
  ]);
  assert.equal(events[0]?.tool, "continuity_codex_tasks_list");
  assert.equal(events[0]?.receipt_id, receiptId);
  assert.equal(events[1]?.reused, false, "the call that actually spawned is the owner");
  assert.equal(events[1]?.child_instance_id, "child-1");
  assert.equal(events[1]?.receipt_id, receiptId);
  assert.equal(events[2]?.initialized, true);
  assert.equal(events[3]?.page_index, 1);
  assert.equal(events[4]?.method, "thread/list");
  assert.equal(events[4]?.complete, true);
  assert.equal(events[4]?.receipt_id, receiptId);
});

test("a second call reuses the child under its own receipt with child_started reused:true", async () => {
  const child = emptyRegistryChild();
  const { events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink);
  const first = await server.call("continuity_codex_tasks_list", {}, "req-reuse-chain-1");
  const second = await server.call("continuity_codex_tasks_list", {}, "req-reuse-chain-2");
  assert.equal(first.ok && second.ok, true);
  const firstId = first.data.receipt_id;
  const secondId = second.data.receipt_id;
  assert.notEqual(firstId, secondId, "each call draws its own receipt");
  const firstEvents = events.filter((event) => event.receipt_id === firstId);
  const secondEvents = events.filter((event) => event.receipt_id === secondId);
  assert.equal(firstEvents.length, 5);
  assert.equal(secondEvents.length, 5);
  assert.equal(firstEvents[1]?.reused, false);
  assert.equal(secondEvents[1]?.reused, true, "the reused call admits it did not spawn");
  assert.equal(secondEvents[1]?.child_instance_id, "child-1");
  // One child across both calls, and no event ever mixes the two receipts.
  assert.equal(child.receivedSpecs.length, 1);
  for (const event of events) assert.equal([firstId, secondId].includes(event.receipt_id as string), true);
});

test("concurrent first calls single-flight onto one child; exactly one receipt owns the spawn", async () => {
  const child = emptyRegistryChild();
  const { events, sink } = captureSink();
  const { server } = registryServer(childTransport(child), sink);
  const envelopes = await Promise.all([
    server.call("continuity_codex_tasks_list", {}, "req-conc-receipt-1"),
    server.call("continuity_codex_tasks_list", {}, "req-conc-receipt-2"),
    server.call("continuity_codex_tasks_list", {}, "req-conc-receipt-3")
  ]);
  for (const envelope of envelopes) assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const ids = new Set(envelopes.map((envelope) => envelope.data.receipt_id as string));
  assert.equal(ids.size, 3, "each concurrent call draws its own receipt");
  const started = events.filter((event) => event.event === "codex_app_server_child_started");
  assert.equal(started.length, 3);
  assert.equal(started.filter((event) => event.reused === false).length, 1, "exactly one receipt owns the spawn");
  assert.equal(started.filter((event) => event.reused === true).length, 2);
  assert.equal(started.every((event) => event.child_instance_id === "child-1"), true);
  const completed = events.filter((event) => event.event === "continuity_tool_call_completed");
  assert.equal(completed.length, 3);
  assert.deepEqual(new Set(completed.map((event) => event.receipt_id)), ids, "each receipt completes once");
  assert.equal(child.receivedSpecs.length, 1, "one child served all three calls");
});

test("a thread/list RPC failure emits a failed event with code and stage but no exception text", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") current.error(request.id, "INTERNAL_ERROR", "boom");
  });
  const { events, sink } = captureSink();
  const { server } = registryServer(await initializedTransport(child), sink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-fail-rpc-receipt");
  assert.equal(envelope.ok, false);
  const last = events[events.length - 1];
  assert.equal(last?.event, "continuity_tool_call_failed");
  assert.equal(last?.code, "INTERNAL_ERROR");
  assert.equal(last?.stage, "thread/list");
  assert.equal(last?.receipt_id, envelope.data.receipt_id, "the envelope keeps the failed receipt");
  assert.equal(events.some((event) => event.event === "continuity_tool_call_completed"), false);
  assert.equal(JSON.stringify(events).includes("boom"), false, "no exception/stack text in the stream");
});

test("a fail-closed page cap emits one page event per RPC and ends in a CURSOR_LOOP failed event", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : null;
    const page = cursor === null ? 1 : Number(cursor.replace("c", ""));
    current.reply(request.id, { data: [{ id: `thread-${page}`, status: "notLoaded", source: "subAgent" }], nextCursor: `c${page + 1}` });
  });
  const { events, sink } = captureSink();
  const { server } = registryServer(await initializedTransport(child), sink);
  const envelope = await server.call("continuity_codex_tasks_list", { page_limit: 2 }, "req-cap-receipt");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "CURSOR_LOOP");
  const pageEvents = events.filter((event) => event.event === "codex_app_server_rpc_page");
  assert.equal(pageEvents.length, 2, "one page event per RPC actually issued");
  const last = events[events.length - 1];
  assert.equal(last?.event, "continuity_tool_call_failed");
  assert.equal(last?.code, "CURSOR_LOOP");
  assert.equal(last?.stage, "thread/list");
  assert.equal(last?.receipt_id, envelope.data.receipt_id);
});

test("an initialize failure emits a failed event at the ensure_initialized stage and nothing after it", async () => {
  const child = new FixtureAppServerChild((request, current) => {
    if (request.method === "initialize") current.error(request.id, "INTERNAL_ERROR", "init exploded");
  });
  const stdio = childTransport(child);
  const { events, sink } = captureSink();
  const { server } = registryServer(stdio, sink);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-fail-init-receipt");
  assert.equal(envelope.ok, false);
  assert.equal(typeof envelope.data.receipt_id, "string", "the failed envelope still carries the receipt");
  const last = events[events.length - 1];
  assert.equal(last?.event, "continuity_tool_call_failed");
  assert.equal(last?.code, "INTERNAL_ERROR");
  assert.equal(last?.stage, "ensure_initialized");
  assert.equal(last?.receipt_id, envelope.data.receipt_id);
  // No spawn/initialized/page/completed event exists for a call that never got
  // past the handshake, and the fault text never reaches the stream.
  assert.equal(events.some((event) => event.event === "codex_app_server_child_started"), false);
  assert.equal(events.some((event) => event.event === "codex_app_server_initialized"), false);
  assert.equal(events.some((event) => event.event === "codex_app_server_rpc_page"), false);
  assert.equal(JSON.stringify(events).includes("init exploded"), false);
  await stdio.shutdown();
});

test("continuity_codex_tasks_list descriptor and input schema are strictly read-only", () => {
  const descriptor = TOOL_DESCRIPTORS.find((tool) => tool.name === "continuity_codex_tasks_list");
  assert.ok(descriptor, "tool descriptor exists");
  assert.equal(descriptor.mutating, false);
  assert.equal(descriptor.description.includes("Read-only"), true);
  assert.equal(descriptor.description.includes("never mutates"), true);
  assert.equal(descriptor.description.includes("thread ids are never excluded"), true);
  assert.equal(descriptor.description.includes("repeatable"), true);
  // Strict optional parameters: unknown fields are rejected, bounds are
  // enforced at the schema, and no schema field exists for an idempotency
  // key or any mutation parameter.
  const parsedEmpty = TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({});
  assert.deepEqual(parsedEmpty, {});
  assert.equal(TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ limit: 5 }).limit, 5);
  assert.equal(TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ page_limit: 3 }).page_limit, 3);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ extra: 1 }), /Unrecognized key/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ limit: 0 }), /too_small/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ page_limit: 101 }), /too_big/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ limit: -1 }), /too_small/);
  assert.throws(() => TOOL_INPUT_SCHEMAS.continuity_codex_tasks_list.parse({ idempotency_key: "idem-key" }), /Unrecognized key/);
});

test("continuity_codex_tasks_list fails closed without an App Server stdio seam", async () => {
  const { server } = registryServer(null);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-absent");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "APP_SERVER_UNAVAILABLE");
  assert.equal(envelope.error?.needs_human, false);
  assert.equal(envelope.error?.retryable, false);
});

test("continuity_codex_tasks_list enumerates the registry through thread/list and returns the receipt", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : null;
    if (cursor === null) current.reply(request.id, { data: [{ id: "thread-a", status: "notLoaded", source: "subAgent" }], nextCursor: "cursor-b" });
    else current.reply(request.id, { data: [{ id: "thread-b", status: "notLoaded", source: "subAgent", turnId: "turn-b", projectId: "project-b", repositoryId: "repo-b" }], nextCursor: null });
  });
  const { server } = registryServer(await initializedTransport(child));
  const envelope: ContinuityEnvelope = await server.call("continuity_codex_tasks_list", {}, "req-list");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.error, null);
  assert.deepEqual(envelope.data.actual_rpc_methods_observed, ["thread/list"]);
  // The envelope contains nothing from the local store, no evidence refs and
  // no redactable fields; only the safe thread fields cross the boundary.
  assert.equal(envelope.data.page_count, 2);
  assert.equal(envelope.data.unique_thread_count, 2);
  assert.equal(envelope.data.complete, true);
  assert.deepEqual(envelope.evidence_refs, []);
  assert.equal(typeof envelope.data.receipt_id, "string");
  assert.equal((envelope.data.receipt_id as string).length > 0, true);
  assert.equal(Object.keys(envelope.data).sort().join(","), "actual_rpc_methods_observed,complete,page_count,pages,receipt_id,threads,unique_thread_count");
  assert.deepEqual(envelope.data.pages, [
    { index: 1, input_cursor: null, output_cursor: "cursor-b", item_count: 1 },
    { index: 2, input_cursor: "cursor-b", output_cursor: null, item_count: 1 }
  ]);
  assert.deepEqual(envelope.data.threads, [
    { thread_id: "thread-a", turn_id: null, project_id: null, repository_id: null, status: "notLoaded", source_kind: "subAgent" },
    { thread_id: "thread-b", turn_id: "turn-b", project_id: "project-b", repository_id: "repo-b", status: "notLoaded", source_kind: "subAgent" }
  ]);
  // Only initialize and thread/list RPCs were issued, and nothing else was
  // written: the envelope carries no evidence refs and the registry walk
  // performed exactly the observable thread/list calls.
  assert.deepEqual(envelope.evidence_refs, []);
  assert.equal(child.requests.filter((request) => request.id !== undefined).every((request) => request.method === "initialize" || request.method === "thread/list"), true);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 2);
});

test("continuity_codex_tasks_list honors the optional page_limit and limit bounds", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    const params = typeof request.params === "object" && request.params !== null ? request.params as Record<string, unknown> : {};
    const cursor = typeof params.cursor === "string" ? params.cursor : null;
    const page = cursor === null ? 1 : Number(cursor.replace("c", ""));
    current.reply(request.id, { data: [{ id: `thread-${page}`, status: "notLoaded", source: "subAgent" }], nextCursor: `c${page + 1}` });
  });
  const { server } = registryServer(await initializedTransport(child));
  const paged = await server.call("continuity_codex_tasks_list", { page_limit: 2 }, "req-paged");
  assert.equal(paged.ok, false);
  assert.equal(paged.error?.code, "CURSOR_LOOP");
  assert.equal(paged.data.page_count, 2);
  assert.equal(paged.data.complete, false);
  assert.equal(paged.data.unique_thread_count, 2);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 2);

  const limited = await server.call("continuity_codex_tasks_list", { limit: 1 }, "req-limited");
  assert.equal(limited.ok, false);
  assert.equal(limited.error?.code, "CURSOR_LOOP");
  assert.equal(limited.data.page_count, 1);
  assert.equal(limited.data.complete, false);
  assert.equal(limited.data.unique_thread_count, 1);
  assert.equal(child.requests.filter((request) => request.method === "thread/list").length, 3);
});

test("continuity_codex_tasks_list returns an envelope fault when the thread/list RPC fails", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") current.error(request.id, "INTERNAL_ERROR", "boom");
  });
  const { server } = registryServer(await initializedTransport(child));
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-fault");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "INTERNAL_ERROR");
  assert.equal(envelope.error?.message.includes("boom"), true);
  assert.equal(envelope.error?.needs_human, false);
  assert.equal(envelope.error?.retryable, false);
  assert.equal(child.requests.filter((request) => request.id !== undefined).every((request) => request.method === "initialize" || request.method === "thread/list"), true);
});

test("continuity_codex_tasks_list never excludes a current thread id from a read-only list", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    current.reply(request.id, {
      data: [{ id: "current-task-thread", status: "notLoaded", source: "subAgent" }, { id: "current-task-thread", status: "notLoaded", source: "subAgent" }],
      nextCursor: null
    });
  });
  const { server } = registryServer(await initializedTransport(child));
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-current");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.data.unique_thread_count, 1);
  assert.equal((envelope.data.threads as Array<{ thread_id: string }>)[0]?.thread_id, "current-task-thread");
});

// ---------------------------------------------------------------------------
// Lazy start+initialize through the codexAppServerStdioLazy seam
// ---------------------------------------------------------------------------

test("continuity_codex_tasks_list never spawns the App Server child before its first call", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") {
      current.reply(request.id, { data: [], nextCursor: null });
    }
  });
  const stdio = childTransport(child);
  const { server, seam } = registryServer(stdio); // never-spawns test
  assert.ok(seam, "a lazy seam is present when a stdio transport is configured");
  assert.equal(stdio.lifecycle, "idle");
  // Every non-App-Server MCP tool must leave the child unstarted.
  const other = await server.call("continuity_task_list", {}, "req-other-before");
  assert.equal(other.ok, true);
  assert.equal(stdio.lifecycle, "idle");
  assert.equal(child.receivedSpecs.length, 0);
  assert.equal(child.requests.filter((request) => request.id !== undefined).length, 0);
  // tools/list does not even reach the server (it is served by main.ts), but
  // listTools() itself must never touch the seam either.
  const tools = server.listTools();
  assert.equal(tools.some((tool) => tool.name === "continuity_codex_tasks_list"), true);
  assert.equal(stdio.lifecycle, "idle");
  assert.equal(child.receivedSpecs.length, 0);
});

test("first continuity_codex_tasks_list call starts the child, initializes, and lists threads", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") {
      current.reply(request.id, { data: [{ id: "lazy-thread", status: "notLoaded", source: "subAgent" }], nextCursor: null });
    }
  });
  const { server, seam } = registryServer(childTransport(child));
  assert.ok(seam, "a lazy seam is present when a stdio transport is configured");
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-lazy-first");
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.error, null);
  assert.equal(envelope.data.complete, true);
  assert.equal(envelope.data.unique_thread_count, 1);
  assert.equal((envelope.data.threads as Array<{ thread_id: string }>)[0]?.thread_id, "lazy-thread");
  assert.deepEqual(envelope.data.actual_rpc_methods_observed, ["thread/list"]);
  // Exactly one child, one initialize RPC + initialized notification, then the
  // thread/list walk the tool actually requested.
  assert.equal(child.receivedSpecs.length, 1);
  const initializeRequests = child.requests.filter((request) => request.id !== undefined && request.method === "initialize");
  assert.equal(initializeRequests.length, 1);
  const listRequests = child.requests.filter((request) => request.id !== undefined && request.method === "thread/list");
  assert.equal(listRequests.length, 1);
  assert.equal(child.writes.filter((write) => write.includes('"method":"initialized"')).length, 1);
  assert.deepEqual(seam.stdio.lifecycle, "initialized");
});

test("second call reuses the initialized connection without spawning again", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") {
      current.reply(request.id, { data: [], nextCursor: null });
    }
  });
  const { server } = registryServer(childTransport(child));
  const first = await server.call("continuity_codex_tasks_list", {}, "req-reuse-1");
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await server.call("continuity_codex_tasks_list", {}, "req-reuse-2");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(child.receivedSpecs.length, 1);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "initialize").length, 1);
});

test("concurrent first calls single-flight onto one child and one initialize", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") {
      current.reply(request.id, { data: [], nextCursor: null });
    }
  });
  const { server } = registryServer(childTransport(child));
  const envelopes = await Promise.all([
    server.call("continuity_codex_tasks_list", {}, "req-race-1"),
    server.call("continuity_codex_tasks_list", {}, "req-race-2"),
    server.call("continuity_codex_tasks_list", {}, "req-race-3")
  ]);
  for (const envelope of envelopes) {
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.data.complete, true);
  }
  assert.equal(child.receivedSpecs.length, 1);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "initialize").length, 1);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "thread/list").length, 3);
});

test("continuity_codex_tasks_list fails closed when initialize fails and the next call retries", async () => {
  let fail = true;
  const child = new FixtureAppServerChild((request, current) => {
    if (request.method === "initialize") {
      if (fail) current.error(request.id, "INTERNAL_ERROR", "init exploded");
      else current.reply(request.id, initializeResult());
      return;
    }
    if (request.method === "thread/list") current.reply(request.id, { data: [], nextCursor: null });
  });
  const stdio = childTransport(child);
  const { server } = registryServer(stdio);
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-init-fail");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "INTERNAL_ERROR");
  assert.equal(envelope.error?.message.includes("init exploded"), true);
  assert.equal(envelope.error?.retryable, false);
  // Fail-closed: an initialize failure must not read as an empty registry.
  assert.equal(envelope.data.complete, false);
  assert.equal(envelope.data.unique_thread_count, 0);
  // The child stayed up for the failed handshake; a later call retries it.
  fail = false;
  const retry = await server.call("continuity_codex_tasks_list", {}, "req-init-retry");
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.data.complete, true);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "initialize").length, 2);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "thread/list").length, 1);
  await stdio.shutdown();
});

test("continuity_codex_tasks_list after an explicit shutdown never restarts the child and fails closed", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method === "thread/list") current.reply(request.id, { data: [], nextCursor: null });
  });
  const stdio = childTransport(child);
  const { server } = registryServer(stdio);
  const first = await server.call("continuity_codex_tasks_list", {}, "req-shutdown-1");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(stdio.lifecycle, "initialized");
  const shutdown = await stdio.shutdown();
  assert.equal(shutdown.ok, true);
  assert.equal(stdio.lifecycle, "closed");
  const after = await server.call("continuity_codex_tasks_list", {}, "req-shutdown-2");
  assert.equal(after.ok, false);
  assert.equal(after.error?.code, "APP_SERVER_NOT_STARTED");
  assert.equal(after.error?.retryable, false);
  assert.equal(after.error?.needs_human, false);
  assert.equal(after.data.complete, false);
  assert.equal(after.data.unique_thread_count, 0);
  // The closed child was never restarted and no further RPC was issued.
  assert.equal(child.receivedSpecs.length, 1);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "initialize").length, 1);
  assert.equal(child.requests.filter((request) => request.id !== undefined && request.method === "thread/list").length, 1);
});

test("continuity_codex_tasks_list fails closed when the child exits during its first call", async () => {
  const child = fixtureChild((request, current) => {
    if (request.method !== "thread/list") return;
    // The child dies while the first thread/list page is still pending: the
    // transport rejects the in-flight RPC with APP_SERVER_CHILD_EXITED instead
    // of completing the walk with a false-empty registry.
    current.exit({ code: 1, signal: null });
  });
  const { server } = registryServer(childTransport(child));
  const envelope = await server.call("continuity_codex_tasks_list", {}, "req-child-exit");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "APP_SERVER_CHILD_EXITED");
  assert.equal(envelope.error?.retryable, false);
  assert.equal(envelope.error?.needs_human, false);
  assert.equal(envelope.data.complete, false);
  assert.equal(envelope.data.page_count, 0);
  assert.equal(envelope.data.unique_thread_count, 0);
  // Exactly one spawn happened (no restart after the exit).
  assert.equal(child.receivedSpecs.length, 1);
});
