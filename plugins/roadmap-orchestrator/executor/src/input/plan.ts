// plan.json, the M1 input contract written by Phase 0. parsePlan checks shape and in-file uniqueness only;
// everything that needs the filesystem, git or the specs (spec paths exist, baseline ancestry, resource
// references, lane argv) is a startup rejection row (src/preflight/startup.ts).
import { type ArcId, type ResourceName, type Sha, type UnitId, INTEGRATION_SLOT, arcId, resourceName, sha, unitId } from '../core/ids.ts';
import { type LaneDef, type LaneEnv, laneDef, laneEnv } from '../core/records.ts';
import { type Read, SchemaError, arrayOf, assertUnique, literal, object, str } from '../core/validate.ts';
import {
  type AbsPath, type BranchName, type PlanPath, type RepoPath, type RepoPattern, absPath, branchName, planPath, repoPath,
  repoPattern,
} from '../core/values.ts';
import { type RiskTier, type RoutingLayer, riskTier, routingLayer } from '../routing/types.ts';

export const PLAN_SCHEMA = 'roadmap/plan-m1';

/** A declared executor-only command, run from the repo root (`cwd` is relative to it); no shell. */
export type ToolCommand = Readonly<{ argv: readonly string[]; cwd: RepoPath; env: LaneEnv }>;

/**
 * Occupancy probe exit contract: 0 free, 10 occupied under this unit's own label, 11 occupied unlabelled
 * or by someone else. Any other exit is a process fault of the probe.
 */
export const PROBE_EXIT = { free: 0, ownLabel: 10, foreign: 11 } as const;

export type ResourceDecl = Readonly<{ name: ResourceName; probe: ToolCommand; teardown: ToolCommand }>;

export type PlanUnit = Readonly<{
  id: UnitId;
  spec: PlanPath;
  risk: RiskTier;
  scope: readonly RepoPattern[];
  resources: readonly ResourceName[];
  /**
   * Units this one runs after (`after`, optional in the file, [] when absent): it is not dispatched while
   * any of them is neither merged nor parked with its needs-user acknowledged. Each names a unit earlier in
   * plan order, never itself.
   */
  after: readonly UnitId[];
}>;

export type PlanM1 = Readonly<{
  schema: typeof PLAN_SCHEMA;
  arc: ArcId;
  integrationBranch: BranchName;
  /** Must be an ancestor of the integration tip (startup check). */
  baseline: Sha;
  worktreeRoot: AbsPath;
  /** Product-tree paths of the frozen contracts. */
  contracts: readonly RepoPath[];
  /** The C-nn ledger, relative to the plan's directory. */
  rulings: PlanPath;
  architectureDoc: RepoPath;
  /**
   * The owner-approved digest of the architecture doc (section index and normative sentences with line
   * anchors). When present, judgments embed it and read the full doc from their checkout on demand.
   */
  architectureDigest?: RepoPath;
  direction: string;
  routing?: RoutingLayer;
  suite: Readonly<{ lanes: readonly LaneDef[] }>;
  resources: readonly ResourceDecl[];
  units: readonly PlanUnit[];
}>;

const toolCommand: Read<ToolCommand> = object((f) => ({
  argv: f.get('argv', arrayOf(str, { nonEmpty: true })),
  cwd: f.get('cwd', (v, p) => repoPath(v, p)),
  env: f.get('env', laneEnv),
}));

const resourceDecl: Read<ResourceDecl> = object((f) => {
  const name = f.get('name', (v, p) => resourceName(v, p));
  if (name === INTEGRATION_SLOT) throw new SchemaError(`${f.path}.name`, 'a name other than the built-in integration-slot', name);
  return { name, probe: f.get('probe', toolCommand), teardown: f.get('teardown', toolCommand) };
});

const planUnit: Read<PlanUnit> = object((f) => {
  const out = {
    id: f.get('id', (v, p) => unitId(v, p)),
    spec: f.get('spec', (v, p) => planPath(v, p)),
    risk: f.get('risk', riskTier),
    scope: f.get('scope', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })),
    resources: f.get('resources', arrayOf((v, p) => resourceName(v, p))),
    after: f.optional('after', arrayOf((v, p) => unitId(v, p))) ?? [],
  };
  assertUnique(out.scope, (s) => s, `${f.path}.scope`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  assertUnique(out.after, (u) => u, `${f.path}.after`);
  return out;
});

/** Field paths in errors start at `plan`, e.g. `plan.units[0].risk`. */
export function parsePlan(value: unknown): PlanM1 {
  return object((f): PlanM1 => {
    const routing = f.optional('routing', routingLayer);
    const architectureDigest = f.optional('architectureDigest', (v, p) => repoPath(v, p));
    const out: PlanM1 = {
      schema: f.get('schema', literal(PLAN_SCHEMA)),
      arc: f.get('arc', (v, p) => arcId(v, p)),
      integrationBranch: f.get('integrationBranch', (v, p) => branchName(v, p)),
      baseline: f.get('baseline', (v, p) => sha(v, p)),
      worktreeRoot: f.get('worktreeRoot', (v, p) => absPath(v, p)),
      contracts: f.get('contracts', arrayOf((v, p) => repoPath(v, p))),
      rulings: f.get('rulings', (v, p) => planPath(v, p)),
      architectureDoc: f.get('architectureDoc', (v, p) => repoPath(v, p)),
      ...(architectureDigest === undefined ? {} : { architectureDigest }),
      direction: f.get('direction', str),
      ...(routing === undefined ? {} : { routing }),
      suite: f.get('suite', object((g) => ({ lanes: g.get('lanes', arrayOf(laneDef)) }))),
      resources: f.get('resources', arrayOf(resourceDecl)),
      units: f.get('units', arrayOf(planUnit, { nonEmpty: true })),
    };
    assertUnique(out.contracts, (c) => c, 'plan.contracts');
    assertUnique(out.suite.lanes, (l) => l.id, 'plan.suite.lanes');
    assertUnique(out.resources, (r) => r.name, 'plan.resources');
    assertUnique(out.units, (u) => u.id, 'plan.units');
    assertUnique(out.units, (u) => u.spec, 'plan.units');
    out.units.forEach((u, i) => {
      const earlier = out.units.slice(0, i).map((e) => e.id);
      u.after.forEach((id, j) => {
        if (!earlier.includes(id)) throw new SchemaError(`plan.units[${i}].after[${j}]`, `a unit earlier in plan order than ${u.id}`, id);
      });
    });
    return out;
  })(value, 'plan');
}
