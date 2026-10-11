// Statistical process control for the flow loop (plan "SPC", G8, G9): one individuals (XmR) chart on log(leadMin),
// centre = mean, upper limit = mean + 2.66·mR̄, frozen for the arc. Seeded from the most recent ≤ 20 points of completed
// previous arcs in this repo with an equal host fingerprint when there are ≥ 5 (newest arcs first, each arc's latest
// merges first), else from this arc's first 5 merges (no buffer trigger before). Zones: green ≤ centre, yellow up to the
// limit, red above. In-flight units are charted by age excluding held time (src/flow/series.ts `inFlightAges`), so a
// stuck unit goes red before it merges and a parked one does not. Rule 1 (the latest point, or an in-flight age, above
// the limit) is `buffer-red`; rule 2 (the latest point beyond centre + 2σ, σ = mR̄/1.128, with at least one of the two
// points before it) is `yellow-worsening`; common cause triggers nothing. Pure.
import type { UnitId } from '../core/ids.ts';
import { type ChartSeed, type FlowChart, type FlowPoint, type FlowSeries, type Zone, sameHost } from './types.ts';

export const SEED_MAX_POINTS = 20;
export const SEED_MIN_POINTS = 5;
/** The XmR constants: the limit's 2.66 and d2 for subgroups of 2. */
export const XMR_E2 = 2.66;
export const XMR_D2 = 1.128;
/** The points a chart lists as recent. */
export const RECENT_POINTS = 10;

/** Limits on the log scale. */
export type XmrLimits = Readonly<{ centre: number; ucl: number; mrBar: number }>;
export type SeededLimits = XmrLimits & Readonly<{ seed: ChartSeed }>;

/** The chart's scale: log(minutes). A lead or age of zero minutes cannot be charted (a unit's lead spans its records). */
function logOf(minutes: number): number {
  if (!(minutes > 0)) throw new Error(`flow chart: ${minutes} minutes cannot be charted on the log scale`);
  return Math.log(minutes);
}

/** The limits of `values` (already on the log scale): at least two, for one moving range. */
export function xmrLimits(values: readonly number[]): XmrLimits {
  if (values.length < 2) throw new Error(`xmr limits need at least 2 values, got ${values.length}`);
  const centre = values.reduce((a, v) => a + v, 0) / values.length;
  let ranges = 0;
  for (let i = 1; i < values.length; i++) ranges += Math.abs(values[i]! - values[i - 1]!);
  const mrBar = ranges / (values.length - 1);
  return { centre, ucl: centre + XMR_E2 * mrBar, mrBar };
}

/**
 * The arc's frozen limits: from `previous` (completed arcs' series, newest first; a series without a host never seeds) on
 * the current series' host, else self-seeded from its first 5 merges; null before either has enough points.
 */
export function seedLimits(previous: readonly FlowSeries[], current: FlowSeries): SeededLimits | null {
  const host = current.host;
  const taken: Readonly<{ arc: FlowSeries['arc']; point: FlowPoint }>[] = [];
  if (host !== null) {
    for (const s of previous) {
      if (s.arc === current.arc || s.host === null || !sameHost(s.host, host)) continue;
      for (const point of [...s.points].reverse()) {
        if (taken.length === SEED_MAX_POINTS) break;
        taken.push({ arc: s.arc, point });
      }
    }
  }
  if (taken.length >= SEED_MIN_POINTS) {
    // Oldest first, so the moving ranges run in merge order within each arc.
    const values = taken.reverse().map((t) => logOf(t.point.leadMin));
    const arcs = [...new Set(taken.map((t) => t.arc))].sort();
    return { ...xmrLimits(values), seed: { type: 'previous', arcs, points: values.length } };
  }
  if (current.points.length < SEED_MIN_POINTS) return null;
  return { ...xmrLimits(current.points.slice(0, SEED_MIN_POINTS).map((p) => logOf(p.leadMin))), seed: { type: 'self', points: SEED_MIN_POINTS } };
}

export function zoneOf(limits: XmrLimits, leadMin: number): Zone {
  const x = logOf(leadMin);
  return x <= limits.centre ? 'green' : x <= limits.ucl ? 'yellow' : 'red';
}

/** The special cause the latest point (or an in-flight age) shows, if any: rule 1 before rule 2. */
export function specialCause(limits: XmrLimits, points: readonly FlowPoint[], inFlight: readonly Readonly<{ ageMin: number }>[]): 'buffer-red' | 'yellow-worsening' | null {
  const last = points.at(-1);
  if ((last !== undefined && zoneOf(limits, last.leadMin) === 'red') || inFlight.some((u) => u.ageMin > 0 && zoneOf(limits, u.ageMin) === 'red')) return 'buffer-red';
  if (last === undefined) return null;
  const twoSigma = limits.centre + 2 * (limits.mrBar / XMR_D2);
  const beyond = (p: FlowPoint): boolean => logOf(p.leadMin) > twoSigma;
  return beyond(last) && points.slice(-3, -1).some(beyond) ? 'yellow-worsening' : null;
}

/** The chart a flow run reads: the frozen limits, the last `RECENT_POINTS` points and the in-flight ages, zoned. */
export function chartOf(limits: SeededLimits, points: readonly FlowPoint[], inFlight: readonly Readonly<{ unit: UnitId; ageMin: number }>[]): FlowChart {
  return {
    centre: limits.centre, ucl: limits.ucl, mrBar: limits.mrBar, seed: limits.seed,
    recent: points.slice(-RECENT_POINTS).map((p) => ({ unit: p.unit, leadMin: p.leadMin, zone: zoneOf(limits, p.leadMin) })),
    inFlight: inFlight.map((u) => ({ unit: u.unit, ageMin: u.ageMin, zone: u.ageMin > 0 ? zoneOf(limits, u.ageMin) : 'green' })),
  };
}
