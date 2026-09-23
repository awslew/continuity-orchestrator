import assert from "node:assert/strict";
import test from "node:test";
import { McpChildClient, type McpChildEndpoint, type McpJsonRpcRequest } from "../../src/adapters/mcp-child.js";

class FakeChild implements McpChildEndpoint {
  readonly requests: McpJsonRpcRequest[] = [];
  private readonly messages = new Set<(value: unknown) => void>();
  private readonly stderrs = new Set<(value: string) => void>();
  private readonly exits = new Set<(value?: unknown) => void>();
  respondToCalls = true;
  respondToToolsList = true;

  send(request: McpJsonRpcRequest): void {
    this.requests.push(request);
    if (request.method === "initialize") {
      this.emit({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    } else if (request.method === "tools/list" && this.respondToToolsList) {
      this.emit({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "run_task" }, { name: "task_result" }] } });
    } else if (request.method === "tools/call" && this.respondToCalls) {
      this.emit({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
    }
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onStderr(listener: (value: string) => void): () => void {
    this.stderrs.add(listener);
    return () => this.stderrs.delete(listener);
  }

  onExit(listener: (value?: unknown) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  emit(value: unknown): void {
    for (const listener of this.messages) listener(value);
  }

  emitStderr(value: string): void {
    for (const listener of this.stderrs) listener(value);
  }

  exit(reason = "child crashed"): void {
    for (const listener of this.exits) listener(reason);
  }
}

test("injected child performs initialize/tools-list with monotonic JSON-RPC request IDs", async () => {
  const fake = new FakeChild();
  const client = new McpChildClient(() => fake, { requestTimeoutMs: 100 });
  const lifecycle = await client.initializeAndListTools();
  assert.equal(lifecycle.ok, true);
  assert.equal(lifecycle.initialize.status, "completed");
  assert.equal(lifecycle.tools.status, "completed");
  assert.deepEqual(fake.requests.map((request) => request.id), [1, 2]);
  assert.deepEqual(client.tools, [{ name: "run_task" }, { name: "task_result" }]);
});

test("timeout becomes unknown in-flight and restart is blocked until explicit reconciliation", async () => {
  let starts = 0;
  const fake = new FakeChild();
  const client = new McpChildClient(() => { starts += 1; return fake; }, { requestTimeoutMs: 15 });
  await client.initialize();
  fake.respondToCalls = false;
  const timedOut = await client.callTool("run_task", { workspace_id: "ws", instruction: "read" });
  assert.equal(timedOut.status, "unknown_in_flight");
  assert.equal(timedOut.ok, false);
  assert.deepEqual(client.unknownInFlightRequestIds, [2]);
  const beforeRestart = client.reconcileBeforeRestart();
  assert.equal(beforeRestart.ok, false);
  const restartBlocked = await client.restart();
  assert.equal(restartBlocked.ok, false);
  assert.equal(restartBlocked.status, "reconcile_required");
  assert.equal(starts, 1);
  const reconciled = client.reconcileUnknown(2, "bridge:task-result:observed");
  assert.equal(reconciled.ok, true);
  const restarted = await client.restart();
  assert.equal(restarted.ok, true);
  assert.equal(restarted.status, "restarted");
  assert.equal(starts, 2);
});

test("child exit resolves pending calls as unknown and does not blindly rerun them", async () => {
  let starts = 0;
  const fake = new FakeChild();
  const client = new McpChildClient(() => { starts += 1; return fake; }, { requestTimeoutMs: 100 });
  fake.respondToToolsList = false;
  await client.start();
  const pending = client.request("tools/list");
  fake.exit("simulated crash");
  const receipt = await pending;
  assert.equal(receipt.status, "unknown_in_flight");
  assert.equal(receipt.error?.code, "CHILD_EXITED");
  assert.deepEqual(client.unknownInFlightRequestIds, [1]);
  assert.equal(starts, 1);
  const restart = await client.restart();
  assert.equal(restart.ok, false);
  assert.equal(starts, 1);
});

test("stderr is retained only in redacted form and late responses cannot clear an unknown request", async () => {
  const fake = new FakeChild();
  const client = new McpChildClient(() => fake, { requestTimeoutMs: 10 });
  await client.start();
  fake.emitStderr("DEEPSEEK_API_KEY=super-secret Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  assert.equal(client.stderr.some((line) => line.includes("super-secret") || line.includes("abcdefghijklmnopqrstuvwxyz0123456789")), false);
  const pending = client.request("custom/operation");
  const timedOut = await pending;
  assert.equal(timedOut.status, "unknown_in_flight");
  fake.emit({ jsonrpc: "2.0", id: timedOut.requestId, result: { ok: true } });
  assert.deepEqual(client.unknownInFlightRequestIds, [timedOut.requestId]);
});

test("stderr redacts short credentials across case, spacing, quoting, and header forms", async () => {
  const fake = new FakeChild();
  const client = new McpChildClient(() => fake, { requestTimeoutMs: 10 });
  await client.start();
  const samples = [
    ["token=x", "x"],
    ["SESSION: 'y'", "y"],
    ["api_key = z", "z"],
    ["Cookie: j", "j"],
    ["Authorization: Bearer q", "q"],
    ["bearer m", "m"],
    ["session token: v", "v"]
  ] as const;
  for (const [line, secret] of samples) {
    fake.emitStderr(line);
    assert.equal(client.stderr.at(-1)?.includes(secret), false, line);
  }
});
