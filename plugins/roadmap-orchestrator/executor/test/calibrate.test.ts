// Pure key and ruler checks; the long-run reader is exercised over real lanes in serial/calibrate.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneDef } from '../src/core/records.ts';
import { laneRevOf } from '../src/holistic/types.ts';
import { buildCpuKey, calibratedCpu, cpuDemand, laneCpuKey } from '../src/resources/calibrate.ts';
import { reserve, cleanup } from '../src/resources/reserve.ts';
import { reservationCpuBasisOf, spawnCpuKeyOf } from '../src/core/upgrade.ts';
import { requestOf, buildCpu, laneCpu } from '../src/resources/pool.ts';
import { setupUnit } from './fixtures/stage-common.ts';

const lane = () => laneDef({
  id: 'check', argv: ['node', '--test'], cwd: '.', env: { set: { A: 'a' }, pass: ['PATH', 'HOME'] },
  expectedExit: 0, cadence: 'unit', resources: [], evidenceGlobs: [],
}, 'lane');

test('calibration ruler: ceil nearest-rank p90, floor one, cap default, three long runs and last ten only', () => {
  assert.equal(calibratedCpu([], 4), 4);
  assert.equal(calibratedCpu([0, 0], 4), 4);
  assert.equal(calibratedCpu([0, 0.1, 0.2], 4), 1);
  assert.equal(calibratedCpu([0, 1.01, 1.99], 4), 2);
  assert.equal(calibratedCpu([0, 3, 90], 4), 4);
  assert.equal(calibratedCpu([...Array(9).fill(1), 9], 4), 1, 'one outlier among ten is above p90');
  assert.equal(calibratedCpu([99, 99, ...Array(10).fill(0.2)], 4), 1, 'old runs leave the window');
  assert.equal(cpuDemand(null), null);
  assert.equal(cpuDemand({ wallMs: 29_999, runMs: 20_000, waitMs: 10_000 }), null);
  assert.equal(cpuDemand({ wallMs: 30_000, runMs: 30_000, waitMs: 30_000 }), 2, 'demand includes scheduler wait');
});

test('lane calibration keys bind execution only, never cost, identity, cadence, topology or pass order', () => {
  const original = lane();
  const key = laneCpuKey(original);
  const rev = laneRevOf(original);
  const changed = { ...original, cpu: 1, cadence: 'candidate' as const, env: { ...original.env, pass: ['HOME', 'PATH'] } };
  assert.equal(laneCpuKey(changed), key);
  assert.notEqual(laneRevOf(changed), rev, 'the scheduling key does not replace laneRev');
  for (const other of [
    { ...original, argv: ['node', '--check'] }, { ...original, cwd: 'src' as typeof original.cwd },
    { ...original, env: { ...original.env, set: { A: 'b' } } }, { ...original, env: { ...original.env, pass: ['PATH'] } },
    { ...original, expectedExit: 1 },
  ]) assert.notEqual(laneCpuKey(other), key);
  const basis = { kind: 'calibrated', key, value: 1, samples: 3 } as const;
  assert.equal(laneCpu(original, basis), 1);
  assert.equal(laneCpu({ ...original, cpu: 7 }, basis), 7);
  assert.equal(laneRevOf(original), rev, 'computing a reservation never changes the definition');
});

test('build calibration keys bind backend, model and effort; a unit CPU declaration stays the override', () => {
  const triple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } as const;
  const key = buildCpuKey(triple);
  assert.notEqual(buildCpuKey({ ...triple, effort: 'high' }), key);
  assert.notEqual(buildCpuKey({ ...triple, model: 'claude-opus-5-5' }), key);
  assert.notEqual(buildCpuKey({ backend: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }), key);
  const run = setupUnit({ steps: [] });
  const basis = { kind: 'calibrated', key, value: 1, samples: 3 } as const;
  assert.equal(buildCpu(run.unit, basis), 1);
  assert.equal(buildCpu({ ...run.unit, cpu: 6 }, basis), 6);
  run.journal.close();
});


test('a calibrated reservation journals its exact tokens and basis; earlier records read as unmeasured', async () => {
  const run = setupUnit({ steps: [] });
  const key = laneCpuKey(lane());
  const basis = { kind: 'calibrated', key, value: 1, samples: 3 } as const;
  const holder = { type: 'stage', unit: run.unit.id, stage: 'lanes', attempt: 1 } as const;
  const parent = { ...holder };
  const reservation = reserve(run.ctx, holder, requestOf(run.ctx.plan(), [], basis.value, basis), parent);
  assert.equal(reservation.state, 'reserved');
  assert.equal(run.journal.view.opsOf('resource.transition').at(-1)?.expect.resources.length, 1);
  assert.deepEqual(reservationCpuBasisOf(run.journal.view.opsOf('resource.transition').at(-1)!.expect), basis);
  assert.equal(reservationCpuBasisOf({}), null);
  assert.equal(spawnCpuKeyOf({}), null);
  if (reservation.state !== 'reserved') assert.fail('the free CPU must be granted');
  assert.equal((await cleanup(run.ctx, reservation, parent)).kind, 'released');
  run.journal.close();
});
