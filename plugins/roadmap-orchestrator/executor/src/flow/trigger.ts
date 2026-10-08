// Flow-run triggers (plan "Triggers and the job", RC-5, OI-1): coalesced `buffer-red`, `yellow-worsening`,
// `constraint-shift` (code's label changed, the first label once ≥ 3 points exist), `verdict-closed`, `floor` (10 merges
// since the last run or the arc's start) and `requested`. A 120-minute cooldown from the last run's start, which
// `requested` bypasses once per window; triggers about a station under an open window are suppressed, and while the one
// window is open only `verdict-closed`, `buffer-red` and `requested` fire. PLACEHOLDER (step 0a): step B1 replaces it.
import type { JournalView } from '../core/interfaces.ts';
import { notYet } from '../core/notyet.ts';
import type { IsoTime } from '../core/values.ts';
import type { FlowTrigger } from './types.ts';

export const COOLDOWN_MIN = 120;
export const FLOOR_MERGES = 10;
/** OI-1: the points a first constraint label needs; measured in paid run 1. */
export const FIRST_LABEL_POINTS = 3;

/** The triggers due at `now`, coalesced in `FLOW_TRIGGERS` order; empty when no run is due. */
export function dueTriggers(_view: JournalView, _now: IsoTime): readonly FlowTrigger[] {
  return notYet('dueTriggers', 'B1');
}
