// The gate stage (src/pipeline/gate.ts) through the unit driver, fake-backed: real processes, real git.
// Named tests: gate.fingerprint-invalidated, gate.risk-promotion; also the approval fingerprint's content,
// a revise round's directives and their re-check with the round handoff, the fingerprint's cited-only set, and
// the empty-diff refusal. M3 step A3: gate.inputs-not-in-ff-window (the capture under the revision fence),
// gate.obligations-selected, plan-check.vision-context.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluateRevision, keepRevision, payloadOf } from '../src/commands/apply.ts';
import { holdFence } from '../src/core/fence.ts';
import { rulingId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { commitRevisionNow, readInputFiles } from '../src/input/inforce.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { git } from './helpers/repo.ts';
import { type CallRecord, readCalls } from './helpers/scenario.ts';
import { events } from './fixtures/invoke-specs.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import type { Gate } from '../src/pipeline/unit.ts';
import { MUL, U1, codexStep, contextFor, gateStep, isGateCall as isGate, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { BASE, editPlan, followContext, planDirOf, recordFirst, stepTo, unitOf } from './fixtures/route-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** Every stage admitted at once: the unit runs on its own. */
const live = (): Gate => admitAll;
const sessionOf = (c: CallRecord): string => c.argv[c.argv.indexOf('--session-id') + 1]!;

test('gate.fingerprint-invalidated: a contract changes on T between approve and ff; the unit is re-gated in a fresh session and published', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const first = r.journal.view.unit(U1).approval!;
    const tip = first.fingerprint.contractRevs;
    // The fingerprint: blob ids at the gated tip, sorted by path; every cited ruling at rev 1.
    assert.deepEqual(tip.map((c) => c.path), ['ARCHITECTURE.md', 'contracts/api.md']);
    for (const c of tip) assert.equal(c.blob, git(d.repo, 'rev-parse', `main:${c.path}`));
    assert.deepEqual(first.fingerprint.rulingRevs, [{ id: rulingId('C-1'), rev: 1 }]);

    writeFileSync(join(d.repo, 'contracts', 'api.md'), '# API contract\n\n`add(a, b)` returns the sum; `mul(a, b)` the product.\n');
    git(d.repo, 'commit', '--quiet', '-am', 'the contract changes on integration');
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(9), ['ff:fingerprint-invalid', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
    const gates = readCalls(d.scenarioPath).filter(isGate);
    assert.equal(gates.length, 2);
    assert.notEqual(sessionOf(gates[0]!), sessionOf(gates[1]!), 'the re-gate is a fresh session');
    assert.ok(gates.every((g) => !g.argv.includes('--resume')));
    assert.ok(gates[1]!.stdin.includes('the product'), 'the re-gate read the changed contract');
    const approvals = events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'approval' ? [e.fact] : []));
    assert.equal(approvals.length, 2);
    assert.notDeepEqual(approvals[0]!.fingerprint.contractRevs, approvals[1]!.fingerprint.contractRevs);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'an invalidated approval charges nothing');
  } finally {
    r.journal.close();
  }
});

test('gate.fingerprint-cited-only: the approval binds the spec\'s cited contracts and rulings; an uncited contract changing on T does not re-gate', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const specFile = join(dirname(d.planPath), 'u1.json');
  writeFileSync(specFile, JSON.stringify({ ...JSON.parse(readFileSync(specFile, 'utf8')), cites: { contracts: [], rulings: [] } }));
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const { fingerprint } = r.journal.view.unit(U1).approval!;
    assert.deepEqual(fingerprint.contractRevs.map((c) => c.path), ['ARCHITECTURE.md'], 'the architecture doc always, no uncited contract');
    assert.deepEqual(fingerprint.rulingRevs, []);
    writeFileSync(join(d.repo, 'contracts', 'api.md'), '# API contract\n\nChanged, but no spec cites it.\n');
    git(d.repo, 'commit', '--quiet', '-am', 'an uncited contract changes on integration');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.ok(!outcomes(d).includes('ff:fingerprint-invalid'), 'the approval still holds');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 1);
  } finally {
    r.journal.close();
  }
});

test('gate.risk-promotion: a contract path in the unit\'s diff promotes the gate dispatch to the escalation seat', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'contracts/api.md': '# API contract\n\nAlso `mul(a, b)`.\n' }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'salvage');
    assert.equal(outcomes(d).at(-1), 'salvage:committed-contract-touched');
    assert.equal(r.journal.view.unit(U1).promotion, true);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [planCall, , gateCall] = readCalls(d.scenarioPath);
    assert.ok(planCall!.argv.includes('claude-opus-5-5'), 'plan-check sat on the unit\'s med seat');
    assert.ok(gateCall!.argv.includes('claude-fable-5-1'), 'the gate sat on the escalation seat');
    assert.equal(r.journal.view.unit(U1).promotion, false, 'the promotion was for that dispatch only');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('gate.revise: the directives go to a fix round, and the next gate rules on its prior round with the delta since', T, async () => {
  const directive = 'Export mul as the default export too.';
  const finding = { severity: 'blocking', path: 'src/mul.js', text: 'mul has no default export.', contractRef: 'contracts/api.md' };
  const premises = [
    { claim: 'mul multiplies', evidence: [{ path: 'src/mul.js', line: 2 }] },
    { claim: 'add is untouched', evidence: [{ path: 'src/add.js', line: 1 }] },
  ];
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild(),
      gateStep({ decision: 'revise', directives: [directive], findings: [finding], premises }),
      codexStep([{ type: 'commit', message: 'default export', files: { 'src/mul.js': `${MUL['src/mul.js']}export default mul;\n` } }], { argv: ['exec', 'resume'], stdinContains: [directive] }),
      gateStep({ decision: 'approve' }, {
        stdinContains: [
          directive, '[blocking] src/mul.js: mul has no default export. (contracts/api.md)', 'mul multiplies [src/mul.js:2]',
          'Paths the fix changed since:\n- src/mul.js\n', 'Premise files changed since:\n- src/mul.js\nRules',
        ],
      }),
    ],
  });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(6, 16), [
      'lanes:green', 'gate:revise', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green',
    ]);
    const u = r.journal.view.unit(U1).counters;
    assert.equal(u.reviseRounds, 1);
    assert.equal(u.chargeableFailures, 1);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'the fix round and the second gate saw the directive');
  } finally {
    r.journal.close();
  }
});

test('gate.empty-diff: a unit whose branch adds nothing is refused at the gate without a judgment call, and parks', T, async () => {
  const d = setupArc({ units: [{ id: 'u1', lanes: [] }], steps: [planCheckStep({ decision: 'approve' }), codexStep([], { argv: ['exec', '-C'] })] });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.equal(result.kind, 'parked');
    assert.ok(result.kind === 'parked');
    assert.equal(result.needsUser.reason, 'empty-diff');
    assert.equal(outcomes(d).at(-1), 'gate:empty-diff');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 0);
    // A parked unit stays parked: the next step reports it and runs nothing.
    const again = await step(r.ctx, r.unit('u1'));
    assert.equal(again.kind, 'parked');
    assert.ok(again.kind === 'parked');
    assert.equal(again.needsUser.reason, 'empty-diff');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// M3 step A3: judgment inputs under the revision fence; the obligations and the vision a judgment reads

const judgmentInputs = (d: ReturnType<typeof setupArc>, stage: string) =>
  events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'judgment-inputs' && e.fact.stage === stage ? [e.fact] : []));
const straightToGate = () => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];

test('gate.inputs-not-in-ff-window: while a revision holds the fence the gate neither captures its inputs nor calls; it then reads the revision that committed', T, async () => {
  const d = setupArc({ steps: straightToGate() });
  recordFirst(d);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    await stepTo(ctx, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    const hold = await holdFence(r.journal);
    const gating = step(ctx, unitOf(ctx, 'u1'));
    await sleep(2_000);
    assert.equal(r.journal.view.unit(U1).open?.stage, 'gate', 'the gate attempt started');
    assert.deepEqual(judgmentInputs(d, 'gate'), [], 'no judgment-inputs while the fence is held');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 0, 'no gate call while the fence is held');

    // A harmless revision commits while the fence is held: a new unit u2, plan rev 2.
    const u1Spec = JSON.parse(readFileSync(join(planDirOf(d), 'u1.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(planDirOf(d), 'u2.json'), JSON.stringify({ ...u1Spec, unit: 'u2' }));
    editPlan(d, (p) => void p.units.push({ ...p.units[0]!, id: 'u2', spec: 'u2.json' }));
    const rctx = { runDir: r.ctx.runDir, view: r.journal.view, hostDir: r.ctx.hostDir, planFile: absPath(d.planPath), routingBase: BASE };
    const v = evaluateRevision(rctx, readInputFiles(absPath(d.planPath)), { type: 'apply' });
    assert.ok(v.kind === 'accepted', JSON.stringify(v));
    keepRevision(r.ctx.runDir, v);
    commitRevisionNow(r.journal, r.ctx.runDir, payloadOf(v.draft, { type: 'start' }), { type: 'arc' });
    assert.equal(r.journal.view.planApplied()?.rev, 2);
    hold.release();

    assert.equal((await gating).kind, 'continue');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const inputs = judgmentInputs(d, 'gate');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.planRev, 2, 'the gate captured the plan the revision committed');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 1);
  } finally {
    r.journal.close();
  }
});

const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null, clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Multiply numbers in one call.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'Never lose a digit.', rank: null, state: 'active' },
  ],
};
const JOURNEY = { id: 'journey', argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl' };
const LANE_REV = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [JOURNEY], obligations: [], mapping: { paths: [] } }).lanes[0]!);
function obligation(id: string, statement: string): Record<string, unknown> {
  return {
    id, rev: 1, statement, docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
    witness: { lane: 'journey', testIds: [`t-${id}`] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV },
    deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' },
  };
}
const OBLIGATIONS = {
  schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when mul ships', lanes: [JOURNEY],
  obligations: [obligation('I-1', 'mul multiplies.'), obligation('I-2', 'add stays fixed.')],
  mapping: { paths: [{ pattern: 'docs/**', obligations: ['I-1'] }] },
};

/** A holistic arc over u1: its vision and obligations in force from revision 1, as an M3 first start records them. */
function holisticArc(): ReturnType<typeof setupArc> {
  const d = setupArc({ steps: straightToGate() });
  writeFileSync(join(planDirOf(d), 'vision.json'), JSON.stringify(VISION));
  writeFileSync(join(planDirOf(d), 'obligations.json'), JSON.stringify(OBLIGATIONS));
  editPlan(d, (p) => void (p['holistic'] = { vision: 'vision.json', obligations: 'obligations.json' }));
  recordFirst(d);
  return d;
}

test('gate.obligations-selected: in a holistic arc the gate prompt lists the obligations the diff selects and the approval fingerprint carries their revs; outside one the fingerprint has no obligationRevs', T, async () => {
  const d = holisticArc();
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    // The diff's paths (src/mul.js, test/mul.test.js) map to no obligation: every must-hold one is selected.
    const [g] = readCalls(d.scenarioPath).filter(isGate);
    assert.ok(g!.stdin.includes('- I-1 (rev 1; must-hold; active): mul multiplies.'), g!.stdin);
    assert.ok(g!.stdin.includes('- I-2 (rev 1; must-hold; active): add stays fixed.'));
    assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }, { id: 'I-2', rev: 1 }]);
  } finally {
    r.journal.close();
  }

  const plain = setupArc({ steps: straightToGate() });
  recordFirst(plain);
  const p = contextFor(plain);
  try {
    await stepTo(followContext(p), 'u1', (f) => f.stage === 'gate');
    const fingerprint = p.journal.view.unit(U1).approval?.fingerprint;
    assert.ok(fingerprint !== undefined);
    assert.ok(!('obligationRevs' in fingerprint), 'no obligationRevs key outside a holistic arc');
  } finally {
    p.journal.close();
  }
});

test('plan-check.vision-context: in a holistic arc the plan-check prompt carries the vision clauses in force; the gate prompt does not', T, async () => {
  const d = holisticArc();
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    const calls = readCalls(d.scenarioPath);
    const check = calls[0]!;
    assert.ok(check.as === 'claude' && !isGate(check));
    assert.ok(check.stdin.includes('Vision revision 1\nV-1 (purpose): Multiply numbers in one call.\nV-2 (non-negotiable): Never lose a digit.'), check.stdin);
    const [g] = calls.filter(isGate);
    for (const text of ['Multiply numbers in one call.', 'Never lose a digit.', 'Vision revision']) assert.ok(!g!.stdin.includes(text), `the gate prompt carries "${text}"`);
  } finally {
    r.journal.close();
  }
});
