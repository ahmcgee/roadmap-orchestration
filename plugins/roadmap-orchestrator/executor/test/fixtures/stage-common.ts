// Shared by the stage, lane and dispatch tests: one unit `u1` of a fresh arc over a real git repo made from
// test/fixtures/unit-repo (a small Node project whose `add` is deliberately wrong), a plan and spec whose
// lanes are real commands, a resource `db` whose probe and teardown are res-tool.ts, and the fake backends
// behind PATH shims. Also the scenario steps the fakes play and readers for what the run left behind.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionContainment } from '../../src/contain/session.ts';
import type { Event, Fact, IntentOf } from '../../src/core/events.ts';
import { type Sha, type Sha256Hex, type UnitId, arcId, invocationId, sha, specRev, unitId } from '../../src/core/ids.ts';
import type { Journal } from '../../src/core/interfaces.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import { atomicJson } from '../../src/core/fsx.ts';
import { type LaunchFile, RUNNER_FILE_READERS, type RunStart } from '../../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../../src/core/values.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { START_FILE } from '../../src/executor.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { keepCorpusFiles, readInputFiles, recordPlan } from '../../src/input/inforce.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../../src/phase0/rows.ts';
import { type PlanM1, type PlanUnit, parsePlan } from '../../src/input/plan.ts';
import { type Cancelled, type Pinned, type StageContext, isCancelled } from '../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { reserveNow } from '../../src/pipeline/lanes.ts';
import { rankOf } from '../../src/schedule/ready.ts';
import { type RepoConfig, parseRepoConfig, resolveRouting } from '../../src/routing/layers.ts';
import type { ProfileName, RiskTier } from '../../src/routing/types.ts';
import { fixture } from '../helpers/proc.ts';
import { git, makeRepo, revParse, tmpDir } from '../helpers/repo.ts';
import { type ClaudeAct, type Expect, type Scenario, type Step, writeScenario } from '../helpers/scenario.ts';
import { arcFor, events } from './invoke-specs.ts';
import type { CommandContext } from '../../src/commands/apply.ts';
import { readHostSample } from '../../src/host/sample.ts';
import { createProber } from '../../src/park/probe.ts';
import type { Gate } from '../../src/pipeline/unit.ts';

export const U1: UnitId = unitId('u1');
/** The unit's kept spec at rev 1, as its first start recorded it: what a test pins a dispatch at. */
export const keptSpec = (journal: Readonly<{ view: Readonly<{ planApplied: () => { specs: Readonly<Record<UnitId, Sha256Hex>> } | null }> }>, unit: UnitId = U1) =>
  ({ rev: specRev(1), sha256: journal.view.planApplied()!.specs[unit]! });
export const DB = 'db';
const REPO_FILES = fileURLToPath(new URL('./unit-repo/', import.meta.url));
const RULINGS = fileURLToPath(new URL('./unit-rulings.md', import.meta.url));

/** Generous per-scenario test timeout: every stage spawns real processes polled at up to 500 ms. */
export const SCENARIO_TIMEOUT_MS = 180_000;

/** A spec lane as spec.json writes it. */
export type LaneJson = Readonly<{
  id: string;
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<{ set?: Readonly<Record<string, string>>; pass?: readonly string[] }>;
  expectedExit?: number;
  /** The dev.16 form (default `fast` when no cadence is given). */
  tier?: 'fast' | 'estate';
  /** dev.17: written instead of `tier` when given. */
  cadence?: 'build' | 'unit' | 'candidate' | 'batch';
  resources?: readonly string[];
  evidenceGlobs?: readonly string[];
  evidenceExcludes?: readonly string[];
  /** M4a rev 3 (F1a): a spec lane's inputs (dev.16; dropped on read since dev.17). */
  inputs?: readonly string[];
  /** dev.17: the plan environment the lane runs against. */
  environment?: string;
  /** dev.17: the lane topology fields. */
  systems?: readonly string[];
  testArgv?: readonly string[];
  stochastic?: Readonly<{ runs: number; minPasses: number }>;
}>;

/** The fixture's own test lane: fails until `add` is fixed, printing ADD-MARKER. */
export const UNIT_LANE: LaneJson = { id: 'unit', argv: ['node', '--test', 'test/add.test.js'] };

export type SetupOptions = Readonly<{
  steps: readonly Step[];
  lanes?: readonly LaneJson[];
  risk?: RiskTier;
  /** The unit's declared resources (each is a res-tool resource). */
  resources?: readonly string[];
  profile?: ProfileName;
  /** The repo's .gitignore; default `out/`. */
  gitignore?: string;
  /** The plan's suite lanes (default none). */
  suite?: readonly LaneJson[];
  /** Files the base commit holds beside the fixture repo's (default none). */
  files?: Readonly<Record<string, string>>;
  /** The plan's `derived` entries as plan.json writes them (default none). */
  derived?: readonly JsonValue[];
  /** dev.17: the plan's `environments` as plan.json writes them (default none). */
  environments?: Readonly<Record<string, JsonValue>>;
  /** The plan's routing layer as plan.json writes it (default none): e.g. `HIGH_BUILDS_ON_FRONTIER`. */
  routing?: JsonValue;
  /** dev.17: the repo config's `systemsMap` the first revision records (default none). */
  systemsMap?: JsonValue;
  /** dev.17: the spec's `forces` (default none). */
  forces?: readonly string[];
}>;

/**
 * A plan routing layer seating build.high on frontier (Opus, Claude), as the built-in seats did before dev.17 (every build
 * seat efficient since): for tests of a risk raise that moves the implementer onto another binding.
 */
export const HIGH_BUILDS_ON_FRONTIER: JsonValue = { build: { high: 'frontier' } };

export type StageRun = Readonly<{
  ctx: StageContext;
  journal: OpenJournal;
  unit: PlanUnit;
  repo: AbsPath;
  runDir: AbsPath;
  planDir: AbsPath;
  specPath: AbsPath;
  base: Sha;
  scenario: Scenario;
  stateDir: string;
  /** A scratch dir outside every tree, for lanes to log into. */
  scratch: string;
}>;

function laneJson(l: LaneJson): Record<string, unknown> {
  return {
    id: l.id, argv: l.argv, cwd: l.cwd ?? '.', env: { set: l.env?.set ?? {}, pass: l.env?.pass ?? ['PATH'] }, expectedExit: l.expectedExit ?? 0,
    ...(l.cadence === undefined ? { tier: l.tier ?? 'fast' } : { cadence: l.cadence }), resources: l.resources ?? [], evidenceGlobs: l.evidenceGlobs ?? [],
    ...(l.evidenceExcludes === undefined ? {} : { evidenceExcludes: l.evidenceExcludes }), ...(l.inputs === undefined ? {} : { inputs: l.inputs }),
    ...(l.systems === undefined ? {} : { systems: l.systems }), ...(l.testArgv === undefined ? {} : { testArgv: l.testArgv }),
    ...(l.stochastic === undefined ? {} : { stochastic: l.stochastic }), ...(l.environment === undefined ? {} : { environment: l.environment }),
    state: 'active',
  };
}

/** A suite lane as plan.json writes it: a spec lane's shape without its item state. */
function suiteLaneJson(l: LaneJson): Record<string, unknown> {
  const { state: _state, ...lane } = laneJson(l);
  return lane;
}

/**
 * Writes start.json as the executor does before any stage runs (src/executor.ts `runExecutor`): generation 1, the
 * repo, the plan file and the profile.
 */
export function writeStart(runDir: AbsPath, repo: AbsPath, planPath: AbsPath, profile: ProfileName): void {
  const start: RunStart = { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo, planFile: planPath, profile };
  atomicJson(join(runDir, START_FILE), start);
}

/**
 * Records the plan file as revision 1 (`scheduling: 'dag'`), as a first start does (src/input/inforce.ts `recordPlan`). A
 * corpus arc's files pass the shared Phase-0 rows first, which open its corpus source, and its corpus files are kept.
 */
export function recordFirstPlan(journal: Journal, runDir: AbsPath, planPath: AbsPath, repo: AbsPath, profile: ProfileName = 'default', config: RepoConfig | null = null): void {
  writeStart(runDir, repo, planPath, profile);
  const files = readInputFiles(planPath, repo);
  if (files.corpus !== null) {
    const rows = phase0Rows(phase0InputOf(files, null), APPLY);
    if (rows.rows.length > 0 || rows.opened === null) throw new Error(`the corpus arc's files are refused: ${JSON.stringify(rows.rows)}`);
    keepCorpusFiles(runDir, rows.opened.files);
  }
  recordPlan(journal, runDir, files, [], { profile, config, arcRoles: 'm4b' });
}

/** Puts the run's input files as they are now in force as the next plan revision (an `apply` of, say, an edited ledger). */
export function applyFilesNow(run: StageRun): void {
  recordPlan(run.journal, run.runDir, readInputFiles(absPath(join(run.planDir, 'plan.json')), run.repo), [], { profile: 'default', config: null, arcRoles: 'm4b' });
}

/** A unit driver's gate that admits every stage at once: one unit driven on its own, without the scheduler. */
export const admitAll: Gate = () => Promise.resolve(true);

/** A command context's prober and stop signal, as the executor wires them: the real prober over `ctx`, a signal nothing aborts. */
export function testProbes(ctx: StageContext, profile: ProfileName = 'default'): CommandContext['probes'] {
  return { prober: createProber({ ...ctx, profile, sample: readHostSample }), signal: new AbortController().signal };
}

/**
 * A test context's reservation runtime: one unit in flight, so `reserveNow` (a busy resource fails the test), the
 * log's rank, and a signal nothing aborts (a test that cancels passes its own).
 */
export function serialRuntime(ctx: Parameters<typeof reserveNow>[0]): Pick<StageContext, 'acquire' | 'rank' | 'signal'> {
  return { acquire: reserveNow(ctx), rank: (unit) => rankOf(ctx.journal.view, ctx.plan(), unit), signal: new AbortController().signal };
}

/** A stage that ran: under a signal nothing aborted, it never returns `cancelled`. */
export function started<T extends object>(done: T | Cancelled): T {
  if (isCancelled(done)) throw new Error(`the stage was cancelled (${done.reason}) under a signal the test never aborted`);
  return done;
}

/** The dispatch of a seat the routing in force allows; a routing-changed park fails the test. */
export function seated<D>(p: Pinned<D>): D {
  if (p.kind !== 'pinned') throw new Error(`expected a pinned dispatch, got ${p.kind}: ${p.needsUser.summary}`);
  return p.dispatch;
}

export function setupUnit(opts: SetupOptions): StageRun {
  const repo = tmpDir('stage-repo');
  cpSync(REPO_FILES, repo, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), opts.gitignore ?? 'out/\n');
  makeRepo(repo, { files: opts.files ?? {} });
  const base = sha(revParse(repo, 'HEAD'));

  const planDir = tmpDir('stage-plan');
  const specPath = join(planDir, 'u1.json');
  writeFileSync(specPath, JSON.stringify({
    schema: 'roadmap/spec-m1', unit: U1, rev: 1,
    lanes: (opts.lanes ?? [UNIT_LANE]).map(laneJson),
    acceptance: [{ id: 'A1', clause: 'add(1, 2) is 3', failLoudIfUndelivered: true, state: 'active' }],
    scope: ['src/**', 'test/**'], resources: opts.resources ?? [], decisions: [], facts: [],
    cites: { contracts: ['contracts/api.md'], rulings: ['C-1'] }, ...(opts.forces === undefined ? {} : { forces: opts.forces }),
  }));
  cpSync(RULINGS, join(planDir, 'rulings.md'));

  const stateDir = tmpDir('stage-res');
  const tool = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, DB], cwd: '.', env: { set: {}, pass: ['PATH'] } });
  const arc = arcFor();
  const planPath = absPath(join(planDir, 'plan.json'));
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: base, worktreeRoot: tmpDir('stage-wt'),
    contracts: ['contracts/api.md'], rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md', direction: 'Keep it small.',
    suite: { lanes: (opts.suite ?? []).map(suiteLaneJson) }, resources: [{ name: DB, probe: tool('probe'), teardown: tool('teardown') }],
    units: [{ id: U1, spec: 'u1.json', risk: opts.risk ?? 'med', scope: ['src/**', 'test/**'], resources: opts.resources ?? [] }],
    ...(opts.derived === undefined ? {} : { derived: opts.derived }),
    ...(opts.environments === undefined ? {} : { environments: opts.environments }),
    ...(opts.routing === undefined ? {} : { routing: opts.routing }),
  }));
  const plan: PlanM1 = parsePlan(JSON.parse(readFileSync(planPath, 'utf8')));
  const unit = plan.units[0]!;

  const runDir = tmpDir('stage-run');
  const journal = openJournal(absPath(runDir), arcId(arc));
  // As a first start does: the files become the plan in force (rev 1), whose spec the stages load.
  const config = opts.systemsMap === undefined ? null : parseRepoConfig({ systemsMap: opts.systemsMap });
  recordFirstPlan(journal, absPath(runDir), planPath, absPath(repo), opts.profile, config);
  const scenario = writeScenario(tmpDir('stage-scenario'), opts.steps);
  const routing = resolveRouting({ profile: opts.profile ?? 'default', classes: null, repoConfig: null, plan: plan.routing ?? null, unit: null });
  const resources = {
    journal, containment: sessionContainment, runDir: absPath(runDir), plan: () => plan, repo: absPath(repo),
    hostDir: openHostDir(absPath(join(tmpDir('stage-host'), 'roadmap'))),
  };
  const ctx: StageContext = {
    ...resources,
    routing: () => routing,
    hostEnv: { ...process.env, PATH: `${scenario.binDir}:${process.env['PATH'] ?? ''}` },
    planDir: absPath(planDir),
    planFile: absPath(planPath),
    routingBase: { profile: opts.profile ?? 'default', config, arcRoles: null },
    ...serialRuntime(resources),
  };
  return { ctx, journal, unit, repo: absPath(repo), runDir: absPath(runDir), planDir: absPath(planDir), specPath: absPath(specPath), base, scenario, stateDir, scratch: tmpDir('stage-scratch') };
}

// ---------------------------------------------------------------------------------------------------
// Scenario steps

export type PlanCheckAnswer = Readonly<{
  decision: 'approve' | 'redirect' | 'infeasible' | 'escalate';
  risk?: RiskTier;
  patch?: readonly JsonValue[];
  notes?: string;
  premises?: readonly JsonValue[];
  /** M3 (R17): vision conflicts the check reports (default none). */
  visionConflict?: readonly Readonly<{ clauses: readonly string[]; note: string }>[];
  /** Scope growth (2026-10-15): proposals the check makes (default none). */
  scopeGrowth?: readonly Readonly<{ patterns: readonly string[]; reason: string }>[];
}>;

/** A plan-check the fake Claude answers: a judgment call (read-only tools, fresh session, no resume). `expect` adds to that check. */
export function planCheckStep(a: PlanCheckAnswer, expect: Expect = {}, before: readonly ClaudeAct[] = []): Step {
  // A judgment's fresh session persists (no --no-session-persistence) so its repair turn can resume it (dev.12: every role).
  const argv = ['-p', '--tools', 'Read,Grep,Glob,Agent', '--session-id', ...(expect.argv ?? [])];
  return {
    as: 'claude',
    expect: { ...expect, argv, argvLacks: ['--resume', '--permission-mode', '--no-session-persistence'] },
    acts: [...before, { type: 'emit', value: planCheckAnswer(a) }],
  };
}

/** A plan-check's answer as the fake emits it. */
export const planCheckAnswer = (a: PlanCheckAnswer): JsonValue =>
  ({ decision: a.decision, reasons: ['C-1 holds'], patch: a.patch ?? null, risk: a.risk ?? 'med', notes: a.notes ?? '', premises: [...(a.premises ?? [])], visionConflict: [...(a.visionConflict ?? [])],
    scopeGrowth: (a.scopeGrowth ?? []).map((g) => ({ patterns: [...g.patterns], reason: g.reason })) }) as JsonValue;

/**
 * 2026-10-15: a plan-check's repair turn: its session resumed (`--resume`) with the reasons its answer was refused, which
 * the stdin carries (`stdinContains` adds to the directive's opening).
 */
export function planCheckRepairStep(a: PlanCheckAnswer, stdinContains: readonly string[] = [], before: readonly ClaudeAct[] = []): Step {
  return {
    as: 'claude',
    expect: { argv: ['-p', '--tools', 'Read,Grep,Glob,Agent', '--resume'], argvLacks: ['--session-id', '--permission-mode', '--no-session-persistence'], stdinContains: ['Your answer was refused: ', ...stdinContains] },
    acts: [...before, { type: 'emit', value: planCheckAnswer(a) }],
  };
}

export const BUILD_REPORT = { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [], experiments: [], final: true } as const;

/** Stdin-matching pattern for a failing lane's stdout/stderr dir of this run, as a fix round lists it. */
export function laneEvidencePattern(run: StageRun, lane: string): string {
  return `(${run.runDir.replaceAll('/', '\\/')}\\/evidence\\/${U1}\\/[0-9]+-lanes\\/${lane}\\/output\\/files)`;
}

// ---------------------------------------------------------------------------------------------------
// Readers

export const worktreeOf = (run: StageRun): AbsPath => absPath(join(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1));

export function facts(run: StageRun): readonly Fact[] {
  return events(run.runDir).flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
}

export const outcomeFacts = (run: StageRun) => facts(run).filter((f) => f.kind === 'stage-outcome');

export function spawnIntents(run: StageRun): readonly (Event & IntentOf<'proc.spawn'>)[] {
  return events(run.runDir).filter((e): e is Event & IntentOf<'proc.spawn'> => e.type === 'intent' && e.kind === 'proc.spawn');
}

/** The launch.json of a spawn intent (its latest ordinal). */
export function launchOf(run: StageRun, intent: IntentOf<'proc.spawn'>): LaunchFile {
  const inv = invocationId(intent.op, intent.ordinal);
  const raw = JSON.parse(readFileSync(join(invocationDir(run.runDir, inv), 'launch.json'), 'utf8')) as unknown;
  return RUNNER_FILE_READERS['launch.json'](raw, 'launch.json');
}

/** Every file under `dir`, recursively, as absolute paths. */
export function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
}

export function headOf(dir: string): Sha {
  return sha(git(dir, 'rev-parse', 'HEAD'));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
