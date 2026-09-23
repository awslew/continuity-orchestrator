import { sha256 } from "../domain/canonical.js";

/**
 * The App Server contract is intentionally kept local to this adapter.  The
 * repository has not yet received a real account/rateLimits/read receipt, so
 * this module accepts only the two structured operation names and never tries
 * to scrape a widget, page, or human-readable message.
 */
export const RATE_LIMIT_OPERATIONS = [
  "account/rateLimits/read",
  "account/rateLimits/updated"
] as const;

export type RateLimitOperation = (typeof RATE_LIMIT_OPERATIONS)[number];

export type QuotaSampleStatus = "fresh" | "unknown" | "conflict";

export interface NormalizedRateLimitWindow {
  kind: "primary" | "secondary";
  windowId: string;
  remainingBps: number;
  usedBps: number;
  resetsAt: string | null;
  updatedAt: string;
  derivedRemaining: boolean;
  derivedUsed: boolean;
  exhausted: boolean;
}

export interface NormalizedQuotaSnapshot {
  sampleId: string;
  sampledAt: string;
  updatedAt: string;
  primary: NormalizedRateLimitWindow | null;
  secondary: NormalizedRateLimitWindow | null;
  source: "app-server" | "fixture";
  rawHash: string;
  sampleHash: string;
  conflict: boolean;
  status: QuotaSampleStatus;
  reason: string;
  errors: string[];
  operation: RateLimitOperation | null;
}

/** A deliberately narrow shape; unknown keys are tolerated only as transport metadata. */
export interface StructuredRateLimitsMessage {
  method?: string;
  operation?: string;
  type?: string;
  result?: unknown;
  params?: unknown;
  account?: unknown;
  rateLimits?: unknown;
  updatedAt?: unknown;
  sampledAt?: unknown;
  [key: string]: unknown;
}

export interface NormalizeQuotaOptions {
  /** Used by the read/updated convenience functions, never inferred from a local clock. */
  operation?: RateLimitOperation;
  source?: "app-server" | "fixture";
  /** Previous trusted sample, when available, for monotonicity/window mapping checks. */
  previous?: NormalizedQuotaSnapshot | null;
}

interface RecordValue {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function timestamp(value: unknown): string | null {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function field(record: RecordValue, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

/** Convert a decimal percent to an integer basis-point value without binary float math. */
function percentToBps(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100) return null;
  const text = String(number);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : null;
}

function bpsValue(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 && number <= 10_000 ? number : null;
}

function statusIsExhausted(value: unknown): boolean {
  return value === true || value === "exhausted" || value === "EXHAUSTED" || value === "depleted" || value === "DEPLETED";
}

function candidateRateLimits(message: RecordValue): RecordValue | null {
  const direct = message.rateLimits;
  if (isRecord(direct)) return direct;

  for (const key of ["result", "params", "account"]) {
    const nested = message[key];
    if (!isRecord(nested)) continue;
    if (isRecord(nested.rateLimits)) return nested.rateLimits;
    if (isRecord(nested.data) && isRecord(nested.data.rateLimits)) return nested.data.rateLimits;
    // Some structured fixtures put primary/secondary under result directly.
    if (isRecord(nested.primary) || isRecord(nested.secondary)) return nested;
    if (isRecord(nested.account) && isRecord(nested.account.rateLimits)) return nested.account.rateLimits;
  }

  if (isRecord(message.primary) || isRecord(message.secondary)) return message;
  return null;
}

function candidateWindow(rateLimits: RecordValue, kind: "primary" | "secondary"): RecordValue | null {
  const direct = rateLimits[kind];
  if (isRecord(direct)) return direct;
  if (Array.isArray(rateLimits.windows)) {
    for (const item of rateLimits.windows) {
      if (!isRecord(item)) continue;
      const itemKind = field(item, "kind", "type", "name");
      if (itemKind === kind) return item;
    }
  }
  return null;
}

function messageField(message: RecordValue, ...names: string[]): unknown {
  const direct = field(message, ...names);
  if (direct !== undefined) return direct;
  for (const key of ["result", "params"]) {
    const nested = message[key];
    if (isRecord(nested)) {
      const value = field(nested, ...names);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function operationOf(message: RecordValue, options: NormalizeQuotaOptions): RateLimitOperation | null {
  const candidate = stringValue(field(message, "method", "operation", "type")) ?? options.operation ?? null;
  return RATE_LIMIT_OPERATIONS.includes(candidate as RateLimitOperation) ? candidate as RateLimitOperation : null;
}

function parseWindow(
  rateLimits: RecordValue,
  kind: "primary" | "secondary",
  root: RecordValue,
  errors: string[]
): NormalizedRateLimitWindow | null {
  const raw = candidateWindow(rateLimits, kind);
  if (!raw) {
    if (kind === "primary") errors.push("missing_primary");
    return null;
  }

  const windowId = stringValue(field(raw, "windowId", "window_id", "id"));
  if (!windowId) errors.push(`${kind}_window_id_missing`);

  const usedInput = field(raw, "usedPercent", "used_percent");
  const remainingInput = field(raw, "remainingPercent", "remaining_percent");
  const usedBpsInput = field(raw, "usedBps", "used_bps");
  const remainingBpsInput = field(raw, "remainingBps", "remaining_bps");

  const usedBps = usedBpsInput !== undefined ? bpsValue(usedBpsInput) : percentToBps(usedInput);
  const remainingBps = remainingBpsInput !== undefined ? bpsValue(remainingBpsInput) : percentToBps(remainingInput);
  const hasUsed = usedInput !== undefined || usedBpsInput !== undefined;
  const hasRemaining = remainingInput !== undefined || remainingBpsInput !== undefined;
  if (hasUsed && usedBps === null) errors.push(`${kind}_used_invalid`);
  if (hasRemaining && remainingBps === null) errors.push(`${kind}_remaining_invalid`);
  if (!hasUsed && !hasRemaining) errors.push(`${kind}_percentage_missing`);

  let normalizedUsed = usedBps;
  let normalizedRemaining = remainingBps;
  let derivedUsed = false;
  let derivedRemaining = false;
  if (normalizedUsed === null && normalizedRemaining !== null) {
    normalizedUsed = 10_000 - normalizedRemaining;
    derivedUsed = true;
  }
  if (normalizedRemaining === null && normalizedUsed !== null) {
    normalizedRemaining = 10_000 - normalizedUsed;
    derivedRemaining = true;
  }
  if (normalizedUsed !== null && normalizedRemaining !== null && normalizedUsed + normalizedRemaining !== 10_000) {
    errors.push(`${kind}_percentage_conflict`);
  }

  const rawUpdated = field(raw, "updatedAt", "updated_at", "lastUpdatedAt");
  const rootUpdated = field(root, "updatedAt", "updated_at");
  const updatedAt = timestamp(rawUpdated ?? rootUpdated);
  if (!updatedAt) errors.push(`${kind}_updated_at_missing_or_invalid`);

  const rawReset = field(raw, "resetsAt", "resetAt", "resets_at", "reset_at");
  const resetsAtValue = rawReset === null || rawReset === undefined ? null : timestamp(rawReset);
  if (rawReset !== undefined && rawReset !== null && !resetsAtValue) errors.push(`${kind}_resets_at_invalid`);

  const exhaustedValue = field(raw, "exhausted", "status");
  if (!windowId || normalizedUsed === null || normalizedRemaining === null || !updatedAt) return null;
  return {
    kind,
    windowId,
    remainingBps: normalizedRemaining,
    usedBps: normalizedUsed,
    resetsAt: resetsAtValue,
    updatedAt,
    derivedRemaining,
    derivedUsed,
    exhausted: statusIsExhausted(exhaustedValue)
  };
}

function validOperationMessage(message: RecordValue, operation: RateLimitOperation | null): boolean {
  // A convenience call supplies the operation explicitly; otherwise the
  // structured message must identify one of the two App Server operations.
  return operation !== null && (message.method === undefined || message.operation === undefined || message.type === undefined ||
    RATE_LIMIT_OPERATIONS.includes(stringValue(field(message, "method", "operation", "type")) as RateLimitOperation));
}

function comparePrevious(
  current: NormalizedQuotaSnapshot,
  previous: NormalizedQuotaSnapshot | null | undefined,
  errors: string[]
): void {
  if (!previous) return;
  if (current.updatedAt && previous.updatedAt && Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) {
    errors.push("updated_at_regressed");
  }
  for (const kind of ["primary", "secondary"] as const) {
    const oldWindow = previous[kind];
    const newWindow = current[kind];
    if (oldWindow && newWindow && oldWindow.windowId !== newWindow.windowId) errors.push(`${kind}_window_unmappable`);
    if (oldWindow && !newWindow) errors.push(`${kind}_window_missing_after_previous`);
  }
}

function emptySnapshot(
  message: unknown,
  operation: RateLimitOperation | null,
  source: "app-server" | "fixture",
  errors: string[],
  conflict: boolean,
  updatedAt = ""
): NormalizedQuotaSnapshot {
  const rawHash = sha256(message);
  const sampleHash = sha256({ operation, updatedAt, primary: null, secondary: null, errors });
  return {
    sampleId: `sample-${sampleHash.slice(7, 23)}`,
    sampledAt: updatedAt,
    updatedAt,
    primary: null,
    secondary: null,
    source,
    rawHash,
    sampleHash,
    conflict,
    status: conflict ? "conflict" : "unknown",
    reason: errors[0] ?? "QUOTA_DATA_UNKNOWN",
    errors: [...new Set(errors)],
    operation
  };
}

/** Normalize a structured App Server read/updated message into integer bps. */
export function normalizeRateLimits(message: unknown, options: NormalizeQuotaOptions = {}): NormalizedQuotaSnapshot {
  const source = options.source ?? "app-server";
  if (!isRecord(message)) return emptySnapshot(message, options.operation ?? null, source, ["unstructured_rate_limits_message"], false);
  const operation = operationOf(message, options);
  if (!validOperationMessage(message, operation)) return emptySnapshot(message, operation, source, ["unsupported_rate_limits_operation"], false);

  const rateLimits = candidateRateLimits(message);
  if (!rateLimits) return emptySnapshot(message, operation, source, ["rate_limits_shape_missing"], false);
  const errors: string[] = [];
  const primary = parseWindow(rateLimits, "primary", message, errors);
  const secondary = parseWindow(rateLimits, "secondary", message, errors);
  const topUpdatedAt = timestamp(messageField(message, "updatedAt", "updated_at"));
  const updatedAt = topUpdatedAt ?? [primary?.updatedAt, secondary?.updatedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? "";
  const sampledAt = timestamp(messageField(message, "sampledAt", "sampled_at")) ?? updatedAt;
  if (topUpdatedAt && primary && Date.parse(primary.updatedAt) > Date.parse(topUpdatedAt)) errors.push("root_updated_at_conflict");
  if (topUpdatedAt && secondary && Date.parse(secondary.updatedAt) > Date.parse(topUpdatedAt)) errors.push("root_updated_at_conflict");
  if (!updatedAt) errors.push("sample_updated_at_missing_or_invalid");

  const conflict = errors.some((error) => error.includes("conflict") || error.includes("regressed"));
  const snapshotWithoutMeta: Omit<NormalizedQuotaSnapshot, "sampleId" | "status" | "reason" | "errors" | "conflict" | "rawHash" | "sampleHash"> = {
    sampledAt,
    updatedAt,
    primary,
    secondary,
    source,
    operation
  };
  const sampleHash = sha256(snapshotWithoutMeta);
  const snapshot: NormalizedQuotaSnapshot = {
    sampleId: `sample-${sampleHash.slice(7, 23)}`,
    ...snapshotWithoutMeta,
    rawHash: sha256(message),
    sampleHash,
    conflict,
    status: errors.length === 0 ? "fresh" : conflict ? "conflict" : "unknown",
    reason: errors.length === 0 ? "NORMALIZED" : errors[0] ?? "QUOTA_DATA_UNKNOWN",
    errors: [...new Set(errors)]
  };
  const previousErrors: string[] = [];
  comparePrevious(snapshot, options.previous, previousErrors);
  if (previousErrors.length) {
    snapshot.errors = [...new Set([...snapshot.errors, ...previousErrors])];
    snapshot.status = previousErrors.some((error) => error.includes("regressed")) ? "conflict" : "unknown";
    snapshot.conflict = snapshot.status === "conflict";
    snapshot.reason = previousErrors[0]!;
  }
  return snapshot;
}

export function normalizeRateLimitsRead(message: unknown, options: Omit<NormalizeQuotaOptions, "operation"> = {}): NormalizedQuotaSnapshot {
  return normalizeRateLimits(message, { ...options, operation: "account/rateLimits/read" });
}

export function normalizeRateLimitsUpdated(message: unknown, options: Omit<NormalizeQuotaOptions, "operation"> = {}): NormalizedQuotaSnapshot {
  return normalizeRateLimits(message, { ...options, operation: "account/rateLimits/updated" });
}

/** Compatibility aliases used by the adapter and fixture tests. */
export const normalizeQuotaSnapshot = normalizeRateLimits;
export const normalizeQuota = normalizeRateLimits;

export function isNormalizedQuotaSnapshot(value: unknown): value is NormalizedQuotaSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.sampleId === "string" && typeof value.sampleHash === "string" &&
    typeof value.updatedAt === "string" && (value.primary === null || isRecord(value.primary)) &&
    (value.secondary === null || isRecord(value.secondary)) &&
    ["fresh", "unknown", "conflict"].includes(String(value.status));
}
