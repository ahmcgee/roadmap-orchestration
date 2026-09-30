// The M2 paid fixture (evals/m2/{setup,driver,check}.ts) validated end to end without paying: the run here is
// fake-backed (`driver --fake`, the fake backends behind PATH shims playing evals/m2/scenarios/story, a host
// dir inside the fixture), real processes, real git, the real supervisor and a real SIGKILL of the executor.
// Proves the setup is valid input with a working estate pool, the driver fires every forcing device (G9) and
// the arc completes, every check criterion passes on it, a used fixture dir is refused, and the criteria
// discriminate (a second owner in an instance's history, a report whose merge-tree saw no conflict). Named
// tests: evals-m2.setup-valid, evals-m2.fake, evals-m2.rerun-refused, evals-m2.tamper-owner,
// evals-m2.tamper-reentry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { resourceName } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { parsePlan } from '../src/input/plan.ts';
import { overCapacity } from '../src/resources/pool.ts';
import { loadSpec } from '../src/spec/spec.ts';
import { BRANCHES, CANNOT_SHOW, type CheckResult } from '../evals/m2/check.ts';
import type { Report } from '../evals/m2/driver.ts';
import { CPU_CAPACITY, EDGE, ESTATE_HOLD, INTEGRATION, MAIN, POOL, POOL_SIZE, RIGHT_HOLD, UNITS, instanceDir, layout, teardownFailsOnce } from '../evals/m2/layout.ts';
import { type Exit, fixture, runUntilExit } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type ScenarioFile, readCalls } from './helpers/scenario.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';

after(assertNoSurvivors);

const EVALS = fileURLToPath(new URL('../evals/m2/', import.meta.url));
const STORY = join(EVALS, 'scenarios', 'story');
/** The driver's own hard timeout under --fake is 10 min; the test allows it that and a margin. */
const RUN_MS = 12 * 60_000;
const T = { timeout: 2 * RUN_MS };

const script = (name: string, args: readonly string[]): Promise<Exit> =>
  runUntilExit(process.execPath, [join(EVALS, name), ...args], { env: process.env, timeoutMs: RUN_MS });

type Checked = Readonly<{ exit: Exit; result: CheckResult }>;

async function check(dir: string): Promise<Checked> {
  const exit = await script('check.ts', [dir]);
  const [json, notExercised, cannotShow] = exit.stdout.split('\n');
  assert.ok(json !== undefined && notExercised !== undefined && cannotShow !== undefined, `check printed: ${exit.stdout}; stderr: ${exit.stderr}`);
  const result = JSON.parse(json) as CheckResult;
  assert.equal(notExercised, `NOT EXERCISED: ${result.notExercised.length === 0 ? '(none)' : result.notExercised.join(', ')}`);
  assert.equal(cannotShow, `CANNOT SHOW: ${CANNOT_SHOW.join(', ')}`);
  assert.equal(exit.code, result.pass ? 0 : 1, 'check exits non-zero exactly when a criterion fails');
  return { exit, result };
}

const failing = (c: Checked): readonly string[] => c.result.criteria.filter((x) => !x.pass).map((x) => x.name);
const criterion = (c: Checked, name: string) => {
  const found = c.result.criteria.find((x) => x.name === name);
  assert.ok(found !== undefined, `no criterion ${name}`);
  return found;
};

/** Runs estate.ts as a workload of `unit` on instance `n` would (owner label, instance binding). */
function estate(l: ReturnType<typeof layout>, unit: string, n: number, args: readonly string[]) {
  return spawnSync(process.execPath, [join(EVALS, 'estate.ts'), ...args], {
    encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'], RESOURCE_OWNER: `${l.arc}/${unit}`, RESOURCE_INSTANCE_ESTATE: String(n) },
  });
}

test('evals-m2.setup-valid: setup lays out a plan parsePlan accepts, specs the validator accepts, a green repo and a working estate pool', T, async () => {
  const dir = join(tmpDir('m2-setup'), 'fx');
  const out = await script('setup.ts', [dir]);
  assert.equal(out.code, 0, out.stderr);
  const l = layout(dir);
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  assert.equal(plan.arc, l.arc);
  assert.deepEqual(plan.units.map((u) => u.id), [...UNITS]);
  assert.deepEqual(plan.capacity, { cpu: CPU_CAPACITY });
  assert.deepEqual(plan.resources.map((r) => [r.name, r.pool]), [[POOL, { size: POOL_SIZE }]]);
  const unit = (id: string) => plan.units.find((u) => u.id === id)!;
  assert.deepEqual(unit('top').after, ['left', 'right']);
  assert.deepEqual(unit('top').contingent.map((e) => e.id), [EDGE]);
  assert.equal(unit('urgent').origin, 'checkpoint');
  assert.deepEqual(unit('urgent').after, []);
  const specs = new Map(plan.units.map((u) => [u.id, loadSpec(absPath(join(l.input, u.spec)))] as const));
  const barrier = (id: string) => specs.get(plan.units.find((u) => u.id === id)!.id)!.lanes.filter((x) => x.argv.includes(ESTATE_HOLD) || x.argv.includes(RIGHT_HOLD)).map((x) => x.id);
  assert.deepEqual(['base', 'left', 'right', 'top', 'urgent'].map(barrier), [[], [ESTATE_HOLD], [ESTATE_HOLD, RIGHT_HOLD], [], []], 'only left and right wait at the estate barrier; right also at its own');
  for (const [id, spec] of specs) {
    assert.equal(spec.unit, id);
    assert.ok(spec.lanes.some((x) => x.resources.includes(resourceName(POOL))), `${id} has an estate lane`);
  }
  assert.deepEqual(overCapacity(plan, { cpu: CPU_CAPACITY }, specs, null), [], 'no request is over the @cpu capacity');
  assert.equal(git(l.repo, 'rev-parse', INTEGRATION), git(l.repo, 'rev-parse', MAIN));
  assert.equal(plan.baseline, git(l.repo, 'rev-parse', MAIN));
  const suite = await runUntilExit('npm', ['test'], { env: process.env, cwd: l.repo, timeoutMs: 60_000 });
  assert.equal(suite.code, 0, `the suite is green at the baseline: ${suite.stdout}`);

  // The pool: the probe contract, a barrier held for exactly its rounds, a teardown that fails exactly once.
  assert.equal(estate(l, 'left', 1, ['probe', l.estate]).status, 0);
  const env = { PATH: process.env['PATH'], RESOURCE_OWNER: `${l.arc}/left`, RESOURCE_INSTANCE_ESTATE: '1' };
  const hold = runUntilExit(process.execPath, [join(EVALS, 'estate.ts'), 'hold', l.estate, l.barriers, ESTATE_HOLD, '2', '60000'], { env, timeoutMs: 60_000 });
  const reachedFile = join(l.barriers, `left.${ESTATE_HOLD}.1.reached`);
  for (let i = 0; i < 300 && !existsSync(reachedFile); i++) await sleep(100);
  assert.ok(existsSync(reachedFile), 'the hold waits at round 1');
  assert.equal(estate(l, 'left', 1, ['probe', l.estate]).status, 10, 'its own label');
  assert.equal(estate(l, 'right', 1, ['probe', l.estate]).status, 11, 'another unit\'s');
  writeFileSync(join(l.barriers, `left.${ESTATE_HOLD}.1.release`), '');
  assert.equal((await hold).code, 0, 'released, the hold leaves');
  assert.equal(estate(l, 'right', 1, ['probe', l.estate]).status, 0, 'free once the hold left');
  writeFileSync(join(l.barriers, `left.${ESTATE_HOLD}.2.release`), '');
  assert.equal(estate(l, 'left', 1, ['hold', l.estate, l.barriers, ESTATE_HOLD, '2', '60000']).status, 0, 'every round released: the lane passes straight through');
  assert.equal(existsSync(join(l.barriers, `left.${ESTATE_HOLD}.2.reached`)), false, 'round 2 was never waited at');
  writeFileSync(teardownFailsOnce(l, 2), '');
  assert.equal(estate(l, 'left', 2, ['teardown', l.estate]).status, 1, 'the armed teardown fails');
  assert.equal(existsSync(teardownFailsOnce(l, 2)), false, 'consuming its marker');
  assert.equal(estate(l, 'left', 2, ['teardown', l.estate]).status, 0, 'once');
  assert.deepEqual(readFileSync(join(instanceDir(l, 1), 'history.log'), 'utf8').split('\n').filter((x) => x !== '').map((x) => x.split(' ')[0]), ['enter', 'leave', 'enter', 'leave']);
});

type Fixture = Readonly<{ dir: string; driver: Exit; report: Report; checked: Checked }>;

describe('evals-m2: the fake-backed fixture run', () => {
  let fx: Fixture;
  before(async () => {
    const dir = join(tmpDir('m2-fixture'), 'fx');
    const setup = await script('setup.ts', [dir]);
    assert.equal(setup.code, 0, setup.stderr);
    const l = layout(dir);
    // The driver ends its run itself; a driver that failed or timed out may leave it going, so it is torn down here.
    const scope: RunScope = {
      paths: [dir],
      stop: async () => {
        const stop = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), join(l.fake, 'host'), 'stop', '--repo', l.repo, '--arc', l.arc], { env: process.env, timeoutMs: 30_000 });
        assert.equal(stop.code, 0, `roadmap stop: ${stop.stderr}`);
      },
    };
    track(scope);
    const driver = await script('driver.ts', [dir, '--profile', 'default', '--fake', STORY]).finally(() => teardown(scope));
    const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
    fx = { dir, driver, report, checked: await check(dir) };
  }, T);

  test('evals-m2.fake: every forcing device fired in order, the arc completed on the respawned generation, and every criterion passes', () => {
    const { driver, report, checked } = fx;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.equal(report.endedBy, 'exit', JSON.stringify(report.devices));
    const d = report.devices;
    assert.equal(d.failed, null);
    for (const [name, value] of Object.entries(d)) if (name !== 'failed') assert.notEqual(value, null, `device ${name} fired`);
    assert.equal(report.start.ready?.generation, 1);
    assert.equal(d.kill?.generation, 1);
    assert.equal(d.respawn?.generation, 2, 'the supervisor respawned the killed executor');
    assert.equal(report.generation, 2, 'the respawned generation finished the arc');
    assert.deepEqual(report.exit, {
      kind: 'complete',
      units: [
        { unit: 'base', result: 'merged' }, { unit: 'left', result: 'merged' }, { unit: 'right', result: 'superseded', by: 'right2' },
        { unit: 'top', result: 'merged' }, { unit: 'urgent', result: 'merged' }, { unit: 'right2', result: 'merged' },
      ],
    });
    assert.deepEqual(failing(checked), [], JSON.stringify(checked.result.criteria));
    assert.equal(checked.result.criteria.length, 14);
    assert.match(criterion(checked, 'no-overlap').detail, /both instances at once: true/);
    assert.match(criterion(checked, 'cleanup-survival').detail, /live [a-z0-9]+ lanes [0-9]+ estate#2: parked seq [0-9]+, probe pass seq [0-9]+, re-ran as lanes/);
    assert.match(criterion(checked, 'cleanup-survival').detail, /recovery [a-z0-9]+ lanes [0-9]+ estate#1: failed seq [0-9]+, probe pass seq [0-9]+, re-ran as lanes/);
    assert.deepEqual(checked.result.notExercised, [...BRANCHES], 'the fake story takes none of the branches M2 covers elsewhere');
    // Every step of the story was played, each by a call that matched it.
    const scenario = join(layout(fx.dir).fake, 'scenario.json');
    const calls = readCalls(scenario);
    const steps = (JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile).steps;
    assert.deepEqual(calls.filter((c) => c.step === null), [], 'no call went unmatched');
    assert.deepEqual(calls.map((c) => c.step).sort((a, b) => a! - b!), steps.map((_, i) => i));
  });

  test('evals-m2.rerun-refused: setup and the driver refuse a fixture dir that was used', async () => {
    const setup = await script('setup.ts', [fx.dir]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /is not empty/);
    const driver = await script('driver.ts', [fx.dir, '--profile', 'default', '--fake', STORY]);
    assert.notEqual(driver.code, 0);
    assert.match(driver.stderr, /report\.json exists: a fixture dir is run once/);
  });

  test('evals-m2.tamper-owner: a second owner in an instance\'s history fails single-owner', async () => {
    const path = join(instanceDir(layout(fx.dir), 1), 'history.log');
    const before_ = readFileSync(path, 'utf8');
    const lines = before_.split('\n').filter((x) => x !== '');
    const [first] = lines;
    assert.ok(first !== undefined && first.startsWith('enter '));
    // A second enter right after the first one, before its leave.
    writeFileSync(path, `${[first, first.replace(/\/[a-z0-9-]+ /, '/intruder '), ...lines.slice(1)].join('\n')}\n`);
    const tampered = await check(fx.dir);
    assert.deepEqual(failing(tampered), ['single-owner']);
    assert.match(criterion(tampered, 'single-owner').detail, /intruder entered while .* held it/);
    writeFileSync(path, before_);
    assert.deepEqual(failing(await check(fx.dir)), [], 'restoring the history restores the pass');
  });

  test('evals-m2.tamper-reentry: a report whose merge-tree saw no conflict fails the re-entry criterion', async () => {
    const path = layout(fx.dir).report;
    const before_ = readFileSync(path, 'utf8');
    const report = JSON.parse(before_) as Report;
    writeFileSync(path, JSON.stringify({ ...report, devices: { ...report.devices, mergeTree: { ...report.devices.mergeTree, conflict: false, paths: [] } } }));
    const tampered = await check(fx.dir);
    assert.deepEqual(failing(tampered), ['reentry']);
    assert.match(criterion(tampered, 'reentry').detail, /the driver saw no conflict on src\/registry\.js/);
    writeFileSync(path, before_);
    assert.deepEqual(failing(await check(fx.dir)), [], 'restoring the report restores the pass');
  });
});

