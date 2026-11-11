import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name)).includes(needle))
    .map((e) => join(e.parentPath, e.name));
}

// Field report 2026-11-11: launch.json held passed `*_API_KEY` values in plaintext. A passed variable reaches the
// workload by value and the run's records by name only.
test('passed-env-value-reaches-workload-not-records', async () => {
  const secret = `sk-test-${randomBytes(16).toString('hex')}`;
  const digest = createHash('sha256').update(secret).digest('hex');
  const output = join(tmpDir('pass-env'), 'digest');
  const argv = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.OUTPUT, require("node:crypto").createHash("sha256").update(process.env.FIELD_API_KEY ?? "").digest("hex"))'];
  const run = setupUnit({ steps: [], lanes: [{ id: 'pass-env', argv, env: { set: { OUTPUT: output }, pass: ['FIELD_API_KEY', 'PATH'] } }] });
  try {
    const ctx = { ...run.ctx, hostEnv: { ...run.ctx.hostEnv, FIELD_API_KEY: secret } };
    pinDispatch(ctx, run.unit, keptSpec(run.journal));
    const lane = loadUnitSpec(ctx, run.unit).spec.lanes[0]!;
    const result = await runLaneSeries(ctx, { type: 'stage', unit: U1, stage: 'lanes', attempt: 1 }, [lane], 'spec', {
      path: absPath(join(tmpDir('pass-tree'), 'tree')), checkout: { type: 'detached', at: run.base },
    }, absPath(join(tmpDir('pass-series'), 'series')), { acquire: reserveNow(ctx), rank: () => { throw new Error('not ranked'); }, signal: ctx.signal, sampleHost: readHostSample }, false);
    assert.equal(result.end.kind, 'green', JSON.stringify(result.end));
    assert.equal(readFileSync(output, 'utf8'), digest, 'the workload got the passed value');
    const launch = launchOf(run, spawnIntents(run).find((i) => i.expect.subject.purpose === 'lane')!);
    assert.deepEqual(launch.envPass, ['FIELD_API_KEY', 'PATH']);
    assert.equal(Object.hasOwn(launch.env, 'FIELD_API_KEY'), false);
    assert.deepEqual(filesContaining(run.runDir, secret), [], 'no file under the run dir holds the value');
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
