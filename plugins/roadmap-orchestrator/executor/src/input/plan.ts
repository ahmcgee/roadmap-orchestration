// plan.json, the input contract written by Phase 0. parsePlan checks shape and in-file uniqueness only;
// everything that needs the filesystem, git or the specs (spec paths exist, baseline ancestry, resource
// references, lane argv) is a startup rejection row (src/preflight/startup.ts). M2 adds optional fields only
// (capacity, pools, unit origin, cpu, contingent edges, re-entry and cut), so the schema literal stays
// `roadmap/plan-m1` and a 1.0.0-dev.4 plan reads unchanged (LR-1). M3 does the same: `holistic`, `limits`, a
// unit's `routing` layer and `limits`, and the `repair` origin.
//
// M4a (K7, step 0a): the plan's target is a closed union, told on disk by the field present and flattened onto the
// parsed plan with the discriminant `target`: `architecture-doc` (`architectureDoc`, `architectureDigest?`,
// `holistic?` with its `vision`) or `corpus` (`corpus`, the pin; `phase0`, the Phase-0 record; `holistic` without a
// vision, whose record is `<repo>/.roadmap/vision.json`). `holistic`'s slice, obligations and audit read the same in
// both arms; the variant fields are read only through `targetDocuments` and `visionFile` (test target.no-direct-access).
// `chain` (H7) names the previous arc of a chained start, fixed at revision 1.
import {
  type ArcId, type EdgeId, type ResourceName, type RulingId, type Sha, type UnitId, type VisionClauseId, INTEGRATION_SLOT, arcId, edgeId, resourceName,
  rulingId, sha, unitId, visionClauseId, idList,
} from '../core/ids.ts';
import { BOUND_FIELDS, type Bounds, DEFAULT_BOUNDS, type LaneDef, type LaneEnv, laneDef, laneEnv } from '../core/records.ts';
import { type Fields, type Read, SchemaError, arrayOf, assertUnique, literal, object, oneOf, positive, sortedBy, str } from '../core/validate.ts';
import { type LensKind, LENS_KINDS } from '../holistic/types.ts';
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

/**
 * A declared resource. `pool` (M2): an estate pool of `size` instances `<name>#1..size`, each probed and torn
 * down with its instance bound (`RESOURCE_INSTANCE_<NAME>=<n>`); a request by name takes one instance.
 */
export type ResourceDecl = Readonly<{ name: ResourceName; probe: ToolCommand; teardown: ToolCommand; pool?: Readonly<{ size: number }> }>;

/**
 * Where a unit came from (M2): `checkpoint` units rank before `planned` ones among unpromoted waiters; M3's
 * `repair` units (R6) rank first, and need a spec with non-empty `repairs` (a startup and apply row).
 */
export const UNIT_ORIGINS = ['planned', 'checkpoint', 'repair'] as const;
export type UnitOrigin = (typeof UNIT_ORIGINS)[number];

/** A contingent edge (M2): the unit waits until `resolve-edge <id>` records the condition met. */
export type ContingentEdge = Readonly<{ id: EdgeId; condition: string }>;

/** Where a re-entry's prepared worktree enters (M2): absent, the preparation decides from the merge. */
export const REENTRY_POINTS = ['plan-check', 'build', 'verify'] as const;
export type ReentryPoint = (typeof REENTRY_POINTS)[number];
/** `reenters` (M2): this unit re-enters `unit`, which it supersedes; `reset` (with a ruling) resets its chargeable failures. */
export type Reentry = Readonly<{ unit: UnitId; enterAt?: ReentryPoint; reset?: Readonly<{ ruling: RulingId }> }>;
/** `cut` (M2): the unit is out of scope; a ruling may back the reason. */
export type Cut = Readonly<{ reason: string; ruling?: RulingId }>;

/**
 * M3 (`limits`): overrides of the built-in bounds (`DEFAULT_BOUNDS`), all positive. A unit's override its own;
 * the plan's for every unit. An apply may not lower a counter's bound below what a unit has spent.
 */
export type UnitLimits = Readonly<{ [K in keyof Bounds]?: number }>;
/** The plan's limits: the units' bounds, and the arc's convergence counter K (§2.8, default 3). */
export type ArcLimits = UnitLimits & Readonly<{ convergenceK?: number }>;
export const DEFAULT_CONVERGENCE_K = 3;

/**
 * M3 (A5): the holistic layer is on exactly when the plan has `holistic`; obligations may be absent (none). The parts both
 * plan targets share; an `architecture-doc` plan's adds its `vision` (`HolisticDoc`).
 */
export type Holistic = Readonly<{
  /**
   * The slice of the vision this arc moves toward, ascending: active clauses of the vision in force, at least one a
   * `world` clause (checked where plan and vision meet: `advancesReasons`). The other active clauses are the horizon.
   */
  advances: readonly VisionClauseId[];
  /** The obligations file (`roadmap/obligations-m3`); absent: no obligations. */
  obligations?: PlanPath;
  audit?: Readonly<{
    /** Publications per cadence audit (D3); absent: 5. */
    every?: number;
    /** The required lens set L (H9), ascending; absent: all four. */
    lenses?: readonly LensKind[];
    /** The wall-clock trigger's period; absent: 360. */
    wallClockMin?: number;
  }>;
}>;
/** An `architecture-doc` plan's holistic block: the vision file (`roadmap/vision-m3`), relative to the plan's directory. */
export type HolisticDoc = Holistic & Readonly<{ vision: PlanPath }>;
export const DEFAULT_AUDIT = { every: 5, wallClockMin: 360 } as const;

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
  /** M2: contingent edges ([] when absent); ids unique across the plan. */
  contingent: readonly ContingentEdge[];
  origin?: UnitOrigin;
  /** M2: `@cpu` tokens a build of this unit takes; absent: 4. */
  cpu?: number;
  reenters?: Reentry;
  cut?: Cut;
  /** M3 (`route`, `steer --class`): the unit routing layer, the stack's highest. */
  routing?: RoutingLayer;
  /** M3 (`limits`): this unit's bound overrides. */
  limits?: UnitLimits;
}>;

/** A chained start's previous arc and its completed head (H12), fixed at revision 1 (`chain-immutable`). */
export type PlanChain = Readonly<{ previousArc: ArcId; previousHead: Sha }>;

export const PLAN_TARGETS = ['architecture-doc', 'corpus'] as const;
export type PlanTargetKind = (typeof PLAN_TARGETS)[number];

/** The `architecture-doc` target: the M3 form, lasting for non-holistic arcs (scaffolding for holistic ones, R17). */
export type ArchitectureDocTarget = Readonly<{
  target: 'architecture-doc';
  architectureDoc: RepoPath;
  /**
   * The owner-approved digest of the architecture doc (section index and normative sentences with line
   * anchors). When present, judgments embed it and read the full doc from their checkout on demand.
   */
  architectureDigest?: RepoPath;
  /** M3 (A5): present exactly when the arc runs the holistic layer. An apply may add it, never remove it. */
  holistic?: HolisticDoc;
}>;
/** The `corpus` target (M4a): the corpus pin and the Phase-0 record beside the plan; always holistic (R23). */
export type CorpusTarget = Readonly<{ target: 'corpus'; corpus: PlanPath; phase0: PlanPath; holistic: Holistic }>;
export type PlanTarget = ArchitectureDocTarget | CorpusTarget;

type PlanBase = Readonly<{
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
  direction: string;
  routing?: RoutingLayer;
  /** M2: the size of the built-in `@cpu` pool; absent: `availableParallelism()`. */
  capacity?: Readonly<{ cpu?: number }>;
  suite: Readonly<{ lanes: readonly LaneDef[] }>;
  resources: readonly ResourceDecl[];
  units: readonly PlanUnit[];
  /** M3: the bounds every unit takes unless its own `limits` overrides them, and the convergence K. */
  limits?: ArcLimits;
  /** M4a: a chained start's previous arc (absent: not chained). */
  chain?: PlanChain;
}>;
export type PlanM1 = PlanBase & PlanTarget;

/**
 * The repo documents a judgment and a fingerprint bind (H10): the architecture doc and its digest (null when none),
 * or null for a corpus arc, which binds the pin instead (C2).
 */
export type TargetDocuments = Readonly<{ doc: RepoPath; digest: RepoPath | null }>;
export function targetDocuments(plan: PlanM1): TargetDocuments | null {
  return plan.target === 'corpus' ? null : { doc: plan.architectureDoc, digest: plan.architectureDigest ?? null };
}
/** `targetDocuments` as a path list (the doc, then the digest when present); empty for a corpus arc. */
export function targetDocumentPaths(plan: PlanM1): readonly RepoPath[] {
  const t = targetDocuments(plan);
  return t === null ? [] : t.digest === null ? [t.doc] : [t.doc, t.digest];
}

/**
 * The documents a ruling's contract ops may edit and a checkpoint's revision vector binds: the plan's contracts and the
 * architecture doc, ascending (never its digest; never a corpus file, R32).
 */
export function contractOpDocuments(plan: PlanM1): readonly RepoPath[] {
  const t = targetDocuments(plan);
  return [...new Set([...plan.contracts, ...(t === null ? [] : [t.doc])])].sort();
}

/** The plan fields an apply's `plan-field` change compares (PLAN_FIELDS, src/core/events.ts); the target's read through its arm. */
export type PlanFieldName = 'contracts' | 'rulings' | 'architectureDoc' | 'architectureDigest' | 'direction' | 'capacity';
export function planFieldValue(plan: PlanM1, field: PlanFieldName): unknown {
  switch (field) {
    case 'architectureDoc':
      return targetDocuments(plan)?.doc;
    case 'architectureDigest':
      return targetDocuments(plan)?.digest ?? undefined;
    default:
      return plan[field];
  }
}

/** A corpus arc's vision record, relative to the product repo (R1). */
export const CORPUS_VISION_FILE = '.roadmap/vision.json';

/**
 * Where the arc's vision record lives (OR-V+, R1): an `architecture-doc` plan's `holistic.vision`, relative to the
 * plan's directory (`base: plan`), or `.roadmap/vision.json` relative to the product repo for a corpus arc (`base:
 * repo`); null when the arc is not holistic. The caller joins `path` to its base.
 */
export type VisionLocation = Readonly<{ base: 'plan'; path: PlanPath }> | Readonly<{ base: 'repo'; path: RepoPath }>;
export function visionFile(plan: PlanM1): VisionLocation | null {
  if (plan.target === 'corpus') return { base: 'repo', path: repoPath(CORPUS_VISION_FILE) };
  return plan.holistic === undefined ? null : { base: 'plan', path: plan.holistic.vision };
}

function limitsFields(f: Fields): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of BOUND_FIELDS) {
    const v = f.optional(k, positive);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
const unitLimits: Read<UnitLimits> = object((f) => limitsFields(f) as UnitLimits);
const arcLimits: Read<ArcLimits> = object((f) => {
  const k = f.optional('convergenceK', positive);
  return { ...limitsFields(f), ...(k === undefined ? {} : { convergenceK: k }) } as ArcLimits;
});

/** `holistic`, with its `vision` exactly when `withVision` (an `architecture-doc` plan's; a corpus plan's has none). */
const holisticOf = (withVision: boolean): Read<Holistic | HolisticDoc> => object((f) => {
  const vision = f.optional('vision', (v, p) => planPath(v, p));
  if ((vision !== undefined) !== withVision) {
    throw new SchemaError(`${f.path}.vision`, withVision ? 'the vision file (an architecture-doc plan)' : 'absent (a corpus plan\'s vision is <repo>/.roadmap/vision.json)', vision);
  }
  const obligations = f.optional('obligations', (v, p) => planPath(v, p));
  const audit = f.optional('audit', object((g) => {
    const every = g.optional('every', positive);
    const lenses = g.optional('lenses', sortedBy(oneOf(LENS_KINDS), (l) => l, { nonEmpty: true }));
    const wallClockMin = g.optional('wallClockMin', positive);
    return { ...(every === undefined ? {} : { every }), ...(lenses === undefined ? {} : { lenses }), ...(wallClockMin === undefined ? {} : { wallClockMin }) };
  }));
  return {
    ...(vision === undefined ? {} : { vision }),
    advances: f.get('advances', idList((v, p) => visionClauseId(v, p), { nonEmpty: true, legacyStringOrder: true })),
    ...(obligations === undefined ? {} : { obligations }), ...(audit === undefined ? {} : { audit }) };
});

/** A unit's bounds: the built-in ones, then the plan's `limits`, then the unit's own (M3). */
export function boundsOf(plan: PlanM1, unit: PlanUnit): Bounds {
  const pick = (k: keyof Bounds): number => unit.limits?.[k] ?? plan.limits?.[k] ?? DEFAULT_BOUNDS[k];
  return Object.fromEntries(BOUND_FIELDS.map((k) => [k, pick(k)])) as Bounds;
}

/** The arc's slice of the vision (`holistic.advances`); a plan without `holistic` here is a bug (a vision is in force). */
export function advancesOf(plan: PlanM1): readonly VisionClauseId[] {
  if (plan.holistic === undefined) throw new Error(`plan of arc ${plan.arc}: a vision in force under a plan without holistic`);
  return plan.holistic.advances;
}

/** The arc's required lens set L (H9): `holistic.audit.lenses`, or all four. */
export const lensSetOf = (h: Holistic): readonly LensKind[] => h.audit?.lenses ?? LENS_KINDS;

const toolCommand: Read<ToolCommand> = object((f) => ({
  argv: f.get('argv', arrayOf(str, { nonEmpty: true })),
  cwd: f.get('cwd', (v, p) => repoPath(v, p)),
  env: f.get('env', laneEnv),
}));

const resourceDecl: Read<ResourceDecl> = object((f) => {
  const name = f.get('name', (v, p) => resourceName(v, p));
  if (name === INTEGRATION_SLOT) throw new SchemaError(`${f.path}.name`, 'a name other than the built-in integration-slot', name);
  const pool = f.optional('pool', object((g) => ({ size: g.get('size', positive) })));
  return { name, probe: f.get('probe', toolCommand), teardown: f.get('teardown', toolCommand), ...(pool === undefined ? {} : { pool }) };
});

const rulingR: Read<RulingId> = (v, p) => rulingId(v, p);

const reentry: Read<Reentry> = object((f) => {
  const enterAt = f.optional('enterAt', oneOf(REENTRY_POINTS));
  const reset = f.optional('reset', object((g) => ({ ruling: g.get('ruling', rulingR) })));
  return { unit: f.get('unit', (v, p) => unitId(v, p)), ...(enterAt === undefined ? {} : { enterAt }), ...(reset === undefined ? {} : { reset }) };
});

const cut: Read<Cut> = object((f) => {
  const ruling = f.optional('ruling', rulingR);
  return { reason: f.get('reason', str), ...(ruling === undefined ? {} : { ruling }) };
});

const planUnit: Read<PlanUnit> = object((f) => {
  const out = {
    id: f.get('id', (v, p) => unitId(v, p)),
    spec: f.get('spec', (v, p) => planPath(v, p)),
    risk: f.get('risk', riskTier),
    scope: f.get('scope', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })),
    resources: f.get('resources', arrayOf((v, p) => resourceName(v, p))),
    after: f.optional('after', arrayOf((v, p) => unitId(v, p))) ?? [],
    contingent: f.optional('contingent', arrayOf(object((g) => ({ id: g.get('id', (v, p) => edgeId(v, p)), condition: g.get('condition', str) })))) ?? [],
  };
  const origin = f.optional('origin', oneOf(UNIT_ORIGINS));
  const cpu = f.optional('cpu', positive);
  const reenters = f.optional('reenters', reentry);
  const cutField = f.optional('cut', cut);
  const routing = f.optional('routing', routingLayer);
  const limits = f.optional('limits', unitLimits);
  assertUnique(out.scope, (s) => s, `${f.path}.scope`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  assertUnique(out.after, (u) => u, `${f.path}.after`);
  if (reenters?.unit === out.id) throw new SchemaError(`${f.path}.reenters.unit`, 'a unit other than itself', reenters.unit);
  return {
    ...out, ...(origin === undefined ? {} : { origin }), ...(cpu === undefined ? {} : { cpu }), ...(reenters === undefined ? {} : { reenters }),
    ...(cutField === undefined ? {} : { cut: cutField }), ...(routing === undefined ? {} : { routing }), ...(limits === undefined ? {} : { limits }),
  };
});

/**
 * Why a unit entering the plan (a fresh arc's rev 1, or a unit a revision adds) may not take `id`, or null. A repair
 * batch's candidate ref is keyed by its job id beside the units' (src/git/candidate.ts), and the run dir's
 * `evidence/<unit>/` sits beside `evidence/jobs/` and `evidence/mutants/`. Units already in an adopted arc's plan keep
 * their ids: this is never a schema rule.
 */
export function reservedUnitIdReason(id: UnitId): string | null {
  return /^batch-\d+$/.test(id) || id === 'jobs' || id === 'mutants'
    ? `unit id ${id} is reserved (batch-<n>, jobs and mutants name repair batches and job or mutant evidence); choose another id`
    : null;
}

/**
 * The target arm, by the fields present (K7): `architectureDoc` or `corpus`, never both or neither; a corpus plan names
 * `phase0` and `holistic` and no digest; `phase0` never without `corpus`. Each illegal combination is a SchemaError.
 */
function planTarget(f: Fields): PlanTarget {
  const architectureDoc = f.optional('architectureDoc', (v, p) => repoPath(v, p));
  const architectureDigest = f.optional('architectureDigest', (v, p) => repoPath(v, p));
  const corpus = f.optional('corpus', (v, p) => planPath(v, p));
  const phase0 = f.optional('phase0', (v, p) => planPath(v, p));
  if ((architectureDoc === undefined) === (corpus === undefined)) {
    throw new SchemaError(`${f.path}.architectureDoc`, 'exactly one of architectureDoc and corpus (the plan target)', { architectureDoc, corpus });
  }
  if (corpus === undefined) {
    if (phase0 !== undefined) throw new SchemaError(`${f.path}.phase0`, 'absent without corpus (a Phase-0 record belongs to a corpus plan)', phase0);
    const holistic = f.optional('holistic', holisticOf(true)) as HolisticDoc | undefined;
    return {
      target: 'architecture-doc', architectureDoc: architectureDoc as RepoPath,
      ...(architectureDigest === undefined ? {} : { architectureDigest }), ...(holistic === undefined ? {} : { holistic }),
    };
  }
  if (architectureDigest !== undefined) throw new SchemaError(`${f.path}.architectureDigest`, 'absent beside corpus (the pin replaces the digest)', architectureDigest);
  if (phase0 === undefined) throw new SchemaError(`${f.path}.phase0`, 'the Phase-0 record of a corpus plan', phase0);
  const holistic = f.optional('holistic', holisticOf(false));
  if (holistic === undefined) throw new SchemaError(`${f.path}.holistic`, 'present on a corpus plan (a corpus arc is holistic)', holistic);
  return { target: 'corpus', corpus, phase0, holistic };
}

/** Field paths in errors start at `plan`, e.g. `plan.units[0].risk`. */
export function parsePlan(value: unknown): PlanM1 {
  return object((f): PlanM1 => {
    const routing = f.optional('routing', routingLayer);
    const capacity = f.optional('capacity', object((g) => {
      const cpu = g.optional('cpu', positive);
      return cpu === undefined ? {} : { cpu };
    }));
    const target = planTarget(f);
    const limits = f.optional('limits', arcLimits);
    const chain = f.optional('chain', object((g): PlanChain => ({ previousArc: g.get('previousArc', (v, p) => arcId(v, p)), previousHead: g.get('previousHead', (v, p) => sha(v, p)) })));
    const out: PlanM1 = {
      schema: f.get('schema', literal(PLAN_SCHEMA)),
      arc: f.get('arc', (v, p) => arcId(v, p)),
      integrationBranch: f.get('integrationBranch', (v, p) => branchName(v, p)),
      baseline: f.get('baseline', (v, p) => sha(v, p)),
      worktreeRoot: f.get('worktreeRoot', (v, p) => absPath(v, p)),
      contracts: f.get('contracts', arrayOf((v, p) => repoPath(v, p))),
      rulings: f.get('rulings', (v, p) => planPath(v, p)),
      direction: f.get('direction', str),
      ...(routing === undefined ? {} : { routing }),
      ...(capacity === undefined ? {} : { capacity }),
      suite: f.get('suite', object((g) => ({ lanes: g.get('lanes', arrayOf(laneDef)) }))),
      resources: f.get('resources', arrayOf(resourceDecl)),
      units: f.get('units', arrayOf(planUnit, { nonEmpty: true })),
      ...(limits === undefined ? {} : { limits }),
      ...(chain === undefined ? {} : { chain }),
      ...target,
    };
    assertUnique(out.contracts, (c) => c, 'plan.contracts');
    assertUnique(out.suite.lanes, (l) => l.id, 'plan.suite.lanes');
    assertUnique(out.resources, (r) => r.name, 'plan.resources');
    assertUnique(out.units, (u) => u.id, 'plan.units');
    assertUnique(out.units, (u) => u.spec, 'plan.units');
    assertUnique(out.units.flatMap((u) => u.contingent), (e) => e.id, 'plan.units[].contingent');
    out.units.forEach((u, i) => {
      const earlier = out.units.slice(0, i).map((e) => e.id);
      u.after.forEach((id, j) => {
        if (!earlier.includes(id)) throw new SchemaError(`plan.units[${i}].after[${j}]`, `a unit earlier in plan order than ${u.id}`, id);
      });
      if (u.reenters !== undefined && !earlier.includes(u.reenters.unit)) {
        throw new SchemaError(`plan.units[${i}].reenters.unit`, `a unit earlier in plan order than ${u.id}`, u.reenters.unit);
      }
    });
    return out;
  })(value, 'plan');
}
