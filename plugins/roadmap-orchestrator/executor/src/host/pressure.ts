// Host CPU pressure (M4b rev 3, RC-10..12; SCHEMAS.md "M4b" "Rev 3: host pressure"): Linux PSI `/proc/pressure/cpu`, its
// `some` line. `total` is the cumulative µs during which at least one runnable task waited for a cpu; `avg10` and `avg60`
// the kernel's running percentages over 10 s and 60 s. The executor samples it at each launch's start and end (`invoke`,
// src/pipeline/invoke.ts: the interval lands on the spawn's done record) and once per scheduler tick (`PressureTicks`,
// read by the flow track). A host without PSI (no file, or PSI disabled at boot: the read fails EOPNOTSUPP) is
// `unavailable`: every interval is null and every pressure rule is off. A file that is present but malformed fails loud.
// The parser and the interval are pure; `readPressure` is the impure edge.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { InvocationId } from '../core/ids.ts';

/** At or above this fraction of wall time stalled on cpu (PSI `some`), the host is saturated (RC-10). */
export const PRESSURE_SATURATED = 0.25;
/** A unit's starved runs before it falls back to the handling without pressure (RC-11). */
export const STARVED_MAX = 3;

export const PSI_CPU = '/proc/pressure/cpu';

/** Whether this host reports PSI, as each executor start records it (`executor-started.pressure`). */
export const PRESSURE_AVAILABILITIES = ['available', 'unavailable'] as const;
export type PressureAvailability = (typeof PRESSURE_AVAILABILITIES)[number];

/** The `some` line: `total` in µs (cumulative), `avg10` and `avg60` as fractions in [0, 1]. */
export type PsiSome = Readonly<{ totalUs: number; avg10: number; avg60: number }>;

/** One reading: the `some` line and the monotonic clock when it was read (ms, `performance.now()`). */
export type PressureSample = PsiSome & Readonly<{ atMs: number }>;

/** The `some` line of `/proc/pressure/cpu`'s text; throws on anything else. */
export function parsePsiCpu(text: string): PsiSome {
  const line = text.split('\n').find((l) => l.startsWith('some '));
  if (line === undefined) throw new Error(`${PSI_CPU}: no "some" line in ${JSON.stringify(text)}`);
  const fields = new Map<string, string>();
  for (const kv of line.slice('some '.length).trim().split(/\s+/)) {
    const m = /^([a-z0-9]+)=(.+)$/.exec(kv);
    if (m === null) throw new Error(`${PSI_CPU}: "${kv}" is not key=value in ${JSON.stringify(line)}`);
    fields.set(m[1] as string, m[2] as string);
  }
  const percent = (key: string): number => {
    const raw = fields.get(key);
    const n = Number(raw);
    if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || n > 100) throw new Error(`${PSI_CPU}: ${key}=${raw} is not a percentage in ${JSON.stringify(line)}`);
    return n / 100;
  };
  const rawTotal = fields.get('total');
  if (rawTotal === undefined || !/^\d+$/.test(rawTotal) || !Number.isSafeInteger(Number(rawTotal))) {
    throw new Error(`${PSI_CPU}: total=${rawTotal} is not a µs count in ${JSON.stringify(line)}`);
  }
  return { totalUs: Number(rawTotal), avg10: percent('avg10'), avg60: percent('avg60') };
}

/** The fraction of wall time between two samples during which a task waited for a cpu, in [0, 1]. */
export function intervalPressure(start: PressureSample, end: PressureSample): number {
  const wallUs = (end.atMs - start.atMs) * 1000;
  const stalledUs = end.totalUs - start.totalUs;
  if (!(wallUs > 0)) throw new Error(`pressure interval: end ${end.atMs} ms is not after start ${start.atMs} ms`);
  if (stalledUs < 0) throw new Error(`pressure interval: PSI total went back from ${start.totalUs} to ${end.totalUs} µs`);
  // The kernel's clock and ours are read a few µs apart, so a fully stalled interval can come out a hair above 1.
  return Math.min(1, stalledUs / wallUs);
}

/** The interval over a launch: null when either end is unavailable. */
export const launchPressure = (start: PressureSample | 'unavailable', end: PressureSample | 'unavailable'): number | null =>
  start === 'unavailable' || end === 'unavailable' ? null : intervalPressure(start, end);

/** `path` read as PSI cpu now; `unavailable` when the file is absent or the kernel has PSI disabled (EOPNOTSUPP). */
export function readPressureAt(path: string): PressureSample | 'unavailable' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EOPNOTSUPP') return 'unavailable';
    throw e;
  }
  const atMs = performance.now();
  return { ...parsePsiCpu(text), atMs };
}

export const readPressure = (): PressureSample | 'unavailable' => readPressureAt(PSI_CPU);

export const availabilityOf = (s: PressureSample | 'unavailable'): PressureAvailability => (s === 'unavailable' ? 'unavailable' : 'available');

/**
 * RC-11 (charging, step H2): a lane run or stage invocation ended by `deadline` or `stall` whose interval pressure is at
 * least `PRESSURE_SATURATED` is starved: no product verdict, not chargeable, no fix round. `inv` is the run, `pressure`
 * its interval.
 */
export type Starved = Readonly<{ kind: 'starved'; inv: InvocationId; pressure: number }>;

// ---------------------------------------------------------------------------------------------------
// Per-tick pressure (in memory: a restart starts a fresh history)

/** One scheduler tick's reading: the wall time (ms since the epoch) and the kernel's 60 s average. */
export type PressureTick = Readonly<{ atMs: number; avg60: number }>;

/** How long the ticks are kept: the longest span a pressure rule reads (the starved hold's 30-min bound, RC-11). */
export const PRESSURE_TICKS_MS = 30 * 60_000;

/**
 * The scheduler's per-tick avg60 history, newest last, pruned to `PRESSURE_TICKS_MS`; empty on a host without PSI. The
 * flow track's `host-pressure` trigger and the starved hold read it (`ticks`).
 */
export class PressureTicks {
  readonly #ticks: PressureTick[] = [];

  /** Records one reading taken at wall time `atMs`. */
  record(sample: PressureSample | 'unavailable', atMs: number): void {
    if (sample !== 'unavailable') this.#ticks.push({ atMs, avg60: sample.avg60 });
    while (this.#ticks.length > 0 && (this.#ticks[0] as PressureTick).atMs < atMs - PRESSURE_TICKS_MS) this.#ticks.shift();
  }

  ticks(): readonly PressureTick[] {
    return [...this.#ticks];
  }
}
