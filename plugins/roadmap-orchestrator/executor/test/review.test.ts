// Proportional review (dev.17; src/pipeline/review.ts, src/pipeline/docsonly.ts) through the unit driver, fake-backed: real
// processes, real git. Named tests: review.defect-required, review.ride-along, review.docs-only-code,
// review.docs-only-verifier, review.docs-only-refused, review.reraise-refused, review.reraise-anchor-changed,
// review.dispute-ruled-once, review.delta-demotes, review.delta-scope, review.delta-empty.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Fact, IntentOf } from '../src/core/events.ts';
import type { JsonValue } from '../src/core/json.ts';
import { certifiedTree } from '../src/pipeline/docsonly.ts';
import { gateDebtNotes } from '../src/pipeline/gate.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { validateGateOutput } from '../src/prompts/schemas.ts';
import { events } from './fixtures/invoke-specs.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcRun, MUL, SUITE_LANE, U1, appendSteps, contextFor, gateRepairStep, gateStep, isGateCall, mulBuild, outcomes, setupArc, stepUntil, workDirPattern,
} from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';
import { type CallRecord, type Step, readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = () => admitAll;

const blocking = (path: string, text: string, extra: Readonly<Record<string, JsonValue>> = {}): JsonValue =>
  ({ severity: 'blocking', path, text, contractRef: null, experiments: [], debt: null, ...extra });
const note = (path: string, text: string): JsonValue => ({ severity: 'note', path, text, contractRef: null, experiments: [], debt: null });
/** A fix round: the build session resumed, committing `files` (none: no change), answering `docsOnlySince`. */
const fixBuild = (files: Readonly<Record<string, string>> | null, docsOnlySince: string | null = null, before: readonly Step['acts'][number][] = []): Step => ({
  as: 'codex', expect: { argv: ['exec', 'resume'] },
  acts: [...before, ...(files === null ? [] : [{ type: 'commit', message: 'fix round', files } as const]), { type: 'emit', value: { ...BUILD_REPORT, docsOnlySince } }],
} as Step);
/** The verifier's call (a fresh read-only judgment on Haiku 5.5) answering `hunks`. */
const verifierStep = (hunks: readonly JsonValue[], stdinContains: readonly string[] = []): Step => ({
  as: 'claude', expect: { argv: ['-p', '--model', 'claude-haiku-5-5', '--effort', 'high', '--tools', 'Read,Grep,Glob,Agent', '--session-id'], stdinContains }, acts: [{ type: 'emit', value: { hunks: [...hunks] } }],
});
const clear = (id: string): JsonValue => ({ id, kind: 'comment', executable: false, toolDirective: false, behaviourChange: false });

const factsOf = <K extends Fact['kind']>(d: Readonly<{ runDir: string }>, kind: K): readonly Extract<Fact, { kind: K }>[] =>
  events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact as Extract<Fact, { kind: K }>] : []));
const ledgerOf = (r: ArcRun): readonly (readonly [string, string, string | null])[] => r.journal.view.review().ledger.map((e) => [e.id, e.path, e.outcome] as const);
const gateCalls = (d: Readonly<{ scenarioPath: string }>): readonly CallRecord[] => readCalls(d.scenarioPath).filter(isGateCall);
/** The lane spawns of the unit's lanes attempt `attempt`, by lane id. */
const laneSpawns = (r: ArcRun, attempt: number): readonly string[] => r.journal.view.opsOf('proc.spawn').flatMap((i: IntentOf<'proc.spawn'>) => {
  const s = i.expect.subject;
  return s.purpose === 'lane' && i.parent.type === 'stage' && i.parent.stage === 'lanes' && i.parent.attempt === attempt ? [s.lane as string] : [];
});
const lastLanesAttempt = (d: Parameters<typeof outcomes>[0]): number => {
  const all = factsOf(d, 'stage-outcome').filter((f) => f.unit === U1 && f.stage === 'lanes');
  return all.at(-1)!.attempt;
};

/** A comment-only change to src/mul.js: whole-line `//` comments, which code clears alone. */
const MUL_LINE_COMMENT = { 'src/mul.js': `// mul multiplies two numbers.\n${MUL['src/mul.js']}` };
/** A doc-comment change code cannot clear alone (a block comment): the verifier is asked. */
const MUL_DOC_COMMENT = { 'src/mul.js': `/** Multiplies two numbers. */\n${MUL['src/mul.js']}` };

test('review.defect-required: a blocking finding without a defect is refused through the repair turn; the repaired one enters the ledger open', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(),
      gateStep({ decision: 'revise', directives: ['Handle negatives.'], findings: [blocking('src/mul.js', 'mul is wrong for negatives.', { defect: null })] }),
      gateRepairStep({ decision: 'revise', directives: ['Handle negatives.'], findings: [blocking('src/mul.js', 'mul is wrong for negatives.', { defect: 'incorrect-behaviour' })] }, ['names no defect']),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:revise');
    assert.equal(gateCalls(d).length, 2, 'the first answer took the repair turn');
    assert.deepEqual(ledgerOf(r), [['R-1', 'src/mul.js', null]], 'the blocking finding is open in the ledger');
    const [entry] = r.journal.view.review().ledger;
    assert.equal(entry!.anchor, git(d.repo, 'rev-parse', `roadmap/${r.ctx.plan().arc}/u1:src/mul.js`), 'anchored at the blob the gate judged');
    const inputs = r.journal.view.judgmentInputs(U1, 'gate', r.journal.view.unit(U1).decided!.attempt)!;
    assert.deepEqual(inputs.review, { ledger: [], disputes: [], delta: null }, 'the first gate was given an empty ledger and a full review');
  } finally {
    r.journal.close();
  }
});

test('review.ride-along: comment and doc findings never block; each enters the ledger released (no banking outside a corpus arc), and only one naming its drag is debt', T, async () => {
  const rideAlong = (path: string, text: string, debt: JsonValue): JsonValue => ({ severity: 'ride-along', path, text, contractRef: null, experiments: [], debt });
  const findings = [rideAlong('src/mul.js', 'The comment above mul is stale.', { drag: 'Every later caller reads the wrong contract from it.' }), rideAlong('test/mul.test.js', 'Typo in a test name.', null)];
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve', findings })] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    assert.deepEqual(ledgerOf(r), [['R-1', 'src/mul.js', 'released'], ['R-2', 'test/mul.test.js', 'released']]);
    const read = validateGateOutput({ decision: 'approve', findings, directives: [], reasons: ['ok'], premises: [], unreviewed: [], clusters: null, rulings: [] });
    assert.deepEqual(gateDebtNotes(read.findings).map((n) => n.index), [0], 'a ride-along finding is debt only with its drag');
    assert.ok(factsOf(d, 'approval').at(-1)!.blobs !== undefined, 'the approval records its blobs');
  } finally {
    r.journal.close();
  }
});

/** Takes u1 to a gate revise on src/mul.js after a green lanes attempt; returns the certified tree. */
async function toRevise(r: ArcRun): Promise<string> {
  await stepUntil(r, 'u1', (f) => f.stage === 'gate');
  assert.equal(outcomes(r.d).at(-1), 'gate:revise');
  const certified = certifiedTree(r.ctx, U1);
  assert.ok(certified !== null);
  return certified;
}

const reviseSteps = (): readonly Step[] => [
  planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'revise', directives: ['Document mul.'], findings: [blocking('src/mul.js', 'mul is undocumented.', { defect: 'requirement-unmet' })] }),
];

test('review.docs-only-code: a fix that adds only whole-line comments, claimed docs-only since the certified tree, carries the lane passes over by code alone; a lane reading comments runs again', T, async () => {
  const d = setupArc({ steps: reviseSteps(), suite: [{ ...SUITE_LANE, readsComments: true }] });
  const r = contextFor(d);
  try {
    const certified = await toRevise(r);
    appendSteps(d, [fixBuild(MUL_LINE_COMMENT, certified), gateStep({ decision: 'approve' })]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [check] = factsOf(d, 'docs-only');
    assert.ok(check !== undefined);
    assert.deepEqual([check.verdict, check.since, check.reason, check.carried], ['code', certified, null, ['mul']]);
    assert.deepEqual(laneSpawns(r, lastLanesAttempt(d)), ['suite'], 'the spec lane was carried over; the lane reading comments ran');
    const reused = factsOf(d, 'lane-reused').filter((f) => f.parent.type === 'stage' && f.parent.attempt === check.attempt);
    assert.deepEqual(reused.map((f) => [f.lane, f.from.at]), [['mul', certified]]);
    assert.ok(!r.journal.view.opsOf('proc.spawn').some((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'verifier'), 'no verifier call');
    assert.deepEqual(ledgerOf(r), [['R-1', 'src/mul.js', 'fixed']], 'the approval settles the finding whose file changed as fixed');
  } finally {
    r.journal.close();
  }
});

test('review.docs-only-verifier: a doc comment code cannot clear goes to the verifier (role verifier, Haiku), which clears it; the passes carry over', T, async () => {
  const d = setupArc({ steps: reviseSteps() });
  const r = contextFor(d);
  try {
    const certified = await toRevise(r);
    appendSteps(d, [fixBuild(MUL_DOC_COMMENT, certified), verifierStep([clear('h1')], ['/** Multiplies two numbers. */', 'src/mul.js']), gateStep({ decision: 'approve' })]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [check] = factsOf(d, 'docs-only');
    assert.deepEqual([check!.verdict, check!.carried], ['verifier', ['mul', 'suite']]);
    assert.deepEqual(laneSpawns(r, lastLanesAttempt(d)), [], 'every lane carried over');
    const verifier = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'verifier');
    assert.equal(verifier.length, 1);
    const s = verifier[0]!.expect.subject;
    assert.ok(s.purpose === 'backend' && s.tier === 'med', 'on the unit\'s risk tier');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('review.docs-only-refused: the verifier finds a behaviour change; the claim is refused and the lanes run as normal, uncharged', T, async () => {
  const d = setupArc({ steps: reviseSteps() });
  const r = contextFor(d);
  try {
    const certified = await toRevise(r);
    const charged = r.journal.view.unit(U1).counters.chargeableFailures;
    appendSteps(d, [fixBuild(MUL_DOC_COMMENT, certified), verifierStep([{ id: 'h1', kind: 'mixed', executable: true, toolDirective: false, behaviourChange: true }]), gateStep({ decision: 'approve' })]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [check] = factsOf(d, 'docs-only');
    assert.equal(check!.verdict, 'refused');
    assert.match(check!.reason!, /did not clear h1 \(src\/mul\.js\): mixed, executable, a behaviour change/);
    assert.deepEqual(check!.carried, []);
    assert.deepEqual(laneSpawns(r, lastLanesAttempt(d)), ['mul', 'suite'], 'every lane ran');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, charged, 'the refusal charged nothing');
  } finally {
    r.journal.close();
  }
});

/** gate 1 revises: a blocking finding on the test (R-1) and a note on src/mul.js (R-2, settled released at once). */
const reraiseSteps = (): readonly Step[] => [
  planCheckStep({ decision: 'approve' }), mulBuild(),
  gateStep({
    decision: 'revise', directives: ['Test negatives.'],
    findings: [blocking('test/mul.test.js', 'No negative case.', { defect: 'test-inadequate' }), note('src/mul.js', 'mul could name its parameters.')],
  }),
];
const NEGATIVE_TEST = { 'test/mul.test.js': `${MUL['test/mul.test.js']}test('negatives', () => {\n  assert.equal(mul(-2, 3), -6);\n});\n` };

test('review.reraise-refused: a blocking finding raising a settled one again while its file is unchanged is refused through the repair turn', T, async () => {
  const d = setupArc({
    steps: [
      ...reraiseSteps(), fixBuild(NEGATIVE_TEST),
      gateStep({ decision: 'revise', directives: ['Name the parameters.'], findings: [blocking('src/mul.js', 'mul could name its parameters.', { reraises: 'R-2' })] }),
      gateRepairStep({ decision: 'approve' }, ['raises R-2 again, which is settled (released), and src/mul.js has not changed since it was raised']),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.deepEqual(ledgerOf(r), [['R-1', 'test/mul.test.js', null], ['R-2', 'src/mul.js', 'released']]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    assert.deepEqual(ledgerOf(r), [['R-1', 'test/mul.test.js', 'fixed'], ['R-2', 'src/mul.js', 'released']]);
    assert.ok(gateCalls(d)[1]!.stdin.includes('<findings_ledger>'), 'the second gate was shown the ledger');
    const fix = readCalls(d.scenarioPath).find((c) => c.as === 'codex' && c.argv.includes('resume'));
    assert.ok(fix!.stdin.includes('ledgered as R-1 (test/mul.test.js)'), 'the fix round names the open finding and how to dispute it');
  } finally {
    r.journal.close();
  }
});

test('review.reraise-anchor-changed: once the settled finding\'s file changed, raising it again blocks', T, async () => {
  const d = setupArc({
    steps: [
      ...reraiseSteps(), fixBuild({ ...NEGATIVE_TEST, 'src/mul.js': MUL['src/mul.js'].replace('(a, b)', '(x, y)').replace('a * b', 'x * y') }),
      gateStep({ decision: 'revise', directives: ['Name the parameters for what they are.'], findings: [blocking('src/mul.js', 'x and y say nothing either.', { reraises: 'R-2' })] }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:revise');
    assert.equal(gateCalls(d).length, 2, 'no repair turn');
    assert.deepEqual(ledgerOf(r), [['R-1', 'test/mul.test.js', 'fixed'], ['R-2', 'src/mul.js', 'released'], ['R-3', 'src/mul.js', null]]);
  } finally {
    r.journal.close();
  }
});

test('review.dispute-ruled-once: a builder\'s dispute goes to the next gate, which must rule on it; the ruling is final, and a later gate is not asked again', T, async () => {
  const dispute = JSON.stringify({ decisions: [], disputes: [{ finding: 'R-1', reason: 'The contract asks for exactly this.' }] });
  const d = setupArc({ steps: reviseSteps() });
  // The fake writes decisions.json into the build's evidence dir, which its prompt names.
  appendSteps(d, [
    fixBuild(NEGATIVE_TEST, null, [{ type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: dispute }]),
    gateStep({ decision: 'approve' }, { stdinContains: ['<disputes>', 'R-1: mul is undocumented.', 'Dispute: The contract asks for exactly this.'] }),
    gateRepairStep({ decision: 'approve', rulings: [{ finding: 'R-1', ruling: 'overruled', reason: 'The contract says so.' }] }, ['rulings misses the disputes of R-1']),
  ]);
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    assert.deepEqual(ledgerOf(r), [['R-1', 'src/mul.js', 'disputed-overruled']]);
    // A contract change on the tip voids the approval; the re-gate is shown the ruled finding, and no dispute.
    writeFileSync(join(d.repo, 'contracts', 'api.md'), '# API contract\n\n`add(a, b)` returns the sum; `mul(a, b)` the product.\n');
    git(d.repo, 'commit', '--quiet', '-am', 'the contract changes on integration');
    appendSteps(d, [gateStep({ decision: 'approve' }, { stdinContains: ['- R-1 [disputed-overruled, file unchanged] src/mul.js', '<delta>'] })]);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    const third = gateCalls(d)[3]!;
    assert.ok(!third.stdin.includes('<disputes>'), 'a ruled dispute is never put to a gate again');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

/** Approves u1, then changes the cited contract on the tip, so ff finds the fingerprint invalid and the unit is re-gated. */
async function approvedThenContractMoves(r: ArcRun): Promise<void> {
  await stepUntil(r, 'u1', (f) => f.stage === 'gate');
  assert.equal(outcomes(r.d).at(-1), 'gate:approve');
  writeFileSync(join(r.d.repo, 'contracts', 'api.md'), '# API contract\n\n`add(a, b)` returns the sum; `mul(a, b)` the product.\n');
  git(r.d.repo, 'commit', '--quiet', '-am', 'the contract changes on integration');
}

test('review.delta-demotes: on a re-gate a blocking finding on an unchanged file citing neither a changed hunk nor a moved target is a note, and the revise reads as an approval', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await approvedThenContractMoves(r);
    appendSteps(d, [gateStep({ decision: 'revise', directives: ['Rename mul.'], findings: [blocking('src/mul.js', 'mul should be named times.')] }, {
      stdinContains: ['These files you approved are unchanged.', '- src/mul.js', 'Targets your approval bound that moved since (contracts, rulings, requirements):\n- contracts/api.md'],
    })]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve', 'the demoted revise is an approval');
    const delta = r.journal.view.judgmentInputs(U1, 'gate', r.journal.view.unit(U1).decided!.attempt)!.review!.delta!;
    assert.deepEqual([delta.review, delta.unchanged, delta.moved], [[], ['src/mul.js', 'test/mul.test.js'], ['contracts/api.md']]);
    assert.deepEqual(ledgerOf(r), [['R-1', 'src/mul.js', 'released']], 'recorded as a note, settled at once');
  } finally {
    r.journal.close();
  }
});

test('review.delta-scope: a blocking finding resting on a moved contract stands; the fix\'s file is then under review and the rest are not', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await approvedThenContractMoves(r);
    appendSteps(d, [
      gateStep({ decision: 'revise', directives: ['Document the product as the contract now says.'], findings: [blocking('src/mul.js', 'mul is not described as the product.', { contractRef: 'contracts/api.md#mul' })] }),
      fixBuild(MUL_LINE_COMMENT),
      gateStep({ decision: 'approve' }, { stdinContains: ['they are under review:\n- src/mul.js\n', 'These files you approved are unchanged. They are in your checkout to read for context, and they are not under review:\n- test/mul.test.js\n'] }),
    ]);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:revise', 'a finding resting on the moved contract stands');
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const delta = r.journal.view.judgmentInputs(U1, 'gate', r.journal.view.unit(U1).decided!.attempt)!.review!.delta!;
    assert.deepEqual([delta.review, delta.unchanged], [['src/mul.js'], ['test/mul.test.js']]);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('review.delta-empty: a re-gate after an unchanged fix round with nothing moved is skipped by code: approved again, no call', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), fixBuild(null)] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    // The tip gains a test that fails only beside mul: the candidate is red, the tip alone green, so a fix round follows.
    writeFileSync(join(d.repo, 'test', 'combo.test.js'), [
      "import assert from 'node:assert/strict';", "import { existsSync } from 'node:fs';", "import { test } from 'node:test';", '',
      "test('combo', async () => {", "  if (!existsSync(new URL('../src/mul.js', import.meta.url))) return;", "  const { mul } = await import('../src/mul.js');",
      '  assert.equal(mul(2, 2), 5);', '});', '',
    ].join('\n'));
    git(d.repo, 'add', 'test/combo.test.js');
    git(d.repo, 'commit', '--quiet', '-m', 'a test that fails beside mul');
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:delta-empty');
    assert.ok(outcomes(d).includes('candidate:red'));
    assert.equal(gateCalls(d).length, 1, 'the skipped gate made no call');
    const approvals = factsOf(d, 'approval');
    assert.equal(approvals.length, 2, 'approved again at the new fingerprint');
    assert.deepEqual(approvals[1]!.blobs, approvals[0]!.blobs, 'the same blobs');
    assert.equal(approvals[1]!.attempt, r.journal.view.unit(U1).decided!.attempt);
  } finally {
    r.journal.close();
  }
});
