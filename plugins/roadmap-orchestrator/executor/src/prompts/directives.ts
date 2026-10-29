// The executor's own directives to the implementer, the one place their text lives (src/pipeline/rounds.ts builds every
// round from them): the round directives (resume, no session, resolve, respec, continue, steer) and the fix-round
// directives of the M4a rev 3 checks, one point per directive. Pure: the round reconstruction builds them from the
// recorded outcome, so a replayed round reads the same text.
//   RESUME_DIRECTIVE      the uncharged resume after a malformed report (`resumeDirectives` quotes the validation error)
//   NO_SESSION_NOTE       a round that could not resume its session runs fresh on the kept worktree
//   RESOLVE_DIRECTIVE     resolve and commit a conflicted merge-in
//   RESPEC_DIRECTIVE      the spec was amended after the earlier work (RESPEC_FRESH_DIRECTIVE: told to a fresh session)
//   CONTINUE_DIRECTIVE    the continue of an interrupted build (CONTINUE_FRESH_DIRECTIVE: told to a fresh session)
//   resolveUnmetDirective the continuation of a resolve round that left unmet clauses untouched (field feedback 2026-10-23)
//   STEER_DIRECTIVE       the architect's steer brief follows
//   judgmentRepairDirective  every judgment role's one repair turn: the refused answer's reasons (2026-10-15; all roles dev.12)
//   stalledLaneDirective, flakyLaneDirective, dirtyLanesDirective, movedHeadDirective   a failing or uncertified series
//   witnessFixDirectives  D1: required witness test ids missing or failing after a green certified series, then every required id
//   smokeFixDirectives    D2: target witness tests that still pass with the unit's production change reverted
//   repeatRedDirective    F2: a red lane that repeated its previous red exactly, so the executor did not rerun it
//   SCOPE_GROWTH_BLOCKER, revertedPathsDirective   scope growth (2026-10-15): how a builder reports an out-of-scope path it
//                         needs (the build report's `blockers`), and the fix round after salvage reverted its out-of-scope edits
//   restoredPathsDirective  plan defects (2026-10-16): the round after a scope accept took reverted paths in
import type { TestRef } from '../core/events.ts';
import type { LaneId } from '../core/ids.ts';
import type { RequiredWitness } from '../holistic/required.ts';
import { DECISIONS_FILE } from './schemas.ts';

export const RESUME_DIRECTIVE = 'Your previous final report did not match the required structured format. Do not change any code: return the structured report for the work in this worktree now.';
export const NO_SESSION_NOTE = 'No earlier session of yours exists for this unit, so this is a fresh session: the worktree holds the work done so far. Read it before you change anything.';
export const RESOLVE_DIRECTIVE = 'Integration was merged into this branch and the merge conflicted: resolve and commit. Resolve every conflict in the worktree, then commit the merge on the current branch (no other changes in that commit). Then carry out what the spec still needs (a handover in this message, when there is one, lists the acceptance clauses still unmet), run targeted checks and return your report for executor certification.';
export const RESPEC_DIRECTIVE = 'The architect amended this unit\'s spec after your earlier work on it; the spec in this message is the amended revision and replaces the one you worked from. The worktree holds your earlier work, committed. Bring the work in line with the amended spec, run targeted checks and return your report for executor certification.';
/** RESPEC_DIRECTIVE for a fresh session (before NO_SESSION_NOTE): it claims no earlier work as the session's own. */
export const RESPEC_FRESH_DIRECTIVE = 'The architect amended this unit\'s spec after earlier work on it; the spec in this message is the amended revision and replaces the one that work followed. Bring the work in line with the amended spec, run targeted checks and return your report for executor certification.';
export const CONTINUE_DIRECTIVE = `You were paused partway through this task and are now resumed. The worktree holds your work so far, including uncommitted changes. Continue from where you stopped; do not restart. The evidence directory named in this message is new: rewrite ${DECISIONS_FILE} there, complete, with every decision so far.`;
/** CONTINUE_DIRECTIVE for a fresh session (after NO_SESSION_NOTE): it claims no earlier work as the session's own. */
export const CONTINUE_FRESH_DIRECTIVE = `An earlier session on this task was interrupted partway through. The worktree holds its work so far, including uncommitted changes. Continue from there; do not restart. The evidence directory named in this message is new: write ${DECISIONS_FILE} there with every decision you take.`;

/**
 * Field feedback 2026-10-23 item 4: the one continuation of a resolve round that committed the merge and changed nothing beyond
 * it while acceptance clauses of the spec are still unmet (src/pipeline/rounds.ts `resolveContinuation`).
 */
export function resolveUnmetDirective(unmet: readonly Readonly<{ clause: string; text: string }>[]): string {
  if (unmet.length === 0) throw new Error('resolveUnmetDirective: a continuation names the unmet clauses');
  return `The merge is committed, but the resolve round changed nothing beyond it while these acceptance clauses of the spec are still unmet: ${unmet.map((u) => `${u.clause} (${u.text})`).join('; ')}. Carry them out now, run targeted checks and return your report for executor certification.`;
}
/** A steer round's directive (R11): the architect's brief follows it verbatim. */
export const STEER_DIRECTIVE = 'The architect is steering this unit: the brief below is their direction for this round, and it takes precedence over any earlier round\'s directives. The worktree holds the unit\'s work so far (committed, and possibly uncommitted changes); read it before you change anything. Follow the brief within the unit\'s scope, run targeted checks and return your report for executor certification. The brief:';

/**
 * Scope growth (2026-10-15): what a builder does with an out-of-scope path the work needs. It never keeps one: it names it in
 * the report's `blockers`, which the gate reads; a unit's scope grows only through the root agent.
 */
export const SCOPE_GROWTH_BLOCKER = 'list each such path in your report\'s blockers as "scope growth: <path>: <why the spec needs it>" and change nothing for it: only the root agent grows a unit\'s scope (its plan-check proposes the growth, `roadmap scope accept` lands it)';

/**
 * The fix round after salvage reverted the build's edits outside the pinned scope (`paths`, still outside it), their content
 * kept under `kept` (the salvage's rejected dir, `files/<path>`).
 */
export function revertedPathsDirective(paths: readonly string[], kept: string): string {
  return `The executor reverted your edits to these paths after your last round, because they are outside the unit's pinned scope: ${paths.join(', ')} (your versions are kept under ${kept}/files). Do not edit them again: the executor keeps only in-scope changes. If the spec cannot be met without them, ${SCOPE_GROWTH_BLOCKER}.`;
}

/** Plan defects (2026-10-16): reverted paths a scope accept has since taken into the unit's scope. */
export function restoredPathsDirective(paths: readonly string[], kept: string): string {
  return `The unit's scope now includes these paths, whose edits the executor reverted after your last round: ${paths.join(', ')}. Your versions are kept under ${kept}/files: restore them (or redo the edits) as part of this round.`;
}

/**
 * 2026-10-15 (arc feedback #3; dev.12 every judgment role, `repairTurnOf` in src/pipeline/dispatch.ts): the repair turn of a
 * judgment whose answer the executor refused (its schema, or the role's validator): the same session resumed once with every
 * reason, so the judge corrects its own answer.
 */
export function judgmentRepairDirective(reasons: readonly string[]): string {
  if (reasons.length === 0) throw new Error('judgmentRepairDirective: a repair turn names why the answer was refused');
  return `Your answer was refused: ${reasons.join('; ')}. Return a corrected answer.`;
}

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

/**
 * D1: one directive per missing or failing required witness test, after the one that says what the check was; then (paid
 * M4b run 6) every required test, so a fix that renames one test to satisfy an id cannot pass unseen as breaking another.
 */
export function witnessFixDirectives(missing: readonly TestRef[], failed: readonly TestRef[], required: readonly RequiredWitness[]): readonly string[] {
  if (missing.length === 0 && failed.length === 0) throw new Error('witnessFixDirectives: a witness fix round names a missing or failing test');
  const every = [...new Map(required.map((r) => [`${r.lane}\u0000${r.testId}`, { lane: r.lane, testId: r.testId }])).values()];
  return [
    'Before the gate, the executor ran the arc\'s witness lanes on your commit and looked for every required witness test by its exact id. These did not pass; the gate is not called until every one does. Use the witness check commands in this message to confirm each fix before you finish.',
    ...missing.map((r) => `Missing: ${sourced(r, required)}. No test with exactly this id ran: it is absent, skipped, selected by no test run, or its record is malformed. Write it under exactly this id, or give that id to the test that proves this behaviour, so the lane runs it and it passes.`),
    ...failed.map((r) => `Failing: ${sourced(r, required)}. Make the behaviour it checks hold; never weaken, skip or rename the test to get green.`),
    `Every required witness test, which must all exist and pass together under exactly these ids:\n${every.map((r) => `- ${sourced(r, required)}`).join('\n')}\nNever rename a test that has one of these ids to give it another: the id it had then goes missing. When two ids name the same behaviour, keep a test under each.`,
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

/**
 * dev.17 (proportional review): a gate revise's fix round names the gate's open ledger findings by id, and how the builder
 * disputes one instead of fixing it (decisions.json `disputes`); the next gate rules on each dispute once, final.
 */
export function reviewDisputeDirective(open: readonly Readonly<{ id: string; path: string; text: string }>[]): string {
  if (open.length === 0) throw new Error('reviewDisputeDirective: no open finding to name');
  const listed = open.map((f) => `${f.id} (${f.path}): ${f.text}`).join('; ');
  return `The gate's blocking findings are ledgered as ${listed}. Fix each, or, where you are sure a finding is wrong, dispute it instead: add {"finding": "<id>", "reason": "<why it is wrong, with evidence>"} to the "disputes" list in ${DECISIONS_FILE} and leave that code as it is. The next gate rules on each dispute once, and its ruling is final.`;
}
