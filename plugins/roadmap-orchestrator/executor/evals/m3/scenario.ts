// Fake-backed M3 runs (`driver --fake <story>`): the story plays the plan's eleven steps against the fake backends.
// Unit calls are M1 scenario steps by role (evals/m1/scenario.ts), translated for the profile and keyed by unit
// (test/helpers/scenario.ts `Step.unit`); lens and checkpoint calls are 0b's scripted judgments
// (test/helpers/holistic.ts), keyed by job and lens (`lens: <kind>` in the lens prompt). The backend smoke of the
// one start is prepended, unkeyed. Each story opens with the corpus arc's pack review (`review-1`, M4a: before the
// first admission), answered with no finding. Stories are code, not JSON files: the checkpoint's admit op carries the repair
// spec's text (evals/m3/setup.ts `repairSpecText`) and every judgment is validated by the frozen readers here.
//
//   story      branch R (regressed), the plan's story, plus the literal partial bundle (A18, G19): after the stale
//              rejection (ckpt-1, held at the fake barrier `ckpt-1.hold` until the driver's `apply` is applied), ckpt-2
//              answers the repair admit followed by an invalid op (`twoOpBundleSecondInvalid`): rejected invalid,
//              nothing applied; its one re-evaluation (ckpt-3) admits the repair alone. Then audit-2 (drift: the
//              vision lens) and ckpt-4 no-op, audit-3 (final: both lenses of L) and ckpt-5 no-op.
//   prevented  branch P, after paid run 3: tidy's plan-check twice answers `infeasible` with a V-2 vision conflict
//              (one P3 finding), so tidy parks for design; the park's checkpoint ckpt-1 is held and rejected stale,
//              its re-evaluation ckpt-2 cuts tidy and admits the repair (repairing the P3). Then audit-1 (drift: the
//              vision lens) and ckpt-3 no-op; report and the repair merge; audit-2 (final: both lenses) and ckpt-4
//              no-op.
//   latent     branch L, after paid run 9: tidy's build rounds through formatAmount before formatDisplay, so I-2's
//              witness holds on S while `format` still renders through a binary Number (large amounts lose cents).
//              audit-1's invariants lens opens a P1 over I-2 (F-1); ckpt-1, held, is rejected stale; ckpt-2 admits the
//              repair (repairing F-1) and leaves the P1 undispositioned. Then audit-2 (drift: the vision lens) and ckpt-3
//              no-op; report and the repair merge; audit-3 (final: both lenses) and ckpt-4 no-op.
import { join } from 'node:path';
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import { INVALID_OP, checkpointAnswer, checkpointStep, lensStep, packReviewStep, twoOpBundleSecondInvalid } from '../../test/helpers/holistic.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { type M1Step, fakeSteps } from '../m1/scenario.ts';
import { FAKE_CKPT_HOLD } from './layout.ts';
import { FILES, REPAIR_UNIT, filesOf, repairSpecText } from './setup.ts';

/** How long a fake barrier waits for the driver (the driver's fake run timeout is shorter). */
const HOLD_MS = 20 * 60_000;

const planCheck = (reason: string): M1Step => ({
  role: 'planCheck',
  answer: { decision: 'approve', reasons: [reason], patch: null, risk: 'med', notes: '', premises: [], visionConflict: [] },
});
const build = (message: string, files: Readonly<Record<string, string>>): M1Step => ({ role: 'build', round: 'fresh', acts: [{ type: 'commit', message, files }] });
const gate = (reason: string): M1Step => ({ role: 'gate', answer: { decision: 'approve', findings: [], directives: [], reasons: [reason], premises: [] } });

/** The files of fake build `name` (evals/m3/files/units/<name>/), by repo path. */
const unitFiles = (name: string): Readonly<Record<string, string>> => filesOf(join(FILES, 'units', name));

/** The unit calls of branch R's story, by unit, in each unit's own order. */
export const UNIT_STORY: Readonly<Record<string, readonly M1Step[]>> = {
  parse: [
    planCheck('The spec is consistent with the ledger contract (ledger file) and C-1, C-2, C-4.'),
    build('parse: parseLedger', unitFiles('parse')),
    gate('A1, A2 and A3 hold.'),
  ],
  tidy: [
    planCheck('The spec is a one-line consistency change in src/cli.js; C-3 holds.'),
    build('tidy: format prints through formatDisplay, as total does', unitFiles('tidy')),
    gate('A1 and A2 hold: format and total print through the same helper.'),
  ],
  report: [
    planCheck('The spec is consistent with the ledger contract (commands) and C-1 to C-4.'),
    build('report: reconcile a month', { ...unitFiles('report'), ...unitFiles('report-on-tidy') }),
    gate('A1, A2 and A3 hold; unknown commands still exit 2.'),
  ],
  [REPAIR_UNIT.id]: [
    planCheck('The repair restores I-2 within the unit\'s scope.'),
    build('fix-rounding: formatDisplay rounds the cents half to even', unitFiles(REPAIR_UNIT.id)),
    gate('A1 and A2 hold.'),
  ],
};

/** The checkpoint's repair admit: origin repair, citing V-2, evidence naming the witness P1 (F-1, the first finding). */
const ADMIT_REPAIR: JsonValue = {
  op: 'admit', unit: { ...REPAIR_UNIT, scope: [...REPAIR_UNIT.scope], after: [...REPAIR_UNIT.after] }, spec: repairSpecText(),
  cites: ['V-2'], evidence: ['F-1: I-2 not held on the integration head since tidy routed `format` through formatDisplay, whose toFixed prints 0.125 as 0.13'],
};
const REPAIR_BUNDLE = checkpointAnswer({ decision: 'bundle', ops: [ADMIT_REPAIR] });
const NO_OP = checkpointAnswer({ decision: 'no-op' });

/** The corpus arc's pack review (M4a), before the first admission: no finding, so nothing holds admission. */
const PACK_REVIEW = packReviewStep('review-1');

const JOB_STEPS_R: readonly Step[] = [
  PACK_REVIEW,
  lensStep('audit-1', 'vision'),
  lensStep('audit-1', 'invariants'),
  checkpointStep('ckpt-1', REPAIR_BUNDLE, [{ type: 'barrier', name: FAKE_CKPT_HOLD, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-2', twoOpBundleSecondInvalid(ADMIT_REPAIR, INVALID_OP)),
  checkpointStep('ckpt-3', REPAIR_BUNDLE),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-4', NO_OP),
  lensStep('audit-3', 'invariants'),
  lensStep('audit-3', 'vision'),
  checkpointStep('ckpt-5', NO_OP),
];

/** tidy's plan-check in branch P, as paid run 3's: infeasible within its scope, citing V-2 (a P3 finding, merged on the re-check). */
const INFEASIBLE: M1Step = {
  role: 'planCheck',
  answer: {
    decision: 'infeasible', reasons: ['Routing `format` through formatDisplay breaks I-2: its toFixed prints 0.125 as 0.13; nothing within src/cli.js reconciles A1 with I-2.'],
    patch: null, risk: 'med', notes: 'Drop the unit, or re-scope a unit to src/display.js so formatDisplay rounds half to even.', premises: [],
    visionConflict: [{ clauses: ['V-2'], note: 'format through formatDisplay silently mis-rounds money (0.125 prints 0.13)' }],
  },
};

/** The unit calls of branch P's story: tidy never builds; report builds on a tree without tidy. */
export const UNIT_STORY_P: Readonly<Record<string, readonly M1Step[]>> = {
  parse: UNIT_STORY['parse']!,
  tidy: [INFEASIBLE, INFEASIBLE],
  report: UNIT_STORY['report']!.map((s) => (s.role === 'build' ? build('report: reconcile a month', unitFiles('report')) : s)),
  [REPAIR_UNIT.id]: UNIT_STORY[REPAIR_UNIT.id]!,
};

/** Branch P's bundle: cut tidy, admit the repair (repairing the plan-check P3 F-1), as paid run 3's ckpt-2. */
const CUT_TIDY: JsonValue = { op: 'cut', unit: 'tidy', reason: 'Its goal cannot be met within src/cli.js without breaking I-2.', cites: ['V-2'], evidence: ['F-1: plan-check found that format through formatDisplay prints 0.125 as 0.13'] };
const PREVENT_BUNDLE = checkpointAnswer({ decision: 'bundle', ops: [ADMIT_REPAIR, CUT_TIDY] });

const JOB_STEPS_P: readonly Step[] = [
  PACK_REVIEW,
  checkpointStep('ckpt-1', PREVENT_BUNDLE, [{ type: 'barrier', name: FAKE_CKPT_HOLD, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-2', PREVENT_BUNDLE),
  lensStep('audit-1', 'vision'),
  checkpointStep('ckpt-3', NO_OP),
  lensStep('audit-2', 'invariants'),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-4', NO_OP),
];

/** The unit calls of branch L's story: tidy's build keeps I-2's witness held; report builds on that tidy. */
export const UNIT_STORY_L: Readonly<Record<string, readonly M1Step[]>> = {
  parse: UNIT_STORY['parse']!,
  tidy: UNIT_STORY['tidy']!.map((s) => (s.role === 'build' ? build('tidy: format rounds, then prints through formatDisplay', unitFiles('tidy-latent')) : s)),
  report: UNIT_STORY['report']!.map((s) => (s.role === 'build' ? build('report: reconcile a month', { ...unitFiles('report'), ...unitFiles('report-on-tidy-latent') }) : s)),
  [REPAIR_UNIT.id]: UNIT_STORY[REPAIR_UNIT.id]!,
};

/** audit-1's invariants lens on S (branch L): the latent defect, a P1 over I-2 the witness cannot see. */
const LATENT_P1 = {
  severity: 'P1', obligation: 'I-2', visionClauses: ['V-2'], evidence: [{ path: 'src/cli.js', line: 20 }],
  claim: '`format` renders formatAmount\'s cents through a binary Number and toFixed: `format 100000000000000.01` prints 100,000,000,000,000.02. The money witness only tests amounts below 11.',
} as const;

const JOB_STEPS_L: readonly Step[] = [
  PACK_REVIEW,
  lensStep('audit-1', 'vision'),
  lensStep('audit-1', 'invariants', [LATENT_P1]),
  checkpointStep('ckpt-1', REPAIR_BUNDLE, [{ type: 'barrier', name: FAKE_CKPT_HOLD, timeoutMs: HOLD_MS }]),
  checkpointStep('ckpt-2', REPAIR_BUNDLE),
  lensStep('audit-2', 'vision'),
  checkpointStep('ckpt-3', NO_OP),
  lensStep('audit-3', 'invariants'),
  lensStep('audit-3', 'vision'),
  checkpointStep('ckpt-4', NO_OP),
];

export const STORIES = ['story', 'prevented', 'latent'] as const;
export type StoryName = (typeof STORIES)[number];

export function storyName(value: string): StoryName {
  const found = STORIES.find((s) => s === value);
  if (found === undefined) throw new Error(`unknown M3 story ${JSON.stringify(value)}; one of ${STORIES.join(', ')}`);
  return found;
}

/** The fake backend steps that play `story` under `profile`. */
export function storySteps(story: StoryName, profile: ProfileName): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const [unitStory, jobs] = story === 'story' ? [UNIT_STORY, JOB_STEPS_R] : story === 'prevented' ? [UNIT_STORY_P, JOB_STEPS_P] : [UNIT_STORY_L, JOB_STEPS_L];
  const units = Object.entries(unitStory).flatMap(([unit, steps]) => fakeSteps({ steps }, profile).slice(smoke.length).map((s): Step => ({ ...s, unit })));
  return [...smoke, ...units, ...jobs];
}
