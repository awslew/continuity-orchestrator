/**
 * Runtime configuration boundary for the Continuity App.
 *
 * There are two deliberately different profiles:
 *
 *   - `test` is the only profile allowed to construct in-memory mocks;
 *   - `production` requires explicit local transport/configuration and never
 *     silently falls back to a mock or to the process-wide environment.
 *
 * This file only parses/validates configuration.  It does not start a child,
 * open a browser, or call a network endpoint.
 */

import { isAbsolute, resolve } from "node:path";
import { DomainError } from "./domain/errors.js";
import { DEFAULT_FLAGS, parseFlags, type FeatureFlags } from "./flags.js";

export type RuntimeProfile = "test" | "production";

export interface WebgptRuntimeConfig {
  baseUrl: string;
  tabId: string;
  timeoutMs: number;
  key?: string;
  /** Name of the environment variable read at build time; the secret value is never stored in this object. */
  tokenEnv?: string;
  maxPayloadChars?: number;
}

export interface AppServerRuntimeConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  envAllowlist: string[];
  inheritEnv: false;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  currentTaskId: string | null;
  protectedTaskIds: string[];
}

export interface ClaudeRuntimeConfig {
  /** Explicit local/loopback endpoint. The path is supplied by configuration, not guessed. */
  baseUrl: string;
  replyPath: string;
  startPath: string;
  timeoutMs: number;
  tokenEnv?: string;
}

export interface EngineeringBridgeRuntimeConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  envAllowlist: string[];
  inheritEnv: false;
  requestTimeoutMs: number;
  workspaceIds: string[];
}

export interface RuntimeConfig {
  profile: RuntimeProfile;
  repositoryRoot: string;
  /** Durable adapter state. All runtime stores are constrained below this path. */
  stateDir: string;
  /** Redacted runtime receipts/evidence destination. */
  evidenceDir: string;
  maxEvidenceBytes: number;
  leaseTtlMs: number;
  freshnessWindowMs: number;
  /** Bounded cross-process runtime-store lock acquisition time. */
  durableLockTimeoutMs: number;
  flags: FeatureFlags;
  webgpt: WebgptRuntimeConfig | null;
  appServer: AppServerRuntimeConfig | null;
  claude: ClaudeRuntimeConfig | null;
  engineeringBridge: EngineeringBridgeRuntimeConfig | null;
}

export interface RuntimeConfigInput {
  profile?: unknown;
  runtimeProfile?: unknown;
  repositoryRoot?: unknown;
  stateDir?: unknown;
  evidenceDir?: unknown;
  maxEvidenceBytes?: unknown;
  leaseTtlMs?: unknown;
  freshnessWindowMs?: unknown;
  durableLockTimeoutMs?: unknown;
  flags?: unknown;
  webgpt?: unknown;
  appServer?: unknown;
  claude?: unknown;
  engineeringBridge?: unknown;
}

const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_PAYLOAD_CHARS = 2_000_000;
const MAX_LOCK_TIMEOUT_MS = 60_000;

/**
 * Sanitize values crossing a runtime boundary.  This is intentionally
 * structural: sensitive object keys are replaced wholesale, while ordinary
 * strings are scrubbed for URL credentials, bearer tokens, and common
 * key/value forms.  IDs such as `sessionId` remain available for receipt
 * reconciliation; only credential-like keys (for example `sessionToken`) are
 * treated as sensitive.
 */
const SENSITIVE_KEY = /(?:api[_ -]?key|access[_ -]?token|session[_ -]?token|authorization|auth(?:[_ -]?token)?|bearer|secret|cookie|password|credential)/i;

function sanitizeString(value: string): string {
  let text = value;
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+(?::[^/\s@]*)?)@/gi, "$1[REDACTED]@");
  text = text.replace(/(\bBearer\s+)[^\s,;\]}]+/gi, "$1[REDACTED]");
  text = text.replace(/((?:api[_ -]?key|access[_ -]?token|session[_ -]?token|authorization|auth(?:[_ -]?token)?|bearer|secret|cookie|password|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, "$1[REDACTED]");
  text = text.replace(/([?&](?:key|token|secret|cookie|authorization|auth|password|credential)=)[^&#\s]+/gi, "$1[REDACTED]");
  return text;
}

export function sanitizeRuntimeValue<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, key: string): unknown => {
    if (typeof current === "string") return sanitizeString(current);
    if (current === null || typeof current !== "object") return current;
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    let output: unknown;
    if (Array.isArray(current)) output = current.map((item) => visit(item, key));
    else {
      const object: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) {
        object[childKey] = SENSITIVE_KEY.test(childKey) ? "[REDACTED]" : visit(child, childKey);
      }
      output = object;
    }
    seen.delete(current);
    return output;
  };
  return visit(value, "") as T;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("RED_FLAGGED_INPUT", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new DomainError("RED_FLAGGED_INPUT", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function positiveInteger(value: unknown, field: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new DomainError("RED_FLAGGED_INPUT", `${field} must be a positive integer <= ${max}`);
  }
  return value;
}

function pathValue(value: unknown, field: string, repositoryRoot: string, required: boolean): string {
  if (value === undefined && !required) return resolve(repositoryRoot, ".ai-handoff");
  const parsed = requiredString(value, field);
  return isAbsolute(parsed) ? resolve(parsed) : resolve(repositoryRoot, parsed);
}

function stringArray(value: unknown, field: string, fallback: string[] = []): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new DomainError("RED_FLAGGED_INPUT", `${field} must be an array of strings`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function safeEnvRecord(value: unknown, field: string): Record<string, string | undefined> {
  if (value === undefined) return {};
  const object = record(value, field);
  const result: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(object)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new DomainError("RED_FLAGGED_INPUT", `${field} contains an invalid environment key`);
    if (raw !== undefined && raw !== null && typeof raw !== "string") throw new DomainError("RED_FLAGGED_INPUT", `${field}.${key} must be a string`);
    result[key] = raw === null ? undefined : raw as string | undefined;
  }
  return result;
}

function parseWebgpt(value: unknown, profile: RuntimeProfile): WebgptRuntimeConfig | null {
  if (value === undefined || value === null) {
    if (profile === "production") throw new DomainError("RED_FLAGGED_INPUT", "production requires explicit webgpt configuration");
    return null;
  }
  const object = record(value, "webgpt");
  const baseUrl = requiredString(object.baseUrl, "webgpt.baseUrl");
  const tabId = requiredString(object.tabId, "webgpt.tabId");
  const timeoutMs = positiveInteger(object.timeoutMs, "webgpt.timeoutMs", 0, MAX_TIMEOUT_MS);
  if (timeoutMs === 0) throw new DomainError("RED_FLAGGED_INPUT", "webgpt.timeoutMs is required in production");
  const maxPayloadChars = object.maxPayloadChars === undefined ? undefined : positiveInteger(object.maxPayloadChars, "webgpt.maxPayloadChars", 1, MAX_PAYLOAD_CHARS);
  const key = optionalString(object.key, "webgpt.key");
  const tokenEnv = optionalString(object.tokenEnv, "webgpt.tokenEnv");
  return {
    baseUrl,
    tabId,
    timeoutMs,
    ...(key === undefined ? {} : { key }),
    ...(tokenEnv === undefined ? {} : { tokenEnv }),
    ...(maxPayloadChars === undefined ? {} : { maxPayloadChars })
  };
}

function parseAppServer(value: unknown, profile: RuntimeProfile): AppServerRuntimeConfig | null {
  if (value === undefined || value === null) {
    if (profile === "production") throw new DomainError("RED_FLAGGED_INPUT", "production requires explicit App Server configuration");
    return null;
  }
  const object = record(value, "appServer");
  const command = requiredString(object.command, "appServer.command");
  const cwd = requiredString(object.cwd, "appServer.cwd");
  const envAllowlist = stringArray(object.envAllowlist, "appServer.envAllowlist");
  const env = safeEnvRecord(object.env, "appServer.env");
  for (const key of Object.keys(env)) if (!envAllowlist.includes(key)) throw new DomainError("RED_FLAGGED_INPUT", `appServer.env.${key} is not in appServer.envAllowlist`);
  return {
    command,
    args: stringArray(object.args, "appServer.args"),
    cwd,
    env,
    envAllowlist,
    inheritEnv: false,
    requestTimeoutMs: positiveInteger(object.requestTimeoutMs, "appServer.requestTimeoutMs", 30_000, MAX_TIMEOUT_MS),
    shutdownTimeoutMs: positiveInteger(object.shutdownTimeoutMs, "appServer.shutdownTimeoutMs", 5_000, MAX_TIMEOUT_MS),
    currentTaskId: object.currentTaskId === undefined || object.currentTaskId === null ? null : requiredString(object.currentTaskId, "appServer.currentTaskId"),
    protectedTaskIds: stringArray(object.protectedTaskIds, "appServer.protectedTaskIds")
  };
}

function parseClaude(value: unknown): ClaudeRuntimeConfig | null {
  if (value === undefined || value === null) return null;
  const object = record(value, "claude");
  const tokenEnv = optionalString(object.tokenEnv, "claude.tokenEnv");
  return {
    baseUrl: requiredString(object.baseUrl, "claude.baseUrl"),
    replyPath: requiredString(object.replyPath, "claude.replyPath"),
    startPath: requiredString(object.startPath, "claude.startPath"),
    timeoutMs: positiveInteger(object.timeoutMs, "claude.timeoutMs", 30_000, MAX_TIMEOUT_MS),
    ...(tokenEnv === undefined ? {} : { tokenEnv })
  };
}

function parseEngineeringBridge(value: unknown): EngineeringBridgeRuntimeConfig | null {
  if (value === undefined || value === null) return null;
  const object = record(value, "engineeringBridge");
  const envAllowlist = stringArray(object.envAllowlist, "engineeringBridge.envAllowlist");
  const env = safeEnvRecord(object.env, "engineeringBridge.env");
  for (const key of Object.keys(env)) if (!envAllowlist.includes(key)) throw new DomainError("RED_FLAGGED_INPUT", `engineeringBridge.env.${key} is not in engineeringBridge.envAllowlist`);
  return {
    command: requiredString(object.command, "engineeringBridge.command"),
    args: stringArray(object.args, "engineeringBridge.args"),
    cwd: requiredString(object.cwd, "engineeringBridge.cwd"),
    env,
    envAllowlist,
    inheritEnv: false,
    requestTimeoutMs: positiveInteger(object.requestTimeoutMs, "engineeringBridge.requestTimeoutMs", 30_000, MAX_TIMEOUT_MS),
    workspaceIds: stringArray(object.workspaceIds, "engineeringBridge.workspaceIds")
  };
}

/** Parse a config object. Production defaults are intentionally strict. */
export function parseRuntimeConfig(input: unknown, repositoryRoot = process.cwd()): RuntimeConfig {
  const object = input === undefined || input === null ? {} : record(input, "runtime config");
  const root = resolve(requiredString(object.repositoryRoot ?? repositoryRoot, "repositoryRoot"));
  const rawProfile = object.profile ?? object.runtimeProfile ?? "production";
  if (rawProfile !== "test" && rawProfile !== "production") throw new DomainError("RED_FLAGGED_INPUT", "runtime profile must be test or production");
  const profile = rawProfile as RuntimeProfile;
  const stateDir = pathValue(object.stateDir, "stateDir", root, profile === "production");
  const evidenceDir = pathValue(object.evidenceDir, "evidenceDir", root, profile === "production");
  return {
    profile,
    repositoryRoot: root,
    stateDir,
    evidenceDir,
    maxEvidenceBytes: positiveInteger(object.maxEvidenceBytes, "maxEvidenceBytes", 16_384, 64 * 1024 * 1024),
    leaseTtlMs: positiveInteger(object.leaseTtlMs, "leaseTtlMs", 300_000, 24 * 60 * 60 * 1_000),
    freshnessWindowMs: positiveInteger(object.freshnessWindowMs, "freshnessWindowMs", 300_000, 24 * 60 * 60 * 1_000),
    durableLockTimeoutMs: positiveInteger(object.durableLockTimeoutMs, "durableLockTimeoutMs", 5_000, MAX_LOCK_TIMEOUT_MS),
    flags: parseFlags(object.flags),
    webgpt: parseWebgpt(object.webgpt, profile),
    appServer: parseAppServer(object.appServer, profile),
    claude: parseClaude(object.claude),
    engineeringBridge: parseEngineeringBridge(object.engineeringBridge)
  };
}

function jsonEnv(env: NodeJS.ProcessEnv, key: string, fallback: unknown): unknown {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) return fallback;
  try { return JSON.parse(value); } catch { throw new DomainError("RED_FLAGGED_INPUT", `${key} must contain valid JSON`); }
}

/** Read only the explicitly named configuration variables; no environment is inherited wholesale. */
export function runtimeConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env, repositoryRoot = env.CONTINUITY_REPOSITORY_ROOT ?? process.cwd()): RuntimeConfig {
  const profile = env.CONTINUITY_RUNTIME_PROFILE ?? env.CONTINUITY_PROFILE ?? "production";
  const input: RuntimeConfigInput = {
    profile,
    repositoryRoot,
    stateDir: env.CONTINUITY_STATE_DIR,
    evidenceDir: env.CONTINUITY_EVIDENCE_DIR,
    maxEvidenceBytes: env.CONTINUITY_MAX_EVIDENCE_BYTES ? Number(env.CONTINUITY_MAX_EVIDENCE_BYTES) : undefined,
    leaseTtlMs: env.CONTINUITY_LEASE_TTL_MS ? Number(env.CONTINUITY_LEASE_TTL_MS) : undefined,
    freshnessWindowMs: env.CONTINUITY_FRESHNESS_WINDOW_MS ? Number(env.CONTINUITY_FRESHNESS_WINDOW_MS) : undefined,
    durableLockTimeoutMs: env.CONTINUITY_DURABLE_LOCK_TIMEOUT_MS ? Number(env.CONTINUITY_DURABLE_LOCK_TIMEOUT_MS) : undefined,
    flags: jsonEnv(env, "CONTINUITY_FLAGS", { ...DEFAULT_FLAGS }),
    webgpt: env.CONTINUITY_WEBGPT_BASE_URL || env.CONTINUITY_WEBGPT_TAB_ID
      ? {
          baseUrl: env.CONTINUITY_WEBGPT_BASE_URL,
          tabId: env.CONTINUITY_WEBGPT_TAB_ID,
          timeoutMs: env.CONTINUITY_WEBGPT_TIMEOUT_MS ? Number(env.CONTINUITY_WEBGPT_TIMEOUT_MS) : undefined,
          key: env.CONTINUITY_WEBGPT_KEY,
          tokenEnv: env.CONTINUITY_WEBGPT_TOKEN_ENV,
          maxPayloadChars: env.CONTINUITY_WEBGPT_MAX_PAYLOAD_CHARS ? Number(env.CONTINUITY_WEBGPT_MAX_PAYLOAD_CHARS) : undefined
        }
      : undefined,
    appServer: env.CONTINUITY_APP_SERVER_COMMAND
      ? {
          command: env.CONTINUITY_APP_SERVER_COMMAND,
          args: jsonEnv(env, "CONTINUITY_APP_SERVER_ARGS_JSON", []),
          cwd: env.CONTINUITY_APP_SERVER_CWD,
          env: jsonEnv(env, "CONTINUITY_APP_SERVER_ENV_JSON", {}),
          envAllowlist: jsonEnv(env, "CONTINUITY_APP_SERVER_ENV_ALLOWLIST_JSON", []),
          requestTimeoutMs: env.CONTINUITY_APP_SERVER_REQUEST_TIMEOUT_MS ? Number(env.CONTINUITY_APP_SERVER_REQUEST_TIMEOUT_MS) : undefined,
          shutdownTimeoutMs: env.CONTINUITY_APP_SERVER_SHUTDOWN_TIMEOUT_MS ? Number(env.CONTINUITY_APP_SERVER_SHUTDOWN_TIMEOUT_MS) : undefined,
          currentTaskId: env.CONTINUITY_CURRENT_TASK_ID,
          protectedTaskIds: jsonEnv(env, "CONTINUITY_PROTECTED_TASK_IDS_JSON", [])
        }
      : undefined,
    claude: env.CONTINUITY_CLAUDE_BASE_URL
      ? {
          baseUrl: env.CONTINUITY_CLAUDE_BASE_URL,
          replyPath: env.CONTINUITY_CLAUDE_REPLY_PATH,
          startPath: env.CONTINUITY_CLAUDE_START_PATH,
          timeoutMs: env.CONTINUITY_CLAUDE_TIMEOUT_MS ? Number(env.CONTINUITY_CLAUDE_TIMEOUT_MS) : undefined,
          tokenEnv: env.CONTINUITY_CLAUDE_TOKEN_ENV
        }
      : undefined,
    engineeringBridge: env.CONTINUITY_BRIDGE_COMMAND
      ? {
          command: env.CONTINUITY_BRIDGE_COMMAND,
          args: jsonEnv(env, "CONTINUITY_BRIDGE_ARGS_JSON", []),
          cwd: env.CONTINUITY_BRIDGE_CWD,
          env: jsonEnv(env, "CONTINUITY_BRIDGE_ENV_JSON", {}),
          envAllowlist: jsonEnv(env, "CONTINUITY_BRIDGE_ENV_ALLOWLIST_JSON", []),
          requestTimeoutMs: env.CONTINUITY_BRIDGE_REQUEST_TIMEOUT_MS ? Number(env.CONTINUITY_BRIDGE_REQUEST_TIMEOUT_MS) : undefined,
          workspaceIds: jsonEnv(env, "CONTINUITY_BRIDGE_WORKSPACE_IDS_JSON", [])
        }
      : undefined
  };
  return parseRuntimeConfig(input, repositoryRoot);
}

/** Safe diagnostic projection; token values and env values are intentionally absent. */
export function redactedRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    repositoryRoot: config.repositoryRoot,
    stateDir: config.stateDir,
    evidenceDir: config.evidenceDir,
    maxEvidenceBytes: config.maxEvidenceBytes,
    leaseTtlMs: config.leaseTtlMs,
    freshnessWindowMs: config.freshnessWindowMs,
    durableLockTimeoutMs: config.durableLockTimeoutMs,
    flags: { ...config.flags },
    webgpt: config.webgpt ? { baseUrl: sanitizeString(config.webgpt.baseUrl), tabId: sanitizeString(config.webgpt.tabId), timeoutMs: config.webgpt.timeoutMs, ...(config.webgpt.key ? { keyConfigured: true } : {}), ...(config.webgpt.tokenEnv ? { tokenEnv: sanitizeString(config.webgpt.tokenEnv) } : {}) } : null,
    appServer: config.appServer ? { command: sanitizeString(config.appServer.command), args: config.appServer.args.map(sanitizeString), cwd: sanitizeString(config.appServer.cwd), envAllowlist: [...config.appServer.envAllowlist], inheritEnv: false, requestTimeoutMs: config.appServer.requestTimeoutMs, shutdownTimeoutMs: config.appServer.shutdownTimeoutMs, currentTaskId: config.appServer.currentTaskId, protectedTaskIds: [...config.appServer.protectedTaskIds] } : null,
    claude: config.claude ? { baseUrl: sanitizeString(config.claude.baseUrl), replyPath: sanitizeString(config.claude.replyPath), startPath: sanitizeString(config.claude.startPath), timeoutMs: config.claude.timeoutMs, ...(config.claude.tokenEnv ? { tokenEnv: sanitizeString(config.claude.tokenEnv) } : {}) } : null,
    engineeringBridge: config.engineeringBridge ? { command: sanitizeString(config.engineeringBridge.command), args: config.engineeringBridge.args.map(sanitizeString), cwd: sanitizeString(config.engineeringBridge.cwd), envAllowlist: [...config.engineeringBridge.envAllowlist], inheritEnv: false, requestTimeoutMs: config.engineeringBridge.requestTimeoutMs, workspaceIds: [...config.engineeringBridge.workspaceIds] } : null
  };
}
