// Fake-backed M4a runs (`driver --fake <script>`): the backend calls of each arc, one scenario per arc (its job ids
// restart at review-1, audit-1, ckpt-1), written by the driver under `fake/arc-<n>/` with its shims; the scripted root
// agent puts arc n's shims first on PATH when it starts arc n. Unit calls are M1 steps keyed by unit (evals/m1/
// scenario.ts), or Claude implementer steps where the unit's builder is the frontier class; pack review, lens and
// checkpoint calls are 0b's scripted judgments keyed by job (and lens). Every plan is `planCheck.shape: by-builder`.
//
//   arc 1   review-1 holds a blocking finding on guard's spec (the hold; the root agent fixes the pack by `apply`), and
//           review-2, on the new key, supersedes it with a note. guard (efficient: the acceptance plan-check) builds a
//           refusal that does not name the vessel holding the berth: its unit lane passes, the berths journey fails,
//           so witness presence sends it back with the failing id (a witness fix round) before any gate. confirm (high
//           risk, frontier: no plan-check call) assesses in session, then implements in the same session; mutation
//           smoke reverts it and its W-1 witness, the tide table's journey, still passes: one smoke fix round, which
//           leaves the test (the behaviour predates the unit), then the gate approves with the survivor in its checks
//           and a note (gate-note debt). audit-1's vision lens opens a P3 with no obligation; ckpt-1 defers it
//           (finding-deferred debt), proposes an amendment (T-11: confirm cancellations by text) and takes in both
//           issues (#1 none, #2 an amendment). Then the final audit and its checkpoint, no-op.
//   arc 2   review-1 waits at the `policy-flip` barrier until the driver has flipped the forge to PUBLIC + ALL (the
//           mid-arc flip, OR-L6); then cutoff builds; audit-1 waits at the `blocked-seen` barrier until the root agent
//           has had the run's blocked wake (notice behind the run-only limit), so its checkpoint capture's blocking
//           item is always a wake of its own; once the owner restored the policy and the root agent acked, ckpt-1
//           takes in both issues and admits `fits` (the opportunity O-1, V-7) and a day view (V-6, over the budget:
//           converted into an amendment); the bundle's drift audit-2 and ckpt-2 run while the run-only limit still holds
//           every unit; then notice builds (the root agent pauses it in its hung `slow` lane and resumes it), audit-3
//           and ckpt-3, fits builds after notice, audit-4 (cadence and final) and ckpt-4.
import type { JsonValue } from '../../src/core/json.ts';
import { ASSESSED_DIRECTIVE } from '../../src/prompts/directives.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { checkpointAnswer, checkpointStep, intakeOutcome, lensStep, packReviewStep, packTargetOf } from '../../test/helpers/holistic.ts';
import type { ClaudeAct, Step } from '../../test/helpers/scenario.ts';
import { type M1Step, fakeSteps } from '../m1/scenario.ts';
import { FILES, LANES, OPPORTUNITY, filesOf, specOf } from './golden.ts';
import { join } from 'node:path';

/** The barrier arc 2's pack review waits at until the driver flipped the forge's policy. */
export const POLICY_FLIP_BARRIER = 'policy-flip';
/** The barrier arc 2's audit-1 waits at until the root agent had the run's blocked wake (fake-root.ts releases it). */
export const BLOCKED_SEEN_BARRIER = 'blocked-seen';
/** Arc 2's checkpoint of the drift audit ckpt-1's bundle owes: the root agent lifts the run-only limit once it decided. */
export const DRIFT_CHECKPOINT = 'ckpt-2';
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

/** The test guard's first attempt fails (witness presence), as the fix round's directive names it. */
const BERTHS_TEST = LANES.find((x) => x.id === 'berths')!.test;
/** confirm's W-1 witness (golden.ts), the test mutation smoke finds surviving. */
const TIDES_TEST = LANES.find((x) => x.id === 'tides')!.test;

/** Units whose builder is an M1 step (the efficient class: Codex under `default`, Claude under `claude-only`). */
const M1_UNITS_1: Readonly<Record<string, readonly M1Step[]>> = {
  guard: [
    planCheck('The spec refuses a second booking of a berth for one window (T-7); scope is the ledger.'),
    build('guard: refuse a berth booked twice for one window', 'guard-first'),
    {
      role: 'build', round: 'resume', stdinContains: [`Failing: test "${BERTHS_TEST}" on lane berths`],
      acts: [{ type: 'commit', message: 'guard: the refusal names the vessel holding the berth', files: filesOf(join(FILES, 'units', 'guard')) }],
    },
    gate('A1 and A2 hold.'),
  ],
};

const IMPLEMENTER = ['-p', '--permission-mode', 'bypassPermissions'];
const report = (summary: string): ClaudeAct => ({ type: 'emit', value: { summary, changedPaths: [], lanesRun: [], blockers: [], experiments: [] } });
const confirmGate = fakeSteps({ steps: [gate('A1, A2 and A3 hold; W-1 survives smoke because the tide table predates the unit.', [{ severity: 'note', path: 'src/confirm.js', text: GATE_NOTE, contractRef: null }])] }, 'default').at(-1)!;

/**
 * confirm, high risk on the frontier class: no plan-check call; one session assesses (read-only), then implements; the
 * smoke fix round resumes it and leaves W-1's test, which passed before the unit; then the gate. The same in both profiles.
 */
const CONFIRM: readonly Step[] = ([
  {
    as: 'claude', expect: { argv: [...IMPLEMENTER, '--session-id'], argvLacks: ['--tools'], stdinContains: ['This invocation is the assessment, not the build.'] },
    acts: [{ type: 'emit', value: { planAssessment: { feasible: true, riskFloor: 'high', visionConflict: [], premises: [], notes: 'confirm.js sends the template; book calls it after the write.' } } }],
  },
  {
    as: 'claude', expect: { argv: [...IMPLEMENTER, '--resume'], argvLacks: ['--tools'], stdinContains: [ASSESSED_DIRECTIVE.slice(0, 60)] },
    acts: [{ type: 'commit', message: 'confirm: text the skipper when a booking is made', files: filesOf(join(FILES, 'units', 'confirm')) }, report('Did the work.')],
  },
  {
    as: 'claude', expect: { argv: [...IMPLEMENTER, '--resume'], argvLacks: ['--tools'], stdinContains: [`Survived: test "${TIDES_TEST}" on lane tides`] },
    acts: [report('W-1\'s test passes without this change because the tide table behaviour predates the unit; left as it is.')],
  },
  confirmGate,
] satisfies Step[]).map((s): Step => ({ ...s, unit: 'confirm' }));

const UNITS_2: Readonly<Record<string, readonly M1Step[]>> = {
  cutoff: [planCheck('The spec closes cancellations 48 hours before the window opens (T-15).'), build('cutoff: cancellations close 48 hours before the window', 'cutoff'), gate('A1, A2 and A3 hold.')],
  notice: [planCheck('The spec texts the skipper on a cancellation (T-16).'), build('notice: text the skipper when a booking is cancelled', 'notice'), gate('A1, A2 and A3 hold.')],
  fits: [planCheck('The spec lists the berths a draught fits (V-7), within the register.'), build('fits: the berths a draught fits', 'fits'), gate('A1 holds.')],
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
  packReviewStep('review-2', [{ severity: 'note', target: packTargetOf.unit('confirm'), claim: 'confirm depends on every registered vessel having a phone number; the register has one for each today.' }], [], [
    { job: 'review-1', index: 0, disposition: 'resolved' },
  ]),
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

/** A checkpoint `admit` of golden.ts's `OPPORTUNITY[id]`: no targeted rule, citing the one clause it advances. */
function admitOp(id: keyof typeof OPPORTUNITY): JsonValue {
  const o = OPPORTUNITY[id];
  const spec = specOf({ id: o.unit.id, scope: o.unit.scope, unitLane: o.unitLane, acceptance: o.acceptance });
  return {
    op: 'admit', unit: { ...o.unit, scope: [...o.unit.scope], after: [...o.unit.after] }, spec: JSON.stringify(spec), targets: [],
    cites: [...o.cites], evidence: [o.why],
  };
}

const JOBS_2: readonly Step[] = [
  packReviewStep('review-1', [], [{ type: 'barrier', name: POLICY_FLIP_BARRIER, timeoutMs: HOLD_MS }]),
  lensStep('audit-1', 'vision', [], [{ type: 'barrier', name: BLOCKED_SEEN_BARRIER, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'bundle', ops: [admitOp('fits'), admitOp('dayview')],
    issueIntake: intakeNone('fixed in arc 1 (I-1)', 'deferred at Phase 0 as an amendment of arc 1'),
  })),
  lensStep('audit-2', 'vision'),
  checkpointStep(DRIFT_CHECKPOINT, NO_OP_2),
  lensStep('audit-3', 'vision'),
  checkpointStep('ckpt-3', NO_OP_2),
  lensStep('audit-4', 'vision'),
  checkpointStep('ckpt-4', NO_OP_2),
];

/** The fake backend steps of arc `n` (1 or 2) under `profile`: the start's smoke, the units' calls, the jobs'. */
export function arcSteps(n: 1 | 2, profile: ProfileName): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const m1 = (units: Readonly<Record<string, readonly M1Step[]>>): readonly Step[] =>
    Object.entries(units).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  return n === 1 ? [...smoke, ...m1(M1_UNITS_1), ...CONFIRM, ...JOBS_1] : [...smoke, ...m1(UNITS_2), ...JOBS_2];
}
