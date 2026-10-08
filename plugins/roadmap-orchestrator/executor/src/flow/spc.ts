// Statistical process control for the flow loop (plan "SPC", G8, G9): one individuals (XmR) chart on log(leadMin),
// centre = mean, upper limit = mean + 2.66·mR̄, frozen for the arc. Seeded from the most recent ≤ 20 points of completed
// previous arcs in this repo with an equal host fingerprint when there are ≥ 5, else from this arc's first 5 merges (no
// buffer trigger before). Zones: green ≤ centre, yellow up to the limit, red above. In-flight units are charted by age
// excluding held time. Rule 1 (a point above the limit) is `buffer-red`; rule 2 (2 of 3 beyond centre + 2σ, σ = mR̄/1.128)
// is `yellow-worsening`; common cause triggers nothing. Pure. PLACEHOLDER (step 0a): step A1 replaces these bodies.
import { notYet } from '../core/notyet.ts';
import type { ChartSeed, FlowPoint, FlowSeries, Zone } from './types.ts';

export const SEED_MAX_POINTS = 20;
export const SEED_MIN_POINTS = 5;
/** The XmR constants: the limit's 2.66 and d2 for subgroups of 2. */
export const XMR_E2 = 2.66;
export const XMR_D2 = 1.128;

/** Limits on the log scale. */
export type XmrLimits = Readonly<{ centre: number; ucl: number; mrBar: number }>;
export type SeededLimits = XmrLimits & Readonly<{ seed: ChartSeed }>;

/** The limits of `values` (already on the log scale). */
export function xmrLimits(_values: readonly number[]): XmrLimits {
  return notYet('xmrLimits', 'A1');
}

/** The arc's frozen limits: from `previous` (completed arcs' series, newest first) on an equal host, else self-seeded; null before either has enough points. */
export function seedLimits(_previous: readonly FlowSeries[], _current: FlowSeries): SeededLimits | null {
  return notYet('seedLimits', 'A1');
}

export function zoneOf(_limits: XmrLimits, _leadMin: number): Zone {
  return notYet('zoneOf', 'A1');
}

/** The special cause the latest points show, if any. */
export function specialCause(_limits: XmrLimits, _points: readonly FlowPoint[]): 'buffer-red' | 'yellow-worsening' | null {
  return notYet('specialCause', 'A1');
}
