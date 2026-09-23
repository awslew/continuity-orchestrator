import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../src/domain/errors.js";
import { ENGINEERING_BRIDGE_TOOL_NAMES, EngineeringBridgeAdapter } from "../../src/adapters/engineering-bridge.js";
import { McpChildClient, type McpChildEndpoint, type McpJsonRpcRequest } from "../../src/adapters/mcp-child.js";

class FakeChild implements McpChildEndpoint {
  readonly requests: McpJsonRpcRequest[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly toolResponses = new Map<string, unknown>();
  private readonly structuredToolResponses = new Map<string, unknown>();

  setToolResponse(name: string, payload: unknown): void {
    this.toolResponses.set(name, payload);
  }

  setStructuredToolResponse(name: string, payload: unknown): void {
    this.structuredToolResponses.set(name, payload);
  }

  send(request: McpJsonRpcRequest): void {
    this.requests.push(request);
    if (request.method === "initialize") {
      this.emit({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
      return;
    }
    if (request.method === "tools/list") {
      this.emit({ jsonrpc: "2.0", id: request.id, result: { tools: ENGINEERING_BRIDGE_TOOL_NAMES.map((name) => ({ name })) } });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params as { name?: string };
      const name = params.name ?? "";
      if (this.structuredToolResponses.has(name)) {
        this.emit({ jsonrpc: "2.0", id: request.id, result: { structuredContent: this.structuredToolResponses.get(name) } });
        return;
      }
      const payload = this.toolResponses.get(name) ?? { status: "completed", evidence: ["receipt:fake"] };
      this.emit({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
    }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function makeAdapter(fake = new FakeChild()): { adapter: EngineeringBridgeAdapter; fake: FakeChild } {
  const child = new McpChildClient(() => fake, { requestTimeoutMs: 100 });
  return { adapter: new EngineeringBridgeAdapter(child, ["workspace-a"]), fake };
}

test("Bridge discovers the exact 13 tools and accepts only a registered workspace", async () => {
  const { adapter, fake } = makeAdapter();
  const discovery = await adapter.discoverTools();
  assert.equal(discovery.expectedCount, 13);
  assert.equal(discovery.exact, true);
  assert.deepEqual(discovery.missing, []);
  assert.deepEqual(discovery.extra, []);
  await assert.rejects(() => adapter.runTask({ workspace_id: "not-registered", instruction: "inspect", executor: "dsh" }), DomainError);
  assert.equal(fake.requests.filter((request) => request.method === "tools/call").length, 0);
});

test("Bridge run_task forwards explicit executor:dsh and creates an auditable attempt", async () => {
  const { adapter, fake } = makeAdapter();
  fake.setToolResponse("run_task", { task_id: "bridge-task-1", status: "running", evidence: ["receipt:run-1"] });
  const receipt = await adapter.runTask({ workspace_id: "workspace-a", instruction: "inspect only", executor: "dsh", task_id: "orchestrator-task", attempt_id: "attempt-1", idempotency_key: "run-1" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.kind, "bridge-dsh");
  assert.equal(receipt.continuation, "dsh_fresh");
  assert.equal(receipt.bridgeTaskId, "bridge-task-1");
  assert.equal(receipt.status, "running");
  assert.equal(receipt.idempotencyKey, "run-1");
  const call = fake.requests.find((request) => request.method === "tools/call");
  assert.deepEqual(call?.params, { name: "run_task", arguments: { workspace_id: "workspace-a", instruction: "inspect only", executor: "dsh" } });
});

test("Bridge relay calls reject missing/default executor before any child tool call", async () => {
  const { adapter, fake } = makeAdapter();
  await assert.rejects(() => adapter.runTask({ workspace_id: "workspace-a", instruction: "inspect" }), /explicit executor:dsh/);
  await assert.rejects(() => adapter.runTask({ workspace_id: "workspace-a", instruction: "inspect", executor: "codex" }), /explicit executor:dsh/);
  await assert.rejects(() => adapter.controlTask({ workspace_id: "workspace-a", task_id: "bridge-task-1", action: "accept" }), /explicit executor:dsh/);
  assert.equal(fake.requests.filter((request) => request.method === "tools/call").length, 0);
});

test("Bridge task_result maps review, partial output, and evidence-drop without upgrading mock evidence", async () => {
  const { adapter, fake } = makeAdapter();
  fake.setToolResponse("task_result", { task_id: "bridge-task-2", state: "waiting_for_supervisor_review", review_output: "review", evidence: ["receipt:review"] });
  const review = await adapter.taskResult({ workspace_id: "workspace-a", task_id: "bridge-task-2", executor: "dsh", attempt_id: "attempt-2" });
  assert.equal(review.status, "review");
  assert.equal(review.review?.status, "waiting_for_supervisor_review");
  assert.equal(review.evidenceLevel, "MOCK_PASS");

  fake.setToolResponse("task_result", { task_id: "bridge-task-2", state: "failed", partial_output: "partial", evidence: [{ ref: "receipt:partial" }], evidence_drop: { dropped: 2, reason: "bounded" } });
  const partial = await adapter.taskResult({ workspace_id: "workspace-a", task_id: "bridge-task-2", executor: "dsh", attempt_id: "attempt-2" });
  assert.equal(partial.status, "partial_output");
  assert.equal(partial.partialOutput, "partial");
  assert.equal(partial.evidenceDrop?.dropped, 2);
  assert.equal(partial.ok, false);
});

test("Bridge never reports payload failure as completed and recursively redacts receipt fields", async () => {
  const { adapter, fake } = makeAdapter();
  fake.setToolResponse("task_result", {
    task_id: "bridge-task-secret",
    status: "failed",
    output: "token=x",
    nested: { session: "s", cookie: "c", api_key: "k" },
    evidence: [{ ref: "authorization: Bearer q" }]
  });
  const receipt = await adapter.taskResult({ workspace_id: "workspace-a", task_id: "bridge-task-secret", executor: "dsh", attempt_id: "attempt-secret" });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.ok, false);
  assert.equal(JSON.stringify(receipt).includes("token=x"), false);
  assert.equal(JSON.stringify(receipt).includes('"session":"s"'), false);
  assert.equal(JSON.stringify(receipt).includes("authorization: Bearer q"), false);
  assert.match(JSON.stringify(receipt), /REDACTED/);

  fake.setToolResponse("task_result", { status: "partial_output", partial_output: "short" });
  const partial = await adapter.taskResult({ workspace_id: "workspace-a", task_id: "bridge-task-secret", executor: "dsh" });
  assert.equal(partial.status, "partial_output");
  assert.equal(partial.ok, false);

  fake.setToolResponse("task_result", { evidence_drop: { dropped: 1, reason: "bounded" } });
  const dropped = await adapter.taskResult({ workspace_id: "workspace-a", task_id: "bridge-task-secret", executor: "dsh" });
  assert.equal(dropped.status, "evidence_drop");
  assert.equal(dropped.ok, false);
});

test("Bridge redacts sensitive keys at every depth, including arrays, short/non-string values, cycles, and throwing accessors", async () => {
  const { adapter, fake } = makeAdapter();
  const payload: Record<string, unknown> = {
    status: "completed",
    nested: {
      API_KEY: "a",
      "refresh-token": 7,
      Authorization: { header: "Bearer q" },
      safe: "visible",
      values: [{ SESSION: false }, { password: null }, { "access_token": { value: "secret" } }]
    },
    stderr: ["token=x", { Cookie: "c" }],
    childReceipt: { details: { bearer: ["b", 1] } }
  };
  payload.self = payload;
  Object.defineProperty(payload, "throwingDetails", {
    enumerable: true,
    get() {
      throw new Error("token=getter-secret");
    }
  });
  fake.setStructuredToolResponse("submit_controlled_patch", payload);

  const receipt = await adapter.submitControlledPatch({ workspace_id: "workspace-a", base_head: "abc", diff: "diff" });
  assert.equal(receipt.ok, true);
  const data = receipt.data as Record<string, any>;
  assert.equal((data.nested as Record<string, unknown>).API_KEY, "[REDACTED]");
  assert.equal((data.nested as Record<string, unknown>)["refresh-token"], "[REDACTED]");
  assert.equal((data.nested as Record<string, unknown>).Authorization, "[REDACTED]");
  assert.equal((data.nested as Record<string, any>).safe, "visible");
  assert.equal(((data.nested as Record<string, any>).values[0] as Record<string, unknown>).SESSION, "[REDACTED]");
  assert.equal(((data.nested as Record<string, any>).values[1] as Record<string, unknown>).password, "[REDACTED]");
  assert.equal(((data.nested as Record<string, any>).values[2] as Record<string, any>).access_token, "[REDACTED]");
  assert.equal((data.stderr as any[])[0], "token=[REDACTED]");
  assert.equal(((data.stderr as any[])[1] as Record<string, unknown>).Cookie, "[REDACTED]");
  assert.equal(((data.childReceipt as Record<string, any>).details as Record<string, unknown>).bearer, "[REDACTED]");
  assert.equal(data.self, "[CIRCULAR_REDACTED]");
  assert.equal(data.throwingDetails, "[REDACTED]");
  const encoded = JSON.stringify(receipt);
  for (const secret of ['"API_KEY":"a"', "Bearer q", "token=x", "getter-secret", '"SESSION":false']) assert.equal(encoded.includes(secret), false, secret);

  const hostile = new Proxy({ status: "completed", details: { token: "proxy-secret" } }, {
    ownKeys() {
      throw new Error("uninspectable");
    },
    getOwnPropertyDescriptor() {
      throw new Error("uninspectable");
    }
  });
  fake.setStructuredToolResponse("validate_controlled_patch", hostile);
  const unsafe = await adapter.validateControlledPatch({ workspace_id: "workspace-a", patch_task_id: "patch-unsafe" });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.status, "failed");
  assert.equal(JSON.stringify(unsafe).includes("proxy-secret"), false);
});

test("controlled patch wrappers keep workspace registration and exact confirmations", async () => {
  const { adapter, fake } = makeAdapter();
  fake.setToolResponse("generate_controlled_patch", { task_id: "patch-1", base_head: "abc" });
  const proposal = await adapter.generateControlledPatch({ workspace_id: "workspace-a", change_request: "prepare a read-only diff", executor: "dsh" });
  assert.equal(proposal.ok, true);
  const generateCall = fake.requests.find((request) => request.method === "tools/call" && (request.params as { name?: string }).name === "generate_controlled_patch");
  assert.deepEqual(generateCall?.params, { name: "generate_controlled_patch", arguments: { workspace_id: "workspace-a", change_request: "prepare a read-only diff", executor: "dsh" } });
  await assert.rejects(() => adapter.applyControlledPatch({ workspace_id: "workspace-a", patch_task_id: "patch-1", confirmation: "apply" }), /exact confirmation APPLY/);
  await assert.rejects(() => adapter.commitControlledPatch({ workspace_id: "workspace-a", patch_task_id: "patch-1", message: "test", confirmation: "COMMIT NOW" }), /exact confirmation COMMIT/);
});
