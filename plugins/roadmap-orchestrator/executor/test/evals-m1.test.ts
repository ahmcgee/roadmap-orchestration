// The M1 paid fixture (evals/m1/{setup,driver,check}.ts) validated end to end without paying: every run here
// is fake-backed (`driver --fake`, the fake backends behind PATH shims, a host dir inside the fixture), real
// processes, real git. Proves the setup is valid input, the driver runs both profiles to an end, check passes
// honest runs, its non-exercised list tracks what the journal shows, and its criteria discriminate
// (a tampered integration branch, a tampered snapshot blob). Named tests: evals-m1.setup-valid,
// evals-m1.clean-default, evals-m1.clean-claude-only, evals-m1.bumpy, evals-m1.parked-stop,
// evals-m1.tamper-integration, evals-m1.tamper-snapshot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { parsePlan } from '../src/input/plan.ts';
import { absPath } from '../src/core/values.ts';
import { loadSpec } from '../src/spec/spec.ts';
import { BRANCHES, type Branch, type CheckResult } from '../evals/m1/check.ts';
import type { Report } from '../evals/m1/driver.ts';
import { ARC, INTEGRATION, MAIN, UNITS, layout } from '../evals/m1/layout.ts';
import { type Exit, fixture, runUntilExit } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type CallRecord, type ScenarioFile, readCalls } from './helpers/scenario.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

const EVALS = fileURLToPath(new URL('../evals/m1/', import.meta.url));
const SCENARIOS = join(EVALS, 'scenarios');
/** The driver's own hard timeout under --fake is 5 min; the test allows it that and a margin. */
const RUN_MS = 7 * 60_000;
const T = { timeout: 3 * RUN_MS };

const script = (name: string, args: readonly string[]): Promise<Exit> =>
  runUntilExit(process.execPath, [join(EVALS, name), ...args], { env: process.env, timeoutMs: RUN_MS });

type Checked = Readonly<{ exit: Exit; result: CheckResult }>;

async function check(dir: string): Promise<Checked> {
  const exit = await script('check.ts', [dir]);
  const [json, notExercised, cannotShow] = exit.stdout.split('\n');
  assert.ok(json !== undefined && notExercised !== undefined && cannotShow !== undefined, `check printed: ${exit.stdout}; stderr: ${exit.stderr}`);
  const result = JSON.parse(json) as CheckResult;
  assert.equal(notExercised, `NOT EXERCISED: ${result.notExercised.length === 0 ? '(none)' : result.notExercised.join(', ')}`);
  assert.equal(cannotShow, 'CANNOT SHOW: issue mode, real cgroup containment, crash boundaries under real models, week-long reliability');
  assert.equal(exit.code, result.pass ? 0 : 1, 'check exits non-zero exactly when a criterion fails');
  return { exit, result };
}

/** git with `input` on stdin (hash-object, mktree), isolated from the user's config like helpers/repo.ts. */
function gitStdin(repo: string, args: readonly string[], input: string): string {
  const r = spawnSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

const failing = (c: Checked): readonly string[] => c.result.criteria.filter((x) => !x.pass).map((x) => x.name);
const criterion = (c: Checked, name: string) => {
  const found = c.result.criteria.find((x) => x.name === name);
  assert.ok(found !== undefined, `no criterion ${name}`);
  return found;
};

type Fixture = Readonly<{ dir: string; driver: Exit; report: Report; checked: Checked }>;

/** setup → driver --fake → check, in a fresh fixture dir. */
async function fakeRun(profile: 'default' | 'claude-only', scenario: string): Promise<Fixture> {
  const dir = join(tmpDir('m1-fixture'), 'fx');
  const setup = await script('setup.ts', [dir]);
  assert.equal(setup.code, 0, setup.stderr);
  // The driver ends its run itself; a driver that failed or timed out may leave it going, so it is torn down here.
  const l = layout(dir);
  const scope: RunScope = {
    paths: [dir],
    stop: async () => {
      const stop = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), join(l.fake, 'host'), 'stop', '--repo', l.repo, '--arc', ARC], { env: process.env, timeoutMs: 30_000 });
      assert.equal(stop.code, 0, `roadmap stop: ${stop.stderr}`);
    },
  };
  track(scope);
  const driver = await script('driver.ts', [dir, '--profile', profile, '--fake', scenario]).finally(() => teardown(scope));
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  return { dir, driver, report, checked: await check(dir) };
}

/** Every call the fakes saw, asserting each matched a step and the scenario was played to its end. */
function playedThrough(f: Fixture): readonly CallRecord[] {
  const scenario = join(layout(f.dir).fake, 'scenario.json');
  const calls = readCalls(scenario);
  const steps = (JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile).steps;
  assert.deepEqual(calls.map((c) => c.step), steps.map((_, i) => i), 'every call matched its step, and every step was played');
  return calls;
}

function assertPassed(f: Fixture): void {
  assert.equal(f.driver.code, 0, `driver: ${f.driver.stdout} ${f.driver.stderr}`);
  assert.equal(f.report.endedBy, 'exit');
  assert.equal(f.report.start.ready?.generation, 1);
  assert.equal(f.report.generation, 1);
  assert.deepEqual(f.report.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.equal(f.report.status.run.state, 'complete');
  assert.deepEqual(failing(f.checked), [], JSON.stringify(f.checked.result.criteria));
  assert.equal(f.checked.result.criteria.length, 8);
}

/** What the bumpy scenario exercises beyond the clean one. */
const BUMPY_BRANCHES: readonly Branch[] = ['redirect', 'red lane', 'fix round', 'gate revise'];

test('evals-m1.setup-valid: setup lays out a plan parsePlan accepts, specs the spec validator accepts, and a green repo', T, async () => {
  const dir = join(tmpDir('m1-setup'), 'fx');
  const out = await script('setup.ts', [dir]);
  assert.equal(out.code, 0, out.stderr);
  const l = layout(dir);
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  assert.equal(plan.arc, ARC);
  assert.equal(plan.integrationBranch, INTEGRATION);
  assert.deepEqual(plan.units.map((u) => u.id), [...UNITS]);
  assert.deepEqual(plan.suite.lanes.map((x) => x.argv), [['npm', 'test']]);
  assert.equal(plan.resources.length, 1);
  for (const u of plan.units) {
    const spec = loadSpec(absPath(join(l.input, u.spec)));
    assert.equal(spec.unit, u.id);
    assert.deepEqual(spec.lanes.map((x) => x.tier), ['fast']);
    assert.ok(spec.acceptance.some((a) => a.clause.includes('.roadmap/contracts/one.md')), `${u.id} cites the contract`);
  }
  assert.equal(git(l.repo, 'rev-parse', MAIN), plan.baseline);
  assert.equal(git(l.repo, 'rev-parse', INTEGRATION), plan.baseline, 'integration is cut from main');
  assert.deepEqual(git(l.repo, 'ls-tree', '-r', '--name-only', MAIN, '.roadmap').split('\n'), [
    '.roadmap/config.json', '.roadmap/constraints.md', '.roadmap/contracts/one.md', '.roadmap/invariants.md',
  ]);
  assert.equal(readFileSync(join(l.input, plan.rulings), 'utf8'), git(l.repo, 'show', `${MAIN}:.roadmap/constraints.md`) + '\n', 'the run-input ledger is the in-tree one');
  const suite = await runUntilExit('npm', ['test'], { env: process.env, cwd: l.repo, timeoutMs: 60_000 });
  assert.equal(suite.code, 0, `the suite is green at the baseline: ${suite.stdout}`);
  // The resource's real shell commands answer the probe contract: free, then its own label, then foreign.
  const [decl] = plan.resources;
  assert.ok(decl !== undefined);
  const probe = (owner: string) => runUntilExit(decl.probe.argv[0]!, decl.probe.argv.slice(1), { env: { PATH: process.env['PATH'], RESOURCE_OWNER: owner }, cwd: l.repo, timeoutMs: 10_000 });
  assert.equal((await probe(`${ARC}/slug`)).code, 0);
  writeFileSync(join(l.resource, 'scratch.owner'), `${ARC}/slug`);
  assert.equal((await probe(`${ARC}/slug`)).code, 10);
  assert.equal((await probe(`${ARC}/page-id`)).code, 11);
  const teardown = await runUntilExit(decl.teardown.argv[0]!, decl.teardown.argv.slice(1), { env: { PATH: process.env['PATH'] }, cwd: l.repo, timeoutMs: 10_000 });
  assert.equal(teardown.code, 0);
  assert.equal((await probe(`${ARC}/slug`)).code, 0, 'free again after the teardown');
});

describe('evals-m1: fake-backed fixture runs', () => {
  let clean: Fixture;
  let claudeOnly: Fixture;
  let bumpy: Fixture;
  let parked: Fixture;
  before(async () => {
    const parkedScenario = join(tmpDir('m1-parked'), 'parked.json');
    const escalate = { role: 'planCheck', answer: { decision: 'escalate', reasons: ['The contract is ambiguous.'], patch: null, risk: 'med', notes: '', premises: [] } };
    // Each unit escalates on its seat and again on the high seat it routes up to: both park.
    writeFileSync(parkedScenario, JSON.stringify({ steps: [escalate, escalate, escalate, escalate] }));
    // Independent fixture dirs and host dirs: the four runs go in parallel.
    [clean, claudeOnly, bumpy, parked] = await Promise.all([
      fakeRun('default', join(SCENARIOS, 'clean.json')),
      fakeRun('claude-only', join(SCENARIOS, 'clean.json')),
      fakeRun('default', join(SCENARIOS, 'bumpy.json')),
      fakeRun('default', parkedScenario),
    ]);
  }, T);

  test('evals-m1.clean-default: both units merge, every criterion passes, and the non-exercised list names every branch', () => {
    assertPassed(clean);
    const calls = playedThrough(clean);
    assert.ok(calls.some((c) => c.as === 'codex'), 'default builds on Codex');
    assert.deepEqual(clean.checked.result.notExercised, [...BRANCHES]);
    for (const b of BUMPY_BRANCHES) assert.ok(clean.checked.result.notExercised.includes(b), `${b} is listed not exercised`);
  });

  test('evals-m1.clean-claude-only: codex is off PATH and never called; every criterion passes', () => {
    assertPassed(claudeOnly);
    const calls = playedThrough(claudeOnly);
    assert.deepEqual(calls.filter((c) => c.as === 'codex'), [], 'the codex shim was never called');
    assert.ok(calls.some((c) => c.as === 'claude' && c.argv.includes('--permission-mode')), 'the Claude implementer built');
    assert.deepEqual(claudeOnly.checked.result.notExercised, [...BRANCHES]);
  });

  test('evals-m1.bumpy: redirect, red lane with its fix round, gate revise; the non-exercised list is shorter by exactly those', () => {
    assertPassed(bumpy);
    playedThrough(bumpy);
    const listed = bumpy.checked.result.notExercised;
    assert.deepEqual(listed, BRANCHES.filter((b) => !BUMPY_BRANCHES.includes(b)));
    assert.equal(listed.length, clean.checked.result.notExercised.length - BUMPY_BRANCHES.length);
  });

  test('evals-m1.parked-stop: units parked on blocking needs-user items make the driver stop the run; check grades them coherent', () => {
    assert.equal(parked.driver.code, 0, parked.driver.stderr);
    assert.equal(parked.report.endedBy, 'parked-stop');
    assert.equal(parked.report.generation, parked.report.start.ready?.generation);
    assert.deepEqual(parked.report.exit, { kind: 'stop', cause: 'command', needsUser: null });
    assert.deepEqual(failing(parked.checked), [], JSON.stringify(parked.checked.result.criteria));
    playedThrough(parked);
    assert.match(criterion(parked.checked, 'units-settled').detail, /^slug parked nu-[0-9]+ escalation; page-id parked nu-[0-9]+ escalation$/);
    assert.match(criterion(parked.checked, 'head-is-candidate').detail, /nothing published/);
  });

  test('evals-m1.tamper-integration: a transient file committed on integration fails the product-only criterion', async () => {
    const repo = layout(clean.dir).repo;
    const before_ = git(repo, 'rev-parse', INTEGRATION);
    const wt = join(tmpDir('m1-tamper'), 'wt');
    git(repo, 'worktree', 'add', '--quiet', wt, INTEGRATION);
    writeFileSync(join(wt, '.roadmap', 'state.json'), '{}\n');
    git(wt, 'add', '.roadmap/state.json');
    git(wt, 'commit', '--quiet', '--message', 'tamper: run state on integration');
    git(repo, 'worktree', 'remove', '--force', wt);
    const tampered = await check(clean.dir);
    assert.equal(tampered.exit.code, 1);
    assert.ok(failing(tampered).includes('diff-product-only'), JSON.stringify(tampered.result.criteria));
    assert.match(criterion(tampered, 'diff-product-only').detail, /\.roadmap\/state\.json \(roadmap-dir\)/);
    git(repo, 'update-ref', `refs/heads/${INTEGRATION}`, before_);
    assert.deepEqual(failing(await check(clean.dir)), [], 'restoring the branch restores the pass');
  });

  test('evals-m1.tamper-snapshot: a snapshot blob that no longer matches its manifest fails the snapshot criterion', async () => {
    const repo = layout(clean.dir).repo;
    const ref = `refs/roadmap/${ARC}`;
    const at = git(repo, 'rev-parse', ref);
    const blob = git(repo, 'rev-parse', `${ref}:state.json`);
    const forged = gitStdin(repo, ['hash-object', '-w', '--stdin'], `${git(repo, 'cat-file', 'blob', blob)} `);
    const listing = git(repo, 'ls-tree', ref).split('\n').map((line) => (line.endsWith('\tstate.json') ? line.replace(blob, forged) : line)).join('\n');
    const tree = gitStdin(repo, ['mktree'], `${listing}\n`);
    const commit = git(repo, 'commit-tree', tree, '-p', at, '-m', 'tamper: snapshot blob');
    git(repo, 'update-ref', ref, commit, at);
    const tampered = await check(clean.dir);
    assert.equal(tampered.exit.code, 1);
    assert.deepEqual(failing(tampered), ['snapshot-verifies']);
    assert.match(criterion(tampered, 'snapshot-verifies').detail, /state\.json hashes to .* manifest says/);
    git(repo, 'update-ref', ref, at, commit);
    assert.deepEqual(failing(await check(clean.dir)), [], 'restoring the ref restores the pass');
  });
});
