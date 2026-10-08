// Verdicts (plan "Verdicts", G8, G9): a window opens when an applied revision is in force; its samples are units admitted
// after it (lead) or suite runs after it (per-run service), drain idle excluded; it closes at 5 samples, 6 h or
// `arc-completed`, whichever is first, < 3 samples being `inconclusive`. Before = the last 5 samples before the revision.
// `improved` / `worse`: the after-mean below / above the before-window's centre ∓ 2.66·mR̄/√n (on log for lead), else
// `no-effect`; any guard breach (absolute floors) makes it `worse`. Pure, one fact per proposal. PLACEHOLDER (step 0a):
// step A2 replaces this body in place.
import { notYet } from '../core/notyet.ts';
import type { FlowMetric, FlowVerdictKind, GuardBreach, VerdictAfter, VerdictBefore } from './types.ts';

export const WINDOW_SAMPLES = 5;
export const WINDOW_MAX_MIN = 360;
export const BEFORE_SAMPLES = 5;

/** The verdict of a closed window. */
export function verdictOf(_metric: FlowMetric, _before: VerdictBefore, _after: VerdictAfter, _guards: readonly GuardBreach[]): FlowVerdictKind {
  return notYet('verdictOf', 'A2');
}
