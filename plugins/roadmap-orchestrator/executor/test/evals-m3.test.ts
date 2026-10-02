// The M3 paid fixture (evals/m3/{setup,driver,check}.ts) validated end to end without paying: the run here is
// fake-backed (`driver --fake story`, the fake backends behind PATH shims playing evals/m3/scenario.ts, a host dir
// inside the fixture), real processes, real git, the real supervisor, real node-test witness lanes over the fixture's
// journey tests. Proves the setup is valid input whose lanes witness what the story needs (I-1 not held and I-2, I-3
// held at the baseline; the barrier holds only audit-1's run of the money lane; the story's tidy regresses I-2 and its
// repair restores it), the driver fires every forcing device and the arc completes, every check criterion passes,
// the literal partial bundle applies nothing (A18, G19), a used fixture dir is refused, and the criteria
// discriminate. Also the latch-during-audit race: I-1 latches while audit-1 runs, and the audit grades latches as of
// its capture. Named tests: evals-m3.setup-valid, evals-m3.fake, evals-m3.partial-bundle, evals-m3.latch-during-audit,
// evals-m3.rerun-refused, evals-m3.tamper-digest, evals-m3.tamper-stale, evals-m3.prevented, evals-m3.latent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { verdictOf } from '../src/holistic/observe.ts';
import { type ObservationVerdict, parseObligations, parseVision } from '../src/holistic/types.ts';
import { advancesReasons } from '../src/holistic/vision.ts';
import { witnessEnv } from '../src/holistic/witness.ts';
import { parsePlan } from '../src/input/plan.ts';
import { loadSpec, parseSpec } from '../src/spec/spec.ts';
import { BRANCHES, CANNOT_SHOW, type CheckResult } from '../evals/m3/check.ts';
import type { Report } from '../evals/m3/driver.ts';
import { AUDIT_EVERY, CONVERGENCE_K, INTEGRATION, LENSES, MAIN, MONEY_LANE, UNITS, barrierFile, layout } from '../evals/m3/layout.ts';
import { type StoryName, UNIT_STORY, storySteps } from '../evals/m3/scenario.ts';
import { REPAIR_UNIT, repairSpecText } from '../evals/m3/setup.ts';
import { type Exit, fixture, runUntilExit } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type ScenarioFile, readCalls } from './helpers/scenario.ts';
import { readWitnessFile } from './helpers/witness.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';

after(assertNoSurvivors);

const EVALS = fileURLToPath(new URL('../evals/m3/', import.meta.url));
/** The driver's own hard timeout under --fake is 15 min; the test allows it that and a margin. */
const RUN_MS = 17 * 60_000;
const T = { timeout: 2 * RUN_MS };

/** This process's environment without the test runner's own context, which a nested `node --test` would report to. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

const script = (name: string, args: readonly string[]): Promise<Exit> =>
  runUntilExit(process.execPath, [join(EVALS, name), ...args], { env: ENV, timeoutMs: RUN_MS });

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

type ObligationsFile = ReturnType<typeof parseObligations>;

/** Runs arc lane `lane` in `cwd` as a witness run would (the witness env over a fresh file); its exit and records. */
function runArcLane(o: ObligationsFile, lane: string, cwd: string) {
  const def = o.lanes.find((l) => l.id === lane)!;
  const file = join(tmpDir('m3-witness'), 'witness.lines');
  writeFileSync(file, '');
  const [cmd, ...args] = def.argv as readonly string[];
  const env = { PATH: process.env['PATH'], ...witnessEnv('node-test', absPath(file)) };
  return { file, env, cmd: cmd!, args, run: () => spawnSync(cmd!, args, { cwd, env, encoding: 'utf8', timeout: 60_000 }) };
}

/** The verdict of obligation `id` from lane records in `file`. */
function verdictIn(o: ObligationsFile, id: string, file: string): ObservationVerdict {
  const witness = o.obligations.find((x) => x.id === id)!.witness!;
  const records = [...readWitnessFile(file)].sort((a, b) => (a.testId < b.testId ? -1 : 1));
  return verdictOf({ v: 1, lane: witness.lane, laneRev: '0000000000000000', envId: '0000000000000000', treeSha: '0'.repeat(40), inv: 'x', runner: 'node-test', purpose: 'witness', records, malformed: false } as never, witness);
}

const LANE_OF: Readonly<Record<string, string>> = { 'I-1': 'reconcile', 'I-2': MONEY_LANE, 'I-3': 'cli' };

/** Every obligation's verdict in `cwd`, each lane run once as a witness run would. */
function verdicts(o: ObligationsFile, cwd: string): Readonly<Record<string, ObservationVerdict>> {
  return Object.fromEntries(Object.entries(LANE_OF).map(([id, lane]) => {
    const l = runArcLane(o, lane, cwd);
    l.run();
    return [id, verdictIn(o, id, l.file)];
  }));
}

/** The CLI in `cwd` run with `args` (for the refusals the seed and the story's builds make). */
const refused = (cwd: string, args: readonly string[]) => spawnSync('node', ['src/cli.js', ...args], { cwd, env: ENV, encoding: 'utf8', timeout: 30_000 });

/** Writes the files of `unit`'s story build commit into `cwd` (the fake implementer's act). */
function playBuild(unit: string, cwd: string): void {
  const build = UNIT_STORY[unit]!.find((s) => s.role === 'build');
  assert.ok(build !== undefined && build.role === 'build');
  for (const act of build.acts) {
    if (act.type !== 'commit') continue;
    for (const [path, text] of Object.entries(act.files)) writeFileSync(join(cwd, path), text as string);
  }
}

test('evals-m3.setup-valid: setup lays out a valid holistic plan whose witness lanes report what the story needs, the barrier holds only audit-1\'s run, and the story\'s builds regress and restore I-2', T, async () => {
  const dir = join(tmpDir('m3-setup'), 'fx');
  const out = await script('setup.ts', [dir]);
  assert.equal(out.code, 0, out.stderr);
  const l = layout(dir);
  const plan = parsePlan(JSON.parse(readFileSync(l.plan, 'utf8')));
  assert.equal(plan.arc, l.arc);
  assert.deepEqual(plan.units.map((u) => u.id), [...UNITS]);
  assert.deepEqual(plan.holistic, { vision: 'vision.json', advances: ['V-1', 'V-2', 'V-3', 'V-4'], obligations: 'obligations.json', audit: { every: AUDIT_EVERY, lenses: [...LENSES] } });
  assert.deepEqual(plan.limits, { convergenceK: CONVERGENCE_K });
  const vision = parseVision(JSON.parse(readFileSync(l.vision, 'utf8')));
  assert.deepEqual(vision.clauses.map((c) => [c.id, c.kind, c.rank, c.state]), [['V-1', 'purpose', null, 'active'], ['V-2', 'non-negotiable', null, 'active'], ['V-3', 'tradeoff', 1, 'active'], ['V-4', 'world', null, 'active']]);
  assert.deepEqual(vision.questions, []);
  assert.deepEqual(advancesReasons(vision, plan.holistic!.advances), []);
  const o = parseObligations(JSON.parse(readFileSync(l.obligations, 'utf8')));
  assert.deepEqual(o.obligations.map((x) => [x.id, x.activation, x.serves, x.deliveredBy]), [['I-1', 'future', ['V-1', 'V-4'], ['parse', 'report']], ['I-2', 'must-hold', ['V-2'], []], ['I-3', 'must-hold', ['V-3'], []]]);
  assert.deepEqual(o.lanes.map((x) => x.reporter), ['node-test', 'node-test', 'node-test']);
  const mapped = new Map(o.mapping.paths.map((m) => [m.pattern as string, m.obligations]));
  for (const u of plan.units) {
    const spec = loadSpec(absPath(join(l.input, u.spec)));
    assert.equal(spec.unit, u.id);
    for (const p of spec.scope) assert.ok(mapped.has(p), `${u.id}'s scoped path ${p} is mapped`);
  }
  assert.deepEqual(plan.units.find((u) => u.id === 'tidy')!.scope, ['src/cli.js']);
  assert.deepEqual(mapped.get('src/cli.js'), ['I-3'], 'tidy\'s one path maps to I-3 only');
  // What tidy's judges read says nothing about rounding (its spec, the contract it cites, the architecture doc), and its
  // story diff holds no rounding code: the regression is formatDisplay's existing toFixed, reached by a routing change.
  const tidySpec = readFileSync(join(l.input, 'tidy.json'), 'utf8');
  for (const text of [tidySpec, readFileSync(join(l.repo, '.roadmap/contracts/ledger.md'), 'utf8'), readFileSync(join(l.repo, 'ARCHITECTURE.md'), 'utf8')]) {
    assert.doesNotMatch(text, /round|even|half|toFixed|Intl/i);
  }
  assert.match(tidySpec, /formatDisplay/);
  const tidyBuild = UNIT_STORY['tidy']!.find((x) => x.role === 'build');
  assert.ok(tidyBuild !== undefined && tidyBuild.role === 'build');
  const tidyFiles = tidyBuild.acts.flatMap((a) => (a.type === 'commit' ? Object.entries(a.files) : []));
  assert.deepEqual(tidyFiles.map(([path]) => path), ['src/cli.js']);
  for (const [, text] of tidyFiles) assert.doesNotMatch(text as string, /round|toFixed|Intl/i);
  const repair = parseSpec(Buffer.from(repairSpecText()), `${REPAIR_UNIT.id}.json` as never);
  assert.deepEqual([repair.unit, repair.repairs, repair.obligations], [REPAIR_UNIT.id, ['F-1'], ['I-2']]);
  assert.equal(git(l.repo, 'rev-parse', INTEGRATION), git(l.repo, 'rev-parse', MAIN));
  assert.equal(plan.baseline, git(l.repo, 'rev-parse', MAIN));
  const suite = await runUntilExit('npm', ['test'], { env: ENV, cwd: l.repo, timeoutMs: 60_000 });
  assert.equal(suite.code, 0, `the suite is green at the baseline: ${suite.stdout}`);
  const journeyNames = /amounts render to the cent|reconcile a month|unknown commands/;
  assert.doesNotMatch(suite.stdout, journeyNames, 'the suite runs no journey test');
  const bare = spawnSync(process.execPath, ['--test'], { cwd: l.repo, env: ENV, encoding: 'utf8', timeout: 60_000 });
  assert.equal(bare.status, 0, bare.stdout);
  assert.doesNotMatch(bare.stdout, journeyNames, 'a bare `node --test` discovers no journey test either');

  // The witness lanes through the shipped reporter: the baseline's verdicts.
  assert.deepEqual(verdicts(o, l.repo), { 'I-1': 'not-held', 'I-2': 'held', 'I-3': 'held' });
  // The seed refuses what it cannot read exactly (V-3), so an honest lens has nothing but the story's issue to report.
  for (const args of [['format', 'abc'], ['format', '1e3'], ['format', 'NaN'], ['format', '1,234.50'], ['format'], ['total'], ['total', '1', 'Infinity']]) {
    const r = refused(l.repo, args);
    assert.deepEqual([r.status, r.stdout], [2, ''], `${args.join(' ')} is refused`);
    assert.match(r.stderr, /^ledger: /, `${args.join(' ')} says why`);
  }
  assert.equal(spawnSync('node', ['src/cli.js', 'total', '0.1', '0.2'], { cwd: l.repo, encoding: 'utf8' }).stdout, '0.30\n', 'sums are exact');

  // The barrier (branch R): an audit's lane checkout without the regression passes; with it, the run waits until released.
  const checkout = join(tmpDir('m3-checkouts'), 'audit-1.lanes');
  git(l.repo, 'worktree', 'add', '--detach', checkout, MAIN);
  const clean = runArcLane(o, MONEY_LANE, checkout);
  assert.equal(clean.run().status, 0, 'no regression: the audit\'s run passes straight through');
  assert.equal(existsSync(barrierFile(l, 'reached')), false);
  assert.equal(verdictIn(o, 'I-2', clean.file), 'held', 'the lane reports through the reporter');
  playBuild('tidy', checkout);
  const money = runArcLane(o, MONEY_LANE, checkout);
  const waiting = runUntilExit(money.cmd, money.args, { env: money.env, cwd: checkout, timeoutMs: 60_000 });
  for (let i = 0; i < 300 && !existsSync(barrierFile(l, 'reached')); i++) await sleep(100);
  assert.equal(readFileSync(barrierFile(l, 'reached'), 'utf8'), 'audit-1\n', 'with tidy\'s regression, the audit\'s run waits at the barrier, naming its job');
  writeFileSync(barrierFile(l, 'release'), '');
  const released = await waiting;
  assert.equal(released.code, 1, 'released, the lane runs and fails: I-2 is regressed');
  assert.equal(verdictIn(o, 'I-2', money.file), 'not-held');

  // The story's builds: tidy regresses I-2 (and keeps its command lane and I-3 green); the repair restores it.
  const tree = join(tmpDir('m3-story'), 'tree');
  git(l.repo, 'worktree', 'add', '--detach', tree, MAIN);
  for (const unit of ['parse', 'tidy']) playBuild(unit, tree);
  assert.deepEqual(verdicts(o, tree), { 'I-1': 'not-held', 'I-2': 'not-held', 'I-3': 'held' });
  const formatted = spawnSync('node', ['src/cli.js', 'format', '1234.5'], { cwd: tree, env: ENV, encoding: 'utf8', timeout: 60_000 });
  assert.deepEqual([formatted.status, formatted.stdout], [0, '1,234.50\n'], 'tidy\'s own lane passes and delivers its A1');
  playBuild('report', tree);
  assert.deepEqual(verdicts(o, tree), { 'I-1': 'held', 'I-2': 'not-held', 'I-3': 'held' }, 'report delivers I-1');
  const bad = join(tree, 'bad.csv');
  writeFileSync(bad, '2026-09-01,1.00,ok\n2026-02-30,1.00,no such day\n');
  for (const args of [['reconcile', '2026-13', bad], ['reconcile', '2026-09', join(tree, 'missing.csv')], ['reconcile', '2026-09', bad], ['reconcile', '2026-09']]) {
    const r = refused(tree, args);
    assert.deepEqual([r.status, r.stdout], [2, ''], `${args.join(' ')} is refused`);
    assert.match(r.stderr, /^ledger: /, `${args.join(' ')} says why`);
  }
  assert.match(refused(tree, ['reconcile', '2026-09', bad]).stderr, /line 2/, 'a malformed ledger line is named');
  playBuild(REPAIR_UNIT.id, tree);
  assert.deepEqual(verdicts(o, tree), { 'I-1': 'held', 'I-2': 'held', 'I-3': 'held' }, 'the repair restores I-2');
  const units = await runUntilExit('npm', ['test'], { env: ENV, cwd: tree, timeoutMs: 60_000 });
  assert.equal(units.code, 0, `the story's suite is green: ${units.stdout}`);

  const steps = storySteps('story', 'default');
  assert.equal(steps.filter((s) => s.unit === undefined).length, 2, 'the one start smokes Claude and Codex');
  assert.equal(steps.filter((s) => s.unit !== undefined && !/^(audit|ckpt)-/.test(s.unit)).length, 12, 'three calls for each of four units');
  assert.equal(steps.filter((s) => s.unit?.startsWith('audit-') === true).length, 5, 'five lens calls');
  assert.equal(steps.filter((s) => s.unit?.startsWith('ckpt-') === true).length, 5, 'five checkpoint calls (the paid run\'s four and the partial bundle)');
});

type Fixture = Readonly<{ dir: string; driver: Exit; report: Report; checked: Checked }>;
type Seq<F> = F & { seq: number };

/** Sets up a fixture and runs the driver on fake `story` to its end; the run is torn down whatever happens. */
async function runStory(story: StoryName): Promise<Readonly<{ fx: Fixture; events: readonly Event[] }>> {
  const dir = join(tmpDir('m3-fixture'), 'fx');
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
  const driver = await script('driver.ts', [dir, '--profile', 'default', '--fake', story]).finally(() => teardown(scope));
  const report = JSON.parse(readFileSync(l.report, 'utf8')) as Report;
  return { fx: { dir, driver, report, checked: await check(dir) }, events: readJournal(absPath(l.runDir), arcId(l.arc)).events };
}

/** Every step of the fake scenario was played once, by a call that matched it. */
function assertEveryStepPlayed(dir: string): void {
  const scenario = join(layout(dir).fake, 'scenario.json');
  const calls = readCalls(scenario);
  const steps = (JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile).steps;
  assert.deepEqual(calls.filter((c) => c.step === null), [], 'no call went unmatched');
  assert.deepEqual(calls.map((c) => c.step).sort((a, b) => a! - b!), steps.map((_, i) => i), 'every step played once');
}

describe('evals-m3: the fake-backed fixture run, branch R', () => {
  let fx: Fixture;
  let events: readonly Event[];
  const factsOf = <K extends Fact['kind']>(kind: K): readonly Seq<Extract<Fact, { kind: K }>>[] =>
    events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [{ ...(e.fact as Extract<Fact, { kind: K }>), seq: e.seq }] : []));

  before(async () => {
    ({ fx, events } = await runStory('story'));
  }, T);

  test('evals-m3.fake: branch R; every forcing device fired, the arc completed, and every criterion passes', () => {
    const { driver, report, checked } = fx;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.equal(report.endedBy, 'exit', JSON.stringify(report.devices));
    const d = report.devices;
    assert.equal(d.failed, null);
    for (const [name, value] of Object.entries(d)) if (name !== 'failed') assert.notEqual(value, null, `device ${name} fired`);
    assert.equal(d.branch?.branch, 'R');
    assert.deepEqual(d.added.map((a) => a.unit), [REPAIR_UNIT.id]);
    assert.deepEqual(report.exit, { kind: 'complete', units: [...UNITS, REPAIR_UNIT.id].map((unit) => ({ unit, result: 'merged' })) });
    assert.deepEqual(failing(checked), [], JSON.stringify(checked.result.criteria));
    assert.equal(checked.result.branch, 'R');
    assert.equal(checked.result.criteria.length, 25);
    assert.ok(['regression-unselected', 'audit-race', 'repair-resolved'].every((n) => checked.result.criteria.some((c) => c.name === n)), 'branch R\'s own criteria are graded');
    assert.deepEqual(checked.result.notExercised, BRANCHES.filter((b) => b !== 'literal partial bundle'), 'the fake story takes the literal partial bundle, and nothing else the paid run leaves out');
    assertEveryStepPlayed(fx.dir);
  });

  test('evals-m3.partial-bundle (A18, G19): the two-op bundle whose second op is invalid applies neither; its one re-evaluation applies the admit alone', () => {
    const decided = factsOf('bundle-decided');
    const revisions = factsOf('plan-applied');
    const bundleRevs = revisions.filter((f) => f.source?.type === 'bundle');
    const outcome = (job: string) => {
      const x = decided.find((f) => f.job === job);
      return x === undefined ? (bundleRevs.some((f) => f.source?.type === 'bundle' && f.source.job === job) ? 'applied' : 'none') : x.outcome.kind === 'rejected' ? `rejected:${x.outcome.reason}` : x.outcome.kind;
    };
    assert.deepEqual(['ckpt-1', 'ckpt-2', 'ckpt-3', 'ckpt-4', 'ckpt-5'].map(outcome), ['rejected:stale', 'rejected:invalid', 'applied', 'no-op', 'no-op']);
    const invalid = decided.find((f) => f.job === 'ckpt-2')!;
    assert.ok(invalid.outcome.kind === 'rejected');
    assert.match(invalid.outcome.detail, /V-999/);
    const captured = factsOf('checkpoint-inputs').find((f) => f.job === 'ckpt-2')!;
    assert.deepEqual(revisions.filter((f) => f.seq > captured.seq && f.seq < invalid.seq), [], 'no revision between its capture and its rejection');
    const [bundle] = bundleRevs;
    assert.ok(bundle !== undefined && bundle.source?.type === 'bundle' && bundle.source.job === 'ckpt-3');
    assert.deepEqual(bundle.changes, [{ type: 'unit-added', unit: REPAIR_UNIT.id }], 'the re-evaluation applied the admit, and only it');
    assert.ok(bundle.seq > invalid.seq);
  });

  test('evals-m3.latch-during-audit: I-1 latches while audit-1 runs; the audit grades latches as of its capture, so it opens the I-2 witness P1 and nothing over I-1', () => {
    const job = fx.report.devices.barrier!.audit;
    assert.equal(job, 'audit-1');
    const started = factsOf('audit-started').find((f) => f.job === job)!;
    const ended = factsOf('audit-ended').find((f) => f.job === job)!;
    assert.ok(started !== undefined && ended !== undefined);
    const latch = factsOf('obligation-latched').find((f) => f.obligation === 'I-1');
    assert.ok(latch !== undefined && latch.seq > started.highWater && latch.seq < ended.seq, 'I-1 latched after the audit\'s capture and before its end: the race');
    const opened = factsOf('finding-opened').filter((f) => ended.findings.includes(f.id));
    assert.deepEqual(opened.map((f) => [f.id, f.lens, f.severity, f.obligation]), [['F-1', 'witness', 'P1', 'I-2']], 'the audit\'s one finding is the I-2 witness P1');
    assert.deepEqual(factsOf('finding-opened').filter((f) => f.obligation === 'I-1'), [], 'no finding over I-1, which S did not deliver');
  });

  test('evals-m3.rerun-refused: setup and the driver refuse a fixture dir that was used', async () => {
    const setup = await script('setup.ts', [fx.dir]);
    assert.notEqual(setup.code, 0);
    assert.match(setup.stderr, /is not empty/);
    const driver = await script('driver.ts', [fx.dir, '--profile', 'default', '--fake', 'story']);
    assert.notEqual(driver.code, 0);
    assert.match(driver.stderr, /report\.json exists: a fixture dir is run once/);
  });

  /** Rewrites report.json's devices, checks, restores it and checks the pass is restored; returns the tampered check. */
  async function tamper(edit: (d: Report['devices']) => Report['devices']): Promise<Checked> {
    const path = layout(fx.dir).report;
    const before_ = readFileSync(path, 'utf8');
    const report = JSON.parse(before_) as Report;
    writeFileSync(path, JSON.stringify({ ...report, devices: edit(report.devices) }));
    const tampered = await check(fx.dir);
    writeFileSync(path, before_);
    assert.deepEqual(failing(await check(fx.dir)), [], 'restoring the report restores the pass');
    return tampered;
  }

  test('evals-m3.tamper-digest: a digest the driver did not acknowledge fails divergence-digest-bound', async () => {
    const tampered = await tamper((d) => ({ ...d, acks: d.acks.filter((a) => a.reason !== 'divergence-digest') }));
    assert.deepEqual(failing(tampered), ['divergence-digest-bound']);
    assert.match(criterion(tampered, 'divergence-digest-bound').detail, /the driver did not acknowledge the digest/);
  });

  test('evals-m3.tamper-stale: a stale apply that committed no revision fails stale-whole', async () => {
    const tampered = await tamper((d) => ({ ...d, staleApply: { ...d.staleApply!, command: 'cmd-000000000000ffff' } }));
    assert.deepEqual(failing(tampered), ['stale-whole']);
    assert.match(criterion(tampered, 'stale-whole').detail, /committed no revision/);
  });
});

describe('evals-m3: the fake-backed fixture run, branch P', () => {
  let fx: Fixture;
  let events: readonly Event[];

  before(async () => {
    ({ fx, events } = await runStory('prevented'));
  }, T);

  test('evals-m3.prevented: branch P (as paid run 3); tidy is stopped upstream and cut, the repair merges, the arc completes, and every criterion passes', () => {
    const { driver, report, checked } = fx;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.equal(report.endedBy, 'exit', JSON.stringify(report.devices));
    const d = report.devices;
    assert.equal(d.failed, null);
    assert.equal(d.branch?.branch, 'P');
    assert.match(d.branch!.why, /unit-cut of tidy/);
    assert.deepEqual([d.barrier, d.release], [null, null], 'no regression: the money barrier never held');
    for (const name of ['runOnly', 'staleApply', 'staleApplied', 'admit', 'unlimited'] as const) assert.notEqual(d[name], null, `device ${name} fired`);
    assert.deepEqual(d.added.map((a) => a.unit), [REPAIR_UNIT.id]);
    assert.deepEqual(d.acks.map((a) => a.reason).sort(), ['convergence-bound', 'divergence-digest']);
    assert.ok(report.exit?.kind === 'complete', JSON.stringify(report.exit));
    assert.deepEqual(failing(checked), [], JSON.stringify(checked.result.criteria));
    assert.equal(checked.result.branch, 'P');
    assert.equal(checked.result.criteria.length, 23);
    assert.ok(checked.result.criteria.some((c) => c.name === 'prevention'), 'branch P\'s own criterion is graded');
    const outcomes = events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === 'tidy' ? [`${e.fact.stage}:${e.fact.outcome}`] : []));
    assert.ok(outcomes.every((o) => o.startsWith('plan-check:')), `tidy never got past plan-check: ${outcomes.join(', ')}`);
    const firstCheckpoint = events.find((e) => e.type === 'fact' && e.fact.kind === 'checkpoint-inputs');
    assert.ok(firstCheckpoint?.type === 'fact' && firstCheckpoint.fact.kind === 'checkpoint-inputs' && firstCheckpoint.fact.trigger.type === 'park', 'the stale apply fired on the park\'s checkpoint');
    assertEveryStepPlayed(fx.dir);
  });
});

describe('evals-m3: the fake-backed fixture run, branch L', () => {
  let fx: Fixture;

  before(async () => {
    ({ fx } = await runStory('latent'));
  }, T);

  test('evals-m3.latent: branch L (as paid run 9); tidy publishes with I-2\'s witness held, the lens P1 over I-2 is repaired by a checkpoint admit, the arc completes, and every criterion passes', () => {
    const { driver, report, checked } = fx;
    assert.equal(driver.code, 0, `driver: ${driver.stdout} ${driver.stderr}`);
    assert.equal(report.endedBy, 'exit', JSON.stringify(report.devices));
    const d = report.devices;
    assert.equal(d.failed, null);
    assert.equal(d.branch?.branch, 'L');
    assert.match(d.branch!.why, /I-2 is held there/);
    assert.deepEqual([d.barrier, d.release], [null, null], 'I-2\'s witness held on S: the money barrier never held');
    for (const name of ['runOnly', 'staleApply', 'staleApplied', 'admit', 'unlimited'] as const) assert.notEqual(d[name], null, `device ${name} fired`);
    assert.deepEqual(d.added.map((a) => a.unit), [REPAIR_UNIT.id]);
    assert.ok(report.exit?.kind === 'complete', JSON.stringify(report.exit));
    assert.deepEqual(failing(checked), [], JSON.stringify(checked.result.criteria));
    assert.equal(checked.result.branch, 'L');
    assert.equal(checked.result.criteria.length, 23);
    assert.match(criterion(checked, 'latent-repair').detail, /F-1 \(invariants, P1\)/);
    for (const name of ['regression-unselected', 'audit-race', 'repair-resolved', 'prevention']) {
      assert.ok(!checked.result.criteria.some((c) => c.name === name), `${name} is not applicable on L`);
    }
    assertEveryStepPlayed(fx.dir);
  });
});
