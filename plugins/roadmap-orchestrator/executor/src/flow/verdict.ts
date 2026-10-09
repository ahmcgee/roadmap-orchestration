// Verdicts (plan "Verdicts", G8, G9): a window opens when an applied revision is in force; its samples are units admitted
// after it (lead, or the wait in front of a station) or suite runs after it (per-run service), drain idle excluded from
// its clock; it closes at 5 samples, 6 h or `arc-completed`, whichever is first, < 3 samples being `inconclusive`.
// Before = the last 5 samples completed before the revision. `improved` / `worse`: the after-mean below / above the
// before-window's centre ∓ 2.66·mR̄/√n (on log for lead), else `no-effect`; any guard breach (absolute floors) makes it
// `worse`. A before-window of fewer than 3 samples (M4b B1 amendment: its mR̄ is undefined or a single range) is
// `inconclusive` too, as is one empty (centre and mR̄ 0, never read). The pressure metric (M4b rev 3, RC-12: a lever at
// `host:cpu`) samples the interval pressure of the units on each side (a fraction in place of minutes), a unit without one
// (no PSI, an unwatched spawn) being no sample. Pure: src/flow/track.ts computes a due verdict
// from the log each tick and writes it once per proposal.
import type { ObligationId } from '../core/ids.ts';
import type { IsoTime } from '../core/values.ts';
import {
  type FlowMetric, type FlowPoint, type FlowSeries, type FlowVerdictKind, type GuardBreach, type VerdictAfter, type VerdictBefore, MIN_VERDICT_SAMPLES,
} from './types.ts';

export const WINDOW_SAMPLES = 5;
export const WINDOW_MAX_MIN = 360;
export const BEFORE_SAMPLES = 5;
/** XmR's limit constant (2.66 = 3/d2 with d2 = 1.128 for moving ranges of two). */
const E2 = 2.66;
/** The lead guard: this many after-window units above the chart's upper limit. */
const LEAD_GUARD_SAMPLES = 2;
/** The rework and first-run-red guards' absolute floor: one more per three merges. */
const RATE_FLOOR = 1 / 3;

const ms = (t: IsoTime): number => Date.parse(t);

/** The scale a metric is tested on: log minutes for lead, minutes otherwise. A lead of 0 minutes cannot occur. */
function scaled(metric: FlowMetric, minutes: number): number {
  if (metric.type !== 'lead') return minutes;
  if (!(minutes > 0)) throw new Error(`verdict: a lead sample of ${minutes} minutes`);
  return Math.log(minutes);
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
/** The mean moving range of consecutive values; 0 for one value. */
const mrBarOf = (xs: readonly number[]): number => (xs.length < 2 ? 0 : mean(xs.slice(1).map((x, i) => Math.abs(x - (xs[i] as number)))));

// ---------------------------------------------------------------------------------------------------
// Samples

/** One sample of a metric: its minutes (a fraction for pressure) and when it became a sample (a unit's merge, a suite run's time). */
export type MetricSample = Readonly<{ at: IsoTime; minutes: number }>;

/** A point's sample of a lead, wait or pressure metric; none for a unit that measured no pressure. */
function pointSample(metric: Exclude<FlowMetric, { type: 'suite-run' }>, p: FlowPoint): MetricSample | null {
  switch (metric.type) {
    case 'wait': return { at: p.mergedAt, minutes: p.minutes[metric.station] ?? 0 };
    case 'lead': return { at: p.mergedAt, minutes: p.leadMin };
    case 'pressure': return p.pressure === null ? null : { at: p.mergedAt, minutes: p.pressure };
  }
}

/**
 * The before and after samples of `metric` around a revision in force from `openedAt`, in time order, and the merged
 * units on each side (what the guards read). Before: the last 5 samples of units merged, or suite runs taken, at or before it. After:
 * units admitted after it (a unit admitted before and merged after belongs to neither side) or suite runs after it; all
 * of them, `closeWindow` cuts them at the close.
 */
export function windowSamples(metric: FlowMetric, openedAt: IsoTime, series: Pick<FlowSeries, 'points' | 'suiteRuns'>): Readonly<{
  before: readonly MetricSample[]; after: readonly MetricSample[]; beforePoints: readonly FlowPoint[]; afterPoints: readonly FlowPoint[];
}> {
  const merged = series.points.filter((p) => ms(p.mergedAt) <= ms(openedAt));
  const beforePoints = merged.slice(-BEFORE_SAMPLES);
  const afterPoints = series.points.filter((p) => ms(p.admittedAt) > ms(openedAt));
  if (metric.type === 'suite-run') {
    const runs = series.suiteRuns.filter((r) => r.lane === metric.lane).map((r): MetricSample => ({ at: r.at, minutes: r.minutes }));
    return { before: runs.filter((r) => ms(r.at) <= ms(openedAt)).slice(-BEFORE_SAMPLES), after: runs.filter((r) => ms(r.at) > ms(openedAt)), beforePoints, afterPoints };
  }
  const samples = (ps: readonly FlowPoint[]): MetricSample[] => ps.flatMap((p) => pointSample(metric, p) ?? []);
  return { before: samples(merged).slice(-BEFORE_SAMPLES), after: samples(afterPoints), beforePoints, afterPoints };
}

// ---------------------------------------------------------------------------------------------------
// The window's clock

/** An idle interval (an ARC-scope drain): excluded from the window's 6 h; `to` null while it lasts. */
export type IdleSpan = Readonly<{ from: IsoTime; to: IsoTime | null }>;
export type WindowCloseReason = 'samples' | 'time' | 'arc-completed';
export type WindowClose = Readonly<{ at: number; reason: WindowCloseReason }>;

/**
 * When the window closed, or null while it is open at `now`: the first of its fifth sample, 6 h of non-idle time after
 * `openedAt`, and the arc's completion after it (`completedAt`, null while the arc runs). `at` is epoch milliseconds.
 */
export function closeWindow(openedAt: IsoTime, now: IsoTime, samples: readonly MetricSample[], idle: readonly IdleSpan[], completedAt: IsoTime | null): WindowClose | null {
  const candidates: WindowClose[] = [];
  const fifth = samples[WINDOW_SAMPLES - 1];
  if (fifth !== undefined) candidates.push({ at: ms(fifth.at), reason: 'samples' });
  candidates.push({ at: timeDeadline(ms(openedAt), idle), reason: 'time' });
  if (completedAt !== null && ms(completedAt) >= ms(openedAt)) candidates.push({ at: ms(completedAt), reason: 'arc-completed' });
  const first = candidates.filter((c) => c.at <= ms(now)).sort((a, b) => a.at - b.at)[0];
  return first ?? null;
}

/** The instant 6 h of non-idle time after `start`, idle spans clipped to after it and merged (an open span runs forever). */
function timeDeadline(start: number, idle: readonly IdleSpan[]): number {
  const spans = idle
    .map((s) => ({ from: Math.max(start, ms(s.from)), to: s.to === null ? Infinity : ms(s.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  let budget = WINDOW_MAX_MIN * 60_000;
  let t = start;
  for (const s of spans) {
    if (s.to <= t) continue;
    const from = Math.max(s.from, t);
    if (from - t >= budget) break;
    budget -= from - t;
    t = s.to;
  }
  return t + budget;
}

/** The after samples a closed window takes: those up to its close, at most 5. */
export function afterOf(samples: readonly MetricSample[], close: WindowClose): VerdictAfter {
  return { samples: samples.filter((s) => ms(s.at) <= close.at).slice(0, WINDOW_SAMPLES).map((s) => s.minutes) };
}

// ---------------------------------------------------------------------------------------------------
// The test

/** The before-window: its samples (raw minutes), and the XmR centre and mR̄ on the metric's scale (log for lead); 0 and 0 when empty. */
export function beforeOf(metric: FlowMetric, samples: readonly MetricSample[]): VerdictBefore {
  if (samples.length === 0) return { samples: [], centre: 0, mrBar: 0 };
  const xs = samples.map((s) => scaled(metric, s.minutes));
  return { samples: samples.map((s) => s.minutes), centre: mean(xs), mrBar: mrBarOf(xs) };
}

/**
 * The verdict of a closed window: a breach is `worse`; < 3 samples after, or < 3 before, `inconclusive`; else the
 * after-mean against the before-window's limits for a mean of n.
 */
export function verdictOf(metric: FlowMetric, before: VerdictBefore, after: VerdictAfter, guards: readonly GuardBreach[]): FlowVerdictKind {
  if (guards.length > 0) return 'worse';
  const n = after.samples.length;
  if (n < MIN_VERDICT_SAMPLES || before.samples.length < MIN_VERDICT_SAMPLES) return 'inconclusive';
  const m = mean(after.samples.map((x) => scaled(metric, x)));
  const half = (E2 * before.mrBar) / Math.sqrt(n);
  if (m < before.centre - half) return 'improved';
  if (m > before.centre + half) return 'worse';
  return 'no-effect';
}

// ---------------------------------------------------------------------------------------------------
// Guards (never folded into T): absolute floors, each breach once, in `FLOW_GUARDS` order

export type GuardInput = Readonly<{
  metric: FlowMetric;
  /** The merged units before the revision and those admitted after it, up to the close (`windowSamples`). */
  beforePoints: readonly FlowPoint[];
  afterPoints: readonly FlowPoint[];
  /** The arc's frozen chart limit on log(leadMin), or null before the limits are seeded (no lead guard then). */
  leadUcl: number | null;
  /** Obligations held at the revision and not held at the close. */
  unheld: readonly ObligationId[];
}>;

/**
 * The breaches: lead (when not the metric) above its upper limit on 2 after-window units; rework and first-run reds up
 * by at least one per three merges; any obligation un-held; cost per merge above the before-window's upper limit.
 */
export function guardBreaches(input: GuardInput): readonly GuardBreach[] {
  const out: GuardBreach[] = [];
  const { beforePoints: before, afterPoints: after } = input;
  if (input.metric.type !== 'lead' && input.leadUcl !== null) {
    const ucl = input.leadUcl;
    const over = after.filter((p) => Math.log(p.leadMin) > ucl);
    if (over.length >= LEAD_GUARD_SAMPLES) out.push({ guard: 'lead', detail: `${over.map((p) => p.unit).join(', ')} above the lead limit` });
  }
  const rate = (ps: readonly FlowPoint[], of: (p: FlowPoint) => number): number => (ps.length === 0 ? 0 : ps.reduce((a, p) => a + of(p), 0) / ps.length);
  if (after.length > 0) {
    for (const [guard, of] of [['rework', (p: FlowPoint) => p.rework], ['first-run-reds', (p: FlowPoint) => p.firstRunReds]] as const) {
      const was = rate(before, of);
      const is = rate(after, of);
      if (is - was >= RATE_FLOOR - 1e-9) out.push({ guard, detail: `${is.toFixed(2)} per merge after, ${was.toFixed(2)} before` });
    }
  }
  if (input.unheld.length > 0) out.push({ guard: 'obligation', detail: `${input.unheld.join(', ')} no longer held` });
  const costs = (ps: readonly FlowPoint[]): number[] => ps.flatMap((p) => (p.costUsd === null ? [] : [p.costUsd]));
  const was = costs(before);
  const is = costs(after);
  if (was.length > 0 && is.length > 0) {
    const ucl = mean(was) + E2 * mrBarOf(was);
    if (mean(is) > ucl) out.push({ guard: 'cost', detail: `$${mean(is).toFixed(2)} per merge above the before-window's limit $${ucl.toFixed(2)}` });
  }
  return out;
}
