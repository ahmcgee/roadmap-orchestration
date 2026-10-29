// dev.17 plan environments (src/resources/environments.ts), integrated over real processes and real git: env-tool.ts
// stands in for an environment's up, down and probe, logging every call. Named tests: env.lazy-up-reuse,
// env.idle-teardown, env.start-waits-for-stop, env.probe-fails-parks, env.up-fails-parks, env.job-suite-lane, env.plain-no-lifecycle,
// env.unavailable-to-arc, env.crash-before-up-runs, env.crash-after-up-ran, env.pause-brings-down, env.schema.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, test } from 'node:test';
import type { DesignRecord } from '../src/core/design.ts';
import { arcId, jobId, laneId, resourceName } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { SchemaError } from '../src/core/validate.ts';
import { arcLaneDef } from '../src/holistic/types.ts';
import { parsePlan } from '../src/input/plan.ts';
import { type StageParent, pinDispatch } from '../src/pipeline/dispatch.ts';
import { type LaneRuntime, laneOrder, reserveNow, runJourneySeries, runLaneSeries, specSeriesRoot, suiteJourneyLane } from '../src/pipeline/lanes.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { lanes, loadUnitSpec } from '../src/pipeline/stages.ts';
import { designFaults } from '../src/pipeline/design.ts';
import { laneRows } from '../src/preflight/lanerows.ts';
import { spawnReconciler } from '../src/recover/spawn.ts';
import {
  bringDown, downEnvironments, environmentState, environmentUnavailable, idleEnvironments, releaseEnvironment, settleEnvironments, useEnvironment,
} from '../src/resources/environments.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { commitOn } from './fixtures/git8b-common.ts';
import { type EnvRun, managedEnv, openEnvRun, plainEnv, startedCalls, envCalls } from './fixtures/env-common.ts';
import { receiptOf, startScheduler, stopScheduler, submit } from './fixtures/sched-common.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, keptSpec, outcomeFacts, setupUnit, spawnIntents, started, testProbes } from './fixtures/stage-common.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { until } from './fixtures/exec-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const STACK = resourceName('stack');
const CLEAR = { load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 };
const ARC = { type: 'arc' } as const;

/** A lane on environment `stack` that passes: a spec lane's cadence `unit`, a suite lane's `candidate`. */
const envLane = (id: string, cadence: 'unit' | 'candidate' = 'unit', environment = 'stack'): LaneJson => ({ id, argv: ['sh', '-c', 'exit 0'], cadence, environment });

/** A run whose plan declares `stack` as `decl(stateDir)` and whose spec has `lanesJson`. */
function withEnv(decl: (state: string) => unknown, lanesJson: readonly LaneJson[]): Readonly<{ run: StageRun; state: string }> {
  const state = tmpDir('env-state');
  const run = setupUnit({ steps: [], lanes: lanesJson, environments: { stack: decl(state) as never } });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  return { run, state };
}

const runtime = (run: StageRun): LaneRuntime => ({ acquire: reserveNow(run.ctx), rank: () => { throw new Error('not ranked'); }, signal: new AbortController().signal, sampleHost: () => CLEAR });

/**
 * The unit's spec lanes as lanes attempt `attempt`, in a checkout of its own: the first at the base commit, a later one at
 * a commit on it adding `attempt-<n>`. A series reuses an earlier clean pass on the same input (dev.17, the one reuse
 * key: any set, any unit), so a later attempt runs on a tree of its own: each lane runs again.
 */
function series(run: StageRun, attempt: number) {
  const parent: StageParent = { type: 'stage', unit: U1, stage: 'lanes', attempt };
  const at = attempt === 1 ? run.base : commitOn(run.repo, run.base, { [`attempt-${attempt}`]: `${attempt}\n` }, `attempt ${attempt}\n`);
  const checkout = { path: absPath(join(tmpDir('env-tree'), 'tree')), checkout: { type: 'detached', at } } as const;
  return runLaneSeries(run.ctx, parent, laneOrder(loadUnitSpec(run.ctx, run.unit).spec), 'spec', checkout, specSeriesRoot(run.ctx.runDir, parent), runtime(run), false);
}

const never = (): boolean => false;
const laneSpawns = (run: StageRun) => spawnIntents(run).filter((i) => i.expect.subject.purpose === 'lane');

test('env.lazy-up-reuse: nothing runs before a lane needs it; the first lane brings it up, each use probes it, and two successive series within idleMinutes share the one up', T, async () => {
  const { run, state } = withEnv((s) => managedEnv(s, 'stack', 60), [envLane('one'), envLane('two')]);
  assert.deepEqual(startedCalls(state), [], 'declared and loaded, the environment is not touched');
  assert.equal(environmentState(run.journal.view, STACK), 'down');

  const first = await series(run, 1);
  assert.equal(first.end.kind, 'green');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'probe stack'], 'one up, a probe before each lane');
  assert.equal(environmentState(run.journal.view, STACK), 'up');
  assert.deepEqual(idleEnvironments(run.ctx, Date.now(), never, false), [], 'used just now, it is not idle');

  const second = await series(run, 2);
  assert.equal(second.end.kind, 'green');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'probe stack', 'probe stack', 'probe stack'], 'the second series reuses it: no second up');
  assert.equal(laneSpawns(run).length, 4);
  // The lanes reserved the environment's unit, and released it.
  assert.deepEqual(run.journal.view.resources().get(STACK)?.status, { state: 'free' });
});

test('env.idle-teardown: once idleMinutes pass with no use it is brought down; the next use brings it up again', T, async () => {
  const { run, state } = withEnv((s) => managedEnv(s, 'stack', 0.002), [envLane('one')]);
  assert.equal((await series(run, 1)).end.kind, 'green');
  assert.deepEqual(idleEnvironments(run.ctx, Date.now(), () => true, false), [], 'a lane holding or waiting for its unit keeps it up');
  await sleep(300);
  assert.deepEqual(idleEnvironments(run.ctx, Date.now(), never, false), [STACK]);
  assert.equal(await bringDown(run.ctx, STACK, ARC), true);
  assert.equal(environmentState(run.journal.view, STACK), 'down');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack']);
  assert.deepEqual(idleEnvironments(run.ctx, Date.now(), never, false), [], 'down, nothing to bring down');

  assert.equal((await series(run, 2)).end.kind, 'green');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack', 'up stack', 'probe stack']);
});

test('env.start-waits-for-stop: a use while its down is in flight waits for the down to end, then brings it up', T, async () => {
  const { run, state } = withEnv((s) => managedEnv(s, 'stack', 60), [envLane('one')]);
  assert.equal((await useEnvironment(run.ctx, STACK, ARC)).kind, 'ready');
  releaseEnvironment(run.journal, STACK);
  writeFileSync(join(state, 'stack.down-ms'), '600');
  const stopping = bringDown(run.ctx, STACK, ARC);
  const starting = useEnvironment(run.ctx, STACK, ARC);
  const [stopped, started_] = await Promise.all([stopping, starting]);
  assert.equal(stopped, true);
  assert.equal(started_.kind, 'ready');
  assert.deepEqual(envCalls(state), [
    'up stack', 'up-done stack', 'probe stack', 'probe-done stack',
    'down stack', 'down-done stack', 'up stack', 'up-done stack', 'probe stack', 'probe-done stack',
  ], 'the second up starts only after the down ended');
  // One transition at a time in the log too: no up intent while the down was open.
  const lifecycle = readJournal(run.runDir, arcId(run.ctx.plan().arc)).events.flatMap((e) => {
    if (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'environment' && e.expect.subject.action !== 'probe') return [`${e.expect.subject.action}:${e.op}`];
    return [];
  });
  assert.equal(lifecycle.length, 3);
  releaseEnvironment(run.journal, STACK);
});

test('env.probe-fails-parks: a failed probe parks the lanes stage on the environment, retryable and uncharged, never red; it is brought down, and the park\'s probe brings it up again', T, async () => {
  const { run, state } = withEnv((s) => managedEnv(s, 'stack', 60), [envLane('one')]);
  writeFileSync(join(state, 'stack.probe-fails'), '');
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'env-unavailable');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.outcome === 'env-unavailable' && !fact.chargeable);
  assert.deepEqual(fact.kind === 'stage-outcome' ? fact.park : null, { class: 'retryable', targets: [{ type: 'environment', environment: 'stack' }] });
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);
  assert.equal(laneSpawns(run).length, 0, 'the lane never ran');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack'], 'brought down after its failed probe');
  assert.equal(environmentState(run.journal.view, STACK), 'down');
  assert.deepEqual(run.journal.view.resources().get(STACK)?.status, { state: 'free' }, 'the reservation is cleaned');

  // The park's probe: still failing, then fixed.
  const { prober } = testProbes(run.ctx);
  const probeAll = async (): Promise<readonly string[]> => {
    const out: string[] = [];
    for (const job of prober.due(run.journal.view, new Date(Date.now() + 3_600_000))) out.push(await prober.run(job, new AbortController().signal));
    return out;
  };
  assert.deepEqual(await probeAll(), ['fail']);
  assert.equal(run.journal.view.unit(U1).status, 'park-pending');
  rmSync(join(state, 'stack.probe-fails'));
  assert.deepEqual(await probeAll(), ['pass']);
  assert.equal(run.journal.view.unit(U1).status, 'active', 'the passing probe recovers the park');
  assert.equal(environmentState(run.journal.view, STACK), 'up', 'left up for the lane\'s re-run');
  assert.deepEqual(startedCalls(state).slice(3), ['up stack', 'probe stack', 'down stack', 'up stack', 'probe stack']);
});

test('env.up-fails-parks: a failed up parks the lanes stage on the environment, the partial environment brought down', T, async () => {
  const { run, state } = withEnv((s) => managedEnv(s, 'stack', 60), [envLane('one')]);
  writeFileSync(join(state, 'stack.up-fails'), '');
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'env-unavailable');
  assert.deepEqual(startedCalls(state), ['up stack', 'down stack'], 'no probe after a failed up; a down for whatever it left');
  assert.equal(environmentState(run.journal.view, STACK), 'down');
  assert.equal(laneSpawns(run).length, 0);
});

test('env.job-suite-lane: a suite lane in a job\'s journey series uses its environment; one that does not come up gives no verdict (blocked), never red', T, async () => {
  const state = tmpDir('env-state');
  const run = setupUnit({ steps: [], suite: [envLane('suite-env', 'candidate')], environments: { stack: managedEnv(state, 'stack', 60) as never } });
  const ctx = { ...run.ctx, acquireFirst: createArbiter(run.ctx).acquireFirst };
  const lane = suiteJourneyLane(run.ctx.plan().suite.lanes[0]!);
  const go = (n: number) => runJourneySeries(ctx, { type: 'job', job: jobId('audit', n), acquireFirst: ctx.acquireFirst }, [lane], {
    path: absPath(join(tmpDir('env-journey'), 'checkout')), checkout: { type: 'detached', at: run.base },
  }, { reuse: false, stop: () => false });
  writeFileSync(join(state, 'stack.probe-fails'), '');
  const blocked = await go(1);
  assert.equal(blocked.end.kind, 'blocked');
  assert.match(blocked.end.kind === 'blocked' ? blocked.end.detail : '', /^environment stack: probe .* exited 1; brought down again/);
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack']);
  rmSync(join(state, 'stack.probe-fails'));
  const ran = await go(2);
  assert.equal(ran.end.kind, 'ran');
  assert.equal(ran.runs[0]?.verdict, 'pass');
  assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack', 'up stack', 'probe stack']);
});

test('env.plain-no-lifecycle: an environment without up and down is reserved and probed, never started or stopped', T, async () => {
  const { run, state } = withEnv((s) => plainEnv(s, 'stack'), [envLane('one'), envLane('two')]);
  assert.equal((await series(run, 1)).end.kind, 'green');
  assert.deepEqual(startedCalls(state), ['probe stack', 'probe stack']);
  assert.deepEqual(idleEnvironments(run.ctx, Date.now() + 3_600_000, never, true), []);
  await settleEnvironments(run.ctx);
  await downEnvironments(run.ctx);
  assert.deepEqual(startedCalls(state), ['probe stack', 'probe stack'], 'no lifecycle command, ever');
  assert.equal(environmentState(run.journal.view, STACK), 'down');
});

test('env.unavailable-to-arc (item 10): an environment whose last probe failed is unavailable to the arc, and a clause only its lane exercises is a plan defect; a passing probe makes it available again', T, async () => {
  const { run, state } = withEnv((s) => plainEnv(s, 'stack'), [envLane('one')]);
  const spec = loadUnitSpec(run.ctx, run.unit).spec;
  const record = (lanes: readonly string[]): DesignRecord => ({
    kind: 'module', changes: [{ system: null, paths: [repoPattern('src/**')], lines: 10 }], interfaces: [], failureModes: [],
    clauses: [{ clause: spec.acceptance[0]!.id, lanes: lanes.map((l) => laneId(l)) }], breaks: { tests: [], docs: [] }, experiments: [],
  });
  assert.equal(environmentUnavailable(run.journal.view, STACK), null, 'never probed: presumed available');
  assert.deepEqual(designFaults(run.ctx, spec, record(['one'])), { reasons: [], defects: [] });
  writeFileSync(join(state, 'stack.probe-fails'), '');
  assert.equal((await useEnvironment(run.ctx, STACK, ARC)).kind, 'unavailable');
  assert.match(environmentUnavailable(run.journal.view, STACK) ?? '', /environment stack's last probe in this arc failed/);
  const faults = designFaults(run.ctx, spec, record(['one']));
  assert.deepEqual(faults.reasons, []);
  assert.equal(faults.defects.length, 1);
  assert.match(faults.defects[0]!, /exercised by no lane that can run in this arc before the unit merges \(environment stack's last probe in this arc failed\)/);
  rmSync(join(state, 'stack.probe-fails'));
  assert.equal((await useEnvironment(run.ctx, STACK, ARC)).kind, 'ready');
  releaseEnvironment(run.journal, STACK);
  assert.equal(environmentUnavailable(run.journal.view, STACK), null, 'its last probe passed');
  assert.deepEqual(designFaults(run.ctx, spec, record(['one'])).defects, []);
});

describe('env.crash: a crash inside the up, then recovery (the spawn reconciler) and the scheduler\'s settle', () => {
  const crashed = async (label: string): Promise<Readonly<{ r: EnvRun; state: string }>> => {
    const { run, state } = withEnv((s) => managedEnv(s, 'stack', 60), [envLane('one')]);
    const r: EnvRun = { arc: run.ctx.plan().arc, runDir: run.runDir, repo: run.repo, planPath: join(run.planDir, 'plan.json'), hostDir: run.ctx.hostDir, name: STACK };
    run.journal.close();
    const trigger = writeTrigger(tmpDir('env-trigger'), { label, occurrence: 1 });
    const exit = await runFixture('env-child.ts', [JSON.stringify(r)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
    assert.equal(exit.signal, 'SIGKILL', exit.stderr);
    assertFired(trigger);
    return { r, state };
  };

  const recoverSpawns = async (r: EnvRun) => {
    const opened = openEnvRun(r);
    const open = opened.journal.view.openIntents();
    assert.equal(open.length, 1, 'the up is open');
    const [intent] = open;
    assert.ok(intent !== undefined && intent.kind === 'proc.spawn' && intent.expect.subject.purpose === 'environment' && intent.expect.subject.action === 'up');
    assert.equal(environmentState(opened.journal.view, STACK), 'starting');
    await spawnReconciler(opened.ctx)(intent, opened.journal.view);
    assert.deepEqual(opened.journal.view.openIntents(), []);
    return opened;
  };

  it('env.crash-before-up-runs: an up intent with no runner is lost; the environment is unsettled and brought down at the start', T, async () => {
    const { r, state } = await crashed('spawn.after-intent');
    assert.deepEqual(startedCalls(state), [], 'the up never ran');
    const { ctx, journal } = await recoverSpawns(r);
    assert.equal(environmentState(journal.view, STACK), 'unsettled');
    await settleEnvironments(ctx);
    assert.equal(environmentState(journal.view, STACK), 'down');
    assert.deepEqual(startedCalls(state), ['down stack']);
    assert.equal((await useEnvironment(ctx, STACK, ARC)).kind, 'ready', 'the next use starts from nothing');
    assert.deepEqual(startedCalls(state), ['down stack', 'up stack', 'probe stack']);
    releaseEnvironment(journal, STACK);
    journal.close();
  });

  it('env.crash-after-up-ran: an up whose runner exited is reconciled done; the environment is up and its idle clock resumes', T, async () => {
    const { r, state } = await crashed('spawn.after-runner-exit');
    assert.deepEqual(envCalls(state), ['up stack', 'up-done stack']);
    const { ctx, journal } = await recoverSpawns(r);
    assert.equal(environmentState(journal.view, STACK), 'up');
    await settleEnvironments(ctx);
    assert.deepEqual(startedCalls(state), ['up stack'], 'nothing to settle');
    assert.deepEqual(idleEnvironments(ctx, Date.now(), never, false), [], 'its idle clock starts again at the start');
    assert.deepEqual(idleEnvironments(ctx, Date.now() + 61 * 60_000, never, false), [STACK]);
    assert.equal((await useEnvironment(ctx, STACK, ARC)).kind, 'ready');
    assert.deepEqual(startedCalls(state), ['up stack', 'probe stack'], 'used again without a second up');
    releaseEnvironment(journal, STACK);
    journal.close();
  });
});

test('env.pause-brings-down: under `pause --all` the scheduler brings an up environment down at once, whatever its idle clock', T, async () => {
  const state = tmpDir('env-state');
  const d = setupArc({ steps: [] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Record<string, unknown>;
  plan['environments'] = { stack: managedEnv(state, 'stack', 600) };
  writeFileSync(d.planPath, JSON.stringify(plan));
  const r = contextFor(d);
  try {
    assert.equal((await useEnvironment(r.ctx, STACK, ARC)).kind, 'ready');
    releaseEnvironment(r.journal, STACK);
    const pause = submit(r, { type: 'pause', target: { type: 'all' } });
    const s = startScheduler(r);
    await receiptOf(r, pause);
    await until(() => environmentState(r.journal.view, STACK) === 'down', 60_000, 'the environment to be brought down');
    assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack']);
    assert.equal((await stopScheduler(r, s)).kind, 'stop');
    assert.deepEqual(startedCalls(state), ['up stack', 'probe stack', 'down stack'], 'down once');
  } finally {
    r.journal.close();
  }
});

describe('env.schema', () => {
  const base = (extra: Record<string, unknown>) => ({
    schema: 'roadmap/plan-m1', arc: 'a1', integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/tmp/wt', contracts: [], rulings: 'r.md',
    architectureDoc: 'ARCHITECTURE.md', direction: 'd', suite: { lanes: [] }, resources: [], units: [{ id: 'u1', spec: 'u1.json', risk: 'med', scope: ['src/**'], resources: [] }],
    ...extra,
  });
  const cmd = { argv: ['true'], cwd: '.', env: { set: {}, pass: [] } };

  it('reads a managed and a plain environment, ascending by name; up, down and idleMinutes come together', () => {
    const plan = parsePlan(base({ environments: { zeta: { probe: cmd }, alpha: { up: cmd, down: cmd, probe: cmd, idleMinutes: 0.5 } } }));
    assert.deepEqual(plan.environments?.map((e) => [e.name, e.lifecycle?.idleMinutes ?? null]), [['alpha', 0.5], ['zeta', null]]);
    assert.throws(() => parsePlan(base({ environments: { s: { up: cmd, probe: cmd, idleMinutes: 1 } } })), SchemaError);
    assert.throws(() => parsePlan(base({ environments: { s: { probe: cmd, idleMinutes: 1 } } })), SchemaError);
    assert.throws(() => parsePlan(base({ environments: { s: { up: cmd, down: cmd, probe: cmd, idleMinutes: 0 } } })), SchemaError);
    assert.throws(() => parsePlan(base({ environments: { s: { up: cmd, down: cmd, idleMinutes: 1 } } })), SchemaError, 'a probe is required');
  });

  it('shares the resource namespace: an environment named like a declared resource, or the slot, is refused', () => {
    assert.throws(() => parsePlan(base({ resources: [{ name: 'db', probe: cmd, teardown: cmd }], environments: { db: { probe: cmd } } })), /no declared resource has/);
    assert.throws(() => parsePlan(base({ environments: { 'integration-slot': { probe: cmd } } })), SchemaError);
  });

  it('an undeclared environment is unrunnable; declared build-cadence environments are executor-only; an arc lane never names one', () => {
    const lane = (id: string, cadence: 'build' | 'candidate', environment: string) => ({
      id, argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, cadence, resources: [], evidenceGlobs: [], environment,
    });
    const plan = parsePlan(base({ environments: { stack: { probe: cmd } }, suite: { lanes: [lane('known', 'candidate', 'stack'), lane('unknown', 'candidate', 'nope'), lane('fast', 'build', 'stack')] } }));
    const rows = laneRows(plan, [], () => { throw new Error('no unit is checked'); }, process.env);
    assert.deepEqual(rows.map((r) => ('lane' in r ? [r.lane, r.problem.type] : null)), [
      ['unknown', 'unknown-environment'],
    ]);
    assert.throws(() => arcLaneDef({ ...lane('arc', 'candidate', 'stack'), reporter: 'jsonl' }, 'lane'), /absent on an arc lane/);
  });
});
