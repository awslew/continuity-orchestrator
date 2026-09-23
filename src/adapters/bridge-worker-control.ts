/**
 * Real worker-control seam over the engineering-bridge `control_task` tool.
 *
 * This is the only path that may steer or interrupt a running Bridge worker.
 * It reports `confirmed` strictly: the upstream call has to come back `ok` with
 * no structured error, otherwise the caller (the supervision controller) rolls
 * the accepted action back. A control that could not be proven is never
 * reported as "the worker stopped".
 *
 * Instruction discipline: the MCP boundary accepts only a structured
 * instruction *reference* (`evidence_ref` / `checkpoint_ref` / `handoff_item`,
 * never free-form web text).  That reference is forwarded to the Bridge as-is,
 * so a worker receives a pointer to the instruction artifact instead of
 * arbitrary prose injected from the web page.
 */

import type { EngineeringBridgeAdapter } from "./engineering-bridge.js";
import type { WorkerControlAction } from "../workflow/supervision.js";

export interface BridgeWorkerControlInput {
  taskId: string;
  attemptId: string;
  workerKind: "claude" | "dsh" | "bridge-dsh";
  action: WorkerControlAction;
  workspaceId: string;
  instructionRef: { kind: string; ref: string } | null;
  idempotencyKey: string;
}

export interface BridgeWorkerControlOutcome {
  confirmed: boolean;
  receipt: unknown;
  status: string | null;
  code: string | null;
  message: string | null;
}

export class BridgeWorkerControlBackend {
  /** Only Bridge-routed workers have a `control_task` upstream. */
  readonly supportedKinds = ["bridge-dsh"] as const;

  constructor(
    private readonly bridge: EngineeringBridgeAdapter,
    private readonly executor = "dsh"
  ) {}

  async control(input: BridgeWorkerControlInput): Promise<BridgeWorkerControlOutcome> {
    const receipt = await this.bridge.controlTask({
      workspace_id: input.workspaceId,
      task_id: input.taskId,
      action: input.action,
      executor: this.executor,
      attempt_id: input.attemptId,
      ...(input.instructionRef === null ? {} : { instruction: input.instructionRef.ref }),
      idempotency_key: input.idempotencyKey
    });
    const confirmed = receipt.ok === true && receipt.error === null;
    return {
      confirmed,
      receipt,
      status: receipt.status ?? null,
      code: confirmed ? null : receipt.error?.code ?? "BRIDGE_CONTROL_FAILED",
      message: confirmed ? null : receipt.error?.message ?? "the Bridge did not confirm this control action"
    };
  }
}
