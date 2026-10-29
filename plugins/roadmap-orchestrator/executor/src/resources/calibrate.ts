// Scheduling costs from completed runner measurements. Keys describe execution, never lane identity or reuse.
// The per-journal reader visits each completed invocation once; a restart rebuilds it from the durable log.
import { type InvocationId, type Sha256Hex, invocationId, sha256 } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { LaneDef, LaunchCpu } from '../core/records.ts';
import { spawnCpuKeyOf, exitCpuOf } from '../core/upgrade.ts';
import type { AbsPath } from '../core/values.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import type { Triple } from '../routing/types.ts';
import { runnerFiles } from '../runner/files.ts';
import type { CpuBasis } from '../core/cpu.ts';
export { type CpuBasis, cpuBasis } from '../core/cpu.ts';

export const CALIBRATION_MIN_WALL_MS = 30_000;
export const CALIBRATION_RUNS = 10;
export const CALIBRATION_MIN_SAMPLES = 3;

export const laneCpuKey = (lane: LaneDef): Sha256Hex => sha256(sha256Hex(canonicalJson({
  kind: 'lane', argv: lane.argv, cwd: lane.cwd, set: lane.env.set, pass: [...lane.env.pass].sort(), expectedExit: lane.expectedExit,
})));
export const buildCpuKey = (triple: Triple): Sha256Hex => sha256(sha256Hex(canonicalJson({ kind: 'build', ...triple })));

/** Nearest-rank p90, rounded up to whole tokens, bounded by the unmeasured default. */
export function calibratedCpu(samples: readonly number[], fallback: number): number {
  if (samples.length < CALIBRATION_MIN_SAMPLES) return fallback;
  const sorted = samples.slice(-CALIBRATION_RUNS).sort((a, b) => a - b);
  return Math.max(1, Math.min(fallback, Math.ceil(sorted[Math.ceil(sorted.length * 0.9) - 1] as number)));
}

/** Demand in cores, ignoring startup-sized runs and hosts without schedstat. */
export const cpuDemand = (cpu: LaunchCpu | null): number | null =>
  cpu === null || cpu.wallMs < CALIBRATION_MIN_WALL_MS ? null : (cpu.runMs + cpu.waitMs) / cpu.wallMs;

type History = { seen: Set<InvocationId>; samples: Map<Sha256Hex, number[]> };
const histories = new WeakMap<JournalView, History>();

export function cpuCost(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, key: Sha256Hex, fallback: number, explicit?: number): CpuBasis {
  if (explicit !== undefined) return { kind: 'explicit', value: explicit };
  const view = ctx.journal.view;
  let history = histories.get(view);
  if (history === undefined) {
    history = { seen: new Set(), samples: new Map() };
    histories.set(view, history);
  }
  for (const spawn of view.opsOf('proc.spawn')) {
    const inv = invocationId(spawn.op, spawn.ordinal);
    if (history.seen.has(inv) || view.doneOf(spawn.op) === null) continue;
    history.seen.add(inv);
    const subject = spawn.expect.subject;
    if (subject.purpose !== 'lane' && subject.purpose !== 'proof' && !(subject.purpose === 'backend' && subject.role === 'build')) continue;
    const basis = spawnCpuKeyOf(spawn.expect);
    if (basis === null) continue;
    const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
    const exit = files.read('exit.json');
    if (exit === null) continue;
    const demand = cpuDemand(exitCpuOf(exit));
    if (demand === null) continue;
    // Explicit reservations still teach the same execution key, carried separately on the spawn.
    const samples = history.samples.get(basis) ?? [];
    samples.push(demand);
    if (samples.length > CALIBRATION_RUNS) samples.shift();
    history.samples.set(basis, samples);
  }
  const samples = history.samples.get(key) ?? [];
  return { kind: samples.length < CALIBRATION_MIN_SAMPLES ? 'default' : 'calibrated', key, value: calibratedCpu(samples, fallback), samples: samples.length };
}
