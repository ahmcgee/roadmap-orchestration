// Upgrade in place (owner ruling, 2026-09-26): arcs run for days and executor fixes land mid-run, so an
// executor update never forces a new arc. HEAD's executor must adopt an arc the previous release started
// and finish it. The previous release's executor is extracted from git (`git archive PREVIOUS_RELEASE`) and
// run with its own setup, fakes and CLI; the fixture is generated at test time because the runtime state
// it leaves holds absolute paths. Each test runs the M1 fixture (evals/m1) on the previous release to a
// mid-arc point with live state, stops it (or lets it crash at a crash point, below), then finishes the arc on
// HEAD (same repo, run dir and host dir; setup does not re-run; the spec inputs stay as the previous release
// left them), with HEAD's driver, graded by HEAD's check.ts (every criterion passes, and the upgrade forced no
// park and no new session), or, where the story needs arc judgments the M1 scenario format cannot express, with
// HEAD's CLI and fakes directly. The previous release (1.0.0-dev.5) scheduled a DAG, so every arc it started is a
// DAG arc under HEAD too (`scheduling: dag`, `@cpu` reserved). It has no holistic layer: HEAD runs its arcs with
// M2 semantics and no new spend unless the architect opts in (plan "Upgrade in place (dev.5 → dev.6)").
//
// A crashed previous release: its executor is armed with a crash trigger (src/core/crash.ts), and its supervisor
// is frozen (SIGSTOP) as soon as it is ready, so no generation of the previous release recovers the crash; once
// the executor is gone the supervisor is SIGKILLed. HEAD's start takes over the dead claim of the same arc and its
// recovery finishes what the previous release left open.
//
// The M2 variants (1.0.0-dev.4 → dev.5), now run against dev.5:
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
//                              retry), so parked `lane-blocked` operator-env (dev.5 records the park class); its
//                              needs-user acknowledged, and the previous release ends the arc. `resume page-id`
//                              (queued through the previous release's CLI) re-runs its lanes on HEAD, which now
//                              pass, and it merges.
//   upgrade.named-cpu-low-host (F18) the plan declares a named resource `cpu`, which both units reserve; `page-id`
//                              stopped mid-build as in stop-mid-build. A dev.5 arc is a DAG arc: on a one-CPU
//                              host (`taskset -c 0`) HEAD refuses it over the `@cpu` capacity, as dev.5 does, and
//                              changes nothing; on this host HEAD finishes it reserving both the named `cpu` and
//                              `@cpu` tokens.
//
// The M3 variants (1.0.0-dev.5 → dev.6; plan "Upgrade in place", G14–G16, H7, H15, A5a, B4):
//   upgrade.dev5-completes     stopped mid-build as in stop-mid-build: HEAD finishes it with no vision and no
//                              holistic layer: no holistic fact, no arc call, no job, no plan revision.
//   upgrade.dev5-approval-open-ff
//                              (G14) dev.5 approved `page-id` and crashed with its unit `ff` open (`ff.act-start`):
//                              HEAD's recovery compares the dev.5 approval's fingerprint byte for byte, redoes the
//                              ff and publishes it, with no new judgment.
//   upgrade.dev5-plan-check-answer
//                              (B4) dev.5 crashed after `page-id`'s plan-check result was written (`spawn.after-result`):
//                              HEAD consumes that answer, which has no `visionConflict` (read as none), and builds.
//   upgrade.dev5-apply-queued  (G15) stopped mid-build, `page-id` left held; on HEAD's running arc the architect's
//                              `apply` (a new `direction`) queued through dev.5's CLI: HEAD applies its dev.5 body
//                              (legacy interpretation, ledger live) as plan revision 2, the command's bytes unchanged.
//   upgrade.dev5-apply-open    (G15) `page-id` parked at plan-check as in reopen-mid-plan-check; the architect's
//                              `apply` of its rev 2 spec, queued through dev.5's CLI, crashed open after its
//                              revision 2 (`command.apply.after-effect`, no receipt); `resume page-id` queued. HEAD's
//                              start leaves the files to the open command, its recovery finishes it, then re-opens
//                              `page-id`, which merges on rev 2 (HEAD's CLI and fakes: the M1 driver stops a run it
//                              sees parked).
//   upgrade.dev5-spend-by-model
//                              (G16, H7) the repo config binds `efficient` to a non-default triple; stopped
//                              mid-build. HEAD adopts dev.5's revision with its routing provenance reconstructed from
//                              that binding, and `status` attributes every build, dev.5's and HEAD's, to the bound
//                              model.
//   upgrade.rule-on-dev5-arc   stopped mid-build; while `page-id` waits at its lane on HEAD, `roadmap rule` lands
//                              C-3 on the dev.5 revision (its live ledger): the ledger's preimage kept, the docs
//                              publication of constraints.md, the write-back; then `page-id` merges.
//   upgrade.dev5-roadmap-diff-branch
//                              (H15) `page-id`'s dev.5 build edits the allowlisted `.roadmap/constraints.md`, its gate
//                              approves, and dev.5 is stopped in its candidate's suite: HEAD admits the candidate
//                              under dev.5's transient rules (m3's would refuse the path) and publishes it.
//   upgrade.compact-with-dev5-retry
//                              (A5a, H1) `slug`'s resource teardown fails once; dev.5's retry crashes after its
//                              `cleaned` disposition (`retry.after-disposition`), the instance still held; 64
//                              released pairs of another arc fill the index. HEAD's start compacts it: the fillers
//                              go, the dev.5 pair stays byte for byte; recovery releases it and the arc merges.
//   upgrade.opt-in-holistic    stopped mid-build, `page-id` left held; on HEAD the architect's
//                              `apply` adds `holistic` (a vision, one must-hold obligation witnessed by a node-test
//                              lane, L = {invariants}), then `resume page-id`: the baseline job, the brake on
//                              `page-id`'s candidate, the final audit and a no-op checkpoint, `arc-completed`.
//
// Not covered: a backend parked on a usage limit, the Claude-only profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { isAlive, statOf } from '../src/contain/proc.ts';
import type { Event, Fact } from '../src/core/events.ts';
import { arcId, commandId, invocationId, opId, resourceName, unitId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { canonicalJson } from '../src/core/json.ts';
import type { ProcIdentity } from '../src/core/records.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { incomingPath, terminalReceipt } from '../src/commands/queue.ts';
import type { ExitReason } from '../src/executor.ts';
import { transientViolations } from '../src/git/transient.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { readOwner } from '../src/host/owner.ts';
import { RESIDUE_ARCHIVE, bodyOf, readResidues, recordDisposition, recordResidue } from '../src/host/residues.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { overCapacity } from '../src/resources/pool.ts';
import { bytesSha256, loadSpec } from '../src/spec/spec.ts';
import { CONTINUE_DIRECTIVE } from '../src/pipeline/rounds.ts';
import { executorLogs, lastLine } from '../src/supervisor.ts';
import type { CheckResult } from '../evals/m1/check.ts';
import type { Report } from '../evals/m1/driver.ts';
import { type Layout, RESOURCE, UNITS, layout } from '../evals/m1/layout.ts';
import { type M1Step, fakeSteps as headFakeSteps } from '../evals/m1/scenario.ts';
import { type TriggerSpec, assertFired, writeTrigger } from './helpers/crash.ts';
import { checkpointAnswer, checkpointStep, lensStep } from './helpers/holistic.ts';
import { type Exit, fixture, runUntilExit } from './helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type CallRecord, type ScenarioFile, type Step, readCalls, writeScenario } from './helpers/scenario.ts';

after(assertNoSurvivors);

/**
 * The previous release: its executor starts the arc, HEAD's finishes it. At each release, move it to the
 * last released commit, the merge of the previous release's PR into main. Merges here are merge commits, so
 * a merged branch's shas stay reachable and `git archive` finds them. Now: 1.0.0-dev.5, merged to main as
 * PR #105 (schema version 1). Arcs started before 1.0.0-dev.1 (a95355e) are not adopted; they are adapted by hand.
 */
const PREVIOUS_RELEASE = 'be761320c0c0b2323b856ed42dd571ff3a98bea8';
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
  assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"version": "1\.0\.0-dev\.5"/);
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

/** `page-id`'s build files (clean.json). */
function pageIdFiles(c: Clean): Readonly<Record<string, string>> {
  const files = c.pageId.build.acts.flatMap((a) => (a.type === 'commit' ? [a.files] : []))[0];
  assert.ok(files !== undefined);
  return files as Readonly<Record<string, string>>;
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
  cli: (args: readonly string[], timeoutMs?: number, env?: Readonly<Record<string, string>>) => Promise<Exit>;
  run: readonly string[];
}>;

/**
 * Lays out the fixture with the previous release's setup, lets `edit` change its inputs before anything runs, and
 * writes the fakes for `m1` (or what it makes of the laid-out fixture) then `extra` (raw fake steps).
 */
async function preparePrevious(
  m1: readonly M1Step[] | ((l: Layout) => readonly M1Step[]), extra: readonly Step[], edit: (l: Layout) => void = () => {},
): Promise<Phase1> {
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
  writeFileSync(m1File, JSON.stringify({ steps: (typeof m1 === 'function' ? m1(l) : m1).map(forPrevious) }));
  const { fakeSteps, readScenario, writeShims } = previous.modules;
  const scenario = join(fakeDir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ steps: [...fakeSteps(readScenario(m1File), 'default'), ...extra] }, null, 2));
  writeShims(join(fakeDir, 'bin'), scenario);
  const env = { ...process.env, PATH: `${join(fakeDir, 'bin')}:${process.env['PATH'] ?? ''}` };
  const cli = (args: readonly string[], timeoutMs = CLI_MS, extraEnv: Readonly<Record<string, string>> = {}): Promise<Exit> =>
    runUntilExit(process.execPath, [join(previous.root, 'test', 'fixtures', 'exec-cli.ts'), host, ...args], { env: { ...env, ...extraEnv }, timeoutMs });
  return { dir, l, host, fakeDir, cli, run: ['--repo', l.repo, '--arc', l.arc] };
}

/** HEAD's `roadmap` CLI against the fixture's host dir. */
const headCli = (p: Phase1, args: readonly string[]): Promise<Exit> =>
  runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, ...args], { env: process.env, timeoutMs: CLI_MS });

/** The run's processes, stopped through HEAD's CLI when a test fails midway. */
function scopeOf(p: Phase1): RunScope {
  return {
    paths: [p.dir],
    stop: async () => {
      const stop = await headCli(p, ['stop', ...p.run]);
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

/** Starts the previous release's run (`env` added to its start, and so to its supervisor and executors); returns its supervisor. */
async function startPrevious(p: Phase1, env: Readonly<Record<string, string>> = {}): Promise<ProcIdentity> {
  const start = await p.cli(['start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], START_MS, env);
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

/**
 * Runs the previous release until its executor crashes at `spec` (it SIGKILLs itself there), and leaves what the crash
 * left open for HEAD: the supervisor is frozen as soon as it is ready, so no generation of the previous release
 * respawns to recover it, and SIGKILLed once the executor is gone. `act` runs meanwhile (the architect's commands).
 */
async function crashPrevious(p: Phase1, spec: TriggerSpec, act: () => Promise<void> = async () => {}): Promise<void> {
  const trigger = writeTrigger(p.dir, spec);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { ROADMAP_TEST_CRASH: trigger });
    process.kill(supervisor.pid, 'SIGSTOP');
    await act();
    await until(`the previous release's executor crashes at ${spec.label}`, PHASE_MS, () => (existsSync(`${trigger}.fired`) ? true : null));
    const executor = readOwner(absPath(p.host))?.executor ?? null;
    assert.ok(executor !== null, 'host.owner.json names the crashed executor');
    await until('the crashed executor is gone', 60_000, () => (isAlive(executor) ? null : true));
    process.kill(supervisor.pid, 'SIGKILL');
    await until('the frozen supervisor is gone', 60_000, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  assertFired(trigger);
  const started = journalOf(p).events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started');
  assert.equal(started.length, 1, 'one executor generation of the previous release ran: nothing of it recovered the crash');
}

// ---------------------------------------------------------------------------------------------------
// Phase 2: HEAD finishes the arc

type Finished = Readonly<{ driver: Exit; report: Report; check: CheckResult; calls: readonly CallRecord[]; after: readonly Event[]; view: JournalView }>;

/**
 * HEAD's driver on the same fixture with `m1` (its smoke prepended), then HEAD's check. `during` runs alongside the
 * driver (the architect acting on the running arc).
 */
async function finishOnHead(p: Phase1, m1: readonly M1Step[], during: () => Promise<void> = async () => {}): Promise<Finished> {
  const highWater = journalOf(p).view.highWater();
  const file = join(p.dir, 'head.json');
  writeFileSync(file, JSON.stringify({ steps: m1 }));
  const [driver] = await Promise.all([
    runUntilExit(process.execPath, [join(EVALS, 'driver.ts'), p.dir, '--profile', 'default', '--fake', file], { env: process.env, timeoutMs: PHASE_MS }),
    during(),
  ]);
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

/**
 * Every check.ts criterion passes but `failing` (named with the reason in the caller), both units merged, one HEAD
 * generation ran it, and the upgrade forced no park.
 */
function assertFinished(f: Finished, failing: readonly string[] = []): void {
  assert.equal(f.driver.code, 0, `driver: ${f.driver.stdout} ${f.driver.stderr}`);
  assert.equal(f.report.endedBy, 'exit');
  assert.equal(f.report.generation, f.report.start.ready?.generation, 'HEAD\'s executor was not restarted');
  assert.ok((f.report.generation ?? 0) > 1, 'HEAD ran a later host generation than the previous release');
  assert.deepEqual(f.report.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.deepEqual(f.check.criteria.filter((c) => !c.pass).map((c) => c.name), failing, JSON.stringify(f.check.criteria));
  assert.equal(f.check.criteria.length, 8);
  const forced = f.after.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && ['park', 'stop'].includes(e.fact.class) ? [`${e.fact.unit} ${e.fact.stage} ${e.fact.outcome}`] : []));
  assert.deepEqual(forced, [], 'the upgrade parked or stopped no unit');
  const raised = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'needsuser.raise' ? [e.expect.id] : []));
  assert.deepEqual(raised, [], 'HEAD raised no needs-user');
  assertDag(f);
}

/**
 * The previous release's arc is a DAG arc under HEAD too: `scheduling: dag`, and HEAD reserves `@cpu` tokens for the
 * stages it runs (an ff and a snapshot reserve none).
 */
function assertDag(f: Finished): void {
  assert.equal(f.view.scheduling(), 'dag');
  const ran = factsOf(f.after, 'stage-outcome').filter((o) => o.stage !== 'ff' && o.stage !== 'snapshot');
  const cpu = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' ? e.expect.resources.filter((r) => r.startsWith('@cpu#')) : []));
  assert.equal(cpu.length > 0, ran.length > 0, `HEAD reserved @cpu exactly when it ran a stage that takes it: ${JSON.stringify(ran.map((o) => o.stage))}`);
}

/** HEAD's calls after its start-up smoke (Claude, then Codex, under `default`). */
const SMOKE_CALLS = 2;

/** The upgrade defaults (src/core/upgrade.ts) HEAD's executor of `generation` warned it applied, from its stderr in the host dir. */
function defaulted(p: Phase1, generation: number): ReadonlySet<string> {
  const text = readFileSync(executorLogs(absPath(p.host), generation).err, 'utf8');
  return new Set([...text.matchAll(/^roadmap: upgrade default \(([^)]+)\)/gm)].map((m) => m[1]!));
}

const factsOf = <K extends Fact['kind']>(events: readonly Event[], kind: K): readonly Extract<Fact, { kind: K }>[] =>
  events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact as Extract<Fact, { kind: K }>] : []));
/** The stage outcomes of `unit` among `events`, as `stage:outcome`. */
const outcomesOf = (events: readonly Event[], unit: string): readonly string[] =>
  factsOf(events, 'stage-outcome').filter((f) => f.unit === unit).map((f) => `${f.stage}:${f.outcome}`);

// ---------------------------------------------------------------------------------------------------

/**
 * Phase 1 of stop-mid-build: the previous release merges `slug` and is stopped mid-build of `page-id` (held,
 * interrupted); `resume` is queued through its CLI unless `queueResume` is false (the caller releases it later).
 * Returns the phase and HEAD's steps to finish it (the build resumed with the continue directive, then the gate).
 */
async function stoppedMidBuild(c: Clean, edit?: (l: Layout) => void, queueResume = true): Promise<Readonly<{ p: Phase1; head: readonly M1Step[] }>> {
  const p = await preparePrevious([...c.slug, c.pageId.planCheck], [midBuild(pageIdFiles(c))], edit);
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
  if (queueResume) {
    const resume = await p.cli(['resume', ...p.run]);
    assert.equal(resume.code, 0, resume.stderr);
  }
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
    await parkedAtPlanCheck(p);
    // The architect's edit: the next rev, one more fact, put in force by `roadmap apply` (a pending revision);
    // then `resume page-id` re-opens the unit on it.
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
 * Waits until the previous release parks `page-id` at plan-check on a raised needs-user, then writes the architect's
 * edit of its spec: the next rev, one more fact (put in force by the caller's `roadmap apply`).
 */
async function parkedAtPlanCheck(p: Phase1): Promise<void> {
  await until('page-id parks on a raised needs-user', PHASE_MS, () => {
    const view = journalOf(p).view;
    return view.unit(unitId('page-id')).status === 'park-pending' && view.needsUser().length > 0 ? true : null;
  });
  const specPath = join(p.l.input, 'page-id.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { rev: number; facts: object[] };
  writeFileSync(specPath, `${JSON.stringify({ ...spec, rev: spec.rev + 1, facts: [...spec.facts, { id: 'F2', text: 'Contract one is unambiguous about the empty slug.', state: 'active' }] }, null, 2)}\n`);
}

/**
 * The previous release kept the plan revisions (1 at its start, 2 by its apply): HEAD's start finds its files
 * in force and records none, and the arc then takes `roadmap apply` like any other: a unit added to its plan
 * classifies as accepted (a dry run: the arc is complete, and no executor runs to apply it).
 */
async function assertAcceptsApply(p: Phase1, f: Finished): Promise<void> {
  const revisions = factsOf(f.after, 'plan-applied').map((a) => [a.rev, a.command]);
  assert.deepEqual(revisions, [], 'HEAD recorded no plan revision: the previous release\'s revision 2 is in force');
  assert.equal(f.view.planApplied()?.rev, 2);
  const plan = JSON.parse(readFileSync(p.l.plan, 'utf8')) as { units: { id: string; spec: string }[] };
  const last = plan.units.at(-1)!;
  const spec = JSON.parse(readFileSync(join(p.l.input, last.spec), 'utf8')) as object;
  writeFileSync(join(p.l.input, 'extra.json'), JSON.stringify({ ...spec, unit: 'extra', rev: 1 }));
  writeFileSync(p.l.plan, JSON.stringify({ ...plan, units: [...plan.units, { ...last, id: 'extra', spec: 'extra.json', after: [] }] }));
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { dryRun: true, kind: 'accepted', rev: 2, nextRev: 3, changes: [{ type: 'unit-added', unit: 'extra' }], smoke: [] });
}

// ---------------------------------------------------------------------------------------------------
// M2 variants

/** Rewrites a JSON input file of the fixture in place. */
function editJson<T>(path: string, edit: (value: T) => T): void {
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as T), null, 2)}\n`);
}

test('upgrade.park-adopted: a unit the previous release parked lane-blocked (operator-env) stays parked on HEAD; `resume page-id` re-runs its lanes, and it merges', T, async () => {
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
  assert.deepEqual(parked.decided?.park, { class: 'operator', kind: 'env' }, 'the previous release recorded the park class itself');
  assert.deepEqual(parked.park?.park, { class: 'operator', kind: 'env' }, 'HEAD reads the park as the previous release wrote it');
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
  assert.deepEqual(factsOf(f.after, 'unparked').map((u) => u.unit), ['page-id'], 'resume page-id unparked it');
  assert.deepEqual(outcomesOf(f.after, 'page-id'), ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'], 'HEAD re-ran the lanes, and nothing before them');
});

test('upgrade.named-cpu-low-host: a dev.5 plan\'s named resource `cpu` is reserved beside @cpu; on a one-CPU host HEAD refuses the DAG arc over capacity, as dev.5 does, and changes nothing', T, async () => {
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
  // One CPU: a DAG arc's build asks 4 @cpu tokens, so the start is refused before any effect.
  const highWater = journalOf(p).view.highWater();
  const low = await runUntilExit('taskset', ['-c', '0', process.execPath, fixture('exec-cli.ts'), p.host, 'start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], { env: process.env, timeoutMs: START_MS });
  assert.equal(low.code, 78, `start on one CPU: ${low.stdout} ${low.stderr}`);
  const refused = JSON.parse(low.stdout) as { kind: string; rejections: { kind: string; problem: { type: string; resource: string } }[] };
  assert.equal(refused.kind, 'refused');
  assert.ok(refused.rejections.length > 0 && refused.rejections.every((r) => r.kind === 'plan-invalid' && r.problem.type === 'over-capacity' && r.problem.resource === '@cpu'), low.stdout);
  assert.equal(journalOf(p).view.highWater(), highWater, 'the refused start appended nothing');
  const plan = requirePlanInForce(absPath(p.l.runDir), journalOf(p).view).plan;
  const specs = new Map(plan.units.map((u) => [u.id, loadSpec(absPath(join(p.l.input, u.spec)))] as const));
  assert.ok(overCapacity(plan, { cpu: 1 }, specs, journalOf(p).view).length > 0, 'the dev.5 arc is a DAG arc: over a one-CPU capacity');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const reserved = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reserve' ? [e.expect.resources] : []));
  assert.ok(reserved.some((units) => units.includes(resourceName('cpu'))), `HEAD reserved the named cpu: ${JSON.stringify(reserved)}`);
});

// ---------------------------------------------------------------------------------------------------
// M3 variants (1.0.0-dev.5 → dev.6)

/** Every M3 fact kind but `arc-completed` (whether an arc without the layer records its completion is not what these variants test). */
const HOLISTIC_KINDS: ReadonlySet<string> = new Set([
  'witnessed', 'obligation-latched', 'finding-opened', 'finding-transition', 'audit-started', 'audit-ended', 'docs-covered', 'checkpoint-inputs',
  'bundle-decided', 'divergence', 'divergence-digest', 'steered', 'merged-in', 'audit-requested', 'admissions-closed', 'docs-published',
]);

test('upgrade.dev5-completes: HEAD finishes a dev.5 arc with no vision and no holistic layer: no holistic fact, no arc call or job, no plan revision', T, async () => {
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
  assert.equal(f.view.holistic().on, false);
  assert.deepEqual(f.after.flatMap((e) => (e.type === 'fact' && HOLISTIC_KINDS.has(e.fact.kind) ? [e.fact.kind] : [])), [], 'no holistic fact');
  assert.deepEqual(factsOf(f.after, 'plan-applied'), [], 'no plan revision');
  const jobs = f.after.flatMap((e) => (e.type === 'intent' && (e.kind === 'revision.commit' || e.kind === 'docs.commit' || e.kind === 'mutant.apply' || e.parent?.type === 'job') ? [`${e.kind} ${canonicalJson(e.parent)}`] : []));
  assert.deepEqual(jobs, [], 'no revision, docs publication, mutant or job');
  assert.deepEqual(f.calls.map((c) => c.lens), f.calls.map(() => null), 'no lens call');
  assert.equal(f.calls.length, SMOKE_CALLS + head.length, 'the unit calls, and no arc call');
  const s = f.report.status;
  assert.deepEqual([s.vision, s.audit, s.divergences, s.spend.byJob], [null, null, [], []]);
  assert.ok(defaulted(p, f.report.generation!).has('dispatch.transientRules'), 'page-id, dispatched by dev.5, keeps its transient rules');
});

test('upgrade.dev5-approval-open-ff: dev.5 approved page-id and crashed with its ff open; HEAD\'s recovery compares the dev.5 fingerprint byte for byte and publishes, with no new judgment', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], []);
  await crashPrevious(p, { label: 'ff.act-start', occurrence: 1, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const open = mid.opsOf('integration.ff').filter((i) => mid.doneOf(i.op) === null);
  assert.equal(open.length, 1, 'page-id\'s ff intent is open');
  const approval = mid.unit(unitId('page-id')).approval;
  assert.ok(approval !== null, 'dev.5 recorded page-id\'s approval');
  assert.equal('obligationRevs' in approval.fingerprint, false, 'a dev.5 fingerprint has no obligationRevs');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, []);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.equal(f.calls.length, SMOKE_CALLS, 'no judgment, no build: the smoke only');
  assert.deepEqual(factsOf(f.after, 'judgment-inputs'), []);
  assert.deepEqual(outcomesOf(f.after, 'page-id'), ['ff:published', 'snapshot:published'], 'the recovered ff published, then the snapshot');
  const done = f.view.doneOf(open[0]!.op);
  assert.ok(done !== null && done.kind === 'integration.ff');
  assert.equal(canonicalJson(f.view.unit(unitId('page-id')).approval?.fingerprint), canonicalJson(approval.fingerprint), 'the approval is read as dev.5 wrote it');
});

test('upgrade.dev5-plan-check-answer: dev.5 crashed after page-id\'s plan-check result; HEAD consumes the answer without visionConflict (read as none) and builds, with no new plan-check', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck], []);
  await crashPrevious(p, { label: 'spawn.after-result', occurrence: 1, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  assert.deepEqual(outcomesOf(journalOf(p).events, 'page-id'), [], 'dev.5 recorded no outcome for page-id');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.build, c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(f.calls.slice(SMOKE_CALLS).map((call) => call.as), ['codex', 'claude'], 'the build and the gate, and no plan-check call');
  assert.equal(outcomesOf(f.after, 'page-id')[0], 'plan-check:approve', 'HEAD recorded the dev.5 answer\'s outcome');
  assert.ok(defaulted(p, f.report.generation!).has('planCheck.visionConflict'));
  assert.deepEqual(factsOf(f.after, 'finding-opened'), [], 'no vision-conflict finding');
});

/** Replaces the plan's `direction`, as the architect would. */
const newDirection = (l: Layout): void =>
  editJson<{ direction: string }>(l.plan, (plan) => ({ ...plan, direction: `${plan.direction} Page identifiers are stable across releases.` }));

/** The queued command file's bytes. */
const commandBytes = (p: Phase1, id: string): Buffer => readFileSync(incomingPath(absPath(p.l.runDir), commandId(id)));

test('upgrade.dev5-apply-queued: an apply dev.5\'s CLI queues on HEAD\'s running arc is applied as revision 2 under the legacy interpretation, its bytes unchanged', T, async () => {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle. The edit is made
  // on the running arc, so HEAD's start finds the files in force and the revision is the command's.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
  let id = '';
  let queued: Buffer | null = null;
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      const apply = await p.cli(['apply', ...p.run]);
      assert.equal(apply.code, 0, apply.stderr);
      id = (JSON.parse(apply.stdout) as { command: string }).command;
      queued = commandBytes(p, id);
      const receipt = await until(`the dev.5 apply ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
      assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  assert.deepEqual([fact.rev, fact.command, fact.changes], [2, id, [{ type: 'plan-field', field: 'direction' }]]);
  assert.ok(queued !== null && commandBytes(p, id).equals(queued), 'the dev.5 command file is never rewritten');
  assert.ok(defaulted(p, f.report.generation!).has('apply.manifest'));
});

test('upgrade.dev5-apply-open: dev.5 crashed with the architect\'s apply open past its revision; HEAD\'s start leaves the files to it, recovery finishes it, then re-opens page-id, which merges on its rev 2', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, ESCALATE, ESCALATE], []);
  let id = '';
  await crashPrevious(p, { label: 'command.apply.after-effect', occurrence: 1 }, async () => {
    await parkedAtPlanCheck(p);
    const apply = await p.cli(['apply', ...p.run]);
    assert.equal(apply.code, 0, apply.stderr);
    id = (JSON.parse(apply.stdout) as { command: string }).command;
  });
  const mid = journalOf(p).view;
  const open = mid.opsOf('command.apply').filter((i) => mid.doneOf(i.op) === null);
  assert.deepEqual(open.map((i) => i.expect.command), [id], 'the apply\'s op is open');
  assert.deepEqual([mid.planApplied()?.rev, mid.planApplied()?.command], [2, id], 'dev.5 committed its revision');
  assert.equal(terminalReceipt(absPath(p.l.runDir), commandId(id)), null, 'and wrote no receipt');
  const queued = commandBytes(p, id);
  const reopen = await p.cli(['resume', 'page-id', ...p.run]);
  assert.equal(reopen.code, 0, reopen.stderr);

  // HEAD's CLI and fakes directly: the M1 driver stops a run it sees parked, and page-id is parked until the reopen.
  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, headFakeSteps({ steps: [c.pageId.planCheck, c.pageId.build, c.pageId.gate] }, 'default'), async () => {});
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.equal(terminalReceipt(absPath(p.l.runDir), commandId(id))?.state, 'applied');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD recorded no revision: the start left the files to the open command');
  assert.ok(r.view.doneOf(open[0]!.op) !== null, 'recovery finished the dev.5 command\'s op');
  assert.ok(commandBytes(p, id).equals(queued));
  const u = r.view.unit(unitId('page-id'));
  assert.deepEqual([u.reopened?.specRev, u.spec?.rev], [2, 2], 'page-id re-opened and merged on rev 2');
  assert.deepEqual(r.view.needsUser().map((n) => [n.blocking, n.ack !== null]), [[true, true]], 'the park\'s needs-user, acknowledged by the reopen');
  assert.deepEqual(factsOf(r.after, 'stage-outcome').filter((o) => o.class === 'park' || o.class === 'stop'), [], 'HEAD parked or stopped no unit');
});

/** The repo config's non-default binding: `efficient` (the build seats under `default`) on another Codex triple. */
const EFFICIENT = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' } as const;

test('upgrade.dev5-spend-by-model: dev.5\'s revision is adopted with its routing provenance reconstructed from the repo\'s class binding, and status attributes every build to the bound model', T, async () => {
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    writeFileSync(join(l.repo, '.roadmap', 'config.json'), `${JSON.stringify({ routing: { classes: { efficient: EFFICIENT } } }, null, 2)}\n`);
    git(l.repo, 'commit', '--quiet', '--all', '--message', 'bind efficient');
    git(l.repo, 'branch', '--force', 'integration', 'main');
    const baseline = git(l.repo, 'rev-parse', 'main');
    editJson<{ baseline: string }>(l.plan, (plan) => ({ ...plan, baseline }));
  });
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  // check.ts predates routing provenance: its no-model-ids scan counts the adoption record, which is routing
  // configuration (CLAUDE.md: model ids appear only there). Every hit must be in that record.
  assertFinished(f, ['no-model-ids']);
  const hits = f.check.criteria.find((c) => c.name === 'no-model-ids')!.detail.split('; ');
  assert.ok(hits.every((h) => /^gpt-5\.6-sol in (refs\/roadmap\/[^:]+:)?routing-provenance\/1\.json$/.test(h)), hits.join('; '));
  const adopted = JSON.parse(readFileSync(join(p.l.runDir, 'routing-provenance', '1.json'), 'utf8')) as { kind: string; provenance: { repoConfig: { classes: object } }; matched: unknown[] };
  assert.equal(adopted.kind, 'reconstructed');
  assert.deepEqual(adopted.provenance.repoConfig.classes, { efficient: EFFICIENT });
  assert.ok(adopted.matched.length > 0, 'the reconstruction resolves the routing revs dev.5 recorded');
  const spend = f.report.status.spend.byModel;
  assert.deepEqual(spend.unresolvedRevs, []);
  const models = new Map(spend.models.map((m) => [m.model, m.calls] as const));
  assert.equal(models.get('gpt-5.6-sol'), 3, 'slug\'s build and page-id\'s stopped one (dev.5), and page-id\'s resumed build (HEAD)');
  assert.equal(models.has('gpt-5.6-luna'), false, 'never the default efficient model');
});

/**
 * page-id's lane waits at `marker` (writing `<marker>.reached`) until `<marker>.release` exists, then runs its test:
 * the architect acts on HEAD's running arc meanwhile.
 */
function holdLane(l: Layout, marker: string): void {
  editJson<{ lanes: { argv: readonly string[] }[] }>(join(l.input, 'page-id.json'), (spec) => ({
    ...spec,
    lanes: spec.lanes.map((lane) => ({
      ...lane,
      argv: ['/bin/sh', '-c', '[ -e "$1.release" ] || { : > "$1.reached"; while [ ! -e "$1.release" ]; do sleep 0.2; done; }; exec node --test test/page-id.test.js', 'lane', marker],
    })),
  }));
}

/** Submits `args` through HEAD's CLI and waits for the command's terminal receipt; returns the command id. */
async function submitOnHead(p: Phase1, args: readonly string[]): Promise<string> {
  const out = await headCli(p, [...args, ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const id = (JSON.parse(out.stdout) as { command: string }).command;
  const receipt = await until(`command ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
  return id;
}

const RULING = 'C-3';
const RULING_TEXT = 'Every page identifier is built from slugify.';

test('upgrade.rule-on-dev5-arc: `roadmap rule` lands on a dev.5 revision: the live ledger\'s preimage kept, constraints.md published, the files written back; the arc then merges', T, async () => {
  let marker = '';
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    marker = join(l.dir, 'page-id-lane');
    holdLane(l, marker);
  });
  const ledger = join(p.l.input, 'rulings.md');
  const dev5Ledger = readFileSync(ledger);
  let id = '';
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('page-id waits at its lane on HEAD', PHASE_MS, () => (existsSync(`${marker}.reached`) ? true : null));
      const tip = git(p.l.repo, 'rev-parse', 'integration');
      const record = {
        schema: 'roadmap/ruling-m3', id: RULING, statement: RULING_TEXT, kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review', supersedes: [], condition: null,
        docRefs: [{ path: 'ARCHITECTURE.md', anchor: '#architecture', quotedText: 'A tiny library of pure string and number helpers.', relation: 'consistent' }],
        contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
        // A dev.5 revision in force: the live ledger, no obligations and no vision.
        consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: bytesSha256(dev5Ledger), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
      };
      const file = join(p.dir, 'C-3.json');
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      id = await submitOnHead(p, ['rule', file]);
      writeFileSync(`${marker}.release`, '');
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  const written = readFileSync(ledger);
  assert.equal(written.toString('utf8'), `${dev5Ledger.toString('utf8')}${RULING} — ${RULING_TEXT}\n`, 'the live ledger written back');
  assert.deepEqual([fact.rev, fact.command, fact.source, fact.rulingsSha256, fact.publication?.pub], [2, id, { type: 'command', command: id }, bytesSha256(written), 'docs-1']);
  assert.ok(existsSync(join(`${ledger}.d`, `${RULING}.json`)), 'its sidecar written beside the ledger');
  const preimage = JSON.parse(readFileSync(join(p.l.runDir, 'commands', 'rule-preimages', `${id}.json`), 'utf8')) as unknown;
  assert.deepEqual(preimage, { ledgerSha256: bytesSha256(dev5Ledger) }, 'the dev.5 ledger\'s hash, kept before the commit');
  assert.match(git(p.l.repo, 'show', `integration:.roadmap/constraints.md`), new RegExp(`${RULING} — ${RULING_TEXT}`), 'constraints.md published');
  assert.ok(defaulted(p, f.report.generation!).has('rulings.live'));
});


const CONSTRAINTS = '.roadmap/constraints.md';

test('upgrade.dev5-roadmap-diff-branch: a dev.5-approved branch editing .roadmap/constraints.md reaches candidate admission on HEAD and publishes under dev.5\'s transient rules', T, async () => {
  const c = clean();
  let hold = '';
  let edited = '';
  // page-id's build also edits the in-tree ledger rendering, an entry dev.5's transient check allows.
  const withConstraints = (l: Layout): readonly M1Step[] => {
    edited = `${readFileSync(join(l.repo, CONSTRAINTS), 'utf8')}C-3 — (proposed) Page identifiers are ASCII.\n`;
    const build = { ...c.pageId.build, acts: c.pageId.build.acts.map((a) => (a.type === 'commit' ? { ...a, files: { ...a.files, [CONSTRAINTS]: edited } } : a)) };
    return [...c.slug, c.pageId.planCheck, build, c.pageId.gate];
  };
  const p = await preparePrevious(withConstraints, [], (l) => {
    hold = join(l.dir, 'candidate-hold');
    // The suite waits on page-id's candidate (the only one holding src/page-id.js) until released.
    editJson<{ suite: { lanes: { argv: readonly string[] }[] } }>(l.plan, (plan) => ({
      ...plan,
      suite: {
        lanes: plan.suite.lanes.map((lane) => ({
          ...lane,
          argv: ['/bin/sh', '-c', '{ [ ! -e src/page-id.js ] || [ -e "$1.release" ]; } || { : > "$1.reached"; while [ ! -e "$1.release" ]; do sleep 0.2; done; }; exec npm test', 'suite', hold],
        })),
      },
    }));
  });
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id\'s candidate waits in its suite', PHASE_MS, () => (existsSync(`${hold}.reached`) ? true : null));
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['candidate', 'held', 'interrupted']);
  assert.ok(held.approval !== null, 'dev.5 approved the branch');
  const dispatch = mid.dispatchOf(unitId('page-id'));
  assert.ok(dispatch !== null && dispatch.transientRules === undefined, 'dispatched by dev.5');
  // The branch's diff is allowed by dev.5's rules only.
  const scopeRules = { evidenceGlobs: [], scope: dispatch.scope };
  assert.deepEqual(transientViolations({ kind: 'dev5', ...scopeRules }, [repoPath(CONSTRAINTS)]), []);
  assert.deepEqual(transientViolations({ kind: 'm3', ...scopeRules }, [repoPath(CONSTRAINTS)]).map((v) => v.rule), ['roadmap-dir']);
  writeFileSync(`${hold}.release`, '');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, []);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.equal(f.calls.length, SMOKE_CALLS, 'no judgment: dev.5\'s approval stands');
  assert.deepEqual(outcomesOf(f.after, 'page-id'), ['candidate:green', 'ff:published', 'snapshot:published']);
  assert.equal(git(p.l.repo, 'show', `integration:${CONSTRAINTS}`), edited.trimEnd(), 'published with the branch\'s .roadmap/ edit');
  assert.ok(defaulted(p, f.report.generation!).has('dispatch.transientRules'));
});

/** The arc whose released residue pairs fill the host index to the compaction threshold (COMPACT_THRESHOLD). */
const FILLER = arcId('upgrade-filler');
const FILLERS = 64;

test('upgrade.compact-with-dev5-retry: dev.5\'s retry crashed after its disposition; HEAD\'s start compacts the index, keeping that pair byte for byte, and recovery releases it', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], [], (l) => {
    // The resource's teardown fails once: the first release of `scratch` leaves a residue.
    type Decl = { name: string; teardown: { argv: readonly string[] } };
    editJson<{ resources: Decl[] }>(l.plan, (plan) => ({
      ...plan,
      resources: plan.resources.map((r) => ({
        ...r,
        teardown: { ...r.teardown, argv: ['/bin/sh', '-c', 'if [ -e "$1/teardown-fails-once" ]; then rm "$1/teardown-fails-once"; exit 1; fi; rm -f "$1/scratch.owner" && rm -rf "$1/scratch"', 'teardown', l.resource] },
      })),
    }));
    writeFileSync(join(l.resource, 'teardown-fails-once'), '');
  });
  await crashPrevious(p, { label: 'retry.after-disposition', occurrence: 1 });
  const scratch = resourceName(RESOURCE);
  const mid = journalOf(p).view;
  const held = mid.resources().get(scratch)?.status;
  assert.ok(held !== undefined && held.state === 'cleaning' && held.holder.type === 'retry', `scratch is cleaning under the retry: ${JSON.stringify(held)}`);
  const host = absPath(p.host);
  const dev5Pair = readResidues(host).map((l) => canonicalJson(bodyOf(l)));
  assert.equal(dev5Pair.length, 2, 'the residue and its cleaned disposition');

  // Another arc's released pairs, its log readable (an empty one) in the repo's runtime dir.
  const fillerRunDir = absPath(join(p.l.repo, '.git', 'roadmap-runtime', FILLER));
  mkdirSync(fillerRunDir, { recursive: true });
  openJournal(fillerRunDir, FILLER).close();
  for (let i = 1; i <= FILLERS; i++) {
    const key = { arc: FILLER, unit: unitId('filler'), inv: invocationId(opId(FILLER, i), 1), resource: resourceName(`filler${i}`) };
    recordResidue(host, { type: 'residue', key, teardown: { argv: ['true'], cwd: absPath('/tmp'), env: {} }, label: `filler ${i}` });
    recordDisposition(host, { type: 'disposition', key, disposition: 'cleaned', by: { arc: FILLER, inv: invocationId(opId(FILLER, 1000 + i), 1) } });
  }
  const before = readFileSync(join(p.host, 'residues.jsonl'));

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, remainingSteps(p, c));
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const archives = readdirSync(p.host).filter((n) => RESIDUE_ARCHIVE.test(n));
  assert.equal(archives.length, 1, 'HEAD\'s start compacted the index once');
  assert.ok(readFileSync(join(p.host, archives[0]!)).equals(before), 'the archive is the index as it stood, byte for byte');
  assert.deepEqual(readResidues(host).map((l) => canonicalJson(bodyOf(l))), dev5Pair, 'the fillers went; the dev.5 pair stays unchanged, and no second disposition');
  assert.deepEqual(f.view.resources().get(scratch)?.status, { state: 'free' }, 'recovery released the dev.5 retry');
});

/**
 * The clean scenario's steps the previous release did not reach before it crashed (its calls matched the smoke, then
 * the first steps in order): what HEAD plays.
 */
function remainingSteps(p: Phase1, c: Clean): readonly M1Step[] {
  const all = [...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate];
  const calls = readCalls(join(p.fakeDir, 'scenario.json'));
  assert.deepEqual(calls.map((call) => call.step), calls.map((_, i) => i), 'the previous release\'s calls matched its first steps, in order');
  return all.slice(calls.length - SMOKE_CALLS);
}

// ---------------------------------------------------------------------------------------------------
// HEAD with arc judgments: its CLI and fakes directly (the M1 scenario format has unit roles only)

type HeadRun = Readonly<{ exit: ExitReason; calls: readonly CallRecord[]; after: readonly Event[]; view: JournalView }>;

/** Starts HEAD on the fixture with `steps` behind its fake backends and waits for the run to end; `during` runs alongside. */
async function runOnHead(p: Phase1, steps: readonly Step[], during: () => Promise<void>): Promise<HeadRun> {
  const highWater = journalOf(p).view.highWater();
  const s = writeScenario(join(p.dir, 'fake-head'), steps);
  const env = { ...process.env, PATH: `${s.binDir}:${process.env['PATH'] ?? ''}` };
  const start = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'start', '--repo', p.l.repo, '--plan', p.l.plan, '--profile', 'default'], { env, timeoutMs: START_MS });
  assert.equal(start.code, 0, `HEAD start: ${start.stdout} ${start.stderr}`);
  const ready = JSON.parse(start.stdout) as { kind: string; generation: number; supervisor: number };
  assert.equal(ready.kind, 'ready', start.stdout);
  const stat = statOf(ready.supervisor);
  assert.ok(stat !== null);
  const supervisor = { pid: ready.supervisor, start: stat.start };
  await Promise.all([until('HEAD ends the arc', PHASE_MS, () => (isAlive(supervisor) ? null : true)), during()]);
  const line = lastLine(executorLogs(absPath(p.host), ready.generation).out);
  assert.ok(line !== null, 'HEAD\'s executor printed its exit line');
  const calls = readCalls(s.path);
  assert.deepEqual(calls.map((c) => c.step).sort((a, b) => a! - b!), steps.map((_, i) => i), 'HEAD\'s calls matched every step of its scenario');
  const { view, events } = journalOf(p);
  return { exit: JSON.parse(line) as ExitReason, calls, after: events.filter((e) => e.seq > highWater), view };
}

/** The architect's opt-in: one purpose clause, one must-hold obligation witnessed by slug's tests through a node-test lane. */
const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [{ id: 'V-1', kind: 'purpose', text: 'Every page has a stable, readable identifier.', rank: null, state: 'active' }],
};
const SLUG_LANE = {
  id: 'slug-journey', argv: ['node', '--test', 'test/slug.test.js'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast',
  resources: [], evidenceGlobs: [], reporter: 'node-test',
} as const;
const SLUG_WITNESS = { lane: SLUG_LANE.id, testIds: ['slugify never starts or ends with a hyphen (A2)'] };

function obligations(): unknown {
  const empty = { schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when page-id ships', lanes: [SLUG_LANE], obligations: [], mapping: { paths: [] } };
  const laneRev = laneRevOf(parseObligations(empty).lanes[0]!);
  return {
    ...empty,
    obligations: [{
      id: 'I-1', rev: 1, statement: 'slugify never returns a leading or trailing hyphen.',
      docRef: { path: '.roadmap/contracts/one.md', anchor: '#slugifytext', quotedText: 'The result never starts or ends with' },
      serves: ['V-1'], witness: SLUG_WITNESS, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness: SLUG_WITNESS },
      deliveredBy: [], activation: 'must-hold', contracts: ['.roadmap/contracts/one.md'], state: { type: 'active' },
    }],
  };
}

test('upgrade.opt-in-holistic: an architect apply adds `holistic` to a dev.5 arc mid-run: the baseline job, the brake on page-id\'s candidate, the final audit and a no-op checkpoint, arc-completed', T, async () => {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: head }, 'default'),
    lensStep('audit-1', 'invariants'),
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let id = '';
  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      writeFileSync(join(p.l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
      writeFileSync(join(p.l.input, 'obligations.json'), `${JSON.stringify(obligations(), null, 2)}\n`);
      editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
      id = await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  const [opted, ...more] = factsOf(r.after, 'plan-applied');
  assert.ok(opted !== undefined && more.length === 0);
  assert.equal(opted.command, id);
  assert.ok(opted.changes.some((ch) => ch.type === 'holistic') && opted.visionSha256 !== undefined, JSON.stringify(opted.changes));
  const witnessed = factsOf(r.after, 'witnessed');
  assert.ok(witnessed.some((w) => w.for.type === 'job' && w.for.job.startsWith('baseline-')), 'the baseline job witnessed the arc lanes');
  assert.ok(witnessed.some((w) => w.for.type === 'candidate' && w.for.unit === 'page-id'), 'page-id\'s candidate ran the brake');
  assert.ok(factsOf(r.after, 'audit-ended').some((a) => a.outcome === 'completed' && a.covered.some((cv) => cv.lens === 'invariants')), 'an audit covered the invariants lens');
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => b.outcome), [{ type: 'no-op' }]);
  const [completed] = factsOf(r.after, 'arc-completed');
  assert.ok(completed !== undefined);
  assert.equal(completed.planRev, 2);
  assert.equal(completed.head, git(p.l.repo, 'rev-parse', 'integration'));
  assert.equal(r.view.holistic().on, true);
});
