/**
 * Input schemas for the single externally visible Continuity App (design §5.2).
 *
 * Every schema is strict: unknown fields are rejected instead of silently
 * ignored.  Paths are workspace-relative strings resolved through the
 * allowlist; executors, actions and confirmation words are enums; mutation
 * tools require an idempotency key.
 */

import { z } from "zod";

/** Logical identifier: non-empty, no path separators, no traversal. */
const logicalId = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\u0000") && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..", {
    message: "identifier must not contain path separators or traversal"
  });

const idempotencyKey = z.string().min(8).max(200);

export const workerKindSchema = z.enum(["claude", "dsh", "bridge-dsh"]);
export const patchExecutorSchema = z.enum(["codex", "dsh", "bridge-dsh"]);
export const webSessionActionSchema = z.enum(["create", "attach", "send", "read", "stop"]);
export const workerControlActionSchema = z.enum(["continue", "steer", "interrupt", "accept"]);

/** Structured instruction reference; raw instruction text never crosses the boundary. */
export const instructionRefSchema = z.object({
  kind: z.enum(["evidence_ref", "checkpoint_ref", "handoff_item"]),
  ref: z.string().min(1).max(500)
}).strict();

/** Structured web payload; page text is never interpreted as a command. */
export const webPayloadSchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(20_000).optional(),
  manifestHash: z.string().min(1).max(200).optional(),
  pageState: z.enum(["loaded", "loading", "unknown"]).optional(),
  quotaError: z.enum(["none", "account_limit", "unknown"]).optional()
}).strict();

export const changeRequestSchema = z.object({
  title: z.string().min(1).max(200),
  motivation: z.string().min(1).max(4_000),
  workspaceId: z.string().min(1).max(100),
  /** Workspace-relative paths the change may touch. */
  paths: z.array(z.string().min(1).max(300)).min(1).max(50),
  baseHead: z.string().min(1).max(120)
}).strict();

/**
 * One entry of the complete remaining-work set.  Every field is required and
 * explicit: `createInitialLedger` refuses partially specified work items
 * (`normalizedWorkItem`), so a permissive schema here would only move the
 * failure deeper, after the caller had already committed to a task id.
 */
const remainingWorkItemSchema = z.object({
  taskId: logicalId,
  parentId: logicalId.nullable(),
  status: z.enum(["PENDING", "RUNNING", "BLOCKED", "DONE", "FAILED"]),
  dependencies: z.array(z.string().min(1).max(300)).max(500),
  acceptance: z.array(z.string().min(1).max(300)).max(200),
  acceptancePassed: z.boolean(),
  evidence: z.array(z.string().min(1).max(500)).max(500),
  lastCheckpoint: z.string().max(500).nullable(),
  sourceOfTruth: z.string().min(1).max(500)
}).strict();

export const TOOL_INPUT_SCHEMAS = {
  /**
   * The relay (Plus) entrypoint.  Without it no other relay tool can run at
   * all: every one of them starts with `assertRegisteredTaskId`, and the task
   * registry had no production writer.
   */
  continuity_task_register: z.object({
    task_id: logicalId,
    project_id: logicalId,
    repository_id: logicalId,
    relay_epoch: z.string().min(1).max(200).optional(),
    thread_id: z.string().min(1).max(200).optional(),
    active_turn_id: z.string().min(1).max(200).optional(),
    scope_cutoff_at: z.string().min(1).max(100).optional(),
    remaining_work: z.array(remainingWorkItemSchema).max(5_000).optional(),
    idempotency_key: idempotencyKey
  }).strict(),

  /**
   * CODEX_ACTIVE → DRAINING → HANDOFF_READY.  `registered_thread_ids` must
   * equal the complete visible active-thread set; a strict subset is rejected
   * by the drain fence, never silently narrowed.
   */
  continuity_drain: z.object({
    task_id: logicalId,
    expected_revision: z.number().int().nonnegative(),
    registered_thread_ids: z.array(z.string().min(1).max(200)).max(1_000).optional(),
    project_mapping: z.record(z.string().min(1).max(200), z.string().min(1).max(200).nullable()).optional(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_quota_snapshot: z.object({
    freshness_ms: z.number().int().positive().max(3_600_000).optional()
  }).strict(),

  continuity_task_list: z.object({
    project_id: logicalId.optional(),
    state: z.enum([
      "CODEX_ACTIVE",
      "DRAINING",
      "HANDOFF_READY",
      "WEB_UNATTENDED_EXECUTING",
      "WEB_TERMINAL",
      "RETURN_READY",
      "CODEX_RESUMED"
    ]).optional()
  }).strict(),

  continuity_task_status: z.object({
    task_id: logicalId
  }).strict(),

  continuity_checkpoint: z.object({
    task_id: logicalId,
    checkpoint: z.string().min(1).max(500),
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_prepare_handoff: z.object({
    task_id: logicalId,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_web_session: z.object({
    task_id: logicalId,
    action: webSessionActionSchema,
    payload: webPayloadSchema,
    expected_revision: z.number().int().nonnegative().optional(),
    idempotency_key: idempotencyKey.optional()
  }).strict(),

  continuity_worker_run: z.object({
    task_id: logicalId,
    worker_kind: workerKindSchema,
    instruction_ref: instructionRefSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_worker_control: z.object({
    attempt_id: logicalId,
    action: workerControlActionSchema,
    /** Required by `continue`/`steer`; raw instruction text is rejected downstream. */
    instruction_ref: instructionRefSchema.optional(),
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_patch_propose: z.object({
    task_id: logicalId,
    change_request: changeRequestSchema,
    executor: patchExecutorSchema,
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_patch_validate: z.object({
    patch_task_id: logicalId
  }).strict(),

  continuity_patch_apply: z.object({
    patch_task_id: logicalId,
    confirmation: z.literal("APPLY"),
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_patch_commit: z.object({
    patch_task_id: logicalId,
    message: z.string().min(1).max(500),
    confirmation: z.literal("COMMIT"),
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_prepare_return: z.object({
    task_id: logicalId,
    idempotency_key: idempotencyKey
  }).strict(),

  continuity_resume_codex: z.object({
    task_id: logicalId,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: idempotencyKey
  }).strict(),

  // Web-facing handoff delivery tools (plan 4C/4E): the web reads the manifest,
  // verifies chunk and total hashes, then records an accept receipt.
  continuity_handoff_manifest_read: z.object({
    task_id: logicalId
  }).strict(),

  continuity_handoff_chunk_read: z.object({
    task_id: logicalId,
    chunk_index: z.number().int().nonnegative(),
    chunk_hash: z.string().min(8).max(200)
  }).strict(),

  continuity_handoff_accept: z.object({
    task_id: logicalId,
    manifest_hash: z.string().min(8).max(200),
    client_ref: z.string().min(1).max(200),
    idempotency_key: idempotencyKey
  }).strict(),

  // Read-only registry enumeration of the Codex app-server thread registry
  // (plan 4B wire RPC thread/list).  Purely observational: no local state is
  // consulted, no other RPC is ever issued, and every page/cursor actually
  // observed is reported back.  No mutation tool and never a write.
  continuity_codex_tasks_list: z.object({
    page_limit: z.number().int().positive().max(100).optional(),
    limit: z.number().int().positive().max(10_000).optional()
  }).strict()
} as const;

export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;
export type ToolInput<T extends ToolName = ToolName> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[T]>;

export const TOOL_NAMES = Object.keys(TOOL_INPUT_SCHEMAS) as ToolName[];

/** Tools that mutate state and therefore must be idempotent. */
export const MUTATING_TOOLS = new Set<ToolName>([
  "continuity_task_register",
  "continuity_drain",
  "continuity_checkpoint",
  "continuity_prepare_handoff",
  "continuity_web_session",
  "continuity_worker_run",
  "continuity_worker_control",
  "continuity_patch_propose",
  "continuity_patch_apply",
  "continuity_patch_commit",
  "continuity_prepare_return",
  "continuity_resume_codex",
  "continuity_handoff_accept"
]);

/** Which tools carry an optional idempotency key (send/read web session). */
export function idempotencyKeyOf<T extends ToolName>(tool: T, input: ToolInput<T>): string | null {
  const candidate = (input as { idempotency_key?: string }).idempotency_key;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return null;
}

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  mutating: boolean;
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  { name: "continuity_task_register", description: "Register a relay task and persist its initial ledger, binding the remaining-work source hash that handoff preparation verifies. Every other relay tool requires a registered task; re-registering the same task id is rejected.", mutating: true },
  { name: "continuity_drain", description: "Move a registered task from CODEX_ACTIVE to DRAINING and then HANDOFF_READY: interrupt the complete visible active Codex thread set, reconcile the work set, write handoff.md and enter HANDOFF_READY only when the full drain fence passes. A partial or unprovable drain leaves the task in DRAINING with structured faults.", mutating: true },
  { name: "continuity_quota_snapshot", description: "Primary/secondary quota windows, remaining basis points, freshness and gate decision.", mutating: false },
  { name: "continuity_task_list", description: "Managed task summaries with their chat/thread/worker mappings.", mutating: false },
  { name: "continuity_task_status", description: "Current state, revision, last event, fault and next action for one task.", mutating: false },
  { name: "continuity_checkpoint", description: "Record a task checkpoint under revision control.", mutating: true },
  { name: "continuity_prepare_handoff", description: "Reconcile the complete remaining_work set and generate handoff references.", mutating: true },
  { name: "continuity_web_session", description: "Create/attach/send/read/stop the task web chat with receipt evidence.", mutating: true },
  { name: "continuity_worker_run", description: "Start a worker attempt with an explicit allowlisted worker kind.", mutating: true },
  { name: "continuity_worker_control", description: "Continue/steer/interrupt/accept a worker attempt by registered id.", mutating: true },
  { name: "continuity_patch_propose", description: "Propose a controlled patch for an explicit executor; never writes files.", mutating: true },
  { name: "continuity_patch_validate", description: "Structured patch validation verdict (PASS/FAIL/INCOMPLETE).", mutating: false },
  { name: "continuity_patch_apply", description: "Apply a validated patch; requires the exact literal APPLY confirmation.", mutating: true },
  { name: "continuity_patch_commit", description: "Commit an applied patch; requires the exact literal COMMIT confirmation.", mutating: true },
  { name: "continuity_prepare_return", description: "Prepare return to Codex after a terminal reason and quota hysteresis.", mutating: true },
  { name: "continuity_resume_codex", description: "Resume the original Codex thread with a real receipt.", mutating: true },
  { name: "continuity_handoff_manifest_read", description: "Read the handoff manifest (chunk list, chunk hashes, total hash).", mutating: false },
  { name: "continuity_handoff_chunk_read", description: "Read one handoff chunk after hash verification.", mutating: false },
  { name: "continuity_handoff_accept", description: "Record the web-side handoff acceptance receipt after hash reconciliation.", mutating: true },
  {
    name: "continuity_codex_tasks_list",
    // Read-only + idempotent equivalents of the MCP hint fields (this App's
    // ListTools advertises only name/description/inputSchema).  The strict
    // optional-parameters schema is itself read-only, and the description
    // states the tool never mutates and is repeatable without side effects.
    description: "Read-only listing of Codex app-server registry threads via the thread/list RPC (never mutates, no side effects, repeatable; thread ids are never excluded). Omitting page_limit enumerates the full registry.",
    mutating: false
  }
];
