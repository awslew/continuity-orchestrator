import { fileURLToPath } from "node:url";
// An explicit launch argument wins over inherited environment, so the manager
// preflights and stops the same configuration that the child actually uses.
process.env.CONTINUITY_PRO_CONFIG = process.argv[2] ?? fileURLToPath(new URL("../config/pro.local.json", import.meta.url));
const { spawn } = await import("node:child_process");
// Overridable so a probe can exercise this supervisor against a stand-in entry point without
// standing up the real Pro server. Production never sets it.
const entry = process.env.CONTINUITY_PRO_ENTRY ?? fileURLToPath(new URL("../dist/src/project-reader/pro.js", import.meta.url));

/** The tunnel does NOT restart a managed MCP command that dies on its own. Measured: with
 * Pro killed and the runtime still up, `runtimes status` reports process_running=false and no
 * new child is ever spawned. So a Pro that was killed by itself — a crash, a stray exact-PID
 * kill — used to leave the bridge dead until a human restarted the whole tunnel. Supervising
 * it here is what makes that heal on its own.
 *
 * Deliberately slow, and deliberately never final:
 * - Only a NON-ZERO exit restarts. Exit 0 is how Pro says it shut down on purpose (stdin end,
 *   SIGINT/SIGTERM), and fighting that would resurrect a process that was asked to stop.
 * - The first delay is longer than a tunnel teardown takes, so a deliberate `/T` kill removes
 *   THIS supervisor too instead of leaving a fresh Pro orphaned and holding the editor lease
 *   — the state that would otherwise need a human to clear by hand.
 * - The delay then doubles up to a ceiling, so a bad configuration cannot become a hot respawn
 *   loop. It never gives up permanently: the usual reasons a Pro fails to start are transient
 *   (a lease still held by a dying process, a lock directory being reclaimed), and a supervisor
 *   that stops trying turns a self-healing condition into one that needs a human. Every
 *   restart is announced on stderr with the wait it chose.
 * - A run that lasted HEALTHY_MS resets the delay: that was a working server, not a crash.
 * This process deliberately never reads stdin: it shares the child's stdin, and consuming
 * bytes there would corrupt the MCP stream the child is framing. */
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const HEALTHY_MS = 300_000;
let stopping = false;
let child;
let delay = BASE_DELAY_MS;

const start = () => {
  const startedAt = Date.now();
  child = spawn(process.execPath, [entry], { stdio: "inherit", windowsHide: true });
  child.on("error", () => {
    process.stderr.write("Pro startup failed: the Pro entry point could not be started\n");
    stopping = true;
    process.exitCode = 1;
  });
  child.on("exit", code => {
    const uptime = Date.now() - startedAt;
    const failed = (code ?? 1) !== 0;
    if (!failed || stopping) { process.exitCode = code ?? 0; return; }
    if (uptime >= HEALTHY_MS) delay = BASE_DELAY_MS;
    const wait = delay;
    delay = Math.min(delay * 2, MAX_DELAY_MS);
    process.stderr.write(`Pro exited with code ${code ?? 1} after ${Math.round(uptime / 1000)}s; restarting it in ${Math.round(wait / 1000)}s. The tunnel does not do this itself, so this supervisor does: the bridge comes back without anyone restarting the tunnel.\n`);
    setTimeout(start, wait);
  });
};
start();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; child?.kill(signal); });
