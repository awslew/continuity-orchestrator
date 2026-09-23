import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The supervisor that fronts Pro. It exists because the Tunnel does NOT restart a managed MCP
 * command that dies on its own: measured, with Pro killed and the runtime still up, no new
 * child is ever spawned. Without this, a Pro that dies alone leaves the bridge dead until a
 * human restarts the whole tunnel — so the behaviour below is what keeps that from needing a
 * human, and it is pinned here rather than left to a one-off probe. */
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisor = join(repo, "scripts", "start-pro-local.mjs");

async function standIn(dir: string, name: string, exitCode: number) {
  const entry = join(dir, `${name}.mjs`);
  const counter = join(dir, `${name}.count`);
  await writeFile(entry, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "spawn\\n");\nprocess.exit(${exitCode});\n`);
  return { entry, counter, spawns: () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length : 0) };
}

/** stdin is a pipe that stays OPEN on purpose: Pro treats stdin EOF as a clean shutdown signal
 * (that is how the tunnel stops it), so closing it here would end the child before the
 * supervisor logic being tested ever runs. */
function start(t: test.TestContext, entry: string) {
  const child = spawn(process.execPath, [supervisor, join(repo, "config", "pro.local.json")],
    { env: { ...process.env, CONTINUITY_PRO_ENTRY: entry }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let err = "";
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>(resolve => { child.on("exit", code => resolve(code)); });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  return { child, exited, stderr: () => err };
}

test("Pro is supervised: a crash is restarted, a clean exit is not", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pro-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A clean exit is how Pro says it was asked to stop. Restarting that would resurrect a
  // process the tunnel just shut down.
  const clean = await standIn(dir, "clean", 0);
  const cleanRun = start(t, clean.entry);
  assert.equal(await cleanRun.exited, 0, "the supervisor follows a clean exit instead of overriding it");
  assert.equal(clean.spawns(), 1, "a clean exit must not be restarted");
  assert.doesNotMatch(cleanRun.stderr(), /restarting it in/);

  // A non-zero exit is a process that died on its own, which the tunnel would otherwise leave
  // dead for ever.
  const crash = await standIn(dir, "crash", 1);
  const crashRun = start(t, crash.entry);
  const restarted = await new Promise<boolean>(resolve => {
    const deadline = Date.now() + 20_000;
    const poll = setInterval(async () => {
      if (crash.spawns() >= 2) { clearInterval(poll); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(poll); resolve(false); }
    }, 250);
  });
  assert.equal(restarted, true, "a crashed Pro must be started again without a human");
  assert.match(crashRun.stderr(), /restarting it in \d+s/);
  assert.match(crashRun.stderr(), /does not do this itself/, "the log says why this supervisor exists");
});
