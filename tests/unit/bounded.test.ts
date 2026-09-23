import assert from "node:assert/strict";
import test from "node:test";
import { bounded, BOUNDED_CHARS, TRUNCATION_MARK } from "../../src/project-reader/bounded.js";

/** A truncated answer must never carry a value that could be read as data. This is what a real
 * client hit on a 6-minute round: the tail of the answer came back as `path: ""`,
 * `operation: ""`, `after_sha256: ""` and `argv: ["", "", ""]`, and every one of those looks
 * exactly like something the plugin said on purpose. */
test("a bounded answer never carries a value that could be mistaken for data", () => {
  // Fits: returned as it is, and says nothing about truncation.
  const small = { state: "applied", changes: [{ path: "src/a.ts" }] };
  assert.deepEqual(bounded(small), { data: small });

  // Does not fit: the oversized string is replaced with a marker, NOT cut. A silent prefix of
  // the original would read as the complete value.
  const cut = bounded({ keep: "ok", big: "x".repeat(BOUNDED_CHARS * 2) }) as { data: Record<string, unknown>; output_truncated?: true };
  assert.equal(cut.output_truncated, true);
  assert.equal(cut.data.keep, "ok", "a value that fits is untouched");
  assert.equal(cut.data.big, TRUNCATION_MARK);
  assert.notEqual(cut.data.big, "", "an omitted string must never look like an empty string");
  assert.notEqual(cut.data.big, "x", "a silent prefix would read as the whole value");

  // Budget spent on real values: the ones that cannot fit are DROPPED, so the answer shrinks
  // instead of filling up with empty strings that look like data.
  const spent = bounded({ fill: "x".repeat(BOUNDED_CHARS - 5), last: "y".repeat(100) }) as { data: { fill: string; last?: string } };
  assert.equal(spent.data.fill.length, BOUNDED_CHARS - 5, "the value that fits keeps every character");
  assert.equal(spent.data.last, undefined);
  assert.ok(!("last" in JSON.parse(JSON.stringify(spent.data))), "a dropped key is absent from the answer, not empty in it");

  // Arrays of omitted strings shrink too: `argv: ["","",""]` was the same defect in array form.
  const args = bounded({ argv: ["a".repeat(BOUNDED_CHARS - 2), "b".repeat(100), "c".repeat(100)] }) as { data: { argv: string[] } };
  assert.deepEqual(args.data.argv.filter(v => v === ""), [], "no element of a truncated array may be an empty string");
});
