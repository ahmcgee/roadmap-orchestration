// Upgrade in place (owner ruling, 2026-09-26): arcs run for days and executor fixes land mid-run, so an
// executor update never forces a new arc. HEAD's executor must adopt an arc the previous release started
// and finish it. The previous release's executor is extracted from git (`git archive PREVIOUS_RELEASE`) and
// run with its own setup, fakes and CLI; the fixture is generated at test time because the runtime state
// it leaves holds absolute paths. Each test runs the M1 fixture (evals/m1) on the previous release to a
// mid-arc point with live state, stops it (or lets it crash at a crash point, below), then finishes the arc on
// HEAD (same repo, run dir and host dir; setup does not re-run; the spec inputs stay as the previous release
// left them), with HEAD's driver, graded by HEAD's check.ts (every criterion passes, and the upgrade forced no
// park and no new session), or, where the story needs arc judgments the M1 scenario format cannot express, with
// HEAD's CLI and fakes directly. The previous release (1.0.0-dev.11) schedules a DAG and keeps every M3, M4a and M4b
// record, so its arcs run on HEAD as they ran on it; an arc it started without the holistic layer runs with M2
// semantics and no new spend unless the architect opts in. Its role set, seat table and pressure records are HEAD's,
// so its routing revs stand unchanged, and its applies, re-entries, obligations and in-force inputs are HEAD's shape.
// What it records differently from 1.0.0-dev.12: its judgments ran without the Agent tool and, but for plan-check and
// the checkpoint, without session persistence (a refused answer it left unread takes no repair turn on HEAD, warned);
// it voided an approve whose session had a read refused (`read-denied`, whose retry row HEAD keeps); its gates
// recorded no `diffShown` (read as nothing recorded); and its lens calls attached the dev.11 diff (an audit it left
// between chunks finds the same chunks on HEAD).
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
//   upgrade.apply-queued       stopped mid-build, `page-id` left held; on HEAD's running arc the architect's `apply`
//                              (a new `direction`) queued through the previous release's CLI, its body `expectRev`
//                              with no `base` and no `visionEdit`: HEAD rebases it from the default base and applies
//                              it as plan revision 2, the command's bytes unchanged, the default warned.
//   upgrade.rule-on-adopted-arc
//                              stopped mid-build; while `page-id` waits at its lane on HEAD, `roadmap rule` lands
//                              C-3 on the previous release's revision: the docs publication of constraints.md, nothing
//                              written into the owner's files; then `page-id` merges.
//   upgrade.compact-with-adopted-retry
//                              (A5a, H1) `slug`'s resource teardown fails once; the previous release's retry crashes
//                              after its `cleaned` disposition (`retry.after-disposition`), the instance still held;
//                              64 released pairs of another arc fill the index. HEAD's start compacts it: the fillers
//                              go, the previous release's pair stays byte for byte; recovery releases it and the arc
//                              merges.
//   upgrade.opt-in-holistic    stopped mid-build, `page-id` left held; on HEAD the architect's
//                              `apply --vision-edit` adds `holistic` (a vision, one must-hold obligation witnessed by a node-test
//                              lane, L = {invariants}), then `resume page-id`: the baseline job, the drift audit and
//                              a no-op checkpoint, the brake on `page-id`'s candidate, the final audit and a no-op
//                              checkpoint, the close-out, `arc-completed`.
//   upgrade.fingerprint-open-ff
//                              `page-id` approved, the ff open at a crash; HEAD compares the fingerprint byte for byte.
//   upgrade.config-without-chain
//                              no chain K in the repo config: no chain row applies to the adopted arc.
//   upgrade.target-kind-fixed  an apply cannot switch the adopted arc to a corpus target (`target-kind-changed`).
//   upgrade.routing-stable     stopped mid-build, `page-id` left held; on HEAD the architect's `apply` (a new
//                              `direction`) and `resume page-id`: HEAD's revision records the role set the previous
//                              release recorded and resolves the rev it recorded; every HEAD judgment runs under it, no
//                              re-pin, no `routing-changed`; `status` spend resolves every metered call.
//   upgrade.reentry-with-fixes
//                              `page-id` parked infeasible at plan-check (a recorded failure); the architect's `apply`
//                              through the previous release's CLI adds `page-id-2` re-entering it with `fixes` naming that
//                              failure, and the previous release is stopped mid-build of it. HEAD's start finds that
//                              revision in force, HEAD merges `page-id-2`, and an apply then classifies as accepted.
//   upgrade.inputs-in-force    `page-id`'s plan-check redirects with a spec patch and `roadmap rule` lands C-3, both on
//                              the previous release, which keeps them in force without writing the owner's files;
//                              stopped mid-build. On HEAD an architect `apply` (a new `direction`) keeps both in force
//                              as plan revision 3, C-3 published once, and nothing writes the owner's files.
//   upgrade.checkpoint-reentry-with-fixes
//                              `page-id` parks infeasible; the architect opts in to `holistic` through the previous
//                              release's CLI (`--vision-edit`); its park checkpoint's bundle re-enters `page-id` as
//                              `page-id-2` naming the failure, the drift audit and its no-op checkpoint settle, and the
//                              previous release is stopped mid-build of `page-id-2`. HEAD merges it (the brake on its
//                              candidate), runs the final audit and checkpoint and completes the arc; an apply then
//                              classifies as accepted.
//   upgrade.vision-edit-queued as opt-in-holistic, the opt-in apply queued through the previous release's CLI with
//                              `--vision-edit`: applied as the declared vision edit, never `vision-leak`; no default.
//   upgrade.checkpoint-answer-unapplied
//                              a corpus arc; `page-id` parks infeasible and the previous release crashes right after its
//                              park checkpoint's call (`checkpoint.after-call`): the recorded answer, a re-entry naming
//                              the failure, undecided. HEAD decides it from the record (no new call, no repair turn),
//                              applies it and merges `page-id-2`.
//   upgrade.corpus-witnesses-declared
//                              a corpus arc (the previous release's corpus target: pin, Phase-0 record, fake forge)
//                              whose arc lane declares `testPaths` and whose witness declares `files`; stopped mid-build.
//                              HEAD finishes it (the brake, the final audit and checkpoint); an apply's Phase 0 checks
//                              both as declared, no default read.
//   upgrade.read-denied-retry  the previous release's gate approves from a session refused a read, records
//                              `read-denied` and crashes before its retry (`unit.after-stage`); HEAD takes the retry by
//                              the old row (one uncharged retry), approves and merges.
//   upgrade.unpersisted-refused
//                              the previous release's gate answers off its schema in an unpersisted session and the
//                              previous release crashes before reading it (`spawn.after-done`); HEAD reads the refusal
//                              with no repair turn (a call consumed after a crash takes none): `malformed`, then a
//                              fresh gate merges.
//   upgrade.audit-mid-chunk    a corpus arc (holistic from the start) whose slug publication alone outgrows a lens's diff
//                              budget; the previous release's executor dies in the final audit's second chunk (its
//                              first chunk read). HEAD finds the same chunks, consumes the recorded first, asks the lost
//                              second again as a bounded diff (`<orientation>`), settles the checkpoint, completes the arc.
//
// Not covered: a backend parked on a usage limit, the Claude-only profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { isAlive, statOf } from '../../src/contain/proc.ts';
import type { Event, Fact } from '../../src/core/events.ts';
import { arcId, commandId, invocationId, opId, resourceName, unitId } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { type JsonValue, canonicalJson } from '../../src/core/json.ts';
import { gateDiffShownOf } from '../../src/core/upgrade.ts';
import type { ProcIdentity } from '../../src/core/records.ts';
import { openJournal, readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { incomingPath, terminalReceipt } from '../../src/commands/queue.ts';
import type { ExitReason } from '../../src/executor.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { readOwner } from '../../src/host/owner.ts';
import { pressureAvailability } from '../../src/host/pressure.ts';
import { RESIDUE_ARCHIVE, bodyOf, readResidues, recordDisposition, recordResidue } from '../../src/host/residues.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { overCapacity } from '../../src/resources/pool.ts';
import { bytesSha256, loadSpec } from '../../src/spec/spec.ts';
import { CONTINUE_DIRECTIVE } from '../../src/prompts/directives.ts';
import { meterOf } from '../../src/meter.ts';
import { provenanceStack, resolveRouting } from '../../src/routing/layers.ts';
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
import { type CallRecord, type ClaudeAct, type ScenarioFile, type Step, readCalls, writeScenario } from '../helpers/scenario.ts';

after(assertNoSurvivors);

/**
 * The previous release: its executor starts the arc, HEAD's finishes it. At each release, move it to the
 * last released commit, the merge of the previous release's PR into main. Merges here are merge commits, so
 * a merged branch's shas stay reachable and `git archive` finds them. Now: 1.0.0-dev.11, merged to main as
 * PR #113 (schema version 1). Arcs started on 1.0.0-dev.7 to dev.10 stay adopted through their defaults in
 * src/core/upgrade.ts until none is in flight; this test exercises the previous release only.
 */
const PREVIOUS_RELEASE = '1f7f69681fbf637126046dfc0c01617b1adfdb17';
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
  assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"version": "1\.0\.0-dev\.11"/);
  const load = (path: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(root, path)).href);
  const [scenario, shim, sample] = await Promise.all([load('evals/m1/scenario.ts'), load('test/fakes/shim.ts'), load('src/host/sample.ts')]);
  previous = {
    root,
    modules: {
      fakeSteps: scenario['fakeSteps'], readScenario: scenario['readScenario'], writeShims: shim['writeShims'],
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
  answer: { decision: 'escalate', reasons: ['The contract is ambiguous.'], patch: null, risk: 'med', notes: '', premises: [], visionConflict: [], scopeGrowth: [] },
};

/** Where the previous release is stopped: a fake call parked at a barrier in its scenario dir. */
const MID_CALL = 'mid-call';
const MID_BUILD_THREAD = '11111111-1111-4111-8111-111111111111';
/** page-id's fresh build: its Codex thread started, its files written but not committed, then parked. */
const midBuild = (files: Readonly<Record<string, string>>): Step => ({
  as: 'codex', threadId: MID_BUILD_THREAD, expect: { argv: ['exec', '-C'] },
  acts: [{ type: 'threadStarted' }, { type: 'dirty', files }, { type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }],
});
/** page-id's plan-check after its reopen, parked (the previous release's judgment tools, before the Agent tool).  */
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
  writeFileSync(m1File, JSON.stringify({ steps: typeof m1 === 'function' ? m1(l) : m1 }));
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
 * respawns to recover it, and SIGKILLed once the executor is gone. `act` runs meanwhile (the architect's commands);
 * `env` is added to the start.
 */
async function crashPrevious(p: Phase1, spec: TriggerSpec, act: () => Promise<void> = async () => {}, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const trigger = writeTrigger(p.dir, spec);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { ...env, ROADMAP_TEST_CRASH: trigger });
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
  assertPressure(f);
}

/**
 * M4b rev 3: both releases record host pressure. Every start, the previous release's and HEAD's, records this host's
 * schedstat availability, and every spawn either closed records its pressure (a number, or null for a launch under
 * `PRESSURE_MIN_WALL_MS`; null always without schedstat).
 */
function assertPressure(f: Finished): void {
  const available = pressureAvailability();
  const headFirst = f.after[0]?.seq ?? Infinity;
  assert.ok(factsOf(f.events.filter((e) => e.seq < headFirst), 'executor-started').length > 0, 'the previous release started the arc');
  for (const s of factsOf(f.events, 'executor-started')) assert.equal(s.pressure, available, JSON.stringify(s));
  const spawnResults = (events: readonly Event[]) => events.flatMap((e) => (e.type === 'done' && e.kind === 'proc.spawn' && e.outcome.kind === 'result' ? [e.outcome] : []));
  assert.ok(spawnResults(f.after).length > 0, 'HEAD closed spawns');
  for (const outcome of spawnResults(f.events)) {
    assert.notEqual(outcome.pressure, undefined, JSON.stringify(outcome));
    if (available === 'unavailable') assert.equal(outcome.pressure, null, JSON.stringify(outcome));
  }
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
  const gated = factsOf(f.after, 'judgment-inputs').filter((i) => i.stage === 'gate');
  assert.ok(gated.length === 1 && gated[0]!.diffShown !== undefined && gated[0]!.diffShown.inlined.length > 0, 'HEAD\'s gate records what its bounded diff showed');
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
  assert.deepEqual(JSON.parse(dry.stdout), { dryRun: true, kind: 'accepted', rev: 2, nextRev: 3, changes: [{ type: 'unit-added', unit: 'extra' }], smoke: [], advisories: [], numbered: [] });
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

test('upgrade.apply-queued: an apply the previous release\'s CLI queues (`base` and `visionEdit`) on HEAD\'s running arc is applied as revision 2, its bytes unchanged, no default read', T, async () => {
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
      id = await submitOnPrevious(p, ['apply']);
      queued = commandBytes(p, id);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const body = (JSON.parse(queued!.toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
  assert.deepEqual([body['type'], 'expectRev' in body, 'base' in body, 'visionEdit' in body], ['apply', false, true, true], 'the previous release\'s CLI queued the apply HEAD knows');
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0);
  assert.deepEqual([fact.rev, fact.command, fact.changes], [2, id, [{ type: 'plan-field', field: 'direction' }]]);
  assert.ok(queued !== null && commandBytes(p, id).equals(queued), 'the previous release\'s command file is never rewritten');
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(apply\./, 'HEAD read the command as written: no default');
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

/** Submits `args` through the previous release's CLI and waits for the command's terminal receipt; returns the command id. */
async function submitOnPrevious(p: Phase1, args: readonly string[]): Promise<string> {
  const out = await p.cli([...args, ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const id = (JSON.parse(out.stdout) as { command: string }).command;
  const receipt = await until(`the previous release's command ${id} ends`, PHASE_MS, () => terminalReceipt(absPath(p.l.runDir), commandId(id)));
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
  return id;
}

/**
 * Acknowledges, through the previous release's CLI, every blocking needs-user still open (a superseded unit's park
 * escalation, which otherwise holds the arc open), and waits until the previous release records each ack.
 */
async function ackOpenItems(p: Phase1): Promise<void> {
  const open = journalOf(p).view.needsUser().filter((n) => n.blocking && n.ack === null).map((n) => n.id);
  for (const id of open) {
    const ack = await p.cli(['ack', id, ...p.run]);
    assert.equal(ack.code, 0, ack.stderr);
  }
  await until('the previous release records the acks', PHASE_MS, () => (journalOf(p).view.needsUser().every((n) => !open.includes(n.id) || n.ack !== null) ? true : null));
}

/** Every supervisor's and executor's stderr in the host dir (the executors' upgrade-default warnings land there). */
const hostLogs = (p: Phase1): string =>
  readdirSync(p.host).filter((n) => /^(supervisor\.[0-9a-f]+|executor\.\d+)\.err$/.test(n)).map((n) => readFileSync(join(p.host, n), 'utf8')).join('');

const RULING = 'C-3';
const RULING_TEXT = 'Every page identifier is built from slugify.';

test('upgrade.rule-on-adopted-arc: `roadmap rule` lands on the previous release\'s revision: constraints.md published, the owner\'s files never written; the arc then merges', T, async () => {
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
  assert.ok(readFileSync(ledger).equals(before), 'the owner\'s ledger is never written');
  const inForce = Buffer.from(`${before.toString('utf8')}${RULING} — ${RULING_TEXT}\n`, 'utf8');
  assert.deepEqual([fact.rev, fact.command, fact.source, fact.rulingsSha256, fact.publication?.pub], [2, id, { type: 'command', command: id }, bytesSha256(inForce), 'docs-1']);
  assert.ok(!existsSync(join(`${ledger}.d`, `${RULING}.json`)), 'nor a sidecar beside it');
  assert.match(git(p.l.repo, 'show', `integration:.roadmap/constraints.md`), new RegExp(`${RULING} — ${RULING_TEXT}`), 'constraints.md published');
});

/** The arc whose released residue pairs fill the host index to the compaction threshold (COMPACT_THRESHOLD). */
const FILLER = arcId('upgrade-filler');
const FILLERS = 64;

test('upgrade.compact-with-adopted-retry: the previous release\'s retry crashed after its disposition; HEAD\'s start compacts the index, keeping that pair byte for byte, and recovery releases it', T, async () => {
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

/**
 * Starts HEAD on the fixture with `steps` behind its fake backends (`binDirs` next on PATH) and waits for the run to end;
 * `during` runs alongside.
 */
async function runOnHead(p: Phase1, steps: readonly Step[], during: () => Promise<void>, name = 'fake-head', binDirs: readonly string[] = []): Promise<HeadRun> {
  const highWater = journalOf(p).view.highWater();
  const s = writeScenario(join(p.dir, name), steps);
  const env = { ...process.env, PATH: [s.binDir, ...binDirs, process.env['PATH'] ?? ''].join(':') };
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

/**
 * The obligations file: I-1 witnessed through `lane` by `witness`, its proof judged on the lane's rev as `revOf` (HEAD's
 * `laneRevOf`, or the previous release's) computes it. The default lane and witness declare no `testPaths` and no
 * `files`, which only a corpus arc's Phase 0 requires.
 */
function obligations(lane: object = SLUG_LANE, witness: object = SLUG_WITNESS, revOf: (file: object) => string = (file) => laneRevOf(parseObligations(file).lanes[0]!)): unknown {
  const empty = { schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when page-id ships', lanes: [lane], obligations: [], mapping: { paths: [] } };
  const laneRev = revOf(empty);
  return {
    ...empty,
    obligations: [{
      id: 'I-1', rev: 1, statement: 'slugify never returns a leading or trailing hyphen.',
      docRef: { path: '.roadmap/contracts/one.md', anchor: '#slugifytext', quotedText: 'The result never starts or ends with' },
      serves: ['V-1'], witness, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness },
      deliveredBy: [], activation: 'must-hold', contracts: ['.roadmap/contracts/one.md'], state: { type: 'active' },
    }],
  };
}

/**
 * The opt-in story: stopped mid-build, `page-id` left held; on HEAD the architect writes a vision, the obligations and
 * `holistic`, `queue` submits the apply (and waits for it applied; returns its command id), then `resume page-id`: the
 * baseline job, the drift audit (audit-1, L ∩ {drift, vision} empty: all of L) and its no-op checkpoint (ckpt-1), the
 * brake on page-id's candidate, the final audit (audit-2) and its no-op checkpoint (ckpt-2), `arc-completed`.
 */
async function optInHolistic(queue: (p: Phase1) => Promise<string>): Promise<Readonly<{ p: Phase1; r: HeadRun; id: string }>> {
  // page-id stays held until the apply lands: an arc-scoped apply waits for every unit to be idle.
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
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
      id = await queue(p);
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
  return { p, r, id };
}

test('upgrade.opt-in-holistic: an architect apply adds `holistic` to the previous release\'s arc mid-run: the baseline job, the drift audit, the brake on page-id\'s candidate, the final audit, no-op checkpoints, arc-completed', T, async () => {
  await optInHolistic((p) => submitOnHead(p, ['apply', '--vision-edit']));
});

test('upgrade.vision-edit-queued: the opt-in apply the previous release\'s CLI queues with `--vision-edit` changes the vision and is applied as the declared vision edit it carries, never refused as vision-leak; no default read', T, async () => {
  let body: Readonly<Record<string, unknown>> = {};
  const { p } = await optInHolistic(async (q) => {
    const id = await submitOnPrevious(q, ['apply', '--vision-edit']);
    body = (JSON.parse(commandBytes(q, id).toString('utf8')) as { body: Readonly<Record<string, unknown>> }).body;
    return id;
  });
  assert.deepEqual([body['type'], 'expectRev' in body, body['visionEdit']], ['apply', false, true], 'the previous release\'s CLI queued its declared vision edit');
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(apply\./, 'HEAD read the command as written: no default');
});

// ---------------------------------------------------------------------------------------------------
// Generic adoption: a crash with the ff open, the repo config, the target kind

test('upgrade.fingerprint-open-ff: the previous release approved page-id and crashed with its ff open; HEAD\'s recovery compares its fingerprint byte for byte and publishes, with no new judgment', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build, c.pageId.gate], []);
  await crashPrevious(p, { label: 'ff.act-start', occurrence: 1, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const open = mid.opsOf('integration.ff').filter((i) => mid.doneOf(i.op) === null);
  assert.equal(open.length, 1, 'page-id\'s ff intent is open');
  const approval = mid.unit(unitId('page-id')).approval;
  assert.ok(approval !== null, 'the previous release recorded page-id\'s approval');
  assert.equal('corpus' in approval.fingerprint, false, 'a non-corpus arc\'s fingerprint has no corpus pin');
  const gateInputs = factsOf(journalOf(p).events, 'judgment-inputs').filter((i) => i.unit === 'page-id' && i.stage === 'gate');
  assert.ok(gateInputs.length === 1 && gateInputs[0]!.diffShown === undefined, 'the previous release\'s gate recorded no diffShown');
  assert.deepEqual(gateDiffShownOf(gateInputs[0]!), { inlined: [], notInlined: [] }, 'read as nothing recorded (the dev.12 default)');

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
  assert.equal(canonicalJson(f.view.unit(unitId('page-id')).approval?.fingerprint), canonicalJson(approval.fingerprint), 'the approval is read as the previous release wrote it');
});

test('upgrade.config-without-chain: an adopted arc whose repo config names no chain K finishes on HEAD with no chain row applied, and its chain is itself alone', T, async () => {
  const { p, head } = await stoppedMidBuild(clean());
  const config = JSON.parse(readFileSync(join(p.l.repo, '.roadmap', 'config.json'), 'utf8')) as object;
  assert.equal('chain' in config, false, 'the previous release\'s fixture repo config names no chain K');
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

test('upgrade.target-kind-fixed: an apply cannot switch an adopted architecture-doc arc to a corpus one (target-kind-changed)', T, async () => {
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
// Routing: HEAD binds the previous release's revisions through the same seat table

test('upgrade.routing-stable: an arc the previous release started keeps its role set and routing rev on HEAD: HEAD\'s revision records the same role set and resolves the same rev, it judges under it with no re-pin and no routing-changed; spend resolves', T, async () => {
  const { p, head } = await stoppedMidBuild(clean(), undefined, false);
  const before = journalOf(p).events;
  const [rev1] = factsOf(before, 'plan-applied');
  assert.ok(rev1 !== undefined && rev1.routingProvenance.arcRoles !== undefined, 'the previous release records its role set');
  const revs = new Set(factsOf(before, 'dispatch').map((d) => d.record.routingRev));
  assert.equal(revs.size, 1, 'one arc routing rev under the previous release');
  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, head, async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [rev2, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(rev2 !== undefined && more.length === 0);
  assert.deepEqual(rev2.routingProvenance.arcRoles, rev1.routingProvenance.arcRoles, 'HEAD\'s revision carries the role set the previous release recorded');
  const resolved = resolveRouting(provenanceStack(rev2.routingProvenance, 'none', null));
  assert.ok(revs.has(resolved.rev), 'HEAD resolves the rev the previous release recorded');
  const judged = factsOf(f.after, 'judgment-inputs');
  assert.ok(judged.length > 0);
  for (const ji of judged) assert.ok(revs.has(ji.routingRev), `${ji.unit} ${ji.stage}: judged under the previous release's rev`);
  assert.deepEqual(factsOf(f.after, 'stage-outcome').filter((o) => o.outcome === 'routing-changed'), [], 'no routing-changed');
  const started = factsOf(f.after, 'executor-started');
  assert.ok(started.length > 0 && started.every((s) => s.host !== undefined), 'HEAD\'s starts record the host fingerprint');

  const out = await headCli(p, ['status', ...p.run]);
  assert.equal(out.code, 0, out.stderr);
  const spend = (JSON.parse(out.stdout) as { spend: { byRole: { calls: number }[]; byModel: { models: { model: string; calls: number }[]; unresolvedRevs: string[] } } }).spend;
  const total = (xs: readonly { calls: number }[]): number => xs.reduce((n, x) => n + x.calls, 0);
  const metered = meterOf(journalOf(p).events);
  assert.deepEqual(spend.byModel.unresolvedRevs, []);
  assert.equal(total(spend.byModel.models), total(metered.bySeat), 'every metered seat call resolves to a model');
  assert.equal(total(spend.byRole), total(metered.byRole));
});

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.11's additive records over an arc the previous release started

/** A plan-check that finds page-id infeasible; played twice (its seat, then the escalation seat), it parks page-id. */
const INFEASIBLE: M1Step = {
  role: 'planCheck',
  answer: { decision: 'infeasible', reasons: ['Contract one cannot be met as written.'], patch: null, risk: 'med', notes: 'Contract one contradicts itself.', premises: [], visionConflict: [], scopeGrowth: [] },
};
const REENTRY = 'page-id-2';

/** What the re-entry's spec adds to page-id's: a design failure's retry must change something it ran under. */
const REENTRY_FACT = { id: 'F2', text: 'Contract one is satisfiable: slugify already returns no leading or trailing hyphen.' };

/** The architect re-enters `page-id` as REENTRY (its spec, one fact more, and scope), naming the failure it fixes. */
function reenterPageId(l: Layout, fixes: string): void {
  type Unit = { id: string; spec: string };
  const spec = JSON.parse(readFileSync(join(l.input, 'page-id.json'), 'utf8')) as { facts: object[] };
  writeFileSync(join(l.input, `${REENTRY}.json`), `${JSON.stringify({ ...spec, unit: REENTRY, rev: 1, facts: [...spec.facts, { ...REENTRY_FACT, state: 'active' }] }, null, 2)}\n`);
  editJson<{ units: Unit[] }>(l.plan, (plan) => {
    const old = plan.units.find((u) => u.id === 'page-id')!;
    return { ...plan, units: [...plan.units, { ...old, id: REENTRY, spec: `${REENTRY}.json`, reenters: { unit: 'page-id', fixes } }] };
  });
}

test('upgrade.reentry-with-fixes: a re-entry the previous release applied, naming the failure it fixes, stays in force on HEAD, never classified again: HEAD finishes it, and a later apply is accepted', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [midBuild(pageIdFiles(c))]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    const failed = journalOf(p).view.unit(unitId('page-id')).failures.at(-1)!.fact;
    reenterPageId(p.l, `page-id/${failed.stage}#${failed.attempt}`);
    await submitOnPrevious(p, ['apply']);
    await midCall(p);
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const failed = mid.unit(unitId('page-id')).failures.at(-1)!.fact;
  const fixes = `page-id/${failed.stage}#${failed.attempt}`;
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  const inForce = requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY);
  assert.deepEqual(inForce?.reenters, { unit: unitId('page-id'), fixes }, 'the re-entry in force names the failure it fixes');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps = headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default');
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {});
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

/** The architect's ruling C-3 on the revision in force: its ledger, no obligations and no vision. */
const rulingRecord = (p: Phase1, ledger: Buffer): object => ({
  schema: 'roadmap/ruling-m3', id: RULING, statement: RULING_TEXT, kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'review', supersedes: [], condition: null,
  docRefs: [{ path: 'ARCHITECTURE.md', anchor: '#architecture', quotedText: 'A tiny library of pure string and number helpers.', relation: 'consistent' }],
  contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
  consistency: {
    verdict: 'consistent', judgedRevs: { head: git(p.l.repo, 'rev-parse', 'integration'), ledgerSha256: bytesSha256(ledger), obligationsSha256: null, visionSha256: null, contracts: [] },
    by: { type: 'architect' },
  },
});

const REDIRECT_FACT = { id: 'F2', text: 'Contract one is unambiguous about the empty slug.' };

test('upgrade.inputs-in-force: a plan-check\'s spec patch and a ruling the previous release kept in force without writing the owner\'s files rebase cleanly on HEAD: its start and an architect apply keep both in force, and nothing writes the owner\'s files', T, async () => {
  const c = clean();
  const redirect: M1Step = { role: 'planCheck', answer: { ...((c.pageId.planCheck as Exclude<M1Step, { role: 'build' }>).answer as object), decision: 'redirect', patch: [{ op: 'add', section: 'facts', item: REDIRECT_FACT }] } };
  const p = await preparePrevious([...c.slug, redirect, c.pageId.planCheck], [midBuild(pageIdFiles(c))]);
  const ledger = join(p.l.input, 'rulings.md');
  const sidecar = join(`${ledger}.d`, `${RULING}.json`);
  const specPath = join(p.l.input, 'page-id.json');
  const ledgerBefore = readFileSync(ledger);
  const specBefore = readFileSync(specPath);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await midCall(p);
    const file = join(p.dir, 'C-3.json');
    writeFileSync(file, `${JSON.stringify(rulingRecord(p, ledgerBefore), null, 2)}\n`);
    await submitOnPrevious(p, ['rule', file]);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  // The previous release (1.0.0-dev.11) keeps both in its revision, never in the owner's files.
  assert.ok(readFileSync(ledger).equals(ledgerBefore) && !existsSync(sidecar) && readFileSync(specPath).equals(specBefore), 'the previous release wrote nothing into the owner\'s files');
  const ruled = journalOf(p).view.planApplied();
  assert.equal(ruled?.rev, 2, 'the ruling\'s revision');
  assert.equal(journalOf(p).view.unit(unitId('page-id')).spec?.rev, 2, 'page-id runs at the patched spec rev');

  let id = '';
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate], async () => {
      await until('HEAD\'s executor runs the arc', PHASE_MS, () => (factsOf(journalOf(p).events, 'executor-started').length > 1 ? true : null));
      newDirection(p.l);
      id = await submitOnHead(p, ['apply']);
      await submitOnHead(p, ['resume', 'page-id']);
    });
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  const [fact, ...more] = factsOf(f.after, 'plan-applied');
  assert.ok(fact !== undefined && more.length === 0, 'HEAD\'s start found the files in force: only the apply revised the plan');
  assert.deepEqual([fact.rev, fact.command, fact.changes, fact.rulingsSha256], [3, id, [{ type: 'plan-field', field: 'direction' }], ruled!.rulingsSha256], 'C-3 stays in force');
  assert.equal(f.view.unit(unitId('page-id')).spec?.rev, 2, 'page-id merged at the patched rev');
  assert.ok(readFileSync(ledger).equals(ledgerBefore) && !existsSync(sidecar) && readFileSync(specPath).equals(specBefore), 'HEAD wrote nothing into the owner\'s files');
  const constraints = git(p.l.repo, 'show', 'integration:.roadmap/constraints.md');
  assert.equal(constraints.split(`${RULING} — ${RULING_TEXT}`).length - 1, 1, 'C-3 published once');
});

/** An arc lane over the fixture's initial tests (green from the baseline): `node --test test/text.test.js`. */
/** A corpus arc's lane and witness, declared (`testPaths`, `files`) as Phase 0 requires of a fresh corpus arc since 1.0.0-dev.11. */
const TEXT_LANE = { ...SLUG_LANE, id: 'text-journey', argv: ['node', '--test', 'test/text.test.js'], testPaths: ['test/text.test.js'] } as const;
const TEXT_WITNESS = { lane: TEXT_LANE.id, testIds: ['words splits on runs of whitespace'], files: ['test/text.test.js'] };

test('upgrade.checkpoint-reentry-with-fixes: a holistic arc whose checkpoint the previous release ran re-entered page-id, naming the failure it fixes, finishes on HEAD: the bundle\'s re-entry stays in force, HEAD\'s final checkpoint reads the applied answer as recorded, and a later apply is accepted', T, async () => {
  const c = clean();
  type Helpers = typeof import('../helpers/holistic.ts');
  type Types = typeof import('../../src/holistic/types.ts');
  const [prev, prevTypes] = await Promise.all([
    import(pathToFileURL(join(previous.root, 'test', 'helpers', 'holistic.ts')).href) as Promise<Helpers>,
    import(pathToFileURL(join(previous.root, 'src', 'holistic', 'types.ts')).href) as Promise<Types>,
  ]);
  // page-id's second plan-check (the escalation seat's infeasible) is the failure its park recorded last.
  const fixes = 'page-id/plan-check#2';
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, fixes, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  // A design failure's retry must change something it ran under: the re-entry's spec gains a fact.
  const respec = { op: 'patch-spec', unit: REENTRY, patch: [{ op: 'add', section: 'facts', item: REENTRY_FACT }], cites: ['V-1'], evidence: ['contract one is satisfiable as written'] };
  // Once holistic, page-id's park has a checkpoint (ckpt-1, the re-entry); the opt-in's drift audit (audit-1, which the
  // bundle's revision joins) finds nothing new after ckpt-1 settled, so it has no checkpoint (`checkpoint-skipped`).
  const p = await preparePrevious([...c.slug, INFEASIBLE, INFEASIBLE, c.pageId.planCheck], [
    midBuild(pageIdFiles(c)),
    prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter, respec] })),
    prev.lensStep('audit-1', 'invariants'),
  ]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p);
    await until('page-id parks infeasible', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'park-pending' ? true : null));
    // The architect opts in through the previous release's CLI, the obligations as it wrote them.
    writeFileSync(join(p.l.input, 'vision.json'), `${JSON.stringify(VISION, null, 2)}\n`);
    const file = obligations(SLUG_LANE, SLUG_WITNESS, (o) => prevTypes.laneRevOf(prevTypes.parseObligations(o).lanes[0]!));
    writeFileSync(join(p.l.input, 'obligations.json'), `${JSON.stringify(file, null, 2)}\n`);
    editJson<object>(p.l.plan, (plan) => ({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json', audit: { lenses: ['invariants'] } } }));
    await submitOnPrevious(p, ['apply', '--vision-edit']);
    await midCall(p);
    // The park checkpoint and the drift audit run side by side. Every audit started by then (the bundle's revision's
    // drift included) has ended and every checkpoint settled.
    await until('the previous release ends its audits and settles their checkpoints', PHASE_MS, () => {
      const h = journalOf(p).view.holistic();
      const settled = h.audits.length > 0 && h.audits.every((a) => a.ended !== null) && h.checkpoints.every((ck) => ck.decided !== null);
      return settled ? true : null;
    });
    await ackOpenItems(p);
    await stopPrevious(p, supervisor);
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  const failed = mid.unit(unitId('page-id')).failures.at(-1)!.fact;
  assert.equal(`page-id/${failed.stage}#${failed.attempt}`, fixes, 'the re-entry names the failure page-id\'s park recorded');
  const h = mid.holistic();
  assert.deepEqual(h.checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided?.kind]), [['ckpt-1', 'park', 'applied']], 'the park checkpoint re-entered page-id');
  assert.deepEqual(factsOf(journalOf(p).events, 'checkpoint-skipped').map((k) => k.audit), ['audit-1'], 'the drift audit found nothing new: no checkpoint');
  assert.deepEqual(h.audits.map((a) => a.started.job), ['audit-1']);
  const held = mid.unit(unitId(REENTRY));
  assert.deepEqual([held.stage, held.status, held.interrupted?.outcome], ['build', 'held', 'interrupted']);
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id'), fixes }, 'the bundle\'s re-entry names the failure it fixes');
  const resume = await p.cli(['resume', ...p.run]);
  assert.equal(resume.code, 0, resume.stderr);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-2', 'invariants'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {});
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === REENTRY), 'the brake ran on the re-entry\'s candidate');
  assert.deepEqual(factsOf(r.after, 'audit-started').map((a) => [a.job, a.triggers.map((t) => t.type)]), [['audit-2', ['final']]]);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-2', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'HEAD\'s checkpoint read the applied answer as recorded: no default');
  // The architect's next apply classifies the plan holding the bundle's re-entry: accepted.
  newDirection(p.l);
  const dry = await headCli(p, ['apply', '--dry-run', ...p.run]);
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
});

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.12's adoption paths: a refused read the previous release voided, a judgment it did not persist, an audit
// it left between chunks

/** page-id's gate as the previous release plays it, `acts` before its answer (its judgment tools, before the Agent tool). */
const previousGate = (answer: JsonValue, acts: readonly ClaudeAct[] = []): Step =>
  ({ as: 'claude', expect: { argv: ['-p', '--tools', 'Read,Grep,Glob'] }, acts: [...acts, { type: 'emit', value: answer }] });
const gateAnswer = (c: Clean): JsonValue => (c.pageId.gate as Exclude<M1Step, { role: 'build' }>).answer;

test('upgrade.read-denied-retry: a gate approve the previous release voided as read-denied, crashed before its retry, takes that retry on HEAD by the old row (uncharged) and merges', T, async () => {
  const c = clean();
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [previousGate(gateAnswer(c), [{ type: 'globAboveAddDir' }])]);
  // page-id's stages: plan-check, build, quiesce, evidence, salvage, teardown, lanes, then the gate (the eighth).
  await crashPrevious(p, { label: 'unit.after-stage', occurrence: 8, unit: 'page-id' });
  const mid = journalOf(p).view;
  assert.equal(mid.unit(unitId('slug')).status, 'retired');
  assert.equal(outcomesOf(journalOf(p).events, 'page-id').at(-1), 'gate:read-denied', 'the previous release voided the approve');
  assert.equal(mid.unit(unitId('page-id')).approval, null);
  assert.deepEqual(mid.needsUser(), [], 'the retry is pending: no park');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(outcomesOf(f.after, 'page-id').slice(0, 1), ['gate:approve'], 'HEAD re-ran the gate by the read-denied row and approved');
  assert.equal(f.view.unit(unitId('page-id')).counters.retries.gate, 1, 'the one uncharged retry');
  assert.equal(f.view.unit(unitId('page-id')).counters.chargeableFailures, 0);
});

test('upgrade.unpersisted-refused: a gate answer off its schema the previous release received in an unpersisted session, crashed before reading, is read on HEAD with no repair turn (a call consumed after a crash takes none): malformed, then a fresh gate merges', T, async () => {
  const c = clean();
  const offSchema = { decision: 'approve', findings: [], directives: [], reasons: ['B1 holds'] };
  const p = await preparePrevious([...c.slug, c.pageId.planCheck, c.pageId.build], [previousGate(offSchema)]);
  // page-id's spawns: its plan-check, its resource's probe, its build, the resource's teardown, its lane, then the gate (the sixth).
  await crashPrevious(p, { label: 'spawn.after-done', occurrence: 6, unit: 'page-id' });
  const events = journalOf(p).events;
  const gateSpawns = events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'backend' && e.expect.subject.role === 'gate' && e.expect.subject.unit === 'page-id' ? [e] : []));
  assert.equal(gateSpawns.length, 1, 'the previous release spawned page-id\'s gate once');
  assert.ok(journalOf(p).view.doneOf(gateSpawns[0]!.op) !== null, 'its call is done');
  assert.ok(!outcomesOf(events, 'page-id').some((o) => o.startsWith('gate:')), 'and unread');

  const scope = scopeOf(p);
  let f: Finished;
  track(scope);
  try {
    f = await finishOnHead(p, [c.pageId.gate]);
  } finally {
    await teardown(scope);
  }
  assertFinished(f);
  assert.deepEqual(outcomesOf(f.after, 'page-id').slice(0, 2), ['gate:malformed', 'gate:approve'], 'the refusal stands, then a fresh gate');
  assert.ok(!f.calls.some((call) => call.argv.includes('--resume')), 'no repair turn');
});

/** A module big enough (about 160 KB) that slug's publication alone outgrows a lens's diff budget. */
const BULK = Array.from({ length: 6000 }, (_, i) => `export const word${i} = 'w${i}';`).join('\n');


// ---------------------------------------------------------------------------------------------------
// A corpus arc the previous release started: its obligations declare their testPaths and witness files

type PreviousHelpers = typeof import('../helpers/holistic.ts');

/**
 * The M1 fixture as a corpus arc of the previous release (its corpus target: pin, Phase-0 record, fake forge, whose `gh`
 * is in the returned bin dir), its one obligation witnessed on the fixture's initial text tests (green from the
 * baseline), L = {invariants}; `m1` and `extra(helpers)` (the previous release's holistic step builders) its fake steps,
 * after the pack review `review-1`.
 */
async function corpusArc(m1: readonly M1Step[], extra: (prev: PreviousHelpers) => readonly Step[]): Promise<Readonly<{ p: Phase1; gh: string }>> {
  type Types = typeof import('../../src/holistic/types.ts');
  type Target = typeof import('../fixtures/corpus-target.ts');
  type Brake = typeof import('../fixtures/brake-common.ts');
  const load = <M>(...path: string[]): Promise<M> => import(pathToFileURL(join(previous.root, ...path)).href) as Promise<M>;
  const [prev, prevTypes, target, brake] = await Promise.all([
    load<PreviousHelpers>('test', 'helpers', 'holistic.ts'), load<Types>('src', 'holistic', 'types.ts'), load<Target>('test', 'fixtures', 'corpus-target.ts'),
    load<Brake>('test', 'fixtures', 'brake-common.ts'),
  ]);
  let gh = '';
  const p = await preparePrevious(m1, [...extra(prev), prev.packReviewStep('review-1')], (l) => {
    gh = join(l.dir, 'bin-gh');
    mkdirSync(gh, { recursive: true });
    const file = obligations(TEXT_LANE, TEXT_WITNESS, (o) => prevTypes.laneRevOf(prevTypes.parseObligations(o).lanes[0]!)) as Record<string, unknown>;
    target.corpusTarget(
      { arc: l.arc, repo: l.repo, planPath: l.plan, runDir: l.runDir, hostDir: join(l.fake, 'host'), binDir: gh, scenarioPath: '', scenarioDir: '' },
      { obligations: file, advances: brake.ADVANCES, audit: { lenses: ['invariants'] } },
    );
    // The integration branch starts at the corpus baseline.
    git(l.repo, 'branch', '-f', 'integration', 'main');
  });
  return { p, gh };
}

/** PATH with the corpus arc's `gh` and the previous release's fakes first. */
const corpusPath = (p: Phase1, gh: string): string => [gh, join(p.fakeDir, 'bin'), process.env['PATH'] ?? ''].join(':');

test('upgrade.corpus-witnesses-declared: a corpus arc the previous release started (its arc lane\'s testPaths, its witness\'s files) finishes on HEAD, and an apply\'s Phase 0 checks both as declared: accepted, no default read', T, async () => {
  const c = clean();
  const { p, gh } = await corpusArc([...c.slug, c.pageId.planCheck], () => [midBuild(pageIdFiles(c))]);
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
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

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [{ ...c.pageId.build, round: 'resume', stdinContains: [CONTINUE_DIRECTIVE] }, c.pageId.gate] }, 'default'),
    lensStep('audit-1', 'invariants'), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(r.view.unit(unitId('page-id')).status, 'retired');
  assert.deepEqual(factsOf(r.after, 'plan-applied'), [], 'HEAD\'s start found the previous release\'s revision in force');
  assert.ok(factsOf(r.after, 'witnessed').some((w) => w.for.type === 'candidate' && w.for.unit === 'page-id'), 'the brake ran on page-id\'s candidate');
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  newDirection(p.l);
  const dry = await runUntilExit(process.execPath, [fixture('exec-cli.ts'), p.host, 'apply', '--dry-run', ...p.run], {
    env: { ...process.env, PATH: [gh, process.env['PATH'] ?? ''].join(':') }, timeoutMs: CLI_MS,
  });
  assert.equal(dry.code, 0, dry.stderr);
  const out = JSON.parse(dry.stdout) as { kind: string; changes: unknown[] };
  assert.deepEqual([out.kind, out.changes], ['accepted', [{ type: 'plan-field', field: 'direction' }]], dry.stdout);
  assert.doesNotMatch(dry.stderr, /roadmap: upgrade default \(obligations\./, 'the apply read the declared obligations as written');
});

test('upgrade.checkpoint-answer-unapplied: a park checkpoint\'s answer the previous release recorded but did not apply (it crashed after the call), re-entering page-id with the failure it fixes, is adopted on HEAD: decided from the recorded answer with no new call, applied, the re-entry merged', T, async () => {
  const c = clean();
  // A re-entry of the infeasible park, naming its last failure (the escalation seat's plan-check).
  const fixes = 'page-id/plan-check#2';
  const reenter = { op: 'reenter', unit: REENTRY, reenters: 'page-id', enterAt: null, reset: null, fixes, cites: ['V-1'], evidence: ['page-id parked infeasible: it starts over'] };
  const { p, gh } = await corpusArc([...c.slug, INFEASIBLE, INFEASIBLE], (prev) => [prev.checkpointStep('ckpt-1', prev.checkpointAnswer({ decision: 'bundle', ops: [reenter] }))]);
  await crashPrevious(p, { label: 'checkpoint.after-call', occurrence: 1 }, async () => {}, { PATH: corpusPath(p, gh) });
  const mid = journalOf(p).view;
  assert.ok(mid.unit(unitId('page-id')).failures.length > 0, 'page-id\'s lineage recorded a failure');
  assert.deepEqual(mid.holistic().checkpoints.map((ck) => [ck.inputs.job, ck.inputs.trigger.type, ck.decided]), [['ckpt-1', 'park', null]], 'the park checkpoint answered, undecided');
  assert.equal(requirePlanInForce(absPath(p.l.runDir), mid).plan.units.some((u) => u.id === REENTRY), false);

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [c.pageId.planCheck, c.pageId.build, c.pageId.gate] }, 'default'),
    // The bundle's drift audit finds nothing new after ckpt-1 settled (no checkpoint: `checkpoint-skipped`); the final
    // audit's checkpoint is ckpt-2.
    lensStep('audit-1', 'invariants'), lensStep('audit-2', 'invariants'), checkpointStep('ckpt-2', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  const scope = scopeOf(p);
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {
      // The superseded park's escalation item holds the arc open until acknowledged.
      await until('HEAD applies the recorded bundle', PHASE_MS, () => (journalOf(p).view.unit(unitId('page-id')).status === 'superseded' ? true : null));
      for (const n of journalOf(p).view.needsUser().filter((x) => x.blocking && x.ack === null)) await submitOnHead(p, ['ack', n.id]);
    }, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.deepEqual(r.calls.filter((call) => call.unit === 'ckpt-1'), [], 'HEAD decided ckpt-1 from the recorded answer: no new call, no repair turn');
  const [applied] = factsOf(r.after, 'plan-applied');
  assert.deepEqual(applied?.source, { type: 'bundle', job: 'ckpt-1', admits: [], conversions: [] }, 'HEAD applied the recorded bundle');
  assert.deepEqual(r.view.holistic().checkpoints.find((ck) => ck.inputs.job === 'ckpt-1')?.decided?.kind, 'applied');
  assert.deepEqual(requirePlanInForce(absPath(p.l.runDir), r.view).plan.units.find((u) => u.id === REENTRY)?.reenters, { unit: unitId('page-id'), fixes }, 'the re-entry enters the plan naming the failure it fixes');
  assert.equal(r.view.unit(unitId(REENTRY)).status, 'retired', 'HEAD merged the re-entry');
  assert.deepEqual(factsOf(r.after, 'checkpoint-skipped').map((k) => k.audit), ['audit-1']);
  assert.deepEqual(factsOf(r.after, 'bundle-decided').map((b) => [b.job, b.outcome]), [['ckpt-2', { kind: 'no-op' }]]);
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
  assert.doesNotMatch(hostLogs(p), /roadmap: upgrade default \(checkpoint\.reenter\.fixes\)/, 'the recorded answer read as written: no default');
});

test('upgrade.audit-mid-chunk: the final audit whose executor died during its second chunk resumes on HEAD: the chunks found again, the recorded first chunk consumed, the lost second asked again as a bounded diff, the arc completed', T, async () => {
  const c = clean();
  const [pc, build, gate] = c.slug;
  const bulky: M1Step = { ...build!, acts: (build as Extract<M1Step, { role: 'build' }>).acts.map((a) => (a.type === 'commit' ? { ...a, files: { ...a.files, 'src/words.js': `${BULK}\n` } } : a)) } as M1Step;
  // Holistic from the start is a corpus arc (the previous release refuses one without a corpus). Slug's publication
  // alone is the final audit's first chunk; the lens's call on the second (page-id's) parks until its executor is dead.
  const { p, gh } = await corpusArc([pc!, bulky, gate!, c.pageId.planCheck, c.pageId.build, c.pageId.gate], (prev) => [
    prev.lensStep('audit-1', 'invariants'),
    prev.lensStep('audit-1', 'invariants', [], [{ type: 'barrier', name: MID_CALL, timeoutMs: PHASE_MS }]),
  ]);
  // As a crash (see crashPrevious): the supervisor frozen so nothing of the previous release recovers, its executor
  // SIGKILLed while the second chunk's call waits; that call is HEAD's recovery's to end (lost).
  const scope = scopeOf(p);
  track(scope);
  try {
    const supervisor = await startPrevious(p, { PATH: corpusPath(p, gh) });
    process.kill(supervisor.pid, 'SIGSTOP');
    await midCall(p);
    const executor = readOwner(absPath(p.host))?.executor ?? null;
    assert.ok(executor !== null, 'host.owner.json names the executor');
    process.kill(executor.pid, 'SIGKILL');
    await until('the killed executor is gone', 60_000, () => (isAlive(executor) ? null : true));
    process.kill(supervisor.pid, 'SIGKILL');
    await until('the frozen supervisor is gone', 60_000, () => (isAlive(supervisor) ? null : true));
  } finally {
    await teardown(scope);
  }
  const mid = journalOf(p).view;
  assert.deepEqual(UNITS.map((u) => mid.unit(unitId(u)).status), ['retired', 'retired']);
  const audits = mid.holistic().audits;
  assert.deepEqual(audits.map((a) => [a.started.job, a.started.triggers.map((t) => t.type), a.ended]), [['audit-1', ['final'], null]], 'the final audit is open');
  const lensCalls = (events: readonly Event[]) => events.filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'arc-backend' && e.expect.subject.role === 'lens');
  assert.equal(lensCalls(journalOf(p).events).length, 2, 'the previous release read the first chunk and died in the second');

  const steps: readonly Step[] = [
    ...headFakeSteps({ steps: [] }, 'default'), lensStep('audit-1', 'invariants', [], [], ['<orientation>']), checkpointStep('ckpt-1', checkpointAnswer({ decision: 'no-op' })),
  ];
  let r: HeadRun;
  track(scope);
  try {
    r = await runOnHead(p, steps, async () => {}, 'fake-head', [gh]);
  } finally {
    await teardown(scope);
  }
  assert.equal(r.exit.kind, 'complete', JSON.stringify(r.exit));
  assert.equal(lensCalls(r.after).length, 1, 'HEAD consumed the recorded first chunk and asked the lost second once, as a bounded diff');
  const [ended] = factsOf(r.after, 'audit-ended');
  assert.deepEqual([ended?.job, ended?.outcome], ['audit-1', 'completed']);
  assert.ok(ended!.covered.some((cv) => cv.lens === 'invariants' && cv.to === audits[0]!.started.integrationSha), JSON.stringify(ended!.covered));
  assert.equal(factsOf(r.after, 'arc-completed').length, 1);
});
