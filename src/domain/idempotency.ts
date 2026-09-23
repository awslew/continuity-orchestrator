import { sha256, clone } from "./canonical.js";
import { fail } from "./errors.js";
import type { IdempotencyRecord, Receipt } from "./types.js";

export type IdempotencyBegin =
  | { kind: "new"; record: IdempotencyRecord }
  | { kind: "replay"; receipt: Receipt }
  | { kind: "in_flight"; record: IdempotencyRecord };

/** In-memory request ledger. A persistence adapter can serialize records without changing semantics. */
export class IdempotencyRegistry {
  private readonly records = new Map<string, IdempotencyRecord>();

  begin(key: string, payload: unknown, at = new Date().toISOString()): IdempotencyBegin {
    if (!key) fail("IDEMPOTENCY_KEY_REUSED", "idempotency key is required");
    const payloadHash = sha256(payload);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        fail("IDEMPOTENCY_KEY_REUSED", `Idempotency key ${key} was already used for another payload`, {
          key,
          existingPayloadHash: existing.payloadHash,
          payloadHash
        });
      }
      if (existing.status === "completed" && existing.receipt) return { kind: "replay", receipt: clone(existing.receipt) };
      return { kind: "in_flight", record: clone(existing) };
    }
    const record: IdempotencyRecord = {
      key,
      payloadHash,
      status: "in_flight",
      startedAt: at,
      updatedAt: at
    };
    this.records.set(key, record);
    return { kind: "new", record: clone(record) };
  }

  complete<T>(key: string, payload: unknown, receipt: Receipt<T>, at = new Date().toISOString()): Receipt<T> {
    const existing = this.records.get(key);
    const payloadHash = sha256(payload);
    if (!existing) {
      fail("IDEMPOTENCY_KEY_REUSED", `Cannot complete unknown idempotency key ${key}`);
    }
    if (existing.payloadHash !== payloadHash) {
      fail("IDEMPOTENCY_KEY_REUSED", `Idempotency key ${key} was already used for another payload`);
    }
    if (existing.status === "completed" && existing.receipt) return clone(existing.receipt) as Receipt<T>;
    const saved = clone(receipt);
    existing.status = "completed";
    existing.receipt = saved as Receipt;
    existing.updatedAt = at;
    return clone(saved);
  }

  markInFlight(key: string, payload: unknown, at = new Date().toISOString()): IdempotencyRecord {
    const current = this.begin(key, payload, at);
    if (current.kind === "new" || current.kind === "in_flight") return clone(current.record);
    fail("IDEMPOTENCY_IN_FLIGHT", `Idempotency key ${key} already has a completed receipt`);
  }

  get(key: string): IdempotencyRecord | null {
    const record = this.records.get(key);
    return record ? clone(record) : null;
  }

  load(records: IdempotencyRecord[]): void {
    for (const record of records) this.records.set(record.key, clone(record));
  }

  snapshot(): IdempotencyRecord[] {
    return [...this.records.values()].map((record) => clone(record));
  }
}

export function idempotencyPayloadHash(payload: unknown): string {
  return sha256(payload);
}
