import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve a path and enforce that it stays below the declared root. */
export function resolveWithinRoot(rootDir: string, target: string): string {
  if (!rootDir || !target || target.includes("\u0000")) {
    throw new DomainError("PATH_OUTSIDE_ROOT", "Root and target paths are required");
  }
  const root = resolve(rootDir);
  const resolved = resolve(root, target);
  if (!pathInside(root, resolved)) {
    throw new DomainError("PATH_OUTSIDE_ROOT", `Path escapes root: ${target}`, { root, target: resolved });
  }
  return resolved;
}

export function assertWithinRoot(rootDir: string, target: string): string {
  return resolveWithinRoot(rootDir, target);
}

export interface AtomicWriteOptions {
  rootDir?: string;
  mode?: number;
}

/** Atomic UTF-8 replacement. The temporary file is created beside the target and never exposed as state. */
export function atomicWriteText(rootDir: string, target: string, content: string, mode = 0o600): string {
  const targetPath = resolveWithinRoot(rootDir, target);
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = resolve(parent, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  if (!pathInside(resolve(rootDir), tempPath)) throw new DomainError("PATH_OUTSIDE_ROOT", "Temporary path escaped root");
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx", mode });
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return targetPath;
}

export function atomicWriteJson(rootDir: string, target: string, value: unknown, mode = 0o600): string {
  return atomicWriteText(rootDir, target, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Convenience form for callers that already have a file path. The default root is its containing directory. */
export function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): string {
  const root = options.rootDir ?? dirname(resolve(filePath));
  const target = options.rootDir ? filePath : basename(filePath);
  return atomicWriteJson(root, target, value, options.mode ?? 0o600);
}

export function readText(rootDir: string, target: string): string {
  return readFileSync(resolveWithinRoot(rootDir, target), "utf8");
}

export function readJson<T>(rootDir: string, target: string): T {
  const text = readText(rootDir, target);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Malformed JSON at ${resolveWithinRoot(rootDir, target)}: ${String(error)}`);
  }
}

export function fileExists(rootDir: string, target: string): boolean {
  return existsSync(resolveWithinRoot(rootDir, target));
}
