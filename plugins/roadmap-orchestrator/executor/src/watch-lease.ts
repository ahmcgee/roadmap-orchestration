// The actionable watch's durable presence. All claim/stop operations share a kernel mutex; polls and
// clean release are synchronous and identity-checked. A replacement waits for process death before claiming.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBootId, signal as signalProcess } from './contain/proc.ts';
import { atomicJson,durableUnlink,readJson } from './core/fsx.ts';
import type { ArcId } from './core/ids.ts';
import { sha256Hex } from './core/json.ts';
import { type ProcIdentity,type WatchLease,watchLease } from './core/records.ts';
import { type AbsPath,isoTimeOf } from './core/values.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import { isAlive,selfIdentity } from './host/liveness.ts';

export const WATCH_LEASE_FILE = 'watch.lease.json';
/** A live actionable watcher already owns this arc (distinct from usage/refusal/host-busy). */
export const EXIT_WATCH_BUSY = 73;
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
const TERM_WAIT_MS = 10_000;
const KILL_WAIT_MS = 2_000;

export function readWatchLease(runDir: AbsPath): WatchLease | null {
  try {
    return watchLease(readJson(join(runDir, WATCH_LEASE_FILE)), WATCH_LEASE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export type Supervision = Readonly<{ state: 'none' }> | Readonly<{
  state: 'live' | 'stale'; pid: number; lastPollAt: string; executorVersion: string;
}>;
export function supervision(runDir: AbsPath): Supervision {
  const lease = readWatchLease(runDir);
  return lease === null ? { state: 'none' } : {
    state: isAlive(lease, lease.bootId) ? 'live' : 'stale', pid: lease.pid,
    lastPollAt: lease.lastPollAt, executorVersion: lease.executorVersion,
  };
}

const same = (a: ProcIdentity, b: ProcIdentity): boolean => a.pid === b.pid && a.start === b.start;

/** Linux abstract sockets have exclusive bind and disappear on death, including SIGKILL. No helper or lock-file recovery.
 * Canonicalise the run path so symlink spellings and executor versions all use the same mutex. */
async function mutex(runDir: AbsPath): Promise<Server> {
  const path = `\0roadmap-watch-${sha256Hex(realpathSync(runDir))}`;
  const deadline = Date.now() + TERM_WAIT_MS + KILL_WAIT_MS + 5_000;
  for (;;) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => { server.removeListener('error', reject); resolve(); });
      });
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new Error(`watch lease mutex remained busy for ${runDir}`);
      await sleep(25);
    }
  }
}

async function locked<T>(runDir: AbsPath, act: () => Promise<T>): Promise<T> {
  const server = await mutex(runDir);
  try { return await act(); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function terminate(lease: WatchLease): Promise<void> {
  for (const [sig, wait] of [['SIGTERM', TERM_WAIT_MS], ['SIGKILL', KILL_WAIT_MS]] as const) {
    if (!isAlive(lease, lease.bootId)) return;
    signalProcess(lease, sig);
    const deadline = Date.now() + wait;
    while (isAlive(lease, lease.bootId) && Date.now() < deadline) await sleep(25);
  }
  if (isAlive(lease, lease.bootId)) throw new Error(`watch pid ${lease.pid} start ${lease.start} survived SIGKILL`);
}

export type WatchClaim = Readonly<{ kind: 'claimed'; lease: WatchLease }> | Readonly<{ kind: 'busy'; lease: WatchLease }>;
export async function claimWatch(runDir: AbsPath, arc: ArcId, replace: boolean): Promise<WatchClaim> {
  return locked(runDir, async () => {
    const held = readWatchLease(runDir);
    if (held !== null && isAlive(held, held.bootId)) {
      if (!replace) return { kind: 'busy', lease: held };
      await terminate(held);
    }
    const at = isoTimeOf(new Date());
    const lease: WatchLease = {
      v: SCHEMA_VERSION, ...selfIdentity(), bootId: readBootId(), executorVersion: pkg.version, arc,
      startedAt: at, lastPollAt: at, lastSeq: 0,
    };
    atomicJson(join(runDir, WATCH_LEASE_FILE), lease);
    return { kind: 'claimed', lease };
  });
}

/** A poll may only renew its own lease. Losing it while alive is an invariant failure. */
export function pollWatch(runDir: AbsPath, lease: WatchLease, lastSeq: number): void {
  const held = readWatchLease(runDir);
  if (held === null || !same(held, lease)) throw new Error(`watch pid ${lease.pid} lost its lease`);
  atomicJson(join(runDir, WATCH_LEASE_FILE), { ...lease, lastPollAt: isoTimeOf(new Date()), lastSeq });
}

/** Clean exit never removes another watcher's lease. */
export function releaseWatch(runDir: AbsPath, lease: WatchLease): void {
  const held = readWatchLease(runDir);
  if (held !== null && same(held, lease)) durableUnlink(join(runDir, WATCH_LEASE_FILE));
}

export async function stopWatch(runDir: AbsPath): Promise<Readonly<{ event: 'watch-stopped'; state: 'stopped' | 'stale' | 'none'; pid?: number }>> {
  return locked(runDir, async () => {
    const held = readWatchLease(runDir);
    if (held === null) return { event: 'watch-stopped', state: 'none' };
    const live = isAlive(held, held.bootId);
    if (live) await terminate(held);
    releaseWatch(runDir, held);
    return { event: 'watch-stopped', state: live ? 'stopped' : 'stale', pid: held.pid };
  });
}
