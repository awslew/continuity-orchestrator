import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validationEnvironment } from "./editor.js";

const exec = promisify(execFile);
/** One entry per changed path. `text` keeps the private checkpoint readable and
 * reviewable; `bytes` is the exact base64 source, so rollback restores the
 * original encoding and BOM. Untouched files are never rewritten, so they need
 * no backup: these checkpoints never commit, reset or clean the user's repo. */
export type CheckpointEntry = { text: string | null; bytes: string; encoding: string | null };
export type CheckpointFiles = Record<string, CheckpointEntry | null>;
export const checkpointEntry = (serialized: string, encoding: string | null, text: string | null): CheckpointEntry =>
  ({ text, bytes: serialized.slice(1), encoding });
// These private Git repositories, never the user's index, branches or hooks.
async function git(root: string, args: string[]) {
  const env = { ...validationEnvironment(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  return (await exec("git", ["-C", root, "-c", "core.autocrlf=false", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "user.name=Continuity", "-c", "user.email=continuity@localhost.invalid", ...args], { env, windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}
export async function checkpoint(stateDir: string, id: string, before: CheckpointFiles, after: CheckpointFiles) {
  const repository = join(stateDir, "checkpoints", id);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--template="]);
  const commit = async (files: CheckpointFiles, message: string) => {
    const file = await open(join(repository, "snapshot.json"), "w", 0o600);
    try { await file.writeFile(JSON.stringify(files)); await file.sync(); } finally { await file.close(); }
    await git(repository, ["add", "--", "snapshot.json"]);
    await git(repository, ["commit", "--allow-empty", "-m", message]);
    return git(repository, ["rev-parse", "HEAD"]);
  };
  return { repository, before_commit: await commit(before, "Original working files including uncommitted edits"), candidate_commit: await commit(after, "Candidate files; application status is in tasks.json") };
}
export async function readCheckpoint(repository: string, commit: string): Promise<CheckpointFiles> {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid checkpoint revision");
  return JSON.parse(await git(repository, ["show", `${commit}:snapshot.json`]));
}
export async function audit(stateDir: string, event: Record<string, unknown>) {
  const path = join(stateDir, "audit.jsonl");
  try { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Invalid audit file"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const file = await open(path, "a", 0o600);
  try { await file.writeFile(JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n"); await file.sync(); } finally { await file.close(); }
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
