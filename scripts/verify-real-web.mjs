#!/usr/bin/env node
/**
 * Wave 6 real-web evidence organizer (plan §10.3.4, §10.4).
 *
 *   node scripts/verify-real-web.mjs --evidence-root "evidence/g1-g7/real-web"
 *
 * Scans the evidence root for acceptance-case bundles (cases A-L of plan
 * §10.1), validates each bundle against the required evidence fields defined
 * in docs/real-web-evidence.md, and writes report.json + report.md.
 *
 * This script ORGANIZES EVIDENCE AND CHECKS COMPLETENESS.  It can never
 * substitute for the user's observation/confirmation of the real web pages —
 * a COLLECTED verdict means "the bundle is structurally complete", not
 * "G7 passed".  Terminal reasons are pinned to the closed enumeration
 * ALL_TASKS_COMPLETED / WEB_QUOTA_EXHAUSTED / HUMAN_STOP.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TERMINAL_REASONS = ["ALL_TASKS_COMPLETED", "WEB_QUOTA_EXHAUSTED", "HUMAN_STOP"];
const CASES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

const REQUIRED_FIELDS = [
  "case_id",
  "observed_page_state",
  "tool_receipts",
  "local_evidence_refs",
  "event_refs",
  "next_state",
  "observed_at"
];
const TERMINAL_EXTRA = ["terminal_reason", "relay_epoch"];

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--evidence-root") {
      args.evidenceRoot = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function bundlePaths(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!statSync(path).isDirectory()) {
      if (name.endsWith(".json")) found.push(path);
      continue;
    }
    const bundle = join(path, "bundle.json");
    if (existsSync(bundle)) found.push(bundle);
  }
  return found;
}

function validateBundle(bundle) {
  const issues = [];
  for (const field of REQUIRED_FIELDS) {
    const value = bundle[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0)) {
      issues.push(`missing:${field}`);
    }
  }
  if (bundle.observed_at !== undefined && Number.isNaN(Date.parse(bundle.observed_at))) {
    issues.push("invalid:observed_at");
  }
  const isTerminal = bundle.terminal_reason !== undefined || (typeof bundle.next_state === "string" && bundle.next_state === "WEB_TERMINAL");
  if (isTerminal) {
    if (!TERMINAL_REASONS.includes(bundle.terminal_reason)) {
      issues.push(`terminal_reason_outside_closed_enumeration:${String(bundle.terminal_reason)}`);
    }
    for (const field of TERMINAL_EXTRA) {
      if (!bundle[field]) issues.push(`missing:${field}`);
    }
    if (bundle.terminal_reason === "HUMAN_STOP" && !bundle.stop_receipt_ref) {
      issues.push("missing:stop_receipt_ref (HUMAN_STOP requires a STOP_RELAY/confirmation receipt)");
    }
    if (bundle.terminal_reason === "WEB_QUOTA_EXHAUSTED" && !bundle.quota_receipt_ref) {
      issues.push("missing:quota_receipt_ref (WEB_QUOTA_EXHAUSTED requires a quota receipt)");
    }
    if (bundle.terminal_reason === "WEB_QUOTA_EXHAUSTED" && bundle.post_recovery_resumed === true) {
      issues.push("invalid:post_recovery_resumed (K: quota recovery must not resume execution)");
    }
  }
  return issues;
}

const args = parseArgs(process.argv);
if (!args.evidenceRoot) {
  process.stderr.write("usage: node scripts/verify-real-web.mjs --evidence-root <evidence directory>\n");
  process.exit(2);
}
const evidenceRoot = resolve(args.evidenceRoot);
if (!existsSync(evidenceRoot)) {
  process.stderr.write(`evidence root does not exist: ${evidenceRoot}\n`);
  process.exit(2);
}

const bundles = bundlePaths(evidenceRoot);
const results = bundles.map((path) => {
  let bundle = null;
  let parseError = null;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    parseError = String(error);
  }
  if (parseError !== null) {
    return { path, case_id: null, verdict: "MALFORMED", issues: [parseError] };
  }
  const issues = validateBundle(bundle);
  return { path, case_id: bundle.case_id ?? null, verdict: issues.length === 0 ? "COLLECTED" : "INCOMPLETE", issues };
});

// The checklist also lists which of the plan's cases A-L have no bundle at all.
const coveredCases = new Set(results.map((result) => result.case_id).filter(Boolean));
const missingCases = CASES.filter((testCase) => !coveredCases.has(testCase));

const allCollected = results.length > 0 && results.every((result) => result.verdict === "COLLECTED");
const report = {
  schema: "continuity-real-web-evidence-report.v1",
  generatedAt: new Date().toISOString(),
  evidenceRoot,
  disclaimer: "This report organizes evidence and checks completeness only. G7 acceptance requires the user's live observation and confirmation per plan §10.5; a COLLECTED verdict is not a real-web PASS.",
  bundles: results,
  missingCases,
  verdict: allCollected ? "ALL_BUNDLES_COLLECTED" : "GAPS_PRESENT"
};

writeFileSync(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  "# Real-web evidence organization report",
  "",
  `generated: ${report.generatedAt}`,
  "",
  `> ${report.disclaimer}`,
  "",
  "| case | bundle | verdict | issues |",
  "|---|---|---|---|"
];
for (const result of results) {
  lines.push(`| ${result.case_id ?? "?"} | ${result.path} | ${result.verdict} | ${result.issues.join("; ") || "-"} |`);
}
if (missingCases.length) {
  lines.push("", `Missing bundles for cases: ${missingCases.join(", ")}`);
}
lines.push("", `verdict: ${report.verdict}`, "");
writeFileSync(join(evidenceRoot, "report.md"), lines.join("\n") + "\n");
process.stdout.write(`${report.verdict} (${results.length} bundles, missing cases: ${missingCases.join(",") || "none"})\n`);
process.exit(allCollected ? 0 : 1);
