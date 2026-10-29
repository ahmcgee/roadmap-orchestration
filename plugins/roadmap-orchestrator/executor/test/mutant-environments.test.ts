// Mutant environment ownership and parks over real processes, git and the unit driver's fault recovery.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobId, resourceName, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { unitTip } from '../src/pipeline/gate.ts';
import { arcJourneyLane, runJourneySeries } from '../src/pipeline/lanes.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { step } from '../src/pipeline/unit.ts';
import { bringDown, downEnvironments, environmentState, idleEnvironments } from '../src/resources/environments.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { faultUnit } from '../src/schedule/fault.ts';
import { checksArc } from './fixtures/checks-common.ts';
import { managedEnv, startedCalls } from './fixtures/env-common.ts';
import { vacuityArc } from './fixtures/repair-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep, testProbes } from './fixtures/stage-common.ts';
import { type ArcRun, contextFor, gateStep, mulBuild, stepUntil } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const STACK = resourceName('stack');
const V1 = unitId('v1');
const ARC = { type: 'arc' } as const;
const powered = (state: string) => {
  const cmd = { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } };
  return { resources: [{ name: 'db', probe: cmd, teardown: cmd }], environments: { stack: { ...managedEnv(state, 'stack', 60), resources: ['db'] } } };
};

/** Fault settlement, not the unwinding lane, must clean its reservation; every successful use must end. */
async function witnessFault(r: ArcRun, unit: string, state: string): Promise<void> {
  await assert.rejects(async () => {
    try {
      await step(r.ctx, r.unit(unit));
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
      assert.equal(r.journal.view.resources().get(STACK)?.status.state, 'running', 'unwinding leaves cleanup to fault recovery after quiescence');
      assert.equal((await faultUnit(r.ctx, r.unit(unit), error))?.kind, 'parked');
      throw error;
    }
  }, { code: 'EISDIR' });
  assert.ok([...r.journal.view.resources().values()].every((e) => e.status.state === 'free'));
  assert.deepEqual(idleEnvironments(r.ctx, Date.now(), () => false, true), [STACK], 'no leaked in-memory use after the contained fault');
  await downEnvironments(r.ctx);
  assert.equal(environmentState(r.journal.view, STACK), 'down');
  assert.equal(startedCalls(state).at(-1), 'down stack');
}

test('mutant.environment-fault: reproduction EISDIR releases its use and fault recovery permits shutdown', T, async () => {
  const state = tmpDir('mutant-env-fault');
  const { d } = vacuityArc({
    planExtra: powered(state),
    laneExtra: { journey: { resources: ['db'], argv: [process.execPath, '-e', 'require("node:fs").mkdirSync(process.env.ROADMAP_WITNESS_FILE)'] } },
  });
  const r = contextFor(d);
  try {
    await witnessFault(r, 'v1', state);
  } finally {
    r.journal.close();
  }
});

test('mutant.environment-fault: smoke EISDIR releases its use after a successful journey used the same environment', T, async () => {
  const state = tmpDir('smoke-env-fault');
  const a = await checksArc({
    steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
    activation: 'future', deliveredBy: ['u1'], testPaths: ['test/**'],
    resources: ['db'], plan: (p) => Object.assign(p, powered(state)),
    argv: (wrapper) => [process.execPath, '-e', 'if (process.cwd().includes(".smoke-")) require("node:fs").mkdirSync(process.env.ROADMAP_WITNESS_FILE); else process.exit(require("node:child_process").spawnSync(process.argv[1], {stdio:"inherit"}).status)', wrapper],
  });
  const r = contextFor(a.d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'teardown');
    await witnessFault(r, 'u1', state);
    assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'probe stack', 'down stack']);
  } finally {
    r.journal.close();
  }
});

for (const stage of ['reproduce', 'candidate'] as const) {
  test(`mutant.environment-park: ${stage} preserves the failed up's target until the environment probes healthy`, T, async () => {
    const state = tmpDir('mutant-env-park');
    const { d } = vacuityArc({ planExtra: powered(state), laneExtra: { journey: { resources: ['db'] } } });
    const r = contextFor(d);
    try {
      if (stage === 'candidate') {
        await stepUntil(r, 'v1', (f) => f.stage === 'gate');
        // Certify the unmutated candidate tree first, so only mutant acceptance needs the environment below.
        const lane = holisticInForce(r.ctx).obligations!.lanes[0]!;
        const arb = createArbiter(r.ctx);
        const series = await runJourneySeries(r.ctx, { type: 'job', job: jobId('audit', 99), acquireFirst: arb.acquireFirst }, [arcJourneyLane(lane)], {
          path: absPath(join(tmpDir('mutant-env-certified'), 'tree')), checkout: { type: 'detached', at: unitTip(r.ctx, V1) },
        }, { reuse: false, stop: () => false });
        assert.equal(series.end.kind, 'ran');
        await bringDown(r.ctx, STACK, ARC);
      }
      const journeys = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length;
      writeFileSync(join(state, 'stack.up-fails'), '');
      assert.equal((await step(r.ctx, r.unit('v1'))).kind, 'parked');
      const outcome = r.journal.view.unit(V1).decided!;
      assert.equal(outcome.stage, stage);
      assert.equal(outcome.outcome, 'env-unavailable');
      assert.deepEqual(outcome.park, { class: 'retryable', targets: [{ type: 'environment', environment: STACK }] });
      assert.equal(outcome.chargeable, false);
      assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length, journeys, 'candidate failure came from mutant acceptance, not its reusable journey');
      const { prober, signal } = testProbes(r.ctx);
      const probe = async () => {
        const jobs = prober.due(r.journal.view, new Date(Date.now() + 3_600_000));
        assert.equal(jobs.length, 1);
        assert.deepEqual(jobs[0]!.target, { type: 'environment', environment: STACK }, 'a healthy-host probe cannot recover this park');
        return prober.run(jobs[0]!, signal);
      };
      assert.equal(await probe(), 'fail');
      rmSync(join(state, 'stack.up-fails'));
      writeFileSync(join(state, 'stack.probe-fails'), '');
      assert.equal(await probe(), 'fail', 'successful up alone cannot recover an unhealthy environment');
      assert.equal(r.journal.view.unit(V1).status, 'park-pending');
      assert.equal(r.journal.view.unit(V1).lastRecovery, null, 'failed probes never manufacture recovery and repeat parks');
      rmSync(join(state, 'stack.probe-fails'));
      assert.equal(await probe(), 'pass');
      assert.equal(r.journal.view.unit(V1).status, 'active');
      assert.equal(environmentState(r.journal.view, STACK), 'up');
    } finally {
      r.journal.close();
    }
  });
}
