// A host load sample (M2 flake reruns and host parks): /proc/loadavg and /proc/meminfo as a typed value, and
// the busy / clear predicates over it. The parsers are pure; readHostSample is the one impure edge.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export type HostSample = Readonly<{ load1: number; cpus: number; memTotalKb: number; memAvailableKb: number }>;

// UNMEASURED DEFAULTS: these thresholds are starting points, not measurements. Revisit with arc data.
/** Busy at or above this many runnable tasks per cpu. */
export const BUSY_LOAD_PER_CPU = 1.0;
/** Busy below this fraction of MemTotal available. */
export const BUSY_MEM_AVAILABLE_FRACTION = 0.05;
/** Clear below this many runnable tasks per cpu (a gap to busy is deliberate: neither, so a wait does not flap). */
export const CLEAR_LOAD_PER_CPU = 0.7;

/** The 1-minute load average from the text of /proc/loadavg. */
export function parseLoadavg(text: string): number {
  const first = text.trim().split(/\s+/)[0];
  const load = Number(first);
  if (first === undefined || first === '' || !Number.isFinite(load) || load < 0) throw new Error(`loadavg: no 1-minute load in ${JSON.stringify(text)}`);
  return load;
}

/** MemTotal and MemAvailable in kB from the text of /proc/meminfo. */
export function parseMeminfo(text: string): Readonly<{ memTotalKb: number; memAvailableKb: number }> {
  const field = (name: string): number => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (m === null) throw new Error(`meminfo: no ${name} line`);
    return Number(m[1]);
  };
  const memTotalKb = field('MemTotal');
  if (memTotalKb <= 0) throw new Error('meminfo: MemTotal is not positive');
  return { memTotalKb, memAvailableKb: field('MemAvailable') };
}

export function readHostSample(): HostSample {
  return {
    load1: parseLoadavg(readFileSync('/proc/loadavg', 'utf8')),
    cpus: availableParallelism(),
    ...parseMeminfo(readFileSync('/proc/meminfo', 'utf8')),
  };
}

export const isBusy = (s: HostSample): boolean => s.load1 / s.cpus >= BUSY_LOAD_PER_CPU || s.memAvailableKb < s.memTotalKb * BUSY_MEM_AVAILABLE_FRACTION;

export const isClear = (s: HostSample): boolean => s.load1 / s.cpus < CLEAR_LOAD_PER_CPU;
