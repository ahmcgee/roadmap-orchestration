// Advisory observations over the efficacy feed. Thresholds are unmeasured defaults; none changes admission or routing.
import type { Event, IntentOf, Parent } from '../core/events.ts';
import type { LaneId, UnitId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { AbsPath } from '../core/values.ts';
import { eventsPrefix } from '../git/snapshot.ts';
import { raiseNeedsUser } from '../needsuser.ts';

export type WasteFinding = Readonly<{ key: string; detector: 'grinding' | 'red-on-unit-green-on-base' | 'low-unique-catch' | 'repeated-expensive-suite'; unit: UnitId | null; summary: string }>;
export type LaneRun = Readonly<{ lane: LaneId; unit: UnitId | null; series: string; at: string; set: 'spec' | 'suite'; minutes: number; verdict: string }>;

/**
 * The completed lane and journey runs, folded one event at a time (a pass of src/status/passes.ts). Only completed real
 * executions count; reuse facts stay intact but incur no second run or cost.
 */
export class LaneRunFold {
  readonly #starts = new Map<string, Readonly<{ intent: IntentOf<'proc.spawn'>; at: string }>>();
  readonly #runs: LaneRun[] = [];
  step(e: Event): void {
    if (e.type === 'intent' && e.kind === 'proc.spawn') this.#starts.set(e.op, { intent: e, at: e.at });
    if (e.type !== 'done' || e.kind !== 'proc.spawn' || e.outcome.kind !== 'result' || e.outcome.summary.type !== 'command') return;
    const start = this.#starts.get(e.op);
    if (start === undefined) throw new Error(`done spawn without intent: ${e.op}`);
    const { subject: s } = start.intent.expect;
    if (s.purpose !== 'lane' && s.purpose !== 'journey') return;
    const parent = start.intent.parent;
    this.#runs.push({ lane: s.lane, unit: s.purpose === 'lane' ? s.unit : s.owner.type === 'unit' ? s.owner.unit : null,
      series: canonicalJson(parent), at: s.at, set: s.purpose === 'lane' ? s.set : 'suite', minutes: Math.max(0, Date.parse(e.at) - Date.parse(start.at)) / 60000, verdict: e.outcome.summary.verdict });
  }
  /** The runs so far, in log order. */
  get runs(): readonly LaneRun[] { return [...this.#runs]; }
}

export function laneRuns(events: readonly Event[]): readonly LaneRun[] {
  const fold = new LaneRunFold();
  for (const e of events) fold.step(e);
  return fold.runs;
}

/** Each unit's builds and judged stages, folded one event at a time (a pass of src/status/passes.ts). */
export class GrindingFold {
  readonly #units = new Map<UnitId, Readonly<{ builds: number; judged: number }>>();
  step(e: Event): void {
    if (e.type !== 'fact' || e.fact.kind !== 'stage-outcome' || !('unit' in e.fact)) return;
    const f = e.fact;
    const n = this.#units.get(f.unit) ?? { builds: 0, judged: 0 };
    this.#units.set(f.unit, { builds: n.builds + (f.stage === 'build' ? 1 : 0), judged: n.judged + (['plan-check', 'build', 'lanes', 'gate'].includes(f.stage) ? 1 : 0) });
  }
  get findings(): readonly WasteFinding[] {
    return [...this.#units].flatMap(([unit, n]) => n.builds >= 8 || n.judged >= 20
      ? [{ key: `grinding:${unit}`, detector: 'grinding' as const, unit, summary: `${unit}: ${n.builds} builds, ${n.judged} judged stages; inspect the repeated work.` }] : []);
  }
}

export function grinding(events: readonly Event[]): readonly WasteFinding[] {
  const fold = new GrindingFold();
  for (const e of events) fold.step(e);
  return fold.findings;
}

export function redOnUnitGreenOnBase(runs: readonly LaneRun[]): readonly WasteFinding[] {
  const found = new Map<string, WasteFinding>();
  const passing = new Map<string, Set<string>>();
  for (const r of runs) if (r.verdict === 'pass') {
    const key = JSON.stringify([r.series, r.lane]); const commits = passing.get(key) ?? new Set<string>();
    commits.add(r.at); passing.set(key, commits);
  }
  for (const red of runs) {
    if (red.unit === null || !['fail', 'stall', 'timeout'].includes(red.verdict)) continue;
    // A stage series runs the candidate/salvage first, then the same lane on its diff base/tip.
    const commits = passing.get(JSON.stringify([red.series, red.lane]));
    if (commits === undefined || commits.size === 1 && commits.has(red.at)) continue;
    const key = `red-on-unit-green-on-base:${red.unit}:${red.lane}`;
    found.set(key, { key, detector: 'red-on-unit-green-on-base', unit: red.unit, summary: `${red.unit}: ${red.lane} red on the unit, green on its base; inspect the fix rounds.` });
  }
  return [...found.values()];
}

export function lowUniqueCatch(runs: readonly LaneRun[]): readonly WasteFinding[] {
  const lanes = new Map<LaneId, { runs: number; unique: number }>();
  const failing = new Map<string, Set<LaneId>>();
  for (const r of runs) if (r.verdict === 'fail') {
    const key = JSON.stringify([r.series, r.at]); const ids = failing.get(key) ?? new Set<LaneId>();
    ids.add(r.lane); failing.set(key, ids);
  }
  for (const r of runs) {
    const n = lanes.get(r.lane) ?? { runs: 0, unique: 0 }; n.runs++;
    if (r.verdict === 'fail' && failing.get(JSON.stringify([r.series, r.at]))!.size === 1) n.unique++;
    lanes.set(r.lane, n);
  }
  return [...lanes].flatMap(([lane, n]) => n.runs >= 10 && n.unique === 0 ? [{ key: `low-unique-catch:${lane}`, detector: 'low-unique-catch' as const, unit: null,
    summary: `${lane}: ${n.runs} executions, no unique red series; review its coverage and cadence.` }] : []);
}

export function repeatedExpensiveSuites(runs: readonly LaneRun[], expensive: ReadonlySet<LaneId>): readonly WasteFinding[] {
  const lanes = new Map<LaneId, { count: number; minutes: number }>();
  for (const r of runs) if (r.set === 'suite' && (expensive.has(r.lane) || r.minutes >= 5)) {
    const n = lanes.get(r.lane) ?? { count: 0, minutes: 0 }; n.count++; n.minutes += r.minutes; lanes.set(r.lane, n);
  }
  return [...lanes].flatMap(([lane, n]) => n.count >= 3 ? [{ key: `repeated-expensive-suite:${lane}`, detector: 'repeated-expensive-suite' as const, unit: null,
    summary: `${lane}: ${n.count} expensive suite executions (${n.minutes.toFixed(1)} min); review reuse and cadence.` }] : []);
}

export function wasteFindings(events: readonly Event[], runs = laneRuns(events)): readonly WasteFinding[] {
  return wasteOf(grinding(events), runs);
}

/** Every detector's findings: grinding's (`GrindingFold`), then those over the lane runs. */
export function wasteOf(grinds: readonly WasteFinding[], runs: readonly LaneRun[]): readonly WasteFinding[] {
  return [...grinds, ...redOnUnitGreenOnBase(runs), ...lowUniqueCatch(runs), ...repeatedExpensiveSuites(runs, new Set())];
}

const scanned = new WeakMap<Journal, number>();

export function raiseWasteFindings(ctx: Readonly<{ journal: Journal; runDir: AbsPath }>): void {
  if (scanned.get(ctx.journal) === ctx.journal.view.highWater()) return;
  const seen = new Set(ctx.journal.view.opsOf('needsuser.raise').flatMap((i) => i.parent.type === 'waste' && ctx.journal.view.doneOf(i.op) !== null ? [i.parent.key] : []));
  for (const finding of wasteFindings(eventsPrefix(ctx.runDir, ctx.journal.view.highWater()).events)) {
    if (seen.has(finding.key)) continue;
    const parent: Parent = { type: 'waste', key: finding.key };
    raiseNeedsUser(ctx.journal, ctx.runDir, { reason: 'waste-finding', blocking: false,
      subject: finding.unit === null ? { type: 'arc' } : { type: 'unit', unit: finding.unit }, summary: `[${finding.key}] ${finding.summary}`,
      recommendation: 'Inspect the evidence and adjust the plan if useful. This observation never holds work.', options: [], evidence: [] }, parent);
  }
  scanned.set(ctx.journal, ctx.journal.view.highWater());
}
