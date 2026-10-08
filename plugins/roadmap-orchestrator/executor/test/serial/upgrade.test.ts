// Upgrade in place (owner ruling, 2026-09-26): arcs run for days and executor fixes land mid-run, so an
// executor update never forces a new arc. HEAD's executor must adopt an arc the previous release started
// and finish it. The previous release's executor is extracted from git (`git archive PREVIOUS_RELEASE`) and
// run with its own setup, fakes and CLI; the fixture is generated at test time because the runtime state
// it leaves holds absolute paths. Each test runs the M1 fixture (evals/m1) on the previous release to a
// mid-arc point with live state, stops it (or lets it crash at a crash point, below), then finishes the arc on
// HEAD (same repo, run dir and host dir; setup does not re-run; the spec inputs stay as the previous release
// left them), with HEAD's driver, graded by HEAD's check.ts (every criterion passes, and the upgrade forced no
// park and no new session), or, where the story needs arc judgments the M1 scenario format cannot express, with
// HEAD's CLI and fakes directly. The previous release (1.0.0-dev.6, the only one adopted: OR-L4) scheduled a DAG
// and kept every M3 record, so its arcs run on HEAD as they ran on it; an arc it started without the holistic layer
// runs with M2 semantics and no new spend unless the architect opts in.
//
// A crashed previous release: its executor is armed with a crash trigger (src/core/crash.ts), and its supervisor
// is frozen (SIGSTOP) as soon as it is ready, so no generation of the previous release recovers the crash; once
// the executor is gone the supervisor is SIGKILLed. HEAD's start takes over the dead claim of the same arc and its
// recovery finishes what the previous release left open.
//
// The variants:
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
//                              retry) on a calm host (the test waits, bounded, for the previous release's own host
//                              sample to clear: on a busy one it parks it as host pressure), so parked `lane-blocked`
//                              operator-env; its needs-user acknowledged, and the previous release ends the arc.
//                              `resume page-id` (queued through the previous release's CLI) re-runs its lanes on
//                              HEAD, which now pass, and it merges.
//   upgrade.named-cpu-low-host (F18) the plan declares a named resource `cpu`, which both units reserve; `page-id`
//                              stopped mid-build as in stop-mid-build. On a one-CPU host (`taskset -c 0`) HEAD
//                              refuses the DAG arc over the `@cpu` capacity and changes nothing; on this host HEAD
//                              finishes it reserving both the named `cpu` and `@cpu` tokens.
//   upgrade.dev6-apply-queued  stopped mid-build, `page-id` left held; on HEAD's running arc the architect's `apply`
//                              (a new `direction`) queued through the previous release's CLI: HEAD applies it as plan
//                              revision 2, the command's bytes unchanged.
//   upgrade.rule-on-dev6-arc   stopped mid-build; while `page-id` waits at its lane on HEAD, `roadmap rule` lands
//                              C-3 on the previous release's revision: the docs publication of constraints.md, the
//                              write-back; then `page-id` merges.
//   upgrade.compact-with-dev6-retry
//                              (A5a, H1) `slug`'s resource teardown fails once; the previous release's retry crashes
//                              after its `cleaned` disposition (`retry.after-disposition`), the instance still held;
//                              64 released pairs of another arc fill the index. HEAD's start compacts it: the fillers
//                              go, the previous release's pair stays byte for byte; recovery releases it and the arc
//                              merges.
//   upgrade.opt-in-holistic    stopped mid-build, `page-id` left held; on HEAD the architect's
//                              `apply` adds `holistic` (a vision, one must-hold obligation witnessed by a node-test
//                              lane, L = {invariants}), then `resume page-id`: the baseline job, the drift audit and
//                              a no-op checkpoint, the brake on `page-id`'s candidate, the final audit and a no-op
//                              checkpoint, the close-out, `arc-completed`.
//   upgrade.dev6-holistic-completes
//                              (M4a) the arc holistic from its first revision (architecture-doc target, a future
//                              obligation with a docRef, no census), stopped mid-build; HEAD starts it, is stopped,
//                              starts it again (no `holistic-needs-corpus`: a plan is in force), and completes.
//   upgrade.dev6-rebind-inflight
//                              (M4a, OR-L3) a high-risk `page-id` stopped mid-build on build.high (Opus high);
//                              HEAD re-pins at Opus medium, resumes the same session with `--effort medium`, parks
//                              nothing; `status` spend resolves every dev.6 routing rev.
//   upgrade.dev6-rebind-summit-pending
//                              a plan-check escalated, its summit call stopped mid-call; HEAD re-asks it at xhigh.
//   upgrade.dev6-fingerprint-open-ff
//                              `page-id` approved, the ff open at a crash; HEAD compares the fingerprint byte for byte.
//   upgrade.dev6-checkpoint-open
//                              a holistic arc crashed after a checkpoint's call; HEAD consumes the recorded output
//                              (no issues, corpusAmendments or issueIntake) with no new call.
//   upgrade.dev6-config-without-chain
//                              no chain K in the repo config: no chain row applies to the adopted arc.
//   upgrade.dev6-target-kind-fixed
//                              an apply cannot switch the adopted arc to a corpus target (`target-kind-changed`).
//
// M4a rev 3 (N8): each story below runs the previous release once and is shared by the tests named under it.
//   lanes story                `slug`'s lane fails once printing `etcdserver: request timed out` (a host signature only
//                              HEAD's table has), passes its diagnostic rerun (flaky), and `slug` merges after a fix round;
//                              `page-id`'s first lane passes, and the previous release is stopped in its second.
//     upgrade.dev6-lanes-readback-stable
//                              HEAD's `status` reads the unstamped run on the frozen dev.6 table: flaky, not host-suspected,
//                              no red.json.
//     upgrade.dev6-arc-new-lanes-stamped
//                              HEAD's lane runs stamp `redRev` (spec lanes: and `identity`); its red one writes red.json.
//     upgrade.dev6-paused-lanes-rerun
//                              HEAD runs page-id's passed lane again at the same commit: no lane-reused (OI-15).
//   answer stories             the previous release crashes after a call's result, before its stage outcome:
//                              `page-id`'s build (no `experiments`); in a holistic arc with `page-id` at risk high,
//                              `slug`'s plan-check.
//     upgrade.dev6-completed-unrecorded-answers
//                              HEAD consumes both answers with no new call; the build reads `experiments: []`.
//     upgrade.dev6-plan-without-rev3-fields
//                              (the plan-check story, LR-h) plan-check `uniform`, so `page-id`'s frontier builder gets a
//                              plan-check call and one build call (no assess); no witness check, no smoke; priority normal.
//   observation story          a holistic arc; the previous release witnessed `page-id`'s candidate and crashed at its ff.
//     upgrade.dev6-uncertified-observation-reruns
//                              HEAD's final audit needs that observation key and runs the lane again (no certificate).
//   repair stories             a holistic arc with the vacuity lens: the final audit opens F-1 with a mutant, its
//                              checkpoint bundles an admit of a repair unit, applied (revision 2); the repair's reproduce is
//                              cut short in its `mutant.apply`, or in its mutant spawn. HEAD's start needs the architect's
//                              files synced to the plan in force first (`roadmap inputs export`); the repair then merges.
//     upgrade.dev6-open-mutant-spawn
//                              the open dev.6 apply and the open dev.6 spawn (each naming `finding`) close on HEAD.
//     upgrade.dev6-bundle-unclassified
//                              the dev.6 bundle reads `unclassified`: no conversion, amendment or debt; status admits,
//                              opportunities and drift empty.
//
// Not covered: a backend parked on a usage limit, the Claude-only profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import type { Event, Fact, IntentOf } from '../../src/core/events.ts';
import { arcId, commandId, invocationId, opId, resourceName, unitId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { type JsonValue, canonicalJson } from '../../src/core/json.ts';
import { type ProcIdentity, RED_FILE, STDERR_FILE } from '../../src/core/records.ts';
import { HOST_SIGNATURES_DEV6, bundleClassesOf, mutantSubjectDefault } from '../../src/core/upgrade.ts';
import { openJournal, readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { EXPORT_FILE } from '../../src/commands/inputs.ts';
import { incomingPath, terminalReceipt } from '../../src/commands/queue.ts';
import type { ExitReason } from '../../src/executor.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { readOwner } from '../../src/host/owner.ts';
import { HOST_SIGNATURES_REV, matchSignatures } from '../../src/host/signatures.ts';
import { RESIDUE_ARCHIVE, bodyOf, readResidues, recordDisposition, recordResidue } from '../../src/host/residues.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { planCheckShapeOf, priorityOf } from '../../src/input/plan.ts';
import { buildOutput } from '../../src/prompts/schemas.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { overCapacity } from '../../src/resources/pool.ts';
import { bytesSha256, loadSpec } from '../../src/spec/spec.ts';
import { CONTINUE_DIRECTIVE } from '../../src/prompts/directives.ts';
import { seatTripleOf } from '../../src/pipeline/dispatch.ts';
import type { LaneFailure } from '../../src/pipeline/failures.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { meterOf } from '../../src/meter.ts';
import { executorLogs, lastLine } from '../../src/supervisor.ts';
import { corpusTarget } from '../fixtures/corpus-target.ts';
import type { CheckResult } from '../../evals/m1/check.ts';
import type { Report } from '../../evals/m1/driver.ts';
import { type Layout, RESOURCE, UNITS, layout } from '../../evals/m1/layout.ts';
import { type M1Step, fakeSteps as headFakeSteps } from '../../evals/m1/scenario.ts';
import { type TriggerSpec, assertFired, writeTrigger } from '../helpers/crash.ts';
import { checkpointAnswer, checkpointStep, lensStep } from '../helpers/holistic.ts';
import { type Exit, fixture, runUntilExit } from '../helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from '../helpers/reap.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import { type CallRecord, type ScenarioFile, type Step, readCalls, writeScenario } from '../helpers/scenario.ts';

after(assertNoSurvivors);

/**
 * The previous release: its executor starts the arc, HEAD's finishes it. At each release, move it to the
 * last released commit, the merge of the previous release's PR into main. Merges here are merge commits, so
 * a merged branch's shas stay reachable and `git archive` finds them. Now: 1.0.0-dev.6, merged to main as
 * PR #106 (schema version 1). Arcs started before 1.0.0-dev.6 are not adopted (owner ruling OR-L4): each finishes on
 * the executor release it started on.
 */
const PREVIOUS_RELEASE = '0a58349bca2b76a1b40be1204e97f1862764f4d0';
const EXECUTOR_PATH = 'plugins/roadmap-orchestrator/executor';

const EXECUTOR = fileURLToPath(new URL('../../', import.meta.url));
const EVALS = join(EXECUTOR, 'evals', 'm1');
/** The driver's own hard timeout under --fake is 5 min; each phase gets that and a margin. */
const PHASE_MS = 7 * 60_000;
const T = { timeout: 3 * PHASE_MS };
/** How long a test whose premise is a calm host waits for the host to clear (park-adopted), and its timeout. */
const CLEAR_HOST_MS = 20 * 60_000;
const T_CALM = { timeout: 3 * PHASE_MS + CLEAR_HOST_MS };
const CLI_MS = 60_000;
/** `start` waits for readiness itself (240 s by default). */
const START_MS = 300_000;
const POLL_MS = 200;

type PreviousModules = Readonly<{
  fakeSteps: typeof import('../../evals/m1/scenario.ts').fakeSteps;
  readScenario: typeof import('../../evals/m1/scenario.ts').readScenario;
  writeShims: typeof import('../fakes/shim.ts').writeShims;
  /** The previous release's scripted arc judgments (the shapes its reader accepts). */
  holistic: Readonly<{
    lensStep: typeof import('../helpers/holistic.ts').lensStep;
    checkpointStep: typeof import('../helpers/holistic.ts').checkpointStep;
    checkpointAnswer: typeof import('../helpers/holistic.ts').checkpointAnswer;
  }>;
  /** The previous release's host sample and its busy/clear thresholds (the host park's classification). */
  sample: Readonly<{
    readHostSample: typeof import('../../src/host/sample.ts').readHostSample;
    isBusy: (s: ReturnType<typeof import('../../src/host/sample.ts').readHostSample>) => boolean;
    isClear: (s: ReturnType<typeof import('../../src/host/sample.ts').readHostSample>) => boolean;
  }>;
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
  assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"version": "1\.0\.0-dev\.6"/);
  const load = (path: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(root, path)).href);
  const [scenario, shim, sample, holistic] = await Promise.all([load('evals/m1/scenario.ts'), load('test/fakes/shim.ts'), load('src/host/sample.ts'), load('test/helpers/holistic.ts')]);
  previous = {
    root,
    modules: {
      fakeSteps: scenario['fakeSteps'], readScenario: scenario['readScenario'], writeShims: shim['writeShims'],
      holistic: { lensStep: holistic['lensStep'], checkpointStep: holistic['checkpointStep'], checkpointAnswer: holistic['checkpointAnswer'] },
      sample: { readHostSample: sample['readHostSample'], isBusy: sample['isBusy'], isClear: sample['isClear'] },
    } as PreviousModules,
  };
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
  writeFileSync(m1File, JSON.stringify({ steps: (typeof m1 === 'function' ? m1(l) : m1) }));
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

type Finished = Readonly<{
  driver: Exit; report: Report; check: CheckResult; calls: readonly CallRecord[]; events: readonly Event[]; after: readonly Event[]; view: JournalView;
}>;

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
  return { driver, report, check, calls, events, after: events.filter((e) => e.seq > highWater), view };
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
  assertDag(f);
}

/**
 * The previous release's arc is a DAG arc under HEAD too: `scheduling: dag`, and HEAD reserves `@cpu` tokens for the
 * stages it runs (an ff and a snapshot reserve none).
 */
function assertDag(f: Finished): void {
  assert.equal(factsOf(f.events, 'plan-applied')[0]?.scheduling, 'dag');
  const ran = factsOf(f.after, 'stage-outcome').filter((o) => o.stage !== 'ff' && o.stage !== 'snapshot');
  const cpu = f.after.flatMap((e) => (e.type === 'intent' && e.kind === 'resource.transition' ? e.expect.resources.filter((r) => r.startsWith('@cpu#')) : []));
  assert.equal(cpu.length > 0, ran.length > 0, `HEAD reserved @cpu exactly when it ran a stage that takes it: ${JSON.stringify(ran.map((o) => o.stage))}`);
}

/** HEAD's calls after its start-up smoke (Claude, then Codex, under `default`). */
const SMOKE_CALLS = 2;

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
async function stoppedMidBuild(c: Clean, edit?: (l: Layout) => void, queueResume = true, extra: readonly Step[] = []): Promise<Readonly<{ p: Phase1; head: readonly M1Step[] }>> {
  const p = await preparePrevious([...c.slug, c.pageId.planCheck], [midBuild(pageIdFiles(c)), ...extra], edit);
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
// Parks and resources

/** Rewrites a JSON input file of the fixture in place. */
function editJson<T>(path: string, edit: (value: T) => T): void {
  writeFileSync(path, `${JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as T), null, 2)}\n`);
}

/** Waits until the previous release's host sample is clear and not busy; fails naming the last sample if it never is. */
async function clearHost(): Promise<void> {
  const { readHostSample, isBusy, isClear } = previous.modules.sample;
  const deadline = Date.now() + CLEAR_HOST_MS;
  for (;;) {
    const s = readHostSample();
    if (isClear(s) && !isBusy(s)) return;
    if (Date.now() >= deadline) assert.fail(`the host stayed busy for ${CLEAR_HOST_MS / 60_000} min (last sample ${JSON.stringify(s)}): this test needs a calm host`);
    await sleep(5_000);
  }
}

test('upgrade.park-adopted: a unit the previous release parked lane-blocked (operator-env) stays parked on HEAD; `resume page-id` re-runs its lanes, and it merges', T_CALM, async () => {
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
  // The premise: a calm host. The previous release reads a lane killed by a signal on a busy host as host pressure
  // (a retryable host park), so the run starts only once its own sample says the host is clear.
  await clearHost();
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

test('upgrade.named-cpu-low-host: the previous release\'s plan\'s named resource `cpu` is reserved beside @cpu; on a one-CPU host HEAD refuses the DAG arc over capacity and changes nothing', T, async () => {
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
  assert.ok(overCapacity(plan, { cpu: 1 }, specs).length > 0, 'the previous release\'s arc is a DAG arc: over a one-CPU capacity');

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
// The architect acting on HEAD's running arc

/** Replaces the plan's `direction`, as the architect would. */
const newDirection = (l: Layout): void =>
  editJson<{ direction: string }>(l.plan, (plan) => ({ ...plan, direction: `${plan.direction} Page identifiers are stable across releases.` }));

/** The queued command file's bytes. */
const commandBytes = (p: Phase1, id: string): Buffer => readFileSync(incomingPath(absPath(p.l.runDir), commandId(id)));

test('upgrade.dev6-apply-queued: an apply the previous release\'s CLI queues on HEAD\'s running arc is applied as revision 2, its bytes unchanged', T, async () => {
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
      const receipt = await until(`the previous release's apply ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
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
  assert.ok(queued !== null && commandBytes(p, id).equals(queued), 'the previous release\'s command file is never rewritten');
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

test('upgrade.rule-on-dev6-arc: `roadmap rule` lands on the previous release\'s revision: constraints.md published, the files written back; the arc then merges', T, async () => {
  let marker = '';
  const { p, head } = await stoppedMidBuild(clean(), (l) => {
    marker = join(l.dir, 'page-id-lane');
    holdLane(l, marker);
  });
  const ledger = join(p.l.input, 'rulings.md');
  const before = readFileSync(ledger);
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
        // The previous release's revision in force: its ledger, no obligations and no vision.
        consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: bytesSha256(before), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
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
  assert.equal(written.toString('utf8'), `${before.toString('utf8')}${RULING} — ${RULING_TEXT}\n`, 'the live ledger written back');
  assert.deepEqual([fact.rev, fact.command, fact.source, fact.rulingsSha256, fact.publication?.pub], [2, id, { type: 'command', command: id }, bytesSha256(written), 'docs-1']);
  assert.ok(existsSync(join(`${ledger}.d`, `${RULING}.json`)), 'its sidecar written beside the ledger');
  assert.match(git(p.l.repo, 'show', `integration:.roadmap/constraints.md`), new RegExp(`${RULING} — ${RULING_TEXT}`), 'constraints.md published');
});

/** The arc whose released residue pairs fill the host index to the compaction threshold (COMPACT_THRESHOLD). */
const FILLER = arcId('upgrade-filler');
const FILLERS = 64;

test('upgrade.compact-with-dev6-retry: the previous release\'s retry crashed after its disposition; HEAD\'s start compacts the index, keeping that pair byte for byte, and recovery releases it', T, async () => {
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
  const previousPair = readResidues(host).map((l) => canonicalJson(bodyOf(l)));
  assert.equal(previousPair.length, 2, 'the residue and its cleaned disposition');

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
  assert.deepEqual(readResidues(host).map((l) => canonicalJson(bodyOf(l))), previousPair, 'the fillers went; the previous release\'s pair stays unchanged, and no second disposition');
  assert.deepEqual(f.view.resources().get(scratch)?.status, { state: 'free' }, 'recovery released the previous release\'s retry');
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
async function runOnHead(p: Phase1, steps: readonly Step[], during: () => Promise<void>, name = 'fake-head'): Promise<HeadRun> {
  const highWater = journalOf(p).view.highWater();
  const s = writeScenario(join(p.dir, name), steps);
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
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Every page has a stable, readable identifier.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'world', text: 'A reader shares a link to any page and it still works a year later.', rank: null, state: 'active' },
  ],
  questions: [],
};
const SLUG_LANE = {
  id: 'slug-journey', argv: ['node', '--test', 'test/slug.test.js'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast',
  resources: [], evidenceGlobs: [], reporter: 'node-test',
} as const;
const SLUG_WITNESS = { lane: SLUG_LANE.id, testIds: ['slugify never starts or ends with a hyphen (A2)'] };

/** The obligations file: I-1 witnessed through `lane` (slug's journey lane: its id is SLUG_LANE's). */
function obligations(lane: object = SLUG_LANE): unknown {
  const empty = { schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when page-id ships', lanes: [lane], obligations: [], mapping: { paths: [] } };
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

test('upgrade.opt-in-holistic: an architect apply adds `holistic` to the previous release\'s arc mid-run: the baseline job, the drift audit, the brake on page-id\'s candidate, the final audit, no-op checkpoints, arc-completed', T, async () => {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
  // The opt-in revision triggers a drift audit (audit-1, L ∩ {drift, vision} empty: all of L), whose checkpoint is
  // ckpt-1; page-id's publication leaves the final audit (audit-2) and its checkpoint (ckpt-2).
  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: head }, 'default'),
    ...(['1', '2'] as const).flatMap((n) => [lensStep(`audit-${n}`, 'invariants'), checkpointStep(`ckpt-${n}`, checkpointAnswer({ decision: 'no-op' }))]),
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
      editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
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
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-1', { kind: 'no-op' }], ['ckpt-2', { kind: 'no-op' }]]);
  assert.deepEqual(factsOf(r.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-1', ['drift']], ['audit-2', ['final']]]);
  const [completed] = factsOf(r.after, 'arc-completed');
  assert.ok(completed !== undefined);
  assert.equal(completed.planRev, 2);
  assert.equal(completed.head, git(p.l.repo, 'rev-parse', 'integration'));
  assert.equal(r.view.holistic().on, true);
});

// ---------------------------------------------------------------------------------------------------
// M4a: the previous release's holistic arcs (architecture-doc target) on HEAD

/** The architect's holistic plan from the first revision: written before the previous release starts. */
function holisticFromStart(l: Layout, lane: object = SLUG_LANE): void {
  writeFileSync(join(l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
  // slug is not merged yet: the obligation is future, delivered by slug, its witness failing until then (the baseline).
  const base = obligations(lane) as { obligations: object[] };
  const future = { ...base, obligations: base.obligations.map((o) => ({ ...o, activation: 'future', deliveredBy: ['slug'] })) };
  writeFileSync(join(l.input, 'obligations.json'), `${JSON.stringify(future, null, 2)}\n`);
  editJson<object>(l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
}

/** The previous release's scripted judgments for two audits, each followed by a no-op checkpoint (unused ones are never called). */
function previousJudgments(): readonly Step[] {
  const { lensStep: lens, checkpointStep: checkpoint, checkpointAnswer: answer } = previous.modules.holistic;
  return (['1', '2'] as const).flatMap((n) => [lens(`audit-${n}`, 'invariants'), checkpoint(`ckpt-${n}`, answer({ decision: 'no-op' }))]);
}

/** HEAD's start-up smoke, then `steps` (the scenario steps `head` plays by role, via the M1 driver's translation). */
const headSmoke = (): readonly Step[] => headFakeSteps({ steps: [] }, 'default');

test('upgrade.dev6-holistic-completes: a holistic architecture-doc arc stopped mid-arc runs on HEAD, which starts it twice (a stop between) without `holistic-needs-corpus`, with docRef obligations and no census, and completes', T, async () => {
  const c = clean();
  const { p, head } = await stoppedMidBuild(c, holisticFromStart, false, previousJudgments());
  const mid = journalOf(p).view.holistic();
  assert.equal(mid.on, true, 'the previous release ran the arc holistic from its first revision');

  // HEAD's first start: the interrupted build is resumed and held at a barrier; then `stop`.
  const hold: Step = { as: 'codex', expect: { argv: ['exec', 'resume', MID_BUILD_THREAD] }, acts: [{ type: 'barrier', name: 'head-mid', timeoutMs: PHASE_MS }] };
  const scope = scopeOf(p);
  track(scope);
  let first: HeadRun;
  let second: HeadRun;
  try {
    const resume = await p.cli(['resume', ...p.run]);
    assert.equal(resume.code, 0, resume.stderr);
    first = await runOnHead(p, [...headSmoke(), hold], async () => {
      await until('HEAD\'s first start reaches the held build', PHASE_MS, () => (existsSync(join(p.dir, 'fake-head-1', 'head-mid.reached')) ? true : null));
      const stop = await headCli(p, ['stop', ...p.run]);
      assert.equal(stop.code, 0, stop.stderr);
    }, 'fake-head-1');
    assert.notEqual(first.exit.kind, 'complete');
    const again = await headCli(p, ['resume', ...p.run]);
    assert.equal(again.code, 0, again.stderr);
    // The final audit and its checkpoint: the previous release's arc ran no audit before the stop.
    second = await runOnHead(p, [
      ...headFakeSteps({ steps: head }, 'default'),
      lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
    ], async () => {}, 'fake-head-2');
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(second.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.deepEqual(factsOf([...first.after, ...second.after], 'plan-applied'), [], 'HEAD recorded no plan revision');
  assert.deepEqual(factsOf(second.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-1', ['final']]]);
  assert.deepEqual(factsOf(second.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-1', { kind: 'no-op' }]]);
  assert.equal(factsOf(second.after, 'arc-completed').length, 1);
  assert.equal(second.view.holistic().on, true);
  const census = (JSON.parse(readFileSync(join(p.l.input, 'obligations.json'), 'utf8')) as { census?: unknown }).census;
  assert.equal(census, undefined, 'the dev.6 obligations carry no census');
});

test('upgrade.dev6-rebind-inflight: a dev.6 build at build.high stopped mid-build re-pins on HEAD with --effort medium and resumes its session; no routing-changed; spend still resolves', T, async () => {
  const c = clean();
  const sessionStep: Step = {
    as: 'claude', expect: { argv: ['--effort', 'high', '--session-id'] },
    acts: [{ type: 'dirty', files: pageIdFiles(c) }, { type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }],
  };
  const planCheck = c.pageId.planCheck;
  assert.ok(planCheck.role === 'planCheck');
  const planCheckHigh: M1Step = { ...planCheck, answer: { ...(planCheck.answer as object), risk: 'high' } };
  const p = await preparePrevious([...c.slug, planCheckHigh], [sessionStep], (l) => {
    editJson<{ units: { id: string; risk: string }[] }>(l.plan, (plan) => ({ ...plan, units: plan.units.map((u) => (u.id === 'page-id' ? { ...u, risk: 'high' } : u)) }));
  });
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const buildCall = readCalls(join(p.fakeDir, 'scenario.json')).find((call) => call.as === 'claude' && call.argv.includes('--session-id') && call.argv.includes('--permission-mode'));
  assert.ok(buildCall !== undefined, 'the previous release started the claude build');
  const session = buildCall.argv[buildCall.argv.indexOf('--session-id') + 1]!;
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  const pinned = factsOf(journalOf(p).events, 'dispatch').at(-1)!.record;
  assert.deepEqual(seatTripleOf(pinned.implementerSeatRev), { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'dev.6 pinned build.high at Opus high');

  const [smokeClaude, smokeCodex, gate] = headFakeSteps({ steps: [c.pageId.gate] }, 'default');
  const build: Step = {
    as: 'claude', expect: { argv: ['--effort', 'medium', '--resume', session], argvLacks: ['--session-id'], stdinContains: [CONTINUE_DIRECTIVE] },
    acts: [...c.pageId.build.acts, { type: 'emit', value: { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [], experiments: [] } }],
  };
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, [smokeClaude!, smokeCodex!, build, gate!], async () => {});
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  const repinned = factsOf(r.after, 'dispatch');
  assert.equal(repinned.length, 1, 'one re-pin');
  assert.deepEqual(seatTripleOf(repinned[0]!.record.implementerSeatRev), { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(factsOf(r.after, 'stage-outcome').filter((o) => o.outcome === 'routing-changed'), [], 'no routing-changed');
  assert.deepEqual(r.after.flatMap((e) => (e.type === 'intent' && e.kind === 'needsuser.raise' ? [e.expect.id] : [])), [], 'HEAD raised no needs-user');

  const out = await headCli(p, ['status', ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const spend = (JSON.parse(out.stdout) as { spend: { byRole: { calls: number }[]; byModel: { models: { model: string; calls: number }[]; unresolvedRevs: string[] } } }).spend;
  const total = (xs: readonly { calls: number }[]): number => xs.reduce((n, x) => n + x.calls, 0);
  const metered = meterOf(journalOf(p).events);
  assert.deepEqual(spend.byModel.unresolvedRevs, []);
  assert.equal(total(spend.byModel.models), total(metered.bySeat), 'every metered seat call resolves to a model');
  assert.equal(total(spend.byRole), total(metered.byRole));
  const opus = spend.byModel.models.find((m) => m.model === 'claude-opus-5-5');
  assert.ok(opus !== undefined && opus.calls >= 4, `the dev.6 frontier calls are attributed to the current binding: ${JSON.stringify(spend.byModel.models)}`);
});

test('upgrade.dev6-rebind-summit-pending: a dev.6 escalation (summit) judgment stopped mid-call is re-asked on HEAD at Opus xhigh', T, async () => {
  const c = clean();
  // page-id's plan-check escalates on its own seat; the escalation seat's call (summit) is parked at the barrier.
  const p = await preparePrevious([...c.slug, ESCALATE], [midPlanCheck]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const held = journalOf(p).view.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['plan-check', 'held', 'interrupted']);
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [{ ...ESCALATE, answer: { ...(ESCALATE.answer as object), visionConflict: [] } } as M1Step, c.pageId.planCheck, c.pageId.build, c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  // The interrupted plan-check starts over on HEAD: its own seat (frontier, Opus medium) escalates, then the summit seat.
  const [own, summit] = f.calls.slice(SMOKE_CALLS).filter((call) => call.as === 'claude');
  const flags = (argv: readonly string[]): readonly string[] => [argv[argv.indexOf('--model') + 1]!, argv[argv.indexOf('--effort') + 1]!];
  assert.deepEqual(flags(own!.argv), ['claude-opus-5-5', 'medium']);
  assert.deepEqual(flags(summit!.argv), ['claude-opus-5-5', 'xhigh'], 'the escalation seat runs Opus xhigh, never the dev.6 summit model');
});

test('upgrade.dev6-fingerprint-open-ff: dev.6 approved page-id and crashed with its ff open; HEAD\'s recovery compares the dev.6 fingerprint byte for byte and publishes, with no new judgment', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], []);
  await crashPrevious(p, { label: 'ff.act-start', occurrence: 1, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const open = mid.opsOf('integration.ff').filter((i) => mid.doneOf(i.op) === null);
  assert.equal(open.length, 1, 'page-id\'s ff intent is open');
  const approval = mid.unit(unitId('page-id')).approval;
  assert.ok(approval !== null, 'dev.6 recorded page-id\'s approval');
  assert.equal('corpus' in approval.fingerprint, false, 'a dev.6 fingerprint has no corpus pin');

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
  assert.equal(canonicalJson(f.view.unit(unitId('page-id')).approval?.fingerprint), canonicalJson(approval.fingerprint), 'the approval is read as dev.6 wrote it');
});

test('upgrade.dev6-checkpoint-open: dev.6 crashed after a checkpoint\'s call; HEAD consumes the recorded call without issues, corpusAmendments or issueIntake, makes no new call, and completes', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], previousJudgments(), holisticFromStart);
  await crashPrevious(p, { label: 'checkpoint.after-call', occurrence: 1 });
  const mid = journalOf(p).view.holistic();
  const open = mid.checkpoints.filter((k) => k.decided === null);
  assert.equal(open.length, 1, 'the checkpoint is open: inputs recorded, no decision');
  assert.equal('issues' in open[0]!.inputs, false, 'a dev.6 checkpoint-inputs has no issues');

  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, headSmoke(), async () => {});
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  assert.deepEqual(r.calls.map((call) => call.unit), ['smoke', 'smoke'], 'HEAD made no judgment call: the recorded one was consumed');
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [[open[0]!.inputs.job, { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
});

test('upgrade.dev6-config-without-chain: an adopted arc whose repo config names no chain K finishes on HEAD with no chain row applied, and its chain is itself alone', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const config = JSON.parse(readFileSync(join(p.l.repo, '.roadmap', 'config.json'), 'utf8')) as object;
  assert.equal('chain' in config, false, 'the dev.6 fixture\'s repo config names no chain K');
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.equal(f.report.status.chain, null, 'status shows no chain outside a corpus arc');
  const out = await headCli(p, ['chain', 'status', '--repo', p.l.repo]);
  assert.equal(out.code, 0, out.stderr);
  const chain = JSON.parse(out.stdout) as { arcs: { arc: string; previousArc: string | null }[]; k: number | null; unackedStarts: string[] };
  assert.deepEqual([chain.k, chain.arcs.map((a) => [a.arc, a.previousArc])], [null, [[p.l.arc, null]]]);
});

test('upgrade.dev6-target-kind-fixed: an apply cannot switch an adopted architecture-doc arc to a corpus one (target-kind-changed)', T, async () => {
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
  // The architect moves the plan files onto a corpus target (pin, Phase-0 record, anchored obligations, a fake forge's gh).
  const binDir = join(p.dir, 'bin-gh');
  mkdirSync(binDir, { recursive: true });
  corpusTarget({ arc: p.l.arc, repo: p.l.repo, planPath: p.l.plan, runDir: p.l.runDir, hostDir: p.host, binDir, scenarioPath: '', scenarioDir: '' }, { obligations: obligations() as Record<string, unknown>, advances: ['V-1'] });
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  const out = JSON.parse(dry.stdout) as { kind: string; reasons?: string[] };
  assert.equal(out.kind, 'rejected', dry.stdout);
  assert.ok(out.reasons?.some((reason) => reason.startsWith('target-kind-changed')), dry.stdout);
});

// ---------------------------------------------------------------------------------------------------
// M4a rev 3: what the previous release ran and recorded, read and finished by HEAD (LR-g, LR-h, Q20, Q21, OI-15).
// Each story runs the previous release once; the tests that share it each assert their own claim.

/** Memoises a story: the first test that needs it runs it, the others read its result. */
function once<T>(story: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => (running ??= story());
}

const spawnsOf = (events: readonly Event[]): readonly IntentOf<'proc.spawn'>[] =>
  events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' ? [e] : []));
/** The spec lane spawns among `events`, in log order. */
const specLaneSpawns = (events: readonly Event[]): readonly IntentOf<'proc.spawn'>[] =>
  spawnsOf(events).filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'spec');
/** A lane spawn as `unit/lane`, a journey spawn as its lane. */
const laneOf = (i: IntentOf<'proc.spawn'>): string => {
  const s = i.expect.subject;
  assert.ok(s.purpose === 'lane' || s.purpose === 'journey', `${i.op} spawned a ${s.purpose}`);
  return s.purpose === 'lane' ? `${s.unit}/${s.lane}` : s.lane;
};
const invOf = (i: IntentOf<'proc.spawn'>) => invocationId(i.op, i.ordinal);

/** Every `red.json` under the run dir, relative to it. */
const redFiles = (p: Phase1): readonly string[] =>
  readdirSync(p.l.runDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(`/${RED_FILE}`)).sort();

type StatusOut = Readonly<{ units: readonly Readonly<{ unit: string; failures: readonly LaneFailure[] }>[] }>;
async function statusOn(p: Phase1): Promise<StatusOut> {
  const out = await headCli(p, ['status', ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout) as StatusOut;
}
/** A unit's `status` lane failures as `[lane, class, hostSuspected]`. */
const failuresIn = (s: StatusOut, unit: string): readonly (readonly [string, string, unknown])[] =>
  (s.units.find((u) => u.unit === unit)?.failures ?? []).map((f) => [f.lane, f.class, f.hostSuspected] as const);

/** The files a scenario build step commits. */
function committed(step: M1Step | undefined): Readonly<Record<string, string>> {
  assert.ok(step !== undefined && step.role === 'build');
  const files = step.acts.flatMap((a) => (a.type === 'commit' ? [a.files] : []))[0];
  assert.ok(files !== undefined);
  return files as Readonly<Record<string, string>>;
}

/** A fix round (Codex resumes the unit's thread) committing `path` of `files` with one more line. */
const fixRound = (files: Readonly<Record<string, string>>, path: string): M1Step => ({
  role: 'build', round: 'resume', acts: [{ type: 'commit', message: `fix round: ${path}`, files: { [path]: `${files[path]!}// fix round\n` } }],
});

const ETCD = 'etcdserver: request timed out';

type LanesStory = Readonly<{ p: Phase1; f: Finished; before: readonly Event[]; status: StatusOut }>;

/**
 * The lanes story (no holistic layer). On the previous release: `slug`'s lane fails once printing a host signature only
 * HEAD's table has (etcd); its diagnostic rerun passes, so it is flaky, charged a fix round, and `slug` merges. `page-id`'s
 * first lane passes and its second (`page-id-tail`) waits at a marker, where the previous release is stopped. On HEAD:
 * `page-id`'s series runs again; `page-id-tail` fails once without a signature (a diagnostic rerun, which passes), a fix
 * round, then green, and the arc merges.
 */
const lanesStory = once(async (): Promise<LanesStory> => {
  const c = clean();
  let tail = '';
  const p = await preparePrevious([c.slug[0]!, c.slug[1]!, fixRound(committed(c.slug[1]), 'src/slug.js'), c.slug[2]!, c.pageId.planCheck, c.pageId.build], [], (l) => {
    const marker = join(l.dir, 'slug-red-once');
    editJson<{ lanes: { argv: readonly string[] }[] }>(join(l.input, 'slug.json'), (spec) => ({
      ...spec,
      lanes: spec.lanes.map((lane) => ({ ...lane, argv: ['/bin/sh', '-c', `[ -e "$1" ] && exec node --test test/slug.test.js; : > "$1"; echo "Error: ${ETCD}" >&2; exit 1`, 'lane', marker] })),
    }));
    tail = join(l.dir, 'page-id-tail');
    editJson<{ lanes: { id: string; argv: readonly string[] }[] }>(join(l.input, 'page-id.json'), (spec) => ({
      ...spec,
      lanes: [...spec.lanes, {
        ...spec.lanes[0]!, id: 'page-id-tail',
        argv: ['/bin/sh', '-c', [
          // Waits until released (the previous release is stopped meanwhile), then fails once without a host signature.
          '[ -e "$1.release" ] || { : > "$1.reached"; while [ ! -e "$1.release" ]; do sleep 0.2; done; }',
          '[ -e "$1.failed" ] || { : > "$1.failed"; echo "page-id-tail: the empty slug is not page" >&2; exit 1; }',
          'exec node --test test/page-id.test.js',
        ].join('\n'), 'lane', tail],
      }],
    }));
  });
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id-tail runs on the previous release', PHASE_MS, () => (existsSync(`${tail}.reached`) ? true : null));
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const held = mid.unit(unitId('page-id'));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['lanes', 'held', 'interrupted']);
  const before = journalOf(p).events;
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);
  writeFileSync(`${tail}.release`, '');

  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [fixRound(pageIdFiles(c), 'src/page-id.js'), c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  return { p, f, before, status: await statusOn(p) };
});

test('upgrade.dev6-lanes-readback-stable: a dev.6 diagnostic rerun whose output matches a host signature added since reads back on HEAD as dev.6 recorded it (frozen table, no red.json)', T, async () => {
  const { p, before, status } = await lanesStory();
  const [red, rerun, ...more] = specLaneSpawns(before).filter((i) => laneOf(i) === 'slug/slug');
  assert.ok(red !== undefined && rerun !== undefined && more.length === 1, 'slug\'s lane: the red run, its diagnostic rerun, then the fix round\'s run');
  assert.equal('redRev' in red.expect.subject, false, 'the previous release stamps no redRev');
  const stderr = readFileSync(join(invocationDir(absPath(p.l.runDir), invOf(red)), STDERR_FILE), 'utf8');
  assert.deepEqual(matchSignatures(stderr), ['etcd-request-timeout'], 'HEAD\'s table reads the red run as host-caused');
  assert.deepEqual(matchSignatures(stderr, HOST_SIGNATURES_DEV6), [], 'the frozen dev.6 table does not');
  assert.deepEqual(redFiles(p).filter((f) => f.includes('slug')), [], 'no red.json for the unstamped run');
  assert.deepEqual(failuresIn(status, 'slug'), [['slug', 'flaky', null]], 'flaky, not host-suspected: as the previous release classified it');
});

test('upgrade.dev6-arc-new-lanes-stamped: an adopted dev.6 arc\'s new lane runs stamp redRev (spec lanes: and identity), and a red one writes red.json; its dev.6 runs stay on the frozen table', T, async () => {
  const { p, f, before, status } = await lanesStory();
  assert.ok(specLaneSpawns(before).every((i) => !('redRev' in i.expect.subject) && !('identity' in i.expect.subject)), 'the previous release\'s lane runs are unstamped');
  const head = spawnsOf(f.after).filter((i) => i.expect.subject.purpose === 'lane' || i.expect.subject.purpose === 'journey');
  assert.ok(head.length > 0);
  for (const i of head) {
    const s = i.expect.subject;
    assert.ok((s.purpose === 'lane' || s.purpose === 'journey') && s.redRev === HOST_SIGNATURES_REV, `${laneOf(i)} is stamped with redRev ${HOST_SIGNATURES_REV}`);
    if (s.purpose === 'lane' && s.set === 'spec') assert.ok(s.identity !== undefined, `${laneOf(i)} carries its reuse identity`);
  }
  const [file, ...others] = redFiles(p);
  assert.ok(file !== undefined && others.length === 0, `one red.json, HEAD's red run's: ${JSON.stringify(redFiles(p))}`);
  assert.match(file, /page-id-tail/);
  const red = JSON.parse(readFileSync(join(p.l.runDir, file), 'utf8')) as { class: unknown; redRev: number };
  assert.deepEqual([red.class, red.redRev], [{ kind: 'diagnostic' }, HOST_SIGNATURES_REV]);
  assert.deepEqual(failuresIn(status, 'page-id'), [['page-id-tail', 'flaky', null]]);
  assert.deepEqual(failuresIn(status, 'slug'), [['slug', 'flaky', null]], 'the dev.6 run still reads on the frozen table');
});

test('upgrade.dev6-paused-lanes-rerun: a dev.6 series stopped after a passing lane runs that lane again on HEAD (no identity, no certificate: never reused; no lane-reused)', T, async () => {
  const { f, before } = await lanesStory();
  const pageIdOn = (events: readonly Event[]) => specLaneSpawns(events).filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.unit === 'page-id');
  const [passed, ...stopped] = pageIdOn(before);
  assert.deepEqual([passed, ...stopped].map((i) => i && laneOf(i)), ['page-id/page-id', 'page-id/page-id-tail'], 'the previous release ran page-id\'s first lane through (the series went on), then was stopped in the second');
  assert.ok(passed !== undefined && passed.expect.subject.purpose === 'lane');
  assert.equal('identity' in passed.expect.subject, false);
  assert.deepEqual(factsOf(before, 'series-certified'), [], 'the previous release certified no series');
  const [first] = pageIdOn(f.after);
  assert.ok(first !== undefined && first.expect.subject.purpose === 'lane');
  assert.deepEqual([laneOf(first), first.expect.subject.at], ['page-id/page-id', passed.expect.subject.at], 'HEAD ran the passed lane again, at the same commit');
  assert.deepEqual(factsOf(f.after, 'lane-reused'), [], 'nothing reused');
});

/**
 * The spawn of `unit`'s `stage` the previous release's crash left open (its intent, no done) and its completed result:
 * the answer was written, the stage outcome was not.
 */
function completedUnrecorded(p: Phase1, unit: string, stage: string): Readonly<{ spawn: IntentOf<'proc.spawn'>; value: unknown }> {
  const { view, events } = journalOf(p);
  const open = spawnsOf(events).filter((i) => view.doneOf(i.op) === null);
  const [spawn, ...more] = open;
  assert.ok(spawn !== undefined && more.length === 0 && spawn.parent.type === 'stage', `one spawn open: ${JSON.stringify(open.map((i) => i.parent))}`);
  assert.deepEqual([spawn.parent.unit, spawn.parent.stage], [unit, stage], `the crash left ${unit}'s ${stage} call open`);
  assert.equal(outcomesOf(events, unit).some((o) => o.startsWith(`${stage}:`)), false, `no ${stage} outcome recorded`);
  const result = runnerFiles(invocationDir(absPath(p.l.runDir), invOf(spawn)), invOf(spawn)).read('result.json');
  assert.ok(result !== null && result.type === 'backend' && result.outcome.kind === 'success', `the call completed: ${JSON.stringify(result)}`);
  return { spawn, value: result.outcome.value };
}

/** HEAD's calls after its smoke as `unit:role`, a judgment (read-only tools) `judge`, an implementer call `build`. */
const callsOf = (calls: readonly CallRecord[]): readonly string[] =>
  calls.slice(SMOKE_CALLS).map((call) => `${call.unit}:${call.as === 'codex' || call.argv.includes('--permission-mode') ? 'build' : call.lens ?? 'judge'}`);

/** The build story: the previous release crashed after `page-id`'s build answer was written, before its outcome. */
const buildAnswerStory = once(async (): Promise<Readonly<{ p: Phase1; f: Finished; value: unknown }>> => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], []);
  // page-id's spawns: its plan-check, its resource probe, then its build.
  await crashPrevious(p, { label: 'spawn.after-result', occurrence: 3, unit: 'page-id' });
  const { value } = completedUnrecorded(p, 'page-id', 'build');
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  return { p, f, value };
});

function highPlanCheck(c: Clean): M1Step {
  const step = c.pageId.planCheck;
  assert.ok(step.role === 'planCheck');
  return { ...step, answer: { ...(step.answer as object), risk: 'high' } };
}

/** `page-id` at risk high: its build resolves to a frontier (Claude) builder. */
function pageIdHigh(l: Layout): void {
  editJson<{ units: { id: string; risk: string }[] }>(l.plan, (plan) => ({ ...plan, units: plan.units.map((u) => (u.id === 'page-id' ? { ...u, risk: 'high' } : u)) }));
}

type HolisticRun = Readonly<{ p: Phase1; r: HeadRun; before: readonly Event[] }>;

/**
 * The plan-check story: a holistic architecture-doc arc (`holisticFromStart`) whose `page-id` is high risk; the previous
 * release crashed after `slug`'s plan-check answer was written, before its outcome. HEAD consumes it, then runs the arc
 * to completion, `page-id`'s build on a frontier (Claude) seat, then the final audit and a no-op checkpoint.
 */
const planCheckAnswerStory = once(async (): Promise<HolisticRun & Readonly<{ value: unknown }>> => {
  const c = clean();
  const p = await preparePrevious([c.slug[0]!], [], (l) => {
    holisticFromStart(l);
    pageIdHigh(l);
  });
  await crashPrevious(p, { label: 'spawn.after-result', occurrence: 1, unit: 'slug' });
  const { value } = completedUnrecorded(p, 'slug', 'plan-check');
  const before = journalOf(p).events;
  const [smokeClaude, smokeCodex, ...m1] = headFakeSteps({ steps: [c.slug[1]!, c.slug[2]!, highPlanCheck(c)] }, 'default');
  const [, , gate] = headFakeSteps({ steps: [c.pageId.gate] }, 'default');
  const build: Step = {
    as: 'claude', expect: { argv: ['-p', '--permission-mode', '--session-id'], argvLacks: ['--tools', '--resume'] },
    acts: [...c.pageId.build.acts, { type: 'emit', value: { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [], experiments: [] } }],
  };
  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, [smokeClaude!, smokeCodex!, ...m1, build, gate!, lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))], async () => {});
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  return { p, r, before, value };
});

test('upgrade.dev6-completed-unrecorded-answers: a dev.6 build answer and a dev.6 plan-check answer, each completed but unrecorded at a crash, are consumed by HEAD\'s recovery with no new call; the build reads experiments: []', T, async () => {
  const b = await buildAnswerStory();
  assert.equal('experiments' in (b.value as object), false, 'the dev.6 build answer has no experiments');
  assert.deepEqual(buildOutput(b.value as JsonValue, 'build').experiments, [], 'HEAD\'s reader defaults them to none');
  assert.deepEqual(callsOf(b.f.calls), ['page-id:judge'], 'HEAD made no build call: the gate only');
  assert.equal(outcomesOf(b.f.after, 'page-id')[0], 'build:success', 'HEAD recorded the dev.6 answer\'s outcome');

  const pc = await planCheckAnswerStory();
  assert.deepEqual((pc.value as { decision: string }).decision, 'approve');
  const calls = callsOf(pc.r.calls);
  assert.equal(calls[0], 'slug:build', `HEAD made no plan-check call for slug: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter((call) => call.startsWith('slug:')), ['slug:build', 'slug:judge'], 'slug\'s one judgment on HEAD is its gate');
  assert.equal(outcomesOf(pc.r.after, 'slug')[0], 'plan-check:approve', 'HEAD recorded the dev.6 answer\'s outcome');
});

test('upgrade.dev6-plan-without-rev3-fields: an adopted architecture-doc arc runs no witness-check, smoke or assess stage; plan-check uniform (a call for a frontier builder); priority normal', T, async () => {
  const { p, r } = await planCheckAnswerStory();
  const plan = requirePlanInForce(absPath(p.l.runDir), r.view).plan;
  assert.deepEqual([planCheckShapeOf(plan), plan.units.map(priorityOf)], ['uniform', ['normal', 'normal']]);
  assert.equal('knownDefects' in plan, false);
  // page-id (risk high) builds on the frontier seat (Claude): a plan-check call, then one build call, no assess.
  assert.deepEqual(callsOf(r.calls).filter((call) => call.startsWith('page-id:')), ['page-id:judge', 'page-id:build', 'page-id:judge']);
  const pageId = outcomesOf(r.after, 'page-id');
  assert.equal(pageId[0], 'plan-check:approve');
  const rev3 = ['plan-check:in-session', 'build:infeasible', 'build:risk-raised', 'lanes:witnesses-missing', 'lanes:smoke-survived', 'lanes:known-defect'];
  assert.deepEqual(outcomesOf(r.after, 'slug').concat(pageId).filter((o) => rev3.includes(o)), []);
  assert.deepEqual(factsOf(r.after, 'smoke-ran'), [], 'no mutation smoke');
  assert.deepEqual(spawnsOf(r.after).filter((i) => i.expect.subject.purpose === 'mutant'), []);
  const witnessCheck = spawnsOf(r.after).filter((i) => i.expect.subject.purpose === 'journey' && i.parent.type === 'stage' && i.parent.stage === 'lanes');
  assert.deepEqual(witnessCheck, [], 'no witness presence check (a journey series in the lanes stage)');
  assert.deepEqual(factsOf(r.after, 'witnessed').filter((w) => w.for.type === 'smoke'), []);
});

/**
 * The observation story: a holistic architecture-doc arc whose obligation I-1 is mapped from `src/**`, so `page-id`'s
 * candidate selects it; the previous release witnessed that candidate (slug's journey lane on the candidate tree) and
 * crashed at the start of its ff. HEAD's recovery publishes it; the final audit then needs that lane on that same tree.
 * The lane passes no variable (`node` by its path): its environment identity is the same under both releases' fakes,
 * whose PATHs differ, so the observation key HEAD needs is the dev.6 one.
 */
const observationStory = once(async (): Promise<HolisticRun> => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], previousJudgments(), (l) => {
    holisticFromStart(l, { ...SLUG_LANE, argv: [process.execPath, '--test', 'test/slug.test.js'], env: { set: {}, pass: [] } });
    editJson<object>(join(l.input, 'obligations.json'), (o) => ({ ...o, mapping: { paths: [{ pattern: 'src/**', obligations: ['I-1'] }] } }));
  });
  await crashPrevious(p, { label: 'ff.act-start', occurrence: 1, unit: 'page-id' });
  const before = journalOf(p).events;
  const scope = scopeOf(p);
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, [...headSmoke(), lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' }))], async () => {});
  } finally {
    await teardown(scope);
  }
  assert.deepEqual(r.exit, { kind: 'complete', units: UNITS.map((unit) => ({ unit, result: 'merged' })) });
  return { p, r, before };
});

test('upgrade.dev6-uncertified-observation-reruns: a dev.6 candidate\'s witnessed observation has no series-certified fact; HEAD\'s audit on the same tree runs the lane again', T, async () => {
  const { r, before } = await observationStory();
  const keyText = (w: Extract<Fact, { kind: 'witnessed' }>): string => canonicalJson({ treeSha: w.treeSha, lane: w.lane, laneRev: w.laneRev, envId: w.envId });
  const dev6 = factsOf(before, 'witnessed').filter((w) => w.purpose === 'witness' && w.for.type === 'candidate' && w.for.unit === 'page-id');
  assert.equal(dev6.length, 1, 'the previous release witnessed page-id\'s candidate');
  assert.deepEqual(factsOf(before, 'series-certified'), [], 'and certified no series');
  const audit = factsOf(r.after, 'witnessed').filter((w) => w.purpose === 'witness' && w.for.type === 'job' && w.for.job.startsWith('audit-'));
  assert.deepEqual(audit.map(keyText), dev6.map(keyText), 'the audit observed the same key (tree, lane, lane rev, environment)');
  const spawned = new Set(spawnsOf(r.after).map((i) => invOf(i)));
  assert.ok(audit.every((w) => spawned.has(w.inv) && w.inv !== dev6[0]!.inv), 'from a run HEAD spawned, not the dev.6 observation');
});

/** The vacuity lens's mutant: slugify keeps a trailing hyphen its input ends with, which slug's A2 test never feeds it. */
const SLUG_MUTANT = [
  'diff --git a/src/slug.js b/src/slug.js',
  '--- a/src/slug.js',
  '+++ b/src/slug.js',
  '@@ -1,4 +1,5 @@',
  ' /** The URL slug of `text` (.roadmap/contracts/one.md, slugify). */',
  ' export function slugify(text) {',
  "-  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
  "+  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
  "+  return text.endsWith('-') ? `${slug}-` : slug;",
  ' }',
  '',
].join('\n');
const REPAIR = 'repair-1';

/** The repair unit's spec (a vacuity repair of F-1 over I-1): its lane runs slug's tests. */
const REPAIR_SPEC = {
  schema: 'roadmap/spec-m1', unit: REPAIR, rev: 1,
  lanes: [{ id: REPAIR, argv: ['node', '--test', 'test/slug.test.js'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active' }],
  acceptance: [{ id: 'R1', clause: 'The A2 test also checks that an input ending with a hyphen yields no trailing hyphen.', failLoudIfUndelivered: true, state: 'active' }],
  scope: ['test/**'], resources: [], decisions: [], facts: [], cites: { contracts: ['.roadmap/contracts/one.md'], rulings: [] },
  obligations: ['I-1'], repairs: ['F-1'],
};

/** slug's test file with the A2 test strengthened: it kills SLUG_MUTANT. */
function strictSlugTest(c: Clean): string {
  const test = committed(c.slug[1])['test/slug.test.js']!;
  const strict = test.replace("'SLUG-TRIM: no leading or trailing hyphen');", "'SLUG-TRIM: no leading or trailing hyphen');\n  assert.equal(slugify('trailing-'), 'trailing');");
  assert.notEqual(strict, test);
  return strict;
}

type MutantRun = HolisticRun & Readonly<{ status: Readonly<{ admits: readonly unknown[]; opportunities: readonly unknown[]; drift: readonly unknown[] }> }>;

/**
 * The repair story: a holistic architecture-doc arc auditing with the vacuity lens. On the previous release both units
 * merge; the final audit's vacuity lens opens F-1 over I-1 with SLUG_MUTANT; its checkpoint bundles one op, admitting a
 * repair unit (`repair-1`, repairs F-1), which the previous release applies (plan revision 2). The repair starts with
 * `reproduce`, whose mutant the crash `spec` cuts short. On HEAD: the reproduce finishes (reproduced), the repair
 * strengthens the A2 test, its candidate kills the mutant, it merges; then the final audit and a no-op checkpoint.
 */
function mutantStory(spec: TriggerSpec): () => Promise<MutantRun> {
  return once(async () => {
    const c = clean();
    const { lensStep: lens, checkpointStep: checkpoint, checkpointAnswer: answer } = previous.modules.holistic;
    const admit = {
      op: 'admit', unit: { id: REPAIR, risk: 'med', scope: ['test/**'], after: [], origin: 'repair' }, spec: JSON.stringify(REPAIR_SPEC),
      cites: ['V-1'], evidence: ['F-1: I-1\'s witness passes on the mutant'],
    };
    const judgments = [
      lens('audit-1', 'vacuity', [{
        severity: 'P2', obligation: 'I-1', claim: 'I-1\'s witness passes when slugify keeps a trailing hyphen', cause: 'the A2 test never ends its input with a hyphen',
        evidence: [{ path: 'src/slug.js', line: 3 }], mutant: { patch: SLUG_MUTANT, lane: SLUG_LANE.id },
      }]),
      checkpoint('ckpt-1', answer({ decision: 'bundle', ops: [admit] })),
      // The drift audit the bundle's revision triggers runs beside the repair: the crash may come before, during or after
      // its judgments, so the previous release has them too (unused ones are never called).
      lens('audit-2', 'vacuity'), checkpoint('ckpt-2', answer({ decision: 'no-op' })),
    ];
    const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], judgments, (l) => {
      holisticFromStart(l);
      editJson<{ holistic: object }>(l.plan, (plan) => ({ ...plan, holistic: { ...plan.holistic, audit: { lenses: ['vacuity'] } } }));
    });
    await crashPrevious(p, spec);
    const before = journalOf(p).events;
    // The bundle's revision (repair-1 added) is in force but not in the architect's files, which `start` classifies: they
    // are synced from the plan in force first, through the sanctioned recovery (`roadmap inputs export`, I1).
    const exported = join(p.dir, 'inputs-export');
    const exportCli = await headCli(p, ['inputs', 'export', ...p.run, '--out', exported]);
    assert.equal(exportCli.code, 0, `inputs export: ${exportCli.stdout} ${exportCli.stderr}`);
    cpSync(exported, p.l.input, { recursive: true, filter: (src) => basename(src) !== EXPORT_FILE });
    const [, , ...repair] = headFakeSteps({
      steps: [c.pageId.planCheck, { role: 'build', round: 'fresh', acts: [{ type: 'commit', message: 'strengthen the A2 witness', files: { 'test/slug.test.js': strictSlugTest(c) } }] }, c.pageId.gate],
    }, 'default');
    const scope = scopeOf(p);
    let r: HeadRun;
    track(scope);
    try {
      // The drift audit's judgments HEAD makes: those the previous release did not spawn before its crash (one it spawned
      // ran to its end under its own runner, and recovery reads it). Then the final audit, once the repair merged.
      const spawned = (job: string): boolean => spawnsOf(before).some((i) => i.parent.type === 'job' && i.parent.job === job && i.expect.subject.purpose === 'arc-backend');
      const drift = [...(spawned('audit-2') ? [] : [lensStep('audit-2', 'vacuity')]), ...(spawned('ckpt-2') ? [] : [checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' }))])];
      const final = [lensStep('audit-3', 'vacuity'), checkpointStep('ckpt-3', checkpointAnswer({ decision: 'no-op' }))];
      r = await runOnHead(p, [...headSmoke(), ...repair, ...drift, ...final], async () => {});
    } finally {
      await teardown(scope);
    }
    assert.deepEqual(r.exit, { kind: 'complete', units: [...UNITS, REPAIR].map((unit) => ({ unit, result: 'merged' })) });
    const out = await headCli(p, ['status', ...p.run]);
    assert.equal(out.code, 0, out.stderr);
    return { p, r, before, status: JSON.parse(out.stdout) as MutantRun['status'] };
  });
}

/** Cut short in its `mutant.apply` (the worktree made, the patch not applied). */
const applyOpenStory = mutantStory({ label: 'mutant.after-worktree', occurrence: 1 });
/** Cut short in its mutant spawn (the lane ran, its result unwritten). */
const spawnOpenStory = mutantStory({ label: 'spawn.after-runner-exit', occurrence: 1, unit: REPAIR });

const AS_FINDING = { type: 'finding', finding: 'F-1' } as const;

/** The repair merged on HEAD after its reproduce decided `reproduced`, and F-1 resolved. */
function assertRepaired(m: MutantRun): void {
  assert.equal(outcomesOf(m.r.after, REPAIR)[0], 'reproduce:reproduced', JSON.stringify(outcomesOf(m.r.after, REPAIR)));
  assert.equal(m.r.view.holistic().findings.find((f) => f.id === 'F-1')?.state, 'resolved');
}

test('upgrade.dev6-open-mutant-spawn: an open dev.6 mutant.apply and an open dev.6 mutant proc.spawn (each naming `finding`) reconcile on HEAD through the `of: finding` default', T, async () => {
  const a = await applyOpenStory();
  const [apply, ...moreApplies] = a.before.flatMap((e) => (e.type === 'intent' && e.kind === 'mutant.apply' ? [e] : []));
  assert.ok(apply !== undefined && moreApplies.length === 0);
  assert.deepEqual(['finding' in apply.expect, 'of' in apply.expect, mutantSubjectDefault(apply.expect)], [true, false, AS_FINDING], 'the dev.6 intent names its finding');
  assert.equal(journalOf(a.p).view.doneOf(apply.op)?.kind, 'mutant.apply', 'HEAD\'s recovery closed it');
  assert.equal(a.before.some((e) => e.type === 'done' && e.op === apply.op), false, 'the previous release left it open');
  assertRepaired(a);

  const s = await spawnOpenStory();
  const open = spawnsOf(s.before).filter((i) => i.expect.subject.purpose === 'mutant' && !s.before.some((e) => e.type === 'done' && e.op === i.op));
  const [spawn, ...moreSpawns] = open;
  assert.ok(spawn !== undefined && moreSpawns.length === 0 && spawn.expect.subject.purpose === 'mutant', 'the previous release left its mutant spawn open');
  assert.deepEqual(['finding' in spawn.expect.subject, mutantSubjectDefault(spawn.expect.subject)], [true, AS_FINDING], 'the dev.6 subject names its finding');
  assert.equal(journalOf(s.p).view.doneOf(spawn.op)?.kind, 'proc.spawn', 'HEAD\'s recovery closed it');
  assertRepaired(s);
});

test('upgrade.dev6-bundle-unclassified: a dev.6 applied bundle (no admits, no conversions) reads back on HEAD as unclassified: nothing converted or counted; status admits and opportunities empty', T, async () => {
  const { r, before, status } = await applyOpenStory();
  const [bundle, ...more] = before.flatMap((e) => (e.type === 'intent' && e.kind === 'revision.commit' && e.expect.source.type === 'bundle' ? [e.expect.source] : []));
  assert.ok(bundle !== undefined && more.length === 0, 'the previous release applied one bundle');
  assert.deepEqual(['admits' in bundle, 'conversions' in bundle], [false, false]);
  assert.equal(bundleClassesOf(bundle), 'unclassified');
  assert.ok(factsOf(before, 'plan-applied').some((a) => a.rev === 2 && a.changes.some((ch) => ch.type === 'unit-added' && ch.unit === REPAIR)), 'its admit added the repair unit');
  assert.deepEqual(factsOf(r.after, 'corpus-amendment'), [], 'no admit converted to an amendment');
  assert.deepEqual(factsOf(r.after, 'debt-banked'), [], 'no overrun debt');
  assert.deepEqual([status.admits, status.opportunities, status.drift], [[], [], []]);
});
