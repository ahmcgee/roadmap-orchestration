// Fake-backed M4a runs (`driver --fake <script>`): the backend calls of each arc, one scenario per arc (its job ids
// restart at review-1, audit-1, ckpt-1), written by the driver under `fake/arc-<n>/` with its shims; the scripted root
// agent puts arc n's shims first on PATH when it starts arc n. Unit calls are M1 steps keyed by unit (evals/m1/
// scenario.ts); pack review, lens and checkpoint calls are 0b's scripted judgments keyed by job (and lens).
//
//   arc 1   review-1 holds a blocking finding on guard's spec (the hold; the root agent fixes the pack by `apply`), and
//           review-2, on the new key, supersedes it with a note. guard and confirm build; confirm's gate approves with
//           a note (gate-note debt). audit-1's vision lens opens a P3 with no obligation; ckpt-1 defers it
//           (finding-deferred debt), proposes an amendment (T-11: confirm cancellations by text) and takes in both
//           issues (#1 none, #2 an amendment). Then the final audit and its checkpoint, no-op.
//   arc 2   review-1 waits at the `policy-flip` barrier until the driver has flipped the forge to PUBLIC + ALL (the
//           mid-arc flip, OR-L6); then cutoff builds, audit-1's checkpoint capture finds the policy untrusted and raises
//           the blocking item; once the owner restored it and the root agent acked, ckpt-1 takes in both issues; notice
//           builds; audit-2 and ckpt-2.
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { checkpointAnswer, checkpointStep, intakeOutcome, lensStep, packReviewStep, packTargetOf } from '../../test/helpers/holistic.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { type M1Step, fakeSteps } from '../m1/scenario.ts';
import { FILES, filesOf } from './golden.ts';
import { join } from 'node:path';

/** The barrier arc 2's pack review waits at until the driver flipped the forge's policy. */
export const POLICY_FLIP_BARRIER = 'policy-flip';
const HOLD_MS = 20 * 60_000;

const planCheck = (reason: string): M1Step => ({
  role: 'planCheck',
  answer: { decision: 'approve', reasons: [reason], patch: null, risk: 'low', notes: '', premises: [], visionConflict: [] },
});
const build = (message: string, unit: string): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files: filesOf(join(FILES, 'units', unit)) }] });
const gate = (reason: string, findings: readonly JsonValue[] = []): M1Step => ({
  role: 'gate', answer: { decision: 'approve', findings: [...findings], directives: [], reasons: [reason], premises: [] },
});

/** The gate note confirm's approval carries: banked as `gate-note` debt. */
export const GATE_NOTE = 'The confirmation text signs off as "Tidewater" where the harbour\'s own name would read better to a skipper.';
/** The lens P3 ckpt-1 defers: banked as `finding-deferred` debt, which arc 2 promotes to `notice`. */
export const DEFERRED_CLAIM = '`cancel` leaves the skipper nothing to keep: unlike a booking, a cancellation sends no text.';
/** ckpt-1's proposed amendment (source checkpoint), applied in arc 2 as T-16. */
export const CHECKPOINT_AMENDMENT = { rules: ['T-11'], proposal: 'Add a rule: a cancellation is confirmed to the skipper by text message, as a booking is.', why: 'V-5 asks that a cancellation be as clear to the skipper as a booking; only bookings are confirmed today.' } as const;
/** ckpt-1's intake amendment of issue #2 (source issue), deferred in arc 2. */
export const ISSUE_AMENDMENT = { rules: ['T-5'], proposal: 'Windows list the high-water height from the printed table beside each time.' } as const;

const UNITS_1: Readonly<Record<string, readonly M1Step[]>> = {
  guard: [planCheck('The spec refuses a second booking of a berth for one window (T-7); scope is the ledger.'), build('guard: refuse a berth booked twice for one window', 'guard'), gate('A1 and A2 hold.')],
  confirm: [
    planCheck('The spec writes the booking text to the outbox (T-11), within src/cli.js and src/confirm.js.'),
    build('confirm: text the skipper when a booking is made', 'confirm'),
    gate('A1, A2 and A3 hold.', [{ severity: 'note', path: 'src/confirm.js', text: GATE_NOTE, contractRef: null }]),
  ],
};

const UNITS_2: Readonly<Record<string, readonly M1Step[]>> = {
  cutoff: [planCheck('The spec closes cancellations 48 hours before the window opens (T-15).'), build('cutoff: cancellations close 48 hours before the window', 'cutoff'), gate('A1, A2 and A3 hold.')],
  notice: [planCheck('The spec texts the skipper on a cancellation (T-16).'), build('notice: text the skipper when a booking is cancelled', 'notice'), gate('A1, A2 and A3 hold.')],
};

const intakeNone = (reason1: string, reason2: string) => [
  { issue: 'issue-1', outcome: intakeOutcome.none(reason1) },
  { issue: 'issue-2', outcome: intakeOutcome.none(reason2) },
];

const NO_OP_1 = checkpointAnswer({ decision: 'no-op', issueIntake: intakeNone('guard refuses a second booking of a berth for one window (I-1)', 'taken in at ckpt-1 as an amendment') });

const JOBS_1: readonly Step[] = [
  packReviewStep('review-1', [{
    severity: 'blocking', target: packTargetOf.unit('guard'),
    claim: 'guard\'s spec does not say that a refused booking writes nothing, so a ledger left half-written would pass its gate.',
    evidence: [{ path: 'docs/corpus/0030_Bookings.md', line: 22 }],
  }]),
  packReviewStep('review-2', [{ severity: 'note', target: packTargetOf.unit('confirm'), claim: 'confirm depends on every registered vessel having a phone number; the register has one for each today.' }]),
  lensStep('audit-1', 'vision', [{ severity: 'P3', obligation: null, visionClauses: ['V-5'], claim: DEFERRED_CLAIM, cause: 'no cancellation template is sent', evidence: [{ path: 'src/cli.js', line: 50 }] }]),
  checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'no-op',
    findingDispositions: [{ finding: 'F-1', disposition: 'deferred', reason: 'Cancellations are the next slice\'s scene (V-5), not this one\'s.' }],
    corpusAmendments: [{ ...CHECKPOINT_AMENDMENT, rules: [...CHECKPOINT_AMENDMENT.rules] }],
    issueIntake: [
      { issue: 'issue-1', outcome: intakeOutcome.none('guard refuses a second booking of a berth for one window (I-1 held on the head)') },
      { issue: 'issue-2', outcome: intakeOutcome.amendment([...ISSUE_AMENDMENT.rules], ISSUE_AMENDMENT.proposal) },
    ],
  })),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-2', NO_OP_1),
];

const NO_OP_2 = checkpointAnswer({ decision: 'no-op', issueIntake: intakeNone('fixed in arc 1 (I-1)', 'deferred at Phase 0 as an amendment of arc 1') });

const JOBS_2: readonly Step[] = [
  packReviewStep('review-1', [], [{ type: 'barrier', name: POLICY_FLIP_BARRIER, timeoutMs: HOLD_MS }]),
  lensStep('audit-1', 'vision'),
  checkpointStep('ckpt-1', NO_OP_2),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-2', NO_OP_2),
];

/** The fake backend steps of arc `n` (1 or 2) under `profile`: the start's smoke, the units' calls, the jobs'. */
export function arcSteps(n: 1 | 2, profile: ProfileName): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const units = Object.entries(n === 1 ? UNITS_1 : UNITS_2).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  return [...smoke, ...units, ...(n === 1 ? JOBS_1 : JOBS_2)];
}
