import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.env.CONTINUITY_MODE ?? "pro";
const entries = { pro: "../dist/src/project-reader/pro.js", reader: "../dist/src/project-reader/mcp.js", plus: "../dist/src/main.js" };
if (!Object.hasOwn(entries, mode)) {
  process.stderr.write("CONTINUITY_MODE must be pro, reader or plus\n");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL(entries[mode], import.meta.url))], { stdio: "inherit", windowsHide: true });
  child.on("error", () => { process.stderr.write("Mode startup failed\n"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
}
