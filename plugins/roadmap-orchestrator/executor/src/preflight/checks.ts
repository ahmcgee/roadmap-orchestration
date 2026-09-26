// The startup rejection table's checks (SCHEMAS.md "Startup rejection table") and their composition.
//
// `runChecks` evaluates in groups, and stops at the first group that refuses (every rejection of that
// group is reported, so the architect fixes them together):
//
//   1. input        plan schema (nothing else can run without a plan), legacy `.roadmap/`, the rest of
//                   `plan-invalid` (spec files, baseline ancestry, resource names)
//   2. environment  worktree root, lanes, routing, host residues             (pure: no effect yet)
//   3. host claim   host-busy, previous-arc-unreconciled, recovery-holder-dead, owner-mismatch (step 7)
//   4. journal      log-corrupt at open, containment-mode-changed; a first start records the mode
//   5. smoke        backend-smoke for the resolved profile, last: its spawns are journaled
//
// Order within groups 1 and 2 follows the table. Nothing here names a model: routing refusals name the
// seat and the layer.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { detectContainmentMode } from '../contain/detect.ts';
import { durableMkdir, readJson } from '../core/fsx.ts';
import { INTEGRATION_SLOT, type ResourceName, type UnitId, sha } from '../core/ids.ts';
import { LogCorruptError, type OpenJournal, openJournal } from '../core/log.ts';
import type { HostLockClaim, LaneDef, SpecM1 } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath, branchRef } from '../core/values.ts';
import { gitRun, refTarget } from '../git/git.ts';
import { undispositionedResidueCheck } from '../host/residues.ts';
import type { ClaimOutcome } from '../host/lock.ts';
import { runDir as runDirOf } from '../input/cli.ts';
import { type PlanM1, type PlanUnit, parsePlan } from '../input/plan.ts';
import { checkLaneTiers } from '../resources/reserve.ts';
import { type RepoConfig, type ResolvedRouting, parseRepoConfig, resolveRouting, selectProfile, unsupportedSeats } from '../routing/layers.ts';
import type { ProfileName } from '../routing/types.ts';
import { SpecFileError, loadSpec } from '../spec/spec.ts';
import { type SmokeReport, type SmokeRouting, backendEnv, smoke, smokeRejections } from './smoke.ts';
import type { StartupCheck, StartupContext, StartupRejection } from './startup.ts';

type Rejection<K extends StartupRejection['kind']> = Extract<StartupRejection, { kind: K }>;

/** The in-tree `.roadmap/` entries 1.0 keeps; anything else is a 0.x layout (hard cutover: refused, never converted). */
export const ROADMAP_DIR_ALLOWED = ['config.json', 'constraints.md', 'contracts', 'debt.md', 'invariants.md'] as const;
/** statfs(2) f_type of tmpfs. */
const TMPFS_MAGIC = 0x01021994;
/** What Node's spawn searches when a workload's env has no PATH (and the runner passes only the declared env). */
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin';

const planDir = (context: StartupContext): string => dirname(context.planFile);
const specPath = (context: StartupContext, unit: PlanUnit): AbsPath => absPath(join(planDir(context), unit.spec));

function schemaRejection(error: unknown): Rejection<'plan-invalid'> {
  if (!(error instanceof SchemaError)) throw error;
  return { kind: 'plan-invalid', problem: { type: 'schema', field: error.field, detail: error.message } };
}

// ---------------------------------------------------------------------------------------------------
// Group 1: input

export function legacyRoadmapDir(repo: AbsPath): readonly Rejection<'legacy-roadmap-dir'>[] {
  const dir = absPath(join(repo, '.roadmap'));
  if (!existsSync(dir)) return [];
  const unexpected = readdirSync(dir).filter((n) => !(ROADMAP_DIR_ALLOWED as readonly string[]).includes(n)).sort();
  return unexpected.length === 0 ? [] : [{ kind: 'legacy-roadmap-dir', path: dir, unexpected }];
}

/** The plan, or the schema rejection that stops everything else. */
export function loadPlan(planFile: AbsPath): PlanM1 | Rejection<'plan-invalid'> {
  let raw: unknown;
  try {
    raw = readJson(planFile);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: 'plan-invalid', problem: { type: 'schema', field: 'plan', detail: `not JSON: ${error.message}` } };
  }
  try {
    return parsePlan(raw);
  } catch (error) {
    return schemaRejection(error);
  }
}

type SpecOrRejection = SpecM1 | Rejection<'plan-invalid'>;

function loadUnitSpec(context: StartupContext, unit: PlanUnit): SpecOrRejection {
  const path = specPath(context, unit);
  if (!existsSync(path)) return { kind: 'plan-invalid', problem: { type: 'unknown-spec-path', unit: unit.id, path: unit.spec } };
  let spec: SpecM1;
  try {
    spec = loadSpec(path);
  } catch (error) {
    if (error instanceof SpecFileError) return { kind: 'plan-invalid', problem: { type: 'schema', field: 'spec', detail: error.message } };
    return schemaRejection(error);
  }
  if (spec.unit !== unit.id) return { kind: 'plan-invalid', problem: { type: 'schema', field: 'spec.unit', detail: `${unit.spec} is the spec of unit ${spec.unit}, not ${unit.id}` } };
  return spec;
}

/** Every unit's spec, parsed; a missing or invalid one is its rejection instead. */
function specs(context: StartupContext): ReadonlyMap<UnitId, SpecOrRejection> {
  const out = new Map<UnitId, SpecOrRejection>();
  for (const unit of context.plan.units) out.set(unit.id, loadUnitSpec(context, unit));
  return out;
}

const isSpec = (s: SpecOrRejection): s is SpecM1 => !('kind' in s);

/** Spec files, baseline ancestry and resource names (the plan's schema row is `loadPlan`). */
export const planInvalidCheck: StartupCheck<'plan-invalid'> = {
  kind: 'plan-invalid',
  check: async (context) => {
    const { plan, repo } = context;
    const out: Rejection<'plan-invalid'>[] = [];
    const loaded = specs(context);
    for (const s of loaded.values()) if (!isSpec(s)) out.push(s);

    const tip = refTarget(repo, branchRef(plan.integrationBranch));
    if (tip === null) throw new Error(`integration branch ${plan.integrationBranch} does not exist in ${repo}`);
    const known = gitRun(repo, ['cat-file', '-e', `${plan.baseline}^{commit}`], { okCodes: [0, 128] }).code === 0;
    const ancestor = known && gitRun(repo, ['merge-base', '--is-ancestor', plan.baseline, tip], { okCodes: [0, 1] }).code === 0;
    if (!ancestor) out.push({ kind: 'plan-invalid', problem: { type: 'baseline-not-ancestor', baseline: plan.baseline, tip: sha(tip) } });

    const declared = new Set<ResourceName>([INTEGRATION_SLOT, ...plan.resources.map((r) => r.name)]);
    const unknown = (unit: UnitId | null, lane: LaneDef | null, resources: readonly ResourceName[]): void => {
      for (const resource of resources) {
        if (!declared.has(resource)) out.push({ kind: 'plan-invalid', problem: { type: 'unknown-resource', unit, lane: lane?.id ?? null, resource } });
      }
    };
    for (const lane of plan.suite.lanes) unknown(null, lane, lane.resources);
    for (const unit of plan.units) {
      unknown(unit.id, null, unit.resources);
      const spec = loaded.get(unit.id);
      if (spec === undefined || !isSpec(spec)) continue;
      unknown(unit.id, null, spec.resources);
      for (const lane of spec.lanes) unknown(unit.id, lane, lane.resources);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------
// Group 2: environment

export const worktreeRootCheck: StartupCheck<'worktree-root-unusable'> = {
  kind: 'worktree-root-unusable',
  check: async ({ plan: { worktreeRoot: path } }) => {
    if (!existsSync(path) || !statSync(path).isDirectory()) return [{ kind: 'worktree-root-unusable', path, problem: 'not-writable', detail: 'not an existing directory' }];
    if (statfsSync(path).type === TMPFS_MAGIC) return [{ kind: 'worktree-root-unusable', path, problem: 'tmpfs', detail: 'worktrees on tmpfs do not survive a reboot, and unit branches live there' }];
    try {
      accessSync(path, constants.W_OK);
    } catch (error) {
      return [{ kind: 'worktree-root-unusable', path, problem: 'not-writable', detail: (error as Error).message }];
    }
    return [];
  },
};

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a lane's argv[0] resolves, as the runner's spawn would: a bare name on the lane's own PATH (its
 * declared `set.PATH`, or the host's when it passes PATH, else Node's default search path). A relative path
 * with a slash names a file of the unit's tree, which the unit may create: not decidable at startup.
 */
function argv0Resolves(lane: LaneDef, env: Readonly<Record<string, string | undefined>>): boolean {
  const argv0 = lane.argv[0];
  if (argv0 === undefined) throw new Error(`lane ${lane.id} has an empty argv`); // the validator requires non-empty
  if (isAbsolute(argv0)) return executable(argv0);
  if (argv0.includes('/')) return true;
  const path = lane.env.set['PATH'] ?? (lane.env.pass.includes('PATH') ? env['PATH'] : undefined) ?? DEFAULT_SEARCH_PATH;
  return path.split(delimiter).some((dir) => dir !== '' && executable(join(dir, argv0)));
}

function laneProblems(unit: UnitId | null, lane: LaneDef, env: Readonly<Record<string, string | undefined>>): Rejection<'spec-lane-unrunnable'>[] {
  const out: Rejection<'spec-lane-unrunnable'>[] = [];
  if (!argv0Resolves(lane, env)) out.push({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem: { type: 'argv0-unresolvable', argv0: lane.argv[0] as string } });
  for (const name of lane.env.pass) {
    if (env[name] === undefined) out.push({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem: { type: 'env-missing', name } });
  }
  return out;
}

/** Suite lanes and every unit's active lanes: argv[0], declared host variables, the fast/estate boundary. */
export function specLaneCheck(env: Readonly<Record<string, string | undefined>>): StartupCheck<'spec-lane-unrunnable'> {
  return {
    kind: 'spec-lane-unrunnable',
    check: async (context) => {
      const out = context.plan.suite.lanes.flatMap((lane) => laneProblems(null, lane, env));
      for (const unit of context.plan.units) {
        const spec = loadSpec(specPath(context, unit));
        for (const lane of spec.lanes) if (lane.state === 'active') out.push(...laneProblems(unit.id, lane, env));
        out.push(...checkLaneTiers(spec, unit));
      }
      return out;
    },
  };
}

/** `.roadmap/config.json`, or null when the repo has none. */
export function readRepoConfig(repo: AbsPath): RepoConfig | null {
  const path = join(repo, '.roadmap', 'config.json');
  return existsSync(path) ? parseRepoConfig(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

/** The stack for this arc: the profile, the repo config's seats, the plan's layer (no per-unit layers in M1). */
export function resolveArcRouting(context: StartupContext): ResolvedRouting {
  return resolveRouting({
    profile: context.profile,
    repoConfig: readRepoConfig(context.repo)?.routing?.seats ?? null,
    plan: context.plan.routing ?? null,
    unit: null,
  });
}

export const routingCheck: StartupCheck<'unsupported-routing'> = {
  kind: 'unsupported-routing',
  check: async (context) => unsupportedSeats(resolveArcRouting(context), null) as Rejection<'unsupported-routing'>[],
};

// ---------------------------------------------------------------------------------------------------
// Group 4: the journal

export function openJournalChecked(context: StartupContext): OpenJournal | Rejection<'log-corrupt'> {
  durableMkdir(context.runDir);
  try {
    return openJournal(context.runDir, context.plan.arc);
  } catch (error) {
    if (!(error instanceof LogCorruptError)) throw error;
    return { kind: 'log-corrupt', file: error.file, offset: error.offset, detail: error.detail };
  }
}

/** The arc's recorded mode must be the detected one; a first start records it. */
export function containmentModeCheck(journal: OpenJournal): readonly Rejection<'containment-mode-changed'>[] {
  const recorded = journal.view.containmentMode();
  const detected = detectContainmentMode();
  if (recorded === null) {
    journal.fact({ kind: 'containment-mode', mode: detected });
    return [];
  }
  return recorded === detected ? [] : [{ kind: 'containment-mode-changed', recorded, detected }];
}

// ---------------------------------------------------------------------------------------------------
// Composition

export type StartInput = Readonly<{
  repo: AbsPath;
  planFile: AbsPath;
  /** `start --profile`, or null to let `.roadmap/config.json` choose. */
  profile: ProfileName | null;
  hostDir: AbsPath;
  /** The executor's environment: lane prerequisites resolve against it, and backends get `backendEnv(env)`. */
  env: Readonly<Record<string, string | undefined>>;
  /** Claims the host for the arc (step 7's `claimHost`, wired by the supervisor, step 14a). */
  claim: (context: StartupContext) => Promise<ClaimOutcome>;
}>;

export type StartChecks =
  | Readonly<{
    kind: 'refused';
    rejections: readonly StartupRejection[];
    /** Held when a later group refused: the caller releases it. */
    claim: HostLockClaim | null;
    /** Open when the smoke refused: the caller closes it. */
    journal: OpenJournal | null;
  }>
  | Readonly<{ kind: 'passed'; context: StartupContext; routing: SmokeRouting; claim: HostLockClaim; journal: OpenJournal; smoke: SmokeReport }>;

/** The absolute git common dir of `repo`, where the run dirs live. */
export function gitCommonDir(repo: AbsPath): AbsPath {
  return absPath(gitRun(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim());
}

export async function runChecks(input: StartInput): Promise<StartChecks> {
  const refused = (rejections: readonly StartupRejection[], claim: HostLockClaim | null = null, journal: OpenJournal | null = null): StartChecks =>
    ({ kind: 'refused', rejections, claim, journal });

  // 1. input
  const plan = loadPlan(input.planFile);
  if ('kind' in plan) return refused([...legacyRoadmapDir(input.repo), plan]);
  let profile: ProfileName;
  try {
    profile = selectProfile(input.profile, readRepoConfig(input.repo));
  } catch (error) {
    return refused([...legacyRoadmapDir(input.repo), schemaRejection(error)]);
  }
  const context: StartupContext = {
    repo: input.repo, planFile: input.planFile, plan, profile, runDir: runDirOf(gitCommonDir(input.repo), plan.arc), hostDir: input.hostDir,
  };
  const inputRows = [...legacyRoadmapDir(input.repo), ...(await planInvalidCheck.check(context))];
  if (inputRows.length > 0) return refused(inputRows);

  // 2. environment
  let routingRows: readonly StartupRejection[];
  let resolved: ResolvedRouting | null = null;
  try {
    resolved = resolveArcRouting(context);
    routingRows = await routingCheck.check(context);
  } catch (error) {
    routingRows = [schemaRejection(error)];
  }
  const environment = [
    ...(await worktreeRootCheck.check(context)),
    ...(await specLaneCheck(input.env).check(context)),
    ...routingRows,
    ...(await undispositionedResidueCheck.check(context)),
  ];
  if (environment.length > 0 || resolved === null) return refused(environment);

  // 3. host claim
  const claimed = await input.claim(context);
  if (claimed.kind === 'refused') return refused([claimed.rejection]);
  const { claim } = claimed;

  // 4. journal
  const journal = openJournalChecked(context);
  if ('kind' in journal) return refused([journal], claim);
  const mode = containmentModeCheck(journal);
  if (mode.length > 0) return refused(mode, claim, journal);

  // 5. smoke
  const routing: SmokeRouting = { profile, resolved };
  const report = await smoke(routing, { journal, runDir: context.runDir, hostEnv: backendEnv(input.env) });
  const smokeRows = smokeRejections(report);
  if (smokeRows.length > 0) return refused(smokeRows, claim, journal);
  return { kind: 'passed', context, routing, claim, journal, smoke: report };
}
