// Turn-boundary certification: real unit loops, git checkouts and fake backends behind PATH shims.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { build, planCheck } from '../src/pipeline/stages.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { readCalls } from './helpers/scenario.ts';
import { events, intents } from './fixtures/invoke-specs.ts';
import { admitAll, planCheckStep, setupUnit, started } from './fixtures/stage-common.ts';
import { U1, codexStep, contextFor, mulBuild, setupArc, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: 300_000 };

test('certification: three reds free, fourth charged, allowance resets, twelfth parks at the chargeable bound', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), ...Array.from({ length: 11 }, (_, i) => codexStep([{ type: 'commit', message: 'repair attempt', files: { 'src/attempt.js': `export const attempt = ${i};\n` } }], { argv: ['exec', 'resume'] }))],
    units: [{ id: 'u1', lanes: [{ id: 'red', argv: ['node', '-e', 'process.exit(1)'] }] }], suite: [] });
  let r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.unchargedLanesReds === 3);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
    r.journal.close();
    r = contextFor(d);
    assert.equal(r.journal.view.unit(U1).counters.unchargedLanesReds, 3, 'restart retains the spent uncharged allowance');
    assert.equal((await runUnit(r.ctx, r.unit('u1'), admitAll)).kind, 'parked');
    const reds = events(d.runDir).flatMap((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.stage === 'lanes' ? [e.fact] : []);
    assert.deepEqual(reds.map((f) => f.chargeable), [false, false, false, true, false, false, false, true, false, false, false, true]);
    assert.deepEqual(reds.map((f) => f.unchargedLanesReds), [1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0]);
    assert.deepEqual(reds.map((f) => f.class), [...Array(11).fill('advance'), 'park']);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 3);
    const builds = readCalls(d.scenarioPath).filter((c) => c.as === 'codex');
    assert.equal(builds.length, 12);
    for (let i = 1; i < builds.length; i++) {
      assert.deepEqual(builds[i]!.argv.slice(0, 2), ['exec', 'resume']);
      assert.match(builds[i]!.stdin, new RegExp(`Certification allowance: ${3 - i % 4} uncharged red certifications remaining`));
      assert.match(builds[i]!.stdin, /failing evidence/i);
    }
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally { r.journal.close(); }
});

test('certification: limits.certifications=1 charges the first red and honors the chargeable limit', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()],
    units: [{ id: 'u1', lanes: [{ id: 'red', argv: ['false'] }] }], suite: [] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
  plan.limits = { certifications: 2, chargeable: 1 };
  plan.units[0].limits = { certifications: 1 };
  writeFileSync(d.planPath, JSON.stringify(plan));
  const r = contextFor(d);
  try {
    assert.equal((await runUnit(r.ctx, r.unit('u1'), admitAll)).kind, 'parked');
    const state = r.journal.view.unit(U1);
    assert.equal(state.counters.chargeableFailures, 1);
    assert.equal(state.counters.unchargedLanesReds, 0);
    assert.equal(state.decided?.outcome, 'red');
  } finally { r.journal.close(); }
});

for (const set of ['spec', 'suite'] as const) test(`certification: ${set} retries its previous red before build cadence and stops there`, T, async () => {
  const lanes = [{ id: 'fast', cadence: 'build' as const, argv: ['true'] },
    { id: 'red', cadence: 'unit' as const, argv: ['node', '-e', "process.exit(require('node:fs').existsSync('src/mul.js') ? 1 : 0)"] },
    { id: 'tail', cadence: 'unit' as const, argv: ['true'] }];
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), codexStep([], { argv: ['exec', 'resume'] })],
    units: [{ id: 'u1', lanes: set === 'spec' ? lanes : [] }], suite: set === 'suite' ? lanes : [] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'red');
    const first = r.journal.view.unit(U1).decided!.attempt;
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.attempt > first && f.outcome === 'red');
    const second = r.journal.view.unit(U1).decided!.attempt;
    const spawns = intents(d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && i.parent.type === 'stage' && i.parent.stage === 'lanes');
    const order = (attempt: number) => spawns.flatMap((i) => i.kind === 'proc.spawn' && i.parent.type === 'stage' && i.parent.attempt === attempt
      && i.expect.subject.purpose === 'lane' && i.expect.subject.set === set ? [i.expect.subject.lane] : []);
    assert.deepEqual([...new Set(order(first))], ['fast', 'red']);
    assert.deepEqual([...new Set(order(second))], ['red']);
  } finally { r.journal.close(); }
});

test('certification: builds reserve cpu only and omit resource-bearing build lanes from the prompt', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), codexStep([])], resources: ['db'],
    lanes: [{ id: 'local', argv: ['true'] }, { id: 'estate-build', argv: ['echo', 'ESTATE-ONLY-COMMAND'], resources: ['db'] }],
    suite: [{ id: 'estate-suite', argv: ['echo', 'ESTATE-SUITE-COMMAND'], resources: ['db'] }] });
  try {
    started(await planCheck(run.ctx, run.unit));
    const done = started(await build(run.ctx, run.unit, { kind: 'fresh' }));
    assert.ok(done.run !== null);
    const held = [...resourceTable(run.journal.view)].filter(([, r]) => r.status.state !== 'free');
    assert.ok(held.length > 0);
    assert.ok(held.every(([resource]) => String(resource).startsWith('@cpu')), JSON.stringify(held));
    const call = readCalls(run.scenario.path).find((c) => c.as === 'codex')!;
    assert.ok(!call.stdin.includes('ESTATE-ONLY-COMMAND'));
    assert.ok(!call.stdin.includes('ESTATE-SUITE-COMMAND'));
    assert.match(call.stdin, /do not rehearse the full lane suite/);
    while (run.journal.view.unit(U1).decided?.stage !== 'lanes') assert.equal((await step(run.ctx, run.unit)).kind, 'continue');
    const named = intents(run.runDir, 'resource.transition').filter((i) => i.kind === 'resource.transition' && i.expect.edge.type === 'reserve'
      && i.expect.resources.some((r) => String(r) === 'db'));
    assert.equal(named.length, 2, 'both resource-bearing build-cadence lanes still run in the executor');
    assert.ok(named.every((i) => i.parent.type === 'stage' && i.parent.stage === 'lanes'));
    assert.equal(run.journal.view.unit(U1).decided?.outcome, 'green');
  } finally { run.journal.close(); }
});
