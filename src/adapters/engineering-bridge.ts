import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { assertExplicitDsh } from "../routing/executor-policy.js";
import type {
  ChildMcpReceipt,
  StructuredAdapterError,
  WorkerEvidence,
  WorkerReceipt,
  WorkerReceiptStatus
} from "./adapter-types.js";
import { structuredAdapterError } from "./adapter-types.js";
import { McpChildClient } from "./mcp-child.js";

export const ENGINEERING_BRIDGE_TOOL_NAMES = [
  "run_task",
  "task_result",
  "control_task",
  "bind_project",
  "create_project",
  "authorize_workspace_write",
  "generate_controlled_patch",
  "refine_controlled_patch",
  "submit_controlled_patch",
  "apply_controlled_patch",
  "commit_controlled_patch",
  "configure_validation_profile",
  "validate_controlled_patch"
] as const;

export type EngineeringBridgeToolName = (typeof ENGINEERING_BRIDGE_TOOL_NAMES)[number];
export type BridgeExecutor = "dsh";

export interface EngineeringBridgeOptions {
  child: McpChildClient;
  registeredWorkspaces: Iterable<string> | Readonly<Record<string, unknown>>;
  /** All receipts remain mock/injected evidence in Wave 3. */
  evidenceLevel?: "MOCK_PASS" | "UNKNOWN";
}

export interface BridgeToolsDiscovery {
  schemaVersion: "continuity.bridge-tools.v1";
  expectedCount: 13;
  expectedTools: string[];
  tools: string[];
  missing: string[];
  extra: string[];
  exact: boolean;
  childInitialize: ChildMcpReceipt | null;
  childToolsList: ChildMcpReceipt | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
}

export interface BridgeToolReceipt<T = unknown> {
  schemaVersion: "continuity.bridge-receipt.v1";
  requestId: string;
  idempotencyKey: string;
  operation: string;
  tool: EngineeringBridgeToolName;
  workspaceId: string | null;
  executor: BridgeExecutor | null;
  ok: boolean;
  status: "completed" | "failed" | "unknown_in_flight" | "blocked";
  data: T | null;
  childReceipt: ChildMcpReceipt | null;
  error: StructuredAdapterError | null;
  evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  createdAt: string;
}

export interface BridgeRunTaskInput {
  workspace_id: string;
  instruction: string;
  /** Deliberately optional at the type boundary so omission is rejected at runtime. */
  executor?: string;
  task_id?: string;
  attempt_id?: string;
  idempotency_key?: string;
  model?: string;
  reasoning_effort?: string;
}

export interface BridgeTaskResultInput {
  workspace_id: string;
  task_id: string;
  executor?: string;
  attempt_id?: string;
  idempotency_key?: string;
}

export type BridgeControlAction = "continue" | "steer" | "interrupt" | "accept";

export interface BridgeControlTaskInput {
  workspace_id: string;
  task_id: string;
  action: BridgeControlAction;
  /** Raw text is accepted only by the upstream Bridge; web supervision never passes it here. */
  instruction?: string;
  executor?: string;
  attempt_id?: string;
  idempotency_key?: string;
}

export interface BridgePatchGenerateInput {
  workspace_id: string;
  change_request: string;
  executor?: string;
  task_id?: string;
  idempotency_key?: string;
  model?: string;
  reasoning_effort?: string;
}

export interface BridgePatchRefineInput {
  workspace_id: string;
  patch_task_id: string;
  change_request: string;
  executor?: string;
  idempotency_key?: string;
  model?: string;
  reasoning_effort?: string;
}

export interface BridgePatchSubmitInput {
  workspace_id: string;
  base_head: string;
  diff: string;
  idempotency_key?: string;
}

export interface BridgePatchApplyInput {
  workspace_id: string;
  patch_task_id: string;
  confirmation: string;
  idempotency_key?: string;
}

export interface BridgePatchCommitInput {
  workspace_id: string;
  patch_task_id: string;
  message: string;
  confirmation: string;
  idempotency_key?: string;
}

export interface BridgePatchValidateInput {
  workspace_id: string;
  patch_task_id: string;
  idempotency_key?: string;
}

interface DecodedToolResult {
  payload: unknown;
  error: StructuredAdapterError | null;
  evidenceDrop: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function redacted(value: string): string {
  const key = "(?:deepseek_api_key|openai_api_key|anthropic_api_key|api[_ -]?key|access[_ -]?token|session[_ -]?token|session|token|cookie|authorization|auth(?:[_ -]?token)?|secret|bearer)";
  let text = value;
  text = text.replace(new RegExp(`[\"']?\\b(?:authorization|auth)\\b[\"']?\\s*(?::|=|\\s+)\\s*[\"']?(?:bearer\\s+)?[\"']?(?:\"[^\"]*\"|'[^']*'|(?!\\[REDACTED\\])[^\\s,;\\]}]+)[\"']?`, "gi"), (match) => `${match.match(/authorization|auth/i)?.[0] ?? "AUTHORIZATION"}=[REDACTED]`);
  text = text.replace(new RegExp(`[\"']?\\b${key}\\b[\"']?\\s*(?:(?:[:=]\\s*)|\\s+)(?:\"[^\"]*\"|'[^']*'|(?!\\[REDACTED\\])[^\\s,;\\]}]+)`, "gi"), (match) => `${match.match(new RegExp(key, "i"))?.[0] ?? "SECRET"}=[REDACTED]`);
  return text
    .replace(new RegExp(`([?&](?:key|token|secret|api[_ -]?key|access[_ -]?token|session(?:[_ -]?token)?|cookie)=)[^&#\\s]+`, "gi"), "$1[REDACTED]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[REDACTED]");
}

/**
 * A key is sensitive independently of the value it points at.  In
 * particular, a one-character token, a numeric session id, or a nested
 * object under `api_key` must not survive merely because it is not a string.
 * Removing separators also covers camelCase, snake_case, kebab-case, and
 * space-separated spellings without widening this to ordinary `key` fields.
 */
function isSensitiveKey(key: PropertyKey): boolean {
  const name = typeof key === "symbol" ? key.description ?? String(key) : key;
  const normalized = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:token|session|apikey|cookie|authorization|bearer|secret|password|accesstoken|refreshtoken)/i.test(normalized) || normalized === "auth";
}

function defineRedactedProperty(output: object, key: PropertyKey, value: unknown): void {
  // defineProperty avoids the special `__proto__` setter and therefore does
  // not copy an input key into the output object's prototype.
  Object.defineProperty(output, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function redactDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redacted(value);
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  // Functions are executable objects rather than receipt data.  Do not carry
  // one across the adapter boundary where its own properties could evade a
  // JSON-oriented sanitizer.
  if (typeof value === "function") return "[REDACTED]";
  if (seen.has(value)) return "[CIRCULAR_REDACTED]";
  seen.add(value);
  const output: object = Array.isArray(value) ? [] : {};
  try {
    let keys: (string | symbol)[];
    try {
      // Reflect.ownKeys plus the descriptor check covers enumerable symbols as
      // well as strings, while still excluding inherited/non-enumerable data.
      keys = Reflect.ownKeys(value).filter((key) => {
        try {
          return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
        } catch {
          return false;
        }
      });
    } catch {
      // A hostile Proxy can throw while enumerating.  Returning a marker is
      // safer than returning the uninspected object or propagating raw data.
      return "[REDACTED]";
    }
    for (const key of keys) {
      let safeValue: unknown = "[REDACTED]";
      if (!isSensitiveKey(key)) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          // Accessors are deliberately not invoked.  Their returned value is
          // unknown and may be secret; fail closed instead.
          if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            safeValue = redactDeep(descriptor.value, seen);
          }
        } catch {
          safeValue = "[REDACTED]";
        }
      }
      try {
        defineRedactedProperty(output, key, isSensitiveKey(key) ? "[REDACTED]" : safeValue);
      } catch {
        // If even the safe output cannot represent a property, discard the
        // whole container rather than leak an unprocessed sibling.
        return "[REDACTED]";
      }
    }
    return output;
  } finally {
    // Track only the current recursion path.  Repeated references are safe to
    // sanitize independently; only an actual cycle gets the cycle marker.
    seen.delete(value);
  }
}

function valueAt(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function decodeToolResult(value: unknown, operation: string): DecodedToolResult {
  if (!isRecord(value)) return { payload: value, error: null, evidenceDrop: false };
  if (value.isError === true) {
    const nested = isRecord(value.error) ? value.error : null;
    const code = nested && typeof nested.code === "string" ? nested.code : "BRIDGE_TOOL_FAILED";
    const message = nested && typeof nested.message === "string" ? redacted(nested.message) : "Engineering Bridge returned a tool error";
    return {
      payload: null,
      error: structuredAdapterError(code, "unknown", message, operation),
      evidenceDrop: false
    };
  }
  const structured = value.structuredContent;
  if (structured !== undefined) return { payload: structured, error: null, evidenceDrop: false };
  if (Array.isArray(value.content)) {
    const textItem = value.content.find((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string");
    if (textItem && isRecord(textItem)) {
      const payload = parseJsonText(textItem.text);
      const evidenceDrop = typeof textItem.text === "string" && /evidence[-_ ]drop|\[truncated\]/i.test(textItem.text);
      return { payload, error: null, evidenceDrop };
    }
  }
  return { payload: value, error: null, evidenceDrop: false };
}

function statusFrom(payload: unknown, evidenceDrop: boolean): { status: WorkerReceiptStatus; external: WorkerReceipt["externalStatus"]; workerStatus: WorkerReceipt["workerStatus"] } {
  const raw = isRecord(payload) ? valueAt(payload, "state", "status") : undefined;
  const state = typeof raw === "string" ? raw.toLowerCase() : "unknown";
  if (isRecord(payload) && valueAt(payload, "partial_output", "partialOutput") !== undefined) return { status: "partial_output", external: "partial_output", workerStatus: "failed" };
  if (evidenceDrop || state === "evidence-drop" || state === "evidence_drop") return { status: "evidence_drop", external: "evidence-drop", workerStatus: "failed" };
  if (state === "queued") return { status: "queued", external: "queued", workerStatus: "queued" };
  if (state === "running") return { status: "running", external: "running", workerStatus: "running" };
  if (state === "waiting_for_supervisor_review" || state === "review") return { status: "review", external: "waiting_for_supervisor_review", workerStatus: "review" };
  if (state === "completed" || state === "success") return { status: "completed", external: "completed", workerStatus: "completed" };
  if (state === "failed" || state === "error") return { status: "failed", external: "failed", workerStatus: "failed" };
  return { status: "unknown", external: "unknown", workerStatus: "unknown" };
}

function evidenceFrom(payload: unknown, evidenceDrop: boolean): { evidence: WorkerEvidence[]; refs: string[]; drop: WorkerReceipt["evidenceDrop"] } {
  const evidence: WorkerEvidence[] = [];
  const refs: string[] = [];
  const rawEvidence = isRecord(payload) ? valueAt(payload, "evidence", "evidence_refs", "evidenceRefs") : undefined;
  if (Array.isArray(rawEvidence)) {
    for (const entry of rawEvidence) {
      const ref = typeof entry === "string" ? nonEmptyString(entry) : isRecord(entry) ? nonEmptyString(valueAt(entry, "ref", "id", "path")) : null;
      if (!ref) continue;
      const clean = redacted(ref);
      refs.push(clean);
      evidence.push({ kind: "evidence", ref: clean, complete: true, redacted: true });
    }
  }
  const dropValue = isRecord(payload) ? valueAt(payload, "evidence_drop", "evidenceDrop") : undefined;
  const dropped = isRecord(dropValue) && typeof dropValue.dropped === "number" ? dropValue.dropped : evidenceDrop ? 1 : 0;
  const drop = dropped > 0 ? {
    kind: "evidence-drop" as const,
    dropped,
    reason: isRecord(dropValue) && typeof dropValue.reason === "string" ? redacted(dropValue.reason) : "upstream evidence was truncated or dropped",
    marker: "evidence-drop" as const
  } : null;
  if (drop) evidence.push({ kind: "evidence_drop", ref: "evidence-drop", complete: false, redacted: true });
  return { evidence, refs: [...new Set(refs)], drop };
}

function payloadError(payload: unknown, operation: string): StructuredAdapterError | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = typeof payload.error.code === "string" ? payload.error.code : "BRIDGE_TASK_FAILED";
  const message = typeof payload.error.message === "string" ? redacted(payload.error.message) : "Engineering Bridge task failed";
  return structuredAdapterError(code, "unknown", message, operation);
}

function payloadFailure(payload: unknown, evidenceDrop: boolean, operation: string): StructuredAdapterError | null {
  if (evidenceDrop) return structuredAdapterError("BRIDGE_EVIDENCE_DROP", "unknown", "Engineering Bridge evidence was dropped or truncated", operation);
  const error = payloadError(payload, operation);
  if (error) return error;
  if (!isRecord(payload)) return null;
  const raw = valueAt(payload, "state", "status");
  const state = typeof raw === "string" ? raw.toLowerCase() : "";
  if (valueAt(payload, "partial_output", "partialOutput") !== undefined || state === "partial_output") return structuredAdapterError("BRIDGE_PARTIAL_OUTPUT", "unknown", "Engineering Bridge returned partial output", operation);
  if (valueAt(payload, "evidence_drop", "evidenceDrop") !== undefined || state === "evidence-drop" || state === "evidence_drop") return structuredAdapterError("BRIDGE_EVIDENCE_DROP", "unknown", "Engineering Bridge reported an evidence drop", operation);
  if (state === "failed" || state === "error" || payload.ok === false || payload.success === false || (Object.prototype.hasOwnProperty.call(payload, "error") && payload.error !== null && payload.error !== undefined)) return structuredAdapterError("BRIDGE_TASK_FAILED", "unknown", "Engineering Bridge reported a failed task", operation);
  return null;
}

export class EngineeringBridgeAdapter {
  private readonly child: McpChildClient;
  private readonly registered = new Set<string>();
  private readonly evidenceLevel: "MOCK_PASS" | "UNKNOWN";
  private discovery: BridgeToolsDiscovery | null = null;

  constructor(options: EngineeringBridgeOptions);
  constructor(child: McpChildClient, registeredWorkspaces: Iterable<string> | Readonly<Record<string, unknown>>);
  constructor(optionsOrChild: EngineeringBridgeOptions | McpChildClient, workspaces?: Iterable<string> | Readonly<Record<string, unknown>>) {
    if (optionsOrChild instanceof McpChildClient) {
      this.child = optionsOrChild;
      this.evidenceLevel = "MOCK_PASS";
      this.addWorkspaces(workspaces ?? []);
    } else {
      if (!optionsOrChild.child) throw new TypeError("EngineeringBridgeAdapter requires an injected child client");
      this.child = optionsOrChild.child;
      this.evidenceLevel = optionsOrChild.evidenceLevel ?? "MOCK_PASS";
      this.addWorkspaces(optionsOrChild.registeredWorkspaces);
    }
  }

  get registeredWorkspaces(): string[] {
    return [...this.registered].sort();
  }

  async discoverTools(): Promise<BridgeToolsDiscovery> {
    const initAndList = await this.child.initializeAndListTools();
    const names = initAndList.tools.ok ? this.child.tools.map((tool) => {
      if (typeof tool === "string") return tool;
      if (isRecord(tool) && typeof tool.name === "string") return tool.name;
      return null;
    }).filter((name): name is string => name !== null) : [];
    const expected = [...ENGINEERING_BRIDGE_TOOL_NAMES];
    const missing = expected.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !expected.includes(name as EngineeringBridgeToolName));
    const error = !initAndList.ok
      ? initAndList.initialize.error ?? initAndList.tools.error ?? structuredAdapterError("BRIDGE_DISCOVERY_FAILED", "blocked", "Engineering Bridge initialize/tools-list failed", "tools/list")
      : missing.length > 0 || extra.length > 0
        ? structuredAdapterError("BRIDGE_TOOL_CONTRACT_MISMATCH", "blocked", "Engineering Bridge tools/list did not match the pinned 13-tool contract", "tools/list", { missing, extra, count: names.length })
        : null;
    this.discovery = {
      schemaVersion: "continuity.bridge-tools.v1",
      expectedCount: 13,
      expectedTools: expected,
      tools: names,
      missing,
      extra,
      exact: initAndList.ok && names.length === 13 && missing.length === 0 && extra.length === 0,
      childInitialize: initAndList.initialize,
      childToolsList: initAndList.tools,
      error,
      evidenceLevel: this.evidenceLevel
    };
    return this.discovery;
  }

  async runTask(input: BridgeRunTaskInput): Promise<WorkerReceipt> {
    this.requireWorkspace(input.workspace_id);
    this.requireDsh(input.executor);
    if (!nonEmptyString(input.instruction)) throw new DomainError("RED_FLAGGED_INPUT", "Bridge run_task requires a non-empty instruction");
    if (input.model !== undefined || input.reasoning_effort !== undefined) throw new DomainError("ROUTING_REJECTED", "DSH Bridge relay calls cannot carry Codex model or reasoning options");
    const args: Record<string, unknown> = {
      workspace_id: input.workspace_id,
      instruction: input.instruction,
      executor: "dsh",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort })
    };
    const call = await this.call("run_task", input.workspace_id, args, "dsh", input.idempotency_key);
    return this.workerReceipt(call, input.task_id ?? null, input.attempt_id, "bridge-dsh", "dsh_fresh", "run_task");
  }

  async runReadOnly(input: BridgeRunTaskInput): Promise<WorkerReceipt> {
    return this.runTask(input);
  }

  async taskResult(input: BridgeTaskResultInput): Promise<WorkerReceipt> {
    this.requireWorkspace(input.workspace_id);
    this.requireDsh(input.executor);
    const call = await this.call("task_result", input.workspace_id, { task_id: input.task_id }, "dsh", input.idempotency_key);
    return this.workerReceipt(call, null, input.attempt_id, "bridge-dsh", "dsh_fresh", "task_result");
  }

  async controlTask(input: BridgeControlTaskInput): Promise<WorkerReceipt> {
    this.requireWorkspace(input.workspace_id);
    this.requireDsh(input.executor);
    const args: Record<string, unknown> = { task_id: input.task_id, action: input.action };
    if (input.instruction !== undefined) args.instruction = input.instruction;
    const call = await this.call("control_task", input.workspace_id, args, "dsh", input.idempotency_key);
    return this.workerReceipt(call, null, input.attempt_id, "bridge-dsh", "dsh_fresh", "control_task");
  }

  async generateControlledPatch(input: BridgePatchGenerateInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    this.requireDsh(input.executor);
    if (!nonEmptyString(input.change_request)) throw new DomainError("RED_FLAGGED_INPUT", "change_request is required");
    if (input.model !== undefined || input.reasoning_effort !== undefined) throw new DomainError("ROUTING_REJECTED", "DSH Bridge patch proposals cannot carry Codex model or reasoning options");
    return this.call("generate_controlled_patch", input.workspace_id, {
      workspace_id: input.workspace_id,
      change_request: input.change_request,
      executor: "dsh",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort })
    }, "dsh", input.idempotency_key);
  }

  async refineControlledPatch(input: BridgePatchRefineInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    this.requireDsh(input.executor);
    if (!nonEmptyString(input.patch_task_id) || !nonEmptyString(input.change_request)) throw new DomainError("RED_FLAGGED_INPUT", "patch_task_id and change_request are required");
    if (input.model !== undefined || input.reasoning_effort !== undefined) throw new DomainError("ROUTING_REJECTED", "DSH Bridge patch proposals cannot carry Codex model or reasoning options");
    return this.call("refine_controlled_patch", input.workspace_id, {
      patch_task_id: input.patch_task_id,
      change_request: input.change_request,
      executor: "dsh",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort })
    }, "dsh", input.idempotency_key);
  }

  async submitControlledPatch(input: BridgePatchSubmitInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    if (!nonEmptyString(input.base_head) || !nonEmptyString(input.diff)) throw new DomainError("RED_FLAGGED_INPUT", "base_head and diff are required");
    return this.call("submit_controlled_patch", input.workspace_id, { workspace_id: input.workspace_id, base_head: input.base_head, diff: input.diff }, null, input.idempotency_key);
  }

  async applyControlledPatch(input: BridgePatchApplyInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    if (input.confirmation !== "APPLY") throw new DomainError("RED_FLAGGED_INPUT", "apply_controlled_patch requires exact confirmation APPLY");
    return this.call("apply_controlled_patch", input.workspace_id, { patch_task_id: input.patch_task_id, confirmation: "APPLY" }, null, input.idempotency_key);
  }

  async commitControlledPatch(input: BridgePatchCommitInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    if (!nonEmptyString(input.message) || input.confirmation !== "COMMIT") throw new DomainError("RED_FLAGGED_INPUT", "commit_controlled_patch requires a message and exact confirmation COMMIT");
    return this.call("commit_controlled_patch", input.workspace_id, { patch_task_id: input.patch_task_id, message: input.message, confirmation: "COMMIT" }, null, input.idempotency_key);
  }

  async validateControlledPatch(input: BridgePatchValidateInput): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    return this.call("validate_controlled_patch", input.workspace_id, { patch_task_id: input.patch_task_id }, null, input.idempotency_key);
  }

  async authorizeWorkspaceWrite(input: { workspace_id: string; confirmation: string; idempotency_key?: string }): Promise<BridgeToolReceipt> {
    this.requireWorkspace(input.workspace_id);
    if (input.confirmation !== "AUTHORIZE") throw new DomainError("RED_FLAGGED_INPUT", "authorize_workspace_write requires exact confirmation AUTHORIZE");
    return this.call("authorize_workspace_write", input.workspace_id, { workspace_id: input.workspace_id, confirmation: "AUTHORIZE" }, null, input.idempotency_key);
  }

  private async call(tool: EngineeringBridgeToolName, workspaceId: string, args: Record<string, unknown>, executor: BridgeExecutor | null, idempotencyKey?: string): Promise<BridgeToolReceipt> {
    const discovery = this.discovery?.exact === true ? this.discovery : await this.discoverTools();
    if (!discovery.exact) {
      return this.bridgeReceipt(tool, workspaceId, executor, idempotencyKey, null, false, "blocked", null, discovery.error ?? structuredAdapterError("BRIDGE_TOOL_CONTRACT_MISMATCH", "blocked", "Engineering Bridge 13-tool discovery proof is missing", tool));
    }
    let child: ChildMcpReceipt;
    try {
      child = await this.child.callTool(tool, args);
    } catch {
      return this.bridgeReceipt(
        tool,
        workspaceId,
        executor,
        idempotencyKey,
        null,
        false,
        "failed",
        null,
        structuredAdapterError("BRIDGE_CHILD_CALL_FAILED", "unknown", "Engineering Bridge child call failed", tool)
      );
    }
    try {
      const decoded = decodeToolResult(child.result, tool);
      const error = child.error ?? decoded.error ?? payloadFailure(decoded.payload, decoded.evidenceDrop, tool);
      const unknown = child.status === "unknown_in_flight" || child.status === "reconcile_required";
      const childFailed = !child.ok || child.status === "failed" || child.status === "timeout" || child.status === "exited";
      const status = unknown ? "unknown_in_flight" : error || childFailed ? "failed" : "completed";
      return this.bridgeReceipt(tool, workspaceId, executor, idempotencyKey, child, status === "completed", status, decoded.payload, error);
    } catch {
      // A malformed object/Proxy must not escape as an unredacted exception.
      // The child receipt still goes through bridgeReceipt's recursive
      // sanitizer before it is exposed to callers.
      return this.bridgeReceipt(
        tool,
        workspaceId,
        executor,
        idempotencyKey,
        child,
        false,
        "failed",
        null,
        structuredAdapterError("BRIDGE_PAYLOAD_UNSAFE", "unknown", "Engineering Bridge returned an unreadable payload", tool)
      );
    }
  }

  private workerReceipt(call: BridgeToolReceipt, taskId: string | null, suppliedAttemptId: string | undefined, kind: "bridge-dsh", continuation: "dsh_fresh", tool: EngineeringBridgeToolName): WorkerReceipt {
    const payload = call.data;
    const evidenceDrop = isRecord(payload) && /evidence[-_ ]drop/i.test(JSON.stringify(payload));
    const mapped = statusFrom(payload, evidenceDrop);
    const evidenceData = evidenceFrom(payload, evidenceDrop);
    const bridgeTaskId = isRecord(payload) ? nonEmptyString(valueAt(payload, "task_id", "taskId", "id")) : null;
    const output = isRecord(payload) ? nonEmptyString(valueAt(payload, "output", "review_output", "reviewOutput")) : null;
    const partialOutput = isRecord(payload) ? nonEmptyString(valueAt(payload, "partial_output", "partialOutput")) : null;
    const error = call.error ?? payloadError(payload, call.operation);
    const actualStatus = call.status === "unknown_in_flight" ? "unknown" : call.status !== "completed" || !call.ok || error ? mapped.status === "partial_output" || mapped.status === "evidence_drop" ? mapped.status : "failed" : mapped.status === "unknown" && tool === "run_task" && bridgeTaskId ? "attempt" : mapped.status;
    const actualWorkerStatus = actualStatus === "attempt" ? "queued" : actualStatus === "unknown" ? "unknown" : mapped.workerStatus;
    return {
      schemaVersion: "continuity.worker-receipt.v1",
      requestId: call.requestId,
      idempotencyKey: call.idempotencyKey,
      operation: call.operation,
      ok: call.ok && !error && actualStatus !== "failed" && actualStatus !== "unknown" && actualStatus !== "evidence_drop" && actualStatus !== "partial_output",
      taskId,
      attemptId: suppliedAttemptId ?? `attempt-${randomUUID()}`,
      kind,
      source: "engineering-bridge",
      continuation,
      status: actualStatus,
      externalStatus: mapped.external,
      workerStatus: actualWorkerStatus,
      realSessionRef: null,
      freshTurnRef: null,
      realJobId: null,
      bridgeTaskId,
      evidence: evidenceData.evidence,
      evidenceRefs: evidenceData.refs,
      review: mapped.external === "waiting_for_supervisor_review" ? { status: "waiting_for_supervisor_review", output, evidenceRefs: evidenceData.refs } : null,
      output,
      partialOutput,
      evidenceDrop: evidenceData.drop,
      error,
      evidenceLevel: call.evidenceLevel,
      state: null,
      revision: null,
      createdAt: call.createdAt
    };
  }

  private bridgeReceipt(tool: EngineeringBridgeToolName, workspaceId: string | null, executor: BridgeExecutor | null, suppliedIdempotencyKey: string | undefined, child: ChildMcpReceipt | null, ok: boolean, status: BridgeToolReceipt["status"], data: unknown, error: StructuredAdapterError | null): BridgeToolReceipt {
    const safeChild = child === null ? null : redactDeep(child) as ChildMcpReceipt;
    const safeError = error === null ? null : redactDeep(error) as StructuredAdapterError;
    return {
      schemaVersion: "continuity.bridge-receipt.v1",
      requestId: safeChild?.requestId === null || safeChild?.requestId === undefined ? `bridge-${randomUUID()}` : String(safeChild.requestId),
      idempotencyKey: suppliedIdempotencyKey ?? `bridge-${tool}-${randomUUID()}`,
      operation: `engineering-bridge:${tool}`,
      tool,
      workspaceId,
      executor,
      ok: ok && status === "completed" && safeError === null,
      status,
      data: redactDeep(data),
      childReceipt: safeChild,
      error: safeError,
      evidenceLevel: this.evidenceLevel,
      createdAt: nowIso()
    };
  }

  private requireDsh(executor: string | undefined): asserts executor is "dsh" {
    assertExplicitDsh(executor);
  }

  private requireWorkspace(workspaceId: string): void {
    if (!nonEmptyString(workspaceId) || !this.registered.has(workspaceId)) {
      throw new DomainError("ROUTING_REJECTED", "Engineering Bridge accepts only a registered workspace_id", { workspaceId });
    }
  }

  private addWorkspaces(workspaces: Iterable<string> | Readonly<Record<string, unknown>>): void {
    if (Symbol.iterator in Object(workspaces)) {
      for (const value of workspaces as Iterable<string>) if (nonEmptyString(value)) this.registered.add(value);
      return;
    }
    for (const key of Object.keys(workspaces)) if (nonEmptyString(key)) this.registered.add(key);
  }
}

export type EngineeringBridge = EngineeringBridgeAdapter;
