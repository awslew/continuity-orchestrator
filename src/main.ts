/**
 * Entrypoint for the single externally visible Continuity App (plan §8.3.3).
 *
 * Builds the local app from configuration and mounts it on stdio MCP.  The
 * app is fail-closed: every feature flag defaults off, production requires
 * explicit runtime configuration, and the real webgpt-drive transport is
 * refused until plan 4C contract evidence exists.  Mock transports are
 * available only through explicitly named test construction helpers.
 */

import { resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FeatureFlags } from "./flags.js";
import {
  parseRuntimeConfig,
  runtimeConfigFromEnvironment,
  type RuntimeConfig,
  type RuntimeProfile
} from "./runtime-config.js";
import { HandoffStore } from "./persistence/handoff-store.js";
import {
  FileLocalDurableStore,
  FileQuotaStore,
  FileRuntimeReceiptSink,
  FileWebgptDriveHttpStore
} from "./persistence/runtime-durable-stores.js";
import { Allowlist } from "./security/allowlist.js";
import { ConfirmationGateRegistry } from "./security/confirmations.js";
import { EvidenceWriter } from "./evidence/evidence-writer.js";
import { TaskCoordinator } from "./workflow/task-coordinator.js";
import { MockWebgptDriveTransport, WebgptDriveAdapter, type WebgptDriveTransport } from "./adapters/webgpt-drive.js";
import { WebgptDriveHttpTransport } from "./adapters/webgpt-drive-http.js";
import { CodexAppServerAdapter, type AppServerMethod, type AppServerTransport } from "./adapters/codex-app-server.js";
import { CodexAppServerStdioTransport, createCodexAppServerLazySeam, type AppServerRpcMethod, type CodexAppServerLazySeam } from "./adapters/codex-app-server-stdio.js";
import { ClaudeOrchestratorAdapter, ClaudeOrchestratorHttpTransport } from "./adapters/claude-orchestrator.js";
import { EngineeringBridgeAdapter } from "./adapters/engineering-bridge.js";
import { endpointFromStdioProcess, McpChildClient } from "./adapters/mcp-child.js";
import {
  LocalPatchBackend,
  LocalWorkerBackend,
  type LocalDurableStore,
  type LocalPatchTransport,
  type LocalWorkerBinding,
  type LocalWorkerBindingResolver,
  type LocalWorkerTransport
} from "./adapters/local-worker-backends.js";
import type { RealSessionRef } from "./adapters/adapter-types.js";
import { normalizeRateLimitsRead, normalizeRateLimitsUpdated, type NormalizedQuotaSnapshot } from "./quota/quota-normalizer.js";
import { ContinuityMcpServer } from "./mcp/server.js";
import type { QuotaProvider, WorkerControlBackend } from "./mcp/server.js";
import { FileRelayServerStore, type RelayServerStore } from "./persistence/runtime-durable-stores.js";
import { BridgeWorkerControlBackend } from "./adapters/bridge-worker-control.js";
import { WorkerSupervisionController } from "./workflow/supervision.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOL_INPUT_SCHEMAS, type ToolName } from "./mcp/schemas.js";

export interface ContinuityApp {
  readonly repositoryRoot: string;
  readonly runtimeProfile: RuntimeProfile;
  readonly runtimeConfig: RuntimeConfig;
  readonly flags: FeatureFlags;
  readonly allowlist: Allowlist;
  readonly confirmations: ConfirmationGateRegistry;
  readonly store: HandoffStore;
  readonly evidence: EvidenceWriter;
  readonly coordinator: TaskCoordinator;
  readonly webgpt: WebgptDriveAdapter;
  /** Present only when an explicit App Server stdio configuration exists. */
  readonly codexAppServer: CodexAppServerAdapter | null;
  readonly codexAppServerStdio: CodexAppServerStdioTransport | null;
  /** The lazy single-flight start/initialize gate; the child stays idle until its first use. */
  readonly codexAppServerStdioLazy: CodexAppServerLazySeam | null;
  readonly quotaStore: FileQuotaStore | null;
  /** Durable patch / idempotency / supervised-attempt registry (Plus relay). */
  readonly serverStore: RelayServerStore | null;
  /** Real worker-control seam; null means no control action is ever claimed. */
  readonly workerControl: WorkerControlBackend | null;
  /** B3 backends are injected here; they are never implicit mocks in production. */
  readonly workerBackend: LocalWorkerBackend | null;
  readonly patchBackend: LocalPatchBackend | null;
  /** Result of startup recovery; null when recovery was not requested. */
  readonly hydration: { restored: string[]; skipped: Array<{ taskId: string; reason: string }> } | null;
  readonly server: ContinuityMcpServer;
}

interface AppAssemblyOptions {
  repositoryRoot: string;
  flags: FeatureFlags;
  runtimeProfile: RuntimeProfile;
  runtimeConfig: RuntimeConfig;
  transport: WebgptDriveTransport;
  quotaProvider?: QuotaProvider;
  workerBackend?: LocalWorkerBackend | null;
  patchBackend?: LocalPatchBackend | null;
  codexAppServer?: CodexAppServerAdapter | null;
  codexAppServerStdioLazy?: CodexAppServerLazySeam | null;
  quotaStore?: FileQuotaStore | null;
  serverStore?: RelayServerStore | null;
  workerControl?: WorkerControlBackend | null;
  workerLedger?: LocalDurableStore | null;
  /**
   * Rebuild the in-memory task registry from persisted ledgers.  Deliberately
   * opt-in: the named test helper must stay empty and deterministic, while the
   * production path has to recover tasks that survived a process restart.
   */
  hydrateTasks?: boolean;
}
function assembleApp(options: AppAssemblyOptions): ContinuityApp {
  const { repositoryRoot, flags, transport, runtimeConfig } = options;
  const config = runtimeConfig;
  const store = new HandoffStore(repositoryRoot);
  const allowlist = new Allowlist();
  const evidence = new EvidenceWriter(repositoryRoot, config.maxEvidenceBytes);
  allowlist.registerWorkspace({ workspaceId: "default", root: repositoryRoot });
  const confirmations = new ConfirmationGateRegistry();
  const coordinator = new TaskCoordinator(store, allowlist, evidence);
  const webgpt = new WebgptDriveAdapter(transport);
  const server = new ContinuityMcpServer({
    coordinator,
    store,
    allowlist,
    confirmations,
    evidence,
    webgpt,
    flags,
    supervision: new WorkerSupervisionController(),
    ...(options.quotaProvider ? { quotaProvider: options.quotaProvider } : {}),
    ...(options.workerBackend ? { workerBackend: options.workerBackend } : {}),
    ...(options.patchBackend ? { patchBackend: options.patchBackend } : {}),
    ...(options.codexAppServer ? { codexAppServer: options.codexAppServer } : {}),
    ...(options.codexAppServerStdioLazy ? { codexAppServerStdioLazy: options.codexAppServerStdioLazy } : {}),
    ...(options.serverStore ? { serverStore: options.serverStore } : {}),
    ...(options.workerControl ? { workerControl: options.workerControl } : {}),
    ...(options.workerLedger ? { workerLedger: options.workerLedger } : {})
  });
  // Recovery is explicit and fail-closed: unreadable ledgers are reported in
  // the returned summary and skipped, never re-invented.
  const hydration = options.hydrateTasks === true ? coordinator.hydrate({ workspaceId: "default" }) : null;
  return {
    repositoryRoot,
    runtimeProfile: options.runtimeProfile,
    runtimeConfig,
    flags,
    allowlist,
    confirmations,
    store,
    evidence,
    coordinator,
    webgpt,
    codexAppServer: options.codexAppServer ?? null,
    codexAppServerStdio: options.codexAppServerStdioLazy?.stdio ?? null,
    codexAppServerStdioLazy: options.codexAppServerStdioLazy ?? null,
    quotaStore: options.quotaStore ?? null,
    serverStore: options.serverStore ?? null,
    workerControl: options.workerControl ?? null,
    workerBackend: options.workerBackend ?? null,
    patchBackend: options.patchBackend ?? null,
    hydration,
    server
  };
}

/**
 * Explicit test helper.  The mock is intentionally named and scoped to the
 * test profile; the CLI entrypoint below never calls it.
 */
export function buildTestApp(repositoryRoot: string, flags: FeatureFlags, transport: WebgptDriveTransport = new MockWebgptDriveTransport()): ContinuityApp {
  const runtimeConfig = parseRuntimeConfig({ profile: "test", repositoryRoot }, repositoryRoot);
  return assembleApp({ repositoryRoot, flags, runtimeProfile: "test", runtimeConfig, transport });
}

/**
 * Generic construction requires an explicit transport.  Keeping this narrow
 * alias avoids silently changing callers while removing the former implicit
 * mock fallback.
 */
export function buildApp(repositoryRoot: string, flags: FeatureFlags, transport: WebgptDriveTransport): ContinuityApp {
  if (!transport) throw new Error("buildApp requires an explicit transport; use buildTestApp for the named test mock");
  return assembleApp({ repositoryRoot, flags, runtimeProfile: "test", runtimeConfig: parseRuntimeConfig({ profile: "test", repositoryRoot }, repositoryRoot), transport });
}

export interface RuntimeBuildOverrides {
  /** Test-only transport injection. A mock is rejected for production. */
  webgptTransport?: WebgptDriveTransport;
  /** Test-only App Server transport injection. */
  appServerTransport?: AppServerTransport;
  /** Explicit worker/patch seams, normally assembled from runtime config. */
  workerTransport?: LocalWorkerTransport;
  patchTransport?: LocalPatchTransport;
  quotaProvider?: QuotaProvider;
  /** Test-only durable relay store, for restart/durability coverage. */
  serverStore?: RelayServerStore;
  /** Test-only opt-in to startup task recovery. */
  hydrateTasks?: boolean;
  /** Test-only Codex App Server injection (drain and resume paths). */
  codexAppServer?: CodexAppServerAdapter;
  /** Test-only worker-control seam injection. */
  workerControl?: WorkerControlBackend;
}

/**
 * Worker bindings for the local worker backend.
 *
 * `LocalWorkerBackend` refuses to synthesise a Claude session, a DSH checkpoint
 * or a Bridge workspace id, so without a binding every production worker call
 * fails `CLAUDE_SESSION_MISSING` / `WORKSPACE_ID_MISSING` and the relay has no
 * execution feedback at all.  The values are derived from what the runtime
 * already knows rather than invented:
 *   - the Bridge workspace id is unambiguous only when exactly one is
 *     configured; with several, no workspace is guessed and the bridge call
 *     fails closed by itself;
 *   - a Claude resume reuses the real session recorded by this task's own
 *     previous attempt — never a fabricated one;
 *   - a DSH fresh start uses the checkpoint the task's ledger persisted.
 */
function workerBindingResolver(params: {
  repositoryRoot: string;
  workspaceIds: readonly string[];
  durableStore: LocalDurableStore;
}): LocalWorkerBindingResolver {
  const store = new HandoffStore(params.repositoryRoot);
  return (taskId, kind) => {
    const binding: LocalWorkerBinding = {};
    const [onlyWorkspace] = params.workspaceIds;
    if (params.workspaceIds.length === 1 && onlyWorkspace) binding.workspaceId = onlyWorkspace;
    if (kind === "dsh" || kind === "bridge-dsh") {
      try {
        const checkpointRef = store.readState(taskId).checkpointRef;
        if (checkpointRef) binding.checkpointRef = checkpointRef;
      } catch {
        // No persisted ledger for this task yet: leave the field out and let
        // the backend report exactly which binding is missing.
      }
    }
    if (kind === "claude") {
      const session = latestClaudeSession(params.durableStore, taskId);
      if (session) binding.claudeSession = session;
    }
    return binding;
  };
}

/** The real Claude session this task already started, if any attempt recorded one. */
function latestClaudeSession(durableStore: LocalDurableStore, taskId: string): RealSessionRef | undefined {
  const recorded = durableStore
    .listWorkerAttempts()
    .filter((record) => record.receipt?.taskId === taskId && record.receipt?.realSessionRef?.kind === "real_session")
    // Newest first: a task that restarted its Claude session must resume the
    // latest one, not the first.
    .sort((left, right) => (left.receipt.createdAt < right.receipt.createdAt ? 1 : -1));
  return recorded[0]?.receipt.realSessionRef ?? undefined;
}

function envForChild(config: { env: Record<string, string | undefined>; envAllowlist: string[] }): Record<string, string> {  const result: Record<string, string> = {};
  for (const key of config.envAllowlist) {
    const value = config.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSuccessfulRpcResult(value: unknown): boolean {
  return !isRecord(value) || (value.ok !== false && (value.error === undefined || value.error === null));
}

function extractRpcResult(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "result") ? value.result : value;
}

function bridgeChild(config: NonNullable<RuntimeConfig["engineeringBridge"]>): McpChildClient {
  return new McpChildClient(
    () => {
      // The factory is lazy. Building a production app never starts the
      // Engineering Bridge child; the first explicitly requested operation
      // owns that side effect.
      const child = nodeSpawn(config.command, [...config.args], {
        cwd: config.cwd,
        env: envForChild(config),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      return endpointFromStdioProcess(child as unknown as Parameters<typeof endpointFromStdioProcess>[0]);
    },
    {
      requestTimeoutMs: config.requestTimeoutMs,
      autoNotifyInitialized: true,
      protocolVersion: "2025-06-18",
      clientName: "continuity-orchestrator",
      clientVersion: "0.1.0"
    }
  );
}

interface RuntimeAppServerAssembly {
  adapter: CodexAppServerAdapter | null;
  stdio: CodexAppServerStdioTransport | null;
  codexAppServerStdioLazy: CodexAppServerLazySeam | null;
  transport: AppServerTransport | null;
  quotaProvider: QuotaProvider | null;
}

function appServerAssembly(runtime: RuntimeConfig, overrides: RuntimeBuildOverrides, quotaStore: FileQuotaStore | null = null): RuntimeAppServerAssembly {
  if (overrides.appServerTransport) {
    let latest: NormalizedQuotaSnapshot | null = quotaStore?.get().snapshot ?? null;
    const transport: AppServerTransport = {
      ...(overrides.appServerTransport.capabilities ? { capabilities: overrides.appServerTransport.capabilities } : {}),
      async request(method, params, requestOptions) {
        const result = await overrides.appServerTransport!.request(method, params, requestOptions);
        if (method === "account/rateLimits/read" && quotaStore && isSuccessfulRpcResult(result)) {
          latest = normalizeRateLimitsRead({ method, result: extractRpcResult(result) }, { source: "app-server", ...(latest ? { previous: latest } : {}) });
          quotaStore.set(latest, result);
        }
        return result;
      }
    };
    const adapter = new CodexAppServerAdapter(transport, { source: "app-server" });
    // No stdio child exists in the overridden-transport path, so there is no
    // lazy stdio seam: the registry-listing tool stays fail-closed absent one.
    return { adapter, stdio: null, codexAppServerStdioLazy: null, transport, quotaProvider: overrides.quotaProvider ?? (quotaStore ? { snapshot: () => latest } : null) };
  }
  if (!runtime.appServer) return { adapter: null, stdio: null, codexAppServerStdioLazy: null, transport: null, quotaProvider: overrides.quotaProvider ?? null };
  const stdio = new CodexAppServerStdioTransport({
    command: runtime.appServer.command,
    args: runtime.appServer.args,
    cwd: runtime.appServer.cwd,
    env: runtime.appServer.env,
    envAllowlist: runtime.appServer.envAllowlist,
    inheritEnv: false,
    requestTimeoutMs: runtime.appServer.requestTimeoutMs,
    shutdownTimeoutMs: runtime.appServer.shutdownTimeoutMs,
    currentTaskId: runtime.appServer.currentTaskId,
    protectedTaskIds: runtime.appServer.protectedTaskIds
  });
  // One lazy gate owns this transport's single lifecycle.  Building the app
  // never starts the child: only the first explicit App Server operation
  // (quota request through the adapter wrapper, or the registry-listing tool)
  // triggers the start + initialize/initialized handshake, single-flighted.
  const codexAppServerStdioLazy = createCodexAppServerLazySeam(stdio);
  let latest: NormalizedQuotaSnapshot | null = quotaStore?.get().snapshot ?? null;
  const transport: AppServerTransport = {
    async request(method: AppServerMethod, params?: unknown, requestOptions?: { timeoutMs?: number }): Promise<unknown> {
      const ensured = await codexAppServerStdioLazy.ensureInitialized();
      if (!ensured.ok) return ensured;
      const receipt = await stdio.request(method as AppServerRpcMethod, params ?? {}, requestOptions?.timeoutMs === undefined ? {} : { timeoutMs: requestOptions.timeoutMs });
      if (method === "account/rateLimits/read" && receipt.ok) {
        latest = normalizeRateLimitsRead({ method, result: receipt.result }, { source: "app-server", ...(latest ? { previous: latest } : {}) });
        quotaStore?.set(latest, receipt);
      }
      return receipt;
    },
    capabilities: ["initialize", "thread/list", "thread/loaded/list", "thread/active/list", "account/rateLimits/read", "turn/interrupt", "thread/resume"]
  };
  stdio.onEvent((event) => {
    if (event.type === "notification" && event.method === "account/rateLimits/updated") {
      latest = normalizeRateLimitsUpdated(event.params, { source: "app-server", ...(latest ? { previous: latest } : {}) });
      quotaStore?.set(latest, event.params);
    }
  });
  const adapter = new CodexAppServerAdapter(transport, { source: "app-server", timeoutMs: runtime.appServer.requestTimeoutMs });
  return { adapter, stdio, codexAppServerStdioLazy, transport, quotaProvider: overrides.quotaProvider ?? { snapshot: () => latest } };
}

/**
 * Assemble the runtime-selected application. This is the only production
 * construction path: it creates real transport seams from explicit config,
 * while all external processes/network calls remain lazy until a tool call.
 */
export function buildAppFromRuntime(runtime: RuntimeConfig, overrides: RuntimeBuildOverrides = {}): ContinuityApp {
  const parsed = parseRuntimeConfig(runtime, runtime.repositoryRoot);
  if (parsed.profile === "test") {
    const testTransport = overrides.webgptTransport;
    if (!testTransport) throw new Error("test profile requires an explicit webgpt transport; use buildTestApp for the named test mock");
    return assembleApp({
      repositoryRoot: parsed.repositoryRoot,
      flags: parsed.flags,
      runtimeProfile: "test",
      runtimeConfig: parsed,
      transport: testTransport,
      ...(overrides.quotaProvider ? { quotaProvider: overrides.quotaProvider } : {}),
      // Opt-in only: a restart/durability test explicitly supplies its own
      // durable relay store; ordinary test apps stay empty and deterministic.
      ...(overrides.serverStore ? { serverStore: overrides.serverStore } : {}),
      ...(overrides.hydrateTasks ? { hydrateTasks: true } : {}),
      ...(overrides.codexAppServer ? { codexAppServer: overrides.codexAppServer } : {}),
      ...(overrides.workerControl ? { workerControl: overrides.workerControl } : {})
    });
  }
  if (overrides.webgptTransport?.kind === "mock") throw new Error("production profile rejects MockWebgptDriveTransport");
  if (!parsed.webgpt) throw new Error("production webgpt configuration is required");
  const webStore = new FileWebgptDriveHttpStore(parsed.stateDir, "webgpt-drive.store.json", { lockTimeoutMs: parsed.durableLockTimeoutMs });
  const webToken = parsed.webgpt.tokenEnv ? process.env[parsed.webgpt.tokenEnv] : undefined;
  const webTransport = overrides.webgptTransport ?? new WebgptDriveHttpTransport({
    baseUrl: parsed.webgpt.baseUrl,
    tabId: parsed.webgpt.tabId,
    timeoutMs: parsed.webgpt.timeoutMs,
    ...(parsed.webgpt.key ? { key: parsed.webgpt.key } : {}),
    ...(webToken === undefined ? {} : { token: webToken }),
    ...(parsed.webgpt.maxPayloadChars ? { maxPayloadChars: parsed.webgpt.maxPayloadChars } : {}),
    store: webStore
  });
  const quotaStore = new FileQuotaStore(parsed.stateDir, "quota-runtime.store.json", { lockTimeoutMs: parsed.durableLockTimeoutMs });
  const appServer = appServerAssembly(parsed, overrides, quotaStore);
  const durableStore = new FileLocalDurableStore(parsed.stateDir, "worker-runtime.store.json", { lockTimeoutMs: parsed.durableLockTimeoutMs });
  const receiptSink = new FileRuntimeReceiptSink(parsed.evidenceDir, "runtime-receipts.json", { lockTimeoutMs: parsed.durableLockTimeoutMs });
  let claudeAdapter: ClaudeOrchestratorAdapter | null = null;
  if (parsed.claude) {
    const claudeToken = parsed.claude.tokenEnv ? process.env[parsed.claude.tokenEnv] : undefined;
    const claudeTransport = new ClaudeOrchestratorHttpTransport({
      baseUrl: parsed.claude.baseUrl,
      replyPath: parsed.claude.replyPath,
      startPath: parsed.claude.startPath,
      timeoutMs: parsed.claude.timeoutMs,
      ...(claudeToken === undefined ? {} : { token: claudeToken })
    });
    claudeAdapter = new ClaudeOrchestratorAdapter({ transport: claudeTransport, externalAssetsStatus: "LOCATED", transportKind: "real" });
  }
  const bridgeAdapter = parsed.engineeringBridge ? new EngineeringBridgeAdapter({ child: bridgeChild(parsed.engineeringBridge), registeredWorkspaces: parsed.engineeringBridge.workspaceIds, evidenceLevel: "UNKNOWN" }) : null;
  const workerTransport: LocalWorkerTransport = {
    ...(overrides.workerTransport ?? {}),
    ...(claudeAdapter ? {
      claudeReply: async (request) => claudeAdapter!.resumeClaude({ session: { kind: "real_session", backend: "claude", source: "claude_orchestrator", jobId: request.jobId, sessionId: request.sessionId, threadId: request.threadId }, instruction_ref: request.instruction_ref, idempotency_key: request.idempotency_key }),
      dshFreshStart: async (request) => claudeAdapter!.startDshFresh({ instruction_ref: request.instruction_ref, checkpoint_ref: request.checkpoint_ref, idempotency_key: request.idempotency_key })
    } : {}),
    ...(bridgeAdapter ? { bridgeRunTask: async (request) => bridgeAdapter!.runTask(request) } : {})
  };
  const patchTransport: LocalPatchTransport = {
    ...(overrides.patchTransport ?? {}),
    ...(bridgeAdapter ? {
      propose: async (input) => bridgeAdapter!.generateControlledPatch(input),
      validate: async (input) => bridgeAdapter!.validateControlledPatch(input),
      apply: async (input) => bridgeAdapter!.applyControlledPatch(input),
      commit: async (input) => bridgeAdapter!.commitControlledPatch(input)
    } : {})
  };
  const workerBackend = new LocalWorkerBackend({
    transport: workerTransport,
    durableStore,
    receiptSink,
    evidenceLevel: "UNKNOWN",
    // Bindings are derived, never invented; an unresolvable field stays absent
    // and the backend reports exactly which one is missing.
    resolveBinding: workerBindingResolver({
      repositoryRoot: parsed.repositoryRoot,
      workspaceIds: parsed.engineeringBridge?.workspaceIds ?? [],
      durableStore
    })
  });
  const patchBackend = new LocalPatchBackend({ transport: patchTransport, durableStore, receiptSink, evidenceLevel: "UNKNOWN" });
  // Plus (relay) durable state: proposed patches, mutation-idempotency replays
  // and supervised worker attempts all have to outlive this process.
  const relayStore = new FileRelayServerStore(parsed.stateDir, "relay-runtime.store.json", { lockTimeoutMs: parsed.durableLockTimeoutMs });
  // The Bridge is the only worker kind with a real `control_task` upstream; a
  // Claude worker has no control seam, so it stays explicitly unsupported
  // rather than silently reporting a stop that never happened.
  const workerControl = bridgeAdapter ? new BridgeWorkerControlBackend(bridgeAdapter) : null;
  const quotaProvider = appServer.quotaProvider ?? overrides.quotaProvider ?? undefined;
  return assembleApp({
    repositoryRoot: parsed.repositoryRoot,
    flags: parsed.flags,
    runtimeProfile: "production",
    runtimeConfig: parsed,
    transport: webTransport,
    ...(quotaProvider ? { quotaProvider } : {}),
    workerBackend,
    patchBackend,
    codexAppServer: appServer.adapter,
    codexAppServerStdioLazy: appServer.codexAppServerStdioLazy,
    quotaStore,
    serverStore: relayStore,
    workerLedger: durableStore,
    ...(workerControl ? { workerControl } : {}),
    hydrateTasks: true
  });
}

/**
 * Precise JSON Schema for tools/list, derived from the authoritative zod
 * schema so advertised contracts can never drift from dispatch validation.
 * `$schema`/`$defs` bookkeeping is stripped because MCP inline schemas carry
 * no registry.
 */
function inputSchemaFor(tool: ToolName): Record<string, unknown> {
  const derived = zodToJsonSchema(TOOL_INPUT_SCHEMAS[tool]) as Record<string, unknown>;
  const { $schema: _schema, $defs: _defs, ...inline } = derived;
  return inline;
}

/** Mount the app on stdio MCP as exactly one server. */
export async function startStdio(app: ContinuityApp): Promise<Server> {
  const mcpServer = new Server(
    { name: "continuity-orchestrator", version: "0.1.0" },
    // The tools capability must be declared: the SDK refuses a tools/list
    // handler on a server that does not advertise it (startup would crash).
    { capabilities: { tools: {} }, instructions: "Continuity Orchestrator single App. Child MCP tools are not exposed." }
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: app.server.listTools().map((tool) => ({
      name: tool.name,
      description: `${tool.description}${tool.mutating ? " (mutating; requires idempotency key)" : ""}`,
      inputSchema: inputSchemaFor(tool.name)
    }))
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params.name ?? "");
    const result = await app.server.call(name, request.params.arguments ?? {}, `stdio_${Date.now().toString(36)}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.ok
    };
  });
  await mcpServer.connect(new StdioServerTransport());
  return mcpServer;
}

function entryEqualsThisModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.filename === resolve(entry);
  } catch {
    return false;
  }
}

if (entryEqualsThisModule()) {
  const repositoryRoot = process.env.CONTINUITY_REPOSITORY_ROOT ?? process.cwd();
  try {
    // The executable path is always profile-driven. With no explicit profile,
    // runtimeConfigFromEnvironment selects production and rejects missing
    // required transports instead of constructing a mock app.
    const runtime = runtimeConfigFromEnvironment(process.env, repositoryRoot);
    const app = buildAppFromRuntime(runtime);
    startStdio(app).catch((error) => {
      process.stderr.write(`continuity app failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`continuity app failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
