// The whole-pipeline crash matrix's scenarios and driver (test/pipeline-matrix.test.ts): exec-common arcs
// run by the real supervised `roadmap start`, with a watcher beside the run that plays the test's part.
//
// A scenario is its arc (units, lanes, resources), its backend steps after the startup smoke, and hooks the
// watcher fires once each when their condition holds (release a barrier after moving integration, submit
// a command, kill a process). A crash cell runs the scenario with a crash trigger in `roadmap start`'s
// environment, so it reaches the supervisor, the executor and the runners alike; only the executor reaches
// an executor label. When the executor has fired it, the supervisor backs off 2 s and restarts it, and the
// restarted executor runs its startup smoke again. The fakes consume steps strictly in order, so the
// supervisor stops itself (SIGSTOP, pm-stop.ts) once the trigger has fired, before its backoff ends; the
// watcher then waits until every backend call the dead executor had started has reached the fake (its
// runner lives on), inserts the smoke's steps there, dropping the dead executor's unmade smoke calls, and
// lets the supervisor go on (SIGCONT). Nothing but that delay changes: the restart itself is the
// supervisor's own.
//
// A recording run (pm-record.ts) runs the same scenario uncrashed and lists every crash point each roadmap
// process reached, and how often: the cells of a scenario are its executor's labels at occurrence 1, and 2
// where the label repeats.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, scan, statOf } from '../../src/contain/proc.ts';
import { arcId, invocationId } from '../../src/core/ids.ts';
import type { ProcIdentity } from '../../src/core/records.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { type ExitReason } from '../../src/executor.ts';
import { lastGeneration } from '../../src/host/lock.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { RESOLVE_DIRECTIVE } from '../../src/prompts/directives.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { BACKOFF_MS, executorLogs, lastLine } from '../../src/supervisor.ts';
import { reached, release } from '../helpers/barrier.ts';
import { type Exit, fixture, runUntilExit } from '../helpers/proc.ts';
import type { Owner } from '../helpers/reap.ts';
import { type FileSet, tmpDir } from '../helpers/repo.ts';
import { type CodexAct, type Step, readCalls } from '../helpers/scenario.ts';
import { type ExecOptions, type ExecRun, SMOKE_DEFAULT, cli, execEnv, journalOf, setupExec, until } from './exec-common.ts';
import { claimOf, ownerOf } from './sup-common.ts';
import { type LaneJson, planCheckStep } from './stage-common.ts';
import {
  ADD_BROKEN, ADD_FIXED, MUL, SUITE_LANE, U1, appendSteps, codexStep, gateStep, literal, mulBuild, outcomes, workDirPattern,
} from './unit-common.ts';

/** How long one supervised run (all its starts and restarts) may take before the cell calls it hung. */
export const RUN_TIMEOUT_MS = 300_000;
const POLL_MS = 25;
/** How long the watcher waits on the crashed generation's supervisor and executor: many backoffs, for a loaded host. */
const CRASH_WAIT_MS = 15 * BACKOFF_MS[0];

// ---------------------------------------------------------------------------------------------------
// Scenarios

/** What the watcher does for a scenario, once, when `when` first holds. */
export type Hook = Readonly<{ name: string; when: () => boolean; act: () => Promise<void> }>;

export type Scenario = Readonly<{
  /** The arc; `barriers` is a directory of this run for lane barriers (pm-lane-barrier.ts). */
  arc: (barriers: string) => Omit<ExecOptions, 'steps'>;
  /** Edits the laid-out arc's files before its steps are written (the holistic scenario's vision and obligations). */
  prepare?: (r: ExecRun) => void;
  /** The backend steps after the startup smoke, once the arc is laid out (steps may name its run dir). */
  steps: (r: ExecRun) => readonly Step[];
  hooks: (r: ExecRun, barriers: string) => readonly Hook[];
}>;

export type Laid = Readonly<{ r: ExecRun; barriers: string; hooks: readonly Hook[] }>;

/** Lays out `s` for test `t`, which owns its processes (exec-common's setupExec). */
export function layout(t: Owner, s: Scenario): Laid {
  const barriers = tmpDir('pm-barriers');
  const r = setupExec(t, { ...s.arc(barriers), steps: [] });
  s.prepare?.(r);
  appendSteps(r, [...SMOKE_DEFAULT, ...s.steps(r)]);
  return { r, barriers, hooks: s.hooks(r, barriers) };
}

const MUL_WRONG = 'export function mul(a, b) {\n  return a + b;\n}\n';
const MUL_NAMED = 'export function mul(multiplier, multiplicand) {\n  return multiplier * multiplicand;\n}\n';
const TWO = {
  'src/two.js': 'export const two = 2;\n',
  'test/two.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { two } from '../src/two.js';\n\ntest('two', () => {\n  assert.equal(two, 2);\n});\n",
} as const;
const TWO_LANE: LaneJson = { id: 'two', argv: ['node', '--test', 'test/two.test.js'] };
/** u2's own change to add (it conflicts with TIP_ADD). */
const UNIT_ADD = 'export function add(a, b) {\n  return a + b; // unit u2\n}\n';
/** Integration's change to add while u2 is gated: green, and in conflict with UNIT_ADD. */
const TIP_ADD = 'export function add(a, b) {\n  return b + a; // integration\n}\n';
const DIRECTIVE = 'Name the parameters multiplier and multiplicand.';
const DECISION = { id: 'D1', text: 'mul multiplies with the * operator.' };
const NOTES = { 'NOTES.md': 'Unrelated work that landed first.\n' };

/** A build that parks at barrier `name` before doing anything (a cancel or a kill ends it there). */
const blockedBuild = (name: string, after: readonly CodexAct[] = []): Step =>
  codexStep([{ type: 'barrier', name, timeoutMs: 120_000 }, ...after], { argv: ['exec', '-C'] });

/** The fix round's pattern for a failing lane's output dir of `unit`'s spec series. */
const laneOutput = (r: ExecRun, unit: string, lane: string): string => `(${literal(r.runDir)}\\/evidence\\/${unit}\\/[0-9]+-lanes\\/${lane}\\/output\\/files)`;
const suiteOutput = (r: ExecRun, unit: string): string => `(${literal(r.runDir)}\\/evidence\\/${unit}\\/[0-9]+-candidate\\/candidate\\/suite\\/output\\/files)`;

/** Fires once `name` is reached at the fake's barrier dir: `act`, then the release. */
const atBarrier = (dir: string, name: string, act: () => void | Promise<void>): Hook => ({
  name, when: () => existsSync(join(dir, `${name}.reached`)), act: async () => {
    await act();
    release(dir, name);
  },
});

/**
 * One unit straight through, touching every executor-owned op kind but merge-in: a declared resource
 * (probe, run, teardown), decisions.json appended by an executor spec.patch, work left uncommitted for
 * salvage to commit, a spec lane, the suite on the candidate, ff, snapshot, retire.
 */
export const STRAIGHT: Scenario = {
  arc: () => ({ resource: true }),
  steps: (r) => [
    planCheckStep({ decision: 'approve' }),
    codexStep([
      { type: 'writeToPrompt', pattern: workDirPattern(r), file: 'decisions.json', text: JSON.stringify({ decisions: [DECISION] }) },
      { type: 'dirty', files: MUL },
    ], { argv: ['exec', '-C'] }),
    gateStep({ decision: 'approve' }),
  ],
  hooks: () => [],
};
export const STRAIGHT_OUTCOMES = {
  u1: ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'],
} as const;

/**
 * Two units that take every bumpy branch within the chargeable bound (3 per unit). u1: a redirect, a red
 * lane and its fix round (reading the lane's evidence), a gate revise and its fix round (with the
 * directive). u2: integration advanced under it while it is gated (a conflicting change to add), so the
 * candidate conflicts, the merge-in leaves MERGE_HEAD, the resolve round commits a resolution that breaks
 * add; the unit is gated again, its candidate is red while T alone is green, the fix round reads the
 * suite's evidence, a fresh gate approves, and the candidate publishes.
 */
export const BUMPY: Scenario = {
  // u2 is gated after u1 merged: the explicit edge the serial story meant (an M2 arc schedules a DAG).
  arc: () => ({ units: [{ id: 'u1' }, { id: 'u2', lanes: [TWO_LANE], after: ['u1'] }] }),
  steps: (r) => [
    planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'decisions', item: DECISION }] }),
    { ...planCheckStep({ decision: 'approve' }), expect: { ...planCheckStep({ decision: 'approve' }).expect, stdinContains: [DECISION.text] } },
    codexStep([{ type: 'dirty', files: { ...MUL, 'src/mul.js': MUL_WRONG } }], { argv: ['exec', '-C'] }),
    codexStep([
      { type: 'readFromPrompt', pattern: laneOutput(r, 'u1', 'mul'), file: 'stdout', contains: 'MUL-MARKER' },
      { type: 'commit', message: 'fix mul', files: { 'src/mul.js': MUL['src/mul.js'] } },
    ], { argv: ['exec', 'resume'] }),
    gateStep({ decision: 'revise', directives: [DIRECTIVE] }),
    codexStep([{ type: 'dirty', files: { 'src/mul.js': MUL_NAMED } }], { argv: ['exec', 'resume'], stdinContains: [DIRECTIVE] }),
    gateStep({ decision: 'approve' }),

    planCheckStep({ decision: 'approve' }),
    codexStep([{ type: 'commit', message: 'add two', files: { ...TWO, 'src/add.js': UNIT_ADD } }], { argv: ['exec', '-C'] }),
    gateStep({ decision: 'approve' }, {}, [{ type: 'barrier', name: 'advance', timeoutMs: 120_000 }]),
    codexStep([{ type: 'commit', message: 'resolve the merge', files: { 'src/add.js': ADD_BROKEN } }], { argv: ['exec', 'resume'], stdinContains: [RESOLVE_DIRECTIVE] }),
    gateStep({ decision: 'approve' }),
    codexStep([
      { type: 'readFromPrompt', pattern: suiteOutput(r, 'u2'), file: 'stdout', contains: 'ADD-MARKER' },
      { type: 'commit', message: 'fix add', files: { 'src/add.js': ADD_FIXED } },
    ], { argv: ['exec', 'resume'] }),
    gateStep({ decision: 'approve' }),
  ],
  hooks: (r) => [atBarrier(r.scenarioDir, 'advance', () => void advanceIntegration(r.repo, { 'src/add.js': TIP_ADD }, 'integration changes add'))],
};
const BUILT = ['build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'] as const;
export const BUMPY_OUTCOMES = {
  u1: [
    'plan-check:redirect', 'plan-check:approve', ...BUILT, 'lanes:red', ...BUILT, 'lanes:green', 'gate:revise', ...BUILT, 'lanes:green', 'gate:approve',
    'candidate:green', 'ff:published', 'snapshot:published',
  ],
  u2: [
    'plan-check:approve', ...BUILT, 'lanes:green', 'gate:approve', 'candidate:conflict', ...BUILT, 'lanes:green', 'gate:approve', 'candidate:red',
    ...BUILT, 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published',
  ],
} as const;

/** The gate's first answer is not JSON: its one uncharged retry approves. */
export const MALFORMED: Scenario = {
  arc: () => ({}),
  steps: () => [planCheckStep({ decision: 'approve' }), mulBuild(), { ...gateStep({ decision: 'approve' }), acts: [{ type: 'malformed' }] }, gateStep({ decision: 'approve' })],
  hooks: () => [],
};
export const MALFORMED_OUTCOMES = {
  u1: ['plan-check:approve', ...BUILT, 'lanes:green', 'gate:malformed', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'],
} as const;

/**
 * `pause u1` mid-build cancels the build (proc.kill{pause}); `resume u1`, once, when the cancelled call is
 * closed and nothing is open (the pause is what the executor waits on), runs the build again. A crashed
 * executor's restart closes the call in recovery but records `build:interrupted` only when the driver next
 * steps the unit, which the pause defers: so the resume is keyed on the closed call, not on that outcome.
 * A unit held again after the resume would wait for a second one that never comes: that fails at once.
 */
export const CANCEL: Scenario = {
  arc: () => ({}),
  steps: () => [planCheckStep({ decision: 'approve' }), blockedBuild('build1'), mulBuild(), gateStep({ decision: 'approve' })],
  hooks: (r) => {
    const cancelledClosed = (): boolean => {
      if (!existsSync(join(r.runDir, 'events.jsonl'))) return false;
      const { view } = journalOf(r);
      const build = view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
      return build !== undefined && view.doneOf(build.op) !== null && view.openIntents().length === 0 && view.control().pausedUnits.length === 1;
    };
    const heldAfterResume = (): boolean => {
      if (!existsSync(join(r.runDir, 'events.jsonl'))) return false;
      const { view, events } = journalOf(r);
      const resumed = events.findIndex((e) => e.type === 'fact' && e.fact.kind === 'resumed');
      return resumed !== -1 && view.unit(U1).status === 'held' && !view.control().pausedUnits.includes(U1);
    };
    return [
      { name: 'pause', when: () => existsSync(join(r.scenarioDir, 'build1.reached')), act: async () => void (await cli(r, ['pause', 'u1'])) },
      { name: 'resume', when: cancelledClosed, act: async () => void (await cli(r, ['resume', 'u1'])) },
      {
        name: 'held-after-resume', when: heldAfterResume, act: async () => {
          throw new Error(`u1 is held after its resume, waiting for another: ${outcomes(r).join(' ')}`);
        },
      },
    ];
  },
};
export const CANCEL_OUTCOMES = { u1: ['plan-check:approve', 'build:interrupted', ...STRAIGHT_OUTCOMES.u1.slice(1)] } as const;

/** Straight, for a crash inside ff while integration is moved under the dead executor (`whileDown`). */
export const STALE: Scenario = {
  arc: () => ({}),
  steps: () => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
  hooks: () => [],
};

/**
 * Integration moved by someone else while the candidate's suite runs (a suite lane waits at a barrier the
 * watcher releases after the move): the green candidate is stale at ff, so a fresh candidate publishes,
 * with no new gate.
 */
export const STALE_LANE: Scenario = {
  arc: (barriers) => ({
    suite: [SUITE_LANE, { id: 'advance', argv: [process.execPath, fixture('pm-lane-barrier.ts'), barriers, 'suite'] }],
  }),
  steps: STALE.steps,
  hooks: (r, barriers) => [atBarrier(barriers, 'suite', () => void advanceIntegration(r.repo, NOTES, 'unrelated work lands first'))],
};
export const STALE_OUTCOMES = {
  u1: [...STRAIGHT_OUTCOMES.u1.slice(0, 9), 'ff:cas-stale', 'candidate:green', 'ff:published', 'snapshot:published'],
} as const;
export const moveIntegration = (r: ExecRun): string => advanceIntegration(r.repo, NOTES, 'unrelated work lands first');

/** The build parks at barrier build1 for the test to kill a process; `after` is what it does once released. */
export const blockedAt = (after: readonly CodexAct[] = []): Step => blockedBuild('build1', after);
export { SMOKE_DEFAULT };

// ---------------------------------------------------------------------------------------------------
// Integration moved by someone else

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function gitIn(repo: string, args: readonly string[], env: NodeJS.ProcessEnv = GIT_ENV, input?: string): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, input });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${repo} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * A commit of `files` on top of main, made with plumbing in a temporary index (the repo's own checkout is
 * stale once the executor has published, and a worktree would sit beside the executor's), then main moved
 * to it by CAS. Returns the new tip.
 */
export function advanceIntegration(repo: string, files: FileSet, message: string): string {
  const old = gitIn(repo, ['rev-parse', 'refs/heads/main']);
  const env = { ...GIT_ENV, GIT_INDEX_FILE: join(tmpDir('pm-index'), 'index') };
  gitIn(repo, ['read-tree', old], env);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) throw new Error(`advanceIntegration only adds or changes files, not ${path}`);
    const blob = gitIn(repo, ['hash-object', '-w', '--stdin'], env, content);
    gitIn(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], env);
  }
  const tree = gitIn(repo, ['write-tree'], env);
  const next = gitIn(repo, ['commit-tree', tree, '-p', old, '-m', message], env);
  gitIn(repo, ['update-ref', 'refs/heads/main', next, old]);
  return next;
}

// ---------------------------------------------------------------------------------------------------
// The supervised run and its watcher

export type RunOptions = Readonly<{
  /** Crash trigger path (ROADMAP_TEST_CRASH): the supervisor stops itself once it fires (pm-stop.ts) for the watcher. */
  trigger?: string;
  /** Recording file (PM_RECORD): every roadmap process runs with pm-record.ts. */
  record?: string;
  /** Done while the crashed executor is down (the supervisor stopped), after the scenario is adjusted. */
  whileDown?: (r: ExecRun) => void;
  /** Extra arguments to `roadmap start`. */
  startArgs?: readonly string[];
  /**
   * Every step but the startup smoke is keyed to a unit (concurrent units, helpers/scenario.ts): the consumed
   * steps are then not a prefix of the file, so the restarted executor's smoke steps are appended instead of
   * inserted after the calls made so far (the fakes take unkeyed steps in file order, keyed ones per unit).
   */
  keyed?: true;
}>;

export type Supervised = Readonly<{ start: Exit; firstGeneration: number | null }>;

/**
 * `roadmap start` of the laid-out arc, and the watcher, until the start has returned and the supervisor it
 * launched (if it got as far as a claim) has exited. Every hook still pending keeps its turn on later runs
 * of the same arc: pass the same `Laid`.
 */
export async function supervisedRun(laid: Laid, opts: RunOptions = {}, fired: Set<string> = new Set()): Promise<Supervised> {
  const { r } = laid;
  const preloads = [...(opts.trigger === undefined ? [] : ['pm-stop.ts']), ...(opts.record === undefined ? [] : ['pm-record.ts'])];
  const env: NodeJS.ProcessEnv = {
    ...execEnv(r),
    ...(opts.trigger === undefined ? {} : { ROADMAP_TEST_CRASH: opts.trigger }),
    ...(opts.record === undefined ? {} : { PM_RECORD: opts.record }),
    ...(preloads.length === 0 ? {} : { NODE_OPTIONS: preloads.map((f) => `--import=${pathToFileURL(fixture(f)).href}`).join(' ') }),
  };
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let startExit: Exit | null = null;
  let failure: unknown = null;
  const start = runUntilExit(process.execPath, [fixture('exec-cli.ts'), r.hostDir, 'start', '--repo', r.repo, '--plan', r.planPath, ...(opts.startArgs ?? [])], {
    env, timeoutMs: RUN_TIMEOUT_MS,
  }).then((e) => {
    startExit = e;
  }, (e: unknown) => {
    failure = e;
  });

  let watchFailure: unknown = null;
  let supervisor: ProcIdentity | null = null;
  let generation: number | null = null;
  let crashHandled = false;
  // A dead claim left by an earlier run of the arc (a killed host) is not this start's.
  const earlier = lastGeneration(absPath(r.hostDir));
  const seeClaim = (): void => {
    if (supervisor !== null) return;
    const claim = claimOf(r);
    if (claim === null || claim.generation <= earlier) return;
    supervisor = claim.supervisor;
    generation = claim.generation;
  };
  // Done once start has returned and the supervisor it launched is gone (or it never claimed: a refusal).
  const finished = (): boolean => {
    if (failure !== null || watchFailure !== null) return true;
    if (startExit === null) return false;
    seeClaim();
    return supervisor === null || !isAlive(supervisor);
  };

  const crashes = (async () => {
    while (!finished()) {
      if (Date.now() >= deadline) throw new Error(`the supervised run of ${r.arc} outlived ${RUN_TIMEOUT_MS} ms`);
      seeClaim();
      if (opts.trigger !== undefined && !crashHandled && existsSync(`${opts.trigger}.fired`)) {
        crashHandled = true;
        if (supervisor === null || generation === null) throw new Error('the crash trigger fired before the watcher saw the supervisor\'s claim');
        await restartAdjusted(r, supervisor, generation, opts.whileDown, opts.keyed === true);
      }
      await sleep(POLL_MS);
    }
  })();
  const hooks = (async () => {
    while (!finished()) {
      for (const h of laid.hooks) {
        if (fired.has(h.name) || !h.when()) continue;
        fired.add(h.name);
        await h.act();
      }
      await sleep(POLL_MS);
    }
  })();
  const watched = (p: Promise<void>): Promise<void> => p.catch((e: unknown) => {
    watchFailure ??= e;
  });
  await Promise.all([watched(crashes), watched(hooks), start]);
  // A failed cell's processes are its test's teardown's to stop (layout's owner).
  if (watchFailure !== null) throw watchFailure;
  if (failure !== null) throw failure;
  if (startExit === null) throw new Error('roadmap start did not settle');
  return { start: startExit, firstGeneration: generation };
}

/**
 * The executor of `generation` died at its crash point: once its supervisor has stopped itself before the
 * restart (pm-stop.ts), let every backend call the dead executor started reach the fake, adjust the
 * scenario for the restarted executor's smoke, do `whileDown`, then let the supervisor go on.
 */
async function restartAdjusted(r: ExecRun, supervisor: ProcIdentity, generation: number, whileDown: RunOptions['whileDown'], keyed: boolean): Promise<void> {
  try {
    await until(() => statOf(supervisor.pid)?.state === 'T', CRASH_WAIT_MS, `supervisor ${supervisor.pid} to stop itself after generation ${generation}'s crash`);
    const claim = claimOf(r);
    if (claim === null || claim.generation !== generation) {
      throw new Error(`the supervisor had claimed generation ${claim?.generation ?? 'none'} before it stopped for the scenario to be adjusted for generation ${generation}'s crash`);
    }
    // The owner record names the executor before its handshake, so before any executor label; the trigger
    // is renamed before the SIGKILL, so the executor may still be exiting.
    let dead: ProcIdentity | null = null;
    await until(() => {
      const owner = ownerOf(r);
      dead = owner !== null && owner.generation === generation ? owner.executor : null;
      return dead !== null;
    }, CRASH_WAIT_MS, `the executor of generation ${generation}, whose crash trigger fired, in host.owner.json`);
    const executor = dead as unknown as ProcIdentity;
    await until(() => !isAlive(executor), CRASH_WAIT_MS, `executor ${executor.pid} of generation ${generation} to die at its crash point`);
    await settleDeadCalls(r);
    if (keyed) appendSmoke(r);
    else insertSmoke(r);
    whileDown?.(r);
  } finally {
    process.kill(supervisor.pid, 'SIGCONT');
  }
}

/** Every backend call the dead executor started has reached the fake, or its runner and workload are gone. */
async function settleDeadCalls(r: ExecRun): Promise<void> {
  const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
  for (const intent of view.openIntents()) {
    if (intent.kind !== 'proc.spawn') continue;
    const s = intent.expect.subject;
    if (s.purpose !== 'backend' && !(s.purpose === 'smoke' && s.target.type === 'backend')) continue;
    const inv = invocationId(intent.op, intent.ordinal);
    await until(
      () => readCalls(r.scenarioPath).some((c) => c.env['ROADMAP_INV'] === inv) || !scan().some((p) => p.env?.get('ROADMAP_INV') === inv),
      30_000, `the dead executor's backend call ${inv} to reach the fake or end`,
    );
  }
}

/**
 * The restarted executor smokes again: its steps go right after the calls made so far. When the dead
 * executor had not finished its own smoke, its unmade smoke steps are dropped.
 */
function insertSmoke(r: ExecRun): void {
  const calls = readCalls(r.scenarioPath);
  const unmatched = calls.filter((c) => c.step === null);
  if (unmatched.length > 0) throw new Error(`a backend call matched no step before the restart: ${JSON.stringify(unmatched.map((c) => c.argv))}`);
  const file = JSON.parse(readFileSync(r.scenarioPath, 'utf8')) as { steps: Step[] };
  const k = calls.length;
  const steps = [...file.steps.slice(0, k), ...SMOKE_DEFAULT, ...file.steps.slice(Math.max(k, SMOKE_DEFAULT.length))];
  const temp = `${r.scenarioPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ steps }, null, 2)}\n`);
  renameSync(temp, r.scenarioPath);
}

/** The restarted executor smokes again: in a keyed scenario its steps go last (see RunOptions.keyed). */
function appendSmoke(r: ExecRun): void {
  const unmatched = readCalls(r.scenarioPath).filter((c) => c.step === null);
  if (unmatched.length > 0) throw new Error(`a backend call matched no step before the restart: ${JSON.stringify(unmatched.map((c) => c.argv))}`);
  const file = JSON.parse(readFileSync(r.scenarioPath, 'utf8')) as { steps: Step[] };
  if (file.steps.slice(SMOKE_DEFAULT.length).some((s) => s.unit === undefined)) throw new Error('a keyed scenario has an unkeyed step after its smoke');
  const temp = `${r.scenarioPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ steps: [...file.steps, ...SMOKE_DEFAULT] }, null, 2)}\n`);
  renameSync(temp, r.scenarioPath);
}

/** The exit line the arc's last executor printed. */
export function finalReason(r: ExecRun): ExitReason {
  const generation = lastGeneration(absPath(r.hostDir));
  const line = lastLine(executorLogs(absPath(r.hostDir), generation).out);
  if (line === null) throw new Error(`executor generation ${generation} printed no exit line`);
  return JSON.parse(line) as ExitReason;
}

/** The steps the scenario holds now, and whether every backend call matched one of them, each once. */
export function callsMatchSteps(r: ExecRun): Readonly<{ steps: number; calls: number; unmatched: number }> {
  const steps = (JSON.parse(readFileSync(r.scenarioPath, 'utf8')) as { steps: unknown[] }).steps.length;
  const calls = readCalls(r.scenarioPath);
  return { steps, calls: calls.length, unmatched: calls.filter((c) => c.step === null).length };
}

// ---------------------------------------------------------------------------------------------------
// Recording

/** Crash points one run reached: its executors' labels with their per-process counts, and the other processes'. */
export type Recorded = Readonly<{ executor: ReadonlyMap<string, number>; others: ReadonlyMap<string, ReadonlySet<string>> }>;

/** Reads a pm-record.ts file of an uncrashed run: one executor process, whose counts are the occurrences. */
export function readRecord(file: string): Recorded {
  const executor = new Map<string, number>();
  const pids = new Set<string>();
  const others = new Map<string, Set<string>>();
  for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')) {
    const [script, pid, label] = line.split(' ') as [string, string, string];
    if (script === 'executor.ts') {
      pids.add(pid);
      executor.set(label, (executor.get(label) ?? 0) + 1);
    } else {
      others.set(script, (others.get(script) ?? new Set()).add(label));
    }
  }
  if (pids.size !== 1) throw new Error(`a recording run had ${pids.size} executor processes; an uncrashed run has one`);
  return { executor, others };
}

// ---------------------------------------------------------------------------------------------------
// Readers for the kill cells

/** The runner of the arc's open build invocation, from its runner.json. */
export function buildRunner(r: ExecRun): ProcIdentity {
  const intent = journalOf(r).view.openIntents().find((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  if (intent === undefined) throw new Error('no build invocation is open');
  const inv = invocationId(intent.op, intent.ordinal);
  const file = runnerFiles(invocationDir(absPath(r.runDir), inv), inv).read('runner.json');
  if (file === null) throw new Error(`${inv} has no runner.json yet`);
  return file.runner;
}

export { reached, release, until };
