import { resolve } from "node:path";
import { parseFlags, DEFAULT_FLAGS, type FeatureFlags } from "./flags.js";
import { DomainError } from "./domain/errors.js";

export interface ContinuityConfig {
  stateDir: string;
  indexCacheFile: string;
  maxEvidenceBytes: number;
  leaseTtlMs: number;
  freshnessWindowMs: number;
  flags: FeatureFlags;
}

export const DEFAULT_CONFIG: ContinuityConfig = {
  stateDir: ".ai-handoff",
  indexCacheFile: "index-cache.json",
  maxEvidenceBytes: 16_384,
  leaseTtlMs: 300_000,
  freshnessWindowMs: 300_000,
  flags: { ...DEFAULT_FLAGS }
};

function positiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new DomainError("RED_FLAGGED_INPUT", `${field} must be a positive number`);
  return value;
}

export function parseConfig(input: unknown): ContinuityConfig {
  if (input === undefined || input === null) return { ...DEFAULT_CONFIG, flags: { ...DEFAULT_FLAGS } };
  if (typeof input !== "object" || Array.isArray(input)) throw new DomainError("RED_FLAGGED_INPUT", "Config must be an object");
  const object = input as Record<string, unknown>;
  const stateDir = object.stateDir === undefined ? DEFAULT_CONFIG.stateDir : object.stateDir;
  const indexCacheFile = object.indexCacheFile === undefined ? DEFAULT_CONFIG.indexCacheFile : object.indexCacheFile;
  if (typeof stateDir !== "string" || !stateDir || stateDir.includes("\u0000") || typeof indexCacheFile !== "string" || !indexCacheFile || indexCacheFile.includes("\u0000")) {
    throw new DomainError("RED_FLAGGED_INPUT", "Config paths must be non-empty strings");
  }
  const flags = parseFlags(object.flags);
  return {
    stateDir: resolve(stateDir),
    indexCacheFile,
    maxEvidenceBytes: positiveNumber(object.maxEvidenceBytes, "maxEvidenceBytes", DEFAULT_CONFIG.maxEvidenceBytes),
    leaseTtlMs: positiveNumber(object.leaseTtlMs, "leaseTtlMs", DEFAULT_CONFIG.leaseTtlMs),
    freshnessWindowMs: positiveNumber(object.freshnessWindowMs, "freshnessWindowMs", DEFAULT_CONFIG.freshnessWindowMs),
    flags
  };
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): ContinuityConfig {
  const parsed = parseConfig(undefined);
  const stateDir = env.CONTINUITY_STATE_DIR;
  return {
    ...parsed,
    stateDir: stateDir ? resolve(stateDir) : parsed.stateDir
  };
}
