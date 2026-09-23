/**
 * File-backed stores used by the Wave C runtime assembly.
 *
 * Runtime state is kept below one explicit, canonical root. Every
 * read-modify-write operation takes the root lock, and every replacement is
 * written to a checked temporary file before rename. The lock is bounded and
 * carries an owner/timestamp record; expired records are retained under an
 * auditable stale-lock name instead of being silently deleted.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { resolveWithinRoot } from "./atomic-json.js";
import { sanitizeRuntimeValue } from "../runtime-config.js";
import type { NormalizedQuotaSnapshot } from "../quota/quota-normalizer.js";
import type { HttpTransportSendResult, WebgptDriveHttpStore } from "../adapters/webgpt-drive-http.js";
import type {
  DurablePatchAttemptRecord,
  DurableWorkerAttemptRecord,
  LocalDurableStore,
  LocalPatchReceipt,
  LocalReceiptSink,
  LocalWorkerReceipt
} from "../adapters/local-worker-backends.js";

const WEB_SCHEMA = "continuity.runtime-web-store.v1" as const;
const WORKER_SCHEMA = "continuity.runtime-worker-store.v1" as const;
const RECEIPT_SCHEMA = "continuity.runtime-receipts.v1" as const;
const QUOTA_SCHEMA = "continuity.runtime-quota-store.v1" as const;
const LOCK_SCHEMA = "continuity.runtime-lock.v1" as const;
const LOCK_NAME = ".continuity-runtime.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MAX_LOCK_TIMEOUT_MS = 60_000;
const MAX_STALE_RECOVERY_AGE_MS = 24 * 60 * 60 * 1_000;

export interface RuntimeDurableStoreOptions {
  /** Maximum time spent acquiring the root lock. Never infinite. */
  lockTimeoutMs?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pathError(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("PATH_OUTSIDE_ROOT", message, details);
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsoluteLike(rel));
}

interface RuntimeRoot {
  canonical: string;
}

function canonicalRoot(rootDir: string): RuntimeRoot {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0 || rootDir.includes("\u0000")) throw pathError("runtime store root is required");
  const input = resolve(rootDir);
  try {
    mkdirSync(input, { recursive: true });
    const stat = lstatSync(input);
    if (!stat.isDirectory()) throw pathError("runtime store root is not a directory", { root: input });
    return { canonical: realpathSync.native(input) };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw pathError("runtime store root cannot be canonicalized", { root: input });
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertRootStable(root: RuntimeRoot): void {
  try {
    const current = realpathSync.native(root.canonical);
    const stat = lstatSync(root.canonical);
    if (!stat.isDirectory() || !samePath(current, root.canonical)) throw pathError("runtime store root changed or points through a reparse path", { root: root.canonical, current });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw pathError("runtime store root is unavailable or cannot be verified", { root: root.canonical });
  }
}

/**
 * Check each existing component. Symlinks are rejected rather than followed;
 * junction/reparse components are rejected when their canonical target leaves
 * the root (or when canonical verification is unavailable).
 */
function assertSafePath(root: RuntimeRoot, target: string, allowMissingFinal = true): string {
  assertRootStable(root);
  const resolved = resolve(target);
  if (!inside(root.canonical, resolved)) throw pathError("runtime store path escapes canonical root", { root: root.canonical, target: resolved });
  const rel = relative(root.canonical, resolved);
  if (rel === "") return resolved;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  let current = root.canonical;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    const last = index === parts.length - 1;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOENT" && (last || allowMissingFinal)) return resolved;
      throw pathError("runtime store path cannot be verified", { root: root.canonical, target: current });
    }
    if (stat.isSymbolicLink()) throw pathError("runtime store refuses a symlink/reparse component", { root: root.canonical, target: current });
    let canonical: string;
    try {
      canonical = realpathSync.native(current);
    } catch {
      throw pathError("runtime store cannot canonicalize a path component", { root: root.canonical, target: current });
    }
    if (!inside(root.canonical, canonical)) throw pathError("runtime store path component points outside canonical root", { root: root.canonical, target: current, canonical });
  }
  return resolved;
}

function lockTimeout(options: RuntimeDurableStoreOptions | undefined): number {
  const value = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LOCK_TIMEOUT_MS) throw new DomainError("RED_FLAGGED_INPUT", `runtime durable lock timeout must be an integer between 1 and ${MAX_LOCK_TIMEOUT_MS}`);
  return value;
}

function relativeName(root: RuntimeRoot, filePath: string): string {
  const value = relative(root.canonical, filePath);
  if (!value || isAbsoluteLike(value) || value === ".." || value.startsWith(`..${sep}`)) throw pathError("runtime store file is outside canonical root", { root: root.canonical, target: filePath });
  return value;
}

function safeReadJson<T>(root: RuntimeRoot, target: string): T {
  const filePath = resolveWithinRoot(root.canonical, target);
  assertSafePath(root, filePath, false);
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Unable to read runtime state at ${filePath}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Malformed JSON at ${filePath}: ${String(error)}`);
  }
}

function safeAtomicWriteJson(root: RuntimeRoot, target: string, value: unknown): string {
  const filePath = resolveWithinRoot(root.canonical, target);
  assertSafePath(root, filePath, true);
  const parent = dirname(filePath);
  assertSafePath(root, parent, true);
  mkdirSync(parent, { recursive: true });
  assertSafePath(root, parent, false);
  const tempPath = join(parent, `.${basename(filePath)}.${randomUUID()}.tmp`);
  assertSafePath(root, tempPath, true);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assertSafePath(root, tempPath, false);
    // Verify the rename target immediately before replacement. A target that
    // turns into a link between checks fails closed instead of being followed.
    assertSafePath(root, filePath, true);
    renameSync(tempPath, filePath);
    assertSafePath(root, filePath, false);
    return filePath;
  } finally {
    if (existsSync(tempPath)) {
      assertSafePath(root, tempPath, false);
      unlinkSync(tempPath);
    }
  }
}

interface LockMetadata {
  schemaVersion: typeof LOCK_SCHEMA;
  owner: string;
  pid: number;
  createdAt: string;
  expiresAt: string;
}

function lockPath(root: RuntimeRoot): string {
  return resolveWithinRoot(root.canonical, LOCK_NAME);
}

function readLockMetadata(root: RuntimeRoot): LockMetadata | null {
  const path = lockPath(root);
  const metadataPath = join(path, "owner.json");
  try {
    assertSafePath(root, path, false);
    assertSafePath(root, metadataPath, false);
    const raw = objectRecord(safeReadJson<unknown>(root, relativeName(root, metadataPath)));
    if (raw.schemaVersion !== LOCK_SCHEMA || typeof raw.owner !== "string" || raw.owner.length === 0 || !Number.isSafeInteger(raw.pid) || typeof raw.createdAt !== "string" || typeof raw.expiresAt !== "string") return null;
    if (!Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.expiresAt))) return null;
    return { schemaVersion: LOCK_SCHEMA, owner: raw.owner, pid: raw.pid as number, createdAt: raw.createdAt, expiresAt: raw.expiresAt };
  } catch {
    return null;
  }
}

function sleepBounded(milliseconds: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(1, Math.min(milliseconds, 25)));
}

function tryRecoverStaleLock(root: RuntimeRoot, metadata: LockMetadata | null, now: number): boolean {
  if (!metadata) return false;
  const expiresAt = Date.parse(metadata.expiresAt);
  const createdAt = Date.parse(metadata.createdAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || expiresAt > now || createdAt > now || now - expiresAt > MAX_STALE_RECOVERY_AGE_MS) return false;
  const current = lockPath(root);
  const stale = resolveWithinRoot(root.canonical, `.continuity-runtime.lock.stale.${Date.now().toString(36)}.${randomUUID()}`);
  try {
    assertSafePath(root, current, false);
    assertSafePath(root, stale, true);
    renameSync(current, stale);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(root: RuntimeRoot, timeoutMs: number): () => void {
  const current = lockPath(root);
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    assertRootStable(root);
    assertSafePath(root, current, true);
    try {
      mkdirSync(current);
      assertSafePath(root, current, false);
      const created = new Date().toISOString();
      const metadata: LockMetadata = { schemaVersion: LOCK_SCHEMA, owner, pid: process.pid, createdAt: created, expiresAt: new Date(Date.now() + timeoutMs + MAX_LOCK_TIMEOUT_MS).toISOString() };
      const metadataPath = join(current, "owner.json");
      assertSafePath(root, metadataPath, true);
      writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assertSafePath(root, metadataPath, false);
      return () => releaseLock(root, current, owner);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "EEXIST") {
        // If this process created a lock but could not finish its metadata,
        // leave it visible for an operator rather than deleting unknown state.
        throw error;
      }
      const metadata = readLockMetadata(root);
      if (tryRecoverStaleLock(root, metadata, Date.now())) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      sleepBounded(remaining);
    }
  }
  throw new DomainError("LEASE_HELD", "runtime durable store lock acquisition timed out", { root: root.canonical, timeoutMs });
}

function releaseLock(root: RuntimeRoot, current: string, owner: string): void {
  try {
    const metadata = readLockMetadata(root);
    if (!metadata || metadata.owner !== owner) return;
    assertSafePath(root, current, false);
    rmSync(current, { recursive: true, force: false });
  } catch {
    // A lost/replaced lock is never removed by a different owner. The next
    // acquisition will either observe it as stale or report a bounded fault.
  }
}

function withLock<T>(root: RuntimeRoot, timeoutMs: number, operation: () => T): T {
  const release = acquireLock(root, timeoutMs);
  try {
    return operation();
  } finally {
    release();
  }
}

interface WebStoreState {
  schemaVersion: typeof WEB_SCHEMA;
  chats: Record<string, string>;
  sends: Record<string, HttpTransportSendResult>;
  cursors: Record<string, string>;
}

function emptyWebState(): WebStoreState {
  return { schemaVersion: WEB_SCHEMA, chats: {}, sends: {}, cursors: {} };
}

/** Durable task -> web_chat_id / send receipt / cursor state. */
export class FileWebgptDriveHttpStore implements WebgptDriveHttpStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly root: RuntimeRoot;
  private readonly lockTimeoutMs: number;

  constructor(stateDir: string, fileName = "webgpt-drive.store.json", options: RuntimeDurableStoreOptions = {}) {
    this.root = canonicalRoot(stateDir);
    this.stateDir = this.root.canonical;
    this.filePath = resolveWithinRoot(this.stateDir, fileName);
    assertSafePath(this.root, this.filePath, true);
    this.lockTimeoutMs = lockTimeout(options);
  }

  getChatId(taskId: string): string | null { return this.read().chats[taskId] ?? null; }

  setChatId(taskId: string, chatId: string): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.chats[taskId] = chatId;
      this.write(state);
    });
  }

  getSend(idempotencyKey: string): HttpTransportSendResult | null {
    const value = this.read().sends[idempotencyKey];
    return value ? clone(value) : null;
  }

  setSend(idempotencyKey: string, result: HttpTransportSendResult): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.sends[idempotencyKey] = clone(sanitizeRuntimeValue(result));
      this.write(state);
    });
  }

  getCursor(chatId: string): string | null { return this.read().cursors[chatId] ?? null; }

  setCursor(chatId: string, cursor: string): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.cursors[chatId] = cursor;
      this.write(state);
    });
  }

  private read(): WebStoreState {
    assertSafePath(this.root, this.filePath, true);
    if (!existsSync(this.filePath)) return emptyWebState();
    const raw = objectRecord(safeReadJson<unknown>(this.root, relativeName(this.root, this.filePath)));
    if (raw.schemaVersion !== WEB_SCHEMA) throw new Error(`unsupported runtime web store schema at ${this.filePath}`);
    const chats = objectRecord(raw.chats);
    const sends = objectRecord(raw.sends);
    const cursors = objectRecord(raw.cursors);
    const chatValues: Record<string, string> = {};
    const sendValues: Record<string, HttpTransportSendResult> = {};
    const cursorValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(chats)) if (typeof value === "string") chatValues[key] = value;
    for (const [key, value] of Object.entries(sends)) if (value && typeof value === "object") sendValues[key] = sanitizeRuntimeValue(value) as HttpTransportSendResult;
    for (const [key, value] of Object.entries(cursors)) if (typeof value === "string") cursorValues[key] = value;
    return { schemaVersion: WEB_SCHEMA, chats: chatValues, sends: sendValues, cursors: cursorValues };
  }

  private write(state: WebStoreState): void {
    safeAtomicWriteJson(this.root, relativeName(this.root, this.filePath), sanitizeRuntimeValue(state));
  }
}

interface WorkerStoreState {
  schemaVersion: typeof WORKER_SCHEMA;
  workerAttempts: Record<string, DurableWorkerAttemptRecord>;
  patchAttempts: Record<string, DurablePatchAttemptRecord>;
  patchTasks: Record<string, DurablePatchAttemptRecord>;
  patchReceipts: LocalPatchReceipt[];
}

function emptyWorkerState(): WorkerStoreState {
  return { schemaVersion: WORKER_SCHEMA, workerAttempts: {}, patchAttempts: {}, patchTasks: {}, patchReceipts: [] };
}

function safeWorkerRecord(record: DurableWorkerAttemptRecord): DurableWorkerAttemptRecord {
  return { ...record, receipt: sanitizeRuntimeValue(record.receipt), failure: record.failure ? sanitizeRuntimeValue(record.failure) : null };
}

function safePatchRecord(record: DurablePatchAttemptRecord): DurablePatchAttemptRecord {
  // Keep diff bytes untouched; receipts and diagnostic failures are the
  // persisted surfaces that must not retain credential material.
  return { ...record, receipt: sanitizeRuntimeValue(record.receipt), failure: record.failure ? sanitizeRuntimeValue(record.failure) : null };
}

function safeWorkerState(state: WorkerStoreState): WorkerStoreState {
  const workerAttempts: Record<string, DurableWorkerAttemptRecord> = {};
  const patchAttempts: Record<string, DurablePatchAttemptRecord> = {};
  const patchTasks: Record<string, DurablePatchAttemptRecord> = {};
  for (const [key, record] of Object.entries(state.workerAttempts)) workerAttempts[key] = safeWorkerRecord(record);
  for (const [key, record] of Object.entries(state.patchAttempts)) patchAttempts[key] = safePatchRecord(record);
  for (const [key, record] of Object.entries(state.patchTasks)) patchTasks[key] = safePatchRecord(record);
  return {
    schemaVersion: WORKER_SCHEMA,
    workerAttempts,
    patchAttempts,
    patchTasks,
    patchReceipts: state.patchReceipts.map((receipt) => sanitizeRuntimeValue(receipt))
  };
}

/** Durable LocalWorkerBackend/LocalPatchBackend ledger. */
export class FileLocalDurableStore implements LocalDurableStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly root: RuntimeRoot;
  private readonly lockTimeoutMs: number;

  constructor(stateDir: string, fileName = "worker-runtime.store.json", options: RuntimeDurableStoreOptions = {}) {
    this.root = canonicalRoot(stateDir);
    this.stateDir = this.root.canonical;
    this.filePath = resolveWithinRoot(this.stateDir, fileName);
    assertSafePath(this.root, this.filePath, true);
    this.lockTimeoutMs = lockTimeout(options);
  }

  getWorkerAttempt(idempotencyKey: string): DurableWorkerAttemptRecord | undefined {
    const value = this.read().workerAttempts[idempotencyKey];
    return value ? clone(safeWorkerRecord(value)) : undefined;
  }

  putWorkerAttempt(idempotencyKey: string, record: DurableWorkerAttemptRecord): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.workerAttempts[idempotencyKey] = clone(safeWorkerRecord(record));
      this.write(state);
    });
  }

  listWorkerAttempts(): DurableWorkerAttemptRecord[] {
    return clone(Object.values(this.read().workerAttempts).map(safeWorkerRecord));
  }

  getPatchAttempt(idempotencyKey: string): DurablePatchAttemptRecord | undefined {
    const value = this.read().patchAttempts[idempotencyKey];
    return value ? clone(safePatchRecord(value)) : undefined;
  }

  putPatchAttempt(idempotencyKey: string, record: DurablePatchAttemptRecord): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      const copy = safePatchRecord(record);
      state.patchAttempts[idempotencyKey] = clone(copy);
      if (copy.patchTaskId) state.patchTasks[copy.patchTaskId] = clone(copy);
      this.write(state);
    });
  }

  getPatchTask(patchTaskId: string): DurablePatchAttemptRecord | undefined {
    const value = this.read().patchTasks[patchTaskId];
    return value ? clone(safePatchRecord(value)) : undefined;
  }

  putPatchTask(patchTaskId: string, record: DurablePatchAttemptRecord): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      const copy = safePatchRecord({ ...record, patchTaskId });
      state.patchTasks[patchTaskId] = clone(copy);
      for (const [key, value] of Object.entries(state.patchAttempts)) if (value.patchTaskId === patchTaskId) state.patchAttempts[key] = clone(copy);
      this.write(state);
    });
  }

  findPatchByDiffHash(diffHash: string): DurablePatchAttemptRecord[] {
    const state = this.read();
    const values = [...Object.values(state.patchTasks), ...Object.values(state.patchAttempts)].filter((value) => value.diffHash === diffHash);
    const unique = new Map<string, DurablePatchAttemptRecord>();
    for (const value of values) unique.set(`${value.payloadHash}:${value.patchTaskId ?? ""}`, safePatchRecord(value));
    return clone([...unique.values()]);
  }

  appendPatchReceipt(receipt: LocalPatchReceipt): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.patchReceipts.push(clone(sanitizeRuntimeValue(receipt)));
      this.write(state);
    });
  }

  listPatchReceipts(): LocalPatchReceipt[] { return clone(this.read().patchReceipts.map((receipt) => sanitizeRuntimeValue(receipt))); }

  private read(): WorkerStoreState {
    assertSafePath(this.root, this.filePath, true);
    if (!existsSync(this.filePath)) return emptyWorkerState();
    const raw = objectRecord(safeReadJson<unknown>(this.root, relativeName(this.root, this.filePath)));
    if (raw.schemaVersion !== WORKER_SCHEMA) throw new Error(`unsupported runtime worker store schema at ${this.filePath}`);
    return {
      schemaVersion: WORKER_SCHEMA,
      workerAttempts: objectRecord(raw.workerAttempts) as Record<string, DurableWorkerAttemptRecord>,
      patchAttempts: objectRecord(raw.patchAttempts) as Record<string, DurablePatchAttemptRecord>,
      patchTasks: objectRecord(raw.patchTasks) as Record<string, DurablePatchAttemptRecord>,
      patchReceipts: Array.isArray(raw.patchReceipts) ? raw.patchReceipts.map((item) => sanitizeRuntimeValue(item)) as LocalPatchReceipt[] : []
    };
  }

  private write(state: WorkerStoreState): void { safeAtomicWriteJson(this.root, relativeName(this.root, this.filePath), safeWorkerState(state)); }
}

/** Atomic JSON receipt sink shared by worker and patch adapters. */
export class FileRuntimeReceiptSink implements LocalReceiptSink {
  readonly evidenceDir: string;
  readonly filePath: string;
  private readonly root: RuntimeRoot;
  private readonly lockTimeoutMs: number;

  constructor(evidenceDir: string, fileName = "runtime-receipts.json", options: RuntimeDurableStoreOptions = {}) {
    this.root = canonicalRoot(evidenceDir);
    this.evidenceDir = this.root.canonical;
    this.filePath = resolveWithinRoot(this.evidenceDir, fileName);
    assertSafePath(this.root, this.filePath, true);
    this.lockTimeoutMs = lockTimeout(options);
  }

  append(receipt: LocalWorkerReceipt | LocalPatchReceipt): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      const existing = this.readEnvelope();
      existing.entries.push(clone(sanitizeRuntimeValue(receipt)));
      safeAtomicWriteJson(this.root, relativeName(this.root, this.filePath), { schemaVersion: RECEIPT_SCHEMA, entries: existing.entries });
    });
  }

  list(): Array<LocalWorkerReceipt | LocalPatchReceipt> { return clone(this.readEnvelope().entries); }

  private readEnvelope(): { entries: Array<LocalWorkerReceipt | LocalPatchReceipt> } {
    assertSafePath(this.root, this.filePath, true);
    if (!existsSync(this.filePath)) return { entries: [] };
    const raw = objectRecord(safeReadJson<unknown>(this.root, relativeName(this.root, this.filePath)));
    if (raw.schemaVersion !== RECEIPT_SCHEMA) throw new Error(`unsupported runtime receipt schema at ${this.filePath}`);
    return { entries: Array.isArray(raw.entries) ? raw.entries.map((item) => sanitizeRuntimeValue(item)) as Array<LocalWorkerReceipt | LocalPatchReceipt> : [] };
  }
}

export interface DurableQuotaState {
  snapshot: NormalizedQuotaSnapshot | null;
  /** Sanitized upstream read/updated receipt or null when no sample exists. */
  receipt: unknown | null;
}

interface QuotaStoreState extends DurableQuotaState {
  schemaVersion: typeof QUOTA_SCHEMA;
}

/** Latest account/rateLimits sample and its redacted upstream receipt. */
export class FileQuotaStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly root: RuntimeRoot;
  private readonly lockTimeoutMs: number;

  constructor(stateDir: string, fileName = "quota-runtime.store.json", options: RuntimeDurableStoreOptions = {}) {
    this.root = canonicalRoot(stateDir);
    this.stateDir = this.root.canonical;
    this.filePath = resolveWithinRoot(this.stateDir, fileName);
    assertSafePath(this.root, this.filePath, true);
    this.lockTimeoutMs = lockTimeout(options);
  }

  get(): DurableQuotaState {
    assertSafePath(this.root, this.filePath, true);
    if (!existsSync(this.filePath)) return { snapshot: null, receipt: null };
    const raw = objectRecord(safeReadJson<unknown>(this.root, relativeName(this.root, this.filePath)));
    if (raw.schemaVersion !== QUOTA_SCHEMA) throw new Error(`unsupported runtime quota schema at ${this.filePath}`);
    return {
      snapshot: raw.snapshot && typeof raw.snapshot === "object" && !Array.isArray(raw.snapshot) ? sanitizeRuntimeValue(raw.snapshot) as NormalizedQuotaSnapshot : null,
      receipt: raw.receipt === null || raw.receipt === undefined ? null : sanitizeRuntimeValue(raw.receipt)
    };
  }

  set(snapshot: NormalizedQuotaSnapshot, receipt: unknown): void {
    withLock(this.root, this.lockTimeoutMs, () => {
      safeAtomicWriteJson(this.root, relativeName(this.root, this.filePath), {
        schemaVersion: QUOTA_SCHEMA,
        snapshot: sanitizeRuntimeValue(snapshot),
        receipt: sanitizeRuntimeValue(receipt)
      });
    });
  }
}

const RELAY_SCHEMA = "continuity.runtime-relay-store.v1" as const;
/** Bounded idempotency replay window; the oldest entries are evicted first. */
const MAX_RELAY_ENVELOPES = 2_000;

/**
 * Server-level state that used to live only in `ContinuityMcpServer`'s process
 * memory: proposed patches and the mutation-idempotency replay store.  Both are
 * cross-restart concerns — a validated patch must still be applicable after the
 * MCP process dies, and an idempotency key must still replay its original
 * receipt instead of silently executing twice.
 *
 * Handoff manifests are deliberately NOT stored here: `handoff.md` is the
 * Markdown source of truth (README "Experimental Plus lifecycle contract") and
 * the manifest is rebuilt from it, so a sidecar can never repair a missing or
 * incomplete document.
 */
export interface RelayPatchRecord {
  patchTaskId: string;
  taskId: string;
  executor: string;
  baseHead: string;
  changeRequest: Record<string, unknown>;
  /** Ledger revision of the parent task at propose time; apply/commit re-verify it. */
  proposedRevision: number;
  diff: string | null;
  verdict: "PASS" | "FAIL" | "INCOMPLETE" | null;
  applied: boolean;
  committed: boolean;
}

export interface RelayEnvelopeRecord {
  key: string;
  tool: string;
  payloadHash: string;
  envelope: unknown;
  at: string;
}

/**
 * The supervised worker attempt registry.  `continuity_worker_control` only
 * receives an `attempt_id`, so the parent task, the routing kind and the
 * control revision all have to be recoverable from durable state rather than
 * remembered in the process that started the worker.
 */
export interface RelayAttemptRecord {
  attemptId: string;
  taskId: string;
  workerKind: string;
  source: string;
  continuation: string;
  /** WorkerStatus of the supervised attempt. */
  status: string;
  revision: number;
  terminal: boolean;
}

export interface RelayServerStore {
  getPatch(patchTaskId: string): RelayPatchRecord | undefined;
  putPatch(record: RelayPatchRecord): void;
  listPatches(): RelayPatchRecord[];
  getEnvelope(key: string, tool: string): RelayEnvelopeRecord | undefined;
  putEnvelope(record: RelayEnvelopeRecord): void;
  listEnvelopes(): RelayEnvelopeRecord[];
  getAttempt(attemptId: string): RelayAttemptRecord | undefined;
  putAttempt(record: RelayAttemptRecord): void;
  listAttempts(): RelayAttemptRecord[];
}

interface RelayStoreState {
  schemaVersion: typeof RELAY_SCHEMA;
  patches: Record<string, RelayPatchRecord>;
  envelopes: RelayEnvelopeRecord[];
  attempts: Record<string, RelayAttemptRecord>;
}

function emptyRelayState(): RelayStoreState {
  return { schemaVersion: RELAY_SCHEMA, patches: {}, envelopes: [], attempts: {} };
}

function safeRelayPatch(value: unknown): RelayPatchRecord | null {
  const record = objectRecord(value);
  const patchTaskId = typeof record.patchTaskId === "string" && record.patchTaskId.length > 0 ? record.patchTaskId : null;
  const taskId = typeof record.taskId === "string" && record.taskId.length > 0 ? record.taskId : null;
  if (!patchTaskId || !taskId) return null;
  const verdict = record.verdict === "PASS" || record.verdict === "FAIL" || record.verdict === "INCOMPLETE" ? record.verdict : null;
  return {
    patchTaskId,
    taskId,
    executor: typeof record.executor === "string" ? record.executor : "",
    baseHead: typeof record.baseHead === "string" ? record.baseHead : "",
    changeRequest: objectRecord(record.changeRequest),
    proposedRevision: Number.isSafeInteger(record.proposedRevision) ? record.proposedRevision as number : 0,
    diff: typeof record.diff === "string" ? record.diff : null,
    verdict,
    applied: record.applied === true,
    committed: record.committed === true
  };
}

function safeRelayEnvelope(value: unknown): RelayEnvelopeRecord | null {
  const record = objectRecord(value);
  const key = typeof record.key === "string" && record.key.length > 0 ? record.key : null;
  const tool = typeof record.tool === "string" && record.tool.length > 0 ? record.tool : null;
  const payloadHash = typeof record.payloadHash === "string" ? record.payloadHash : null;
  if (!key || !tool || payloadHash === null) return null;
  return {
    key,
    tool,
    payloadHash,
    envelope: sanitizeRuntimeValue(record.envelope),
    at: typeof record.at === "string" ? record.at : ""
  };
}

function safeRelayAttempt(value: unknown): RelayAttemptRecord | null {
  const record = objectRecord(value);
  const attemptId = typeof record.attemptId === "string" && record.attemptId.length > 0 ? record.attemptId : null;
  const taskId = typeof record.taskId === "string" && record.taskId.length > 0 ? record.taskId : null;
  if (!attemptId || !taskId) return null;
  return {
    attemptId,
    taskId,
    workerKind: typeof record.workerKind === "string" ? record.workerKind : "",
    source: typeof record.source === "string" ? record.source : "",
    continuation: typeof record.continuation === "string" ? record.continuation : "",
    status: typeof record.status === "string" ? record.status : "unknown",
    revision: Number.isSafeInteger(record.revision) ? record.revision as number : 0,
    terminal: record.terminal === true
  };
}

/** Durable patch/idempotency store for the relay (Plus) entrypoint. */
export class FileRelayServerStore implements RelayServerStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly root: RuntimeRoot;
  private readonly lockTimeoutMs: number;

  constructor(stateDir: string, fileName = "relay-runtime.store.json", options: RuntimeDurableStoreOptions = {}) {
    this.root = canonicalRoot(stateDir);
    this.stateDir = this.root.canonical;
    this.filePath = resolveWithinRoot(this.stateDir, fileName);
    assertSafePath(this.root, this.filePath, true);
    this.lockTimeoutMs = lockTimeout(options);
  }

  getPatch(patchTaskId: string): RelayPatchRecord | undefined {
    const record = this.read().patches[patchTaskId];
    const safe = record ? safeRelayPatch(record) : null;
    return safe ? clone(safe) : undefined;
  }

  putPatch(record: RelayPatchRecord): void {
    const safe = safeRelayPatch(record);
    if (!safe) throw pathError("relay patch record requires patchTaskId and taskId");
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.patches[safe.patchTaskId] = safe;
      this.write(state);
    });
  }

  listPatches(): RelayPatchRecord[] {
    return clone(Object.values(this.read().patches).map(safeRelayPatch).filter((record): record is RelayPatchRecord => record !== null));
  }

  getEnvelope(key: string, tool: string): RelayEnvelopeRecord | undefined {
    const found = this.read().envelopes.find((entry) => entry && entry.key === key && entry.tool === tool);
    const safe = found ? safeRelayEnvelope(found) : null;
    return safe ? clone(safe) : undefined;
  }

  putEnvelope(record: RelayEnvelopeRecord): void {
    const safe = safeRelayEnvelope(record);
    if (!safe) throw pathError("relay envelope record requires key, tool and payloadHash");
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      // One entry per (key, tool): a replayed key always returns the receipt
      // that was actually produced, never a stale sibling.
      state.envelopes = state.envelopes.filter((entry) => !(entry && entry.key === safe.key && entry.tool === safe.tool));
      state.envelopes.push(safe);
      if (state.envelopes.length > MAX_RELAY_ENVELOPES) {
        state.envelopes = state.envelopes.slice(state.envelopes.length - MAX_RELAY_ENVELOPES);
      }
      this.write(state);
    });
  }

  listEnvelopes(): RelayEnvelopeRecord[] {
    return clone(this.read().envelopes.map(safeRelayEnvelope).filter((record): record is RelayEnvelopeRecord => record !== null));
  }

  getAttempt(attemptId: string): RelayAttemptRecord | undefined {
    const record = this.read().attempts[attemptId];
    const safe = record ? safeRelayAttempt(record) : null;
    return safe ? clone(safe) : undefined;
  }

  putAttempt(record: RelayAttemptRecord): void {
    const safe = safeRelayAttempt(record);
    if (!safe) throw pathError("relay attempt record requires attemptId and taskId");
    withLock(this.root, this.lockTimeoutMs, () => {
      const state = this.read();
      state.attempts[safe.attemptId] = safe;
      this.write(state);
    });
  }

  listAttempts(): RelayAttemptRecord[] {
    return clone(Object.values(this.read().attempts).map(safeRelayAttempt).filter((record): record is RelayAttemptRecord => record !== null));
  }

  private read(): RelayStoreState {
    assertSafePath(this.root, this.filePath, true);
    if (!existsSync(this.filePath)) return emptyRelayState();
    const raw = objectRecord(safeReadJson<unknown>(this.root, relativeName(this.root, this.filePath)));
    if (raw.schemaVersion !== RELAY_SCHEMA) throw new Error(`unsupported runtime relay store schema at ${this.filePath}`);
    return {
      schemaVersion: RELAY_SCHEMA,
      patches: objectRecord(raw.patches) as Record<string, RelayPatchRecord>,
      envelopes: Array.isArray(raw.envelopes) ? raw.envelopes as RelayEnvelopeRecord[] : [],
      attempts: objectRecord(raw.attempts) as Record<string, RelayAttemptRecord>
    };
  }

  private write(state: RelayStoreState): void {
    safeAtomicWriteJson(this.root, relativeName(this.root, this.filePath), {
      schemaVersion: RELAY_SCHEMA,
      patches: state.patches,
      envelopes: state.envelopes,
      attempts: state.attempts
    });
  }
}
