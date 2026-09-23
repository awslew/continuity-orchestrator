/**
 * Exact confirmation gates (design §10, plan §8.3.6).
 *
 * APPLY/COMMIT (and the BIND/AUTHORIZE gates reserved for Tunnel/App binding)
 * accept only the exact literal confirmation word.  Natural-language matches,
 * case folding, trimming, or any other normalization deliberately fail: the
 * gate protects file writes, staging and commits from fuzzy web commands.
 */

import { canonicalize, sha256 } from "../domain/canonical.js";
import { DomainError } from "../domain/errors.js";

export const CONFIRMATION_KINDS = ["BIND", "AUTHORIZE", "APPLY", "COMMIT"] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

export interface ConfirmationReceipt {
  schemaVersion: "continuity.confirmation.v1";
  gateId: string;
  kind: ConfirmationKind;
  /** The identifier this gate protects (patch task id, workspace binding, ...). */
  targetId: string;
  /** The exact confirmation word that opened the gate. */
  confirmation: ConfirmationKind;
  confirmed: true;
  idempotencyKey: string;
  actor: string;
  at: string;
}

/**
 * Validate a caller-supplied confirmation value against the expected kind.
 * Anything other than the exact literal (case included) is rejected.
 */
export function assertExactConfirmation(kind: ConfirmationKind, value: unknown): void {
  if (value !== kind) {
    throw new DomainError(
      "RED_FLAGGED_INPUT",
      `confirmation must be the exact literal "${kind}"; fuzzy or normalized matches are rejected`
    );
  }
}

/**
 * Store of opened confirmation gates.  A gate is opened by an explicit,
 * exact confirmation and consumed by the protected operation.  Replaying the
 * same gate request returns the original receipt; a different payload under
 * the same idempotency key fails.
 */
export class ConfirmationGateRegistry {
  private readonly gates = new Map<string, ConfirmationReceipt>();

  /**
   * Open (or replay) a gate.  The caller must already have validated the
   * exact confirmation literal via `assertExactConfirmation`.
   */
  open(kind: ConfirmationKind, targetId: string, idempotencyKey: string, actor: string, at = new Date().toISOString()): ConfirmationReceipt {
    if (!idempotencyKey) throw new DomainError("RED_FLAGGED_INPUT", "confirmation gate requires an idempotency key");
    const existing = this.gates.get(idempotencyKey);
    if (existing) {
      const fingerprint = canonicalize({ kind, targetId, actor });
      if (existing.kind !== kind || canonicalize({ kind: existing.kind, targetId: existing.targetId, actor: existing.actor }) !== fingerprint) {
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "confirmation idempotency key was already used for another gate");
      }
      return { ...existing };
    }
    const receipt: ConfirmationReceipt = {
      schemaVersion: "continuity.confirmation.v1",
      gateId: `gate_${sha256({ kind, targetId, idempotencyKey, at }).slice("sha256:".length, "sha256:".length + 24)}`,
      kind,
      targetId,
      confirmation: kind,
      confirmed: true,
      idempotencyKey,
      actor,
      at
    };
    this.gates.set(idempotencyKey, receipt);
    return { ...receipt };
  }

  /**
   * Require an open, unconsumed gate of exactly `kind` for `targetId`.
   * `consume` marks the gate used so a second APPLY/COMMIT cannot reuse it.
   */
  require(kind: ConfirmationKind, targetId: string, consume = true): ConfirmationReceipt {
    for (const gate of this.gates.values()) {
      if (gate.kind === kind && gate.targetId === targetId && gate.confirmed) {
        if (consume) {
          this.gates.delete(gate.idempotencyKey);
        }
        return { ...gate };
      }
    }
    throw new DomainError(
      "INVALID_TRANSITION",
      `no open ${kind} confirmation gate for ${targetId}; the exact literal "${kind}" must be confirmed first`
    );
  }

  /** Non-consuming check, used for validation-only flows. */
  has(kind: ConfirmationKind, targetId: string): boolean {
    for (const gate of this.gates.values()) {
      if (gate.kind === kind && gate.targetId === targetId && gate.confirmed) return true;
    }
    return false;
  }

  snapshot(): ConfirmationReceipt[] {
    return [...this.gates.values()].map((gate) => ({ ...gate }));
  }

  load(receipts: readonly ConfirmationReceipt[]): void {
    for (const receipt of receipts) this.gates.set(receipt.idempotencyKey, { ...receipt });
  }
}
