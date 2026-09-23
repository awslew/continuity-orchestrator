import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { parseRuntimeConfig, redactedRuntimeConfig, runtimeConfigFromEnvironment, sanitizeRuntimeValue } from "../../src/runtime-config.js";

function productionInput(root: string) {
  return {
    profile: "production",
    repositoryRoot: root,
    stateDir: join(root, "state"),
    evidenceDir: join(root, "evidence"),
    webgpt: { baseUrl: "http://127.0.0.1:4173", tabId: "continuity-test", timeoutMs: 1_000, tokenEnv: "WEBGPT_TOKEN" },
    appServer: { command: "codex", args: ["app-server"], cwd: root, env: {}, envAllowlist: [], requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, protectedTaskIds: [] }
  };
}

test("production runtime rejects missing required transport and state configuration", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "continuity-runtime-config-"));
  assert.throws(() => parseRuntimeConfig({ profile: "production", repositoryRoot: root }, root), /stateDir|evidenceDir|webgpt|App Server/);
});

test("test runtime remains explicit and does not imply a mock transport", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "continuity-runtime-test-"));
  const config = parseRuntimeConfig({ profile: "test", repositoryRoot: root }, root);
  assert.equal(config.profile, "test");
  assert.equal(config.webgpt, null);
  assert.equal(config.appServer, null);
});

test("production env reads only named values and redacted projection contains no secret", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "continuity-runtime-env-"));
  const input = productionInput(root);
  const config = parseRuntimeConfig(input, root);
  const safe = redactedRuntimeConfig(config);
  assert.equal((safe.webgpt as Record<string, unknown>).tokenEnv, "WEBGPT_TOKEN");
  assert.equal(JSON.stringify(safe).includes("secret-value"), false);

  const fromEnv = runtimeConfigFromEnvironment({
    CONTINUITY_RUNTIME_PROFILE: "test",
    CONTINUITY_REPOSITORY_ROOT: root,
    CONTINUITY_FLAGS: JSON.stringify({ CONTINUITY_DRY_RUN: true })
  }, root);
  assert.equal(fromEnv.profile, "test");
});

test("production process environment is never inherited through app-server config", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "continuity-runtime-env-allowlist-"));
  const input = productionInput(root) as Record<string, unknown>;
  input.appServer = { ...(input.appServer as Record<string, unknown>), env: { SECRET_VALUE: "secret-value" }, envAllowlist: [] };
  assert.throws(() => parseRuntimeConfig(input, root), /envAllowlist/);
});

test("runtime diagnostics redact credential keys, bearer values, and URL credentials", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "continuity-runtime-redaction-"));
  const input = productionInput(root) as Record<string, unknown>;
  input.webgpt = { ...(input.webgpt as Record<string, unknown>), baseUrl: "https://user:password@example.test/?token=url-secret" };
  input.appServer = { ...(input.appServer as Record<string, unknown>), args: ["--header", "Authorization: Bearer header-secret", "https://user:pass@example.test"] };
  const safe = redactedRuntimeConfig(parseRuntimeConfig(input, root));
  const text = JSON.stringify(safe);
  assert.equal(text.includes("password"), false);
  assert.equal(text.includes("url-secret"), false);
  assert.equal(text.includes("header-secret"), false);
  assert.equal(text.includes("[REDACTED]"), true);

  const receipt = sanitizeRuntimeValue({ attemptId: "attempt-1", sessionId: "session-1", authorization: "Bearer raw-secret", nested: { apiKey: "raw-key" } });
  assert.equal(receipt.attemptId, "attempt-1");
  assert.equal(receipt.sessionId, "session-1");
  assert.equal(JSON.stringify(receipt).includes("raw-secret"), false);
  assert.equal(JSON.stringify(receipt).includes("raw-key"), false);
});
