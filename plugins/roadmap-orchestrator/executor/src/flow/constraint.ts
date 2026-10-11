// The constraint (plan "Constraint", G7): over the last min(10, n) points, the non-`held` station with the largest mean
// wait in front of it (`wait:<s>` → `stage:<s>`, the slot's wait → `slot:integration`) when that wait is ≥ 10 % of mean
// lead (`internal: true`), else the station with the largest mean service (`internal: false`; the slot competes as the
// sum of its components). For the slot, its largest service component too. `wait:finding` (a unit's candidate wait held
// by an open P1 on an obligation it selects) stands in front of nothing a lever moves: when it is the largest wait it is
// the constraint itself, diagnostic (no lever targets it, src/flow/levers.ts). Ties go to the station id first in order.
// The flow role may dispute it; a proposal's target must be the constraint, one of its components, or the disputed
// station (or one of its components). Pure.
//
// Ahead of both rules (M4b rev 3, RC-10): when the window's mean pressure is at least `PRESSURE_SATURATED`, the
// constraint is `host:cpu` (internal): a contended cpu inflates every station's service, so the largest station is a
// symptom. The window's pressure is the mean of its points' that measured one; with none (a host without schedstat) the
// rule is off.
import { type StationId, HOST_CPU_STATION, SLOT_STATION, parseStationId, stationId, stationOf } from '../core/ids.ts';
import { PRESSURE_SATURATED } from '../host/pressure.ts';
import { isSlotComponent, stationMeans } from './series.ts';
import type { CodeConstraint, FlowPoint, JudgedConstraint } from './types.ts';

export const CONSTRAINT_WINDOW = 10;
export const WAIT_SHARE = 0.1;

const SLOT = stationId(SLOT_STATION);

/** The points the constraint reads: the last min(10, n). */
export const constraintWindow = (points: readonly FlowPoint[]): readonly FlowPoint[] => points.slice(-CONSTRAINT_WINDOW);

/** The mean pressure of the window's points that measured one; null when none did. */
export function windowPressure(points: readonly FlowPoint[]): number | null {
  const measured = constraintWindow(points).flatMap((p) => (p.pressure === null ? [] : [p.pressure]));
  return measured.length === 0 ? null : measured.reduce((a, b) => a + b, 0) / measured.length;
}

/** The station a wait stands in front of (the finding wait: itself); null for a service station. */
function waitedOn(station: StationId): StationId | null {
  const p = parseStationId(station);
  if (p.type === 'wait') return stationOf({ type: 'stage', stage: p.stage });
  if (p.type === 'slot-wait') return SLOT;
  if (p.type === 'finding-wait') return station;
  return null;
}

/** The entry with the largest value, ties to the smallest station id; null when none. */
function largest(entries: readonly (readonly [StationId, number])[]): readonly [StationId, number] | null {
  let best: readonly [StationId, number] | null = null;
  for (const e of entries) if (best === null || e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = e;
  return best;
}

/** Code's constraint over the last min(10, n) of `points` (null with none). */
export function codeConstraintOf(points: readonly FlowPoint[]): CodeConstraint | null {
  const window = constraintWindow(points);
  if (window.length === 0) return null;
  const pressure = windowPressure(window);
  if (pressure !== null && pressure >= PRESSURE_SATURATED) return { station: stationId(HOST_CPU_STATION), internal: true, component: null };
  const means = [...stationMeans(window)];
  const lead = window.reduce((a, p) => a + p.leadMin, 0) / window.length;
  const wait = largest(means.filter(([s]) => waitedOn(s) !== null));
  const station = wait !== null && wait[1] > 0 && wait[1] >= WAIT_SHARE * lead
    ? { station: waitedOn(wait[0])!, internal: true }
    : { station: largest(means.filter(([s]) => s !== stationId('held') && waitedOn(s) === null && !isSlotComponent(s)))?.[0] ?? null, internal: false };
  if (station.station === null) return null;
  const component = station.station === SLOT ? largest(means.filter(([s]) => isSlotComponent(s)))?.[0] ?? null : null;
  if (station.station === SLOT && component === null) throw new Error('flow constraint: the slot has a wait in front of it but no service component in the window');
  return { station: station.station, internal: station.internal, component };
}

/** `target` is `station` or, when `station` is the slot, one of its components. */
function within(station: StationId, target: StationId): boolean {
  return target === station || (station === SLOT && isSlotComponent(target));
}

/** Whether a proposal may target `target` (the `target` drop rule): code's constraint or a component, or the disputed station or a component. */
export function targetAdmissible(code: CodeConstraint | null, judged: JudgedConstraint, target: StationId): boolean {
  return (code !== null && within(code.station, target)) || (!judged.agree && within(judged.station, target));
}
