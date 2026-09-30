// Shared by the stage, lane and dispatch tests: one unit `u1` of a fresh arc over a real git repo made from
// test/fixtures/unit-repo (a small Node project whose `add` is deliberately wrong), a plan and spec whose
// lanes are real commands, a resource `db` whose probe and teardown are res-tool.ts, and the fake backends
// behind PATH shims. Also the scenario steps the fakes play and readers for what the run left behind.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionContainment } from '../../src/contain/session.ts';
import type { Event, Fact, IntentOf } from '../../src/core/events.ts';
import { type Sha, type UnitId, arcId, invocationId, planRev, sha, unitId } from '../../src/core/ids.ts';
import type { Journal } from '../../src/core/interfaces.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import { atomicJson } from '../../src/core/fsx.ts';
import { type LaunchFile, RUNNER_FILE_READERS, type RunStart } from '../../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../../src/core/values.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import { START_FILE } from '../../src/executor.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { keepInputFiles, readInputFiles } from '../../src/input/inforce.ts';
import { type PlanM1, type PlanUnit, parsePlan } from '../../src/input/plan.ts';
import { type Cancelled, type Pinned, type StageContext, isCancelled } from '../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { reserveNow } from '../../src/pipeline/lanes.ts';
import { rankOf } from '../../src/schedule/ready.ts';
import { resolveRouting } from '../../src/routing/layers.ts';
import type { ProfileName, RiskTier } from '../../src/routing/types.ts';
import { fixture } from '../helpers/proc.ts';
import { git, makeRepo, revParse, tmpDir } from '../helpers/repo.ts';
import { type Expect, type Scenario, type Step, writeScenario } from '../helpers/scenario.ts';
import { arcFor, events } from './invoke-specs.ts';
import type { CommandContext } from '../../src/commands/apply.ts';
import { readHostSample } from '../../src/host/sample.ts';
import { createProber } from '../../src/park/probe.ts';
import type { Gate } from '../../src/pipeline/unit.ts';

export const U1: UnitId = unitId('u1');
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
  tier?: 'fast' | 'estate';
  resources?: readonly string[];
  evidenceGlobs?: readonly string[];
  evidenceExcludes?: readonly string[];
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
  /** An arc started on M2 (`scheduling: 'dag'`: `@cpu` entry reservations); default a legacy arc's first revision. */
  dag?: true;
}>;

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
    tier: l.tier ?? 'fast', resources: l.resources ?? [], evidenceGlobs: l.evidenceGlobs ?? [],
    ...(l.evidenceExcludes === undefined ? {} : { evidenceExcludes: l.evidenceExcludes }), state: 'active',
  };
}

/**
 * Writes start.json as the executor does before any stage runs (src/executor.ts `runExecutor`): generation 1, the
 * repo, the plan file and the profile. A snapshot rebuilds a 1.0.0-dev.5 revision's routing provenance from it (H7).
 */
function writeStart(runDir: AbsPath, repo: AbsPath, planPath: AbsPath, profile: ProfileName): void {
  const start: RunStart = { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo, planFile: planPath, profile };
  atomicJson(join(runDir, START_FILE), start);
}

/**
 * Records the plan file as revision 1 of a legacy arc (no `scheduling`), as 1.0.0-dev.4 did: the serial
 * frontier and no `@cpu` requests. Tests of one serial unit keep this default; a first start on M2 records a DAG.
 */
export function recordLegacyPlan(journal: Journal, runDir: AbsPath, planPath: AbsPath, repo: AbsPath, profile: ProfileName = 'default'): void {
  writeStart(runDir, repo, planPath, profile);
  const manifest = keepInputFiles(runDir, readInputFiles(planPath));
  journal.fact({ kind: 'plan-applied', rev: planRev(1), command: null, ...manifest, changes: [] });
}

/** Records the plan file as revision 1 of an arc started on M2 (`scheduling: 'dag'`), as an M2 first start does. */
export function recordDagPlan(journal: Journal, runDir: AbsPath, planPath: AbsPath, repo: AbsPath, profile: ProfileName = 'default'): void {
  writeStart(runDir, repo, planPath, profile);
  const manifest = keepInputFiles(runDir, readInputFiles(planPath));
  journal.fact({ kind: 'plan-applied', rev: planRev(1), command: null, ...manifest, changes: [], scheduling: 'dag' });
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
  makeRepo(repo, { files: {} });
  const base = sha(revParse(repo, 'HEAD'));

  const planDir = tmpDir('stage-plan');
  const specPath = join(planDir, 'u1.json');
  writeFileSync(specPath, JSON.stringify({
    schema: 'roadmap/spec-m1', unit: U1, rev: 1,
    lanes: (opts.lanes ?? [UNIT_LANE]).map(laneJson),
    acceptance: [{ id: 'A1', clause: 'add(1, 2) is 3', failLoudIfUndelivered: true, state: 'active' }],
    scope: ['src/**', 'test/**'], resources: opts.resources ?? [], decisions: [], facts: [],
    cites: { contracts: ['contracts/api.md'], rulings: ['C-1'] },
  }));
  cpSync(RULINGS, join(planDir, 'rulings.md'));

  const stateDir = tmpDir('stage-res');
  const tool = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, DB], cwd: '.', env: { set: {}, pass: ['PATH'] } });
  const arc = arcFor();
  const planPath = absPath(join(planDir, 'plan.json'));
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: base, worktreeRoot: tmpDir('stage-wt'),
    contracts: ['contracts/api.md'], rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md', direction: 'Keep it small.',
    suite: { lanes: [] }, resources: [{ name: DB, probe: tool('probe'), teardown: tool('teardown') }],
    units: [{ id: U1, spec: 'u1.json', risk: opts.risk ?? 'med', scope: ['src/**', 'test/**'], resources: opts.resources ?? [] }],
  }));
  const plan: PlanM1 = parsePlan(JSON.parse(readFileSync(planPath, 'utf8')));
  const unit = plan.units[0]!;

  const runDir = tmpDir('stage-run');
  const journal = openJournal(absPath(runDir), arcId(arc));
  // As a first start does: the files become the plan in force (rev 1), whose spec the stages load.
  if (opts.dag === true) recordDagPlan(journal, absPath(runDir), planPath, absPath(repo), opts.profile);
  else recordLegacyPlan(journal, absPath(runDir), planPath, absPath(repo), opts.profile);
  const scenario = writeScenario(tmpDir('stage-scenario'), opts.steps);
  const routing = resolveRouting({ profile: opts.profile ?? 'default', classes: null, repoConfig: null, plan: null, unit: null });
  const resources = {
    journal, containment: sessionContainment, runDir: absPath(runDir), plan: () => plan, repo: absPath(repo),
    hostDir: openHostDir(absPath(join(tmpDir('stage-host'), 'roadmap'))),
  };
  const ctx: StageContext = {
    ...resources,
    routing: () => routing,
    hostEnv: { ...process.env, PATH: `${scenario.binDir}:${process.env['PATH'] ?? ''}` },
    planDir: absPath(planDir),
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
}>;

/** A plan-check the fake Claude answers: a judgment call (read-only tools, fresh session, no resume). `expect` adds to that check. */
export function planCheckStep(a: PlanCheckAnswer, expect: Expect = {}): Step {
  const argv = ['-p', '--tools', 'Read,Grep,Glob', '--session-id', '--no-session-persistence', ...(expect.argv ?? [])];
  return {
    as: 'claude',
    expect: { ...expect, argv, argvLacks: ['--resume', '--permission-mode'] },
    acts: [{
      type: 'emit',
      value: { decision: a.decision, reasons: ['C-1 holds'], patch: a.patch ?? null, risk: a.risk ?? 'med', notes: a.notes ?? '', premises: [...(a.premises ?? [])], visionConflict: [] },
    }],
  };
}

export const BUILD_REPORT = { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [] } as const;

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
