// `roadmap witness-check --lane-file <file>` (M4a rev 3, D1, R56): a host act an implementer runs in its worktree. Reads
// the write-once lane file the executor published (`WitnessLaneFile`, src/holistic/types.ts), runs that lane itself in the
// current worktree with a fresh witness file per execution, collects its records (`collectWitness`) and compares them with
// the file's required ids (`missingWitnesses`, src/holistic/required.ts): exit 0, or 78 with `{missing, failed, malformed}`.
// PLACEHOLDER (step N0, H3): step N6 replaces this module in place.
import type { TestRef } from '../core/events.ts';
import type { LaneId } from '../core/ids.ts';
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';

export type WitnessCheckArgs = Readonly<{ laneFile: AbsPath; cwd: AbsPath }>;
/** `passed`: every required id passed (exit 0); `missing`: what did not (exit 78). */
export type WitnessCheckOutcome =
  | Readonly<{ kind: 'passed' }>
  | Readonly<{ kind: 'missing'; missing: readonly TestRef[]; failed: readonly TestRef[]; malformed: readonly LaneId[] }>;

export async function witnessCheck(_args: WitnessCheckArgs): Promise<WitnessCheckOutcome> {
  return notYet('roadmap witness-check', 'N6');
}
