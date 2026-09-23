import { createHash } from "node:crypto";
import type { RemainingWorkItem } from "./types.js";

/** Deterministic JSON used for hashes and idempotency payload identity. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable fingerprint for a complete handoff source set. */
export function workItemsHash(items: readonly RemainingWorkItem[]): string {
  const normalized = [...items].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((item) => ({
    taskId: item.taskId,
    parentId: item.parentId,
    status: item.status,
    dependencies: [...item.dependencies].sort(),
    acceptance: [...item.acceptance],
    acceptancePassed: item.acceptancePassed,
    evidence: [...item.evidence].sort(),
    lastCheckpoint: item.lastCheckpoint,
    sourceOfTruth: item.sourceOfTruth
  }));
  return sha256(normalized);
}
