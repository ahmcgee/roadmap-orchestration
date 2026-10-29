// Real 30-second lanes, real git, real runner exit.json files: calibration is learned only after three runs.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { laneRevOf } from '../../src/holistic/types.ts';
import { laneOrder, laneRequest, reserveNow, runLaneSeries, specSeriesRoot } from '../../src/pipeline/lanes.ts';
import { loadUnitSpec } from '../../src/pipeline/stages.ts';
import { cpuCost, laneCpuKey } from '../../src/resources/calibrate.ts';
import { commitOn } from '../fixtures/git8b-common.ts';
import { setupUnit, U1 } from '../fixtures/stage-common.ts';
import { tmpDir } from '../helpers/repo.ts';

const CLEAR = { load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 };

test('calibration reads completed long runner measurements once, journals the basis, and rebuilds after restart', { timeout: 180_000 }, async () => {
  const run = setupUnit({ steps: [], lanes: [{ id: 'idle', cadence: 'unit', argv: [process.execPath, '-e', 'setTimeout(() => {}, 30100)'] }] });
  const lane = laneOrder(loadUnitSpec(run.ctx, run.unit).spec)[0]!;
  const rev = laneRevOf(lane);
  const key = laneCpuKey(lane);
  const runtime = { acquire: reserveNow(run.ctx), rank: () => { throw new Error('not ranked'); }, signal: new AbortController().signal, sampleHost: () => CLEAR };
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(laneRequest(run.ctx, lane)?.cpu, 4, 'fewer than three samples uses the default');
    const parent = { type: 'stage', unit: U1, stage: 'lanes', attempt } as const;
    const at = commitOn(run.repo, run.base, { [`sample-${attempt}`]: `${attempt}\n` }, `sample ${attempt}\n`);
    const checkout = { path: absPath(join(tmpDir('calibration-tree'), 'tree')), checkout: { type: 'detached', at } } as const;
    const result = await runLaneSeries(run.ctx, parent, [lane], 'spec', checkout, specSeriesRoot(run.ctx.runDir, parent), runtime, false);
    assert.equal(result.end.kind, 'green');
  }
  const request = laneRequest(run.ctx, lane)!;
  assert.equal(request.cpu, 1);
  assert.deepEqual(request.cpuBasis, { kind: 'calibrated', key, value: 1, samples: 3 });
  assert.deepEqual(laneRequest(run.ctx, lane), request, 'cached invocations never count twice');
  assert.equal(laneRevOf(lane), rev);
  const reservations = run.journal.view.opsOf('resource.transition').filter((i) => i.expect.edge.type === 'reserve');
  assert.deepEqual(reservations.map((i) => i.expect.cpuBasis?.kind), ['default', 'default', 'default']);
  assert.deepEqual(reservations.map((i) => i.expect.cpuBasis && 'samples' in i.expect.cpuBasis ? i.expect.cpuBasis.samples : null), [0, 1, 2]);
  run.journal.close();
  const restarted = { ...run.ctx, journal: { view: readJournal(run.ctx.runDir, arcId(run.ctx.plan().arc)).view } };
  assert.deepEqual(cpuCost(restarted, key, 4), request.cpuBasis);
  assert.deepEqual(cpuCost(restarted, key, 4, 6), { kind: 'explicit', value: 6 });
});
