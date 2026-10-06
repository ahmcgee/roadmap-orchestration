// The executor's own directives to the implementer, the one place their text lives (src/pipeline/rounds.ts builds every
// round from them): the round directives (resume, no session, resolve, respec, continue, steer) and the fix-round
// directives of the M4a rev 3 checks, one point per directive. Pure: the round reconstruction builds them from the
// recorded outcome, so a replayed round reads the same text.
//   RESUME_DIRECTIVE      the uncharged resume after a malformed report (`resumeDirectives` quotes the validation error)
//   NO_SESSION_NOTE       a round that could not resume its session runs fresh on the kept worktree
//   RESOLVE_DIRECTIVE     resolve and commit a conflicted merge-in
//   RESPEC_DIRECTIVE      the spec was amended after the earlier work
//   CONTINUE_DIRECTIVE    the continue of an interrupted build
//   STEER_DIRECTIVE       the architect's steer brief follows
//   ASSESSED_DIRECTIVE    the implementing invocation after an in-session assessment (E)
//   stalledLaneDirective, flakyLaneDirective, dirtyLanesDirective, movedHeadDirective   a failing or uncertified series
//   witnessFixDirectives  D1: required witness test ids missing or failing after a green certified series
//   smokeFixDirectives    D2: target witness tests that still pass with the unit's production change reverted
//   repeatRedDirective    F2: a red lane that repeated its previous red exactly, so the executor did not rerun it
import type { TestRef } from '../core/events.ts';
import type { LaneId } from '../core/ids.ts';
import type { RequiredWitness } from '../holistic/required.ts';
import { DECISIONS_FILE } from './schemas.ts';

export const RESUME_DIRECTIVE = 'Your previous final report did not match the required structured format. Do not change any code: return the structured report for the work in this worktree now.';
export const NO_SESSION_NOTE = 'No earlier session of yours exists for this unit, so this is a fresh session: the worktree holds the work done so far. Read it before you change anything.';
export const RESOLVE_DIRECTIVE = 'Integration was merged into this branch and the merge conflicted: resolve and commit. Resolve every conflict in the worktree, then commit the merge on the current branch (no other changes in that commit), run the fast lanes and return your report.';
export const RESPEC_DIRECTIVE = 'The architect amended this unit\'s spec after your earlier work on it; the spec in this message is the amended revision and replaces the one you worked from. The worktree holds your earlier work, committed. Bring the work in line with the amended spec, run the fast lanes and return your report.';
export const CONTINUE_DIRECTIVE = `You were paused partway through this task and are now resumed. The worktree holds your work so far, including uncommitted changes. Continue from where you stopped; do not restart. The evidence directory named in this message is new: rewrite ${DECISIONS_FILE} there, complete, with every decision so far.`;
/** A steer round's directive (R11): the architect's brief follows it verbatim. */
export const STEER_DIRECTIVE = 'The architect is steering this unit: the brief below is their direction for this round, and it takes precedence over any earlier round\'s directives. The worktree holds the unit\'s work so far (committed, and possibly uncommitted changes); read it before you change anything. Follow the brief within the unit\'s scope, run the fast lanes and return your report. The brief:';

/**
 * M4a rev 3 (E, R55): the implementing invocation after an in-session assessment, in the same session: the build's own ask
 * applies from here.
 */
export const ASSESSED_DIRECTIVE = `Your assessment is recorded. Now build the unit: everything the first message of this session says about the build applies from here (the spec, the scope, the fast lanes, the witness checks, ${DECISIONS_FILE}). Record in ${DECISIONS_FILE} each decision your assessment's premises led you to, then return the build report.`;

/** The resume round's directives: RESUME_DIRECTIVE, then why the report was malformed when that is known (I3). */
export function resumeDirectives(error: string | null): readonly string[] {
  return error === null ? [RESUME_DIRECTIVE] : [RESUME_DIRECTIVE, `Why it did not match: ${error}`];
}

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

/** A lane the stall watchdog killed (its output alone does not say it hung). */
export function stalledLaneDirective(lane: LaneId, stallMs: number): string {
  return `Lane ${lane} hung: it made no progress (no CPU time, no output, no process started or ended) for ${stallMs / 60_000} minutes and was killed. Its output so far is in the evidence. Find and fix what it waits on.`;
}

/** A lane that failed, then passed when rerun at the same commit (redlane.ts). */
export function flakyLaneDirective(lane: LaneId, rerunEvidence: string): string {
  return `Lane ${lane} is flaky: it failed, then passed when the executor reran it at the same commit; its passing rerun's evidence is in ${rerunEvidence}. A flaky lane counts as red: find what makes it nondeterministic and make it pass every time.`;
}

/** Lanes that left tracked or unignored paths changed in a clean checkout of the commit (not certified). */
export function dirtyLanesDirective(dirty: readonly string[]): string {
  return `The lanes changed these paths in a clean checkout of your commit: ${dirty.join(', ')}. A lane may write only ignored paths; make the lanes leave every tracked and unignored file as committed.`;
}

/** M4a rev 3 (D1): witness lanes that moved their checkout's HEAD away from the commit (not certified). */
export function movedHeadDirective(): string {
  return 'The witness lanes moved the HEAD of a clean checkout of your commit (a lane committed, checked out or reset). A lane may write only ignored paths and may not touch git state; make the lanes leave the checkout at the commit.';
}

/** F2: a red lane whose failure repeated its previous red exactly (no rerun: the failure is deterministic). */
export function repeatRedDirective(lane: LaneId, previous: Readonly<{ attempt: number }>): string {
  return `Lane ${lane} failed exactly as it did in attempt ${previous.attempt}: the same exit and the same final output line. The executor did not rerun it, because a failure that repeats unchanged is deterministic, not flaky. The previous fix did not reach its cause: read this run's evidence again, find what the failure says, and fix that.`;
}
