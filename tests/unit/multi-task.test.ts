import assert from "node:assert/strict";
import test from "node:test";
import { MultiTaskRegistry } from "../../src/web/multi-task.js";
import { DomainError } from "../../src/domain/errors.js";

function isolation(taskId: string, projectId: string, webChatId: string) {
  return { taskId, projectId, webChatId };
}

test("each task owns exactly one chat; sharing a chat across tasks is refused", () => {
  const registry = new MultiTaskRegistry();
  registry.registerTask(isolation("task-a", "proj-1", "chat-a"));
  registry.registerTask(isolation("task-b", "proj-1", "chat-b"));
  registry.registerTask(isolation("task-c", "proj-2", "chat-c"));
  assert.throws(() => registry.registerTask(isolation("task-d", "proj-2", "chat-a")), (error: unknown) =>
    error instanceof DomainError && error.code === "DUPLICATE_TASK"
  );
  registry.releaseTask("task-a");
  registry.registerTask(isolation("task-d", "proj-2", "chat-a"));
  assert.equal(registry.isolationOf("task-d")?.webChatId, "chat-a", "chat ownership frees on release");
});

test("cross-task chat references are refused", () => {
  const registry = new MultiTaskRegistry();
  registry.registerTask(isolation("task-a", "proj-1", "chat-a"));
  registry.registerTask(isolation("task-b", "proj-1", "chat-b"));
  assert.throws(() => registry.assertIsolation("task-a", "chat-b"), (error: unknown) =>
    error instanceof DomainError && error.code === "RED_FLAGGED_INPUT"
  );
  assert.equal(registry.assertIsolation("task-a", "chat-a").projectId, "proj-1");
  assert.throws(() => registry.assertIsolation("task-unknown", "chat-a"), DomainError);
});

test("a task cannot silently switch chats", () => {
  const registry = new MultiTaskRegistry();
  registry.registerTask(isolation("task-a", "proj-1", "chat-a"));
  assert.throws(() => registry.registerTask(isolation("task-a", "proj-1", "chat-b")), (error: unknown) =>
    error instanceof DomainError && error.code === "INVALID_TRANSITION"
  );
});

test("project locks serialize same-project mutations without touching other projects", async () => {
  const registry = new MultiTaskRegistry();
  const events: string[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  await Promise.all([
    registry.withProjectLock("proj-1", async () => {
      events.push("p1-a:start");
      await sleep(20);
      events.push("p1-a:end");
    }),
    registry.withProjectLock("proj-1", async () => {
      events.push("p1-b:start");
      await sleep(5);
      events.push("p1-b:end");
    }),
    registry.withProjectLock("proj-2", async () => {
      events.push("p2:start");
      events.push("p2:end");
    })
  ]);
  assert.ok(events.indexOf("p1-a:end") < events.indexOf("p1-b:start"), "same project strictly serialized");
  assert.ok(events.indexOf("p1-a:end") < events.indexOf("p1-b:end"));
  assert.ok(events.indexOf("p2:start") < events.indexOf("p1-a:end"), "other projects are not blocked");
});

test("incomplete isolation triples are refused", () => {
  const registry = new MultiTaskRegistry();
  assert.throws(() => registry.registerTask(isolation("task-a", "", "chat-a")), DomainError);
  assert.throws(() => registry.registerTask(isolation("task-a", "proj-1", "")), DomainError);
});
