// Upgrade in place (owner ruling, 2026-09-26): arcs run for days and executor fixes land mid-run, so an
// executor update never forces a new arc. HEAD's executor must adopt an arc the previous release started
// and finish it. The previous release's executor is extracted from git (`git archive PREVIOUS_RELEASE`) and
// run with its own setup, fakes and CLI; the fixture is generated at test time because the runtime state
// it leaves holds absolute paths. Each test runs the M1 fixture (evals/m1) on the previous release to a
// mid-arc point with live state, stops it, then finishes the arc with HEAD's driver (same repo, run dir and
// host dir; setup does not re-run; the spec inputs stay as the previous release left them) and grades it
// with HEAD's check.ts: every criterion passes, and the upgrade forced no park and no new session. The
// previous release (1.0.0-dev.4) scheduled serially, so every arc it started stays legacy under HEAD (M2
// "Adopted arcs"): no `scheduling: dag`, and no `@cpu` token is ever reserved for it.
//
//   upgrade.stop-mid-build     unit `slug` merged; `page-id` stopped mid-build (its Codex thread started, its
//                              worktree dirty), so held with an interrupted attempt; `resume` queued through
//                              the previous release's CLI. HEAD continues the same thread.
//   upgrade.reopen-mid-plan-check
//                              unit `slug` merged; `page-id` parked at plan-check on a blocking needs-user
//                              (escalated on its seat and on the escalation seat), its spec edited to rev 2 and
//                              put in force by `roadmap apply` (plan revision 2), re-opened by `resume page-id`
//                              (the needs-user acknowledged), and stopped mid-plan-check, so held. HEAD re-runs
//                              the plan-check and merges it on rev 2, recording no plan revision of its own; the
//                              finished arc then classifies an apply adding a unit as accepted (revision 3).
//   upgrade.park-adopted       unit `slug` merged; `page-id`'s lane killed by a signal twice (blocked, then its
//                              retry), so parked `lane-blocked` with no park class; its needs-user acknowledged,
//                              and the previous release ends the arc. HEAD reads the park as operator-env,
//                              `resume page-id` (queued through the previous release's CLI) re-runs its lanes,
//                              which now pass, and it merges.
//   upgrade.named-cpu-low-host (F18) the plan declares a named resource `cpu`, which both units reserve; `page-id`
//                              stopped mid-build as in stop-mid-build. HEAD finishes under a one-CPU affinity
//                              (`taskset -c 0`), where a DAG arc's build of 4 `@cpu` tokens is over capacity: the
//                              legacy arc is not refused, reserves no `@cpu`, and reserves `cpu` as before.
//
// Not covered: a crash mid-op (recovery of the previous release's open intents; the crash matrix covers
// recovery within one release), a backend parked on a usage limit, the Claude-only profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { isAlive, statOf } from '../src/contain/proc.ts';
import type { Event } from '../src/core/events.ts';
import { arcId, resourceName, unitId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import type { ProcIdentity } from '../src/core/records.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { overCapacity } from '../src/resources/pool.ts';
import { loadSpec } from '../src/spec/spec.ts';
import { CONTINUE_DIRECTIVE } from '../src/pipeline/rounds.ts';
import type { CheckResult } from '../evals/m1/check.ts';
import type { Report } from '../evals/m1/driver.ts';
import { type Layout, UNITS, layout } from '../evals/m1/layout.ts';
import type { M1Step } from '../evals/m1/scenario.ts';
import { type Exit, fixture, runUntilExit } from './helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import { type CallRecord, type ScenarioFile, type Step, readCalls } from './helpers/scenario.ts';

after(assertNoSurvivors);

/**
 * The previous release: its executor starts the arc, HEAD's finishes it. At each release, move it to the
 * last released commit, the merge of the previous release's PR into main. Merges here are merge commits, so
 * a merged branch's shas stay reachable and `git archive` finds them. Now: 1.0.0-dev.4, merged to main as
 * PR #104 (schema version 1). Arcs started before 1.0.0-dev.1 (a95355e) are not adopted; they are adapted by hand.
 */
const PREVIOUS_RELEASE = 'a5dfcbfeb6d49db25937aa5d2e8b1847edbe60fa';
const EXECUTOR_PATH = 'plugins/roadmap-orchestrator/executor';

const EXECUTOR = fileURLToPath(new URL('../', import.meta.url));
const EVALS = join(EXECUTOR, 'evals', 'm1');
/** The driver's own hard timeout under --fake is 5 min; each phase gets that and a margin. */
const PHASE_MS = 7 * 60_000;
const T = { timeout: 3 * PHASE_MS };
const CLI_MS = 60_000;
/** `start` waits for readiness itself (240 s by default). */
const START_MS = 300_000;
const POLL_MS = 200;

type PreviousModules = Readonly<{
  fakeSteps: typeof import('../evals/m1/scenario.ts').fakeSteps;
  readScenario: typeof import('../evals/m1/scenario.ts').readScenario;
  writeShims: typeof import('./fakes/shim.ts').writeShims;
}>;
type Previous = Readonly<{ root: string; modules: PreviousModules }>;

let previous: Previous;

/** The previous release's executor tree, extracted into a temp dir, and the modules the harness uses from it. */
before(async () => {
  const top = spawnSync('git', ['-C', EXECUTOR, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.equal(top.status, 0, top.stderr);
  const archive = spawnSync('git', ['-C', top.stdout.trim(), 'archive', '--format=tar', PREVIOUS_RELEASE, EXECUTOR_PATH], { maxBuffer: 1 << 30 });
  assert.equal(archive.status, 0, `git archive ${PREVIOUS_RELEASE}: ${archive.stderr}`);
  const dir = tmpDir('upgrade-previous');
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  assert.equal(tar.status, 0, `tar: ${tar.stderr}`);
  const root = join(dir, EXECUTOR_PATH);
  const load = (path: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(root, path)).href);
  const [scenario, shim] = await Promise.all([load('evals/m1/scenario.ts'), load('test/fakes/shim.ts')]);
  previous = { root, modules: { fakeSteps: scenario['fakeSteps'], readScenario: scenario['readScenario'], writeShims: shim['writeShims'] } as PreviousModules };
});

// ---------------------------------------------------------------------------------------------------
// Scenario pieces (evals/m1/scenarios/clean.json, whose steps are slug's three then page-id's three)

type Clean = Readonly<{ slug: readonly M1Step[]; pageId: Readonly<{ planCheck: M1Step; build: Extract<M1Step, { role: 'build' }>; gate: M1Step }> }>;

function clean(): Clean {
  const steps = (JSON.parse(readFileSync(join(EVALS, 'scenarios', 'clean.json'), 'utf8')) as { steps: M1Step[] }).steps;
  const [pc1, b1, g1, planCheck, build, gate] = steps;
  assert.ok(pc1 && b1 && g1 && planCheck && build && gate && build.role === 'build' && steps.length === 6);
  return { slug: [pc1, b1, g1], pageId: { planCheck, build, gate } };
}

const ESCALATE: M1Step = {
  role: 'planCheck',
  answer: { decision: 'escalate', reasons: ['The contract is ambiguous.'], patch: null, risk: 'med', notes: '', premises: [] },
};

/** The scenario file is HEAD's format; dev.5's strict plan-check schema rejects `visionConflict` (added after it). */
function forPrevious(step: M1Step): M1Step {
  if (step.role !== 'planCheck') return step;
  const { visionConflict: _, ...answer } = step.answer as Record<string, unknown>;
  return { ...step, answer } as M1Step;
}

/** Where the previous release is stopped: a fake call parked at a barrier in its scenario dir. */
const MID_CALL = 'mid-call';
const MID_BUILD_THREAD = '11111111-1111-4111-8111-111111111111';
/** page-id's fresh build: its Codex thread started, its files written but not committed, then parked. */
const midBuild = (files: Readonly<Record<string, string>>): Step => ({
  as: 'codex', threadId: MID_BUILD_THREAD, expect: { argv: ['exec', '-C'] },
  acts: [{ type: 'threadStarted' }, { type: 'dirty', files }, { type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }],
});
/** page-id's plan-check after its reopen, parked. */
const midPlanCheck: Step = { as: 'claude', expect: { argv: ['-p', '--tools', 'Read,Grep,Glob'] }, acts: [{ type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }] };

// ---------------------------------------------------------------------------------------------------
// Phase 1: the previous release

type Phase1 = Readonly<{
  dir: string;
  l: Layout;
  host: string;
  fakeDir: string;
  /** The previous release's `roadmap` CLI against the fixture's host dir, its fakes first on PATH. */
  cli: (args: readonly string[], timeoutMs?: number) => Promise<Exit>;
  run: readonly string[];
}>;

/**
 * Lays out the fixture with the previous release's setup, lets `edit` change its inputs before anything runs, and
 * writes the fakes for `m1` then `extra` (raw fake steps).
 */
async function preparePrevious(m1: readonly M1Step[], extra: readonly Step[], edit: (l: Layout) => void = () => {}): Promise<Phase1> {
  const dir = join(tmpDir('upgrade'), 'fx');
  const setup = await runUntilExit(process.execPath, [join(previous.root, 'evals', 'm1', 'setup.ts'), dir], { env: process.env, timeoutMs: CLI_MS });
  assert.equal(setup.code, 0, setup.stderr);
  const l = layout(dir);
  const planArc = (JSON.parse(readFileSync(l.plan, 'utf8')) as { arc: string }).arc;
  assert.equal(planArc, l.arc, 'the previous release lays the fixture out as HEAD\'s evals/m1/layout.ts does; if not, adapt this harness');
  edit(l);
  // HEAD's driver finishes the run with the host dir under fake/, so the previous release starts it there too.
  const host = join(l.fake, 'host');
  mkdirSync(host, { recursive: true });
  const fakeDir = join(dir, 'fake-previous');
  mkdirSync(fakeDir, { recursive: true });
  const m1File = join(fakeDir, 'm1.json');
  writeFileSync(m1File, JSON.stringify({ steps: m1.map(forPrevious) }));
  const { fakeSteps, readScenario, writeShims } = previous.modules;
  const scenario = join(fakeDir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ steps: [...fakeSteps(readScenario(m1File), 'default'), ...extra] }, null, 2));
  writeShims(join(fakeDir, 'bin'), scenario);
  const env = { ...process.env, PATH: `${join(fakeDir, 'bin')}:${process.env['PATH'] ?? ''}` };
  const cli = (args: readonly string[], timeoutMs = CLI_MS): Promise<Exit> =>
    runUntilExit(process.execPath, [join(previous.root, 'test', 'fixtures', 'exec-cli.ts'), host, ...args], { env, timeoutMs });
  return { dir, l, host, fakeDir, cli, run: ['--repo', l.repo, '--arc', l.arc] };
}

/** The run's processes, stopped through HEAD's CLI when a test fails midway. */
function scopeOf(p: Phase1): RunScope {
  return {
    paths: [p.dir],
    stop: async () => {
      const stop = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'stop', ...p.run], { env: process.env, timeoutMs: 30_000 });
      assert.equal(stop.code, 0, `roadmap stop: ${stop.stderr}`);
    },
  };
}

const journalOf = (p: Phase1) => readJournal(absPath(p.l.runDir), arcId(p.l.arc));

async function until<T>(what: string, timeoutMs: number, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = probe();
    if (got !== null) return got;
    if (Date.now() >= deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(POLL_MS);
  }
}

/** Starts the previous release's run; returns its supervisor. */
async function startPrevious(p: Phase1): Promise<ProcIdentity> {
  const start = await p.cli(['start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], START_MS);
  assert.equal(start.code, 0, `previous release start: ${start.stdout} ${start.stderr}`);
  const ready = JSON.parse(start.stdout) as { kind: string; generation: number; supervisor: number };
  assert.equal(ready.kind, 'ready', start.stdout);
  const stat = statOf(ready.supervisor);
  assert.ok(stat !== null, 'the supervisor is alive after start');
  return { pid: ready.supervisor, start: stat.start };
}

/** Waits until the fake call of MID_CALL is parked at its barrier. */
const midCall = (p: Phase1): Promise<true> => until(`the ${MID_CALL} barrier is reached`, PHASE_MS, () => (existsSync(join(p.fakeDir, `${MID_CALL}.reached`)) ? true : null));

/** `roadmap stop` through the previous release's CLI, then waits for its supervisor (and so its executor) to exit. */
async function stopPrevious(p: Phase1, supervisor: ProcIdentity): Promise<void> {
  const stop = await p.cli(['stop', ...p.run]);
  assert.equal(stop.code, 0, stop.stderr);
  await until('the previous release\'s supervisor exits after stop', 60_000, () => (isAlive(supervisor) ? null : true));
}

// ---------------------------------------------------------------------------------------------------
// Phase 2: HEAD finishes the arc

type Finished = Readonly<{ driver: Exit; report: Report; check: CheckResult; calls: readonly CallRecord[]; after: readonly Event[]; view: JournalView }>;

/**
 * HEAD's driver on the same fixture with `m1` (its smoke prepended), then HEAD's check. `wrap` runs the driver
 * (and so the supervisor and executors it starts) under a command prefix, e.g. a CPU affinity.
 */
async function finishOnHead(p: Phase1, m1: readonly M1Step[], wrap: readonly string[] = []): Promise<Finished> {
  const highWater = journalOf(p).view.highWater();
  const file = join(p.dir, 'head.json');
  writeFileSync(file, JSON.stringify({ steps: m1 }));
  const [cmd = process.execPath, ...pre] = wrap.length === 0 ? [] : [...wrap, process.execPath];
  const driver = await runUntilExit(cmd, [...pre, join(EVALS, 'driver.ts'), p.dir, '--profile', 'default', '--fake', file], { env: process.env, timeoutMs: PHASE_MS });
  const report = JSON.parse(readFileSync(p.l.report, 'utf8')) as Report;
  const checked = await runUntilExit(process.execPath, [join(EVALS, 'check.ts'), p.dir], { env: process.env, timeoutMs: CLI_MS });
  const check = JSON.parse(checked.stdout.split('\n')[0]!) as CheckResult;
  const scenario = join(p.l.fake, 'scenario.json');
  const calls = readCalls(scenario);
  const steps = (JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile).steps;
  assert.deepEqual(calls.map((c) => c.step), steps.map((_, i) => i), 'HEAD\'s calls matched every step of its scenario, in order');
  const { view, events } = journalOf(p);
  return { driver, report, check, calls, after: events.filter((e) => e.seq > highWater), view };
}

/** Every check.ts criterion passes, both units merged, one HEAD generation ran it, and the upgrade forced no park. */
function assertFinished(f: Finished): void {
  assert.equal(f.driver.code, 0, `driver: ${f.driver.stdout} ${f.driver.stderr}`);
  assert.equal(f.report.endedBy, 'exit');
  assert.equal(f.report.generation, f.report.start.ready?.generation, 'HEAD\'s executor was not restarted');
  assert.ok((f.report.generation ?? 0) > 1, 'HEAD ran a later host generation than the previous release');
  assert.deepEqual(f.report.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.deepEqual(f.check.criteria.filter((c) => !c.pass), [], JSON.stringify(f.check.criteria));
  assert.equal(f.check.criteria.length, 8);
  const forced = f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && ['park', 'stop'].includes(e.fact.class) ? [`${e.fact.unit} ${e.fact.stage} ${e.fact.outcome}`] : []));
  assert.deepEqual(forced, [], 'the upgrade parked or stopped no unit');
  const raised = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'needsuser.raise' ? [e.expect.id] : []));
  assert.deepEqual(raised, [], 'HEAD raised no needs-user');
  assertLegacy(f);
}

/** The previous release's arc stays legacy (serial) under HEAD: no `scheduling: dag`, and no `@cpu` token reserved. */
function assertLegacy(f: Finished): void {
  assert.equal(f.view.scheduling(), 'legacy');
  const cpu = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' ? e.expect.resources.filter((r) => r.startsWith('@cpu#')) : []));
  assert.deepEqual(cpu, [], 'HEAD reserved no @cpu token for the legacy arc');
}

/** HEAD's calls after its start-up smoke (Claude, then Codex, under `default`). */
const SMOKE_CALLS = 2;
// ---------------------------------------------------------------------------------------------------

/**
 * Phase 1 of stop-mid-build: the previous release merges `slug` and is stopped mid-build of `page-id` (held,
 * interrupted); `resume` is queued through its CLI. Returns the phase and HEAD's steps to finish it (the build
 * resumed with the continue directive, then the gate).
 */
async function stoppedMidBuild(c: Clean, edit?: (l: Layout) => void): Promise<Readonly<{ p: Phase1; head: readonly M1Step[] }>> {
  const files = c.pageId.build.acts.flatMap((a) => (a.type === 'commit' ? [a.files] : []))[0];
  assert.ok(files !== undefined);
  const p = await preparePrevious([...c.slug, c.pageId.planCheck], [midBuild(files as Readonly<Record<string, string>>)], edit);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  return { p, head: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] };
}

test('upgrade.stop-mid-build: HEAD continues the Codex thread the previous release was stopped in, and merges the arc', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const builds = f.calls.slice(SMOKE_CALLS).filter((call) => call.as === 'codex');
  assert.deepEqual(builds.map((b) => b.argv.slice(0, 3)), [['exec', 'resume', MID_BUILD_THREAD]], 'HEAD resumed the thread the previous release started, and started no fresh session');
});

test('upgrade.reopen-mid-plan-check: a unit the previous release parked, re-opened and stopped mid-judgment finishes on HEAD', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, ESCALATE, ESCALATE], [midPlanCheck]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks on a raised needs-user', PHASE_MS, () => {
      const view = journalOf(p).view;
      return view.unit(unitId('page-id')).status === 'park-pending' && view.needsUser().length > 0 ? true : null;
    });
    // The architect's edit: the next rev, one more fact, put in force by `roadmap apply` (a pending revision);
    // then `resume page-id` re-opens the unit on it.
    const specPath = join(p.l.input, 'page-id.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { rev: number; facts: object[] };
    writeFileSync(specPath, `${JSON.stringify({ ...spec, rev: spec.rev + 1, facts: [...spec.facts, { id: 'F2', text: 'Contract one is unambiguous about the empty slug.', state: 'active' }] }, null, 2)}\n`);
    const apply = await p.cli(['apply', ...p.run]);
    assert.equal(apply.code, 0, apply.stderr);
    await until('the previous release applies the revision as plan revision 2', PHASE_MS, () => (journalOf(p).view.planApplied()?.rev === 2 ? true : null));
    const reopen = await p.cli(['resume', 'page-id', ...p.run]);
    assert.equal(reopen.code, 0, reopen.stderr);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome, held.reopened?.specRev], ['plan-check', 'held', 'interrupted', 2]);
  assert.deepEqual(mid.needsUser().map((n) => [n.blocking, n.ack !== null]), [[true, true]], 'the park\'s needs-user, acknowledged by the reopen');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.planCheck, c.pageId.build, c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const u = f.view.unit(unitId('page-id'));
  assert.deepEqual([u.reopened?.specRev, u.spec?.rev], [2, 2], 'page-id merged on the spec rev the previous release re-opened it on');
  await assertAcceptsApply(p, f);
});

/**
 * The previous release kept the plan revisions (1 at its start, 2 by its apply): HEAD's start finds its files
 * in force and records none, and the arc then takes `roadmap apply` like any other: a unit added to its plan
 * classifies as accepted (a dry run: the arc is complete, and no executor runs to apply it).
 */
async function assertAcceptsApply(p: Phase1, f: Finished): Promise<void> {
  const revisions = f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [[e.fact.rev, e.fact.command]] : []));
  assert.deepEqual(revisions, [], 'HEAD recorded no plan revision: the previous release\'s revision 2 is in force');
  assert.equal(f.view.planApplied()?.rev, 2);
  const plan = JSON.parse(readFileSync(p.l.plan, 'utf8')) as { units: { id: string; spec: string }[] };
  const last = plan.units.at(-1)!;
  const spec = JSON.parse(readFileSync(join(p.l.input, last.spec), 'utf8')) as object;
  writeFileSync(join(p.l.input, 'extra.json'), JSON.stringify({ ...spec, unit: 'extra', rev: 1 }));
  writeFileSync(p.l.plan, JSON.stringify({ ...plan, units: [...plan.units, { ...last, id: 'extra', spec: 'extra.json', after: [] }] }));
  const dry = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'apply', '--dry-run', ...p.run], { env: process.env, timeoutMs: CLI_MS });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { dryRun: true, kind: 'accepted', rev: 2, nextRev: 3, changes: [{ type: 'unit-added', unit: 'extra' }], smoke: [] });
}

// ---------------------------------------------------------------------------------------------------
// M2 variants (1.0.0-dev.4 → dev.5)

/** Rewrites a JSON input file of the fixture in place. */
function editJson<T>(path: string, edit: (value: T) => T): void {
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as T), null, 2)}\n`);
}

test('upgrade.park-adopted: a unit the previous release parked lane-blocked is an operator-env park on HEAD; `resume page-id` re-runs its lanes, and it merges', T, async () => {
  const c = clean();
  let marker = '';
  // page-id's lane is killed by a signal (no verdict: blocked) until the marker exists.
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [], (l) => {
    marker = join(l.dir, 'page-id-lane-passes');
    editJson<{ lanes: { argv: readonly string[] }[] }>(join(l.input, 'page-id.json'), (spec) => ({
      ...spec,
      lanes: spec.lanes.map((lane) => ({ ...lane, argv: ['/bin/sh', '-c', '[ -e "$1" ] && exec node --test test/page-id.test.js; kill -KILL $$', 'lane', marker] })),
    }));
  });
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    const item = await until('page-id parks on a raised needs-user', PHASE_MS, () => {
      const view = journalOf(p).view;
      return view.unit(unitId('page-id')).status === 'park-pending' ? view.needsUser()[0]?.id ?? null : null;
    });
    const ack = await p.cli(['ack', item, ...p.run]);
    assert.equal(ack.code, 0, ack.stderr);
    // Every unit merged, or parked with its item acknowledged: the previous release ends the arc itself.
    await until('the previous release ends the arc once the park is acknowledged', PHASE_MS, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const parked = mid.unit(unitId('page-id'));
  assert.deepEqual([parked.status, parked.decided?.stage, parked.decided?.outcome], ['park-pending', 'lanes', 'blocked']);
  assert.equal(parked.decided?.park, undefined, 'the previous release wrote no park class');
  assert.deepEqual(parked.park?.park, { class: 'operator', kind: 'env' }, 'HEAD reads the classless park as operator-env');
  const resume = await p.cli(['resume', 'page-id', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  writeFileSync(marker, '');

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'unparked' ? [e.fact.unit] : [])), ['page-id'], 'resume page-id unparked it');
  const ran = f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === 'page-id' ? [`${e.fact.stage}:${e.fact.outcome}`] : []));
  assert.deepEqual(ran, ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'], 'HEAD re-ran the lanes, and nothing before them');
});

test('upgrade.named-cpu-low-host: a legacy plan\'s named resource `cpu` is reserved as before on a one-CPU host; the arc is not refused as over capacity and takes no @cpu', T, async () => {
  const affinity = spawnSync('taskset', ['-c', '0', process.execPath, '-e', 'process.stdout.write(String(require("node:os").availableParallelism()))'], { encoding: 'utf8' });
  assert.equal(affinity.status, 0, `taskset: ${affinity.stderr}`);
  assert.equal(affinity.stdout, '1', 'taskset -c 0 leaves one CPU available');
  const withCpu = (resources: readonly string[]): readonly string[] => [...resources, 'cpu'];
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    type Plan = { resources: { name: string }[]; units: { spec: string; resources: string[] }[] };
    editJson<Plan>(l.plan, (plan) => {
      const [scratch] = plan.resources;
      assert.ok(scratch !== undefined && plan.resources.length === 1);
      // The same state-dir resource as `scratch`, under its own owner file.
      const cpu = JSON.parse(JSON.stringify(scratch).replaceAll('scratch', 'cpu')) as { name: string };
      assert.equal(cpu.name, 'cpu');
      for (const u of plan.units) editJson<{ resources: string[] }>(join(l.input, u.spec), (spec) => ({ ...spec, resources: [...withCpu(spec.resources)] }));
      return { ...plan, resources: [...plan.resources, cpu], units: plan.units.map((u) => ({ ...u, resources: [...withCpu(u.resources)] })) };
    });
  });
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, ['taskset', '-c', '0']);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const reserved = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reserve' ? [e.expect.resources] : []));
  assert.ok(reserved.some((units) => units.includes(resourceName('cpu'))), `HEAD reserved the named cpu: ${JSON.stringify(reserved)}`);
  // What the legacy reading spares it: the same plan, read as a new (DAG) arc on this host, is over capacity.
  const plan = requirePlanInForce(absPath(p.l.runDir), f.view).plan;
  const specs = new Map(plan.units.map((u) => [u.id, loadSpec(absPath(join(p.l.input, u.spec)))] as const));
  assert.ok(overCapacity(plan, { cpu: 1 }, specs, null).length > 0, 'a DAG arc builds with 4 @cpu tokens: over a one-CPU capacity');
  assert.deepEqual(overCapacity(plan, { cpu: 1 }, specs, f.view), [], 'the legacy arc is never over capacity');
});
