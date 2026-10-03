// The startup rejection table's checks (SCHEMAS.md "Startup rejection table") and their composition.
//
// `runChecks` evaluates in groups, and stops at the first group that refuses (every rejection of that
// group is reported, so the architect fixes them together):
//
//   1. input        plan schema (nothing else can run without a plan), legacy `.roadmap/`, the rest of
//                   `plan-invalid` (spec files, baseline ancestry, resource names, over capacity)
//   2. environment  worktree root, lanes, routing, host residues other than the arc's own (A9)
//                                                                            (pure: no effect yet)
//   3. host claim   host-busy, previous-arc-unreconciled, recovery-holder-dead, owner-mismatch (step 7)
//   4. journal      log-corrupt at open, containment-mode-changed; a first start records the mode; last, the
//                   plan in force (`settlePlan`): a first start records the files (M3: after the Phase-0 row
//                   `obligation-dropped`, reported as plan-change-refused), a start whose files differ applies
//                   them through the apply core (src/commands/apply.ts `evaluateRevision`, source `start`) or
//                   refuses (plan-change-refused); a revision a crash left mid-commit is recovery's first, and so
//                   is a committed command's write-back (its `command.apply` still open with its revision in force:
//                   the files may not hold that revision yet, and recovery re-runs the command, which writes it
//                   back), so the files wait for the next start.
//
// M3: group 1 also loads the ruling sidecars, the obligations and the vision the files name (`revisionInputRows`).
//
// A supervisor's respawn checks the plan in force and its kept specs, not the files (`StartInput.respawn`).
//
// `runChecks` is groups 1 to 4. Group 5, `smokeCheck` (backend-smoke for the resolved profile), is last and
// separate: its spawns are journaled, so the executor runs it only after `executor-started` and recovery,
// which closes a smoke spawn a crashed start left open like any other (lead ruling, 14c). On a respawn of an
// established arc a failed smoke parks its backend instead of refusing (A18).
//
// Order within groups 1 and 2 follows the table. Nothing here names a model: routing refusals name the
// seat and the layer.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectContainmentMode } from '../contain/detect.ts';
import { durableMkdir, readJson } from '../core/fsx.ts';
import { type ArcId, INTEGRATION_SLOT, type ResourceName, type UnitId, sha } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { LogCorruptError, type OpenJournal, openJournal, readJournal } from '../core/log.ts';
import type { HostLockClaim, LaneDef, LaneEnv, SpecM1 } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath, branchName, branchRef, refName } from '../core/values.ts';
import { gitRun, refTarget } from '../git/git.ts';
import { ownArcResidue, undispositionedResidueCheck } from '../host/residues.ts';
import type { ClaimOutcome } from '../host/lock.ts';
import { evaluateRevision, keepRevision, payloadOf } from '../commands/apply.ts';
import { parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { advancesReasons } from '../holistic/vision.ts';
import { rederive } from '../holistic/rederive.ts';
import { runDir as runDirOf } from '../input/cli.ts';
import {
  type InputFiles, type RoutingBase, appendRevision, closeRevision, commitRevisionNow, keptPayload, openRevision, planInForce, readInputFiles, recordPlan,
  specBytesOf, specShaInForce,
} from '../input/inforce.ts';
import { type PlanM1, type PlanUnit, parsePlan, reservedUnitIdReason } from '../input/plan.ts';
import { unitBranchPrefix } from '../pipeline/dispatch.ts';
import { cpuCapacity, overCapacity } from '../resources/pool.ts';
import { checkLaneTiers } from '../resources/reserve.ts';
import {
  type RepoConfig, type ResolvedRouting, planStack, parseRepoConfig, resolveRouting, selectProfile, unsupportedSeats,
} from '../routing/layers.ts';
import type { ProfileName } from '../routing/types.ts';
import { type Ruling, loadRulings } from '../spec/rulings.ts';
import { SpecFileError, parseSpec } from '../spec/spec.ts';
import { resolveArgv0 } from './argv0.ts';
import { type SmokePark, type SmokeReport, type SmokeRouting, backendEnv, smoke, smokeOutages, smokeRejections } from './smoke.ts';
import type { CommandProblem, StartupCheck, StartupContext, StartupRejection } from './startup.ts';

type Rejection<K extends StartupRejection['kind']> = Extract<StartupRejection, { kind: K }>;

/** The in-tree `.roadmap/` entries 1.0 keeps; anything else is a 0.x layout (hard cutover: refused, never converted). */
export const ROADMAP_DIR_ALLOWED = ['config.json', 'constraints.md', 'contracts', 'debt.md', 'invariants.md'] as const;
/** statfs(2) f_type of tmpfs. */
const TMPFS_MAGIC = 0x01021994;

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
  if (!existsSync(planFile)) return { kind: 'plan-invalid', problem: { type: 'schema', field: 'plan', detail: `${planFile} does not exist` } };
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
  const bytes = context.specOf(unit);
  if (bytes === null) return { kind: 'plan-invalid', problem: { type: 'unknown-spec-path', unit: unit.id, path: unit.spec } };
  let spec: SpecM1;
  try {
    spec = parseSpec(bytes, path);
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

/** The rulings ledger, or its schema rejection. */
function ledger(context: StartupContext): readonly Ruling[] | Rejection<'plan-invalid'> {
  const file = join(planDir(context), context.plan.rulings);
  if (!existsSync(file)) return { kind: 'plan-invalid', problem: { type: 'schema', field: 'plan.rulings', detail: `${file} does not exist` } };
  try {
    return loadRulings(file);
  } catch (error) {
    return schemaRejection(error);
  }
}

/** A spec's cites that name no plan contract or no ledger ruling. */
function unknownCites(plan: PlanM1, rulings: readonly Ruling[], unit: UnitId, spec: SpecM1): Rejection<'plan-invalid'>[] {
  const cites = [
    ...spec.cites.contracts.filter((c) => !plan.contracts.includes(c)),
    ...spec.cites.rulings.filter((r) => !rulings.some((x) => x.id === r)),
  ];
  return cites.map((cite) => ({ kind: 'plan-invalid', problem: { type: 'unknown-cite', unit, cite } }));
}

/** `integrationBranch` names no local branch; a full ref or a remote-tracking name is told to use the short local name. */
function unknownIntegrationBranch({ repo, plan }: StartupContext): Rejection<'plan-invalid'> {
  const name = plan.integrationBranch;
  const ref = branchRef(name);
  const short = 'integrationBranch takes the short name of a local branch (e.g. main)';
  const detail = name.startsWith('refs/')
    ? `${ref} does not exist: ${short}, not a full ref`
    : refTarget(repo, refName(`refs/remotes/${name}`)) !== null
      ? `${ref} does not exist: ${name} is a remote-tracking branch; ${short}`
      : `${ref} does not exist in ${repo}`;
  return { kind: 'plan-invalid', problem: { type: 'unknown-integration-branch', ref, detail } };
}

/**
 * Branches that keep git from creating the arc's unit branches `roadmap/<arc>/<unit>`: a branch at `roadmap` or
 * `roadmap/<arc>` itself, and an integration branch inside `roadmap/<arc>/`. The unit branches a recovered arc
 * already has are not conflicts.
 */
function unitBranchConflicts({ repo, plan }: StartupContext): Rejection<'plan-invalid'>[] {
  const prefix = unitBranchPrefix(plan.arc);
  const segments = prefix.split('/');
  const out: Rejection<'plan-invalid'>[] = [];
  for (let i = 1; i <= segments.length; i++) {
    const ref = branchRef(branchName(segments.slice(0, i).join('/')));
    if (refTarget(repo, ref) !== null) {
      out.push({ kind: 'plan-invalid', problem: { type: 'unit-branch-conflict', ref, detail: `branch ${ref} exists, so git cannot create the unit branches ${prefix}/<unit>; rename or delete it` } });
    }
  }
  if (plan.integrationBranch.startsWith(`${prefix}/`)) {
    out.push({
      kind: 'plan-invalid',
      problem: { type: 'unit-branch-conflict', ref: branchRef(plan.integrationBranch), detail: `integrationBranch ${plan.integrationBranch} is inside ${prefix}/, the executor's unit branch namespace` },
    });
  }
  return out;
}

/**
 * Spec files, the rulings ledger, spec cites, unit branch conflicts, the integration branch, baseline ancestry and
 * resource names (the plan's schema row is `loadPlan`).
 */
export const planInvalidCheck: StartupCheck<'plan-invalid'> = {
  kind: 'plan-invalid',
  check: async (context) => {
    const { plan, repo } = context;
    const out: Rejection<'plan-invalid'>[] = [];
    const loaded = specs(context);
    for (const s of loaded.values()) if (!isSpec(s)) out.push(s);
    const rulings = ledger(context);
    if (!Array.isArray(rulings)) out.push(rulings as Rejection<'plan-invalid'>);
    else for (const unit of plan.units) {
      const spec = loaded.get(unit.id);
      if (spec !== undefined && isSpec(spec)) out.push(...unknownCites(plan, rulings, unit.id, spec));
    }

    out.push(...unitBranchConflicts(context));
    const tip = refTarget(repo, branchRef(plan.integrationBranch));
    if (tip === null) out.push(unknownIntegrationBranch(context));
    else {
      const known = gitRun(repo, ['cat-file', '-e', `${plan.baseline}^{commit}`], { okCodes: [0, 128] }).code === 0;
      const ancestor = known && gitRun(repo, ['merge-base', '--is-ancestor', plan.baseline, tip], { okCodes: [0, 1] }).code === 0;
      if (!ancestor) out.push({ kind: 'plan-invalid', problem: { type: 'baseline-not-ancestor', baseline: plan.baseline, tip: sha(tip) } });
    }

    const declared = new Set<ResourceName>([INTEGRATION_SLOT, ...plan.resources.map((r) => r.name)]);
    const unknown = (unit: UnitId | null, lane: LaneDef | null, resources: readonly ResourceName[]): void => {
      for (const resource of resources) {
        if (!declared.has(resource)) out.push({ kind: 'plan-invalid', problem: { type: 'unknown-resource', unit, lane: lane?.id ?? null, resource } });
      }
    };
    for (const lane of plan.suite.lanes) unknown(null, lane, lane.resources);
    const specsLoaded = new Map<UnitId, SpecM1>();
    for (const unit of plan.units) {
      unknown(unit.id, null, unit.resources);
      const spec = loaded.get(unit.id);
      if (spec === undefined || !isSpec(spec)) continue;
      specsLoaded.set(unit.id, spec);
      unknown(unit.id, null, spec.resources);
      for (const lane of spec.lanes) unknown(unit.id, lane, lane.resources);
    }
    out.push(...overCapacity(plan, { cpu: cpuCapacity(plan) }, specsLoaded));
    return out;
  },
};

/**
 * M3: the revisioned inputs besides plan and specs, as the files hold them (a start, not a respawn): each ruling
 * sidecar, the obligations and the vision load, and the plan's `holistic.advances` fits the vision (`plan-invalid`,
 * schema).
 */
export function revisionInputRows(files: InputFiles): Rejection<'plan-invalid'>[] {
  const out: Rejection<'plan-invalid'>[] = [];
  const load = <T>(field: string, path: string, bytes: Buffer | null, parse: (v: unknown) => T): T | null => {
    if (bytes === null) {
      out.push({ kind: 'plan-invalid', problem: { type: 'schema', field, detail: `${path} does not exist` } });
      return null;
    }
    try {
      return parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
      out.push({ kind: 'plan-invalid', problem: { type: 'schema', field, detail: `${path}: ${error.message}` } });
      return null;
    }
  };
  for (const [id, s] of files.sidecars) {
    load(`rulings sidecar ${id}`, s.path, s.bytes, (v) => {
      if (parseRulingSidecar(v).id !== id) throw new SchemaError(s.path, `the sidecar of ${id}`, v);
    });
  }
  if (files.obligations !== null) load('plan.holistic.obligations', files.obligations.path, files.obligations.bytes, parseObligations);
  const vision = files.vision === null ? null : load('plan.holistic.vision', files.vision.path, files.vision.bytes, parseVision);
  if (vision !== null && files.plan.holistic !== undefined) {
    for (const detail of advancesReasons(vision, files.plan.holistic.advances)) out.push({ kind: 'plan-invalid', problem: { type: 'schema', field: 'plan.holistic.advances', detail } });
  }
  return out;
}

/** The arc's log, read-only (the checks run before the journal opens), or `corrupt` (group 4 refuses it as log-corrupt). */
function arcLog(context: StartupContext): JournalView | 'corrupt' {
  try {
    return readJournal(context.runDir, context.plan.arc).view;
  } catch (error) {
    if (error instanceof LogCorruptError) return 'corrupt';
    throw error;
  }
}

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

/** A declared command: a lane, or a resource's probe or teardown. */
type Declared = Readonly<{ argv: readonly string[]; env: LaneEnv }>;

/** argv[0] and the declared host variables of one command. */
function commandProblems(command: Declared, env: Readonly<Record<string, string | undefined>>): CommandProblem[] {
  const out: CommandProblem[] = [];
  if (resolveArgv0(command, env).kind === 'not-found') out.push({ type: 'argv0-unresolvable', argv0: command.argv[0] as string });
  for (const name of command.env.pass) if (env[name] === undefined) out.push({ type: 'env-missing', name });
  return out;
}

function laneProblems(unit: UnitId | null, lane: LaneDef, env: Readonly<Record<string, string | undefined>>): Rejection<'spec-lane-unrunnable'>[] {
  return commandProblems(lane, env).map((problem) => ({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem }));
}

/** Every declared resource's probe and teardown (resource variant of the row). */
function resourceProblems(plan: PlanM1, env: Readonly<Record<string, string | undefined>>): Rejection<'spec-lane-unrunnable'>[] {
  return plan.resources.flatMap((r) => (['probe', 'teardown'] as const).flatMap((command) =>
    commandProblems(r[command], env).map((problem): Rejection<'spec-lane-unrunnable'> => ({ kind: 'spec-lane-unrunnable', resource: r.name, command, problem }))));
}

/**
 * Suite lanes and every unit's active lanes (argv[0], declared host variables, the fast/estate boundary),
 * then every resource's probe and teardown command.
 */
export function specLaneCheck(env: Readonly<Record<string, string | undefined>>): StartupCheck<'spec-lane-unrunnable'> {
  return {
    kind: 'spec-lane-unrunnable',
    check: async (context) => {
      const out = context.plan.suite.lanes.flatMap((lane) => laneProblems(null, lane, env));
      for (const unit of context.plan.units) {
        const bytes = context.specOf(unit);
        if (bytes === null) throw new Error(`spec-lane-unrunnable: the spec of ${unit.id} is absent, which plan-invalid refuses first`);
        const spec = parseSpec(bytes, specPath(context, unit));
        for (const lane of spec.lanes) if (lane.state === 'active') out.push(...laneProblems(unit.id, lane, env));
        out.push(...checkLaneTiers(spec, unit));
      }
      out.push(...resourceProblems(context.plan, env));
      return out;
    },
  };
}

/** `.roadmap/config.json`, or null when the repo has none. */
export function readRepoConfig(repo: AbsPath): RepoConfig | null {
  const path = join(repo, '.roadmap', 'config.json');
  return existsSync(path) ? parseRepoConfig(JSON.parse(readFileSync(path, 'utf8'))) : null;
}

/** The stack for this arc: the profile, the repo config's seats and class rebinds, the plan's layer (no per-unit layers in M1). */
export function resolveArcRouting(context: StartupContext): ResolvedRouting {
  return routingOf(context.profile, context.repo, context.plan);
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

/**
 * The `undispositioned-residue` row, less this arc's own residues (A9): a residue its log proves it owns
 * (`ownArcResidue`) never refuses its start or respawn; the arc disposes of it itself (a retryable park's
 * probe, or a sweep). Every other arc's residue still refuses. A log that does not read owns nothing.
 */
async function residueCheck(context: StartupContext): Promise<readonly Rejection<'undispositioned-residue'>[]> {
  const rows = await undispositionedResidueCheck.check(context);
  if (rows.length === 0) return [];
  const view = arcLog(context);
  const foreign = rows.flatMap((r) => r.residues).filter((key) => view === 'corrupt' || !ownArcResidue(view, key));
  return foreign.length === 0 ? [] : [{ kind: 'undispositioned-residue', residues: foreign }];
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
  /**
   * The host claim for the arc. The supervisor claims (`claimHost`, reconciling a dead claim of another arc)
   * before it spawns the executor; the executor passes the claim it was handshaken with, so this returns
   * that claim and touches no host file (step 14a). Group 3 still refuses whatever it reports.
   */
  claim: (context: StartupContext) => Promise<ClaimOutcome>;
  /**
   * A supervisor's respawn after a crash: the run whose plan in force it runs (the claim's run dir and arc),
   * ignoring plan.json edits nobody applied. Null for `roadmap start`, which puts changed files in force
   * through the apply rules.
   */
  respawn: Readonly<{ runDir: AbsPath; arc: ArcId }> | null;
}>;

export type StartChecks =
  | Readonly<{
    kind: 'refused';
    rejections: readonly StartupRejection[];
    /** Held when a later group refused. The executor never releases it: its supervisor does, after it exits. */
    claim: HostLockClaim | null;
    /** Open when the containment mode or the plan in force refused: the caller closes it. */
    journal: OpenJournal | null;
  }>
  | Readonly<{
    kind: 'passed'; context: StartupContext; routing: SmokeRouting; claim: HostLockClaim; journal: OpenJournal;
    /** A supervisor's respawn of an established arc (it runs the plan in force): a failed smoke parks, never refuses (A18). */
    respawn: boolean;
  }>;

/** The absolute git common dir of `repo`, where the run dirs live. */
export function gitCommonDir(repo: AbsPath): AbsPath {
  return absPath(gitRun(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim());
}

/** What a start checks: the plan and a reader of each unit's spec bytes, and the files when they are the source. */
type Source = Readonly<{ plan: PlanM1; specOf: (unit: PlanUnit) => Buffer | null; files: InputFiles | null }>;

/** plan.json and its specs as the files hold them, or the schema rejection of the plan. */
function fileSource(planFile: AbsPath): Source | Rejection<'plan-invalid'> {
  const plan = loadPlan(planFile);
  if ('kind' in plan) return plan;
  const files = readInputFiles(planFile);
  return { plan: files.plan, specOf: (unit) => files.specs.get(unit.id)?.bytes ?? null, files };
}

/** On a respawn, the plan in force and its kept specs; null when the log records none (or does not read). */
function inForceSource(runDir: AbsPath, arc: ArcId): Source | null {
  let view: JournalView;
  try {
    view = readJournal(runDir, arc).view;
  } catch (error) {
    if (error instanceof LogCorruptError) return null;
    throw error;
  }
  const inForce = planInForce(runDir, view);
  if (inForce === null) return null;
  const specOf = (unit: PlanUnit): Buffer => specBytesOf(runDir, specShaInForce(view, unit.id));
  return { plan: inForce.plan, specOf, files: null };
}

/** The arc's routing for `plan` under the start's profile and the repo config. */
export function routingOf(profile: ProfileName, repo: AbsPath, plan: PlanM1): ResolvedRouting {
  return resolveRouting(planStack(profile, readRepoConfig(repo), plan));
}

/**
 * Group 4, last: the plan in force. With none recorded (a first start), the files' become revision 1. A start whose
 * files differ from the plan in force
 * classifies them like `roadmap apply` (no command) and refuses what the rules refuse. A respawn runs the plan
 * in force and asks nothing.
 */
export function settlePlan(journal: OpenJournal, context: StartupContext, files: InputFiles | null): readonly Rejection<'plan-change-refused'>[] {
  // A start's own revision a crash left mid-commit (it has no docs step): finished from its payload first, exactly as
  // recovery would (src/recover/revision.ts), so the plan in force exists before anything reads it.
  const open = openRevision(journal.view);
  if (open !== null && open.expect.source.type === 'start') {
    appendRevision(journal, open, keptPayload(context.runDir, open.expect.payloadSha256), null);
    closeRevision(journal, open.op, true);
  }
  const inForce = planInForce(context.runDir, journal.view);
  if (files === null) {
    if (inForce === null) throw new Error('a respawn with no plan in force reads the files');
    return [];
  }
  const routingBase: RoutingBase = { profile: context.profile, config: readRepoConfig(context.repo) };
  if (inForce === null) {
    // A fresh arc records the files as they are; every unit enters now.
    const reserved = files.plan.units.map((u) => reservedUnitIdReason(u.id)).filter((r) => r !== null);
    if (reserved.length > 0) return [{ kind: 'plan-change-refused', reasons: reserved }];
    const dropped = obligationDropped(context, files);
    if (dropped.length > 0) return [{ kind: 'plan-change-refused', reasons: dropped }];
    recordPlan(journal, context.runDir, files, [], routingBase);
    return [];
  }
  // A command's or bundle's revision a crash left mid-commit: recovery settles it; the files are settled at the next start.
  if (openRevision(journal.view) !== null) return [];
  // A command whose revision is in force but which a crash cut short (its write-back of that revision into the files
  // may be unfinished): recovery re-runs it and finishes the write-back; the files are settled at the next start.
  if (committedCommand(journal.view)) return [];
  const rctx = { runDir: context.runDir, view: journal.view, hostDir: context.hostDir, planFile: context.planFile, routingBase };
  const verdict = evaluateRevision(rctx, files, { type: 'start' });
  switch (verdict.kind) {
    case 'unchanged':
      return [];
    case 'accepted':
      if (verdict.draft.publication !== null) {
        return [{
          kind: 'plan-change-refused',
          reasons: ['the changed files need a docs publication (their obligations or rulings render into .roadmap/): start on the plan in force, then `roadmap apply` them'],
        }];
      }
      keepRevision(context.runDir, verdict);
      commitRevisionNow(journal, context.runDir, payloadOf(verdict.draft, { type: 'start' }), { type: 'arc' });
      return [];
    case 'rejected':
      return [{ kind: 'plan-change-refused', reasons: verdict.reasons }];
  }
}

/** Whether a `command.apply` is open whose revision is in force already (a `plan-applied` names its command). */
const committedCommand = (view: JournalView): boolean =>
  view.openIntents().some((i) => i.kind === 'command.apply' && view.planAppliedBy(i.expect.command) !== null);

/**
 * The startup row `obligation-dropped` (LR-b, R2), at an arc's first start: the previous arc's published obligations
 * (the JSON block of `.roadmap/invariants.md` in the baseline tree) diffed by I-nn against the obligations file; a
 * missing or weakened id no Phase-0 ruling dispositions is refused (src/holistic/rederive.ts). Reported as a refused
 * plan (`plan-change-refused`), one reason per id.
 */
export function obligationDropped(context: StartupContext, files: InputFiles): readonly string[] {
  const shown = gitRun(context.repo, ['show', `${context.plan.baseline}:.roadmap/invariants.md`], { okCodes: [0, 128] });
  const baseline = shown.code === 0 ? shown.stdout : null;
  const next = files.obligations?.bytes === null || files.obligations === null ? null : parseObligations(JSON.parse(files.obligations.bytes.toString('utf8')));
  const rulings = [...files.sidecars.values()].map((s) => parseRulingSidecar(JSON.parse(s.bytes.toString('utf8'))));
  return rederive(baseline, next, rulings);
}

export async function runChecks(input: StartInput): Promise<StartChecks> {
  const refused = (rejections: readonly StartupRejection[], claim: HostLockClaim | null = null, journal: OpenJournal | null = null): StartChecks =>
    ({ kind: 'refused', rejections, claim, journal });

  // 1. input
  const inForce = input.respawn === null ? null : inForceSource(input.respawn.runDir, input.respawn.arc);
  const source = inForce ?? fileSource(input.planFile);
  if ('kind' in source) return refused([...legacyRoadmapDir(input.repo), source]);
  const { plan } = source;
  let profile: ProfileName;
  try {
    profile = selectProfile(input.profile, readRepoConfig(input.repo));
  } catch (error) {
    return refused([...legacyRoadmapDir(input.repo), schemaRejection(error)]);
  }
  const context: StartupContext = {
    repo: input.repo, planFile: input.planFile, plan, specOf: source.specOf, profile, runDir: runDirOf(gitCommonDir(input.repo), plan.arc), hostDir: input.hostDir,
  };
  const inputRows = [...legacyRoadmapDir(input.repo), ...(await planInvalidCheck.check(context)), ...(source.files === null ? [] : revisionInputRows(source.files))];
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
    ...(await residueCheck(context)),
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
  const planRows = settlePlan(journal, context, source.files);
  if (planRows.length > 0) return refused(planRows, claim, journal);

  return { kind: 'passed', context, routing: { profile, resolved }, claim, journal, respawn: inForce !== null };
}

/**
 * The startup rows an apply re-runs over the new plan (SCHEMAS.md "Plan in force"): the input and lane rows
 * for the units whose entry or spec changed (`scoped`), and the routing row when the routing changed.
 */
export async function applyRows(
  context: StartupContext, scoped: readonly UnitId[], routingChanged: boolean, env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StartupRejection[]> {
  const narrowed: StartupContext = { ...context, plan: { ...context.plan, units: context.plan.units.filter((u) => scoped.includes(u.id)) } };
  return [
    ...(await planInvalidCheck.check(narrowed)),
    ...(await specLaneCheck(env).check(narrowed)),
    ...(routingChanged ? await routingCheck.check(context) : []),
  ];
}

/**
 * Group 5: the backend smoke for the resolved profile, over the passed checks' journal. A first start refuses a
 * missing or failed backend. A supervisor's respawn of an established arc does not (A18): it parks each such
 * backend (`backend-park`, `outage` unless the backend reported a usage limit or capacity error) and the arc
 * runs everything else, the prober recovering a retryable park. A profile that excludes a backend some seat
 * still routes to is a configuration error and refuses either way.
 */
export async function smokeCheck(
  passed: Extract<StartChecks, { kind: 'passed' }>, env: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ kind: 'refused'; rejections: readonly StartupRejection[] }> | Readonly<{ kind: 'passed'; smoke: SmokeReport; parked: readonly SmokePark[] }>> {
  const report = await smoke(passed.routing, { journal: passed.journal, runDir: passed.context.runDir, hostEnv: backendEnv(env) });
  const rejections = smokeRejections(report);
  const parked = passed.respawn ? smokeOutages(report) : [];
  const refused = rejections.filter((r) => !parked.some((p) => p.backend === r.backend));
  if (refused.length > 0) return { kind: 'refused', rejections: refused };
  for (const p of parked) passed.journal.fact({ kind: 'backend-park', backend: p.backend, class: p.class, inv: p.inv });
  return { kind: 'passed', smoke: report, parked };
}
