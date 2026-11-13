// The executor's heartbeat: `heartbeat.json` in its run dir (`{v, generation, at}`). Its first write is the supervisor's
// readiness signal; then the supervisor's watchdog reads it every HEARTBEAT_CHECK_MS and SIGKILLs the executor once it is
// older than HEARTBEAT_STALE_MS (src/supervisor.ts). It says that the executor's one thread is alive and getting work
// done, and is written from two places:
//   - a timer, every HEARTBEAT_MS, whenever the event loop gets a turn;
//   - `beat()`, at most once per HEARTBEAT_MS, from the points the thread passes while it works without yielding: the
//     return of every git call (src/git/git.ts) and the top of every scheduler iteration (src/schedule/scheduler.ts).
// A long synchronous stretch that keeps completing calls (a tick on a contended host, an apply's recomputation, a
// snapshot) keeps it fresh. A git call that never returns, a stopped process, or a stretch that reaches neither point
// leaves it unwritten, which is what the watchdog is for. Outside an executor (`status`, the console) `beat()` does
// nothing.
import { join } from 'node:path';
import { atomicJson } from '../core/fsx.ts';
import type { Heartbeat } from '../core/records.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';

/** Run dir: the executor's heartbeat; the supervisor reads it (readiness, staleness). */
export const HEARTBEAT_FILE = 'heartbeat.json';
/** The timer's period, and the least time between two writes by `beat()`. */
export const HEARTBEAT_MS = 10_000;

type Beating = { readonly runDir: AbsPath; readonly generation: number; last: number };
/** The heartbeats this process writes: one per executor running in it. */
const beating = new Set<Beating>();

function write(b: Beating): void {
  const file: Heartbeat = { v: SCHEMA_VERSION, generation: b.generation, at: isoTimeOf(new Date()) };
  atomicJson(join(b.runDir, HEARTBEAT_FILE), file);
  b.last = Date.now();
}

/** Writes executor generation `generation`'s first heartbeat now and keeps it beating; returns its stop. */
export function startHeartbeat(runDir: AbsPath, generation: number): () => void {
  const b: Beating = { runDir, generation, last: 0 };
  write(b);
  beating.add(b);
  const timer = setInterval(() => write(b), HEARTBEAT_MS);
  return () => {
    clearInterval(timer);
    beating.delete(b);
  };
}

/** A point of progress on the executor's thread: writes each heartbeat last written HEARTBEAT_MS or more ago. */
export function beat(): void {
  if (beating.size === 0) return;
  const now = Date.now();
  for (const b of beating) if (now - b.last >= HEARTBEAT_MS) write(b);
}
