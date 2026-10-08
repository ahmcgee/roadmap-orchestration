// The constraint (plan "Constraint", G7): over the last min(10, n) points, the non-`held` station with the largest mean
// wait in front of it (`wait:<s>` → `stage:<s>`, the slot's wait → `slot:integration`) when that wait is ≥ 10 % of mean
// lead, else the station with the largest mean service (`internal: false`); for the slot, its largest service component
// too. The flow role may dispute it; a proposal's target must be the constraint, one of its components, or the disputed
// station. Pure. PLACEHOLDER (step 0a): step A1 replaces these bodies in place.
import type { StationId } from '../core/ids.ts';
import { notYet } from '../core/notyet.ts';
import type { CodeConstraint, FlowPoint, JudgedConstraint } from './types.ts';

export const CONSTRAINT_WINDOW = 10;
export const WAIT_SHARE = 0.1;

/** Code's constraint over `points` (null with none). */
export function codeConstraintOf(_points: readonly FlowPoint[]): CodeConstraint | null {
  return notYet('codeConstraintOf', 'A1');
}

/** Whether a proposal may target `target` (the `target` drop rule). */
export function targetAdmissible(_code: CodeConstraint | null, _judged: JudgedConstraint, _target: StationId): boolean {
  return notYet('targetAdmissible', 'A1');
}
