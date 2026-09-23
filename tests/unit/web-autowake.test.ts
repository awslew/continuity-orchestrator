import assert from "node:assert/strict";
import test from "node:test";
import { MockWebgptDriveTransport, WebgptDriveAdapter } from "../../src/adapters/webgpt-drive.js";
import { DomainError } from "../../src/domain/errors.js";
import type { TaskLedger } from "../../src/domain/types.js";
import { AutoWakeup, buildWakeupMessage, wakeupKey } from "../../src/web/auto-wakeup.js";
import { ledgerWithTasks, webLedger } from "./helpers/ledgers.js";

function instruction(ref = "instructions/checkpoint-1") {
  return { kind: "instruction_ref" as const, ref, source: "test-plan" };
}

function autowake(transport: MockWebgptDriveTransport, sleeps: number[] = [], enabled = true) {
  return new AutoWakeup(new WebgptDriveAdapter(transport), {
    enabled,
    maxAttempts: 3,
    baseBackoffMs: 2_000,
    clock: () => 0,
    sleep: async (ms) => { sleeps.push(ms); }
  });
}

test("wakeup keys are deterministic per ledger cursor; re-preparing never mints a second key", () => {
  const ledger = webLedger();
  const first = buildWakeupMessage(ledger, instruction(), 7);
  const second = buildWakeupMessage(ledger, instruction(), 7);
  assert.equal(first.key, second.key);
  assert.equal(first.key, wakeupKey(ledger, 7));
  const differentCursor = buildWakeupMessage(ledger, instruction(), 8);
  assert.notEqual(first.key, differentCursor.key);
  assert.match(first.key, /^wakeup_relay-task_relay-1_r\d+_e7$/);
});

test("raw text is never sent: wakeup requires a structured instruction_ref", () => {
  const ledger = ledgerWithTasks() as TaskLedger;
  assert.throws(() => buildWakeupMessage(ledger, { kind: "instruction_ref", ref: "", source: "x" }, 1), DomainError);
});

test("a duplicate wakeup returns the original receipt (adapter replay), not a second message", async () => {
  const transport = new MockWebgptDriveTransport();
  const wa = autowake(transport);
  const { key, message } = buildWakeupMessage(webLedger(), instruction(), 3);
  const first = await wa.send("chat_mock_x_1", key, message);
  const again = await wa.send("chat_mock_x_1", key, message);
  assert.equal(first.outcome, "sent");
  assert.equal(again.outcome, "sent");
  assert.equal(again.receipt.upstreamMessageId, first.receipt.upstreamMessageId, "same key replays the same receipt");
});

test("blocked page state or quota stops the loop after one dispatch — no retry into uncertainty", async () => {
  const sleeps: number[] = [];
  const unknownPage = autowake(new MockWebgptDriveTransport({ pageState: "unknown" }), sleeps);
  const ledger = webLedger();
  const a = buildWakeupMessage(ledger, instruction("i-a"), 1);
  const blockedPage = await unknownPage.send("chat_mock_y_1", a.key, a.message);
  assert.equal(blockedPage.outcome, "blocked");
  assert.equal(blockedPage.attempts, 1);
  assert.deepEqual(sleeps, []);

  const ordinary429 = autowake(new MockWebgptDriveTransport({ quota: "ordinary_error" }), sleeps);
  const b = buildWakeupMessage(ledger, instruction("i-b"), 2);
  const blockedQuota = await ordinary429.send("chat_mock_y_2", b.key, b.message);
  assert.equal(blockedQuota.outcome, "blocked");
  assert.equal(blockedQuota.attempts, 1);
});

test("pre-send chat mismatch refuses before dispatch and does not back off", async () => {
  const sleeps: number[] = [];
  const transport = new MockWebgptDriveTransport({ resolveChatId: () => "chat-other" });
  const wa = autowake(transport, sleeps);
  const { key, message } = buildWakeupMessage(webLedger(), instruction(), 4);
  const result = await wa.send("chat_mapped", key, message);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("transport contract gaps retry with backoff until maxAttempts", async () => {
  const sleeps: number[] = [];
  const wa = autowake(new MockWebgptDriveTransport({ failReceipts: true }), sleeps);
  const { key, message } = buildWakeupMessage(webLedger(), instruction(), 5);
  const result = await wa.send("chat_mock_z_1", key, message);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [2_000, 4_000], "exponential backoff between attempts");
});

test("auto wakeup is fail-closed when the feature flag is off", async () => {
  const wa = autowake(new MockWebgptDriveTransport(), [], false);
  const { key, message } = buildWakeupMessage(webLedger(), instruction(), 6);
  await assert.rejects(() => wa.send("chat_mock_w_1", key, message), DomainError);
});
