/**
 * ContinuityMcpServer — the single externally visible MCP App (plan §8.3.1-3).
 *
 * One registry mounts exactly the high-level tools of design §5.2 plus the
 * web-facing handoff delivery tools.  Child MCP tools are hidden: they are
 * reachable only through the internal adapters, never through this App.
 *
 * Dispatch order for every call:
 *   1. registry lookup (unknown tool → structured error)
 *   2. feature-flag gate (the App is off unless explicitly enabled)
 *   3. strict schema validation (unknown fields rejected)
 *   4. mutation idempotency (replay returns the original receipt; a reused
 *      key with a different payload fails)
 *   5. allowlist registration checks (paths/executors/actions/IDs)
 *   6. revision-controlled state machine work via the TaskCoordinator
 *
 * Every result — success or failure — is a unified envelope.
 */

import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { clone, sha256 } from "../domain/canonical.js";
import {
  allTasksCompleted,
  enterWebTerminal,
  setFault,
  transitionLedger,
  updateLedger
} from "../domain/state-machine.js";
import type { CompletionReceipt, RemainingWorkItem, TaskLedger, TerminalReason, WorkerStatus } from "../domain/types.js";
import { evaluateQuotaGate, decisionToLedgerQuotaGate, type QuotaGateSnapshot } from "../quota/quota-gate.js";
import { validateExecutorRequest } from "../routing/executor-policy.js";
import { workSetHash, type HandoffStore } from "../persistence/handoff-store.js";
import type { RelayAttemptRecord, RelayEnvelopeRecord, RelayPatchRecord, RelayServerStore } from "../persistence/runtime-durable-stores.js";
import type { FeatureFlags } from "../flags.js";
import { Allowlist } from "../security/allowlist.js";
import { ConfirmationGateRegistry, assertExactConfirmation } from "../security/confirmations.js";
import type { EvidenceWriter } from "../evidence/evidence-writer.js";
import type { TaskCoordinator } from "../workflow/task-coordinator.js";
import {
  acceptHandoff,
  buildHandoffManifest,
  prepareHandoff,
  readHandoffChunk,
  type HandoffManifest
} from "../workflow/handoff.js";
import { drainAllVisibleActiveThreads, drainFencePassed, type DrainOptions, type DrainResult } from "../workflow/drain.js";
import {
  validateWave2DrainProof,
  type WorkerControlAction,
  type WorkerControlRequest,
  type WorkerSupervisionController
} from "../workflow/supervision.js";
import { assessReturnReadiness, type ReturnQuotaSnapshot } from "../workflow/return.js";
import { planReconciliation, type ReceiptKind } from "../workflow/reconcile.js";
import type { WebgptDriveAdapter } from "../adapters/webgpt-drive.js";
import type { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import type { CodexAppServerLazySeam, CodexAppServerStdioTransport, ToolRegistryListResult } from "../adapters/codex-app-server-stdio.js";
import { LocalBackendFailure } from "../adapters/local-worker-backends.js";
import type { DurableWorkerAttemptRecord, LocalDurableStore } from "../adapters/local-worker-backends.js";
import { sanitizeRuntimeValue } from "../runtime-config.js";
import {
  MUTATING_TOOLS,
  TOOL_DESCRIPTORS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  idempotencyKeyOf,
  type ToolDescriptor,
  type ToolInput,
  type ToolName
} from "./schemas.js";
import {
  ContinuityEnvelope,
  EnvelopeContext,
  envelopeError,
  errorEnvelope,
  errorFromDomainError,
  okEnvelope
} from "./result.js";
import { TasksListReceiptEmitter, type TasksListReceiptSink } from "./tasks-list-receipt.js";
import type { z } from "zod";

export interface QuotaProvider {
  /** The latest normalized App Server quota snapshot, or null when unavailable. */
  snapshot(): QuotaGateSnapshot | null;
}

/** Optional worker execution backend (real adapters are wired by the caller). */
export interface WorkerRunBackend {
  run(input: { taskId: string; workerKind: "claude" | "dsh" | "bridge-dsh"; instructionRef: { kind: string; ref: string }; idempotencyKey: string }): Promise<{
    realJobId: string;
    attemptId: string;
    status: "queued" | "running" | "failed";
    evidenceRefs: string[];
  }>;
}

/** Optional controlled patch backend (bridge adapter or a mock). */
export interface PatchBackend {
  propose(input: { changeRequest: Record<string, unknown>; executor: string; idempotencyKey: string }): Promise<{ diff: string; baseHead: string }>;
  validate(input: { patchTaskId: string; diff: string }): Promise<{ verdict: "PASS" | "FAIL" | "INCOMPLETE"; reasons: string[] }>;
  apply(input: { patchTaskId: string; diff: string }): Promise<{ changedFiles: string[]; applyReceiptId: string }>;
  commit(input: { patchTaskId: string; message: string }): Promise<{ commitHash: string; commitReceiptId: string }>;
}

/**
 * Outcome of one real upstream worker-control action.  `confirmed` is the only
 * thing that may authorize a success envelope: an unconfirmed or unsupported
 * action is reported as a failure, never as "the worker stopped".
 */
export interface WorkerControlOutcome {
  confirmed: boolean;
  receipt: unknown;
  /** Upstream status string when the backend reports one. */
  status: string | null;
  code: string | null;
  message: string | null;
}

/**
 * Real worker-control seam.  It is the only boundary allowed to steer or
 * interrupt a running worker; without it the control tool fails closed instead
 * of acknowledging an action that never reached a process.
 */
export interface WorkerControlBackend {
  /** Worker kinds this backend can actually control upstream. */
  readonly supportedKinds: readonly ("claude" | "dsh" | "bridge-dsh")[];
  control(input: {
    taskId: string;
    attemptId: string;
    workerKind: "claude" | "dsh" | "bridge-dsh";
    action: WorkerControlAction;
    workspaceId: string;
    instructionRef: { kind: string; ref: string } | null;
    idempotencyKey: string;
  }): Promise<WorkerControlOutcome>;
}

export interface ContinuityAppOptions {
  coordinator: TaskCoordinator;
  store: HandoffStore;
  allowlist: Allowlist;
  confirmations: ConfirmationGateRegistry;
  evidence: EvidenceWriter;
  webgpt: WebgptDriveAdapter;
  flags: FeatureFlags;
  quotaProvider?: QuotaProvider;
  workerBackend?: WorkerRunBackend;
  patchBackend?: PatchBackend;
  /**
   * Lazy start+initialize gate for the App Server child, plus the transport it
   * owns.  Absent in the test profile and in production without an explicit
   * App Server stdio configuration; the read-only tool then fails closed
   * without ever starting a child.  The child stays idle (no spawn, no
   * initialize RPC) from assembly through every non-App-Server tool call; the
   * first `continuity_codex_tasks_list` call is the only trigger.
   */
  codexAppServerStdioLazy?: CodexAppServerLazySeam | null;
  /**
   * The Codex App Server adapter the relay drives: `thread/list` +
   * `turn/interrupt` for the drain workflow and `thread/resume` for the return
   * to the original Codex thread.  Absent in the test profile and in production
   * without an explicit stdio configuration; the dependent tools then fail
   * closed instead of fabricating a local registry or a substitute thread.
   */
  codexAppServer?: Pick<CodexAppServerAdapter, "listVisibleActiveThreads" | "interruptTurn" | "resumeThread"> | null;
  /** Supervised worker-attempt state machine (continue/steer/interrupt/accept). */
  supervision?: WorkerSupervisionController | null;
  /** Real upstream worker-control seam; absent means no control is ever claimed. */
  workerControl?: WorkerControlBackend | null;
  /**
   * Durable patch / idempotency / attempt registry.  Without it the server
   * keeps the original process-memory behaviour, which is correct for a single
   * test process but loses validated patches and idempotent replays on restart.
   */
  serverStore?: RelayServerStore | null;
  /** Durable worker-attempt ledger; resolves `attempt_id` to its parent task. */
  workerLedger?: LocalDurableStore | null;
  now?: () => Date;
  /**
   * Test seam for the structured stderr audit events of the read-only App
   * Server tools (contract 2 of the D-MOUNT receipt work).  Defaults to
   * process.stderr; events are single-line JSON and write failures never
   * affect the tool result.
   */
  tasksListReceiptSink?: TasksListReceiptSink | null;
}

/** Proposed-patch ledger entry; durable through `serverStore` when one is wired. */
type PatchRecord = RelayPatchRecord;

interface ManifestRecord {
  manifest: HandoffManifest;
  text: string;
}

export class ContinuityMcpServer {
  private readonly patches = new Map<string, PatchRecord>();
  private readonly manifests = new Map<string, ManifestRecord>();
  /** Supervised worker attempts keyed by attempt id; durable when a store is wired. */
  private readonly attempts = new Map<string, RelayAttemptRecord>();
  /** Mutation-idempotency replay store (design §6.4). */
  private readonly completedEnvelopes = new Map<string, { envelope: ContinuityEnvelope; payloadHash: string }>();

  constructor(private readonly options: ContinuityAppOptions) {
    this.recoverDurableState();
  }

  /**
   * Rebuild the process-memory caches from durable state.  A validated patch
   * must still be applicable, a supervised attempt must still be controllable,
   * and an idempotency key must still replay its original receipt, after the
   * MCP process that produced them is gone.
   */
  private recoverDurableState(): void {
    const store = this.options.serverStore;
    if (!store) return;
    for (const record of store.listPatches()) {
      // The allowlist is the second half of recovery: a restored identifier
      // that was never re-registered would still be rejected by the gate.
      this.options.allowlist.registerPatchTaskId(record.patchTaskId);
      this.patches.set(record.patchTaskId, record);
    }
    for (const attempt of store.listAttempts()) {
      this.options.allowlist.registerAttemptId(attempt.attemptId);
      this.attempts.set(attempt.attemptId, attempt);
    }
    for (const entry of store.listEnvelopes()) {
      this.completedEnvelopes.set(`${entry.key}:${entry.tool}`, {
        envelope: entry.envelope as ContinuityEnvelope,
        payloadHash: entry.payloadHash
      });
    }
  }

  /** Current supervised attempt for an id, from memory or from the durable ledger. */
  private attemptOrNull(attemptId: string): RelayAttemptRecord | null {
    const cached = this.attempts.get(attemptId);
    if (cached) return cached;
    const stored = this.options.serverStore?.getAttempt(attemptId);
    if (!stored) return null;
    this.attempts.set(stored.attemptId, stored);
    return stored;
  }

  private saveAttempt(record: RelayAttemptRecord): void {
    this.attempts.set(record.attemptId, record);
    this.options.serverStore?.putAttempt(record);
  }

  /**
   * Persist a proposed/validated/applied/committed patch.  A validated patch
   * that only lived in process memory could not be applied after a restart,
   * yet the approval gate that authorized it had already been consumed.
   */
  private savePatch(record: PatchRecord): void {
    this.patches.set(record.patchTaskId, record);
    this.options.serverStore?.putPatch(record);
  }

  /**
   * Resolve the worker attempt that a control call targets.  The tool input
   * carries only `attempt_id`, so the parent task and routing kind have to come
   * from the durable worker ledger rather than from the caller.
   */
  private workerAttemptRecord(attemptId: string): DurableWorkerAttemptRecord | null {
    const ledger = this.options.workerLedger;
    if (!ledger) return null;
    for (const record of ledger.listWorkerAttempts()) {
      if (record.receipt?.attemptId === attemptId) return record;
    }
    return null;
  }

  /** The tool manifest of this single App; child tools never appear here. */
  listTools(): ToolDescriptor[] {
    return TOOL_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
  }

  hasTool(name: string): name is ToolName {
    return (TOOL_NAMES as string[]).includes(name);
  }

  /**
   * Dispatch one tool call.  This method never throws: every failure mode is
   * returned as an error envelope so the web side always receives a
   * structured, explainable result.
   */
  async call(rawTool: string, rawInput: unknown, requestId: string): Promise<ContinuityEnvelope> {
    const context: EnvelopeContext = { requestId };
    if (!this.hasTool(rawTool)) {
      return errorEnvelope(context, envelopeError("TOOL_UNKNOWN", `tool ${rawTool} is not part of this app`, { needs_human: false }));
    }
    const tool = rawTool;
    if (!this.options.flags.CONTINUITY_ORCHESTRATOR_ENABLED) {
      return errorEnvelope(context, envelopeError("FEATURE_DISABLED", "CONTINUITY_ORCHESTRATOR_ENABLED is false; the app is fail-closed"));
    }
    let input: ToolInput<ToolName>;
    try {
      input = TOOL_INPUT_SCHEMAS[tool].parse(rawInput) as ToolInput<ToolName>;
    } catch (error) {
      if (error && typeof error === "object" && "issues" in error) {
        const issues = (error as z.ZodError).issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        return errorEnvelope(context, envelopeError("TOOL_INPUT_INVALID", `input rejected: ${issues}`, { needs_human: false }));
      }
      return errorEnvelope(context, envelopeError("TOOL_INPUT_INVALID", "input rejected", { needs_human: false }));
    }
    context.taskId = ("task_id" in input && typeof input.task_id === "string" ? input.task_id : null) ?? ("patch_task_id" in input && typeof (input as { patch_task_id?: string }).patch_task_id === "string" ? (input as { patch_task_id: string }).patch_task_id : null);
    context.idempotencyKey = idempotencyKeyOf(tool, input);

    // Mutation idempotency: replays return the original receipt envelope;
    // a reused key with a different payload is rejected (design §6.4).
    if (this.requiresIdempotencyKey(tool, input)) {
      const key = context.idempotencyKey;
      if (!key) {
        return errorEnvelope(context, envelopeError("TOOL_INPUT_INVALID", "mutation tools require an idempotency key", { needs_human: false }));
      }
      const replay = this.replayEnvelope(key, tool, input, requestId);
      if (replay) return replay;
    }

    try {
      const envelope = await this.dispatch(tool, input, context, requestId);
      if (this.requiresIdempotencyKey(tool, input) && context.idempotencyKey && envelope.ok) {
        const payloadHash = payloadFingerprint(input);
        this.completedEnvelopes.set(`${context.idempotencyKey}:${tool}`, { envelope, payloadHash });
        // Durability first: a restart between two tool calls must not lose the
        // fact that this key already produced a receipt.
        this.options.serverStore?.putEnvelope({
          key: context.idempotencyKey,
          tool,
          payloadHash,
          envelope: sanitizeRuntimeValue(envelope),
          at: this.nowIso()
        });
      }
      return envelope;
    } catch (error) {
      if (error instanceof DomainError) {
        return errorEnvelope(context, errorFromDomainError(error), this.faultData(context.taskId));
      }
      if (error instanceof LocalBackendFailure) {
        const detail = sanitizeRuntimeValue(error.detail);
        const retryable = detail.class === "upstream_rate_limited" || detail.class === "upstream_unavailable" || detail.class === "unknown";
        const needsHuman = detail.class === "blocked" || detail.class === "needs_attention" || detail.class === "unknown";
        const receipt = error.receipt === null ? null : sanitizeRuntimeValue(error.receipt);
        return errorEnvelope(context, envelopeError(detail.code, detail.message, { retryable, needs_human: needsHuman }), {
          ...this.faultData(context.taskId),
          backend_detail: detail,
          receipt
        });
      }
      const message = error instanceof Error ? error.message : "unknown dispatch failure";
      return errorEnvelope(context, envelopeError("DISPATCH_FAILED", message, { retryable: false }), this.faultData(context.taskId));
    }
  }

  /** Every mutating tool needs a key; web_session needs one for all but read. */
  private requiresIdempotencyKey(tool: ToolName, input: ToolInput<ToolName>): boolean {
    if (!MUTATING_TOOLS.has(tool)) return false;
    if (tool === "continuity_web_session") {
      return (input as ToolInput<"continuity_web_session">).action !== "read";
    }
    return true;
  }

  private replayEnvelope(key: string, tool: ToolName, input: unknown, requestId: string): ContinuityEnvelope | null {
    const existing = this.completedEnvelopes.get(`${key}:${tool}`);
    if (!existing) return null;
    if (existing.payloadHash !== payloadFingerprint(input)) {
      return errorEnvelope(
        { requestId },
        envelopeError("IDEMPOTENCY_KEY_REUSED", "idempotency key was already used for a different payload", { retryable: false })
      );
    }
    return { ...existing.envelope, request_id: requestId, warnings: [...existing.envelope.warnings, "idempotent replay"] };
  }

  private faultData(taskId: string | null): Record<string, unknown> {
    if (!taskId || !this.options.coordinator.has(taskId)) return {};
    const ledger = this.options.coordinator.get(taskId);
    return { state: ledger.lifecycleState, revision: ledger.revision };
  }

  private withLedger(context: EnvelopeContext, ledger: TaskLedger): void {
    context.taskId = ledger.taskId;
    context.projectId = ledger.projectId;
    context.state = ledger.lifecycleState;
    context.revision = ledger.revision;
  }

  private nowIso(): string {
    return (this.options.now ? this.options.now() : new Date()).toISOString();
  }

  private requireFreshQuota(): { decision: ReturnType<typeof evaluateQuotaGate>; ledgerGate: TaskLedger["quotaGate"] } {
    const provider = this.options.quotaProvider;
    if (!provider) throw new DomainError("RED_FLAGGED_INPUT", "no quota provider is configured; quota-guarded tools stay fail-closed");
    const snapshot = provider.snapshot();
    if (!snapshot) throw new DomainError("RED_FLAGGED_INPUT", "quota provider returned no sample");
    const decision = evaluateQuotaGate(snapshot, { now: this.options.now ? this.options.now() : new Date() });
    if (!decision.sampleFresh) throw new DomainError("RED_FLAGGED_INPUT", "quota sample is stale; refusing automatic decisions");
    return { decision, ledgerGate: decisionToLedgerQuotaGate(snapshot, decision) };
  }

  private async dispatch(tool: ToolName, input: ToolInput<ToolName>, context: EnvelopeContext, requestId: string): Promise<ContinuityEnvelope> {
    switch (tool) {
      case "continuity_task_register":
        return this.taskRegister(context, input as ToolInput<"continuity_task_register">, requestId);
      case "continuity_drain":
        return this.drain(context, input as ToolInput<"continuity_drain">, requestId);
      case "continuity_quota_snapshot":
        return this.quotaSnapshot(context, requestId);
      case "continuity_task_list":
        return this.taskList(context, input as ToolInput<"continuity_task_list">);
      case "continuity_task_status":
        return this.taskStatus(context, input as ToolInput<"continuity_task_status">);
      case "continuity_checkpoint":
        return this.checkpoint(context, input as ToolInput<"continuity_checkpoint">);
      case "continuity_prepare_handoff":
        return this.prepareHandoffTool(context, input as ToolInput<"continuity_prepare_handoff">, requestId);
      case "continuity_web_session":
        return this.webSession(context, input as ToolInput<"continuity_web_session">, requestId);
      case "continuity_worker_run":
        return this.workerRun(context, input as ToolInput<"continuity_worker_run">, requestId);
      case "continuity_worker_control":
        return await this.workerControl(context, input as ToolInput<"continuity_worker_control">);
      case "continuity_patch_propose":
        return this.patchPropose(context, input as ToolInput<"continuity_patch_propose">, requestId);
      case "continuity_patch_validate":
        return this.patchValidate(context, input as ToolInput<"continuity_patch_validate">);
      case "continuity_patch_apply":
        return this.patchApply(context, input as ToolInput<"continuity_patch_apply">, requestId);
      case "continuity_patch_commit":
        return this.patchCommit(context, input as ToolInput<"continuity_patch_commit">, requestId);
      case "continuity_prepare_return":
        return this.prepareReturn(context, input as ToolInput<"continuity_prepare_return">, requestId);
      case "continuity_resume_codex":
        return await this.resumeCodex(context, input as ToolInput<"continuity_resume_codex">);
      case "continuity_handoff_manifest_read":
        return this.handoffManifestRead(context, input as ToolInput<"continuity_handoff_manifest_read">);
      case "continuity_handoff_chunk_read":
        return this.handoffChunkRead(context, input as ToolInput<"continuity_handoff_chunk_read">);
      case "continuity_handoff_accept":
        return this.handoffAccept(context, input as ToolInput<"continuity_handoff_accept">, requestId);
      case "continuity_codex_tasks_list":
        // The tool is read-only and stateless: no evidence write, no replay
        // store, and no caller-carrying idempotency bookkeeping.
        return this.codexTasksList(context, input as ToolInput<"continuity_codex_tasks_list">);
      default: {
        const exhaustive: never = tool;
        return errorEnvelope(context, envelopeError("TOOL_UNKNOWN", `unhandled tool ${String(exhaustive)}`));
      }
    }
  }

  private quotaSnapshot(context: EnvelopeContext, requestId: string): ContinuityEnvelope {
    const { decision, ledgerGate } = this.requireFreshQuota();
    return okEnvelope(context, {
      status: decision.status,
      codex_available: decision.codexAvailable,
      drain_required: decision.drainRequired,
      return_ready: decision.returnReady,
      secondary_guard: decision.secondaryGuard,
      sample_fresh: decision.sampleFresh,
      primary_remaining_bps: decision.primaryRemainingBps,
      secondary_remaining_bps: decision.secondaryRemainingBps,
      updated_at: decision.updatedAt,
      sample_id: decision.sampleId,
      faults: decision.faults,
      ledger_gate: ledgerGate,
      request_id: requestId
    });
  }

  private taskList(context: EnvelopeContext, input: ToolInput<"continuity_task_list">): ContinuityEnvelope {
    const summaries = this.options.coordinator.listTasks({ projectId: input.project_id, state: input.state });
    return okEnvelope(context, { tasks: summaries });
  }

  /**
   * Read-only enumeration of the Codex app-server registry via the real
   * `thread/list` wire RPC.  Fail-closed: without an explicit App Server stdio
   * configuration no child is ever started and the tool errors instead of
   * fabricating a local registry.  Thread ids are never excluded; a caller
   * must simply not invoke the CURRENT_EXCLUDED thread id.
   *
   * The lazy seam owns the child lifecycle: the first call starts the child
   * and completes the initialize/initialized handshake exactly once (a burst
   * of first calls single-flights onto one attempt), every later call reuses
   * the initialized connection, and a failed start/initialize fails this call
   * closed with the structured fault instead of returning an empty list.
   *
   * Audit (D-MOUNT): every call draws an unpredictable, non-sensitive
   * receipt_id (contract 1) that is both returned in the envelope `data` and
   * threaded through the structured single-line stderr events emitted by this
   * call (contract 2).  Events carry only safe counters, flags and cursor
   * digests — never a raw cursor, thread title, path, summary or secret —
   * and go to stderr only, so the stdout MCP framing is never polluted.  A
   * failing stderr sink can never break the tool call.
   */
  private async codexTasksList(context: EnvelopeContext, input: ToolInput<"continuity_codex_tasks_list">): Promise<ContinuityEnvelope> {
    const seam = this.options.codexAppServerStdioLazy;
    if (!seam) {
      return errorEnvelope(context, envelopeError("APP_SERVER_UNAVAILABLE", "continuity_codex_tasks_list requires an App Server stdio configuration; none is present", { retryable: false, needs_human: false }));
    }
    // The one unpredictable non-sensitive identity of this call.  Everything
    // in the audit stream and in the envelope data refers back to it.
    const receiptId = randomUUID();
    const emitter = new TasksListReceiptEmitter(receiptId, {
      ...(this.options.tasksListReceiptSink !== undefined && this.options.tasksListReceiptSink !== null
        ? { sink: this.options.tasksListReceiptSink }
        : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {})
    });
    emitter.toolCallReceived(input.page_limit ?? null, input.limit ?? null);

    // Fail-closed data: on a non-ok envelope the pages/threads gathered so far
    // still describe the RPCs actually issued.  The receipt id stays attached
    // to the error too, so an auditor can match the failure stream to it.
    const data = {
      actual_rpc_methods_observed: ["thread/list"] as ["thread/list"],
      page_count: 0,
      unique_thread_count: 0,
      pages: [] as Array<{ index: number; input_cursor: string | null; output_cursor: string | null; item_count: number }>,
      threads: [] as Array<{ thread_id: string; turn_id: string | null; project_id: string | null; repository_id: string | null; status: string | null; source_kind: string | null }>,
      complete: false,
      receipt_id: receiptId
    };
    const failed = (code: string, stage: string, message: string, needsHuman = false): ContinuityEnvelope => {
      emitter.failed({ code, stage });
      return errorEnvelope(context, envelopeError(code, message, { retryable: false, needs_human: needsHuman }), data);
    };
    const ensured = await seam.ensureInitialized();
    if (!ensured.ok) {
      // start/initialize failures are not caller-retryable within this call:
      // the envelope fails closed and the next call may retry from the same
      // lifecycle (the latch was released) unless it is terminal.
      const faultError = ensured.error ?? { code: "APP_SERVER_ERROR", message: "App Server start/initialize failed", operation: "ensure_initialized", requestId: null, at: "" };
      return failed(faultError.code, "ensure_initialized", faultError.message, faultError.code === "RECONCILE_REQUIRED");
    }
    emitter.childStarted(ensured.reused === true, ensured.childInstanceId ?? seam.stdio.childInstanceId ?? "child-unknown");
    emitter.initialized();
    const result: ToolRegistryListResult = await seam.stdio.listRegistryThreadsForTool({
      limit: input.limit ?? null,
      pageLimit: input.page_limit ?? null,
      onPage: (page) => {
        emitter.rpcPage(page);
      }
    });
    // The enumeration payload is the same closed, safe shape whether the walk
    // completed or stopped: only safe thread fields cross the boundary, and on
    // a fail-closed stop the pages/threads gathered so far still describe the
    // RPCs actually issued (actual_rpc_methods_observed, complete: false).
    data.actual_rpc_methods_observed = result.actualRpcMethodsObserved;
    data.page_count = result.pages.length;
    data.unique_thread_count = result.threads.length;
    data.pages = result.pages.map((page) => ({
      index: page.index,
      input_cursor: page.inputCursor,
      output_cursor: page.outputCursor,
      item_count: page.itemCount
    }));
    data.threads = result.threads.map((thread) => ({
      thread_id: thread.threadId,
      turn_id: thread.turnId,
      project_id: thread.projectId,
      repository_id: thread.repositoryId,
      status: thread.status,
      source_kind: thread.sourceKind
    }));
    data.complete = result.complete;
    if (!result.ok || result.fault) {
      // Fault messages were already redacted at the adapter seam; the code
      // identifies the exact failure (CURSOR_LOOP, CONFLICTING_THREAD_RECORD,
      // APP_SERVER_LIST_SHAPE_INVALID, upstream RPC code, ...) and retryable/
      // needs_human stay false: none of these are caller-retryable without a
      // changed environment.
      return failed(result.fault?.code ?? "APP_SERVER_REQUEST_FAILED", "thread/list", result.fault?.message ?? "thread/list enumeration failed");
    }
    emitter.completed({
      pageCount: result.pages.length,
      uniqueCount: result.threads.length,
      complete: result.complete,
      durationMs: emitter.elapsedMs()
    });
    return okEnvelope(context, data);
  }

  private taskStatus(context: EnvelopeContext, input: ToolInput<"continuity_task_status">): ContinuityEnvelope {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    const events = this.options.coordinator.eventLog(input.task_id).read();
    const lastEvent = events[events.length - 1] ?? null;
    return okEnvelope(context, {
      task_id: ledger.taskId,
      project_id: ledger.projectId,
      state: ledger.lifecycleState,
      revision: ledger.revision,
      execution_substate: ledger.web.executionSubstate,
      terminal_reason: ledger.web.terminalReason,
      web_chat_id: ledger.web.chatId,
      cursor: ledger.web.cursor,
      counts: ledger.counts,
      checkpoint: ledger.checkpointRef,
      fault: ledger.fault,
      pending_gates: ledger.pendingGates,
      last_event: lastEvent ? { seq: lastEvent.seq, operation: lastEvent.operation, at: lastEvent.at, result: lastEvent.result } : null,
      next_action: nextActionFor(ledger)
    });
  }

  private checkpoint(context: EnvelopeContext, input: ToolInput<"continuity_checkpoint">): ContinuityEnvelope {
    const ledger = this.options.coordinator.checkpoint(input.task_id, input.checkpoint, input.expected_revision);
    this.withLedger(context, ledger);
    return okEnvelope(context, { checkpoint: ledger.checkpointRef, revision: ledger.revision });
  }

  /**
   * The relay entrypoint.  Every other relay tool begins with
   * `assertRegisteredTaskId`, and `TaskCoordinator.registerTask` had no
   * production caller at all — so the whole relay was unreachable: each tool
   * answered `RED_FLAGGED_INPUT: task X is not registered`.
   *
   * The initial ledger binds `sourceHashes["remaining_work"]` to the hash of
   * its non-terminal work set.  That is the single value `writeHandoff`
   * reconciles against later (`validateSourceSnapshot`), and the only write
   * site for it is ledger creation — so a task registered without it could
   * never reach HANDOFF_READY.
   */
  private taskRegister(context: EnvelopeContext, input: ToolInput<"continuity_task_register">, requestId: string): ContinuityEnvelope {
    const items = (input.remaining_work ?? []) as unknown as RemainingWorkItem[];
    const active = items.filter((item) => item.status !== "DONE");
    const ledger = this.options.coordinator.registerTask({
      ledger: {
        taskId: input.task_id,
        projectId: input.project_id,
        repositoryId: input.repository_id,
        ...(input.relay_epoch === undefined ? {} : { relayEpoch: input.relay_epoch }),
        threadId: input.thread_id ?? null,
        activeTurnId: input.active_turn_id ?? null,
        remainingWork: items,
        ...(input.scope_cutoff_at === undefined ? {} : { scopeCutoffAt: input.scope_cutoff_at }),
        // The handoff source hash is derived, never taken from the caller: a
        // caller-supplied hash could disagree with the work set it claims to
        // describe and would only fail much later, at drain time.
        sourceHashes: { remaining_work: workSetHash(active) }
      },
      // The app registers exactly one workspace at assembly time.
      workspaceId: "default",
      actor: "codex"
    });
    this.withLedger(context, ledger);
    return okEnvelope(context, {
      task_id: ledger.taskId,
      state: ledger.lifecycleState,
      revision: ledger.revision,
      counts: ledger.counts,
      relay_epoch: ledger.relayEpoch,
      source_hash: ledger.sourceHashes["remaining_work"] ?? null,
      request_id: requestId
    });
  }

  /**
   * CODEX_ACTIVE → DRAINING → HANDOFF_READY through the real drain workflow.
   *
   * The task is moved to DRAINING and persisted *before* the drain runs,
   * because `HandoffStore.writeHandoff` refuses to write outside DRAINING or
   * HANDOFF_READY.  Both the DRAINING write and the drain itself are
   * replay-safe: the handoff text is a pure function of the ledger constants
   * and the reconciled work set, so re-running a drain that was interrupted
   * between the interrupt receipts and the handoff write produces the same
   * bytes and the same hash.
   */
  private async drain(context: EnvelopeContext, input: ToolInput<"continuity_drain">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    if (!this.options.flags.CONTINUITY_AUTO_DRAIN_ENABLED) {
      return errorEnvelope(context, envelopeError("AUTO_DRAIN_DISABLED", "CONTINUITY_AUTO_DRAIN_ENABLED is false; the drain workflow stays off", { retryable: false }));
    }
    const adapter = this.options.codexAppServer;
    let ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    if (!adapter) {
      // Checked before any state change: an unavailable App Server must not
      // leave a task parked in DRAINING after interrupting nothing.
      return errorEnvelope(context, envelopeError("DRAIN_BACKEND_UNAVAILABLE", "continuity_drain requires the Codex App Server adapter (thread/list + turn/interrupt); none is configured", { retryable: true }), {
        state: ledger.lifecycleState,
        revision: ledger.revision
      });
    }
    if (ledger.lifecycleState !== "CODEX_ACTIVE" && ledger.lifecycleState !== "DRAINING") {
      throw new DomainError("INVALID_TRANSITION", `drain requires CODEX_ACTIVE or DRAINING, actual ${ledger.lifecycleState}`);
    }
    if (ledger.lifecycleState === "CODEX_ACTIVE") {
      const draining = transitionLedger(ledger, "DRAINING", { expectedRevision: input.expected_revision, at: this.nowIso() });
      ledger = this.options.coordinator.save(draining, "drain_started", "codex");
    } else if (input.expected_revision !== ledger.revision) {
      // A re-run against an already-DRAINING task still honours the caller's
      // revision guard.
      throw new DomainError("REVISION_CONFLICT", `expected_revision ${input.expected_revision} does not match DRAINING ledger revision ${ledger.revision}`);
    }
    const sourceSnapshot = this.completeSnapshotOrThrow(ledger);
    const options: DrainOptions = {
      ledger,
      adapter,
      handoffStore: this.options.store,
      sourceSnapshot,
      ...(input.registered_thread_ids === undefined ? {} : { registeredThreadIds: input.registered_thread_ids }),
      ...(input.project_mapping === undefined ? {} : { projectMapping: input.project_mapping })
    };
    const result: DrainResult = await drainAllVisibleActiveThreads(options);
    const proof = validateWave2DrainProof(result);
    if (!drainFencePassed(result) || !result.handoffSourceReconciliationProof) {
      // Stay in DRAINING: the drain is replayable and the faults are the
      // evidence a human or the next attempt needs.
      const faulted = setFault(ledger, {
        code: result.faults[0]?.code ?? "DRAIN_FENCE_FAILED",
        status: result.faults[0]?.status ?? "blocked",
        message: result.faults[0]?.message ?? "the drain fence did not pass; the task remains in DRAINING",
        at: this.nowIso(),
        operation: "continuity_drain",
        externalId: null
      }, { expectedRevision: ledger.revision });
      const saved = this.options.coordinator.save(faulted, "drain_fence_failed", "codex", undefined, { faults: result.faults.map((fault) => fault.code) });
      this.withLedger(context, saved);
      return errorEnvelope(context, envelopeError("DRAIN_FENCE_FAILED", "the complete visible-thread drain fence did not pass; no handoff was written", { retryable: true }), {
        state: saved.lifecycleState,
        revision: saved.revision,
        scope_known: result.scopeKnown,
        faults: result.faults,
        visible_threads: result.visibleThreads.map((thread) => thread.threadId),
        registered_not_visible: result.registeredNotVisibleThreadIds,
        unregistered_visible: result.unregisteredThreadIds,
        interrupt_receipts: result.interruptReceipts.length,
        proof_missing: proof.missing
      });
    }
    // The drain only produced the handoff; the ledger transition to
    // HANDOFF_READY is prepareHandoff's job, and it re-derives handoffHash from
    // the document it writes.
    const prepared = prepareHandoff(this.options.coordinator, this.options.store, input.task_id, result.handoffSourceReconciliationProof, ledger.revision, "codex");
    this.cacheHandoffManifest(input.task_id);
    this.withLedger(context, prepared.ledger);
    return okEnvelope(context, {
      task_id: prepared.ledger.taskId,
      state: prepared.ledger.lifecycleState,
      revision: prepared.ledger.revision,
      handoff_hash: prepared.ledger.handoffHash,
      handoff_ref: `.ai-handoff/${prepared.ledger.taskId}/handoff.md`,
      counts: prepared.ledger.counts,
      interrupted_threads: result.interruptReceipts.map((receipt) => receipt.threadId),
      drain_proof_hash: proof.proof?.proofHash ?? null,
      request_id: requestId
    });
  }

  /** Rebuild and cache the handoff manifest from the on-disk Markdown truth. */
  private cacheHandoffManifest(taskId: string): ManifestRecord {
    const { manifest, text } = buildHandoffManifest(this.options.store.readHandoff(taskId));
    const record: ManifestRecord = { manifest, text };
    this.manifests.set(taskId, record);
    return record;
  }

  /**
   * Resolve the handoff manifest for a task.  `handoff.md` is the Markdown
   * source of truth (README, "Experimental Plus lifecycle contract"), so the
   * manifest is rebuilt from it whenever it is not cached — a restart, or any
   * other process, must never see a sidecar in place of the document.
   */
  private manifestOrThrow(taskId: string): ManifestRecord {
    const cached = this.manifests.get(taskId);
    if (cached) return cached;
    if (!this.options.store.hasHandoff(taskId)) {
      throw new DomainError("HANDOFF_SOURCE_REQUIRED", "no handoff.md exists for this task");
    }
    return this.cacheHandoffManifest(taskId);
  }

  private prepareHandoffTool(context: EnvelopeContext, input: ToolInput<"continuity_prepare_handoff">, requestId: string): ContinuityEnvelope {
    const coordinator = this.options.coordinator;
    const ledger = coordinator.get(input.task_id);
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    if (ledger.lifecycleState !== "CODEX_ACTIVE" && ledger.lifecycleState !== "DRAINING") {
      throw new DomainError("INVALID_TRANSITION", `task is ${ledger.lifecycleState}; handoff preparation requires CODEX_ACTIVE or DRAINING`);
    }
    this.requireFreshQuota();
    const sourceSnapshot = this.completeSnapshotOrThrow(ledger);
    // `expected_revision` is the caller's optimistic-concurrency assertion.
    // Passing the freshly read `ledger.revision` would make that assertion
    // trivially true and turn the guard into dead code.
    const result = prepareHandoff(coordinator, this.options.store, input.task_id, sourceSnapshot, input.expected_revision, "codex");
    const readyLedger = result.ledger;
    const { manifest } = this.cacheHandoffManifest(input.task_id);
    this.withLedger(context, readyLedger);
    return okEnvelope(context, {
      task_id: readyLedger.taskId,
      state: readyLedger.lifecycleState,
      revision: readyLedger.revision,
      handoff_hash: readyLedger.handoffHash,
      handoff_ref: `.ai-handoff/${readyLedger.taskId}/handoff.md`,
      manifest_hash: manifest.manifest_hash,
      chunk_count: manifest.chunk_count,
      counts: manifest.counts,
      request_id: requestId
    });
  }

  /**
   * Build the trusted complete snapshot from the ledger, or reject preparation.
   * Wave 4 obtains the snapshot from the drain workflow; here the ledger's own
   * complete non-terminal set must already be hash-bound.
   */
  private completeSnapshotOrThrow(ledger: TaskLedger) {
    // `validateSourceSnapshot` reconciles this snapshot against the ledger's
    // non-DONE set *exactly*, so completed items must not be repeated here:
    // passing the raw `remainingWork` would inflate `counts.total` and fail
    // reconciliation for any ledger that already has finished work.
    const work = ledger.remainingWork.filter((item) => item.status !== "DONE").map((item) => clone(item));
    if (work.length === 0) {
      throw new DomainError("HANDOFF_SOURCE_REQUIRED", "ledger has no remaining work; nothing to hand off");
    }
    const sourceHashes = { ...ledger.sourceHashes };
    if (!sourceHashes["remaining_work"]) {
      throw new DomainError("HANDOFF_SOURCE_REQUIRED", "ledger source hashes are not bound; run the drain workflow first");
    }
    const counts = { total: work.length, remaining: work.length };
    const snapshotId = `snapshot_${ledger.taskId}_${ledger.revision}`;
    return {
      snapshotId,
      scopeCutoffAt: ledger.scopeCutoffAt,
      visibility: "COMPLETE" as const,
      sourceHashes: clone(sourceHashes),
      sourceHash: sourceHashes["remaining_work"],
      counts,
      remainingWork: work,
      reconciliationReceipt: {
        receiptId: `reconcile_${snapshotId}`,
        snapshotId,
        visibility: "COMPLETE" as const,
        sourceHash: sourceHashes["remaining_work"],
        counts,
        checkedAt: this.nowIso(),
        accepted: true as const
      }
    };
  }

  /**
   * Receipt-loss reconciliation (plan §9.3.5, `workflow/reconcile.ts`).
   *
   * A transport that threw may still have performed the effect: it is the
   * receipt that is missing, not necessarily the action.  The plan for that
   * branch halts every same-kind side effect and parks the task in
   * BLOCKED_WAITING instead of re-dispatching, so a message or a stop can never
   * be doubled by a blind retry.
   */
  private reconcileOnAmbiguousFailure(context: EnvelopeContext, ledger: TaskLedger, kind: ReceiptKind, error: unknown): ContinuityEnvelope {
    const plan = planReconciliation(kind, "in_flight");
    const message = error instanceof Error ? error.message : "the transport threw without returning a structured receipt";
    const code = error instanceof DomainError
      ? error.code
      : typeof (error as { code?: unknown } | null)?.code === "string"
        ? String((error as { code: string }).code)
        : "TRANSPORT_ERROR";
    const parked = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
      draft.web.executionSubstate = plan.substate;
      draft.fault = {
        code,
        status: "reconcile_required",
        message,
        at: this.nowIso(),
        operation: `continuity_web_session.${kind}`,
        externalId: null
      };
    });
    const saved = this.options.coordinator.save(parked, "receipt_loss_reconcile", "webgpt");
    this.withLedger(context, saved);
    return errorEnvelope(context, envelopeError("RECEIPT_LOSS_RECONCILE_REQUIRED", message, { retryable: false }), {
      receipt_kind: kind,
      branch: "in_flight",
      action: plan.action,
      block_same_kind: plan.blockSameKind,
      substate: saved.web.executionSubstate,
      note: "no retry is issued for this receipt kind until the dispatch outcome is proven"
    });
  }

  private async webSession(context: EnvelopeContext, input: ToolInput<"continuity_web_session">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const coordinator = this.options.coordinator;
    const ledger = coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    const webgpt = this.options.webgpt;
    if (input.action === "create") {
      const receipt = await webgpt.createOrAttach(input.task_id);
      if (!receipt.ok || !receipt.value) {
        return errorEnvelope(context, envelopeError(receipt.error?.code ?? "WEB_SESSION_FAILED", receipt.error?.message ?? "web session creation failed"));
      }
      const next = updateLedger(ledger, { expectedRevision: input.expected_revision ?? ledger.revision }, (draft) => {
        draft.web.chatId = receipt.value!.webChatId;
      });
      const saved = coordinator.save(next, "web_chat_created", "webgpt");
      this.withLedger(context, saved);
      return okEnvelope(context, { web_chat_id: saved.web.chatId, attach_receipt_id: receipt.value.attachReceiptId, page_state: receipt.value.pageState, evidence_level: receipt.evidenceLevel });
    }
    if (input.action === "send") {
      if (ledger.lifecycleState !== "HANDOFF_READY" && ledger.lifecycleState !== "WEB_UNATTENDED_EXECUTING") {
        throw new DomainError("INVALID_TRANSITION", `web send requires HANDOFF_READY or WEB_UNATTENDED_EXECUTING, actual ${ledger.lifecycleState}`);
      }
      if (!ledger.web.chatId) throw new DomainError("INVALID_TRANSITION", "no web chat is attached to this task");
      if (!input.payload.message) throw new DomainError("RED_FLAGGED_INPUT", "send requires a structured message payload");
      const key = input.idempotency_key ?? requestId;
      let result: Awaited<ReturnType<typeof webgpt.send>>;
      try {
        result = await webgpt.send(ledger.web.chatId, key, { message: input.payload.message, taskId: input.task_id });
      } catch (error) {
        // The dispatch may have reached the page before the transport died;
        // reconcile instead of retrying into a possible duplicate.
        return this.reconcileOnAmbiguousFailure(context, ledger, "web_message", error);
      }
      if (!result.ok || !result.value) {
        // ADR-0004 R-5: the persisted taskKey → web_chat_id mapping no longer
        // matches the live web chat (or cannot be verified).  Park the task in
        // BLOCKED_WAITING with a fault receipt; the chat is never re-targeted
        // from here — resuming requires an explicit re-attach flow.
        if (result.error?.code === "WEB_CHAT_ID_MISMATCH" || result.error?.code === "WEB_CHAT_ID_UNVERIFIED") {
          const parked = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
            draft.web.executionSubstate = "BLOCKED_WAITING";
            draft.fault = {
              code: result.error!.code,
              status: "blocked",
              message: result.error!.message,
              at: this.nowIso(),
              operation: result.error!.operation,
              externalId: null
            };
          });
          coordinator.save(parked, "web_chat_id_mismatch", "webgpt");
        }
        return errorEnvelope(context, envelopeError(result.error?.code ?? "WEB_SEND_FAILED", result.error?.message ?? "web send failed"));
      }
      const receipt = result.value;
      if (receipt.quota === "account_limit") {
        // ADR-0004 R-9: an account-level quota receipt is the only web-side
        // signal that may even propose WEB_QUOTA_EXHAUSTED, and the App never
        // declares that terminal itself.  Record the observation as a fault
        // and park in BLOCKED_WAITING; a human confirmation gate owns the
        // terminal decision.
        const parked = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
          draft.web.executionSubstate = "BLOCKED_WAITING";
          draft.fault = {
            code: "WEB_QUOTA_ACCOUNT_LIMIT",
            status: "blocked",
            message: "account-level web quota receipt observed; WEB_QUOTA_EXHAUSTED requires explicit user confirmation (ADR-0004 R-9)",
            at: this.nowIso(),
            operation: "continuity_web_session.send",
            externalId: receipt.sendReceiptId
          };
        });
        coordinator.save(parked, "web_quota_account_limit", "webgpt");
        return okEnvelope(context, {
          message_receipt: receipt,
          execution_substate: "BLOCKED_WAITING",
          quota_observation: "account_limit",
          terminal: false,
          note: "account-level quota receipt parks the task in BLOCKED_WAITING; WEB_QUOTA_EXHAUSTED is never self-declared (ADR-0004 R-9)"
        });
      }
      if (receipt.blockedWaiting) {
        const blocked = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
          draft.web.executionSubstate = "BLOCKED_WAITING";
        });
        coordinator.save(blocked, "web_blocked_waiting", "webgpt");
      }
      return okEnvelope(context, {
        message_receipt: receipt,
        execution_substate: receipt.blockedWaiting ? "BLOCKED_WAITING" : ledger.web.executionSubstate,
        terminal: false
      });
    }
    if (input.action === "attach") {
      // attach = the handoff bootstrap message was delivered and the web
      // acknowledged it; only then may the ledger enter unattended execution.
      if (ledger.lifecycleState !== "HANDOFF_READY") {
        throw new DomainError("INVALID_TRANSITION", `attach requires HANDOFF_READY, actual ${ledger.lifecycleState}`);
      }
      if (!ledger.web.chatId || !ledger.handoffHash) {
        throw new DomainError("INVALID_TRANSITION", "attach requires an attached chat and a written handoff");
      }
      const record = this.manifestOrThrow(input.task_id);
      const key = input.idempotency_key ?? `bootstrap_${input.task_id}_${ledger.revision}`;
      const send = await webgpt.send(
        ledger.web.chatId,
        key,
        { bootstrap: true, taskId: input.task_id, relayEpoch: ledger.relayEpoch, manifestHash: record.manifest.manifest_hash }
      );
      if (!send.ok || !send.value) {
        return errorEnvelope(context, envelopeError(send.error?.code ?? "WEB_SEND_FAILED", send.error?.message ?? "handoff bootstrap send failed"));
      }
      const read = await webgpt.read(ledger.web.chatId, ledger.web.cursor);
      if (!read.ok || !read.value) {
        return errorEnvelope(context, envelopeError(read.error?.code ?? "WEB_READ_FAILED", read.error?.message ?? "handoff bootstrap read failed"));
      }
      const acknowledged = read.value.pageState === "loaded" && read.value.observedMessageIds.includes(send.value.upstreamMessageId ?? "");
      if (!acknowledged) {
        const waiting = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
          draft.web.executionSubstate = "BLOCKED_WAITING";
        });
        coordinator.save(waiting, "web_attach_waiting", "webgpt");
        return errorEnvelope(context, envelopeError("WEB_ACK_MISSING", "the web has not acknowledged the handoff bootstrap yet; staying in HANDOFF_READY", { retryable: true }));
      }
      const next = transitionLedger(ledger, "WEB_UNATTENDED_EXECUTING", {
        expectedRevision: ledger.revision,
        webAck: true,
        at: this.nowIso()
      });
      const saved = coordinator.save(next, "web_unattended_entered", "webgpt");
      this.withLedger(context, saved);
      return okEnvelope(context, {
        state: saved.lifecycleState,
        web_chat_id: saved.web.chatId,
        bootstrap_message_id: send.value.upstreamMessageId,
        cursor: read.value.cursor
      });
    }
    if (input.action === "read") {
      if (!ledger.web.chatId) throw new DomainError("INVALID_TRANSITION", "no web chat is attached to this task");
      const read = await webgpt.read(ledger.web.chatId, input.payload.cursor ?? ledger.web.cursor);
      if (!read.ok || !read.value) {
        return errorEnvelope(context, envelopeError(read.error?.code ?? "WEB_READ_FAILED", read.error?.message ?? "web read failed"));
      }
      return okEnvelope(context, {
        read_receipt: read.value,
        terminal: false,
        note: "ordinary page/transport failures are never terminal"
      });
    }
    // stop
    if (!ledger.web.chatId) throw new DomainError("INVALID_TRANSITION", "no web chat is attached to this task");
    let stopped: Awaited<ReturnType<typeof webgpt.stop>>;
    try {
      stopped = await webgpt.stop(ledger.web.chatId);
    } catch (error) {
      return this.reconcileOnAmbiguousFailure(context, ledger, "web_stop", error);
    }
    if (!stopped.ok || !stopped.value) {
      return errorEnvelope(context, envelopeError(stopped.error?.code ?? "WEB_STOP_FAILED", stopped.error?.message ?? "web stop failed"));
    }
    return okEnvelope(context, { stop_receipt: stopped.value, terminal: false, note: "stop records a receipt only; terminal requires a closed reason" });
  }

  private async workerRun(context: EnvelopeContext, input: ToolInput<"continuity_worker_run">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    if (!this.options.flags.CONTINUITY_CLAUDE_ENABLED && !this.options.flags.CONTINUITY_DSH_ENABLED && !this.options.flags.CONTINUITY_ENGINEERING_BRIDGE_ENABLED) {
      return errorEnvelope(context, envelopeError("WORKER_BACKEND_DISABLED", "no worker backend flag is enabled"));
    }
    // Map the web-facing worker kind onto the explicit executor routing rules
    // (routing/executor-policy).  There is no way to name luna here.
    const quotaDepleted = ledger.quotaGate.status === "depleted";
    if (input.worker_kind === "claude") {
      validateExecutorRequest({ executor: "claude", continuation: "claude_resume", source: "claude_orchestrator", quotaDepleted });
    } else if (input.worker_kind === "dsh") {
      validateExecutorRequest({ executor: "dsh", continuation: "dsh_fresh", source: "claude_orchestrator", quotaDepleted });
    } else {
      validateExecutorRequest({ executor: "dsh", continuation: "dsh_fresh", source: "engineering-bridge", quotaDepleted });
    }
    const backend = this.options.workerBackend;
    if (!backend) {
      return errorEnvelope(context, envelopeError("WORKER_BACKEND_UNAVAILABLE", "no worker backend adapter is wired into this app", { retryable: true }));
    }
    const result = await backend.run({
      taskId: input.task_id,
      workerKind: input.worker_kind,
      instructionRef: input.instruction_ref,
      idempotencyKey: input.idempotency_key
    });
    // Register the supervised attempt so `continuity_worker_control` can act on
    // it later — in this process or in the next one.  The durable worker ledger
    // is the richer source when the backend wrote one.
    // The allowlist gate is the prerequisite: without this registration the
    // control tool could never pass `assertRegisteredAttemptId`.
    this.options.allowlist.registerAttemptId(result.attemptId);
    const durable = this.workerAttemptRecord(result.attemptId);
    const status: WorkerStatus = durable ? workerStatusOf(durable.receipt.status) : result.status;
    const previous = this.attemptOrNull(result.attemptId);
    const record: RelayAttemptRecord = {
      attemptId: result.attemptId,
      taskId: input.task_id,
      workerKind: input.worker_kind,
      source: workerSourceOf(input.worker_kind),
      continuation: input.worker_kind === "claude" ? "claude_resume" : "dsh_fresh",
      status,
      revision: (previous?.revision ?? 0) + 1,
      terminal: status === "completed" || status === "failed"
    };
    this.saveAttempt(record);
    return okEnvelope(context, {
      attempt_id: result.attemptId,
      real_job_id: result.realJobId,
      status: result.status,
      evidence_refs: result.evidenceRefs,
      attempt_revision: record.revision,
      request_id: requestId
    });
  }

  /**
   * continue / steer / interrupt / accept for a supervised worker attempt.
   *
   * Ordering is deliberate.  The supervision controller validates the action
   * (closed allowlist, revision, structured instruction, state guard) and only
   * then mutates its own state; the real upstream action happens after that,
   * and an unconfirmed upstream result is rolled back through `unwindControl`.
   * A tool call therefore never reports success for an action that did not
   * reach a worker.
   */
  private async workerControl(context: EnvelopeContext, input: ToolInput<"continuity_worker_control">): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredAttemptId(input.attempt_id);
    const backend = this.options.workerControl;
    const supervision = this.options.supervision;
    if (!backend || !supervision) {
      // No backend control seam is wired here. In particular an interrupt must
      // never acknowledge success while the underlying process is still running.
      return errorEnvelope(context, envelopeError("WORKER_CONTROL_BACKEND_UNAVAILABLE",
        "Worker control is not connected to an execution backend; no action was performed", { retryable: false }), {
        attempt_id: input.attempt_id,
        action: input.action
      });
    }
    const attempt = this.attemptOrNull(input.attempt_id);
    if (!attempt) {
      return errorEnvelope(context, envelopeError("WORKER_ATTEMPT_UNKNOWN",
        "No supervised attempt is registered for this id; run continuity_worker_run first", { retryable: false }), {
        attempt_id: input.attempt_id,
        action: input.action
      });
    }
    const ledger = this.options.coordinator.get(attempt.taskId);
    this.withLedger(context, ledger);
    const workerKind = attempt.workerKind as "claude" | "dsh" | "bridge-dsh";
    if (!backend.supportedKinds.includes(workerKind)) {
      return errorEnvelope(context, envelopeError("WORKER_CONTROL_UNSUPPORTED",
        `The wired control backend cannot control a ${workerKind} worker upstream; no action was performed`, { retryable: false }), {
        attempt_id: input.attempt_id,
        action: input.action,
        worker_kind: workerKind,
        supported_kinds: [...backend.supportedKinds]
      });
    }
    // Recovery: a fresh process has an empty controller but a durable attempt.
    if (!supervision.getAttempt(input.attempt_id)) {
      supervision.restoreAttempt({
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        kind: workerKind,
        source: attempt.source === "engineering-bridge" ? "engineering-bridge" : "claude_orchestrator",
        continuation: attempt.continuation === "claude_resume" ? "claude_resume" : "dsh_fresh",
        status: workerStatusOf(attempt.status),
        revision: attempt.revision,
        terminal: attempt.terminal
      });
    }
    const request: WorkerControlRequest = {
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      action: input.action,
      expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key,
      // The MCP boundary names *where* the instruction lives
      // (evidence_ref | checkpoint_ref | handoff_item) and supervision requires
      // the `instruction_ref` form.  The ref is passed through verbatim and the
      // origin kind is preserved in `source`; nothing is retyped.
      ...(input.instruction_ref === undefined
        ? {}
        : { instruction: { kind: "instruction_ref", ref: input.instruction_ref.ref, source: input.instruction_ref.kind } }),
      // A real upstream backend is never stamped as mock-validated.
      evidenceLevel: "UNKNOWN"
    };
    const receipt = supervision.control(request);
    if (!receipt.accepted) {
      return errorEnvelope(context, envelopeError(receipt.error?.code ?? "WORKER_CONTROL_REJECTED",
        receipt.error?.message ?? "the supervision controller rejected this control action", { retryable: receipt.error?.status !== "blocked" }), {
        attempt_id: input.attempt_id,
        action: input.action,
        control_receipt: receipt
      });
    }
    const outcome = await backend.control({
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      workerKind,
      action: input.action,
      workspaceId: this.options.coordinator.workspaceIdOf(attempt.taskId),
      instructionRef: receipt.instructionRef ? { kind: receipt.instructionRef.kind, ref: receipt.instructionRef.ref } : null,
      idempotencyKey: input.idempotency_key
    });
    if (!outcome.confirmed) {
      supervision.unwindControl({
        attemptId: attempt.attemptId,
        idempotencyKey: input.idempotency_key,
        status: workerStatusOf(attempt.status),
        revision: attempt.revision,
        terminal: attempt.terminal
      });
      return errorEnvelope(context, envelopeError(outcome.code ?? "WORKER_CONTROL_NOT_CONFIRMED",
        outcome.message ?? "the upstream backend did not confirm this control action; the supervised state was rolled back", { retryable: true }), {
        attempt_id: input.attempt_id,
        action: input.action,
        worker_kind: workerKind,
        backend_receipt: outcome.receipt,
        rolled_back: true
      });
    }
    const saved: RelayAttemptRecord = {
      ...attempt,
      status: receipt.status,
      revision: receipt.revision,
      terminal: receipt.status === "completed" || receipt.status === "failed"
    };
    this.saveAttempt(saved);
    // Audit artifact for "who stopped this worker".  The upstream action has
    // already happened, so an evidence-write failure is reported beside the
    // success rather than turned into a false failure of the control itself.
    let evidenceError: string | null = null;
    try {
      this.options.evidence.write(attempt.taskId, `worker_control_${receipt.requestId}`, {
        attempt_id: attempt.attemptId,
        task_id: attempt.taskId,
        action: input.action,
        previous_status: receipt.previousStatus,
        status: saved.status,
        worker_kind: workerKind,
        backend_receipt: outcome.receipt,
        at: this.nowIso()
      });
    } catch (error) {
      evidenceError = error instanceof Error ? error.message : "evidence write failed";
    }
    return okEnvelope(context, {
      attempt_id: attempt.attemptId,
      task_id: attempt.taskId,
      action: input.action,
      worker_kind: workerKind,
      previous_status: receipt.previousStatus,
      status: saved.status,
      attempt_revision: saved.revision,
      terminal: saved.terminal,
      backend_receipt: outcome.receipt,
      control_receipt: receipt,
      evidence_error: evidenceError,
      request_id: input.idempotency_key
    });
  }

  private async patchPropose(context: EnvelopeContext, input: ToolInput<"continuity_patch_propose">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const backend = this.options.patchBackend;
    if (!backend) {
      return errorEnvelope(context, envelopeError("PATCH_BACKEND_UNAVAILABLE", "no patch backend adapter is wired into this app", { retryable: true }));
    }
    const proposed = await backend.propose({
      changeRequest: input.change_request as unknown as Record<string, unknown>,
      executor: input.executor,
      idempotencyKey: input.idempotency_key
    });
    const patchTaskId = `patch_${Math.abs(hashString(input.idempotency_key + input.task_id)).toString(16).padStart(12, "0")}`;
    this.options.allowlist.registerPatchTaskId(patchTaskId);
    const proposedRevision = this.options.coordinator.get(input.task_id).revision;
    this.savePatch({
      patchTaskId,
      taskId: input.task_id,
      executor: input.executor,
      baseHead: proposed.baseHead,
      changeRequest: input.change_request as unknown as Record<string, unknown>,
      proposedRevision,
      diff: proposed.diff,
      verdict: null,
      applied: false,
      committed: false
    });
    context.taskId = input.task_id;
    return okEnvelope(context, { patch_task_id: patchTaskId, diff: proposed.diff, base_head: proposed.baseHead, executor: input.executor, expected_revision: proposedRevision, request_id: requestId });
  }

  private async patchValidate(context: EnvelopeContext, input: ToolInput<"continuity_patch_validate">): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredPatchTaskId(input.patch_task_id);
    const record = this.patchOrThrow(input.patch_task_id);
    const backend = this.options.patchBackend;
    if (!backend || record.diff === null) {
      return errorEnvelope(context, envelopeError("PATCH_NOT_PROPOSED", "patch has no proposal to validate"));
    }
    const verdict = await backend.validate({ patchTaskId: record.patchTaskId, diff: record.diff });
    record.verdict = verdict.verdict;
    this.savePatch(record);
    return okEnvelope(context, { patch_task_id: record.patchTaskId, verdict: verdict.verdict, reasons: verdict.reasons, note: "INCOMPLETE is never PASS; validation is not write authorization" });
  }

  /**
   * Patch records are bound to the ledger revision they were proposed against
   * (plan §8.3.6): the caller must echo that revision, and the parent task
   * must not have advanced since propose. Checked before any gate is consumed.
   */
  private assertPatchRevisionBound(record: PatchRecord, expectedRevision: number): void {
    if (expectedRevision !== record.proposedRevision) {
      throw new DomainError("REVISION_CONFLICT", `expected_revision ${expectedRevision} does not match the revision this patch was proposed against (${record.proposedRevision})`);
    }
    const live = this.options.coordinator.get(record.taskId).revision;
    if (live !== record.proposedRevision) {
      throw new DomainError("REVISION_CONFLICT", `task ${record.taskId} advanced from revision ${record.proposedRevision} to ${live} since propose; re-propose the patch against current state`);
    }
  }

  private async patchApply(context: EnvelopeContext, input: ToolInput<"continuity_patch_apply">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredPatchTaskId(input.patch_task_id);
    assertExactConfirmation("APPLY", input.confirmation);
    const record = this.patchOrThrow(input.patch_task_id);
    const backend = this.options.patchBackend;
    if (!backend || record.diff === null) {
      return errorEnvelope(context, envelopeError("PATCH_NOT_PROPOSED", "patch has no proposal to apply"));
    }
    if (record.verdict !== "PASS") {
      return errorEnvelope(context, envelopeError("PATCH_NOT_VALIDATED", `patch verdict is ${record.verdict ?? "unvalidated"}; only PASS may be applied`));
    }
    if (record.applied) {
      return errorEnvelope(context, envelopeError("PATCH_ALREADY_APPLIED", "patch was already applied"));
    }
    this.assertPatchRevisionBound(record, input.expected_revision);
    // The exact literal opened and consumed the gate atomically.
    const gate = this.options.confirmations.open("APPLY", record.patchTaskId, input.idempotency_key, "web");
    this.options.confirmations.require("APPLY", record.patchTaskId);
    const applied = await backend.apply({ patchTaskId: record.patchTaskId, diff: record.diff });
    record.applied = true;
    this.savePatch(record);
    return okEnvelope(context, {
      patch_task_id: record.patchTaskId,
      apply_receipt_id: applied.applyReceiptId,
      changed_files: applied.changedFiles,
      gate_id: gate.gateId,
      request_id: requestId
    });
  }

  private async patchCommit(context: EnvelopeContext, input: ToolInput<"continuity_patch_commit">, requestId: string): Promise<ContinuityEnvelope> {
    this.options.allowlist.assertRegisteredPatchTaskId(input.patch_task_id);
    assertExactConfirmation("COMMIT", input.confirmation);
    const record = this.patchOrThrow(input.patch_task_id);
    const backend = this.options.patchBackend;
    if (!backend) {
      return errorEnvelope(context, envelopeError("PATCH_BACKEND_UNAVAILABLE", "no patch backend adapter is wired into this app", { retryable: true }));
    }
    if (!record.applied) {
      return errorEnvelope(context, envelopeError("PATCH_NOT_APPLIED", "patch must be applied before commit"));
    }
    if (record.committed) {
      return errorEnvelope(context, envelopeError("PATCH_ALREADY_COMMITTED", "patch was already committed"));
    }
    this.assertPatchRevisionBound(record, input.expected_revision);
    const gate = this.options.confirmations.open("COMMIT", record.patchTaskId, input.idempotency_key, "web");
    this.options.confirmations.require("COMMIT", record.patchTaskId);
    const committed = await backend.commit({ patchTaskId: record.patchTaskId, message: input.message });
    record.committed = true;
    this.savePatch(record);
    return okEnvelope(context, {
      patch_task_id: record.patchTaskId,
      commit_hash: committed.commitHash,
      commit_receipt_id: committed.commitReceiptId,
      gate_id: gate.gateId,
      push_deploy: "rejected_by_design",
      request_id: requestId
    });
  }

  private prepareReturn(context: EnvelopeContext, input: ToolInput<"continuity_prepare_return">, requestId: string): ContinuityEnvelope {
    const coordinator = this.options.coordinator;
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    let ledger = coordinator.get(input.task_id);
    if (ledger.lifecycleState === "WEB_UNATTENDED_EXECUTING") {
      // Entering terminal here is only legal for ALL_TASKS_COMPLETED with a
      // full completion receipt; quota and stop terminals require their own
      // receipts supplied by the runtime that observed them.
      const completion = allTasksCompleted(ledger);
      if (!completion.ok) {
        return errorEnvelope(context, envelopeError("TERMINAL_GUARD_FAILED", `web execution is still active and the completion guard failed: ${completion.reasons.join("; ")}`, { retryable: false }));
      }
      const receipt: CompletionReceipt = {
        kind: "all_tasks_completed",
        receiptId: `complete_${ledger.taskId}_${ledger.revision}`,
        relayEpoch: ledger.relayEpoch,
        timestamp: this.nowIso(),
        intent: "ALL_TASKS_COMPLETED",
        reason: "ALL_TASKS_COMPLETED",
        accepted: true
      };
      const terminal = enterWebTerminal(ledger, "ALL_TASKS_COMPLETED", { expectedRevision: ledger.revision, completionReceipt: receipt });
      ledger = coordinator.save(terminal, "web_terminal_entered", "web", undefined, { terminal_reason: "ALL_TASKS_COMPLETED" });
    }
    if (ledger.lifecycleState !== "WEB_TERMINAL") {
      throw new DomainError("INVALID_TRANSITION", `return preparation requires WEB_TERMINAL, actual ${ledger.lifecycleState}`);
    }
    const reason = ledger.web.terminalReason as TerminalReason;
    if (!reason) throw new DomainError("INVALID_TRANSITION", "terminal ledger has no terminal reason");
    const { decision, ledgerGate } = this.requireFreshQuota();
    // The gate is the pure decision function (workflow/return.ts), not an inline
    // restatement of it: it also rejects a ledger with no return checkpoint, an
    // already-written return, an internally inconsistent count and a web side
    // still parked in BLOCKED_WAITING — none of which the inline check saw.
    const quotaSnapshot: ReturnQuotaSnapshot = {
      returnReady: decision.returnReady,
      primaryRemainingBps: decision.primaryRemainingBps,
      secondaryGuard: decision.secondaryGuard,
      sampleFresh: decision.sampleFresh
    };
    const readiness = assessReturnReadiness(ledger, quotaSnapshot);
    if (!readiness.ready) {
      return errorEnvelope(context, envelopeError("RETURN_GATE_NOT_READY", `the return gate is not satisfied: ${readiness.blockers.join("; ")}`, { retryable: true }), {
        quota: ledgerGate,
        terminal_reason: reason,
        blockers: readiness.blockers
      });
    }
    const written = this.options.store.writeReturn(ledger, reason);
    const withReturn = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
      draft.returnHash = written.hash;
      draft.quotaGate = ledgerGate;
    });
    const saved = coordinator.save(withReturn, "return_written", "web");
    const ready = transitionLedger(saved, "RETURN_READY", {
      expectedRevision: saved.revision,
      returnReady: true,
      codexQuotaReady: decision.returnReady,
      // Derived from the ledger, never asserted: `assessReturnReadiness`
      // already required a checkpoint reference to pass.
      returnCheckpointComplete: Boolean(saved.checkpointRef),
      originalThreadConfirmed: typeof saved.codex.threadId === "string" && saved.codex.threadId.length > 0
    });
    const persisted = coordinator.save(ready, "return_ready", "web");
    this.withLedger(context, persisted);
    return okEnvelope(context, {
      task_id: persisted.taskId,
      state: persisted.lifecycleState,
      revision: persisted.revision,
      terminal_reason: reason,
      return_ref: `.ai-handoff/${persisted.taskId}/return.md`,
      remaining_counts: persisted.counts,
      quota: ledgerGate,
      request_id: requestId
    });
  }

  private async resumeCodex(context: EnvelopeContext, input: ToolInput<"continuity_resume_codex">): Promise<ContinuityEnvelope> {
    const coordinator = this.options.coordinator;
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    if (ledger.lifecycleState !== "RETURN_READY") {
      throw new DomainError("INVALID_TRANSITION", `resume requires RETURN_READY, actual ${ledger.lifecycleState}`);
    }
    if (!ledger.codex.threadId) {
      throw new DomainError("RED_FLAGGED_INPUT", "original Codex thread id is unknown; refusing to fabricate a resume");
    }
    const adapter = this.options.codexAppServer;
    if (!adapter) {
      return errorEnvelope(context, envelopeError("RESUME_BACKEND_UNAVAILABLE", "thread/resume requires the Codex App Server adapter and a real receipt; no substitute thread may be created", { retryable: true }), {
        original_thread_id: ledger.codex.threadId
      });
    }
    if (!this.options.flags.CONTINUITY_RETURN_TO_CODEX_ENABLED) {
      return errorEnvelope(context, envelopeError("RETURN_TO_CODEX_DISABLED", "CONTINUITY_RETURN_TO_CODEX_ENABLED is false; the original Codex thread is left untouched", { retryable: false }), {
        original_thread_id: ledger.codex.threadId,
        state: ledger.lifecycleState
      });
    }
    if (!ledger.checkpointRef) {
      return errorEnvelope(context, envelopeError("CHECKPOINT_REQUIRED", "thread/resume requires the persisted return checkpoint reference", { retryable: false }), {
        original_thread_id: ledger.codex.threadId
      });
    }
    const receipt = await adapter.resumeThread(ledger.codex.threadId, ledger.checkpointRef, input.idempotency_key);
    if (!receipt.confirmed) {
      // The adapter validated thread identity, checkpoint identity and the
      // explicit receipt + turn id; a failure stays on RETURN_READY so the
      // resume can be retried with the same idempotency key.
      return errorEnvelope(context, envelopeError(receipt.fault?.code ?? "RESUME_NOT_CONFIRMED",
        receipt.fault?.message ?? "thread/resume did not return a confirmed receipt; the task stays in RETURN_READY", { retryable: true }), {
        original_thread_id: ledger.codex.threadId,
        status: receipt.status,
        resume_receipt: receipt
      });
    }
    const resumed = updateLedger(ledger, { expectedRevision: ledger.revision }, (draft) => {
      draft.codex.activeTurnId = receipt.newTurnId;
    });
    const saved = coordinator.save(resumed, "codex_resume_receipt", "codex");
    const next = transitionLedger(saved, "CODEX_RESUMED", {
      expectedRevision: saved.revision,
      at: this.nowIso(),
      // Bound to the adapter's own confirmation, never assumed.
      resumeConfirmed: receipt.confirmed === true
    });
    const persisted = coordinator.save(next, "codex_resumed", "codex");
    this.withLedger(context, persisted);
    return okEnvelope(context, {
      task_id: persisted.taskId,
      state: persisted.lifecycleState,
      revision: persisted.revision,
      original_thread_id: receipt.originalThreadId,
      resumed_thread_id: receipt.resumedThreadId,
      new_turn_id: receipt.newTurnId,
      resume_receipt_id: receipt.receiptId,
      request_id: input.idempotency_key
    });
  }

  private handoffManifestRead(context: EnvelopeContext, input: ToolInput<"continuity_handoff_manifest_read">): ContinuityEnvelope {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    // Rebuilt from handoff.md when it is not cached: the Markdown document is
    // the source of truth, so a restarted process serves the same manifest as
    // the one that accepted it.
    const record = this.manifestOrThrow(input.task_id);
    return okEnvelope(context, { manifest: record.manifest });
  }

  private handoffChunkRead(context: EnvelopeContext, input: ToolInput<"continuity_handoff_chunk_read">): ContinuityEnvelope {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    const record = this.manifestOrThrow(input.task_id);
    const chunk = readHandoffChunk(record.manifest, record.text, input.chunk_index, input.chunk_hash);
    return okEnvelope(context, { chunk });
  }

  private handoffAccept(context: EnvelopeContext, input: ToolInput<"continuity_handoff_accept">, requestId: string): ContinuityEnvelope {
    this.options.allowlist.assertRegisteredTaskId(input.task_id);
    const ledger = this.options.coordinator.get(input.task_id);
    this.withLedger(context, ledger);
    const record = this.manifestOrThrow(input.task_id);
    const receipt = acceptHandoff(
      this.options.coordinator,
      this.options.evidence,
      record.manifest,
      record.text,
      input.manifest_hash,
      // The caller must have verified every chunk; receipts arrive via the
      // manifest itself and are re-verified locally before acceptance.
      record.manifest.chunks.map((chunk) => ({ index: chunk.index, sha256: chunk.sha256 })),
      input.client_ref,
      "web"
    );
    return okEnvelope(context, { accept_receipt: receipt, request_id: requestId });
  }

  private patchOrThrow(patchTaskId: string): PatchRecord {
    const record = this.patches.get(patchTaskId);
    if (!record) throw new DomainError("RED_FLAGGED_INPUT", `patch task ${patchTaskId} is not registered`);
    return record;
  }
}

function nextActionFor(ledger: TaskLedger): string {
  switch (ledger.lifecycleState) {
    case "CODEX_ACTIVE":
      return "quota_watch_or_drain";
    case "DRAINING":
      return "complete_drain_and_handoff";
    case "HANDOFF_READY":
      return "attach_web_and_deliver_handoff";
    case "WEB_UNATTENDED_EXECUTING":
      return ledger.web.executionSubstate === "BLOCKED_WAITING" ? "recover_or_wait" : "keep_executing";
    case "WEB_TERMINAL":
      return "prepare_return_after_quota_hysteresis";
    case "RETURN_READY":
      return "resume_original_codex_thread";
    case "CODEX_RESUMED":
      return "none";
    default:
      return "unknown";
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Payload identity for idempotent replay decisions (design §6.4.2/3). */
function payloadFingerprint(input: unknown): string {
  return sha256(input);
}

/**
 * Map the backend's operation status onto the supervision state machine's
 * status vocabulary.  `blocked` and `unknown` are *not* translated into
 * "running" or "failed": the control guards act on this value, and a wrong
 * guess would authorize an interrupt the worker cannot honour.
 */
function workerStatusOf(status: string): WorkerStatus {
  switch (status) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
      return status;
    case "review":
    case "needs_attention":
      return "review";
    default:
      return "unknown";
  }
}

function workerSourceOf(workerKind: "claude" | "dsh" | "bridge-dsh"): "claude_orchestrator" | "engineering-bridge" {
  return workerKind === "bridge-dsh" ? "engineering-bridge" : "claude_orchestrator";
}
