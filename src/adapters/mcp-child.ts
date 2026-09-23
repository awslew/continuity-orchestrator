import type {
  ChildMcpOperation,
  ChildMcpReceipt,
  ChildMcpReconcileReceipt,
  ChildMcpStatus,
  StructuredAdapterError
} from "./adapter-types.js";
import {
  CHILD_MCP_RECEIPT_SCHEMA,
  structuredAdapterError
} from "./adapter-types.js";

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  /** JSON-RPC notifications intentionally omit an id. Request messages set it. */
  id?: number;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
}

/**
 * Small injected boundary around a JSON-RPC-over-STDIO child.  Tests can use
 * an in-memory endpoint; production wiring can adapt a Node ChildProcess via
 * `endpointFromStdioProcess` without changing the lifecycle logic.
 */
export interface McpChildEndpoint {
  send(request: McpJsonRpcRequest): void | Promise<void>;
  onMessage(listener: (message: unknown) => void): void | (() => void);
  onStderr?(listener: (chunk: string) => void): void | (() => void);
  onExit?(listener: (reason?: unknown) => void): void | (() => void);
  close?(): void | Promise<void>;
}

export type McpChildFactory = () => McpChildEndpoint | Promise<McpChildEndpoint>;

export interface McpChildOptions {
  factory?: McpChildFactory;
  spawn?: McpChildFactory;
  spawnChild?: McpChildFactory;
  requestTimeoutMs?: number;
  autoNotifyInitialized?: boolean;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
}

export interface McpChildRestartResult {
  ok: boolean;
  status: "restarted" | "reconcile_required" | "failed";
  generation: number;
  unknownRequestIds: number[];
  error: StructuredAdapterError | null;
  receipt: ChildMcpReceipt<null> | ChildMcpReconcileReceipt;
}

interface PendingRequest {
  request: McpJsonRpcRequest;
  operation: ChildMcpOperation;
  toolName: string | null;
  resolve: (receipt: ChildMcpReceipt) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface UnknownRequest {
  receipt: ChildMcpReceipt;
  lateResponseObserved: boolean;
}

type Unsubscribe = () => void;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_STDERR_LINES = 64;
const MAX_STDERR_LINE_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function redactedText(value: unknown): string {
  let text = typeof value === "string" ? value : String(value);
  const key = "(?:deepseek_api_key|openai_api_key|anthropic_api_key|api[_ -]?key|access[_ -]?token|session[_ -]?token|session|token|cookie|authorization|auth(?:[_ -]?token)?|secret|bearer)";
  // Redact the complete authorization/Bearer pair before the generic pass so
  // the credential is not left behind after only matching the scheme.
  text = text.replace(new RegExp(`[\"']?\\b(?:authorization|auth)\\b[\"']?\\s*(?::|=|\\s+)\\s*[\"']?(?:bearer\\s+)?[\"']?(?:\"[^\"]*\"|'[^']*'|(?!\\[REDACTED\\])[^\\s,;\\]}]+)[\"']?`, "gi"), (match) => {
    const label = match.match(/authorization|auth/i)?.[0] ?? "AUTHORIZATION";
    return `${label}=[REDACTED]`;
  });
  // Key/value, whitespace-delimited, JSON, and quoted forms. The value
  // matcher intentionally accepts one character; short secrets are secrets.
  text = text.replace(new RegExp(`[\"']?\\b${key}\\b[\"']?\\s*(?:(?:[:=]\\s*)|\\s+)(?:\"[^\"]*\"|'[^']*'|(?!\\[REDACTED\\])[^\\s,;\\]}]+)`, "gi"), (match) => {
    const label = match.match(new RegExp(key, "i"))?.[0] ?? "SECRET";
    return `${label}=[REDACTED]`;
  });
  text = text
    .replace(new RegExp(`([?&](?:key|token|secret|api[_ -]?key|access[_ -]?token|session(?:[_ -]?token)?|cookie)=)[^&#\\s]+`, "gi"), "$1[REDACTED]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[REDACTED]");
  return text.length > MAX_STDERR_LINE_LENGTH ? `${text.slice(0, MAX_STDERR_LINE_LENGTH)}…` : text;
}

function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) return redactedText(value.message);
  if (isRecord(value) && typeof value.message === "string") return redactedText(value.message);
  return redactedText(value);
}

function errorCode(value: unknown): string {
  if (value instanceof Error && value.name) return value.name.toUpperCase();
  if (isRecord(value)) {
    if (typeof value.code === "string") return value.code.toUpperCase();
    if (typeof value.name === "string") return value.name.toUpperCase();
  }
  return "MCP_CHILD_REQUEST_FAILED";
}

function errorStatus(code: string): "retryable" | "blocked" | "reconcile_required" | "unknown" {
  if (code.includes("TIMEOUT") || code === "ETIMEDOUT") return "retryable";
  if (["METHOD_NOT_FOUND", "CAPABILITY_UNAVAILABLE", "NOT_IMPLEMENTED"].includes(code)) return "blocked";
  if (["UNKNOWN_IN_FLIGHT", "IN_FLIGHT", "REQUEST_LOST", "CONNECTION_CLOSED", "CHILD_EXITED"].includes(code)) return "reconcile_required";
  return "unknown";
}

function operationFor(method: string): ChildMcpOperation {
  if (method === "initialize") return "initialize";
  if (method === "tools/list") return "tools/list";
  return "tools/call";
}

function parseMessage(value: unknown): McpJsonRpcResponse | null {
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed as McpJsonRpcResponse : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value as McpJsonRpcResponse : null;
}

function responseId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  if (typeof id === "string" && /^\d+$/.test(id)) {
    const parsed = Number(id);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function responseError(value: unknown, operation: string, fallbackCode = "MCP_CHILD_REQUEST_FAILED"): StructuredAdapterError | null {
  if (!isRecord(value) || value.error === undefined || value.error === null) return null;
  const error = value.error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code.toUpperCase() : fallbackCode;
  const message = isRecord(error) && typeof error.message === "string" ? redactedText(error.message) : "MCP child returned an error";
  return structuredAdapterError(code, errorStatus(code), message, operation);
}

function cloneStderr(lines: readonly string[]): string[] {
  return lines.map((line) => redactedText(line));
}

/**
 * A fail-closed MCP child client.  A timeout or child exit does not trigger a
 * retry: the call becomes `unknown_in_flight` and must be explicitly
 * reconciled before a restart can occur.
 */
export class McpChildClient {
  private readonly factory: McpChildFactory;
  private readonly timeoutMs: number;
  private readonly autoNotifyInitialized: boolean;
  private readonly protocolVersion: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private endpoint: McpChildEndpoint | null = null;
  private unsubscribers: Unsubscribe[] = [];
  private pending = new Map<number, PendingRequest>();
  private unknown = new Map<number, UnknownRequest>();
  private stderrLines: string[] = [];
  private nextRequestId = 1;
  private _generation = 0;
  private lifecycleState: "idle" | "running" | "initialized" | "exited" | "reconcile_required" = "idle";
  private _initialized = false;
  private _tools: unknown[] = [];

  constructor(factory: McpChildFactory, options?: Omit<McpChildOptions, "factory" | "spawn" | "spawnChild">);
  constructor(options: McpChildOptions);
  constructor(factoryOrOptions: McpChildFactory | McpChildOptions, options: Omit<McpChildOptions, "factory" | "spawn" | "spawnChild"> = {}) {
    const supplied = typeof factoryOrOptions === "function"
      ? { ...options, factory: factoryOrOptions }
      : factoryOrOptions;
    const factory = supplied.factory ?? supplied.spawn ?? supplied.spawnChild;
    if (typeof factory !== "function") throw new TypeError("McpChildClient requires an injected child factory");
    this.factory = factory;
    this.timeoutMs = Number.isFinite(supplied.requestTimeoutMs) && (supplied.requestTimeoutMs ?? 0) > 0 ? supplied.requestTimeoutMs! : DEFAULT_TIMEOUT_MS;
    this.autoNotifyInitialized = supplied.autoNotifyInitialized === true;
    this.protocolVersion = supplied.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.clientName = supplied.clientName ?? "continuity-orchestrator";
    this.clientVersion = supplied.clientVersion ?? "0.1.0";
  }

  get generation(): number {
    return this._generation;
  }

  get lifecycle(): string {
    return this.lifecycleState;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get tools(): unknown[] {
    return this._tools.map((tool) => tool);
  }

  get stderr(): string[] {
    return cloneStderr(this.stderrLines);
  }

  get pendingRequestIds(): number[] {
    return [...this.pending.keys()].sort((a, b) => a - b);
  }

  get unknownInFlightRequestIds(): number[] {
    return [...this.unknown.keys()].sort((a, b) => a - b);
  }

  hasUnknownInFlight(): boolean {
    return this.unknown.size > 0;
  }

  async start(): Promise<ChildMcpReceipt<null>> {
    if (this.unknown.size > 0 || this.lifecycleState === "reconcile_required") {
      return this.startReceipt(false, "reconcile_required", structuredAdapterError(
        "RECONCILE_REQUIRED",
        "reconcile_required",
        "MCP child has unknown in-flight requests; reconcile before starting or restarting",
        "start",
        { unknownRequestIds: this.unknownInFlightRequestIds }
      ));
    }
    if (this.endpoint) {
      return this.startReceipt(true, "started", null);
    }
    try {
      const endpoint = await this.factory();
      if (!endpoint || typeof endpoint.send !== "function" || typeof endpoint.onMessage !== "function") {
        throw new TypeError("Injected MCP child endpoint is incomplete");
      }
      this.endpoint = endpoint;
      this._initialized = false;
      this._tools = [];
      this.lifecycleState = "running";
      this.attach(endpoint);
      return this.startReceipt(true, "started", null);
    } catch (error) {
      const fault = structuredAdapterError(errorCode(error), errorStatus(errorCode(error)), safeErrorMessage(error), "start");
      this.lifecycleState = "exited";
      return this.startReceipt(false, "failed", fault);
    }
  }

  async initialize(params: unknown = {
    protocolVersion: this.protocolVersion,
    capabilities: {},
    clientInfo: { name: this.clientName, version: this.clientVersion }
  }): Promise<ChildMcpReceipt> {
    const receipt = await this.request("initialize", params);
    if (receipt.ok) {
      this._initialized = true;
      this.lifecycleState = "initialized";
      if (this.autoNotifyInitialized) this.notify("notifications/initialized", {});
    }
    return receipt;
  }

  async listTools(params: unknown = {}): Promise<ChildMcpReceipt<{ tools?: unknown[] }>> {
    if (!this._initialized) {
      return this.failedReceipt("tools/list", "tools/list", structuredAdapterError(
        "MCP_CHILD_NOT_INITIALIZED",
        "blocked",
        "MCP child initialize must succeed before tools/list",
        "tools/list"
      )) as ChildMcpReceipt<{ tools?: unknown[] }>;
    }
    const receipt = await this.request("tools/list", params);
    if (receipt.ok) {
      const result = receipt.result;
      if (isRecord(result) && Array.isArray(result.tools)) this._tools = [...result.tools];
      else this._tools = [];
    }
    return receipt as ChildMcpReceipt<{ tools?: unknown[] }>;
  }

  /** Naming aliases used by adapter callers that mirror the MCP method. */
  async toolsList(params: unknown = {}): Promise<ChildMcpReceipt<{ tools?: unknown[] }>> {
    return this.listTools(params);
  }

  async initializeAndListTools(): Promise<{ initialize: ChildMcpReceipt; tools: ChildMcpReceipt<{ tools?: unknown[] }>; ok: boolean }> {
    const initialize = await this.initialize();
    if (!initialize.ok) {
      const tools = this.failedReceipt("tools/list", "tools/list", structuredAdapterError(
        "MCP_CHILD_INITIALIZE_FAILED",
        "blocked",
        "tools/list was not attempted because initialize failed",
        "tools/list"
      )) as ChildMcpReceipt<{ tools?: unknown[] }>;
      return { initialize, tools, ok: false };
    }
    const tools = await this.listTools();
    return { initialize, tools, ok: tools.ok };
  }

  async discoverTools(): Promise<{ initialize: ChildMcpReceipt; tools: ChildMcpReceipt<{ tools?: unknown[] }>; ok: boolean }> {
    return this.initializeAndListTools();
  }

  async callTool(toolName: string, args: unknown = {}): Promise<ChildMcpReceipt> {
    if (!toolName || toolName.trim().length === 0) {
      return this.failedReceipt("tools/call", "tools/call", structuredAdapterError(
        "INVALID_TOOL_NAME",
        "blocked",
        "MCP tool name is required",
        "tools/call"
      ));
    }
    if (!this._initialized) {
      return this.failedReceipt("tools/call", toolName, structuredAdapterError(
        "MCP_CHILD_NOT_INITIALIZED",
        "blocked",
        "MCP child initialize must succeed before tools/call",
        "tools/call"
      ));
    }
    return this.request("tools/call", { name: toolName, arguments: args }, toolName);
  }

  async request(method: string, params: unknown = {}, toolName: string | null = null): Promise<ChildMcpReceipt> {
    if (!method || method.trim().length === 0) {
      return this.failedReceipt("tools/call", toolName, structuredAdapterError("INVALID_METHOD", "blocked", "MCP method is required", "tools/call"));
    }
    if (!this.endpoint) {
      const started = await this.start();
      if (!started.ok) return started as ChildMcpReceipt;
    }
    if (!this.endpoint) {
      return this.failedReceipt(operationFor(method), toolName, structuredAdapterError("MCP_CHILD_NOT_RUNNING", "blocked", "MCP child is not running", method));
    }
    const id = this.nextRequestId++;
    const request: McpJsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    const operation = operationFor(method);
    return await new Promise<ChildMcpReceipt>((resolve) => {
      const pending: PendingRequest = { request, operation, toolName, resolve, timer: undefined };
      this.pending.set(id, pending);
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        const fault = structuredAdapterError("MCP_CHILD_TIMEOUT", "reconcile_required", `${method} timed out; request outcome is unknown`, method, { requestId: id });
        const receipt = this.receipt(id, operation, method, toolName, "unknown_in_flight", false, null, fault);
        this.unknown.set(id, { receipt, lateResponseObserved: false });
        this.lifecycleState = "reconcile_required";
        resolve(receipt);
      }, this.timeoutMs);
      Promise.resolve(this.endpoint!.send(request)).catch((error: unknown) => {
        const current = this.pending.get(id);
        if (!current) return;
        if (current.timer !== undefined) clearTimeout(current.timer);
        this.pending.delete(id);
        const code = errorCode(error);
        const fault = structuredAdapterError(code, "reconcile_required", `${safeErrorMessage(error)}; request outcome is unknown`, method, { requestId: id });
        const receipt = this.receipt(id, operation, method, toolName, "unknown_in_flight", false, null, fault);
        this.unknown.set(id, { receipt, lateResponseObserved: false });
        this.lifecycleState = "reconcile_required";
        resolve(receipt);
      });
    });
  }

  /** Send a JSON-RPC notification. It has no response and no in-flight retry. */
  notify(method: string, params: unknown = {}): ChildMcpReceipt<null> {
    const operation: ChildMcpOperation = "notify";
    const receipt = this.receipt(null, operation, method, null, "completed", true, null, null);
    const endpoint = this.endpoint;
    if (!endpoint) {
      return {
        ...receipt,
        ok: false,
        status: "failed",
        error: structuredAdapterError("MCP_CHILD_NOT_RUNNING", "blocked", "MCP child is not running", method)
      };
    }
    const request: McpJsonRpcRequest = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    Promise.resolve(endpoint.send(request)).catch(() => {
      // Notifications have no response. The failure remains visible only as a
      // redacted lifecycle fact; no unsafe retry is attempted.
      this.lifecycleState = "reconcile_required";
    });
    return receipt;
  }

  reconcileBeforeRestart(): ChildMcpReconcileReceipt {
    const unknownIds = this.unknownInFlightRequestIds;
    const ok = unknownIds.length === 0;
    const error = ok ? null : structuredAdapterError(
      "RECONCILE_REQUIRED",
      "reconcile_required",
      "Unknown in-flight MCP requests require explicit reconciliation before restart",
      "reconcile",
      { unknownRequestIds: unknownIds }
    );
    return {
      schemaVersion: CHILD_MCP_RECEIPT_SCHEMA,
      operation: "reconcile",
      requestId: null,
      id: null,
      method: "reconcile",
      toolName: null,
      status: ok ? "completed" : "reconcile_required",
      ok,
      result: null,
      error,
      stderr: this.stderr,
      createdAt: nowIso(),
      generation: this._generation,
      unknownRequestIds: unknownIds,
      reconciledRequestIds: [],
      restartAllowed: ok
    };
  }

  /**
   * A caller must provide a durable external observation before an unknown
   * request can be removed from the reconcile set. This method never retries
   * the original request.
   */
  reconcileUnknown(requestId: number, evidenceRef: string): ChildMcpReconcileReceipt {
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || !evidenceRef || evidenceRef.trim().length === 0) {
      return this.reconcileReceipt(false, [], [], structuredAdapterError(
        "INVALID_RECONCILIATION",
        "blocked",
        "A positive request id and non-empty evidence reference are required",
        "reconcile"
      ));
    }
    if (!this.unknown.has(requestId)) {
      return this.reconcileReceipt(false, [], [], structuredAdapterError(
        "UNKNOWN_REQUEST_ID",
        "blocked",
        `No unknown in-flight request ${requestId} is awaiting reconciliation`,
        "reconcile",
        { requestId }
      ));
    }
    this.unknown.delete(requestId);
    if (this.unknown.size === 0) {
      this.lifecycleState = this.endpoint ? (this._initialized ? "initialized" : "running") : "exited";
    }
    return this.reconcileReceipt(true, [requestId], this.unknownInFlightRequestIds, null);
  }

  async restart(): Promise<McpChildRestartResult> {
    const preflight = this.reconcileBeforeRestart();
    if (!preflight.ok) {
      return {
        ok: false,
        status: "reconcile_required",
        generation: this._generation,
        unknownRequestIds: preflight.unknownRequestIds,
        error: preflight.error,
        receipt: preflight
      };
    }
    await this.closeEndpoint();
    this._generation += 1;
    this._initialized = false;
    this._tools = [];
    const started = await this.start();
    return {
      ok: started.ok,
      status: started.ok ? "restarted" : "failed",
      generation: this._generation,
      unknownRequestIds: this.unknownInFlightRequestIds,
      error: started.error,
      receipt: started
    };
  }

  async shutdown(): Promise<ChildMcpReconcileReceipt> {
    if (this.pending.size > 0) {
      for (const [id, pending] of this.pending) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.pending.delete(id);
        const fault = structuredAdapterError("CHILD_SHUTDOWN", "reconcile_required", "MCP child shutdown left request outcome unknown", pending.request.method, { requestId: id });
        const receipt = this.receipt(id, pending.operation, pending.request.method, pending.toolName, "unknown_in_flight", false, null, fault);
        this.unknown.set(id, { receipt, lateResponseObserved: false });
        pending.resolve(receipt);
      }
    }
    await this.closeEndpoint();
    if (this.unknown.size > 0) this.lifecycleState = "reconcile_required";
    return this.reconcileBeforeRestart();
  }

  private attach(endpoint: McpChildEndpoint): void {
    this.unsubscribers = [];
    const addUnsubscriber = (value: void | (() => void)): void => {
      if (typeof value === "function") this.unsubscribers.push(value);
    };
    addUnsubscriber(endpoint.onMessage((message) => this.handleMessage(message)));
    if (endpoint.onStderr) addUnsubscriber(endpoint.onStderr((chunk) => this.handleStderr(chunk)));
    if (endpoint.onExit) addUnsubscriber(endpoint.onExit((reason) => this.handleExit(reason)));
  }

  private handleMessage(value: unknown): void {
    const parsed = parseMessage(value);
    const id = responseId(parsed);
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) {
      const unknown = this.unknown.get(id);
      if (unknown) unknown.lateResponseObserved = true;
      return;
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(id);
    const fault = responseError(parsed, pending.request.method);
    const receipt = this.receipt(
      id,
      pending.operation,
      pending.request.method,
      pending.toolName,
      fault ? "failed" : "completed",
      !fault,
      parsed && Object.prototype.hasOwnProperty.call(parsed, "result") ? parsed.result : null,
      fault
    );
    pending.resolve(receipt);
  }

  private handleStderr(chunk: string): void {
    const lines = redactedText(chunk).split(/\r?\n/).filter((line) => line.length > 0);
    this.stderrLines.push(...lines.map((line) => redactedText(line)));
    if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines = this.stderrLines.slice(-MAX_STDERR_LINES);
  }

  private handleExit(reason: unknown): void {
    this.endpoint = null;
    this._initialized = false;
    this.lifecycleState = "exited";
    const detail = redactedText(reason === undefined ? "MCP child exited" : safeErrorMessage(reason));
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.pending.delete(id);
      const fault = structuredAdapterError("CHILD_EXITED", "reconcile_required", `${detail}; request outcome is unknown`, pending.request.method, { requestId: id });
      const receipt = this.receipt(id, pending.operation, pending.request.method, pending.toolName, "unknown_in_flight", false, null, fault);
      this.unknown.set(id, { receipt, lateResponseObserved: false });
      pending.resolve(receipt);
    }
    if (this.unknown.size > 0) this.lifecycleState = "reconcile_required";
  }

  private async closeEndpoint(): Promise<void> {
    const endpoint = this.endpoint;
    this.endpoint = null;
    const unsubscribers = this.unsubscribers;
    this.unsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* injected cleanup is best effort */ }
    }
    if (endpoint?.close) {
      try { await endpoint.close(); } catch { /* close failures are represented by later state */ }
    }
    if (this.unknown.size === 0) this.lifecycleState = "idle";
  }

  private startReceipt(ok: boolean, status: ChildMcpStatus, error: StructuredAdapterError | null): ChildMcpReceipt<null> {
    return this.receipt(null, "start", "start", null, status, ok, null, error);
  }

  private failedReceipt(method: string, toolName: string | null, error: StructuredAdapterError): ChildMcpReceipt {
    return this.receipt(null, operationFor(method), method, toolName, "failed", false, null, error);
  }

  private receipt<T>(requestId: number | null, operation: ChildMcpOperation, method: string, toolName: string | null, status: ChildMcpStatus, ok: boolean, result: T | null, error: StructuredAdapterError | null): ChildMcpReceipt<T> {
    return {
      schemaVersion: CHILD_MCP_RECEIPT_SCHEMA,
      requestId,
      id: requestId,
      operation,
      method,
      toolName,
      status,
      ok,
      result,
      error,
      stderr: this.stderr,
      createdAt: nowIso(),
      generation: this._generation
    };
  }

  private reconcileReceipt(ok: boolean, reconciledRequestIds: number[], unknownRequestIds: number[], error: StructuredAdapterError | null): ChildMcpReconcileReceipt {
    return {
      schemaVersion: CHILD_MCP_RECEIPT_SCHEMA,
      operation: "reconcile",
      requestId: null,
      id: null,
      method: "reconcile",
      toolName: null,
      status: ok ? "completed" : "reconcile_required",
      ok,
      result: null,
      error,
      stderr: this.stderr,
      createdAt: nowIso(),
      generation: this._generation,
      unknownRequestIds,
      reconciledRequestIds,
      restartAllowed: ok && unknownRequestIds.length === 0
    };
  }
}

export type McpChildSession = McpChildClient;
export type McpChildTransport = McpChildClient;

/** Minimal shape accepted from Node's ChildProcess without importing its type. */
export interface NodeStdioProcessLike {
  stdin?: { write(data: string): unknown };
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  on?(event: "exit" | "close" | "error", listener: (value?: unknown) => void): unknown;
  kill?(signal?: string): unknown;
}

/** Adapt a Node ChildProcess to the injected endpoint contract. */
export function endpointFromStdioProcess(process: NodeStdioProcessLike): McpChildEndpoint {
  if (!process.stdin || !process.stdout) throw new TypeError("STDIO process requires stdin and stdout");
  const messageHandlers = new Set<(message: unknown) => void>();
  const stderrHandlers = new Set<(chunk: string) => void>();
  const exitHandlers = new Set<(reason?: unknown) => void>();
  let buffer = "";
  let exited = false;
  const notifyExit = (reason?: unknown): void => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(reason);
  };
  process.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) for (const handler of messageHandlers) handler(line);
      newline = buffer.indexOf("\n");
    }
  });
  process.stderr?.on("data", (chunk) => {
    const value = typeof chunk === "string" ? chunk : String(chunk);
    for (const handler of stderrHandlers) handler(value);
  });
  process.on?.("exit", (value) => notifyExit(value));
  process.on?.("close", (value) => notifyExit(value));
  process.on?.("error", (value) => notifyExit(value));
  return {
    send(request) {
      process.stdin!.write(`${JSON.stringify(request)}\n`);
    },
    onMessage(listener) {
      messageHandlers.add(listener);
      return () => messageHandlers.delete(listener);
    },
    onStderr(listener) {
      stderrHandlers.add(listener);
      return () => stderrHandlers.delete(listener);
    },
    onExit(listener) {
      exitHandlers.add(listener);
      return () => exitHandlers.delete(listener);
    },
    close() {
      process.kill?.();
    }
  };
}

export function nodeStdioFactory(spawn: () => NodeStdioProcessLike): McpChildFactory {
  return () => endpointFromStdioProcess(spawn());
}
