/**
 * Allowlist for the single externally visible Continuity App (plan §8.3.6).
 *
 * Paths, executors, actions and confirmations are enum- or registry-driven.
 * Web input never supplies arbitrary shells, URLs, absolute paths or unknown
 * identifiers; anything not registered here is rejected before dispatch.
 */

import { isAbsolute, join, normalize, sep } from "node:path";
import { DomainError } from "../domain/errors.js";

/** Executors that may be named by web-facing tools. `luna` is deliberately absent. */
export const ALLOWED_EXECUTORS = ["claude", "dsh", "bridge-dsh"] as const;
export type AllowedExecutor = (typeof ALLOWED_EXECUTORS)[number];

/** Patch executors additionally allow the local Codex executor. */
export const ALLOWED_PATCH_EXECUTORS = ["codex", "dsh", "bridge-dsh"] as const;
export type AllowedPatchExecutor = (typeof ALLOWED_PATCH_EXECUTORS)[number];

export const WORKER_CONTROL_ACTIONS = ["continue", "steer", "interrupt", "accept"] as const;
export type WorkerControlActionName = (typeof WORKER_CONTROL_ACTIONS)[number];

export const WEB_SESSION_ACTIONS = ["create", "attach", "send", "read", "stop"] as const;
export type WebSessionAction = (typeof WEB_SESSION_ACTIONS)[number];

/** Secure MCP Tunnel permission levels. Manage never enters runtime configuration. */
export const TUNNEL_PERMISSIONS = ["Read", "Use"] as const;
export type TunnelPermission = (typeof TUNNEL_PERMISSIONS)[number];

export interface WorkspaceRegistration {
  /** Logical workspace name used by tools; never a raw path. */
  workspaceId: string;
  /** Absolute repository root on disk. */
  root: string;
}

export class Allowlist {
  private readonly workspaces = new Map<string, WorkspaceRegistration>();
  private readonly taskIds = new Set<string>();
  private readonly attemptIds = new Set<string>();
  private readonly patchTaskIds = new Set<string>();

  registerWorkspace(registration: WorkspaceRegistration): void {
    if (!registration.workspaceId || registration.workspaceId.includes("/") || registration.workspaceId.includes("\\")) {
      throw new DomainError("RED_FLAGGED_INPUT", "workspaceId must be a logical identifier without path separators");
    }
    if (!isAbsolute(registration.root)) {
      throw new DomainError("RED_FLAGGED_INPUT", "workspace root must be an absolute path");
    }
    this.workspaces.set(registration.workspaceId, { workspaceId: registration.workspaceId, root: registration.root });
  }

  registerTaskId(taskId: string): void {
    assertLogicalId(taskId, "task_id");
    this.taskIds.add(taskId);
  }

  registerAttemptId(attemptId: string): void {
    assertLogicalId(attemptId, "attempt_id");
    this.attemptIds.add(attemptId);
  }

  registerPatchTaskId(patchTaskId: string): void {
    assertLogicalId(patchTaskId, "patch_task_id");
    this.patchTaskIds.add(patchTaskId);
  }

  hasTaskId(taskId: string): boolean {
    return this.taskIds.has(taskId);
  }

  hasAttemptId(attemptId: string): boolean {
    return this.attemptIds.has(attemptId);
  }

  hasPatchTaskId(patchTaskId: string): boolean {
    return this.patchTaskIds.has(patchTaskId);
  }

  workspaceRoot(workspaceId: string): string {
    const registration = this.workspaces.get(workspaceId);
    if (!registration) throw new DomainError("RED_FLAGGED_INPUT", `workspace ${workspaceId} is not registered`);
    return registration.root;
  }

  /**
   * Resolve a tool-supplied workspace-relative path against a registered root.
   * Absolute paths, drive letters, URL schemes, parent traversal and NUL bytes
   * are rejected; the result is guaranteed to stay inside the root.
   */
  resolveWorkspacePath(workspaceId: string, relativePath: string): string {
    const root = this.workspaceRoot(workspaceId);
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new DomainError("RED_FLAGGED_INPUT", "path must be a non-empty workspace-relative string");
    }
    if (relativePath.includes("\u0000")) throw new DomainError("PATH_OUTSIDE_ROOT", "path contains a NUL byte");
    if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
      throw new DomainError("PATH_OUTSIDE_ROOT", "absolute paths are not accepted from callers");
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(relativePath)) {
      throw new DomainError("PATH_OUTSIDE_ROOT", "URL-like paths are not accepted from callers");
    }
    const normalized = normalize(join(root, relativePath));
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (normalized !== root && !normalized.startsWith(rootWithSep)) {
      throw new DomainError("PATH_OUTSIDE_ROOT", "resolved path escapes the registered workspace");
    }
    return normalized;
  }

  assertAllowedExecutor(executor: string): asserts executor is AllowedExecutor {
    if (!(ALLOWED_EXECUTORS as readonly string[]).includes(executor)) {
      throw new DomainError("RED_FLAGGED_INPUT", `executor ${executor} is not allowlisted`);
    }
  }

  assertAllowedPatchExecutor(executor: string): asserts executor is AllowedPatchExecutor {
    if (!(ALLOWED_PATCH_EXECUTORS as readonly string[]).includes(executor)) {
      throw new DomainError("RED_FLAGGED_INPUT", `patch executor ${executor} is not allowlisted`);
    }
  }

  assertAllowedWorkerControlAction(action: string): asserts action is WorkerControlActionName {
    if (!(WORKER_CONTROL_ACTIONS as readonly string[]).includes(action)) {
      throw new DomainError("RED_FLAGGED_INPUT", `worker control action ${action} is not allowlisted`);
    }
  }

  assertAllowedWebSessionAction(action: string): asserts action is WebSessionAction {
    if (!(WEB_SESSION_ACTIONS as readonly string[]).includes(action)) {
      throw new DomainError("RED_FLAGGED_INPUT", `web session action ${action} is not allowlisted`);
    }
  }

  assertRegisteredTaskId(taskId: string): void {
    if (!this.hasTaskId(taskId)) throw new DomainError("RED_FLAGGED_INPUT", `task ${taskId} is not registered in this app`);
  }

  assertRegisteredAttemptId(attemptId: string): void {
    if (!this.hasAttemptId(attemptId)) throw new DomainError("RED_FLAGGED_INPUT", `attempt ${attemptId} is not registered in this app`);
  }

  assertRegisteredPatchTaskId(patchTaskId: string): void {
    if (!this.hasPatchTaskId(patchTaskId)) throw new DomainError("RED_FLAGGED_INPUT", `patch task ${patchTaskId} is not registered in this app`);
  }

  /** Tunnel permissions snapshot; Manage is rejected wherever it appears. */
  static parseTunnelPermissions(value: unknown): TunnelPermission[] {
    if (!Array.isArray(value)) throw new DomainError("RED_FLAGGED_INPUT", "tunnel permissions must be an array");
    const permissions: TunnelPermission[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !(TUNNEL_PERMISSIONS as readonly string[]).includes(entry)) {
        throw new DomainError("RED_FLAGGED_INPUT", `tunnel permission ${String(entry)} is not allowlisted for runtime; Manage never enters runtime configuration`);
      }
      if (!permissions.includes(entry as TunnelPermission)) permissions.push(entry as TunnelPermission);
    }
    return permissions;
  }
}

function assertLogicalId(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.includes("\u0000") || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new DomainError("RED_FLAGGED_INPUT", `${label} must be a non-empty logical identifier`);
  }
}
