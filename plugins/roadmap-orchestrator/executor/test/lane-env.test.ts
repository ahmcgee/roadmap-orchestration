import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHostSample } from '../src/host/sample.ts';
import { test } from 'node:test';
import { jobId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { ciReasons } from '../src/input/ci.ts';
import { laneRows } from '../src/preflight/lanerows.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { laneEnv, runJourneySeries, runLaneSeries, reserveNow, suiteJourneyLane } from '../src/pipeline/lanes.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { keptSpec, launchOf, setupUnit, spawnIntents, U1 } from './fixtures/stage-common.ts';
import { tmpDir } from './helpers/repo.ts';

for (const cpu of [3]) test(`granted-not-default-cpu-in-child-env (${cpu})`, async () => {
  const output = join(tmpDir('cpu-env'), 'cpu');
  const run = setupUnit({ steps: [], lanes: [{ id: 'cpu-env', argv: ['sh', '-c', 'printf "%s" "$ROADMAP_CPU" > "$OUTPUT"'], env: { set: { OUTPUT: output }, pass: ['PATH'] } }] });
  try {
    pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
    const lane = { ...loadUnitSpec(run.ctx, run.unit).spec.lanes[0]!, cpu };
    const result = await runLaneSeries(run.ctx, { type: 'stage', unit: U1, stage: 'lanes', attempt: 1 }, [lane], 'spec', {
      path: absPath(join(tmpDir('cpu-tree'), 'tree')), checkout: { type: 'detached', at: run.base },
    }, absPath(join(tmpDir('cpu-series'), 'series')), { acquire: reserveNow(run.ctx), rank: () => { throw new Error('not ranked'); }, signal: run.ctx.signal, sampleHost: readHostSample }, false);
    assert.equal(result.end.kind, 'green');
    assert.equal(readFileSync(output, 'utf8'), String(cpu));
    const spawn = spawnIntents(run).find((i) => i.expect.subject.purpose === 'lane')!;
    assert.equal(launchOf(run, spawn).env['ROADMAP_CPU'], String(cpu));
  } finally { run.journal.close(); }
});

test('journey-job-and-zero-cpu-env', async () => {
  const output = join(tmpDir('job-env'), 'cpu');
  const run = setupUnit({ steps: [], lanes: [{ id: 'job-env', argv: ['sh', '-c', 'printf "%s" "$ROADMAP_CPU" > "$OUTPUT"'], env: { set: { OUTPUT: output }, pass: ['PATH'] } }] });
  try {
    const lane = { ...loadUnitSpec(run.ctx, run.unit).spec.lanes[0]!, cpu: 3 };
    const arbiter = createArbiter(run.ctx);
    const result = await runJourneySeries(run.ctx, { type: 'job', job: jobId('audit', 1), acquireFirst: arbiter.acquireFirst }, [suiteJourneyLane(lane)], {
      path: absPath(join(tmpDir('job-tree'), 'tree')), checkout: { type: 'detached', at: run.base },
    }, { reuse: false, stop: () => false });
    assert.equal(result.runs[0]?.verdict, 'pass');
    assert.equal(readFileSync(output, 'utf8'), '3');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.ROADMAP_CPU ?? "missing")'], { env: laneEnv(run.ctx, U1, lane, []), encoding: 'utf8' });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '0');
  } finally { run.journal.close(); }
});

for (const mode of ['set', 'pass'] as const) test(`reserved-env-${mode}-refused`, () => {
  const run = setupUnit({ steps: [], lanes: [{ id: 'env', argv: ['true'] }] });
  try {
    const spec = loadUnitSpec(run.ctx, run.unit).spec;
    const lane = { ...spec.lanes[0]!, env: { set: mode === 'set' ? { ROADMAP_CPU: '9' } : {}, pass: mode === 'pass' ? ['PATH', 'ROADMAP_CPU'] : ['PATH'] } };
    assert.ok(ciReasons(run.ctx.plan(), [{ ...spec, lanes: [lane] }]).some((r) => r.includes('ROADMAP_CPU')));
    assert.ok(laneRows(run.ctx.plan(), [U1], () => ({ ...spec, lanes: [lane] }), { ...run.ctx.hostEnv, ROADMAP_CPU: '9' }).some((r) => 'unit' in r && r.unit === U1 && r.problem.type === 'env-reserved'));
  } finally { run.journal.close(); }
});
