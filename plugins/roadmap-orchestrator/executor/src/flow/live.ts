// The flow loop's reading of a live arc (plan "Stations and the flow series", "SPC", "Triggers and the job"): the run's
// log and kept inputs folded into its series, the chart's frozen limits (seeded from the completed previous arcs of the
// repo, src/flow/history.ts), the in-flight ages, the flow facts (src/flow/log.ts), the host fingerprint, the givens in
// force and the lever catalogue of the plan in force. The executor's flow track, `status` and the job's capture read it.
// M4b rev 3: the cpu-wait threshold and schedstat availability (`pressureNow`) and the arc's own `@cpu` tokens held (`cpuInUse`).
//
// Reading is the only effect. The log is parsed once per high-water mark (the flow track asks every few seconds), and
// the previous arcs' series once per repo and arc: one arc runs per host, so no previous arc completes while this one
// runs.
import type { Event } from '../core/events.ts';
import { type ArcId, type Sha256Hex, type UnitId, CPU_POOL } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type AbsPath, type IsoTime } from '../core/values.ts';
import { gitCommonDir } from '../git/git.ts';
import { eventsPrefix } from '../git/snapshot.ts';
import { FLOW_SERIES_INPUT, inputPath, keptInput } from '../input/inforce.ts';
import { type PlanM1, priorityOf } from '../input/plan.ts';
import { PRESSURE_SATURATED, pressureAvailability } from '../host/pressure.ts';
import { readHostFingerprint } from '../host/sample.ts';
import { committedRepoConfig } from '../preflight/checks.ts';
import { RISK_TIERS, type ClassTable } from '../routing/types.ts';
import { givensInForce, readHostGivens, repoGivensOf } from './givens.ts';
import { previousSeries } from './history.ts';
import { builtinBuildClass } from './levers.ts';
import { type FlowLog, flowLog, openWindow } from './log.ts';
import { type SeriesInputs, flowSeries, inFlightAges, seriesInputs } from './series.ts';
import { type SeededLimits, seedLimits } from './spc.ts';
import { type FlowPressureStatus, type FlowSeries, type FlowWindow, type GivenInForce, type HostFingerprint, type LeverState, parseFlowSeries } from './types.ts';
import { WINDOW_SAMPLES, windowSamples } from './verdict.ts';
import type { Sha } from '../core/ids.ts';

/** What a reading of the arc needs: its run dir, its repo and its log's view. */
export type FlowReader = Readonly<{ runDir: AbsPath; repo: AbsPath; journal: Readonly<{ view: JournalView }> }>;

/** The arc's flow now. `inFlight`: the in-flight units' ages at the reading's time, held time excluded. */
export type FlowNow = Readonly<{
  events: readonly Event[];
  log: FlowLog;
  series: FlowSeries;
  inputs: SeriesInputs;
  limits: SeededLimits | null;
  inFlight: readonly Readonly<{ unit: UnitId; ageMin: number }>[];
  host: HostFingerprint;
}>;

type Parsed = Readonly<{ highWater: number; events: readonly Event[]; log: FlowLog; series: FlowSeries; inputs: SeriesInputs }>;
const parsed = new Map<AbsPath, Parsed>();
const previous = new Map<string, readonly FlowSeries[]>();

/** The kept-input reader of a run dir: a named input that is not kept is a bug. */
export function keptReader(runDir: AbsPath): (sha: Sha256Hex, ext: string) => Buffer {
  return (sha, ext) => {
    const bytes = keptInput(runDir, sha, ext);
    if (bytes === null) throw new Error(`flow: the log names ${ext} ${sha}, but ${inputPath(runDir, sha, ext)} is not kept`);
    return bytes;
  };
}

function parse(r: FlowReader): Parsed {
  const highWater = r.journal.view.highWater();
  const known = parsed.get(r.runDir);
  if (known !== undefined && known.highWater === highWater) return known;
  const { events } = eventsPrefix(r.runDir, highWater);
  const inputs = seriesInputs(keptReader(r.runDir));
  const log = flowLog(r.journal.view, events);
  // A series kept at completion that is still the log's last work record is the series: what came after it (the terminal
  // snapshot's own op lines, the next start) is no flow, and the ref carries the kept record, so a run dir restored from
  // the ref reads the same accounting.
  const kept = log.series.at(-1);
  const series = kept !== undefined && kept.seq === r.journal.view.lastWorkSeq()
    ? parseFlowSeries(JSON.parse(keptReader(r.runDir)(kept.sha256, FLOW_SERIES_INPUT).toString('utf8')))
    : flowSeries(r.journal.view.arc, events, inputs);
  const out: Parsed = { highWater, events, log, series, inputs };
  parsed.set(r.runDir, out);
  return out;
}

/** The completed previous arcs' series of `repo` (newest completion first), read once per repo and arc. */
function previousOf(repo: AbsPath, arc: ArcId): readonly FlowSeries[] {
  const key = `${repo}\u0000${arc}`;
  const known = previous.get(key);
  if (known !== undefined) return known;
  const out = previousSeries(repo, arc);
  previous.set(key, out);
  return out;
}

/** The arc's flow at `now` (see the header). The host is the latest start's fingerprint, else this host's. */
export function flowNow(r: FlowReader, now: IsoTime): FlowNow {
  const p = parse(r);
  const limits = seedLimits(previousOf(r.repo, r.journal.view.arc), p.series);
  return { ...p, limits, inFlight: inFlightAges(p.events, now, p.inputs), host: p.series.host ?? readHostFingerprint() };
}

/** The open window now (src/flow/log.ts `openWindow`), its samples those taken so far (at most 5). */
export function windowNow(f: FlowNow): FlowWindow | null {
  return openWindow(f.log, (metric, openedAt) => Math.min(WINDOW_SAMPLES, windowSamples(metric, openedAt, f.series).after.length));
}

/** The givens in force on `host`: the host file's (under the repo's git common dir) and the config committed at `head`. */
export function givensNow(repo: AbsPath, head: Sha, host: HostFingerprint): readonly GivenInForce[] {
  return givensInForce(readHostGivens(gitCommonDir(repo)), repoGivensOf(committedRepoConfig(repo, head)), host);
}

/**
 * The lever catalogue of `plan` (the values a run reads): the `@cpu` capacity (the host's cpus when the plan sets none),
 * each pooled resource, each suite lane, each active unit's priority (`active`: the units not merged, cut or superseded)
 * and each build tier's class in force (`classes`, the arc routing's) with its built-in floor.
 */
export function leverCatalogue(plan: PlanM1, hostCpus: number, classes: ClassTable, active: (unit: UnitId) => boolean): readonly LeverState[] {
  const cpu = plan.capacity?.cpu;
  return [
    { lever: 'concurrency', cpu: cpu ?? hostCpus, set: cpu !== undefined, hostCpus },
    ...plan.resources.flatMap((r): LeverState[] => (r.pool === undefined ? [] : [{ lever: 'resource-pool', resource: r.name, size: r.pool.size }])),
    ...plan.suite.lanes.map((l): LeverState => ({ lever: 'suite-lane', lane: l.id, argv: l.argv, cpu: l.cpu ?? null })),
    ...plan.units.filter((u) => u.cut === undefined && active(u.id)).map((u): LeverState => ({ lever: 'sequence', unit: u.id, priority: priorityOf(u) })),
    ...RISK_TIERS.map((tier): LeverState => ({ lever: 'build-class', tier, class: classes.build[tier], builtin: builtinBuildClass(tier) })),
  ];
}

/** The cpu-wait threshold and whether this host reports schedstat (`status.flow.pressure`, a run's inputs). */
export function pressureNow(): FlowPressureStatus {
  return { threshold: PRESSURE_SATURATED, available: pressureAvailability() === 'available' };
}

/** The arc's own `@cpu` tokens held now (reserved, running or cleaning), from the journal's resource table. */
export function cpuInUse(view: JournalView): number {
  return [...view.resources()].filter(([unit, e]) => unit.startsWith(`${CPU_POOL}#`) && e.status.state !== 'free').length;
}
