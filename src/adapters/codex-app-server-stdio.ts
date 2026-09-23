import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { normalizeRateLimitsRead, normalizeRateLimitsUpdated, type NormalizedQuotaSnapshot } from "../quota/quota-normalizer.js";

/**
 * Local JSON-RPC transport for the Codex App Server child process.
 *
 * This module is deliberately independent from the existing injected adapter:
 * it owns the child lifecycle, NDJSON framing, correlation, and the handful of
 * fail-closed probes needed by the handoff drain.  No network, browser, or
 * worker fallback is hidden behind this transport.
 */

export const APP_SERVER_PROTOCOL_VERSION = "2025-06-18" as const;

export type AppServerLifecycle = "idle" | "running" | "initialized" | "closing" | "closed" | "reconcile_required";

export type AppServerRpcMethod =
  | "initialize"
  | "thread/list"
  | "thread/loaded/list"
  | "thread/active/list"
  | "account/rateLimits/read"
  | "turn/interrupt"
  | "thread/resume";

export interface EnsureInitializedReceipt extends AppServerRpcReceipt {
  operation: "ensure_initialized";
  /**
   * True when this call joined an already-running attempt (or an already
   * initialized connection): the caller did not trigger the child start, so
   * its audit trail must not claim ownership of the spawn.
   */
  reused?: boolean;
  /**
   * Identity of the child instance backing this call, present on ok receipts.
   * A counter assigned per spawn — no pid is exposed because the endpoint
   * interface deliberately carries no process handle.
   */
  childInstanceId?: string;
}

/**
 * The single lazy start+initialize gate shared by every caller that must speak
 * to an App Server child on demand.  Exactly one lifecycle exists on the
 * transport: this seam serializes concurrent first calls onto one in-flight
 * start/initialize, and every failure is returned as a structured receipt
 * (never thrown) so callers fail closed instead of fabricating success.
 */
export interface CodexAppServerLazySeam {
  /** The transport the seam owns.  Its lifecycle stays idle until the first ensure. */
  readonly stdio: CodexAppServerStdioTransport;
  /**
   * Starts the child and completes the initialize/initialized handshake exactly
   * once for the first caller; concurrent first callers await the same attempt
   * and later callers reuse the initialized connection.  Failures are returned
   * as `{ok: false}` receipts and remain retryable on a later call unless the
   * lifecycle was explicitly terminated (closed) or demands reconciliation.
   *
   * Ownership is observable: exactly one receipt in a concurrent burst carries
   * `reused: false` (the caller whose call actually triggered the spawn);
   * every other receipt says `reused: true`.
   */
  ensureInitialized(): Promise<EnsureInitializedReceipt>;
}

export interface AppServerRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: AppServerRpcMethod;
  params?: unknown;
}

export interface AppServerRpcNotification {
  jsonrpc: "2.0";
  method: "initialized";
  params?: unknown;
}

export interface AppServerRpcResponse {
  jsonrpc?: unknown;
  id?: number | string | null;
  /** Optional diagnostic echo accepted only when it matches the pending method. */
  method?: string;
  result?: unknown;
  error?: unknown;
}

export interface AppServerStdioSpawnSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Only keys in envAllowlist are copied into the child environment. */
  env: Readonly<Record<string, string>>;
  envAllowlist: readonly string[];
}

export interface AppServerStdioEndpoint {
  write(data: string): void | Promise<void>;
  onStdout(listener: (chunk: unknown) => void): void | (() => void);
  onStderr?(listener: (chunk: unknown) => void): void | (() => void);
  onExit?(listener: (reason?: unknown) => void): void | (() => void);
  close?(): void | Promise<void>;
  kill?(signal?: string): void | Promise<void>;
}

export type AppServerStdioSpawn = (spec: AppServerStdioSpawnSpec) => AppServerStdioEndpoint | Promise<AppServerStdioEndpoint>;

export interface AppServerStdioOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Values supplied by the caller. They are never inherited implicitly. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Explicit allowlist for values copied from env and, optionally, process.env. */
  envAllowlist?: readonly string[];
  /** When true, only allowlisted names may be read from process.env. */
  inheritEnv?: boolean;
  spawn?: AppServerStdioSpawn;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  currentTaskId?: string | null;
  protectedTaskIds?: readonly string[];
}

export type AppServerEvent =
  | { type: "spawn"; at: string; command: string; args: string[]; cwd: string | null; envKeys: string[] }
  | { type: "request"; at: string; requestId: number; method: string }
  | { type: "notification"; at: string; method: string; params: unknown }
  | { type: "response"; at: string; requestId: number; method: string; ok: boolean; result: unknown; error: unknown }
  | { type: "stderr"; at: string; text: string }
  | { type: "malformed_stdout"; at: string; text: string }
  | { type: "unknown_response"; at: string; responseId: string | number | null }
  | { type: "timeout"; at: string; requestId: number; method: string }
  | { type: "exit"; at: string; reason: unknown }
  | { type: "shutdown"; at: string; status: "closed" | "timeout" | "not_running"; pendingRequestIds: number[] };

export type AppServerEventListener = (event: AppServerEvent) => void;

export interface AppServerFault {
  code:
    | "INVALID_SPAWN_SPEC"
    | "APP_SERVER_NOT_STARTED"
    | "APP_SERVER_NOT_INITIALIZED"
    | "APP_SERVER_TIMEOUT"
    | "APP_SERVER_CHILD_EXITED"
    | "APP_SERVER_SHUTDOWN"
    | "APP_SERVER_REQUEST_FAILED"
    | "APP_SERVER_ERROR"
    | "APP_SERVER_LIST_SHAPE_INVALID"
    | "CURSOR_LOOP"
    | "DUPLICATE_THREAD_ID"
    | "DRAIN_SCOPE_UNKNOWN"
    | "CONTROL_GUARD_REQUIRED"
    | "CURRENT_TASK_PROTECTED"
    | "PROTECTED_TASK"
    | "DEDICATED_TASK_REQUIRED"
    | "TARGET_GUARD_MISMATCH"
    | "INVALID_TARGET"
    | "RECEIPT_INVALID"
    | "RECEIPT_ID_MISMATCH"
    | "RECONCILE_REQUIRED"
    | string;
  message: string;
  operation: string;
  requestId: number | null;
  at: string;
}

export interface AppServerRpcReceipt<T = unknown> {
  ok: boolean;
  operation: string;
  requestId: number | null;
  responseId: number | string | null;
  result: T | null;
  error: AppServerFault | null;
}

export interface ThreadRecord {
  threadId: string;
  turnId: string | null;
  projectId: string | null;
  repositoryId: string | null;
  status: string | null;
  sourceKind: string | null;
}

export interface RegistryListResult {
  ok: boolean;
  scope: "registry";
  complete: boolean;
  threads: ThreadRecord[];
  pages: number;
  cursors: string[];
  duplicateThreadIds: string[];
  fault: AppServerFault | null;
}

/**
 * Per-page enumeration metadata for the read-only tool contract.  The tool
 * returns `thread/list` pages verbatim: every page is identified by the cursor
 * that requested it and the cursor the server handed back.
 */
export interface RegistryPageProbe {
  index: number;
  inputCursor: string | null;
  outputCursor: string | null;
  itemCount: number;
}

/**
 * Optional per-page observer: invoked synchronously after a page is parsed
 * and pushed into `pages`, before the loop decides to continue or stop.
 * Lets the caller emit ordered audit events with the exact page the walk
 * is about to judge (in particular its terminality), so the audit stream
 * cannot disagree with the RPCs actually observed.
 */
export interface ToolRegistryListOptions {
  limit?: number | null;
  pageLimit?: number | null;
  onPage?: (page: RegistryPageProbe) => void;
}

/**
 * Structured result of a read-only `thread/list` enumeration over the registry
 * scope.  Deliberately richer than RegistryListResult: identical cross-page
 * thread records are merged (the canonical-equal dedupe the tool contract
 * requires) instead of failing, but any same-id field conflict still fails
 * closed, and every completed page is reported so the caller can prove how
 * many thread/list RPCs were actually observed.
 */
export interface ToolRegistryListResult {
  ok: boolean;
  scope: "registry";
  complete: boolean;
  threads: ThreadRecord[];
  /** One entry per completed page, in request order. */
  pages: RegistryPageProbe[];
  /** Distinct cursors handed back by the server, in request order. */
  cursors: string[];
  /** thread ids that appeared more than once with identical safe fields; merged (deduped) without failure. */
  duplicateThreadIds: string[];
  /**
   * thread ids seen twice with conflicting fields.  Always empty on results
   * returned with `ok: true`; on a CONFLICTING_THREAD_RECORD failure the fault
   * message names the offending id.  Deliberately not a per-fault payload list:
   * the enumerated records themselves are the data, faults carry only
   * redacted {code, message} and the code tells the caller everything.
   */
  conflictingThreadIds: string[];
  actualRpcMethodsObserved: ["thread/list"];
  fault: AppServerFault | null;
}

export interface ScopeProbeResult {
  ok: boolean;
  method: "thread/loaded/list" | "thread/active/list";
  capability: "present" | "absent" | "unverified";
  known: boolean;
  scope: "loaded_active" | "active" | "unknown";
  threads: ThreadRecord[];
  pages: number;
  fault: AppServerFault | null;
}

export interface RateLimitsResult {
  ok: boolean;
  requestId: number | null;
  snapshot: NormalizedQuotaSnapshot;
  fault: AppServerFault | null;
}

export interface RateLimitsUpdatedResult {
  ok: boolean;
  snapshot: NormalizedQuotaSnapshot;
  fault: AppServerFault | null;
}

/** Caller-provided guard. It must identify a dedicated non-current task. */
export interface DedicatedTaskGuard {
  targetTaskId: string;
  currentTaskId: string;
  protectedTaskIds: readonly string[];
  dedicated: true;
  confirmation: "explicit";
}

export interface InterruptControlInput {
  targetTaskId: string;
  threadId: string;
  turnId: string;
  idempotencyKey: string;
  guard: DedicatedTaskGuard;
}

export interface ResumeControlInput {
  targetTaskId: string;
  threadId: string;
  checkpointRef: string;
  idempotencyKey: string;
  guard: DedicatedTaskGuard;
}

export interface ControlReceipt {
  ok: boolean;
  operation: "turn/interrupt" | "thread/resume";
  targetTaskId: string;
  threadId: string;
  requestId: number | null;
  responseId: number | string | null;
  receiptId: string | null;
  newTurnId: string | null;
  /** The response body is returned to the local caller for reconciliation. */
  rawResponse: unknown | null;
  fault: AppServerFault | null;
}

export interface ShutdownReceipt {
  ok: boolean;
  status: "closed" | "timeout" | "not_running";
  pendingRequestIds: number[];
}

export type AppServerCapabilityState = "present" | "absent" | "unverified";

export class AppServerStdioError extends Error {
  readonly fault: AppServerFault;

  constructor(fault: AppServerFault) {
    super(fault.message);
    this.name = "AppServerStdioError";
    this.fault = fault;
  }
}

interface PendingRequest {
  requestId: number;
  method: AppServerRpcMethod;
  resolve: (response: AppServerRpcResponse) => void;
  reject: (error: AppServerStdioError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface ParsedPage {
  data: unknown[];
  nextCursor: string | null;
}

interface ScopeMarker {
  raw: string;
  scope: "loaded_active" | "active";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_PAGES = 1_024;
/** Read-only enumeration bound for the single-App tool (its schema caps at 100). */
const MAX_TOOL_PAGES = 100;
const MAX_EVENT_TEXT = 2_048;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asResponseId(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/** Outbound IDs are numeric; a response must preserve that exact JSON type. */
function strictResponseId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function fault(code: string, message: string, operation: string, requestId: number | null = null): AppServerFault {
  return { code, message, operation, requestId, at: nowIso() };
}

function responseError(response: AppServerRpcResponse, operation: string, requestId: number): AppServerFault | null {
  if (response.error === undefined || response.error === null) return null;
  const error = isRecord(response.error) ? response.error : {};
  const code = typeof error.code === "string" ? error.code : "APP_SERVER_ERROR";
  const message = typeof error.message === "string" ? error.message : "App Server returned an error";
  return fault(code, redactText(message), operation, requestId);
}

function responseResult(response: AppServerRpcResponse): unknown {
  return Object.prototype.hasOwnProperty.call(response, "result") ? response.result : undefined;
}

function redactText(value: string): string {
  let text = value;
  text = text.replace(/(["']?\b(?:api[_ -]?key|access[_ -]?token|session[_ -]?token|token|cookie|authorization|password|secret)\b["']?\s*(?:[:=]|\s)\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[REDACTED]");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]");
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…` : text;
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:api[_ -]?key|access[_ -]?token|session[_ -]?token|token|cookie|authorization|password|secret|private[_ -]?key)/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = redactValue(child, seen);
  }
  return output;
}

function toChunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

function threadFrom(value: unknown): ThreadRecord | null {
  if (!isRecord(value)) return null;
  const threadId = nonEmptyString(value.threadId ?? value.thread_id ?? value.id);
  if (!threadId) return null;
  const turnId = nonEmptyString(value.turnId ?? value.turn_id ?? value.activeTurnId ?? value.active_turn_id);
  const projectId = nonEmptyString(value.projectId ?? value.project_id ?? value.workspaceId ?? value.workspace_id);
  const repositoryId = nonEmptyString(value.repositoryId ?? value.repository_id);
  const statusValue = value.status;
  const status = typeof statusValue === "string"
    ? statusValue
    : isRecord(statusValue) && typeof statusValue.type === "string" ? statusValue.type : null;
  const sourceKind = nonEmptyString(value.sourceKind ?? value.source_kind ?? value.source);
  return { threadId, turnId, projectId, repositoryId, status, sourceKind };
}

/**
 * Deterministic identity of one thread record, used to tell an identical
 * cross-page repeat (merged, contract 4B) from a conflicting one (fail-closed).
 * Only already-safe fields participate; the wire shape itself has no
 * prompt/message content to lose.  threadId never matters for equality beyond
 * the map key, so null turn/project fields compare as absent.
 */
function canonicalThreadIdentity(thread: ThreadRecord): string {
  return canonicalIdentityFor([
    ["turnId", thread.turnId],
    ["projectId", thread.projectId],
    ["repositoryId", thread.repositoryId],
    ["status", thread.status],
    ["sourceKind", thread.sourceKind]
  ]);
}

function canonicalIdentityFor(fields: Array<[string, string | null]>): string {
  return fields.map(([key, value]) => value === null ? `"${key}":null` : `${key}=${JSON.stringify(value)}`).join("|");
}

function resultPayload(response: AppServerRpcResponse): unknown {
  return responseResult(response);
}

function parsePage(response: AppServerRpcResponse, operation: string, requestId: number): ParsedPage {
  const result = resultPayload(response);
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new AppServerStdioError(fault("APP_SERVER_LIST_SHAPE_INVALID", "thread/list result must contain an array at result.data", operation, requestId));
  }
  if (!Object.prototype.hasOwnProperty.call(result, "nextCursor")) {
    throw new AppServerStdioError(fault("APP_SERVER_LIST_SHAPE_INVALID", "thread/list result must contain nextCursor (string or null)", operation, requestId));
  }
  const next = result.nextCursor;
  if (next !== null && nonEmptyString(next) === null) {
    throw new AppServerStdioError(fault("APP_SERVER_LIST_SHAPE_INVALID", "thread/list nextCursor must be a non-empty string or null", operation, requestId));
  }
  return { data: result.data, nextCursor: next === null ? null : next as string };
}

function parseScopeMarker(result: unknown): ScopeMarker | null {
  if (!isRecord(result)) return null;
  const raw = nonEmptyString(result.scope ?? result.visibility);
  if (!raw) return null;
  if (raw === "loaded_active" || raw === "all_loaded_active") return { raw, scope: "loaded_active" };
  if (raw === "active" || raw === "all_active") return { raw, scope: "active" };
  return null;
}

function explicitSuccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ok === true || value.accepted === true || value.confirmed === true) return true;
  const status = value.status ?? value.state;
  return status === "success" || status === "completed" || status === "confirmed" || status === "interrupted" || status === "resumed";
}

function receiptId(value: unknown): string | null {
  const fields = collectFieldValues(value, ["receiptId", "receipt_id"]);
  if (!fields.present || fields.invalid || new Set(fields.values).size !== 1) return null;
  return fields.values[0] ?? null;
}

function fieldString(value: unknown, ...names: string[]): string | null {
  const fields = collectFieldValues(value, names);
  const unique = [...new Set(fields.values)];
  return unique.length === 1 && !fields.invalid ? unique[0] ?? null : null;
}

interface FieldValues {
  present: boolean;
  values: string[];
  invalid: boolean;
}

function collectFieldValues(value: unknown, names: string[]): FieldValues {
  if (!isRecord(value)) return { present: false, values: [], invalid: false };
  const records: Record<string, unknown>[] = [value];
  if (isRecord(value.receipt)) records.push(value.receipt);
  let present = false;
  let invalid = false;
  const values: string[] = [];
  for (const record of records) {
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) continue;
      present = true;
      const parsed = nonEmptyString(record[name]);
      if (parsed === null) invalid = true;
      else values.push(parsed);
    }
  }
  return { present, values, invalid };
}

function buildEnvironment(options: AppServerStdioOptions): { env: Record<string, string>; envAllowlist: string[] } {
  const provided = options.env ?? {};
  const allowlist = [...new Set(options.envAllowlist ?? [])];
  for (const key of Object.keys(provided)) {
    if (!allowlist.includes(key)) throw new AppServerStdioError(fault("INVALID_SPAWN_SPEC", `Environment key ${key} is not in envAllowlist`, "spawn"));
  }
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = provided[key] ?? (options.inheritEnv === true ? process.env[key] : undefined);
    if (value !== undefined) env[key] = value;
  }
  return { env, envAllowlist: allowlist };
}

function defaultSpawn(spec: AppServerStdioSpawnSpec): AppServerStdioEndpoint {
  const child: ChildProcess = nodeSpawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  if (!child.stdin || !child.stdout) throw new Error("Codex App Server child requires piped stdin/stdout");
  const stdoutListeners = new Set<(chunk: unknown) => void>();
  const stderrListeners = new Set<(chunk: unknown) => void>();
  const exitListeners = new Set<(reason?: unknown) => void>();
  let exited = false;
  const notifyExit = (reason?: unknown): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(reason);
  };
  child.stdout.on("data", (chunk) => { for (const listener of stdoutListeners) listener(chunk); });
  child.stderr?.on("data", (chunk) => { for (const listener of stderrListeners) listener(chunk); });
  child.once("exit", (code, signal) => notifyExit({ code, signal }));
  child.once("error", (error) => notifyExit(error));
  return {
    write(data) { child.stdin!.write(data); },
    onStdout(listener) { stdoutListeners.add(listener); return () => stdoutListeners.delete(listener); },
    onStderr(listener) { stderrListeners.add(listener); return () => stderrListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    close() { child.stdin!.end(); },
    kill(signal = "SIGTERM") { child.kill(signal as NodeJS.Signals); }
  };
}

export class CodexAppServerStdioTransport {
  private readonly options: AppServerStdioOptions;
  private readonly spawnSpec: AppServerStdioSpawnSpec;
  private readonly spawn: AppServerStdioSpawn;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly events = new Set<AppServerEventListener>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly unknownInFlight = new Set<number>();
  private readonly completedRequestIds = new Set<number>();
  private endpoint: AppServerStdioEndpoint | null = null;
  private unsubscribe: Array<() => void> = [];
  private buffer = "";
  private nextRequestId = 1;
  private state: AppServerLifecycle = "idle";
  private initializeInFlight: Promise<EnsureInitializedReceipt> | null = null;
  private childInstanceCounter = 0;
  private currentChildInstanceId: string | null = null;
  private latestQuota: NormalizedQuotaSnapshot | null = null;
  private readonly capabilityStates = new Map<string, AppServerCapabilityState>();

  constructor(options: AppServerStdioOptions) {
    if (!nonEmptyString(options.command)) throw new AppServerStdioError(fault("INVALID_SPAWN_SPEC", "command is required", "spawn"));
    if (options.args?.some((arg) => typeof arg !== "string")) throw new AppServerStdioError(fault("INVALID_SPAWN_SPEC", "args must contain only strings", "spawn"));
    if (options.cwd !== undefined && !nonEmptyString(options.cwd)) throw new AppServerStdioError(fault("INVALID_SPAWN_SPEC", "cwd must be a non-empty string when supplied", "spawn"));
    const environment = buildEnvironment(options);
    this.options = options;
    this.spawnSpec = {
      command: options.command,
      args: [...(options.args ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: environment.env,
      envAllowlist: environment.envAllowlist
    };
    this.spawn = options.spawn ?? defaultSpawn;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && (options.requestTimeoutMs ?? 0) > 0 ? options.requestTimeoutMs! : DEFAULT_TIMEOUT_MS;
    this.shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs) && (options.shutdownTimeoutMs ?? 0) > 0 ? options.shutdownTimeoutMs! : DEFAULT_SHUTDOWN_TIMEOUT_MS;
    for (const capability of ["initialize", "thread/list", "thread/loaded/list", "thread/active/list", "account/rateLimits/read", "turn/interrupt", "thread/resume"]) this.capabilityStates.set(capability, "unverified");
  }

  get lifecycle(): AppServerLifecycle { return this.state; }
  get initialized(): boolean { return this.state === "initialized"; }
  get latestRateLimits(): NormalizedQuotaSnapshot | null { return this.latestQuota; }
  get pendingRequestIds(): number[] { return [...this.pending.keys()].sort((a, b) => a - b); }
  get unknownInFlightRequestIds(): number[] { return [...this.unknownInFlight].sort((a, b) => a - b); }
  get commandSpec(): AppServerStdioSpawnSpec { return { ...this.spawnSpec, args: [...this.spawnSpec.args], env: { ...this.spawnSpec.env }, envAllowlist: [...this.spawnSpec.envAllowlist] }; }
  /**
   * Identity of the currently attached child instance, or null when no child
   * is running.  Stable for the whole lifetime of one spawned child.
   */
  get childInstanceId(): string | null { return this.currentChildInstanceId; }

  onEvent(listener: AppServerEventListener): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  capabilityProbe(): Record<string, AppServerCapabilityState> {
    const result: Record<string, AppServerCapabilityState> = {};
    for (const [capability, state] of this.capabilityStates) result[capability] = state;
    return result;
  }

  async start(): Promise<void> {
    if (this.endpoint && (this.state === "running" || this.state === "initialized")) return;
    if (this.state === "reconcile_required") throw new AppServerStdioError(fault("RECONCILE_REQUIRED", "App Server has unresolved requests; reconcile before restarting", "start"));
    this.endpoint = await this.spawn(this.commandSpec);
    if (!this.endpoint || typeof this.endpoint.write !== "function" || typeof this.endpoint.onStdout !== "function") {
      this.endpoint = null;
      throw new AppServerStdioError(fault("INVALID_SPAWN_SPEC", "spawn returned an incomplete stdio endpoint", "spawn"));
    }
    this.childInstanceCounter += 1;
    this.currentChildInstanceId = `child-${this.childInstanceCounter}`;
    this.state = "running";
    this.attach(this.endpoint);
    this.emit({ type: "spawn", at: nowIso(), command: this.spawnSpec.command, args: [...this.spawnSpec.args], cwd: this.spawnSpec.cwd ?? null, envKeys: [...this.spawnSpec.envAllowlist] });
  }

  async initialize(params: unknown = {
    protocolVersion: this.options.protocolVersion ?? APP_SERVER_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: this.options.clientName ?? "continuity-orchestrator", version: this.options.clientVersion ?? "0.1.0" }
  }): Promise<AppServerRpcReceipt> {
    if (!this.endpoint) await this.start();
    const receipt = await this.request("initialize", params, { allowBeforeInitialize: true });
    if (!receipt.ok) return receipt;
    this.captureCapabilities(receipt.result);
    await this.notify("initialized", {});
    this.state = "initialized";
    return receipt;
  }

  async startAndInitialize(params?: unknown): Promise<AppServerRpcReceipt> {
    return this.initialize(params);
  }

  /**
   * Single-flight lazy start + initialize/initialized handshake over the one
   * transport lifecycle.  Behavior contract:
   *
   *   - already initialized → immediate `{ok: true}` receipt, no RPC, no spawn;
   *   - first caller (or first after a retryable failure) owns the attempt;
   *     every concurrent caller awaits the same in-flight attempt, so a burst
   *     of first calls produces exactly one child and one initialize RPC;
   *   - the attempt never throws: failures are returned as structured
   *     `{ok: false}` receipts so callers fail closed;
   *   - after a failed attempt the latch is released and the next call retries;
   *     `reconcile_required` (a lost/timed-out RPC) and `closed`/`closing`
   *     (explicit shutdown or child exit) are not silently retried and return
   *     their terminal receipt instead.
   */
  async ensureInitialized(): Promise<EnsureInitializedReceipt> {
    const unchanged: EnsureInitializedReceipt = { ok: false, operation: "ensure_initialized", requestId: null, responseId: null, result: null, error: null };
    if (this.state === "initialized") return { ...unchanged, ok: true, reused: true, ...(this.currentChildInstanceId ? { childInstanceId: this.currentChildInstanceId } : {}) };
    if (this.initializeInFlight) {
      // A concurrent caller is already driving the single start/initialize
      // attempt.  Await the shared promise but never report this caller as the
      // owner of the child start.
      const owned = await this.initializeInFlight;
      return { ...owned, reused: true, ...(this.currentChildInstanceId ? { childInstanceId: this.currentChildInstanceId } : {}) };
    }
    if (this.state === "closing" || this.state === "closed") {
      return { ...unchanged, error: fault("APP_SERVER_NOT_STARTED", "App Server child is closed; start a new transport before requesting App Server work", "ensure_initialized") };
    }
    if (this.state === "reconcile_required") {
      return { ...unchanged, error: fault("RECONCILE_REQUIRED", "App Server has unresolved requests; reconcile before starting it again", "ensure_initialized") };
    }
    const attempt = (async (): Promise<EnsureInitializedReceipt> => {
      try {
        const receipt = await this.startAndInitialize();
        if (!receipt.ok) return { ...unchanged, error: receipt.error ?? fault("APP_SERVER_ERROR", "App Server initialize failed", "ensure_initialized") };
        return { ...unchanged, ok: true, reused: false, ...(this.currentChildInstanceId ? { childInstanceId: this.currentChildInstanceId } : {}) };
      } catch (error) {
        // start() throws AppServerStdioError only in the non-retryable state
        // checks above; anything else reaching here fails closed.
        const cause = error instanceof AppServerStdioError ? error.fault : fault("APP_SERVER_ERROR", redactText(errorMessage(error)), "ensure_initialized");
        return { ...unchanged, error: cause };
      }
    })();
    this.initializeInFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.initializeInFlight = null;
    }
  }

  async request(method: AppServerRpcMethod, params: unknown = {}, requestOptions: { timeoutMs?: number; allowBeforeInitialize?: boolean } = {}): Promise<AppServerRpcReceipt> {
    const operation = method;
    if (!this.endpoint) return { ok: false, operation, requestId: null, responseId: null, result: null, error: fault("APP_SERVER_NOT_STARTED", "App Server child has not been started", operation) };
    if (this.state === "reconcile_required") return { ok: false, operation, requestId: null, responseId: null, result: null, error: fault("RECONCILE_REQUIRED", "An earlier request timed out or was lost; reconcile before sending another request", operation) };
    if (this.state !== "initialized" && method !== "initialize" && requestOptions.allowBeforeInitialize !== true) {
      return { ok: false, operation, requestId: null, responseId: null, result: null, error: fault("APP_SERVER_NOT_INITIALIZED", "initialize must succeed before App Server requests", operation) };
    }
    const requestId = this.nextRequestId++;
    const request: AppServerRpcRequest = { jsonrpc: "2.0", id: requestId, method, params };
    this.emit({ type: "request", at: nowIso(), requestId, method });
    try {
      const response = await new Promise<AppServerRpcResponse>((resolve, reject) => {
        const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && (requestOptions.timeoutMs ?? 0) > 0 ? requestOptions.timeoutMs! : this.requestTimeoutMs;
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          this.unknownInFlight.add(requestId);
          this.state = "reconcile_required";
          this.emit({ type: "timeout", at: nowIso(), requestId, method });
          reject(new AppServerStdioError(fault("APP_SERVER_TIMEOUT", `${method} timed out`, method, requestId)));
        }, timeoutMs);
        this.pending.set(requestId, { requestId, method, resolve, reject, timer });
        void Promise.resolve(this.endpoint!.write(`${JSON.stringify(request)}\n`)).catch((error: unknown) => {
          const current = this.pending.get(requestId);
          if (!current) return;
          this.pending.delete(requestId);
          clearTimeout(current.timer);
          current.reject(new AppServerStdioError(fault("APP_SERVER_REQUEST_FAILED", redactText(errorMessage(error)), method, requestId)));
        });
      });
      const responseId = asResponseId(response.id);
      const error = responseError(response, operation, requestId);
      const result = responseResult(response);
      this.emit({ type: "response", at: nowIso(), requestId, method, ok: !error, result: redactValue(result), error: redactValue(response.error ?? null) });
      return { ok: !error, operation, requestId, responseId, result: (error ? null : result) as unknown, error };
    } catch (error) {
      const appError = error instanceof AppServerStdioError ? error : new AppServerStdioError(fault("APP_SERVER_REQUEST_FAILED", redactText(errorMessage(error)), operation, requestId));
      return { ok: false, operation, requestId, responseId: null, result: null, error: appError.fault };
    }
  }

  private async notify(method: "initialized", params: unknown): Promise<void> {
    if (!this.endpoint) throw new AppServerStdioError(fault("APP_SERVER_NOT_STARTED", "App Server child has not been started", method));
    const notification: AppServerRpcNotification = { jsonrpc: "2.0", method, params };
    this.emit({ type: "notification", at: nowIso(), method, params: redactValue(params) });
    await this.endpoint.write(`${JSON.stringify(notification)}\n`);
  }

  async listRegistryThreads(): Promise<RegistryListResult> {
    const threads: ThreadRecord[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    const cursors: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const params = cursor === null ? {} : { cursor };
      const receipt = await this.request("thread/list", params);
      if (!receipt.ok || receipt.result == null) return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds: [], fault: receipt.error };
      pages += 1;
      let page: ParsedPage;
      try {
        page = parsePage({ result: receipt.result }, "thread/list", receipt.requestId ?? 0);
      } catch (error) {
        const parsedError = error instanceof AppServerStdioError ? error.fault : fault("APP_SERVER_LIST_SHAPE_INVALID", redactText(errorMessage(error)), "thread/list", receipt.requestId);
        return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds: [], fault: parsedError };
      }
      const duplicateThreadIds: string[] = [];
      for (const item of page.data) {
        const thread = threadFrom(item);
        if (!thread) return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds, fault: fault("APP_SERVER_LIST_SHAPE_INVALID", "thread/list data item has no stable thread id", "thread/list", receipt.requestId) };
        if (seenIds.has(thread.threadId)) {
          duplicateThreadIds.push(thread.threadId);
          continue;
        }
        seenIds.add(thread.threadId);
        threads.push(thread);
      }
      if (duplicateThreadIds.length) return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds, fault: fault("DUPLICATE_THREAD_ID", `thread/list repeated thread id(s): ${duplicateThreadIds.join(", ")}`, "thread/list", receipt.requestId) };
      if (page.nextCursor === null) return { ok: true, scope: "registry", complete: true, threads, pages, cursors, duplicateThreadIds: [], fault: null };
      if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds: [], fault: fault("CURSOR_LOOP", `thread/list repeated cursor ${page.nextCursor}`, "thread/list", receipt.requestId) };
      seenCursors.add(page.nextCursor);
      cursors.push(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { ok: false, scope: "registry", complete: false, threads, pages, cursors, duplicateThreadIds: [], fault: fault("CURSOR_LOOP", `thread/list exceeded ${MAX_PAGES} pages`, "thread/list") };
  }

  /**
   * Read-only `thread/list` enumeration over the registry scope for the
   * externally visible tool (contract 4B: complete pagination by default with
   * an optional per-call page limit).  The registry scope is exactly what the
   * wire method returns; every single thread/list RPC performed is reported in
   * `pages` and `actualRpcMethodsObserved`, so no local state can be mistaken
   * for a remote answer.  Fail-closed rules:
   *   - a repeated input cursor stops the walk (CURSOR_LOOP), never loops;
   *   - two records with the same threadId merge only when their safe fields
   *     are identical; any conflict fails (CONFLICTING_THREAD_RECORD);
   *   - at most MAX_TOOL_PAGES pages per call (callers pass pageLimit to bound
   *     earlier); the schema-level cap is the tool's own 100-page limit.
   * The existing listRegistryThreads() (stricter, no per-page metadata) and
   * every test asserting it are intentionally left unchanged.
   */
  async listRegistryThreadsForTool(options: ToolRegistryListOptions = {}): Promise<ToolRegistryListResult> {
    const threads: ThreadRecord[] = [];
    const byId = new Map<string, string>();
    const seenCursors = new Set<string>();
    const cursors: string[] = [];
    const pageProbes: RegistryPageProbe[] = [];
    const duplicateThreadIds: string[] = [];
    const conflictingThreadIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const pageLimit = options.pageLimit ?? MAX_TOOL_PAGES;
    const itemLimit = options.limit ?? null;
    const failed = (code: string, message: string, requestId: number | null): ToolRegistryListResult =>
      ({ ok: false, scope: "registry", complete: false, threads, pages: pageProbes, cursors, duplicateThreadIds, conflictingThreadIds, actualRpcMethodsObserved: ["thread/list"], fault: fault(code, message, "thread/list", requestId) });
    while (pages < pageLimit && (itemLimit === null || threads.length < itemLimit)) {
      const receipt = await this.request("thread/list", cursor === null ? {} : { cursor });
      if (!receipt.ok) return failed(receipt.error?.code ?? "APP_SERVER_REQUEST_FAILED", receipt.error?.message ?? "thread/list request failed", receipt.requestId);
      const response = { result: receipt.result };
      if (receipt.result === undefined || receipt.result === null) {
        return failed("APP_SERVER_LIST_SHAPE_INVALID", "thread/list result must contain an array at result.data", receipt.requestId);
      }
      pages += 1;
      let parsed: ParsedPage;
      try {
        parsed = parsePage(response, "thread/list", receipt.requestId ?? 0);
      } catch (error) {
        const parsedFault = error instanceof AppServerStdioError ? error.fault : fault("APP_SERVER_LIST_SHAPE_INVALID", redactText(errorMessage(error)), "thread/list", receipt.requestId);
        return failed(parsedFault.code, parsedFault.message, receipt.requestId);
      }
      const pageThreadIds: string[] = [];
      for (const item of parsed.data) {
        const thread = threadFrom(item);
        if (!thread) return failed("APP_SERVER_LIST_SHAPE_INVALID", "thread/list data item has no stable thread id", receipt.requestId);
        const canonical = canonicalThreadIdentity(thread);
        if (byId.has(thread.threadId)) {
          if (canonical === byId.get(thread.threadId)) {
            duplicateThreadIds.push(thread.threadId);
            pageThreadIds.push(thread.threadId);
            continue;
          }
          return failed("CONFLICTING_THREAD_RECORD", `thread/list repeated thread id with conflicting fields: ${thread.threadId}`, receipt.requestId);
        }
        byId.set(thread.threadId, canonical);
        threads.push(thread);
        pageThreadIds.push(thread.threadId);
      }
      pageProbes.push({ index: pages, inputCursor: cursor, outputCursor: parsed.nextCursor, itemCount: pageThreadIds.length });
      options.onPage?.(pageProbes[pageProbes.length - 1]!);
      if (parsed.nextCursor === null) {
        return { ok: true, scope: "registry", complete: true, threads, pages: pageProbes, cursors, duplicateThreadIds, conflictingThreadIds: [], actualRpcMethodsObserved: ["thread/list"], fault: null };
      }
      if (seenCursors.has(parsed.nextCursor) || parsed.nextCursor === cursor) {
        return failed("CURSOR_LOOP", `thread/list repeated cursor ${parsed.nextCursor}`, receipt.requestId);
      }
      seenCursors.add(parsed.nextCursor);
      cursors.push(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    // Guard against an input-cursor echo that advances nothing (fail closed).
    if (pages === 0) {
      return failed("CURSOR_LOOP", "thread/list enumeration made no progress", null);
    }
    if (pages >= pageLimit) {
      return failed("CURSOR_LOOP", `thread/list enumeration stopped after its ${pageLimit}-page cap without a terminal cursor`, null);
    }
    return failed("CURSOR_LOOP", `thread/list enumeration reached the requested item limit of ${itemLimit} without a terminal cursor`, null);
  }

  async probeLoadedActiveScope(method: "thread/loaded/list" | "thread/active/list" = "thread/loaded/list"): Promise<ScopeProbeResult> {
    const threads: ThreadRecord[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let marker: ScopeMarker | null = null;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const receipt = await this.request(method, cursor === null ? {} : { cursor });
      const capability = this.capabilityStates.get(method) ?? "unverified";
      if (!receipt.ok || receipt.result == null) {
        if (receipt.error?.code === "METHOD_NOT_FOUND" || receipt.error?.code === "CAPABILITY_UNAVAILABLE") this.capabilityStates.set(method, "absent");
        return { ok: false, method, capability: this.capabilityStates.get(method) ?? capability, known: false, scope: "unknown", threads, pages, fault: receipt.error ?? fault("DRAIN_SCOPE_UNKNOWN", "loaded/active scope request failed", method, receipt.requestId) };
      }
      this.capabilityStates.set(method, "present");
      pages += 1;
      let page: ParsedPage;
      try {
        page = parsePage({ result: receipt.result }, method, receipt.requestId ?? 0);
      } catch (error) {
        const parsedError = error instanceof AppServerStdioError ? error.fault : fault("DRAIN_SCOPE_UNKNOWN", redactText(errorMessage(error)), method, receipt.requestId);
        return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: parsedError };
      }
      const currentMarker = parseScopeMarker(receipt.result);
      if (!currentMarker) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("DRAIN_SCOPE_UNKNOWN", "every loaded/active page must carry an explicit scope marker", method, receipt.requestId) };
      if (marker === null) marker = currentMarker;
      else if (marker.raw !== currentMarker.raw) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("SCOPE_MARKER_CHANGED", "loaded/active scope marker changed during pagination", method, receipt.requestId) };
      if (page.nextCursor !== null && page.data.length === 0) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("DRAIN_SCOPE_UNKNOWN", "a non-terminal loaded/active page contained no data", method, receipt.requestId) };
      for (const item of page.data) {
        const thread = threadFrom(item);
        if (!thread) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("DRAIN_SCOPE_UNKNOWN", "loaded/active scope contained an unmapped thread", method, receipt.requestId) };
        if (seenThreadIds.has(thread.threadId)) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("DUPLICATE_THREAD_ID", `loaded/active scope repeated thread id ${thread.threadId}`, method, receipt.requestId) };
        seenThreadIds.add(thread.threadId);
        threads.push(thread);
      }
      if (page.nextCursor === null) return { ok: true, method, capability: "present", known: true, scope: marker.scope, threads, pages, fault: null };
      if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("CURSOR_LOOP", `loaded/active scope repeated cursor ${page.nextCursor}`, method, receipt.requestId) };
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { ok: false, method, capability: "present", known: false, scope: "unknown", threads, pages, fault: fault("CURSOR_LOOP", `loaded/active scope exceeded ${MAX_PAGES} pages`, method) };
  }

  async readRateLimits(previous?: NormalizedQuotaSnapshot | null): Promise<RateLimitsResult> {
    const receipt = await this.request("account/rateLimits/read");
    if (!receipt.ok) {
      const snapshot = normalizeRateLimitsRead({ method: "account/rateLimits/read", result: {} }, { source: "app-server", ...(previous === undefined ? {} : { previous }) });
      return { ok: false, requestId: receipt.requestId, snapshot, fault: receipt.error };
    }
    const snapshot = normalizeRateLimitsRead({ method: "account/rateLimits/read", result: receipt.result }, { source: "app-server", ...(previous === undefined ? {} : { previous }) });
    this.latestQuota = snapshot;
    const sampleFault = snapshot.status === "fresh" ? null : fault("QUOTA_DATA_UNKNOWN", snapshot.reason, "account/rateLimits/read", receipt.requestId);
    return { ok: sampleFault === null, requestId: receipt.requestId, snapshot, fault: sampleFault };
  }

  handleRateLimitsUpdated(message: unknown, previous?: NormalizedQuotaSnapshot | null): RateLimitsUpdatedResult {
    const snapshot = normalizeRateLimitsUpdated(message, { source: "app-server", ...(previous === undefined ? {} : { previous }) });
    this.latestQuota = snapshot;
    const sampleFault = snapshot.status === "fresh" ? null : fault("QUOTA_DATA_UNKNOWN", snapshot.reason, "account/rateLimits/updated");
    return { ok: sampleFault === null, snapshot, fault: sampleFault };
  }

  async interruptTurn(input: InterruptControlInput): Promise<ControlReceipt> {
    const rejected = this.validateGuard(input.targetTaskId, input.guard, "turn/interrupt");
    const base: ControlReceipt = { ok: false, operation: "turn/interrupt", targetTaskId: input.targetTaskId, threadId: input.threadId, requestId: null, responseId: null, receiptId: null, newTurnId: null, rawResponse: null, fault: null };
    if (rejected) return { ...base, fault: rejected };
    if (!nonEmptyString(input.threadId) || !nonEmptyString(input.turnId) || !nonEmptyString(input.idempotencyKey)) return { ...base, fault: fault("INVALID_TARGET", "interrupt requires threadId, turnId, and idempotencyKey", "turn/interrupt") };
    const rpc = await this.request("turn/interrupt", { threadId: input.threadId, turnId: input.turnId });
    return this.controlReceipt(base, rpc, input.threadId, input.turnId);
  }

  async resumeThread(input: ResumeControlInput): Promise<ControlReceipt> {
    const rejected = this.validateGuard(input.targetTaskId, input.guard, "thread/resume");
    const base: ControlReceipt = { ok: false, operation: "thread/resume", targetTaskId: input.targetTaskId, threadId: input.threadId, requestId: null, responseId: null, receiptId: null, newTurnId: null, rawResponse: null, fault: null };
    if (rejected) return { ...base, fault: rejected };
    if (!nonEmptyString(input.threadId) || !nonEmptyString(input.checkpointRef) || !nonEmptyString(input.idempotencyKey)) return { ...base, fault: fault("INVALID_TARGET", "resume requires threadId, checkpointRef, and idempotencyKey", "thread/resume") };
    const rpc = await this.request("thread/resume", { threadId: input.threadId, checkpointRef: input.checkpointRef });
    const result = rpc.result;
    const threadFields = collectFieldValues(result, ["threadId", "thread_id", "originalThreadId", "original_thread_id", "resumedThreadId", "resumed_thread_id"]);
    const turnFields = collectFieldValues(result, ["newTurnId", "new_turn_id", "turnId", "turn_id", "activeTurnId", "active_turn_id"]);
    const returnedThread = fieldString(result, "threadId", "thread_id", "originalThreadId", "original_thread_id", "resumedThreadId", "resumed_thread_id");
    const newTurnId = fieldString(result, "newTurnId", "new_turn_id", "turnId", "turn_id", "activeTurnId", "active_turn_id");
    const id = receiptId(result);
    if (!rpc.ok) return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, fault: rpc.error };
    if (!threadFields.present || threadFields.invalid || threadFields.values.length === 0 || threadFields.values.some((value) => value !== input.threadId) || returnedThread === null) {
      return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, receiptId: id, newTurnId, fault: fault("RECEIPT_ID_MISMATCH", "resume response must carry the requested original thread id in every supplied identity field", "thread/resume", rpc.requestId) };
    }
    if (!turnFields.present || turnFields.invalid || !newTurnId || !id || !explicitSuccess(result)) {
      return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, receiptId: id, newTurnId, fault: fault("RECEIPT_INVALID", "resume requires explicit success, a matching thread id, a new turn id, and a receipt id", "thread/resume", rpc.requestId) };
    }
    return { ...base, ok: true, requestId: rpc.requestId, responseId: rpc.responseId, receiptId: id, newTurnId, rawResponse: result };
  }

  private controlReceipt(base: ControlReceipt, rpc: AppServerRpcReceipt, threadId: string, turnId: string): ControlReceipt {
    const result = rpc.result;
    const id = receiptId(result);
    const threadFields = collectFieldValues(result, ["threadId", "thread_id"]);
    const turnFields = collectFieldValues(result, ["turnId", "turn_id", "activeTurnId", "active_turn_id"]);
    const returnedThread = fieldString(result, "threadId", "thread_id");
    const returnedTurn = fieldString(result, "turnId", "turn_id", "activeTurnId", "active_turn_id");
    if (!rpc.ok) return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, fault: rpc.error };
    if (!threadFields.present || threadFields.invalid || threadFields.values.length === 0 || threadFields.values.some((value) => value !== threadId) || returnedThread === null) {
      return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, receiptId: id, fault: fault("RECEIPT_ID_MISMATCH", "interrupt response must carry the requested thread id", "turn/interrupt", rpc.requestId) };
    }
    if (!turnFields.present || turnFields.invalid || turnFields.values.length === 0 || turnFields.values.some((value) => value !== turnId) || returnedTurn === null) {
      return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, receiptId: id, fault: fault("RECEIPT_ID_MISMATCH", "interrupt response must carry the requested turn id", "turn/interrupt", rpc.requestId) };
    }
    if (!explicitSuccess(result) || !id) return { ...base, requestId: rpc.requestId, responseId: rpc.responseId, rawResponse: result, receiptId: id, fault: fault("RECEIPT_INVALID", "interrupt requires explicit success and receiptId", "turn/interrupt", rpc.requestId) };
    return { ...base, ok: true, requestId: rpc.requestId, responseId: rpc.responseId, receiptId: id, rawResponse: result };
  }

  private validateGuard(targetTaskId: string, guard: DedicatedTaskGuard | undefined, operation: string): AppServerFault | null {
    if (!guard) return fault("CONTROL_GUARD_REQUIRED", "interrupt/resume requires an explicit dedicated-task guard", operation);
    if (guard.dedicated !== true || guard.confirmation !== "explicit") return fault("DEDICATED_TASK_REQUIRED", "target must be explicitly marked as a dedicated test task", operation);
    if (!nonEmptyString(targetTaskId) || guard.targetTaskId !== targetTaskId) return fault("TARGET_GUARD_MISMATCH", "guard targetTaskId must match the control target", operation);
    if (targetTaskId === guard.currentTaskId || targetTaskId === this.options.currentTaskId) return fault("CURRENT_TASK_PROTECTED", "current task cannot be interrupted or resumed by this adapter", operation);
    const protectedIds = new Set([...(this.options.protectedTaskIds ?? []), ...guard.protectedTaskIds]);
    if (protectedIds.has(targetTaskId)) return fault("PROTECTED_TASK", "protected task cannot be interrupted or resumed by this adapter", operation);
    return null;
  }

  private captureCapabilities(result: unknown): void {
    if (!isRecord(result) || !isRecord(result.capabilities)) return;
    const declared = result.capabilities;
    for (const [method, current] of this.capabilityStates) {
      if (Object.prototype.hasOwnProperty.call(declared, method)) {
        const value = declared[method];
        this.capabilityStates.set(method, value === false ? "absent" : "present");
      }
      const methodList = declared.methods;
      if (Array.isArray(methodList) && methodList.some((item) => item === method)) this.capabilityStates.set(method, "present");
      // Preserve unverified when the server returns an unrelated capability map.
      if (current === "unverified" && !Object.prototype.hasOwnProperty.call(declared, method) && !Array.isArray(methodList)) this.capabilityStates.set(method, "unverified");
    }
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<ShutdownReceipt> {
    const pendingRequestIds = this.pendingRequestIds;
    if (!this.endpoint) {
      this.state = "closed";
      this.emit({ type: "shutdown", at: nowIso(), status: "not_running", pendingRequestIds });
      return { ok: true, status: "not_running", pendingRequestIds };
    }
    this.state = "closing";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerStdioError(fault("APP_SERVER_SHUTDOWN", "App Server shutdown cancelled the request", pending.method, pending.requestId)));
    }
    this.pending.clear();
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! : this.shutdownTimeoutMs;
    let exited = this.isClosed();
    const waitForExit = new Promise<void>((resolve) => {
      if (this.isClosed()) { resolve(); return; }
      const timer = setTimeout(resolve, timeoutMs);
      this.unsubscribe.push(() => clearTimeout(timer));
      const poll = (): void => {
        if (this.isClosed()) { clearTimeout(timer); resolve(); }
        else setTimeout(poll, 1);
      };
      poll();
    });
    try {
      if (this.endpoint.close) await this.endpoint.close();
      else if (this.endpoint.kill) await this.endpoint.kill("SIGTERM");
    } catch {
      // The lifecycle receipt below remains the source of truth; do not leak raw errors.
    }
    await waitForExit;
    exited = this.isClosed();
    if (!exited) {
      try { if (this.endpoint.kill) await this.endpoint.kill("SIGKILL"); } catch { /* best effort */ }
      this.state = "closed";
    }
    const status = exited ? "closed" : "timeout";
    this.emit({ type: "shutdown", at: nowIso(), status, pendingRequestIds });
    return { ok: status === "closed", status, pendingRequestIds };
  }

  private attach(endpoint: AppServerStdioEndpoint): void {
    const removeStdout = endpoint.onStdout((chunk) => this.consumeStdout(chunk));
    if (typeof removeStdout === "function") this.unsubscribe.push(removeStdout);
    const removeStderr = endpoint.onStderr?.((chunk) => this.consumeStderr(chunk));
    if (typeof removeStderr === "function") this.unsubscribe.push(removeStderr);
    const removeExit = endpoint.onExit?.((reason) => this.handleExit(reason));
    if (typeof removeExit === "function") this.unsubscribe.push(removeExit);
  }

  private consumeStdout(chunk: unknown): void {
    this.buffer += toChunkText(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.emit({ type: "malformed_stdout", at: nowIso(), text: redactText(line) }); return; }
    if (!isRecord(message)) { this.emit({ type: "malformed_stdout", at: nowIso(), text: redactText(line) }); return; }
    if (typeof message.method === "string" && message.id === undefined) {
      const method = message.method;
      this.emit({ type: "notification", at: nowIso(), method, params: redactValue(message.params ?? {}) });
      if (method === "account/rateLimits/updated") this.handleRateLimitsUpdated(message.params ?? message);
      return;
    }
    const response = message as AppServerRpcResponse;
    const id = asResponseId(response.id);
    const numericId = strictResponseId(response.id);
    if (numericId === null) {
      this.failCorrelation("RESPONSE_ID_INVALID", "JSON-RPC response id is missing or is not the exact numeric request id type", id);
      return;
    }
    if (this.completedRequestIds.has(numericId)) {
      this.failCorrelation("DUPLICATE_RESPONSE_ID", `JSON-RPC response id ${numericId} was already completed`, id);
      return;
    }
    const pending = this.pending.get(numericId);
    if (!pending) {
      this.failCorrelation("RESPONSE_ID_UNKNOWN", `JSON-RPC response id ${numericId} does not match a pending request`, id);
      return;
    }
    if (typeof message.method === "string" && message.method !== pending.method) {
      this.failCorrelation("RESPONSE_ID_MISMATCH", `JSON-RPC response method ${message.method} does not match ${pending.method}`, id);
      return;
    }
    this.pending.delete(numericId);
    this.completedRequestIds.add(numericId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private failCorrelation(code: string, message: string, responseId: number | string | null): void {
    this.emit({ type: "unknown_response", at: nowIso(), responseId });
    if (this.state !== "closing" && this.state !== "closed") this.state = "reconcile_required";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.unknownInFlight.add(pending.requestId);
      pending.reject(new AppServerStdioError(fault(code, message, pending.method, pending.requestId)));
    }
    this.pending.clear();
  }

  private consumeStderr(chunk: unknown): void {
    const text = redactText(toChunkText(chunk));
    this.emit({ type: "stderr", at: nowIso(), text });
  }

  private handleExit(reason?: unknown): void {
    this.state = "closed";
    this.currentChildInstanceId = null;
    const safeReason = redactValue(reason ?? null);
    this.emit({ type: "exit", at: nowIso(), reason: safeReason });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerStdioError(fault("APP_SERVER_CHILD_EXITED", "App Server child exited before the response arrived", pending.method, pending.requestId)));
    }
    this.pending.clear();
    this.endpoint = null;
  }

  private emit(event: AppServerEvent): void {
    for (const listener of this.events) {
      try { listener(event); } catch { /* telemetry listeners cannot affect transport */ }
    }
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }
}

/** Build the single lazy gate that owns this transport's lifecycle. */
export function createCodexAppServerLazySeam(transport: CodexAppServerStdioTransport): CodexAppServerLazySeam {
  return {
    stdio: transport,
    async ensureInitialized(): Promise<EnsureInitializedReceipt> {
      return transport.ensureInitialized();
    }
  };
}
