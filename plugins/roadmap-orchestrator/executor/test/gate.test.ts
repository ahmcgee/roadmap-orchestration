// The gate stage (src/pipeline/gate.ts) through the unit driver, fake-backed: real processes, real git.
// Named tests: gate.fingerprint-invalidated, gate.risk-promotion; also the approval fingerprint's content,
// a revise round's directives and their re-check, and the empty-diff refusal.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { rulingId } from '../src/core/ids.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { git } from './helpers/repo.ts';
import { type CallRecord, readCalls } from './helpers/scenario.ts';
import { events } from './fixtures/invoke-specs.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, U1, codexStep, contextFor, gateStep, isGateCall as isGate, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): AbortSignal => new AbortController().signal;
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

test('gate.revise: the directives go to a fix round, and the next gate re-checks them', T, async () => {
  const directive = 'Export mul as the default export too.';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild(),
      gateStep({ decision: 'revise', directives: [directive] }),
      codexStep([{ type: 'commit', message: 'default export', files: { 'src/mul.js': `${MUL['src/mul.js']}export default mul;\n` } }], { argv: ['exec', 'resume'], stdinContains: [directive] }),
      gateStep({ decision: 'approve' }, { stdinContains: [directive] }),
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
