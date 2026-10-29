// Real 30-second lanes, real git, real runner exit.json files: calibration is learned only after three runs.
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId, invocationId, opKey } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath, isoTimeOf, repoPath } from '../../src/core/values.ts';
import { laneRevOf } from '../../src/holistic/types.ts';
import { laneOrder, laneRequest, reserveNow, runLaneSeries, runJourneySeries, suiteJourneyLane, specSeriesRoot } from '../../src/pipeline/lanes.ts';
import { loadUnitSpec } from '../../src/pipeline/stages.ts';
import { invocationDir, invoke } from '../../src/pipeline/invoke.ts';
import { cpuCost, laneCpuKey } from '../../src/resources/calibrate.ts';
import { commitOn } from '../fixtures/git8b-common.ts';
import { setupUnit, U1 } from '../fixtures/stage-common.ts';
import { tmpDir } from '../helpers/repo.ts';

const CLEAR = { load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 };

test('calibration reads completed long runner measurements once, journals the basis, and rebuilds after restart', { timeout: 240_000 }, async () => {
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
    if (attempt === 3) {
      const result = await runJourneySeries(run.ctx, { type: 'unit', parent, rt: runtime }, [suiteJourneyLane(lane)], checkout, { reuse: false, stop: () => false });
      assert.equal(result.end.kind, 'ran');
    } else {
      const result = await runLaneSeries(run.ctx, parent, [lane], 'spec', checkout, specSeriesRoot(run.ctx.runDir, parent), runtime, false);
      assert.equal(result.end.kind, 'green');
    }
  }
  const request = laneRequest(run.ctx, lane)!;
  assert.equal(request.cpu, 1);
  assert.deepEqual(request.cpuBasis, { kind: 'calibrated', key, value: 1, samples: 3 });
  assert.deepEqual(laneRequest(run.ctx, lane), request, 'cached invocations never count twice');
  assert.equal(laneRevOf(lane), rev);
  const reservations = run.journal.view.opsOf('resource.transition').filter((i) => i.expect.edge.type === 'reserve');
  assert.deepEqual(reservations.map((i) => i.expect.cpuBasis?.kind), ['default', 'default', 'default']);
  assert.deepEqual(reservations.map((i) => i.expect.cpuBasis && 'samples' in i.expect.cpuBasis ? i.expect.cpuBasis.samples : null), [0, 1, 2]);
  const spawns = run.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'lane' || i.expect.subject.purpose === 'journey');
  assert.deepEqual(spawns.map((i) => i.expect.cpuKey), [key, key, key], 'different checkout roots share the relative execution shape');
  const first = spawns[0]!;
  const firstInv = invocationId(first.op, first.ordinal);
  const exitPath = join(invocationDir(run.ctx.runDir, firstInv), 'exit.json');
  const lateReader = { ...run.ctx, journal: { view: readJournal(run.ctx.runDir, arcId(run.ctx.plan().arc)).view } };
  renameSync(exitPath, `${exitPath}.late`);
  try {
    assert.deepEqual(cpuCost(lateReader, key, 4), { kind: 'default', key, value: 4, samples: 2 });
  } finally {
    renameSync(`${exitPath}.late`, exitPath);
  }
  assert.deepEqual(cpuCost(lateReader, key, 4), request.cpuBasis, 'a late exit.json is retried and counted once');
  // An older executor stamped the full key even on file-targeted argv. Its real long run must not teach it.
  const subject = first.expect.subject;
  assert.ok(subject.purpose === 'lane');
  await invoke(run.journal, run.ctx.containment, {
    runDir: run.ctx.runDir, cpuKey: key,
    origin: { type: 'new', key: opKey('partial-calibration'), parent: first.parent, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)) },
    subject: { ...subject, files: [repoPath('test/partial.test.js')] },
    launch: () => ({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 30100)', 'partial'], cwd: run.ctx.repo, env: {}, stdinPath: null,
      stallMs: null, graceMs: 1_000, terminal: { type: 'command', purpose: 'lane', expectedExit: 0 } }),
  });
  assert.deepEqual(cpuCost(run.ctx, key, 4), request.cpuBasis, 'a partial run does not lower or enlarge the full-run sample window');
  run.journal.close();
  const restarted = { ...run.ctx, journal: { view: readJournal(run.ctx.runDir, arcId(run.ctx.plan().arc)).view } };
  assert.deepEqual(cpuCost(restarted, key, 4), request.cpuBasis);
  assert.deepEqual(cpuCost(restarted, key, 4, 6), { kind: 'explicit', value: 6 });
});
