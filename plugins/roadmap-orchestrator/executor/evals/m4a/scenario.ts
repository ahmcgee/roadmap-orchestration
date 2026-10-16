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
//           issues (#1 none, #2 an amendment). Then the six read-outs (one module each: plan-check, build, gate), with
//           audit-2..audit-5; audit-2..audit-4 find nothing new and have no checkpoint (checkpoint-skipped), and the
//           final audit-5's checkpoint, ckpt-2, no-ops.
//   arc 2   review-1 waits at the `policy-flip` barrier until the driver has flipped the forge to PUBLIC + ALL (the
//           mid-arc flip, OR-L6); then cutoff builds; audit-1 waits at the `blocked-seen` barrier until the root agent
//           has had the run's blocked wake (notice behind the run-only limit), so its checkpoint capture's blocking
//           item is always a wake of its own; once the owner restored the policy and the root agent acked, ckpt-1
//           takes in both issues and admits `fits` (the opportunity O-1, V-7, with its witness: I-4 split into I-13 and
//           fits' I-14 on the berths journey, golden.ts `FITS_WITNESS`) and a day view (V-6, over the budget: converted
//           into an amendment); the bundle's drift audit-2 (noting a new gap) and ckpt-2 run while the run-only limit
//           still holds every unit; then notice builds (the root agent pauses it in its hung `slow` lane and resumes
//           it), audit-3 (nothing new: no checkpoint), fits builds after notice, audit-4 (cadence and final) and ckpt-3.
//
// M4b (the flow loop): every checkpoint also takes in issue #4 (drop the soak test: none, T-16). Arc 1, in both scripts,
// has the six read-outs after confirm (golden.ts `READOUTS`, one unit each), and run-only holds every unit after
// quay-list until the flow loop has run (three suite runs before the change, confirm's smoke fix round among them,
// outside the rework guard's window). `story`: two flow runs the root agent requests (the second the cooldown's one
// bypass, RC-5): flow-1 proposes the bait, the witness-lane fake `replay` at `--test-concurrency=6` (accepted; its proof
// is `changed`); flow-2 the plant lane `suite` at six files a time (accepted; proof `preserved`, applied, then the other
// five read-outs are its verdict window's suite runs). `vision-silent`: the third merge's constraint-shift run, flow-1,
// answers noAction. Arc 1's eight publications owe audit-1..audit-5; ckpt-1 and the final ckpt-2 run. Arc 2 carries arc 1's
// suite lanes; the root agent requests one flow run right after the start (flow-1: a build-class step it rejects on its
// item's wake), so its cooldown covers the arc. The flow calls are judgment steps keyed by job id (`flow-<n>`), each
// answer checked by the frozen reader (FLOW_SCHEMA).
import type { JsonValue } from '../../src/core/json.ts';
import { ASSESSED_DIRECTIVE } from '../../src/prompts/directives.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { validateFlowOutput } from '../../src/prompts/schemas.ts';
import { admitSpecWire, checkpointAnswer, checkpointStep, intakeOutcome, lensStep, noteLensStep, packReviewStep, packTargetOf } from '../../test/helpers/holistic.ts';
import type { ClaudeAct, Step } from '../../test/helpers/scenario.ts';
import { type M1Step, fakeSteps } from '../m1/scenario.ts';
import { FILES, FITS_WITNESS, LANES, OBLIGATIONS, OPPORTUNITY, READOUTS, REPLAY_LANE, SHARD, SUITE_LANE, filesOf, specOf } from './golden.ts';
import type { FakeScript } from './fake-root.ts';
import { PLANT } from './layout.ts';
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
  answer: { decision: 'approve', reasons: [reason], patch: null, risk: 'low', notes: '', premises: [], visionConflict: [], scopeGrowth: [] },
});
const build = (message: string, unit: string): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files: filesOf(join(FILES, 'units', unit)) }] });
const gate = (reason: string, findings: readonly JsonValue[] = []): M1Step => ({
  role: 'gate', answer: { decision: 'approve', findings: [...findings], directives: [], reasons: [reason], premises: [] },
});

/** The gate note confirm's approval carries: banked as `gate-note` debt. */
export const GATE_NOTE = 'The confirmation text signs off as "Tidewater" where the harbour\'s own name would read better to a skipper.';
/** The lens P3 ckpt-1 defers: banked as `finding-deferred` debt, which arc 2 promotes to `notice`. */
export const DEFERRED_CLAIM = '`cancel` leaves the skipper nothing to keep: unlike a booking, a cancellation sends no text.';
/** ckpt-1's proposed amendment (source checkpoint), applied in arc 2 as T-24. */
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

/** Arc 1's read-outs (golden.ts `READOUTS`): one new module each, plan-checked, built and gated. */
const M1_READOUTS: Readonly<Record<string, readonly M1Step[]>> = Object.fromEntries(READOUTS.map((r) => [r.unit, [
  planCheck(`The spec adds ${r.module} and its test, one new module (${r.rule}).`), build(`${r.unit}: ${r.text}`, r.unit), gate('A1 holds.'),
]]));

const IMPLEMENTER = ['-p', '--permission-mode', 'bypassPermissions'];
const report = (summary: string): ClaudeAct => ({ type: 'emit', value: { summary, changedPaths: [], lanesRun: [], blockers: [], experiments: [], final: true } });
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
  cutoff: [planCheck('The spec closes cancellations 48 hours before the window opens (T-23).'), build('cutoff: cancellations close 48 hours before the window', 'cutoff'), gate('A1, A2 and A3 hold.')],
  notice: [planCheck('The spec texts the skipper on a cancellation (T-24).'), build('notice: text the skipper when a booking is cancelled', 'notice'), gate('A1, A2 and A3 hold.')],
  fits: [planCheck('The spec lists the berths a draught fits (V-7), within the register.'), build('fits: the berths a draught fits', 'fits'), gate('A1 holds.')],
};

/** Every checkpoint's intake of issue #4 (plant G): declined, the soak rule stands. */
export const SOAK_DECLINED = 'The soak run stays in the suite gate (T-16): it guards the ledger, which V-2 will not give up; slow and green is it doing its job.';
const soakIntake = { issue: PLANT.soakIssue, outcome: intakeOutcome.none(SOAK_DECLINED) };

const intakeNone = (reason1: string, reason2: string) => [
  { issue: 'issue-1', outcome: intakeOutcome.none(reason1) },
  { issue: 'issue-2', outcome: intakeOutcome.none(reason2) },
  soakIntake,
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
      soakIntake,
    ],
  })),
  // The read-outs' publications owe four more cadence audits, the last the final one. audit-2..audit-4 find nothing new
  // after the settled ckpt-1, so they have no checkpoint (checkpoint-skipped); the final audit's is ckpt-2.
  lensStep('audit-2', 'vision'),
  lensStep('audit-3', 'vision'),
  lensStep('audit-4', 'vision'),
  lensStep('audit-5', 'vision'), checkpointStep('ckpt-2', NO_OP_1),
];

const NO_OP_2 = checkpointAnswer({ decision: 'no-op', issueIntake: intakeNone('fixed in arc 1 (I-1)', 'deferred at Phase 0 as an amendment of arc 1') });

/** A checkpoint `admit` of golden.ts's `OPPORTUNITY[id]`: its targets, citing the one clause it advances. */
function admitOp(id: keyof typeof OPPORTUNITY): JsonValue {
  const o = OPPORTUNITY[id];
  const spec = specOf({ id: o.unit.id, scope: o.unit.scope, unitLane: o.unitLane, acceptance: o.acceptance });
  return {
    op: 'admit', unit: { ...o.unit, scope: [...o.unit.scope], after: [...o.unit.after] }, spec: admitSpecWire(spec), targets: [...o.targets],
    cites: [...o.cites], evidence: [o.why],
  };
}

/** fits' witness (golden.ts `FITS_WITNESS`): I-4 split into its restatement and the draught child fits delivers. */
function fitsWitnessOp(): JsonValue {
  const w = FITS_WITNESS;
  const parent = OBLIGATIONS.find((o) => o.id === w.parent)!;
  const seed = LANES.find((x) => x.id === parent.lane)!;
  const test = seed.test;
  const childFile = LANES.find((x) => x.id === w.child.lane)!.journey;
  return {
    op: 'obligation-split', obligation: w.parent, cites: [...w.cites], evidence: [w.why],
    children: [
      { id: w.restated, statement: parent.statement, docRef: null, rule: parent.rule, witness: { lane: parent.lane, testIds: [test], files: [seed.journey] }, activation: 'must-hold', deliveredBy: [] },
      { id: w.child.id, statement: w.child.statement, docRef: null, rule: w.child.rule, witness: { lane: w.child.lane, testIds: [w.child.test], files: [childFile] }, activation: 'future', deliveredBy: ['fits'] },
    ],
  };
}

const JOBS_2: readonly Step[] = [
  packReviewStep('review-1', [], [{ type: 'barrier', name: POLICY_FLIP_BARRIER, timeoutMs: HOLD_MS }]),
  lensStep('audit-1', 'vision', [], [{ type: 'barrier', name: BLOCKED_SEEN_BARRIER, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'bundle', ops: [admitOp('fits'), admitOp('dayview'), fitsWitnessOp()],
    issueIntake: intakeNone('fixed in arc 1 (I-1)', 'deferred at Phase 0 as an amendment of arc 1'),
  })),
  // The drift audit notes a new gap (F-1), so its checkpoint runs (the root agent waits on it) and dismisses it, leaving no
  // debt; audit-3 finds nothing new after it (checkpoint-skipped), and the final audit-4's checkpoint is ckpt-3.
  noteLensStep('audit-2'),
  checkpointStep(DRIFT_CHECKPOINT, checkpointAnswer({
    decision: 'no-op', issueIntake: intakeNone('fixed in arc 1 (I-1)', 'deferred at Phase 0 as an amendment of arc 1'),
    findingDispositions: [{ finding: 'F-1', disposition: 'dismissed', reason: 'The noted gap is not this slice\'s.' }],
  })),
  lensStep('audit-3', 'vision'),
  lensStep('audit-4', 'vision'),
  checkpointStep('ckpt-3', NO_OP_2),
];

// ---------------------------------------------------------------------------------------------------
// The flow runs (M4b)

/** A flow call of job `job` (a `flow-n`) answers `answer`, checked by the frozen reader so the fake never emits what the executor could not be given. */
function flowStep(job: string, answer: JsonValue): Step {
  validateFlowOutput(answer);
  return { as: 'claude', unit: job, expect: {}, acts: [{ type: 'emit', value: answer }] };
}

const SLOT = 'slot:integration';
const suiteAction = (lane: string, argv: readonly string[], cpu: number): JsonValue => ({ lever: 'suite-lane', lane, argv: [...argv], reporter: 'node-test', cpu });

/** Arc 1's flow runs in order, each a proposal the root agent decides (fake-root.ts `flowLoop`). */
export const FLOW_1 = {
  bait: {
    job: 'flow-1', decision: 'accept', proof: 'changed',
    request: 'guard, confirm and quay-list merged after most of their lead in the integration slot, the suite one file at a time; please look at the slot before the next unit is admitted.',
    reason: 'An in-place --test-concurrency edit of the replay lane, no selector touched: accepted, the proof decides whether its tests survive it.',
    answer: {
      constraint: { station: SLOT, agree: false, reason: 'guard held the integration slot longest; I read the replay lane as the piece to shorten' },
      diagnosis: 'guard\'s lead was mostly the integration slot, its suite lanes run one file at a time.',
      proposal: {
        target: `suite:${REPLAY_LANE.id}`, action: suiteAction(REPLAY_LANE.id, REPLAY_LANE.argv.map((a) => (a === PLANT.serial ? '--test-concurrency=6' : a)), 6),
        rationale: 'Run the replay lane six files at a time.', risks: 'A replay check that depends on order may not survive.',
      },
      noAction: null,
    },
  },
  shard: {
    job: 'flow-2', decision: 'accept', proof: 'preserved',
    request: `The replay lane change was refused by its proof (changed); the serial suite:${SUITE_LANE} is still what held guard in the slot.`,
    reason: 'The serial flag is stale: every test file makes its own temp dir (0050_Architecture.md, Testing), so the shared-ledger reason is gone; the proof shows the same tests either way.',
    answer: {
      constraint: { station: SLOT, agree: true, reason: `the slot is the constraint and suite:${SUITE_LANE}, the serial suite gate, is most of it` },
      diagnosis: `suite:${SUITE_LANE} runs six replay files of about a minute one at a time; each makes its own temp dir, so they can run side by side.`,
      proposal: {
        target: `suite:${SUITE_LANE}`, action: suiteAction(SUITE_LANE, SHARD.argv, SHARD.cpu),
        rationale: 'Six files at a time in place of one: the same tests, about a sixth of the wall time.', risks: 'Tests that shared state would race; none do since the temp-dir change.',
      },
      noAction: null,
    },
  },
} as const;

/**
 * Arc 2's one flow run, requested right after the start (its cooldown covers the arc, so no constraint-shift run is left
 * to the merges' timing): a build-class step, which the root agent rejects on the item's wake (fake-root.ts).
 */
export const FLOW_2 = {
  buildClass: {
    job: 'flow-1', decision: 'reject', proof: null,
    request: `Arc 1's change to suite:${SUITE_LANE} is carried into this plan; please look at the slot before the first merge.`,
    reason: 'Arc 1\'s lead went to the serial suite in the slot, not to builds, and the suite is sharded now: a dearer builder buys nothing here.',
    answer: {
      constraint: { station: SLOT, agree: false, reason: 'nothing merged yet; red candidates held arc 1\'s slot, fewer of them shortens it' },
      diagnosis: 'guard took two builds in arc 1 before its lanes went green.',
      proposal: { target: SLOT, action: { lever: 'build-class', tier: 'low', class: 'frontier' }, rationale: 'One class up for low-risk builds.', risks: 'Cost per merge rises.' },
      noAction: null,
    },
  },
} as const;

/** `vision-silent`'s one flow run (arc 1's third merge, constraint-shift): nothing to change. */
export const VISION_SILENT_FLOW: JsonValue = {
  constraint: { station: SLOT, agree: true, reason: 'the integration slot is the largest station' },
  diagnosis: 'three merges are too few to tell the slot\'s suite time from noise.',
  proposal: null,
  noAction: 'Three merges so far: wait for more before changing the suite gate.',
};

/** The fake backend steps of arc `n` (1 or 2) under `profile` for `script`: the start's smoke, the units' calls, the jobs'. */
export function arcSteps(n: 1 | 2, profile: ProfileName, script: FakeScript): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const m1 = (units: Readonly<Record<string, readonly M1Step[]>>): readonly Step[] =>
    Object.entries(units).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  const story = script === 'story';
  if (n === 2) return [...smoke, ...m1(UNITS_2), ...JOBS_2, ...(story ? [flowStep(FLOW_2.buildClass.job, FLOW_2.buildClass.answer)] : [])];
  const flow = story ? Object.values(FLOW_1).map((f) => flowStep(f.job, f.answer)) : [flowStep('flow-1', VISION_SILENT_FLOW)];
  return [...smoke, ...m1(M1_UNITS_1), ...m1(M1_READOUTS), ...CONFIRM, ...JOBS_1, ...flow];
}
