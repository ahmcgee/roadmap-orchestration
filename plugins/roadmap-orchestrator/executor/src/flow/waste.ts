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

/** Only completed real executions count; reuse facts stay intact but incur no second run or cost. */
export function laneRuns(events: readonly Event[]): readonly LaneRun[] {
  const starts = new Map<string, Readonly<{ intent: IntentOf<'proc.spawn'>; at: string }>>();
  const runs: LaneRun[] = [];
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'proc.spawn') starts.set(e.op, { intent: e, at: e.at });
    if (e.type !== 'done' || e.kind !== 'proc.spawn' || e.outcome.kind !== 'result' || e.outcome.summary.type !== 'command') continue;
    const start = starts.get(e.op);
    if (start === undefined) throw new Error(`done spawn without intent: ${e.op}`);
    const { subject: s } = start.intent.expect;
    if (s.purpose !== 'lane' && s.purpose !== 'journey') continue;
    const parent = start.intent.parent;
    runs.push({ lane: s.lane, unit: s.purpose === 'lane' ? s.unit : s.owner.type === 'unit' ? s.owner.unit : null,
      series: canonicalJson(parent), at: s.at, set: s.purpose === 'lane' ? s.set : 'suite', minutes: Math.max(0, Date.parse(e.at) - Date.parse(start.at)) / 60000, verdict: e.outcome.summary.verdict });
  }
  return runs;
}

export function grinding(events: readonly Event[]): readonly WasteFinding[] {
  const units = new Map<UnitId, { builds: number; judged: number }>();
  for (const e of events) {
    if (e.type !== 'fact' || e.fact.kind !== 'stage-outcome' || !('unit' in e.fact)) continue;
    const f = e.fact;
    const n = units.get(f.unit) ?? { builds: 0, judged: 0 };
    if (f.stage === 'build') n.builds++;
    if (['plan-check', 'build', 'lanes', 'gate'].includes(f.stage)) n.judged++;
    units.set(f.unit, n);
  }
  return [...units].flatMap(([unit, n]) => n.builds >= 8 || n.judged >= 20
    ? [{ key: `grinding:${unit}`, detector: 'grinding' as const, unit, summary: `${unit}: ${n.builds} builds, ${n.judged} judged stages; inspect the repeated work.` }] : []);
}

export function redOnUnitGreenOnBase(runs: readonly LaneRun[]): readonly WasteFinding[] {
  const found = new Map<string, WasteFinding>();
  for (const red of runs) {
    if (red.unit === null || !['fail', 'stall', 'timeout'].includes(red.verdict)) continue;
    // A stage series runs the candidate/salvage first, then the same lane on its diff base/tip.
    const base = runs.find((b) => b.series === red.series && b.lane === red.lane && b.at !== red.at && b.verdict === 'pass');
    if (base === undefined) continue;
    const key = `red-on-unit-green-on-base:${red.unit}:${red.lane}`;
    found.set(key, { key, detector: 'red-on-unit-green-on-base', unit: red.unit, summary: `${red.unit}: ${red.lane} red on the unit, green on its base; inspect the fix rounds.` });
  }
  return [...found.values()];
}

export function lowUniqueCatch(runs: readonly LaneRun[]): readonly WasteFinding[] {
  const lanes = new Map<LaneId, { runs: number; unique: number }>();
  for (const r of runs) {
    const n = lanes.get(r.lane) ?? { runs: 0, unique: 0 }; n.runs++;
    if (r.verdict === 'fail' && !runs.some((other) => other.series === r.series && other.at === r.at && other.lane !== r.lane && other.verdict === 'fail')) n.unique++;
    lanes.set(r.lane, n);
  }
  return [...lanes].flatMap(([lane, n]) => n.runs >= 10 && n.unique === 0 ? [{ key: `low-unique-catch:${lane}`, detector: 'low-unique-catch' as const, unit: null,
    summary: `${lane}: ${n.runs} executions, no unique red series; review its coverage and cadence.` }] : []);
}

export function repeatedExpensiveSuites(runs: readonly LaneRun[], expensive: ReadonlySet<LaneId>): readonly WasteFinding[] {
  const lanes = new Map<LaneId, LaneRun[]>();
  for (const r of runs) if (r.set === 'suite' && (expensive.has(r.lane) || r.minutes >= 5)) lanes.set(r.lane, [...lanes.get(r.lane) ?? [], r]);
  return [...lanes].flatMap(([lane, rs]) => rs.length >= 3 ? [{ key: `repeated-expensive-suite:${lane}`, detector: 'repeated-expensive-suite' as const, unit: null,
    summary: `${lane}: ${rs.length} expensive suite executions (${rs.reduce((n, r) => n + r.minutes, 0).toFixed(1)} min); review reuse and cadence.` }] : []);
}

export function wasteFindings(events: readonly Event[]): readonly WasteFinding[] {
  const runs = laneRuns(events);
  return [...grinding(events), ...redOnUnitGreenOnBase(runs), ...lowUniqueCatch(runs), ...repeatedExpensiveSuites(runs, new Set())];
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
