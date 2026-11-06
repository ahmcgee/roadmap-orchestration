// Shared live/recovery stop policy: cleanup and publication critical sections always finish.
import type { IntentOf } from '../core/events.ts';
import { parseJobId } from '../core/ids.ts';
import type { ControlState } from '../core/interfaces.ts';

const STOP_KILLS: readonly string[] = ['backend', 'lane', 'smoke', 'journey', 'mutant', 'arc-backend', 'proof', 'bring-up'];
export const stopKills = (intent: IntentOf<'proc.spawn'>): boolean =>
  STOP_KILLS.includes(intent.expect.subject.purpose) && !(intent.parent.type === 'job' && parseJobId(intent.parent.job).kind === 'docs');

/** A drain's original wall deadline applies across executor restarts. */
export function stopAborts(control: ControlState): boolean {
  const { mode, deadline } = control.stopOptions;
  return control.stop !== null && (mode === 'immediate' || (deadline !== null && Date.now() >= Date.parse(deadline)));
}
