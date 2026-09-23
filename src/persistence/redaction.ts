import { clone } from "../domain/canonical.js";

export const REDACTION_VERSION = "continuity.redaction.v2";
const SENSITIVE_KEY = /(^|[_-])(token|transcript|prompt|api[_-]?key|authorization|cookie|secret|password|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)($|[_-])/i;
// v2 adds query-string credentials (API errors and redirect URLs commonly
// carry `?token=`/`?key=`/`?code=`); over-redaction of such fragments is
// acceptable, leaking them is not.  `sk-`/`ghp_`-style token patterns require
// a non-word prefix boundary and a realistic token length: without them any
// word ending in "sk-" (e.g. the task id "task-restart-1") was mangled on
// disk, corrupting state.json with a false-positive redaction.
const SENSITIVE_VALUE = /(bearer\s+|(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}|session=|connect\.sid=|[?&](token|key|api[_-]?key|access[_-]?token|refresh[_-]?token|code|sig(nature)?|session[_-]?id)=[^&\s"']+)/gi;

function redactString(value: string): string {
  return value.replace(SENSITIVE_VALUE, "[REDACTED]");
}

function redact(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  return value;
}

export function redactRecord<T>(value: T): T {
  return redact(clone(value)) as T;
}

export function truncateText(value: string, maxBytes = 16_384): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return redactString(value);
  let result = value;
  while (Buffer.byteLength(result, "utf8") > Math.max(0, maxBytes - 32)) result = result.slice(0, Math.max(0, result.length - 16));
  return `${redactString(result)}…[TRUNCATED ${bytes} bytes]`;
}

export interface RedactionOutcome<T> {
  value: T;
  truncated: boolean;
}

/** Byte-accurate redaction+truncation that reports whether truncation happened. */
export function redactAndTruncateDetailed<T>(value: T, maxBytes = 16_384): RedactionOutcome<T> {
  const redacted = redactRecord(value);
  const serialized = JSON.stringify(redacted);
  // The budget is bytes, not UTF-16 code units, so multibyte content must be
  // measured with Buffer.byteLength before deciding to truncate.
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return { value: redacted, truncated: false };
  return { value: truncateText(serialized, maxBytes) as T, truncated: true };
}

export function redactAndTruncate<T>(value: T, maxBytes = 16_384): T {
  return redactAndTruncateDetailed(value, maxBytes).value;
}
