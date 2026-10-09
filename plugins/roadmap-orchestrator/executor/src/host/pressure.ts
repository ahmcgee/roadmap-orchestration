// Host cpu pressure (M4b rev 3, RC-10..12; SCHEMAS.md "Rev 3: host pressure"), measured as cpu wait: the time a task
// was runnable but waited for a cpu (the scheduler's `run_delay`, Linux schedstat).
//
// A launch's pressure is its own cpu wait. Its runner (src/runner/runner.ts) reads `/proc/<pid>/task/<tid>/schedstat`
// (field 1: ns on a cpu, field 2: ns runnable and waiting) for every thread of every workload member at each poll, keeps
// each thread's latest reading (`WorkloadCpu`), and writes the totals with the workload's wall time to exit.json
// (`LaunchCpu`). The pressure is wait / max(wall, run + wait), in [0, 1]: for a cpu-bound launch the share of its
// runnable time it waited, for a mostly idle one (a backend call waiting on its API, a hung process) the share of its
// wall time, so a launch that sleeps is never read as starved. A launch shorter than `PRESSURE_MIN_WALL_MS` has no
// pressure (null): its reading is its start-up, which waits on any busy host. Calibration (the plan's "Rev 3
// calibration"): on a 16-cpu host the executor's own test tier at --test-concurrency=8 keeps every launch of 5 s or more
// under 0.14 while the host's PSI `some` runs at 0.4 to 0.5; a cpu-bound probe reads 0.45 at most there, 0.5 to 0.6 under
// the default concurrency's starving, and 0.7 under 4 × cpus busy loops.
//
// The host's pressure is the same ratio over every cpu: `/proc/schedstat` (each `cpu<N>` line's fields 7 and 8, ns run
// and ns waited) read once per scheduler tick into `PressureTicks` (in memory: a restart starts a fresh history), taken
// over the last `HOST_WINDOW_MS`. A host-pressure hold releases once it falls below `PRESSURE_SATURATED`; a flow run's
// inputs bind it as the host's cpu wait now.
//
// A host without schedstat (no `/proc/schedstat`: a kernel built without CONFIG_SCHEDSTATS) is `unavailable`: every
// launch's pressure is null and every pressure rule is off. A file that is present but malformed fails loud.
//
// PSI `/proc/pressure/cpu` is not read: its `some` (the share of wall time during which at least one task waited) is high
// on a many-cpu host whenever anything waits, and it did not separate a healthy busy host from a starving one.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { statOf } from '../contain/proc.ts';
import type { InvocationId } from '../core/ids.ts';
import type { LaunchCpu, ProcIdentity } from '../core/records.ts';

/** At or above this cpu wait (a launch's, a window's, the host's), the cpu is saturated: work ran at under half speed (RC-10). */
export const PRESSURE_SATURATED = 0.5;
/** A launch shorter than this has no pressure: its reading is its start-up (RC-10). */
export const PRESSURE_MIN_WALL_MS = 5_000;
/** A unit's starved runs before it falls back to the handling without pressure (RC-11). */
export const STARVED_MAX = 3;

export const HOST_SCHEDSTAT = '/proc/schedstat';

/** Whether this host reports schedstat cpu wait, as each executor start records it (`executor-started.pressure`). */
export const PRESSURE_AVAILABILITIES = ['available', 'unavailable'] as const;
export type PressureAvailability = (typeof PRESSURE_AVAILABILITIES)[number];

export const pressureAvailability = (path: string = HOST_SCHEDSTAT): PressureAvailability => (existsSync(path) ? 'available' : 'unavailable');

// ---------------------------------------------------------------------------------------------------
// A launch's cpu wait

/** One thread's cumulative scheduler times, ns. */
export type TaskCpu = Readonly<{ runNs: number; waitNs: number }>;

/** `/proc/<pid>/task/<tid>/schedstat`: `<run ns> <wait ns> <timeslices>`; throws on anything else. */
export function parseTaskSchedstat(path: string, text: string): TaskCpu {
  const m = /^(\d+) (\d+) \d+\n?$/.exec(text);
  if (m === null) throw new Error(`${path}: ${JSON.stringify(text)} is not "<run ns> <wait ns> <timeslices>"`);
  return { runNs: Number(m[1]), waitNs: Number(m[2]) };
}

/** A process vanished between listing and reading: ENOENT or ESRCH. */
const vanished = (e: unknown): boolean => ['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '');

/** Each live thread of `pid` with its times, by tid; empty when the process is gone. */
function threadsOf(pid: number): ReadonlyMap<string, TaskCpu> {
  const out = new Map<string, TaskCpu>();
  let tids: string[];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch (e) {
    if (vanished(e)) return out;
    throw e;
  }
  for (const tid of tids) {
    const path = `/proc/${pid}/task/${tid}/schedstat`;
    try {
      out.set(tid, parseTaskSchedstat(path, readFileSync(path, 'utf8')));
    } catch (e) {
      if (!vanished(e)) throw e;
    }
  }
  return out;
}

/** The children of every thread of `pid`; none when it is gone. */
function childrenOf(pid: number): readonly number[] {
  const out: number[] = [];
  let tids: string[];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch (e) {
    if (vanished(e)) return out;
    throw e;
  }
  for (const tid of tids) {
    try {
      for (const c of readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(' ')) if (c !== '') out.push(Number(c));
    } catch (e) {
      if (!vanished(e)) throw e;
    }
  }
  return out;
}

/**
 * A workload's cpu wait as its runner observes it: every thread of every member seen at a poll, each at its latest
 * reading. A thread that ends between two polls keeps the reading of the last one, so the totals are a lower bound.
 */
export class WorkloadCpu {
  readonly #threads = new Map<string, TaskCpu>();

  observe(members: readonly ProcIdentity[]): void {
    for (const m of members) for (const [tid, cpu] of threadsOf(m.pid)) this.#threads.set(`${m.pid}:${m.start}:${tid}`, cpu);
  }

  /**
   * `root` and its live descendants (`/proc/<pid>/task/<tid>/children`), the cheap reading while the child runs: no
   * scan of every process. A descendant reparented away from the tree is missed until the membership scan reads it.
   */
  observeTree(root: ProcIdentity): void {
    const found: ProcIdentity[] = [];
    const queue = [root.pid];
    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
      const stat = statOf(pid);
      if (stat === null || stat.state === 'Z' || (pid === root.pid && stat.start !== root.start)) continue;
      found.push({ pid, start: stat.start });
      queue.push(...childrenOf(pid));
    }
    this.observe(found);
  }

  /** The totals over `wallMs` (the workload's wall time, spawn to quiescence). */
  total(wallMs: number): LaunchCpu {
    let run = 0;
    let wait = 0;
    for (const t of this.#threads.values()) {
      run += t.runNs;
      wait += t.waitNs;
    }
    return { wallMs, runMs: Math.round(run / 1e6), waitMs: Math.round(wait / 1e6) };
  }
}

/** A launch's pressure (see the header): null without a reading or under `PRESSURE_MIN_WALL_MS`. */
export function launchPressure(cpu: LaunchCpu | null): number | null {
  if (cpu === null || cpu.wallMs < PRESSURE_MIN_WALL_MS) return null;
  return cpu.waitMs / Math.max(cpu.wallMs, cpu.runMs + cpu.waitMs);
}

/**
 * RC-11 (charging, step H2): a lane run or stage invocation ended by `deadline` or `stall` whose pressure is at least
 * `PRESSURE_SATURATED` is starved: no product verdict, not chargeable, no fix round. `inv` is the run, `pressure` its own.
 */
export type Starved = Readonly<{ kind: 'starved'; inv: InvocationId; pressure: number }>;

// ---------------------------------------------------------------------------------------------------
// The host's cpu wait, per scheduler tick

/** One reading of `/proc/schedstat`: the wall time (ms since the epoch) and the ns run and waited, summed over cpus. */
export type PressureTick = Readonly<{ atMs: number; runNs: number; waitNs: number }>;

/** `/proc/schedstat`'s totals over its `cpu<N>` lines (version 15 or later: fields 7 and 8); throws on anything else. */
export function parseHostSchedstat(text: string): Readonly<{ runNs: number; waitNs: number }> {
  const version = /^version (\d+)$/m.exec(text);
  if (version === null || Number(version[1]) < 15) throw new Error(`${HOST_SCHEDSTAT}: no "version" line of 15 or later in ${JSON.stringify(text.slice(0, 200))}`);
  let runNs = 0;
  let waitNs = 0;
  let cpus = 0;
  for (const line of text.split('\n')) {
    if (!/^cpu\d+ /.test(line)) continue;
    const f = line.split(' ');
    const [run, wait] = [f[7], f[8]];
    if (run === undefined || wait === undefined || !/^\d+$/.test(run) || !/^\d+$/.test(wait)) throw new Error(`${HOST_SCHEDSTAT}: ${JSON.stringify(line)} has no run and wait ns`);
    runNs += Number(run);
    waitNs += Number(wait);
    cpus++;
  }
  if (cpus === 0) throw new Error(`${HOST_SCHEDSTAT}: no cpu line in ${JSON.stringify(text.slice(0, 200))}`);
  return { runNs, waitNs };
}

/** `path` read as the host's schedstat at wall time `atMs`; `unavailable` when the file is absent. */
export function readHostCpuAt(path: string, atMs: number): PressureTick | 'unavailable' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'unavailable';
    throw e;
  }
  return { atMs, ...parseHostSchedstat(text) };
}

export const readHostCpu = (): PressureTick | 'unavailable' => readHostCpuAt(HOST_SCHEDSTAT, Date.now());

/** How long the ticks are kept: the longest span a pressure rule reads (the starved hold's 30-min bound, RC-11). */
export const PRESSURE_TICKS_MS = 30 * 60_000;
/** The span the host's pressure is taken over. */
export const HOST_WINDOW_MS = 60_000;

/** The scheduler's per-tick readings, newest last, pruned to `PRESSURE_TICKS_MS`; empty on a host without schedstat. */
export class PressureTicks {
  readonly #ticks: PressureTick[] = [];

  record(tick: PressureTick | 'unavailable'): void {
    if (tick === 'unavailable') return;
    const last = this.#ticks.at(-1);
    if (last !== undefined && (tick.runNs < last.runNs || tick.waitNs < last.waitNs)) {
      throw new Error(`${HOST_SCHEDSTAT}: the totals went back from ${JSON.stringify(last)} to ${JSON.stringify(tick)}`);
    }
    this.#ticks.push(tick);
    while ((this.#ticks[0] as PressureTick).atMs < tick.atMs - PRESSURE_TICKS_MS) this.#ticks.shift();
  }

  ticks(): readonly PressureTick[] {
    return [...this.#ticks];
  }
}

/**
 * The host's pressure over the last `HOST_WINDOW_MS` of the ticks taken at or after `sinceMs`: waited / (run + waited)
 * between the newest tick and the latest one at least the window before it. Null when those ticks span less.
 */
export function hostPressure(ticks: readonly PressureTick[], sinceMs: number): number | null {
  const newest = ticks.at(-1);
  if (newest === undefined) return null;
  const start = ticks.findLast((t) => t.atMs >= sinceMs && t.atMs <= newest.atMs - HOST_WINDOW_MS);
  if (start === undefined) return null;
  const run = newest.runNs - start.runNs;
  const wait = newest.waitNs - start.waitNs;
  return run + wait === 0 ? 0 : wait / (run + wait);
}

// ---------------------------------------------------------------------------------------------------
// Charging (RC-11, step H2): pure over a run's end, its pressure and the unit's pressure holds

/** How long a host-pressure hold waits at most for the host's pressure to fall below `PRESSURE_SATURATED`. */
export const STARVED_HOLD_MS = 30 * 60_000;

/**
 * How a run ended, as the charging rules read it: killed by its runner's `deadline` or `stall` watchdog (its exit
 * cause), red on its own (a lane that failed), or anything else (a pass, a signal, a lost runner).
 */
export const PRESSURE_RUN_ENDS = ['deadline', 'stall', 'red', 'other'] as const;
export type PressureRunEnd = (typeof PRESSURE_RUN_ENDS)[number];
export type PressureRun = Readonly<{ inv: InvocationId; end: PressureRunEnd; pressure: number | null }>;

/**
 * A unit's host-pressure holds as the fold derives them: how many it has had (`STARVED_MAX` bounds them), and whether
 * the attempt being read is the rerun after one (its latest hold was host-pressure, with no decision since).
 */
export type PressureHolds = Readonly<{ count: number; rerun: boolean }>;

/**
 * What a stage records for its runs. `starved`: a run its deadline or stall watchdog ended at or above
 * `PRESSURE_SATURATED` (no verdict, uncharged, held). `red-rerun`: a red run at or above it, not itself the rerun after
 * a hold (held, then rerun once; only the rerun's verdict counts). `counts`: today's handling: no pressure (null: no
 * schedstat, or a run under `PRESSURE_MIN_WALL_MS`), a clear run, a rerun's red, or a unit with `STARVED_MAX` holds
 * behind it.
 */
export type PressureRuling = Starved | Readonly<{ kind: 'red-rerun'; inv: InvocationId; pressure: number }> | Readonly<{ kind: 'counts' }>;

/** The ruling over `runs` (a lane record's counted run first, then the run attached to it; a call's single run). */
export function pressureRuling(runs: readonly PressureRun[], holds: PressureHolds): PressureRuling {
  if (holds.count >= STARVED_MAX) return { kind: 'counts' };
  const hot = runs.filter((r): r is PressureRun & Readonly<{ pressure: number }> => r.pressure !== null && r.pressure >= PRESSURE_SATURATED);
  const starved = hot.find((r) => r.end === 'deadline' || r.end === 'stall');
  if (starved !== undefined) return { kind: 'starved', inv: starved.inv, pressure: starved.pressure };
  const red = hot.find((r) => r.end === 'red');
  if (red !== undefined && !holds.rerun) return { kind: 'red-rerun', inv: red.inv, pressure: red.pressure };
  return { kind: 'counts' };
}

/** What a hold's release reads: the scheduler's tick history (none in a process without it: status) and the wall time now. */
export type PressureNow = Readonly<{ ticks: readonly PressureTick[]; nowMs: number }>;

/**
 * Whether a host-pressure hold recorded at `heldAtMs` still holds: under `STARVED_HOLD_MS` old, and the host's pressure
 * over the ticks since it is unknown (they span less than `HOST_WINDOW_MS`, as right after a hold or a restart) or at or
 * above `PRESSURE_SATURATED`.
 */
export function pressureHoldWaits(heldAtMs: number, now: PressureNow): boolean {
  if (now.nowMs - heldAtMs >= STARVED_HOLD_MS) return false;
  const host = hostPressure(now.ticks, heldAtMs);
  return host === null || host >= PRESSURE_SATURATED;
}
