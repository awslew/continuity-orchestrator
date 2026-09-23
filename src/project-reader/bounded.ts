/** Bound a whole MCP response, preserving structural status fields.
 *
 * A response that fits is returned as it is: copying it to prove nothing was cut costs CPU on
 * every call and adds a field the caller has to read. `output_truncated` appears only when
 * something actually was, because the caller must never mistake a cut payload for a complete
 * one.
 *
 * This lives outside `pro.ts` so it can be tested at all: importing that module starts the MCP
 * server, so a function defined there is reachable only by standing one up. */
export const BOUNDED_CHARS = 24_000;
/** What an omitted string is replaced with. Short on purpose: the budget is spent by the
 * markers too, and a marker that costs as much as the value it removes bounds nothing. */
export const TRUNCATION_MARK = "[truncated]";

export function bounded(value: unknown): { data: unknown; output_truncated?: true } {
  if (JSON.stringify(value)?.length <= BOUNDED_CHARS) return { data: value };
  let left = BOUNDED_CHARS, truncated = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      if (x.length <= left) { left -= x.length; return x; }
      truncated = true;
      // A string that does not fit is REPLACED, never cut. Cutting produced two answers a
      // caller could not tell apart from data: a silent prefix reads as a complete value, and
      // once the budget ran out `slice(0, 0)` left an EMPTY string, which reads as a real empty
      // value. A real client hit exactly that on a 6-minute round and reported `path: ""`,
      // `operation: ""`, `after_sha256: ""` and `argv: ["", "", ""]` — every one of them looks
      // like something the plugin actually said. The marker says "omitted" in the only place
      // that matters, and when even the marker will not fit the value is dropped entirely:
      // `output_truncated: true` is what tells the caller the answer is incomplete.
      if (left >= TRUNCATION_MARK.length) { left -= TRUNCATION_MARK.length; return TRUNCATION_MARK; }
      return undefined;
    }
    if (Array.isArray(x)) { truncated ||= x.length > 200; return x.slice(0, 200).map(walk).filter(item => item !== undefined); }
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]).filter(([, v]) => v !== undefined));
    return x;
  };
  return { data: walk(value), output_truncated: true };
}
