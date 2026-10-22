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
//
// dev.13 (SCHEMAS.md "dev.13: milestone walkthroughs and design units"): `milestones` (absent: none; `milestonesOf`),
// `limits.walkRounds` (absent: 3; `walkRoundsOf`), the unit origin `polish` with its `polish` field. The in-file milestone
// refusals are here (`milestoneRefusals`); `milestones-need-holistic` is a Phase-0 row (src/phase0/rows.ts).
import {
  type ArcId, type EdgeId, type JourneyId, type KnownDefectId, type LaneId, type MilestoneId, type PolishId, type ResourceName, type RulingId, type ServeName, type Sha,
  type UnitId, type VisionClauseId, INTEGRATION_SLOT, arcId, edgeId, journeyId, knownDefectId, laneId, milestoneId, polishId, resourceName, rulingId, serveName, sha,
  unitId, visionClauseId, idList,
} from '../core/ids.ts';
import {
  BOUND_FIELDS, type Bounds, DEFAULT_BOUNDS, type FailureRef, failureRef, type KnownDefectMatch, type LaneDef, type LaneEnv, knownDefectMatch, laneDefOf, laneEnv,
} from '../core/records.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type Fields, type Read, SchemaError, arrayOf, assertUnique, literal, nullable, object, oneOf, positive, sortedBy, str, stringMap, tagged } from '../core/validate.ts';
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
 * `repair` units (R6) rank first, and need a spec with non-empty `repairs` (a startup and apply row). dev.13: `polish`, a
 * unit a milestone walkthrough proposed and code admitted (it carries `polish`), ranks between checkpoint and planned
 * (`ORIGIN_RANK`, src/schedule/types.ts).
 */
export const UNIT_ORIGINS = ['planned', 'checkpoint', 'repair', 'polish'] as const;
export type UnitOrigin = (typeof UNIT_ORIGINS)[number];

/** dev.13: what a `polish` unit came from: the milestone it polishes and the walkthrough's proposal (`polish-proposed`). */
export type PolishOrigin = Readonly<{ milestone: MilestoneId; proposal: PolishId }>;

/** A contingent edge (M2): the unit waits until `resolve-edge <id>` records the condition met. */
export type ContingentEdge = Readonly<{ id: EdgeId; condition: string }>;

/** Where a re-entry's prepared worktree enters (M2): absent, the preparation decides from the merge. */
export const REENTRY_POINTS = ['plan-check', 'build', 'verify'] as const;
export type ReentryPoint = (typeof REENTRY_POINTS)[number];
/**
 * `reenters` (M2): this unit re-enters `unit`, which it supersedes; `reset` (with a ruling) resets its chargeable failures.
 * `fixes` (arc feedback 2026-10-16): the failure of the lineage this re-entry fixes. The file reads it as optional, since
 * re-entries applied before it carry none; the classifier requires it of every re-entry an apply adds whose lineage
 * recorded a failure.
 */
export type Reentry = Readonly<{ unit: UnitId; enterAt?: ReentryPoint; reset?: Readonly<{ ruling: RulingId }>; fixes?: FailureRef }>;
/** `cut` (M2): the unit is out of scope; a ruling may back the reason. */
export type Cut = Readonly<{ reason: string; ruling?: RulingId }>;

/**
 * M3 (`limits`): overrides of the built-in bounds (`DEFAULT_BOUNDS`), all positive. A unit's override its own;
 * the plan's for every unit. An apply may not lower a counter's bound below what a unit has spent.
 */
export type UnitLimits = Readonly<{ [K in keyof Bounds]?: number }>;
/**
 * The plan's limits: the units' bounds, the arc's convergence counter K (§2.8, default 3) and (dev.13) the walks per
 * milestone (`walkRounds`, default 3: round 1 and up to two polish or fix rounds).
 */
export type ArcLimits = UnitLimits & Readonly<{ convergenceK?: number; walkRounds?: number }>;
export const DEFAULT_CONVERGENCE_K = 3;
export const DEFAULT_WALK_ROUNDS = 3;

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
  /** M4a rev 3 (F1b, R42): `high` ranks before every `normal` waiter, ahead of promotion; absent: `normal` (`priorityOf`). */
  priority?: UnitPriority;
  /** dev.13: present exactly on a `polish` unit. */
  polish?: PolishOrigin;
}>;

export const UNIT_PRIORITIES = ['normal', 'high'] as const;
export type UnitPriority = (typeof UNIT_PRIORITIES)[number];
/** A unit's priority: its own, or `normal` (absent, lasting). */
export const priorityOf = (unit: PlanUnit): UnitPriority => unit.priority ?? 'normal';

/**
 * M4a rev 3 (F4, R49): a defect the plan knows of. A unit that declares lane `lane` (`match: lane`), or whose red lane's
 * output tail contains `contains` (`match: output`, a substring, never a regex), waits uncharged at `prepare` while
 * `knownDefectActive` (src/schedule/ready.ts) holds: until `fixUnit`'s lineage merges. Ids are plan-scoped and never reused.
 */
export type KnownDefect = Readonly<{ id: KnownDefectId; match: KnownDefectMatch; fixUnit: UnitId }>;

/** M4a rev 3 (E, R40): how plan-check runs, per builder class (`by-builder`) or for every unit alike (`uniform`, the default). */
export const PLAN_CHECK_SHAPES = ['uniform', 'by-builder'] as const;
export type PlanCheckShape = (typeof PLAN_CHECK_SHAPES)[number];

/**
 * Plan defects (2026-10-16): files the build derives from others (a bundle from its sources). A unit whose scope covers a
 * source pattern takes the outputs into its effective scope (`derivedWidening`, src/input/derived.ts, pinned on its
 * dispatch record as `derived`), so salvage keeps, and the gate and candidate allow, a regenerated output.
 *
 * `regenerate` (dev.12): the generator, run from the repo root's `cwd` with no shell. A unit whose diff touches a source or
 * an output has it run at the lanes stage, in a clean checkout of its commit, and the outputs must come out byte-identical
 * to what the commit holds (`regenerateLane`, src/input/derived.ts). Absent: no check (lasting: an entry may have no
 * runnable generator).
 */
export type DerivedFiles = Readonly<{ sources: readonly RepoPattern[]; outputs: readonly RepoPattern[]; regenerate?: ToolCommand }>;

/**
 * The lane id a derived entry's regenerate check runs under: `regenerate.` and the first 12 hex digits of the entry's
 * canonical hash, so an apply reordering the entries keeps each id, and one changing an entry gives it a new one. A suite
 * lane may not take one (parsePlan).
 */
export const regenerateLaneId = (entry: DerivedFiles): LaneId => laneId(`regenerate.${sha256Hex(canonicalJson(entry)).slice(0, 12)}`);

/** The plan's derived files; none when absent. */
export const derivedOf = (plan: PlanM1): readonly DerivedFiles[] => plan.derived ?? [];

/**
 * dev.13: a command of a bring-up, run with no shell from the root of the checkout it brings up (a walk's, a compare
 * instance's, the demo's). Non-empty; `{port:<name>}` in any element is substituted (`PORT_PLACEHOLDER`).
 */
export type Argv = readonly string[];
/**
 * How a `serve` entry is known to be ready: an HTTP GET of `http` (a URL, `{port:<name>}` substituted) answering below 500,
 * or `log` appearing in its stdout or stderr (a substring, never a regex).
 */
export type ServeReady = Readonly<{ http: string }> | Readonly<{ log: string }>;
/** A long-lived process of a bring-up: a web server, an API, a broker. Each takes one code-allocated free port, `{port:<name>}`. */
export type ServeEntry = Readonly<{ name: ServeName; argv: Argv; ready: ServeReady }>;
/**
 * dev.13: how code brings a milestone's product up (a walk, a compare instance, the demo): `setup` (each run to exit 0, in
 * order), then every `serve` entry as a contained spawn tied to its owner, each probed ready, then `seed` (each to exit 0).
 * `serve: []`: nothing long-lived (a CLI, an SDK). `env` is added to every command's environment. `{port:<name>}` names a
 * serve entry of this bring-up, in `env` values, every argv element, `ready.http` and a journey's `entry`.
 */
export type BringUp = Readonly<{ setup: readonly Argv[]; serve: readonly ServeEntry[]; env: Readonly<Record<string, string>>; seed: readonly Argv[] }>;
/** `{port:<name>}`: the one placeholder of a bring-up, its name a serve entry's. */
export const PORT_PLACEHOLDER = /\{port:([^}]*)\}/g;
export const JOURNEY_DRIVES = ['browser', 'shell'] as const;
/** `browser`: a page, walked through the walkthrough MCP servers; `shell`: a CLI, HTTP, a bus client, an SDK script, a config edit. */
export type JourneyDrive = (typeof JOURNEY_DRIVES)[number];
/**
 * A journey (dev.13): plain language, as the user or client would say it; `entry` the URL path, command or base URL where it
 * starts (`{port:<name>}` substituted); `budget` its step and time budget, null for none.
 */
export type Journey = Readonly<{ id: JourneyId; text: string; via: JourneyDrive; entry: string; budget: Readonly<{ steps: number; seconds: number }> | null }>;
/** The milestone's design unit (a planned unit of the plan), or a design the owner supplied (its `references`). */
export type MilestoneDesign = Readonly<{ unit: UnitId }> | Readonly<{ supplied: true }>;
/**
 * dev.13: a milestone, the smallest thing someone can experience end to end. Reached when every unit of `units` is retired;
 * then walked (`walk-n`). `references`: the design reference directories it builds to and extends (they outlive it).
 * `resources`: what a bring-up of it reserves, as a unit's resources.
 */
export type Milestone = Readonly<{
  id: MilestoneId;
  text: string;
  units: readonly UnitId[];
  design: MilestoneDesign;
  references: readonly RepoPath[];
  bringUp: BringUp;
  journeys: readonly Journey[];
  resources: readonly ResourceName[];
}>;

/** The plan's milestones; none when absent (every plan before dev.13: lasting). */
export const milestonesOf = (plan: Pick<PlanM1, 'milestones'>): readonly Milestone[] => plan.milestones ?? [];
/** Whether the plan has milestones: what puts the walk roles in force (src/routing/layers.ts). */
export const hasMilestones = (plan: Pick<PlanM1, 'milestones'>): boolean => milestonesOf(plan).length > 0;
/**
 * Whether the plan has milestones without the holistic layer (ruling 2: a walk's findings need the ledger, the checkpoint
 * and fix units): the Phase-0 row `milestones-need-holistic` (src/phase0/rows.ts), which the classifier names too, before
 * it resolves a routing that would put the walk roles in force outside a holistic arc.
 */
export const milestonesNeedHolistic = (plan: Pick<PlanM1, 'milestones' | 'holistic'>): boolean => hasMilestones(plan) && plan.holistic === undefined;
/** The milestone `id` of the plan; an unknown id is a bug. */
export function milestoneOf(plan: Pick<PlanM1, 'milestones'>, id: MilestoneId): Milestone {
  const m = milestonesOf(plan).find((x) => x.id === id);
  if (m === undefined) throw new Error(`no milestone ${id} in the plan`);
  return m;
}
/** The milestones that list `unit` in their `units`, in plan order. */
export const milestonesOfUnit = (plan: Pick<PlanM1, 'milestones'>, unit: UnitId): readonly Milestone[] => milestonesOf(plan).filter((m) => m.units.includes(unit));
/** The milestone's design unit, or null when its design was supplied. */
export const designUnitOf = (m: Milestone): UnitId | null => ('unit' in m.design ? m.design.unit : null);
/** The walks a milestone may take (`limits.walkRounds`); 3 when absent. */
export const walkRoundsOf = (plan: Pick<PlanM1, 'limits'>): number => plan.limits?.walkRounds ?? DEFAULT_WALK_ROUNDS;
/** The serve names `text` names in `{port:<name>}` placeholders, in order of appearance. */
export function portNames(text: string): readonly string[] {
  return [...text.matchAll(PORT_PLACEHOLDER)].map((m) => m[1] as string);
}

/** The plan's known defects; none when absent. */
export const knownDefectsOf = (plan: PlanM1): readonly KnownDefect[] => plan.knownDefects ?? [];
/** The plan's plan-check shape (R40: a non-holistic arc always runs `uniform`, the caller's rule); `uniform` when absent. */
export const planCheckShapeOf = (plan: PlanM1): PlanCheckShape => plan.planCheck?.shape ?? 'uniform';

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
  /** M4a rev 3 (F4): known defects, ids unique (absent: none, lasting; `knownDefectsOf`). */
  knownDefects?: readonly KnownDefect[];
  /** M4a rev 3 (E): the plan-check shape (absent: `uniform`, lasting; `planCheckShapeOf`). */
  planCheck?: Readonly<{ shape: PlanCheckShape }>;
  /** Plan defects (2026-10-16): derived files (absent: none, lasting; `derivedOf`). */
  derived?: readonly DerivedFiles[];
  /** dev.13: the milestones, ids unique (absent: none, lasting; `milestonesOf`). Changed only by `apply`. */
  milestones?: readonly Milestone[];
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
  const walkRounds = f.optional('walkRounds', positive);
  return { ...limitsFields(f), ...(k === undefined ? {} : { convergenceK: k }), ...(walkRounds === undefined ? {} : { walkRounds }) } as ArcLimits;
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
  const fixes = f.optional('fixes', failureRef);
  return {
    unit: f.get('unit', (v, p) => unitId(v, p)), ...(enterAt === undefined ? {} : { enterAt }), ...(reset === undefined ? {} : { reset }), ...(fixes === undefined ? {} : { fixes }),
  };
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
  const priority = f.optional('priority', oneOf(UNIT_PRIORITIES));
  const polish = f.optional('polish', object((g): PolishOrigin => ({ milestone: g.get('milestone', (v, p) => milestoneId(v, p)), proposal: g.get('proposal', (v, p) => polishId(v, p)) })));
  if ((origin === 'polish') !== (polish !== undefined)) throw new SchemaError(`${f.path}.polish`, origin === 'polish' ? 'the milestone and proposal of a polish unit' : 'absent (only a polish unit carries it)', polish);
  assertUnique(out.scope, (s) => s, `${f.path}.scope`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  assertUnique(out.after, (u) => u, `${f.path}.after`);
  if (reenters?.unit === out.id) throw new SchemaError(`${f.path}.reenters.unit`, 'a unit other than itself', reenters.unit);
  return {
    ...out, ...(origin === undefined ? {} : { origin }), ...(cpu === undefined ? {} : { cpu }), ...(reenters === undefined ? {} : { reenters }),
    ...(cutField === undefined ? {} : { cut: cutField }), ...(routing === undefined ? {} : { routing }), ...(limits === undefined ? {} : { limits }),
    ...(priority === undefined ? {} : { priority }), ...(polish === undefined ? {} : { polish }),
  };
});

const patterns: Read<readonly RepoPattern[]> = (value, path) => {
  const out = arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })(value, path);
  assertUnique(out, (x) => x, path);
  return out;
};
const derivedFiles: Read<DerivedFiles> = object((f) => {
  const regenerate = f.optional('regenerate', toolCommand);
  return { sources: f.get('sources', patterns), outputs: f.get('outputs', patterns), ...(regenerate === undefined ? {} : { regenerate }) };
});

const argvR: Read<Argv> = arrayOf(str, { nonEmpty: true });
const serveReady: Read<ServeReady> = (value, path) => {
  const keys = typeof value === 'object' && value !== null ? Object.keys(value) : [];
  if (keys.length === 1 && keys[0] === 'http') return object((g): ServeReady => ({ http: g.get('http', str) }))(value, path);
  if (keys.length === 1 && keys[0] === 'log') return object((g): ServeReady => ({ log: g.get('log', str) }))(value, path);
  throw new SchemaError(path, '{http: <url>} or {log: <substring>}', value);
};
/**
 * dev.13: the demo's name, reserved: `refs/roadmap/demo` (beside the arcs' `refs/roadmap/<arc>`) and `<worktreeRoot>/demo`
 * (beside `<worktreeRoot>/<arc>`) are the demo's (src/demo/), so no arc takes it.
 */
export const DEMO_NAME = 'demo';
const planArc: Read<ArcId> = (v, p) => {
  const arc = arcId(v, p);
  if (arc === DEMO_NAME) throw new SchemaError(p, `an arc id other than "${DEMO_NAME}" (reserved: refs/roadmap/${DEMO_NAME} and <worktreeRoot>/${DEMO_NAME} are the demo's)`, v);
  return arc;
};

/** A milestone's bring-up as the plan holds it (also the demo's records, src/demo/records.ts). */
export const bringUpR: Read<BringUp> = object((f) => {
  const out: BringUp = {
    setup: f.get('setup', arrayOf(argvR)),
    serve: f.get('serve', arrayOf(object((g): ServeEntry => ({ name: g.get('name', (v, p) => serveName(v, p)), argv: g.get('argv', argvR), ready: g.get('ready', serveReady) })))),
    env: f.get('env', stringMap),
    seed: f.get('seed', arrayOf(argvR)),
  };
  assertUnique(out.serve, (s) => s.name, `${f.path}.serve`);
  return out;
});
const journey: Read<Journey> = object((f) => ({
  id: f.get('id', (v, p) => journeyId(v, p)),
  text: f.get('text', str),
  via: f.get('via', oneOf(JOURNEY_DRIVES)),
  entry: f.get('entry', str),
  budget: f.get('budget', nullable(object((g) => ({ steps: g.get('steps', positive), seconds: g.get('seconds', positive) })))),
}));
const milestoneDesign: Read<MilestoneDesign> = (value, path) => {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'supplied')) return object((g): MilestoneDesign => ({ supplied: g.get('supplied', literal(true)) }))(value, path);
  return object((g): MilestoneDesign => ({ unit: g.get('unit', (v, p) => unitId(v, p)) }))(value, path);
};
const milestone: Read<Milestone> = object((f) => {
  const out: Milestone = {
    id: f.get('id', (v, p) => milestoneId(v, p)),
    text: f.get('text', str),
    units: f.get('units', arrayOf((v, p) => unitId(v, p), { nonEmpty: true })),
    design: f.get('design', milestoneDesign),
    references: f.get('references', arrayOf((v, p) => repoPath(v, p))),
    bringUp: f.get('bringUp', bringUpR),
    journeys: f.get('journeys', arrayOf(journey)),
    resources: f.get('resources', arrayOf((v, p) => resourceName(v, p))),
  };
  assertUnique(out.units, (u) => u, `${f.path}.units`);
  assertUnique(out.references, (r) => r, `${f.path}.references`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  return out;
});

/**
 * The in-file refusals of a plan's milestones (dev.13), each one sentence naming the milestone: a unit or design unit the
 * plan does not hold, a design unit that is not a planned unit or is listed in its own milestone's units, a milestone
 * with no journeys or no references, a resource the plan does not declare, a `{port:<name>}` naming no serve entry of its
 * bring-up. Ids (milestones, journeys across milestones) are unique. `parsePlan` throws the first as a SchemaError.
 */
export function milestoneRefusals(plan: PlanM1): readonly Readonly<{ path: string; expected: string; value: unknown }>[] {
  const out: { path: string; expected: string; value: unknown }[] = [];
  const units = new Map(plan.units.map((u) => [u.id, u]));
  const declared = new Set(plan.resources.map((r) => r.name));
  milestonesOf(plan).forEach((m, i) => {
    const at = `plan.milestones[${i}]`;
    m.units.forEach((u, j) => {
      if (!units.has(u)) out.push({ path: `${at}.units[${j}]`, expected: `a unit of the plan (milestone ${m.id})`, value: u });
    });
    const design = designUnitOf(m);
    if (design !== null) {
      const d = units.get(design);
      if (d === undefined) out.push({ path: `${at}.design.unit`, expected: `a unit of the plan (milestone ${m.id}'s design unit)`, value: design });
      else if ((d.origin ?? 'planned') !== 'planned') out.push({ path: `${at}.design.unit`, expected: `a planned unit (milestone ${m.id}'s design unit)`, value: design });
      if (m.units.includes(design)) out.push({ path: `${at}.design.unit`, expected: `a unit outside milestone ${m.id}'s own units (its design unit designs them)`, value: design });
    }
    if (m.journeys.length === 0) out.push({ path: `${at}.journeys`, expected: `at least one journey (milestone ${m.id})`, value: m.journeys });
    if (m.references.length === 0) out.push({ path: `${at}.references`, expected: `at least one design reference directory (milestone ${m.id})`, value: m.references });
    m.resources.forEach((r, j) => {
      if (!declared.has(r)) out.push({ path: `${at}.resources[${j}]`, expected: `a resource the plan declares (milestone ${m.id})`, value: r });
    });
    const serves = new Set<string>(m.bringUp.serve.map((s) => s.name));
    const texts: [string, string][] = [
      ...Object.entries(m.bringUp.env).map(([k, v]): [string, string] => [`${at}.bringUp.env.${k}`, v]),
      ...(['setup', 'seed'] as const).flatMap((k) => m.bringUp[k].flatMap((argv, j) => argv.map((a, n): [string, string] => [`${at}.bringUp.${k}[${j}][${n}]`, a]))),
      ...m.bringUp.serve.flatMap((s, j) => [
        ...s.argv.map((a, n): [string, string] => [`${at}.bringUp.serve[${j}].argv[${n}]`, a]),
        ...('http' in s.ready ? [[`${at}.bringUp.serve[${j}].ready.http`, s.ready.http] as [string, string]] : []),
      ]),
      ...m.journeys.map((jr, j): [string, string] => [`${at}.journeys[${j}].entry`, jr.entry]),
    ];
    for (const [path, text] of texts) {
      for (const name of portNames(text)) {
        if (!serves.has(name)) out.push({ path, expected: `{port:<name>} naming a serve entry of milestone ${m.id}'s bring-up`, value: `{port:${name}}` });
      }
    }
  });
  return out;
}

const knownDefect: Read<KnownDefect> = object((f) => ({
  id: f.get('id', (v, p) => knownDefectId(v, p)),
  match: f.get('match', knownDefectMatch),
  fixUnit: f.get('fixUnit', (v, p) => unitId(v, p)),
}));

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
    const knownDefects = f.optional('knownDefects', arrayOf(knownDefect, { nonEmpty: true }));
    const planCheck = f.optional('planCheck', object((g) => ({ shape: g.get('shape', oneOf(PLAN_CHECK_SHAPES)) })));
    const derived = f.optional('derived', arrayOf(derivedFiles));
    const milestones = f.optional('milestones', arrayOf(milestone, { nonEmpty: true }));
    const out: PlanM1 = {
      schema: f.get('schema', literal(PLAN_SCHEMA)),
      arc: f.get('arc', planArc),
      integrationBranch: f.get('integrationBranch', (v, p) => branchName(v, p)),
      baseline: f.get('baseline', (v, p) => sha(v, p)),
      worktreeRoot: f.get('worktreeRoot', (v, p) => absPath(v, p)),
      contracts: f.get('contracts', arrayOf((v, p) => repoPath(v, p))),
      rulings: f.get('rulings', (v, p) => planPath(v, p)),
      direction: f.get('direction', str),
      ...(routing === undefined ? {} : { routing }),
      ...(capacity === undefined ? {} : { capacity }),
      suite: f.get('suite', object((g) => ({ lanes: g.get('lanes', arrayOf(laneDefOf('suite'))) }))),
      resources: f.get('resources', arrayOf(resourceDecl)),
      units: f.get('units', arrayOf(planUnit, { nonEmpty: true })),
      ...(limits === undefined ? {} : { limits }),
      ...(chain === undefined ? {} : { chain }),
      ...(knownDefects === undefined ? {} : { knownDefects }),
      ...(planCheck === undefined ? {} : { planCheck }),
      ...(derived === undefined ? {} : { derived }),
      ...(milestones === undefined ? {} : { milestones }),
      ...target,
    };
    // dev.17: a batch lane runs at milestones, cadence audits and the close-out, which only the holistic layer has.
    out.suite.lanes.forEach((l, i) => {
      if (l.cadence === 'batch' && out.holistic === undefined) throw new SchemaError(`plan.suite.lanes[${i}].cadence`, 'build, unit or candidate outside a holistic arc (a batch lane runs at milestones, audits and the close-out)', l.cadence);
    });
    assertUnique(knownDefectsOf(out), (k) => k.id, 'plan.knownDefects');
    assertUnique(out.contracts, (c) => c, 'plan.contracts');
    assertUnique([...out.suite.lanes.map((l) => l.id), ...derivedOf(out).filter((d) => d.regenerate !== undefined).map(regenerateLaneId)], (id) => id, 'plan.suite.lanes');
    assertUnique(out.resources, (r) => r.name, 'plan.resources');
    assertUnique(out.units, (u) => u.id, 'plan.units');
    assertUnique(out.units, (u) => u.spec, 'plan.units');
    assertUnique(out.units.flatMap((u) => u.contingent), (e) => e.id, 'plan.units[].contingent');
    assertUnique(milestonesOf(out), (m) => m.id, 'plan.milestones');
    assertUnique(milestonesOf(out).flatMap((m) => m.journeys), (j) => j.id, 'plan.milestones[].journeys');
    const refused = milestoneRefusals(out)[0];
    if (refused !== undefined) throw new SchemaError(refused.path, refused.expected, refused.value);
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
