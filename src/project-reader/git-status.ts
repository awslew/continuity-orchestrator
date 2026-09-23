import { projectGit } from "./snapshot.js";

export type GitState = { available: true; head: string | null; clean: boolean; status: string } | { available: false; code: string; reason: string };
/** Read-only, bounded status; no hooks, commits or index refresh writes. Missing
 * Git, an unborn repository and a failed command stay distinct so callers can
 * report the real cause instead of one generic failure. */
export async function gitState(root: string): Promise<GitState> {
  try { await projectGit(root, ["rev-parse", "--git-dir"]); }
  catch (error) {
    const text = `${(error as { stderr?: string }).stderr ?? ""}${(error as Error).message}`;
    if (/not a git repository/i.test(text)) return { available: false, code: "GIT_UNAVAILABLE", reason: "No Git repository at this path" };
    if (/dubious ownership/i.test(text)) return { available: false, code: "GIT_UNAVAILABLE", reason: "Git refused this repository due to unsafe ownership; run git config --global --add safe.directory for it" };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: false, code: "GIT_UNAVAILABLE", reason: "Git is not installed or not on PATH" };
    return { available: false, code: "GIT_UNAVAILABLE", reason: "Git command failed; direct source editing with private checkpoints remains available" };
  }
  let head: string | null = null;
  try { head = (await projectGit(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim() || null; } catch { /* Unborn repositories still have useful status. */ }
  try {
    const status = (await projectGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout;
    return { available: true, head, clean: status.length === 0, status };
  } catch (error) {
    if (head === null) return { available: false, code: "GIT_NO_HEAD", reason: "Git repository has no commit yet; the project stays readable and editable with private checkpoints" };
    return { available: false, code: "GIT_UNAVAILABLE", reason: `${(error as Error).message.includes("timeout") ? "Git status timed out" : "Git status failed"}; Git metadata stays untouched` };
  }
}
export async function projectGitStatus(root: string, projectId: string) {
  const state = await gitState(root);
  if (!state.available) return { project_id: projectId, git_available: false, head: null, clean: null, error_code: state.code, reason: state.reason };
  return { project_id: projectId, git_available: true, head: state.head, clean: state.clean, status: state.status, ...(state.head === null ? { error_code: "GIT_NO_HEAD", reason: "Repository has no commit yet" } : {}) };
}
