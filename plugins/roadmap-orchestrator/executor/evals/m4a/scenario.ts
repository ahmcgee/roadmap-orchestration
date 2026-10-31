// Fake-backed M4a runs (`driver --fake <script>`): the backend calls of each arc, one scenario per arc (its job ids
// restart at review-1, audit-1, ckpt-1), written by the driver under `fake/arc-<n>/` with its shims; the scripted root
// agent puts arc n's shims first on PATH when it starts arc n. Unit calls are M1 steps keyed by unit (evals/m1/
// scenario.ts); pack review, lens and checkpoint calls are 0b's scripted judgments keyed by job (and lens). Every unit's
// plan-check is one call (dev.17 removed `planCheck.shape: by-builder`) and every build is the efficient class's.
//
//   arc 1   review-1 holds a blocking finding on guard's spec (the hold; the root agent fixes the pack by `apply`), and
//           review-2, on the new key, supersedes it with a note. guard builds a
//           refusal that does not name the vessel holding the berth: its unit lane passes, the berths journey fails,
//           so witness presence sends it back with the failing id (a witness fix round) before any gate. confirm (high
//           risk) is plan-checked and built like the others; mutation smoke reverts it and its W-1 witness, the tide table's journey, still passes: one smoke fix round, which
//           leaves the test (the behaviour predates the unit), then the gate approves with the survivor in its checks
//           and a note (gate-note debt). audit-1's vision lens opens a P2 with no obligation; ckpt-1 defers it
//           (finding-deferred debt) and proposes two amendments (T-11: confirm cancellations by text; T-5: list the
//           high-water heights). Then the six read-outs (one module each: plan-check, build, gate), with
//           audit-2..audit-5; audit-2..audit-4 find nothing new and have no checkpoint (checkpoint-skipped), and the
//           final audit-5's checkpoint, ckpt-2, no-ops.
//   arc 2   review-1, then cutoff builds; audit-1 waits at the `blocked-seen` barrier until the root agent has had the
//           run's blocked wake (notice behind the run-only limit), so the checkpoints run while that turn supervises in
//           place; ckpt-1 admits `fits` (the opportunity O-1, V-7, with its witness: I-4 split into I-13 and
//           fits' I-14 on the berths journey, golden.ts `FITS_WITNESS`) and a day view (V-6, over the budget: converted
//           into an amendment); the bundle's drift audit-2 (noting a new gap) and ckpt-2 run while the run-only limit
//           still holds every unit; then notice builds (the root agent pauses it in its hung `slow` lane and resumes
//           it), audit-3 (nothing new: no checkpoint), fits builds after notice, audit-4 (cadence and final) and ckpt-3.
//
import { join } from 'node:path';
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { admitSpecWire,checkpointAnswer,checkpointStep,lensStep,noteLensStep,packReviewStep,packTargetOf } from '../../test/helpers/holistic.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { type M1Step,fakeSteps } from '../m1/scenario.ts';
import type { FakeScript } from './fake-root.ts';
import { FILES,FITS_WITNESS,LANES,OBLIGATIONS,OPPORTUNITY,READOUTS,REPLAY_LANE,SHARD,SUITE_LANE,filesOf,specOf } from './golden.ts';
import { PLANT } from './layout.ts';

/** The barrier arc 2's audit-1 waits at until the root agent had the run's blocked wake (fake-root.ts releases it). */
export const BLOCKED_SEEN_BARRIER = 'blocked-seen';
/** Arc 2's checkpoint of the drift audit ckpt-1's bundle owes: the root agent lifts the run-only limit once it decided. */
export const DRIFT_CHECKPOINT = 'ckpt-2';
const HOLD_MS = 20 * 60_000;

const planCheck = (reason: string): M1Step => ({
  role: 'planCheck',
  answer: { decision: 'approve', reasons: [reason], patch: null, risk: 'low', notes: '', premises: [], visionConflict: [],  staleLinks: [] },
});
const build = (message: string, unit: string): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files: filesOf(join(FILES, 'units', unit)) }] });
const gate = (reason: string, findings: readonly JsonValue[] = []): M1Step => ({
  role: 'gate',
  answer: {rulings: [],
    decision: 'approve', findings: findings.map((f) => ({ ...(f as object), defect: null, reraises: null, hunk: null })), directives: [], reasons: [reason], premises: [], unreviewed: [],
    clusters: null,
  },
});

/** The gate note confirm's approval carries: banked as `gate-note` debt. */
/** Why the note is debt (dev.13: only a note naming its drag on later work banks). */
export const GATE_NOTE_DRAG = 'Every later message template copies this sign-off, so each one would need the same rename.';
export const GATE_NOTE = 'The confirmation text signs off as "Tidewater" where the harbour\'s own name would read better to a skipper.';
/** The lens P2 ckpt-1 defers (dev.13: a P3 is never debt): banked as `finding-deferred` debt, which arc 2 promotes to `notice`. */
export const DEFERRED_CLAIM = '`cancel` leaves the skipper nothing to keep: unlike a booking, a cancellation sends no text.';
/** ckpt-1's proposed amendment (source checkpoint), applied in arc 2 as T-24. */
export const CHECKPOINT_AMENDMENT = { rules: ['T-11'], proposal: 'Add a rule: a cancellation is confirmed to the skipper by text message, as a booking is.', why: 'V-5 asks that a cancellation be as clear to the skipper as a booking; only bookings are confirmed today.' } as const;
/** ckpt-1's second proposed amendment (source checkpoint), deferred in arc 2. */
export const HEIGHTS_AMENDMENT = { rules: ['T-5'], proposal: 'Windows list the high-water height from the printed table beside each time.', why: 'The printed sheet the harbour hands out lists the heights; the windows command shows only the times.' } as const;

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

/**
 * confirm, high risk: plan-checked, built, then the smoke fix round resumes the build session and leaves W-1's test, which
 * passed before the unit; then the gate with its note.
 */
const CONFIRM: Readonly<Record<string, readonly M1Step[]>> = {
  confirm: [
    { role: 'planCheck', answer: { decision: 'approve', reasons: ['confirm.js sends the template; book calls it after the write.'], patch: null, risk: 'high', notes: '', premises: [], visionConflict: [],  staleLinks: [] } },
    build('confirm: text the skipper when a booking is made', 'confirm'),
    { role: 'build', round: 'resume', stdinContains: [`Survived: test "${TIDES_TEST}" on lane tides`], acts: [] },
    gate('A1, A2 and A3 hold; W-1 survives smoke because the tide table predates the unit.', [{ severity: 'note', path: 'src/confirm.js', text: GATE_NOTE, contractRef: null, experiments: [], debt: { drag: GATE_NOTE_DRAG } }]),
  ],
};

const UNITS_2: Readonly<Record<string, readonly M1Step[]>> = {
  cutoff: [planCheck('The spec closes cancellations 48 hours before the window opens (T-23).'), build('cutoff: cancellations close 48 hours before the window', 'cutoff'), gate('A1, A2 and A3 hold.')],
  notice: [planCheck('The spec texts the skipper on a cancellation (T-24).'), build('notice: text the skipper when a booking is cancelled', 'notice'), gate('A1, A2 and A3 hold.')],
  fits: [planCheck('The spec lists the berths a draught fits (V-7), within the register.'), build('fits: the berths a draught fits', 'fits'), gate('A1 holds.')],
};

const NO_OP = checkpointAnswer({ decision: 'no-op' });

const JOBS_1: readonly Step[] = [
  packReviewStep('review-1', [{
    severity: 'blocking', target: packTargetOf.unit('guard'),
    claim: 'guard\'s spec does not say that a refused booking writes nothing, so a ledger left half-written would pass its gate.',
    evidence: [{ path: 'docs/corpus/0030_Bookings.md', line: 22 }],
  }]),
  packReviewStep('review-2', [{ severity: 'note', target: packTargetOf.unit('confirm'), claim: 'confirm depends on every registered vessel having a phone number; the register has one for each today.' }], [], [
    { job: 'review-1', index: 0, disposition: 'resolved' },
  ]),
  lensStep('audit-1', 'vision', [{ severity: 'P2', obligation: null, visionClauses: ['V-5'], claim: DEFERRED_CLAIM, cause: 'no cancellation template is sent', evidence: [{ path: 'src/cli.js', line: 50 }] }]),
  checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'no-op',
    findingDispositions: [{ finding: 'F-1', disposition: 'deferred', reason: 'Cancellations are the next slice\'s scene (V-5), not this one\'s.' }],
    corpusAmendments: [CHECKPOINT_AMENDMENT, HEIGHTS_AMENDMENT],
  })),
  // The read-outs' publications owe four more cadence audits, the last the final one. audit-2..audit-4 find nothing new
  // after the settled ckpt-1, so they have no checkpoint (checkpoint-skipped); the final audit's is ckpt-2.
  lensStep('audit-2', 'vision'),
  lensStep('audit-3', 'vision'),
  lensStep('audit-4', 'vision'),
  lensStep('audit-5', 'vision'), checkpointStep('ckpt-2', NO_OP),
];

/** A checkpoint `admit` of golden.ts's `OPPORTUNITY[id]`: its targets, citing the one clause it advances. */
function admitOp(id: keyof typeof OPPORTUNITY): JsonValue {
  const o = OPPORTUNITY[id];
  const spec = specOf({ id: o.unit.id, systems: o.unit.systems, unitLane: o.unitLane, acceptance: o.acceptance });
  return {
    op: 'admit', unit: { ...o.unit, systems: [...o.unit.systems], after: [...o.unit.after] }, spec: admitSpecWire(spec), targets: [...o.targets],
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
  packReviewStep('review-1'),
  lensStep('audit-1', 'vision', [], [{ type: 'barrier', name: BLOCKED_SEEN_BARRIER, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-1', checkpointAnswer({
    decision: 'bundle', ops: [admitOp('fits'), admitOp('dayview'), fitsWitnessOp()],
  })),
  // The drift audit notes a new gap (F-1), so its checkpoint runs (the root agent waits on it) and dismisses it, leaving no
  // debt; audit-3 finds nothing new after it (checkpoint-skipped), and the final audit-4's checkpoint is ckpt-3.
  noteLensStep('audit-2'),
  checkpointStep(DRIFT_CHECKPOINT, checkpointAnswer({
    decision: 'no-op',
    findingDispositions: [{ finding: 'F-1', disposition: 'dismissed', reason: 'The noted gap is not this slice\'s.' }],
  })),
  lensStep('audit-3', 'vision'),
  lensStep('audit-4', 'vision'),
  checkpointStep('ckpt-3', NO_OP),
];

/** The fake backend steps of arc `n` (1 or 2) under `profile` for `script`: the start's smoke, the units' calls, the jobs'. */
export function arcSteps(n: 1 | 2, profile: ProfileName, script: FakeScript): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const m1 = (units: Readonly<Record<string, readonly M1Step[]>>): readonly Step[] =>
    Object.entries(units).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  const story = script === 'story';
  if (n === 2) return [...smoke, ...m1(UNITS_2), ...JOBS_2];
  return [...smoke, ...m1(M1_UNITS_1), ...m1(M1_READOUTS), ...m1(CONFIRM), ...JOBS_1];
}
