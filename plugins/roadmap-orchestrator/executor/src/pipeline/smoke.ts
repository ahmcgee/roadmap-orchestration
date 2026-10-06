// Mutation smoke before the gate (M4a rev 3, D2; corpus arcs, LR-h): after D1 is green, the unit's production diff is
// reverted in a detached worktree (`mutant.apply{of: smoke}`) and its smoke targets run under purpose `mutant`; each target
// is killed, survived or inconclusive (Q15), one execution per allowance key (`smoke-ran`, Q17), capped by `smokeRuns`.
// PLACEHOLDER (step N0, H3): step N3 replaces this module in place.
import { notYet } from '../core/notyet.ts';

export function mutationSmoke(): never {
  return notYet('mutation smoke (D2)', 'N3');
}
