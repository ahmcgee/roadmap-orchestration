// The executor's own fix-round directives for the M4a rev 3 checks (corpus arcs, LR-h): a fix round resumes the build
// session with them (`FixRound.directives`), worded for the implementer, one point per directive. Pure: the round
// reconstruction (src/pipeline/rounds.ts) builds them from the recorded outcome, so a replayed round reads the same text.
//   witnessFixDirectives  D1: required witness test ids missing or failing after a green certified series
//   smokeFixDirectives    D2: target witness tests that still pass with the unit's production change reverted
//   repeatRedDirective    F2: a red lane that repeated its previous red exactly, so the executor did not rerun it
import type { TestRef } from '../core/events.ts';
import type { LaneId } from '../core/ids.ts';
import type { RequiredWitness } from '../holistic/required.ts';

/** `lane testId, which witnesses I-3 (target)`: each source of the required test once. */
function sourced(ref: TestRef, required: readonly RequiredWitness[]): string {
  const sources = required.filter((r) => r.lane === ref.lane && r.testId === ref.testId);
  if (sources.length === 0) throw new Error(`witness directive: ${ref.lane} ${ref.testId} is not a required witness`);
  const what = sources.map((r) => `${r.source.id} (${r.role === 'target' ? 'what this unit delivers or repairs' : 'a must-hold this unit keeps'})`);
  return `test "${ref.testId}" on lane ${ref.lane}, which witnesses ${what.join(' and ')}`;
}

/** D1: one directive per missing or failing required witness test, after the one that says what the check was. */
export function witnessFixDirectives(missing: readonly TestRef[], failed: readonly TestRef[], required: readonly RequiredWitness[]): readonly string[] {
  if (missing.length === 0 && failed.length === 0) throw new Error('witnessFixDirectives: a witness fix round names a missing or failing test');
  return [
    'Before the gate, the executor ran the arc\'s witness lanes on your commit and looked for every required witness test by its exact id. These did not pass; the gate is not called until every one does. Use the witness check commands in this message to confirm each fix before you finish.',
    ...missing.map((r) => `Missing: ${sourced(r, required)}. No test with exactly this id ran: it is absent, skipped, selected by no test run, or its record is malformed. Write it under exactly this id, or give that id to the test that proves this behaviour, so the lane runs it and it passes.`),
    ...failed.map((r) => `Failing: ${sourced(r, required)}. Make the behaviour it checks hold; never weaken, skip or rename the test to get green.`),
  ];
}

/** D2: one directive per surviving target, after the one that says what the smoke run did and what a survivor means. */
export function smokeFixDirectives(survived: readonly TestRef[], required: readonly RequiredWitness[]): readonly string[] {
  if (survived.length === 0) throw new Error('smokeFixDirectives: a smoke fix round names a surviving test');
  return [
    'Mutation smoke reverted this unit\'s production changes, kept its test files, and ran the target witness tests again. The tests below still passed without your change, so they do not show what the change does. Strengthen each so that it fails when the change is reverted: assert the behaviour the change adds, through the real entry point, with the fixture injected the way production would read it.',
    ...survived.map((r) => `Survived: ${sourced(r, required)}.`),
    'If a test passes without your change because the behaviour it checks already existed before this unit, leave that test as it is and say so in your summary.',
  ];
}

/** F2: a red lane whose failure repeated its previous red exactly (no rerun: the failure is deterministic). */
export function repeatRedDirective(lane: LaneId, previous: Readonly<{ attempt: number }>): string {
  return `Lane ${lane} failed exactly as it did in attempt ${previous.attempt}: the same exit and the same final output line. The executor did not rerun it, because a failure that repeats unchanged is deterministic, not flaky. The previous fix did not reach its cause: read this run's evidence again, find what the failure says, and fix that.`;
}
