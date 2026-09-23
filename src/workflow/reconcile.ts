/**
 * Receipt-loss reconciliation — plan §9.3.5 (owner-w5).
 *
 * Every receipt kind is classified into one of three branches (the same
 * three the restart drill rehearses):
 *   completed — a receipt exists; reuse it, no side effects;
 *   in_flight — a dispatch may have happened but no receipt is known:
 *               halt, park BLOCKED_WAITING, and stop all same-kind side
 *               effects (no new message, no new worker, no resume);
 *   missing   — provably never dispatched: a retry with the SAME idempotency
 *               key is safe (a completed twin anywhere replays it); kinds
 *               that cannot key their effects are treated as in_flight.
 *
 * Reconciliation never blindly creates workers, messages or resumes, and it
 * never enters a terminal state.
 */

export type ReceiptKind = "web_message" | "web_read" | "web_stop" | "worker" | "bridge" | "app_server";
export type ReceiptBranch = "completed" | "in_flight" | "missing";

export interface ReconcilePlan {
  action: "reuse_receipt" | "halt_and_reconcile" | "retry_with_same_key";
  /** Same-kind side effects must stop until a receipt/absence is proven. */
  blockSameKind: boolean;
  /** Ledger execution substate the caller should park in (when applicable). */
  substate: "EXECUTING" | "BLOCKED_WAITING";
}

const KEYED_KINDS: readonly ReceiptKind[] = ["web_message", "web_stop", "worker", "bridge", "app_server"];

export function planReconciliation(kind: ReceiptKind, branch: ReceiptBranch): ReconcilePlan {
  if (branch === "completed") {
    return { action: "reuse_receipt", blockSameKind: false, substate: "EXECUTING" };
  }
  if (branch === "in_flight") {
    // Unknown outcome: the effect may exist somewhere.  Stop, park, and let
    // an operator/reconcile pass prove what happened — never re-dispatch.
    return { action: "halt_and_reconcile", blockSameKind: true, substate: "BLOCKED_WAITING" };
  }
  // missing: provably never dispatched.
  if (KEYED_KINDS.includes(kind)) {
    // A retry under the SAME idempotency key is collision-free: if a twin
    // completed anywhere it replays the original receipt instead of doubling.
    return { action: "retry_with_same_key", blockSameKind: false, substate: "EXECUTING" };
  }
  return { action: "halt_and_reconcile", blockSameKind: true, substate: "BLOCKED_WAITING" };
}

export interface IdempotencySnapshotEntry {
  status: "new" | "in_flight" | "completed";
  receipt?: unknown;
}

/** Map an IdempotencyRegistry snapshot (post-restart) onto reconcile plans. */
export function planForSnapshotEntries(
  kind: ReceiptKind,
  entries: Record<string, IdempotencySnapshotEntry>
): Array<{ key: string; branch: ReceiptBranch; plan: ReconcilePlan }> {
  return Object.entries(entries).map(([key, entry]) => {
    const branch: ReceiptBranch =
      entry.status === "completed" ? "completed" : entry.status === "in_flight" ? "in_flight" : "missing";
    return { key, branch, plan: planReconciliation(kind, branch) };
  });
}
