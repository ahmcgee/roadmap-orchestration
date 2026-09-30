// Shared by the gate, integrate and unit driver tests (and the unit-child fixture): an arc over a real git
// repo made from test/fixtures/unit-repo, whose integration tip is green by default (`add` fixed at T) so
// the plan's suite (`node --test`, every test file) passes there. Each unit's job is to add `mul` with its
// test, which its own spec lane runs. Everything a child executor needs to rebuild the same StageContext
// is in an `ArcDescriptor` (plain JSON), and `contextFor` builds it, in the test process or the child.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionContainment } from '../../src/contain/session.ts';
import type { StageOutcomeFact } from '../../src/core/events.ts';
import type { CommandContext } from '../../src/commands/apply.ts';
import { type PlanRev, type UnitId, arcId, unitId } from '../../src/core/ids.ts';
import type { CommandBody } from '../../src/core/records.ts';
import { backendEnv } from '../../src/preflight/smoke.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { type OpenJournal, openJournal, readJournal } from '../../src/core/log.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { readInputFiles, revisionManifestOf } from '../../src/input/inforce.ts';
import { type PlanUnit, parsePlan } from '../../src/input/plan.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import { step } from '../../src/pipeline/unit.ts';
import { DOCS_NOT_YET } from '../../src/recover/revision.ts';
import { resolveRouting } from '../../src/routing/layers.ts';
import type { RiskTier } from '../../src/routing/types.ts';
import { makeRepo, revParse, tmpDir } from '../helpers/repo.ts';
import { type CallRecord, type ClaudeAct, type CodexAct, type Expect, type Step, writeScenario } from '../helpers/scenario.ts';
import { arcFor } from './invoke-specs.ts';
import { BUILD_REPORT, type LaneJson, recordDagPlan, recordLegacyPlan, serialRuntime, testProbes } from './stage-common.ts';

const REPO_FILES = fileURLToPath(new URL('./unit-repo/', import.meta.url));
const RULINGS = fileURLToPath(new URL('./unit-rulings.md', import.meta.url));

export const ADD_FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';
export const ADD_BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
/** What a unit builds: `mul` and its test (the spec lane). */
export const MUL = {
  'src/mul.js': 'export function mul(a, b) {\n  return a * b;\n}\n',
  'test/mul.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { mul } from '../src/mul.js';\n\ntest('mul', () => {\n  assert.equal(mul(2, 3), 6, 'MUL-MARKER');\n});\n",
} as const;

export const MUL_LANE: LaneJson = { id: 'mul', argv: ['node', '--test', 'test/mul.test.js'] };
/** The plan's suite: every test file of the repo (node's default patterns). */
export const SUITE_LANE: LaneJson = { id: 'suite', argv: ['node', '--test'] };

export type UnitSpecJson = Readonly<{ id: string; risk?: RiskTier; lanes?: readonly LaneJson[]; after?: readonly string[] }>;

export type ArcOptions = Readonly<{
  steps: readonly Step[];
  units?: readonly UnitSpecJson[];
  suite?: readonly LaneJson[];
  /** The integration tip's `add`: fixed (green suite at T, the default) or broken (red at T). */
  base?: 'green' | 'red';
  /** An arc started on M2 (`scheduling: 'dag'`: `@cpu` entry reservations); default a legacy arc's first revision. */
  dag?: true;
}>;

/** Everything needed to rebuild the arc's StageContext, as JSON (for a child executor). */
export type ArcDescriptor = Readonly<{
  arc: string;
  repo: string;
  planPath: string;
  runDir: string;
  hostDir: string;
  binDir: string;
  scenarioPath: string;
  scenarioDir: string;
  /** Revision 1 schedules a DAG (`ArcOptions.dag`), as contextFor records it. */
  dag?: true;
}>;

function laneJson(l: LaneJson): Record<string, unknown> {
  return {
    id: l.id, argv: l.argv, cwd: l.cwd ?? '.', env: { set: l.env?.set ?? {}, pass: l.env?.pass ?? ['PATH'] }, expectedExit: l.expectedExit ?? 0,
    tier: l.tier ?? 'fast', resources: l.resources ?? [], evidenceGlobs: l.evidenceGlobs ?? [],
  };
}

/** Lays out the repo, plan, specs, rulings and scenario of a fresh arc; opens nothing. */
export function setupArc(opts: ArcOptions): ArcDescriptor {
  const repo = tmpDir('unit-repo');
  cpSync(REPO_FILES, repo, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'out/\n');
  writeFileSync(join(repo, 'src', 'add.js'), opts.base === 'red' ? ADD_BROKEN : ADD_FIXED);
  makeRepo(repo, { files: {} });

  const planDir = tmpDir('unit-plan');
  const units = opts.units ?? [{ id: 'u1' }];
  for (const u of units) {
    writeFileSync(join(planDir, `${u.id}.json`), JSON.stringify({
      schema: 'roadmap/spec-m1', unit: u.id, rev: 1,
      lanes: (u.lanes ?? [MUL_LANE]).map((l) => ({ ...laneJson(l), state: 'active' })),
      acceptance: [{ id: 'A1', clause: 'mul(2, 3) is 6', failLoudIfUndelivered: true, state: 'active' }],
      scope: ['src/**', 'test/**', 'contracts/**'], resources: [], decisions: [], facts: [],
      cites: { contracts: ['contracts/api.md'], rulings: ['C-1'] },
    }));
  }
  cpSync(RULINGS, join(planDir, 'rulings.md'));
  const arc = arcFor();
  const planPath = join(planDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: revParse(repo, 'main'),
    worktreeRoot: tmpDir('unit-wt'), contracts: ['contracts/api.md'], rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md',
    direction: 'Keep it small.', suite: { lanes: (opts.suite ?? [SUITE_LANE]).map(laneJson) }, resources: [],
    units: units.map((u) => ({
      id: u.id, spec: `${u.id}.json`, risk: u.risk ?? 'med', scope: ['src/**', 'test/**', 'contracts/**'], resources: [], ...(u.after === undefined ? {} : { after: u.after }),
    })),
  }));
  const scenarioDir = tmpDir('unit-scenario');
  const scenario = writeScenario(scenarioDir, opts.steps);
  return {
    arc, repo, planPath, runDir: tmpDir('unit-run'), hostDir: join(tmpDir('unit-host'), 'roadmap'),
    binDir: scenario.binDir, scenarioPath: scenario.path, scenarioDir, ...(opts.dag === true ? { dag: true } : {}),
  };
}

export type ArcRun = Readonly<{ ctx: StageContext; journal: OpenJournal; d: ArcDescriptor; unit: (id: string) => PlanUnit }>;

/** Opens the arc's journal and builds its StageContext (default profile), as the executor would. */
export function contextFor(d: ArcDescriptor): ArcRun {
  const plan = parsePlan(JSON.parse(readFileSync(d.planPath, 'utf8')));
  const journal = openJournal(absPath(d.runDir), arcId(d.arc));
  // As a first start does: the files become the plan in force (rev 1), whose specs the stages load.
  if (journal.view.planApplied() === null) {
    if (d.dag === true) recordDagPlan(journal, absPath(d.runDir), absPath(d.planPath));
    else recordLegacyPlan(journal, absPath(d.runDir), absPath(d.planPath));
  }
  const routing = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null });
  const resources = {
    journal, containment: sessionContainment, runDir: absPath(d.runDir), plan: () => plan, repo: absPath(d.repo),
    hostDir: openHostDir(absPath(d.hostDir)),
  };
  const ctx: StageContext = {
    ...resources,
    routing: () => routing,
    hostEnv: { ...process.env, PATH: `${d.binDir}:${process.env['PATH'] ?? ''}` },
    planDir: absPath(join(d.planPath, '..')),
    ...serialRuntime(resources),
  };
  const unit = (id: string): PlanUnit => {
    const u = plan.units.find((x) => x.id === unitId(id));
    if (u === undefined) throw new Error(`no unit ${id} in the plan`);
    return u;
  };
  return { ctx, journal, d, unit };
}

/**
 * The command context over an arc, as the executor builds it (default profile, routing `stage`'s). `plan()`
 * is the context's own: in these tests it does not follow an apply, which only the log records.
 */
export function commandContextFor(r: ArcRun, stage: StageContext = r.ctx): CommandContext {
  return {
    ...stage, hostEnv: backendEnv(stage.hostEnv), laneEnv: stage.hostEnv, planFile: absPath(r.d.planPath), routing: () => ({ profile: 'default', resolved: stage.routing(null) }),
    routingBase: { profile: 'default', config: null }, docs: DOCS_NOT_YET,
    probes: testProbes(stage),
  };
}

/** An `apply` of the plan and specs as the files hold them now (what `roadmap apply` submits). */
export function applyBody(d: ArcDescriptor, expectRev: PlanRev | null = null): CommandBody {
  const manifest = revisionManifestOf(readInputFiles(absPath(d.planPath)));
  if ('missing' in manifest) throw new Error(manifest.missing.join('; '));
  return { type: 'apply', expectRev, manifest };
}

export const U1: UnitId = unitId('u1');
export const unitWorktreePath = (r: ArcRun, unit: UnitId = U1): AbsPath => absPath(join(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, unit));

// ---------------------------------------------------------------------------------------------------
// Scenario steps

const JUDGMENT: Expect = { argv: ['-p', '--tools', 'Read,Grep,Glob', '--session-id', '--no-session-persistence'], argvLacks: ['--resume', '--permission-mode'] };

export type GateAnswer = Readonly<{
  decision: 'approve' | 'revise' | 'escalate';
  directives?: readonly string[];
  findings?: readonly JsonValue[];
  premises?: readonly JsonValue[];
}>;

/** A gate the fake Claude answers after `before`: a fresh judgment call. `expect` adds to the judgment argv check. */
export function gateStep(a: GateAnswer, expect: Expect = {}, before: readonly ClaudeAct[] = []): Step {
  return {
    as: 'claude',
    expect: { ...JUDGMENT, ...expect, argv: [...(JUDGMENT.argv ?? []), ...(expect.argv ?? [])] },
    acts: [...before, { type: 'emit', value: {
      decision: a.decision, findings: [...(a.findings ?? [])], directives: [...(a.directives ?? [])], reasons: ['A1 holds'], premises: [...(a.premises ?? [])],
    } as JsonValue }],
  };
}

/** A gate call: a Claude judgment whose schema is the gate's (the one with directives), whatever its prompt module. */
export function isGateCall(c: CallRecord): boolean {
  return c.as === 'claude' && (c.argv[c.argv.indexOf('--json-schema') + 1] ?? '').includes('"directives"');
}

/** A Codex implementer round: `acts`, then the report. */
export function codexStep(acts: readonly CodexAct[], expect: Expect = {}): Step {
  return { as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] };
}

/** The fresh build that adds mul (plus `extra` files). */
export function mulBuild(extra: Readonly<Record<string, string>> = {}, acts: readonly CodexAct[] = []): Step {
  return codexStep([...acts, { type: 'commit', message: 'add mul', files: { ...MUL, ...extra } }], { argv: ['exec', '-C'] });
}

/** Appends steps to the arc's scenario before any call: for steps that name the run dir, known only once laid out. */
export function appendSteps(d: ArcDescriptor, steps: readonly Step[]): void {
  const file = JSON.parse(readFileSync(d.scenarioPath, 'utf8')) as { steps: Step[] };
  file.steps.push(...steps);
  writeFileSync(d.scenarioPath, `${JSON.stringify(file, null, 2)}\n`);
}

/** A regex source matching `text` literally. */
export const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Pattern for the build's evidence dir as the build prompt names it (where decisions.json goes). */
export const workDirPattern = (d: ArcDescriptor, unit = 'u1'): string => `(${literal(d.runDir)}\\/work\\/${unit}\\/[0-9]+-build)`;

// ---------------------------------------------------------------------------------------------------
// Driving and reading

/** Steps the unit until its latest decided outcome satisfies `until`; any end of the unit first is a failure. */
export async function stepUntil(r: ArcRun, id: string, until: (f: StageOutcomeFact) => boolean): Promise<void> {
  const u = unitId(id);
  for (let i = 0; i < 60; i++) {
    const s = await step(r.ctx, r.unit(id));
    const f = r.journal.view.unit(u).decided;
    if (f !== null && until(f)) return;
    if (s.kind !== 'continue') throw new Error(`unit ${id} ended ${s.kind} (${JSON.stringify(s)}) before the condition held`);
  }
  throw new Error(`unit ${id}: the condition did not hold within 60 steps`);
}

/**
 * `stage:outcome` of every stage-outcome fact of `unit`, in log order. Read as `status` reads the log
 * (`readJournal`), because executor tests poll this while the executor is appending.
 */
export function outcomes(d: ArcDescriptor, unit = 'u1'): readonly string[] {
  return readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit ? [`${e.fact.stage}:${e.fact.outcome}`] : []));
}
