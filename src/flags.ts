import { DomainError } from "./domain/errors.js";

export const FLAG_NAMES = [
  "CONTINUITY_ORCHESTRATOR_ENABLED",
  "CONTINUITY_QUOTA_GUARD_ENABLED",
  "CONTINUITY_AUTO_DRAIN_ENABLED",
  "CONTINUITY_WEB_HANDOFF_ENABLED",
  "CONTINUITY_WEB_UNATTENDED_ENABLED",
  "CONTINUITY_WEB_AUTOWAKE_ENABLED",
  "CONTINUITY_WATCHDOG_ENABLED",
  "CONTINUITY_CLAUDE_ENABLED",
  "CONTINUITY_DSH_ENABLED",
  "CONTINUITY_ENGINEERING_BRIDGE_ENABLED",
  "CONTINUITY_PATCH_APPLY_ENABLED",
  "CONTINUITY_RETURN_TO_CODEX_ENABLED",
  "CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK",
  "CONTINUITY_DRY_RUN"
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type FeatureFlags = Record<FlagName, boolean>;

export const DEFAULT_FLAGS: FeatureFlags = {
  CONTINUITY_ORCHESTRATOR_ENABLED: false,
  CONTINUITY_QUOTA_GUARD_ENABLED: false,
  CONTINUITY_AUTO_DRAIN_ENABLED: false,
  CONTINUITY_WEB_HANDOFF_ENABLED: false,
  CONTINUITY_WEB_UNATTENDED_ENABLED: false,
  CONTINUITY_WEB_AUTOWAKE_ENABLED: false,
  CONTINUITY_WATCHDOG_ENABLED: false,
  CONTINUITY_CLAUDE_ENABLED: false,
  CONTINUITY_DSH_ENABLED: false,
  CONTINUITY_ENGINEERING_BRIDGE_ENABLED: false,
  CONTINUITY_PATCH_APPLY_ENABLED: false,
  CONTINUITY_RETURN_TO_CODEX_ENABLED: false,
  CONTINUITY_CODEX_CHATGPT_WEB_FALLBACK: false,
  CONTINUITY_DRY_RUN: true
};

export function parseFlags(input: unknown, source: "protected-config" | "environment" | "web" = "protected-config"): FeatureFlags {
  if (source === "web") throw new DomainError("RED_FLAGGED_INPUT", "Web input cannot modify feature flags");
  if (input === undefined || input === null) return { ...DEFAULT_FLAGS };
  if (typeof input !== "object" || Array.isArray(input)) throw new DomainError("RED_FLAGGED_INPUT", "Feature flags must be an object");
  const result: FeatureFlags = { ...DEFAULT_FLAGS };
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(FLAG_NAMES as readonly string[]).includes(name)) throw new DomainError("RED_FLAGGED_INPUT", `Unknown feature flag ${name}`);
    if (typeof value !== "boolean") throw new DomainError("RED_FLAGGED_INPUT", `Feature flag ${name} must be boolean`);
    result[name as FlagName] = value;
  }
  return result;
}

export function isFlagEnabled(flags: FeatureFlags, name: FlagName): boolean {
  return flags[name] === true;
}

export function assertWebFlagMutation(source: string): never | void {
  if (source === "web") throw new DomainError("RED_FLAGGED_INPUT", "Web input cannot modify feature flags");
}
