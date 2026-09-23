import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTestApp, buildAppFromRuntime } from "../../src/main.js";
import { MockWebgptDriveTransport } from "../../src/adapters/webgpt-drive.js";
import { MockAppServerTransport } from "../../src/adapters/codex-app-server.js";
import { parseRuntimeConfig } from "../../src/runtime-config.js";
import { DEFAULT_FLAGS } from "../../src/flags.js";
import { FileQuotaStore, FileWebgptDriveHttpStore, FileRuntimeReceiptSink } from "../../src/persistence/runtime-durable-stores.js";
import type { HttpTransportSendResult } from "../../src/adapters/webgpt-drive-http.js";

function root(prefix: string): string {
  return mkdtempSync(join(process.env.TEMP ?? ".", prefix));
}

function productionConfig(repositoryRoot: string) {
  return parseRuntimeConfig({
    profile: "production",
    repositoryRoot,
    stateDir: join(repositoryRoot, "state"),
    evidenceDir: join(repositoryRoot, "evidence"),
    webgpt: { baseUrl: "http://127.0.0.1:4173", tabId: "continuity-test", timeoutMs: 1_000 },
    appServer: { command: "codex", args: ["app-server"], cwd: repositoryRoot, env: {}, envAllowlist: [], requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, protectedTaskIds: [] },
    flags: { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true }
  }, repositoryRoot);
}

test("named buildTestApp is the explicit test-profile mock helper", () => {
  const app = buildTestApp(root("continuity-test-helper-"), { ...DEFAULT_FLAGS, CONTINUITY_ORCHESTRATOR_ENABLED: true });
  assert.equal(app.runtimeProfile, "test");
  assert.equal(app.webgpt.sessionReceipt("missing"), null);
});

test("test runtime assembly without an explicit transport fails closed", () => {
  assert.throws(() => buildAppFromRuntime(parseRuntimeConfig({ profile: "test", repositoryRoot: root("continuity-test-no-transport-") })), /explicit webgpt transport/);
  const app = buildAppFromRuntime(parseRuntimeConfig({ profile: "test", repositoryRoot: root("continuity-test-explicit-transport-") }), { webgptTransport: new MockWebgptDriveTransport() });
  assert.equal(app.runtimeProfile, "test");
});

test("production assembly has real web/App Server seams and no mock worker fallback", async () => {
  const repositoryRoot = root("continuity-production-wiring-");
  const app = buildAppFromRuntime(productionConfig(repositoryRoot));
  assert.equal(app.runtimeProfile, "production");
  assert.equal(app.codexAppServer !== null, true);
  assert.equal(app.codexAppServerStdio !== null, true);
  assert.equal(app.workerBackend !== null, true);
  assert.equal(app.patchBackend !== null, true);
  // Capability remains fail-closed until real 4C receipt evidence exists; the
  // request must not reach the loopback relay merely by constructing the app.
  const result = await app.webgpt.createOrAttach("task-production");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "WEB_CONTRACT_GAP");
});

test("B1 durable mapping and receipts survive a second store instance", () => {
  const stateDir = root("continuity-web-store-");
  const first = new FileWebgptDriveHttpStore(stateDir);
  first.setChatId("task-1", "chat-1");
  first.setCursor("chat-1", "cursor-2");
  const send: HttpTransportSendResult = { clientOperationId: "op-1", upstreamMessageId: "msg-1", sendReceiptId: "send-1", completeReceiptId: "complete-1", pageState: "loaded", quota: "none", observedChatId: "chat-1" };
  first.setSend("idem-1", send);
  const second = new FileWebgptDriveHttpStore(stateDir);
  assert.equal(second.getChatId("task-1"), "chat-1");
  assert.equal(second.getCursor("chat-1"), "cursor-2");
  assert.deepEqual(second.getSend("idem-1"), send);
  assert.ok(readFileSync(first.filePath, "utf8").includes("continuity.runtime-web-store.v1"));
});

test("runtime receipt sink appends atomically across instances", () => {
  const evidenceDir = root("continuity-receipts-");
  const first = new FileRuntimeReceiptSink(evidenceDir);
  first.append({ schemaVersion: "continuity.local-worker-receipt.v1", requestId: "r1", idempotencyKey: "i1", attemptId: "a1", taskId: "t1", workerKind: "dsh", source: "claude_orchestrator", executor: "dsh", operation: "claude_code_start", continuation: "dsh_fresh", status: "failed", ok: false, realJobId: null, realSessionRef: null, freshTurnRef: null, bridgeTaskId: null, inputRefs: [], outputRefs: [], deliverable: null, evidenceRefs: [], error: null, evidenceLevel: "UNKNOWN", createdAt: new Date().toISOString() });
  const second = new FileRuntimeReceiptSink(evidenceDir);
  assert.equal(second.list().length, 1);
  second.append({ schemaVersion: "continuity.local-worker-receipt.v1", requestId: "r2", idempotencyKey: "i2", attemptId: "a2", taskId: "t1", workerKind: "dsh", source: "claude_orchestrator", executor: "dsh", operation: "claude_code_start", continuation: "dsh_fresh", status: "failed", ok: false, realJobId: null, realSessionRef: null, freshTurnRef: null, bridgeTaskId: null, inputRefs: [], outputRefs: [], deliverable: null, evidenceRefs: [], error: null, evidenceLevel: "UNKNOWN", createdAt: new Date().toISOString() });
  assert.equal(first.list().length, 2, "a second store instance must not lose the first append");
});

test("runtime stores recover only an auditable expired lock and bound active-lock waits", () => {
  const stateDir = root("continuity-runtime-lock-");
  const lockDir = join(stateDir, ".continuity-runtime.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: "continuity.runtime-lock.v1", owner: "dead-owner", pid: 1, createdAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString() }));
  // Recovery performs several real filesystem checks; use the normal budget.
  // The short deadline below tests contention, not disk throughput.
  const store = new FileWebgptDriveHttpStore(stateDir, "web.json");
  store.setChatId("task-lock", "chat-lock");
  assert.equal(store.getChatId("task-lock"), "chat-lock");
  assert.ok(readdirSync(stateDir).some((name) => name.startsWith(".continuity-runtime.lock.stale.")), "stale lock metadata remains auditable");

  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: "continuity.runtime-lock.v1", owner: "live-owner", pid: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const contendedStore = new FileWebgptDriveHttpStore(stateDir, "web.json", { lockTimeoutMs: 50 });
  assert.throws(() => contendedStore.setCursor("chat-lock", "cursor-lock"), /lock acquisition timed out/);
  rmSync(lockDir, { recursive: true, force: true });
});

test("runtime store rejects a symlink/junction below the canonical root", (t) => {
  const stateDir = root("continuity-runtime-link-");
  const outside = root("continuity-runtime-outside-");
  const link = join(stateDir, "linked");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip(`platform ${process.platform} cannot create a test link without elevated privileges`);
    return;
  }
  assert.throws(() => new FileWebgptDriveHttpStore(stateDir, "linked/web.json"), /symlink|reparse|outside canonical root/);
});

test("quota sample and receipt persist across runtime instances and stale data remains visible to the guard", async () => {
  const repositoryRoot = root("continuity-quota-runtime-");
  const config = productionConfig(repositoryRoot);
  const updatedAt = new Date().toISOString();
  const response = {
    result: {
      updatedAt,
      primary: { windowId: "primary-1", remainingPercent: 40, usedPercent: 60, updatedAt, resetsAt: new Date(Date.now() + 60_000).toISOString() },
      secondary: { windowId: "secondary-1", remainingPercent: 80, usedPercent: 20, updatedAt, resetsAt: new Date(Date.now() + 60_000).toISOString() }
    }
  };
  const transport = new MockAppServerTransport({ "account/rateLimits/read": response }, ["account/rateLimits/read"]);
  const first = buildAppFromRuntime(config, { appServerTransport: transport });
  const observed = await first.codexAppServer!.readRateLimits();
  assert.equal(observed.status, "fresh");
  const second = buildAppFromRuntime(config, { appServerTransport: new MockAppServerTransport({}) });
  const persisted = second.quotaStore?.get();
  assert.equal(persisted?.snapshot?.sampleId, observed.sampleId);
  assert.equal(JSON.stringify(persisted?.receipt).includes("Bearer"), false);
  assert.ok(existsSync(new FileQuotaStore(config.stateDir).filePath));
});
