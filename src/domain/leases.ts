import { randomUUID } from "node:crypto";
import { clone } from "./canonical.js";
import { fail } from "./errors.js";
import type { Lease } from "./types.js";

export interface LeaseClock {
  now(): Date;
}

const systemClock: LeaseClock = { now: () => new Date() };

function at(clock: LeaseClock): string {
  return clock.now().toISOString();
}

function isExpired(lease: Lease, clock: LeaseClock): boolean {
  return Date.parse(lease.expiresAt) <= clock.now().getTime();
}

export class LeaseManager {
  private taskLeases = new Map<string, Lease>();
  private workspaceLocks = new Map<string, Lease>();

  acquireTask(taskId: string, owner: string, ttlMs: number, clock: LeaseClock = systemClock): Lease {
    return this.acquire(this.taskLeases, `task:${taskId}`, owner, ttlMs, clock);
  }

  acquireWorkspace(workspaceId: string, owner: string, ttlMs: number, clock: LeaseClock = systemClock): Lease {
    return this.acquire(this.workspaceLocks, `workspace:${workspaceId}`, owner, ttlMs, clock);
  }

  renewTask(taskId: string, token: string, ttlMs: number, clock: LeaseClock = systemClock): Lease {
    return this.renew(this.taskLeases, `task:${taskId}`, token, ttlMs, clock);
  }

  renewWorkspace(workspaceId: string, token: string, ttlMs: number, clock: LeaseClock = systemClock): Lease {
    return this.renew(this.workspaceLocks, `workspace:${workspaceId}`, token, ttlMs, clock);
  }

  releaseTask(taskId: string, token: string, clock: LeaseClock = systemClock): void {
    this.release(this.taskLeases, `task:${taskId}`, token, clock);
  }

  releaseWorkspace(workspaceId: string, token: string, clock: LeaseClock = systemClock): void {
    this.release(this.workspaceLocks, `workspace:${workspaceId}`, token, clock);
  }

  getTask(taskId: string): Lease | null {
    const lease = this.taskLeases.get(`task:${taskId}`);
    return lease ? clone(lease) : null;
  }

  getWorkspace(workspaceId: string): Lease | null {
    const lease = this.workspaceLocks.get(`workspace:${workspaceId}`);
    return lease ? clone(lease) : null;
  }

  isValid(lease: Lease | null, owner?: string, token?: string, clock: LeaseClock = systemClock): boolean {
    return Boolean(lease && !isExpired(lease, clock) && (owner === undefined || lease.owner === owner) && (token === undefined || lease.token === token));
  }

  private acquire(map: Map<string, Lease>, key: string, owner: string, ttlMs: number, clock: LeaseClock): Lease {
    if (!owner || !Number.isFinite(ttlMs) || ttlMs <= 0) fail("LEASE_EXPIRED", "Lease owner and positive ttl are required");
    const existing = map.get(key);
    if (existing && !isExpired(existing, clock)) {
      fail("LEASE_HELD", `${key} is held by ${existing.owner}`, { owner: existing.owner, expiresAt: existing.expiresAt });
    }
    const acquiredAt = at(clock);
    const lease: Lease = { owner, acquiredAt, expiresAt: new Date(clock.now().getTime() + ttlMs).toISOString(), token: randomUUID() };
    map.set(key, lease);
    return clone(lease);
  }

  private renew(map: Map<string, Lease>, key: string, token: string, ttlMs: number, clock: LeaseClock): Lease {
    const existing = map.get(key);
    if (!existing || existing.token !== token) fail("LEASE_NOT_HELD", `${key} is not held by this token`);
    if (isExpired(existing, clock)) fail("LEASE_EXPIRED", `${key} lease has expired`);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail("LEASE_EXPIRED", "Lease ttl must be positive");
    existing.expiresAt = new Date(clock.now().getTime() + ttlMs).toISOString();
    return clone(existing);
  }

  private release(map: Map<string, Lease>, key: string, token: string, clock: LeaseClock): void {
    const existing = map.get(key);
    if (!existing || existing.token !== token) fail("LEASE_NOT_HELD", `${key} is not held by this token`);
    if (isExpired(existing, clock)) {
      map.delete(key);
      fail("LEASE_EXPIRED", `${key} lease has expired`);
    }
    map.delete(key);
  }
}

export function leaseIsExpired(lease: Lease, clock: LeaseClock = systemClock): boolean {
  return isExpired(lease, clock);
}
