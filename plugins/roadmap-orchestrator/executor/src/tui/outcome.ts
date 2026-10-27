import type { Invocation } from './types.ts';
/** Display the purpose's recorded verdict, preserving the raw process outcome separately. */
export function activityState(inv: Invocation): string {
  if (inv.assessment === 'future-gap' && inv.state === 'fail') return 'pre-delivery';
  if (inv.assessment === 'baseline-red' && inv.state === 'fail') return 'pre-delivery';
  if (inv.assessment === 'mutation-caught' && inv.state === 'fail') return 'probe passed';
  if (inv.assessment === 'mutation-survived') return 'probe failed';
  if (inv.assessment === 'mutation-inconclusive') return 'probe unknown';
  return inv.state;
}
export function assessmentExplanation(inv: Invocation): string {
  switch (inv.assessment) {
    case 'future-gap': return 'At this check, these requirements were still future and not yet delivered. The recorded witness tests were red; this is not an executor failure. Later delivery does not change this historical result.';
    case 'baseline-red': return 'At baseline, these future requirements were not delivered. The recorded witness tests were red; this is not an executor failure or a statement about current delivery.';
    case 'mutation-caught': return 'Mutation probe passed: the recorded smoke verdict confirms the tests caught deliberately broken code.';
    case 'mutation-survived': return 'Mutation probe failed: the recorded smoke verdict says deliberately broken code passed its tests.';
    case 'mutation-inconclusive': return 'Mutation probe inconclusive: the recorded smoke verdict does not establish whether the test caught the change.';
    default: return inv.context ?? '';
  }
}
