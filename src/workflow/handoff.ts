/**
 * Handoff workflow + web delivery manifest (plan §8.3.5, 4C/4E).
 *
 * `prepareHandoff` drives CODEX_ACTIVE → DRAINING → HANDOFF_READY through the
 * state machine with a complete, hash-bound source snapshot.  The manifest
 * helpers make the accepted `handoff.md` deliverable to the web in verified
 * chunks: chunk reads verify the chunk hash, acceptance verifies the manifest
 * hash and the full chunk hash set before any receipt is written.
 */

import { DomainError } from "../domain/errors.js";
import { canonicalize, clone, sha256 } from "../domain/canonical.js";
import { transitionLedger, updateLedger } from "../domain/state-machine.js";
import type { HandoffDocument, HandoffReconciliationProof, HandoffSourceSnapshot, TaskLedger } from "../domain/types.js";
import type { HandoffStore } from "../persistence/handoff-store.js";
import type { TaskCoordinator } from "./task-coordinator.js";
import type { EvidenceWriter } from "../evidence/evidence-writer.js";

export const HANDOFF_MANIFEST_SCHEMA = "continuity.handoff-manifest.v1" as const;
export const HANDOFF_ACCEPT_SCHEMA = "continuity.handoff-accept.v1" as const;

export interface HandoffManifestChunk {
  index: number;
  sha256: string;
  bytes: number;
}

export interface HandoffManifest {
  schemaVersion: typeof HANDOFF_MANIFEST_SCHEMA;
  task_id: string;
  relay_epoch: string;
  manifest_hash: string;
  source_hash: string;
  counts: TaskLedger["counts"];
  chunk_size: number;
  chunk_count: number;
  chunks: HandoffManifestChunk[];
  at: string;
}

export interface HandoffAcceptReceipt {
  schemaVersion: typeof HANDOFF_ACCEPT_SCHEMA;
  task_id: string;
  manifest_hash: string;
  chunk_count: number;
  client_ref: string;
  accepted: true;
  at: string;
}

const DEFAULT_CHUNK_SIZE = 4096;

/**
 * Drive the ledger from CODEX_ACTIVE (or DRAINING) to HANDOFF_READY with a
 * complete remaining_work snapshot.  The snapshot is fully validated against
 * the ledger before anything is persisted: a rejected snapshot leaves the
 * ledger exactly where it was.  A sidecar, raw array or unknown visibility is
 * rejected by the underlying store.
 */
export function prepareHandoff(
  coordinator: TaskCoordinator,
  store: HandoffStore,
  taskId: string,
  sourceSnapshot: HandoffSourceSnapshot,
  expectedRevision: number,
  actor = "codex",
  at = new Date().toISOString()
): { ledger: TaskLedger; proof: HandoffReconciliationProof; handoffPath: string } {
  const current = coordinator.get(taskId);
  if (current.lifecycleState !== "CODEX_ACTIVE" && current.lifecycleState !== "DRAINING") {
    throw new DomainError("INVALID_TRANSITION", `handoff preparation requires CODEX_ACTIVE or DRAINING, actual ${current.lifecycleState}`);
  }
  if (current.revision !== expectedRevision) {
    throw new DomainError("REVISION_CONFLICT", `expected revision ${expectedRevision}, actual ${current.revision}`);
  }
  // Pure transition: DRAINING is only persisted once the snapshot validates.
  const draining = current.lifecycleState === "CODEX_ACTIVE"
    ? transitionLedger(current, "DRAINING", { expectedRevision: current.revision, at, actor })
    : current;
  // The snapshot must cover the ledger exactly; writeHandoff re-validates and
  // reconciles counts, ids and hashes before anything is written.
  const written = store.writeHandoff(draining, sourceSnapshot);
  const withHash = updateLedger(draining, { expectedRevision: draining.revision, at }, (draft) => {
    draft.handoffHash = written.hash;
  });
  const persisted = coordinator.save(withHash, "handoff_written", actor, at, {
    handoffHash: written.hash,
    from_state: current.lifecycleState
  });
  const proof: HandoffReconciliationProof = written.proof;
  const ready = coordinator.transition(
    taskId,
    "HANDOFF_READY",
    { expectedRevision: persisted.revision, at, actor, handoffProof: proof, drainComplete: true, drainScopeKnown: true },
    actor
  );
  return { ledger: ready, proof, handoffPath: written.path };
}

/** Build the web delivery manifest for an accepted handoff document. */
export function buildHandoffManifest(
  document: HandoffDocument,
  chunkSize = DEFAULT_CHUNK_SIZE,
  at = new Date().toISOString()
): { manifest: HandoffManifest; text: string } {
  if (chunkSize <= 0 || !Number.isSafeInteger(chunkSize)) {
    throw new DomainError("RED_FLAGGED_INPUT", "chunk size must be a positive safe integer");
  }
  const text = canonicalize(document);
  const manifestHash = sha256(document);
  const sourceHash = document.source_hashes["remaining_work"] ?? sha256(document.remaining_work);
  const chunks: HandoffManifestChunk[] = [];
  for (let index = 0; index * chunkSize < text.length; index += 1) {
    const slice = text.slice(index * chunkSize, (index + 1) * chunkSize);
    chunks.push({
      index,
      sha256: sha256(slice),
      bytes: Buffer.byteLength(slice, "utf8")
    });
  }
  if (chunks.length === 0) {
    chunks.push({ index: 0, sha256: sha256(""), bytes: 0 });
  }
  const manifest: HandoffManifest = {
    schemaVersion: HANDOFF_MANIFEST_SCHEMA,
    task_id: document.task_id,
    relay_epoch: document.relay_epoch,
    manifest_hash: manifestHash,
    source_hash: sourceHash,
    counts: clone(document.counts),
    chunk_size: chunkSize,
    chunk_count: chunks.length,
    chunks,
    at
  };
  return { manifest, text };
}

/**
 * Verify one chunk request against the manifest and return the chunk text.
 * A wrong hash or index is a reconciliation failure, never a partial read.
 */
export function readHandoffChunk(manifest: HandoffManifest, text: string, chunkIndex: number, chunkHash: string): { index: number; sha256: string; content: string; verified: true } {
  const chunk = manifest.chunks[chunkIndex];
  if (!chunk) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", `chunk index ${chunkIndex} is outside the manifest`);
  }
  const slice = text.slice(chunkIndex * manifest.chunk_size, (chunkIndex + 1) * manifest.chunk_size);
  const actualHash = sha256(slice);
  if (chunkHash !== chunk.sha256 || actualHash !== chunk.sha256) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", `chunk ${chunkIndex} hash mismatch`);
  }
  return { index: chunkIndex, sha256: chunk.sha256, content: slice, verified: true };
}

/**
 * Record the web-side acceptance.  The caller supplies the chunk receipts it
 * verified; every chunk must be covered with a matching hash, and the
 * manifest hash must match the current manifest.
 */
export function acceptHandoff(
  coordinator: TaskCoordinator,
  evidence: EvidenceWriter,
  manifest: HandoffManifest,
  text: string,
  manifestHash: string,
  chunkReceipts: ReadonlyArray<{ index: number; sha256: string }>,
  clientRef: string,
  actor = "web",
  at = new Date().toISOString()
): HandoffAcceptReceipt {
  if (manifestHash !== manifest.manifest_hash) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", "manifest hash does not match the current handoff manifest");
  }
  const seen = new Map<number, string>();
  for (const receipt of chunkReceipts) {
    const chunk = manifest.chunks[receipt.index];
    if (!chunk || chunk.sha256 !== receipt.sha256) {
      throw new DomainError("HANDOFF_RECONCILIATION_FAILED", `chunk receipt ${receipt.index} does not match the manifest`);
    }
    seen.set(receipt.index, receipt.sha256);
  }
  if (seen.size !== manifest.chunk_count) {
    throw new DomainError("HANDOFF_RECONCILIATION_FAILED", `chunk receipts cover ${seen.size} of ${manifest.chunk_count} chunks`);
  }
  for (const chunk of manifest.chunks) {
    const slice = text.slice(chunk.index * manifest.chunk_size, (chunk.index + 1) * manifest.chunk_size);
    if (sha256(slice) !== chunk.sha256) {
      throw new DomainError("HANDOFF_RECONCILIATION_FAILED", `local re-verification of chunk ${chunk.index} failed`);
    }
  }
  const ledger = coordinator.get(manifest.task_id);
  const receipt: HandoffAcceptReceipt = {
    schemaVersion: HANDOFF_ACCEPT_SCHEMA,
    task_id: manifest.task_id,
    manifest_hash: manifest.manifest_hash,
    chunk_count: manifest.chunk_count,
    client_ref: clientRef,
    accepted: true,
    at
  };
  const ref = evidence.write(manifest.task_id, `handoff-accept-${ledger.revision + 1}`, receipt, at);
  coordinator.eventLog(manifest.task_id).append({
    task_id: manifest.task_id,
    operation: "handoff_accept",
    actor,
    at,
    result: "completed",
    from_state: ledger.lifecycleState,
    to_state: ledger.lifecycleState,
    evidence_refs: [ref.ref],
    manifest_hash: manifest.manifest_hash
  });
  return receipt;
}
