// Free M4a fixture scenarios: scripted root sessions drive the real staged CLI and fake backends.
// Arc 1 covers pack review, a witness fix, high-risk Opus builds, smoke survival, campaign audit and flow changes.
// Arc 2 covers root-authored opportunity admission, a paused lane and its reuse, and a rejected flow proposal.
// Both profiles share the story; high-risk builds use Claude, while eligible low-risk builds follow the profile.
import { join } from 'node:path';
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName,RiskTier } from '../../src/routing/types.ts';
import { lensStep, packReviewStep, packTargetOf } from '../../test/helpers/holistic.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { type M1Step,fakeSteps } from '../m1/scenario.ts';
import type { FakeScript } from './fake-root.ts';
import { FILES,LANES,READOUTS,REPLAY_LANE,SHARD,SUITE_LANE,filesOf } from './golden.ts';
import { PLANT } from './layout.ts';

/** The barrier arc 2's audit-1 waits at until the root agent had the run's blocked wake (fake-root.ts releases it). */
export const BLOCKED_SEEN_BARRIER = 'blocked-seen';
const HOLD_MS = 20 * 60_000;

const preBuild = (reason: string): M1Step => ({
  role: 'verifier',
  answer: {decision: 'approve', ordering: null, findings: [], directives: [], reasons: [reason], premises: [], standing: [], clusters: null, rulings: []},
});
const build = (message: string, unit: string): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files: filesOf(join(FILES, 'units', unit)) }] });
const gate = (reason: string, findings: readonly JsonValue[] = []): M1Step => ({
  role: 'gate',
  answer: {rulings: [],
    decision: 'approve', findings: findings.map((f) => ({ ...(f as object), defect: null, reraises: null, hunk: null })), directives: [], reasons: [reason], premises: [], standing: [],
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
    preBuild('The spec refuses a second booking of a berth for one window (T-7); scope is the ledger.'),
    build('guard: refuse a berth booked twice for one window', 'guard-first'),
    {
      role: 'build', round: 'resume', stdinContains: [`Failing: test "${BERTHS_TEST}" on lane berths`],
      acts: [{ type: 'commit', message: 'guard: the refusal names the vessel holding the berth', files: filesOf(join(FILES, 'units', 'guard')) }],
    },
    gate('A1 and A2 hold.'),
  ],
};

/** Arc 1's read-outs (golden.ts `READOUTS`): one new module each, pre-builded, built and gated. */
const M1_READOUTS: Readonly<Record<string, readonly M1Step[]>> = Object.fromEntries(READOUTS.map((r) => [r.unit, [
  preBuild(`The spec adds ${r.module} and its test, one new module (${r.rule}).`), build(`${r.unit}: ${r.text}`, r.unit), gate('A1 holds.'),
]]));

/**
 * confirm, high risk: pre-builded, built, then the smoke fix round resumes the build session and leaves W-1's test, which
 * passed before the unit; then the gate with its note.
 */
const CONFIRM: Readonly<Record<string, readonly M1Step[]>> = {
  confirm: [
    preBuild('confirm.js sends the template; book calls it after the write.'),
    build('confirm: text the skipper when a booking is made', 'confirm'),
    { role: 'build', round: 'resume', stdinContains: [`Survived: test "${TIDES_TEST}" on lane tides`], acts: [] },
    gate('A1, A2 and A3 hold; W-1 survives smoke because the tide table predates the unit.', [{evidence: ["src/confirm.js:1"],  severity: 'note', path: 'src/confirm.js', text: GATE_NOTE, contractRef: null, experiments: [], debt: { drag: GATE_NOTE_DRAG } }]),
  ],
};

const UNITS_2: Readonly<Record<string, readonly M1Step[]>> = {
  cutoff: [preBuild('The spec closes cancellations 48 hours before the window opens (T-23).'), build('cutoff: cancellations close 48 hours before the window', 'cutoff'), gate('A1, A2 and A3 hold.')],
  notice: [preBuild('The spec texts the skipper on a cancellation (T-24).'), build('notice: text the skipper when a booking is cancelled', 'notice'), gate('A1, A2 and A3 hold.')],
  fits: [preBuild('The spec lists the berths a draught fits (V-7), within the register.'), build('fits: the berths a draught fits', 'fits'), gate('A1 holds.')],
};

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

  lensStep('audit-2', 'invariants'),
];

const JOBS_2: readonly Step[] = [
  packReviewStep('review-1'),
  lensStep('audit-1', 'invariants', [], [{type: 'barrier', name: BLOCKED_SEEN_BARRIER, timeoutMs: HOLD_MS}]),
  lensStep('audit-2', 'invariants'),
];

/** The fake backend steps of arc `n` (1 or 2) under `profile` for `script`: the start's smoke, the units' calls, the jobs'. */
export function arcSteps(n: 1 | 2, profile: ProfileName, script: FakeScript): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const m1 = (units: Readonly<Record<string, readonly M1Step[]>>, risk: RiskTier = 'low'): readonly Step[] =>
    Object.entries(units).flatMap(([unit, steps]) => fakeSteps({ steps }, profile, risk).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  if (n === 2) return [...smoke, ...m1(UNITS_2), ...JOBS_2];
  return [...smoke, ...m1(M1_UNITS_1), ...m1(M1_READOUTS), ...m1(CONFIRM, 'high'), ...JOBS_1];
}
