// The M4b flow loop's records and domain types (SCHEMAS.md "M4b: the flow loop"; plan
// /claude-state/plans/m4b-flow.md rev 2). Frozen in step 0a: the series and its points, the host fingerprint, the levers
// and their actions, a flow run's kept inputs and its strict output, proofs, verdicts, preimages and givens. The facts
// that carry them are src/core/events.ts's `FlowFact`; the behaviour is the later steps' (series, SPC, constraint,
// triggers, the job, levers, givens, verdicts, proofs). Rev 3 (host pressure, step H0; SCHEMAS.md "Rev 3: host
// pressure") adds the points' and suite runs' `pressure`, the `host-pressure` trigger, the `direction` drop reason, the
// `pressure` metric and `status.flow.pressure`'s shape.
import {
  type ArcId, type GivenId, type JobId, type LaneId, type ProposalId, type ResourceName, type StationId, type UnitId, type VisionClauseId, arcId, givenId,
  idsAscending, jobIdOfKind, laneId, parseStationId, proposalId, resourceName, stationId, unitId, visionClauseId,
} from '../core/ids.ts';
import { type Read, SchemaError, arrayOf, assertUnique, bool, literal, nat, nullable, object, oneOf, positive, sortedBy, str, tagged } from '../core/validate.ts';
import { type IsoTime, isoTime } from '../core/values.ts';
import type { Reporter } from '../holistic/types.ts';
import { UNIT_PRIORITIES, type UnitPriority } from '../input/plan.ts';
import { type ModelClass, type RiskTier, modelClass, riskTier } from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Numbers

/** A finite number (a log-scale centre may be negative). */
export const finite: Read<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(path, 'a finite number', value);
  return value;
};
/** A finite non-negative number: minutes, dollars, rates. */
export const amount: Read<number> = (value, path) => {
  const n = finite(value, path);
  if (n < 0) throw new SchemaError(path, 'a finite non-negative number', value);
  return n;
};
/** A fraction in [0, 1]: a share, a pressure. */
export const fraction: Read<number> = (value, path) => {
  const n = amount(value, path);
  if (n > 1) throw new SchemaError(path, 'a fraction in [0, 1]', value);
  return n;
};

const stationR: Read<StationId> = (v, p) => stationId(v, p);
const laneR: Read<LaneId> = (v, p) => laneId(v, p);
const unitR: Read<UnitId> = (v, p) => unitId(v, p);
const resourceR: Read<ResourceName> = (v, p) => resourceName(v, p);
const timeR: Read<IsoTime> = (v, p) => isoTime(v, p);
const proposalR: Read<ProposalId> = (v, p) => proposalId(v, p);
const flowJobR: Read<JobId> = (v, p) => jobIdOfKind('flow')(v, p);

// ---------------------------------------------------------------------------------------------------
// The host fingerprint (R11): an additive field of `executor-started` since 1.0.0-dev.8, read once per start
// (src/host/sample.ts `readHostFingerprint`). Limits seed only from previous arcs with an equal one; a host given is
// enforced only while it matches.

export type HostFingerprint = Readonly<{ platform: string; arch: string; cpus: number; memGiB: number }>;
export const hostFingerprint: Read<HostFingerprint> = object((f) => ({
  platform: f.get('platform', str), arch: f.get('arch', str), cpus: f.get('cpus', positive), memGiB: f.get('memGiB', positive),
}));
export const sameHost = (a: HostFingerprint, b: HostFingerprint): boolean => a.platform === b.platform && a.arch === b.arch && a.cpus === b.cpus && a.memGiB === b.memGiB;

// ---------------------------------------------------------------------------------------------------
// The flow series (`inputs/<sha>.flow-series.json`, named by `flow-series`; src/flow/series.ts computes it)

/**
 * The kept series' format; a reader recomputes the series from the ref's events when a kept record's `v` differs. 2 (M4b
 * rev 3): points and suite runs carry `pressure`.
 */
export const FLOW_SERIES_V = 2;

/**
 * One merged unit (batch-merged units are counted in T and excluded): admitted at its first `dispatch`, merged when its
 * publication ends (its `snapshot` outcome right after the ff, so the slot's `ff` and `snapshot` components lie inside the
 * lead time; src/flow/series.ts). `minutes` partitions `leadMin` over disjoint stations (`slot:integration` itself is never a key: its
 * components are; nor is `host:cpu`); `rework` counts T-alone reruns and other rework, `firstRunReds` the suite reds of first runs.
 * `pressure` (rev 3): the time-weighted mean pressure (a launch's own cpu wait, src/host/pressure.ts) over the unit's
 * measured service intervals (the spawns its stages ran that have one, clipped to its lead time), null when none has; `stationPressure` the same mean per station those
 * spawns served (a key per service station with at least one spawn: `stage:<s>`, `suite:<lane>`, `arc-lanes`,
 * `candidate-rest`), what the station table's per-station pressure reads.
 */
export type FlowPoint = Readonly<{
  unit: UnitId;
  admittedAt: IsoTime;
  mergedAt: IsoTime;
  leadMin: number;
  minutes: Readonly<Record<StationId, number>>;
  costUsd: number | null;
  rework: number;
  firstRunReds: number;
  pressure: number | null;
  stationPressure: Readonly<Record<StationId, number | null>>;
}>;

/** The four shapes a suite run takes (R2): a `lane{set: suite}` spawn, a unit's F6 stand-in journey, a batch job's journey, a red path's T-alone rerun. */
export const SUITE_RUN_SHAPES = ['lane', 'stand-in', 'batch', 'rerun'] as const;
export type SuiteRunShape = (typeof SUITE_RUN_SHAPES)[number];
/** One suite-lane run, sampled per run: the verdict metric of a `suite-lane` lever. `pressure` (rev 3): its spawn's pressure. */
export type SuiteRun = Readonly<{ lane: LaneId; at: IsoTime; minutes: number; shape: SuiteRunShape; red: boolean; pressure: number | null }>;

/**
 * Throughput accounting (RC-2), diagnostic only, never a goal: `tAdvances` (obligations held for the first time this arc
 * per hour, serving an `advances` clause) and `tOther` (the rest), both null on a non-holistic arc; `tUnits` units merged
 * per hour; `wip` admitted-not-merged plus ready queued; `oeUsdPerHour` executor spend per hour.
 */
export type FlowAccounting = Readonly<{ tAdvances: number | null; tOther: number | null; tUnits: number; wip: number; oeUsdPerHour: number }>;

/** `host` null: no start of the arc recorded a fingerprint (a 1.0.0-dev.7 ref, recomputed); such a series never seeds. */
export type FlowSeries = Readonly<{
  v: typeof FLOW_SERIES_V;
  arc: ArcId;
  host: HostFingerprint | null;
  points: readonly FlowPoint[];
  suiteRuns: readonly SuiteRun[];
  accounting: FlowAccounting;
}>;

const minutesRecord: Read<Readonly<Record<StationId, number>>> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SchemaError(path, 'an object of station minutes', value);
  const out: Record<StationId, number> = {};
  for (const [key, v] of Object.entries(value)) {
    const parts = parseStationId(key, `${path}.${key}`);
    if (parts.type === 'slot') throw new SchemaError(`${path}.${key}`, 'a leaf station (the slot is the sum of its components)', key);
    if (parts.type === 'host-cpu') throw new SchemaError(`${path}.${key}`, 'a share of lead time (host:cpu is none)', key);
    out[key as StationId] = amount(v, `${path}.${key}`);
  }
  return out;
};

/** A point's per-station pressure: leaf stations only (never the slot or host:cpu), each a fraction or null. */
const stationPressureRecord: Read<Readonly<Record<StationId, number | null>>> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SchemaError(path, 'an object of station pressures', value);
  const out: Record<StationId, number | null> = {};
  for (const [key, v] of Object.entries(value)) {
    const parts = parseStationId(key, `${path}.${key}`);
    if (parts.type === 'slot' || parts.type === 'host-cpu') throw new SchemaError(`${path}.${key}`, 'a leaf station', key);
    out[key as StationId] = nullable(fraction)(v, `${path}.${key}`);
  }
  return out;
};

const flowPoint: Read<FlowPoint> = object((f) => {
  const out = {
    unit: f.get('unit', unitR), admittedAt: f.get('admittedAt', timeR), mergedAt: f.get('mergedAt', timeR), leadMin: f.get('leadMin', amount),
    minutes: f.get('minutes', minutesRecord), costUsd: f.get('costUsd', nullable(amount)), rework: f.get('rework', nat), firstRunReds: f.get('firstRunReds', nat),
    pressure: f.get('pressure', nullable(fraction)), stationPressure: f.get('stationPressure', stationPressureRecord),
  };
  if (out.mergedAt < out.admittedAt) throw new SchemaError(`${f.path}.mergedAt`, `not before admittedAt ${out.admittedAt}`, out.mergedAt);
  const sum = Object.values(out.minutes).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - out.leadMin) > 1e-6 * Math.max(1, out.leadMin)) throw new SchemaError(`${f.path}.minutes`, `stations summing to leadMin ${out.leadMin}`, sum);
  return out;
});

const suiteRun: Read<SuiteRun> = object((f) => ({
  lane: f.get('lane', laneR), at: f.get('at', timeR), minutes: f.get('minutes', amount), shape: f.get('shape', oneOf(SUITE_RUN_SHAPES)), red: f.get('red', bool),
  pressure: f.get('pressure', nullable(fraction)),
}));

export const flowAccounting: Read<FlowAccounting> = object((f) => {
  const out = {
    tAdvances: f.get('tAdvances', nullable(amount)), tOther: f.get('tOther', nullable(amount)), tUnits: f.get('tUnits', amount), wip: f.get('wip', nat),
    oeUsdPerHour: f.get('oeUsdPerHour', amount),
  };
  if ((out.tAdvances === null) !== (out.tOther === null)) throw new SchemaError(`${f.path}.tOther`, 'null exactly when tAdvances is (a non-holistic arc)', out.tOther);
  return out;
});

/** Non-decreasing by `key`. */
function inOrder<T>(items: readonly T[], key: (t: T) => string, path: string): void {
  for (let i = 1; i < items.length; i++) if (key(items[i] as T) < key(items[i - 1] as T)) throw new SchemaError(`${path}[${i}]`, 'entries in time order', key(items[i] as T));
}

export const flowSeries: Read<FlowSeries> = object((f) => {
  const out = {
    v: f.get('v', literal(FLOW_SERIES_V)), arc: f.get('arc', (v, p) => arcId(v, p)), host: f.get('host', nullable(hostFingerprint)),
    points: f.get('points', arrayOf(flowPoint)), suiteRuns: f.get('suiteRuns', arrayOf(suiteRun)), accounting: f.get('accounting', flowAccounting),
  };
  assertUnique(out.points, (p) => p.unit, `${f.path}.points`);
  inOrder(out.points, (p) => p.mergedAt, `${f.path}.points`);
  inOrder(out.suiteRuns, (r) => r.at, `${f.path}.suiteRuns`);
  return out;
});
export function parseFlowSeries(value: unknown): FlowSeries {
  return flowSeries(value, 'flowSeries');
}

// ---------------------------------------------------------------------------------------------------
// Levers, actions and proposals (src/flow/levers.ts)

/** The closed lever classes; a given names one. `host` is owner advice, never applied (RC-7: no rope lever). */
export const FLOW_LEVERS = ['concurrency', 'resource-pool', 'suite-lane', 'sequence', 'build-class', 'host'] as const;
export type FlowLever = (typeof FLOW_LEVERS)[number];
/** A suite-lane proof's reporters (RC-4): the witness reporters a test id set can be read with. */
export const FLOW_REPORTERS = ['node-test', 'go-test-json'] as const satisfies readonly Reporter[];
export type FlowReporter = (typeof FLOW_REPORTERS)[number];
/** The five focusing steps a lever serves (G7): code derives it from the lever, never the model. */
export const TOC_STEPS = ['exploit', 'subordinate', 'elevate'] as const;
export type TocStep = (typeof TOC_STEPS)[number];

/**
 * What a proposal changes. `concurrency`: the plan's `capacity.cpu` (≤ the fingerprint's cpus); `resource-pool`: a pool's
 * size; `suite-lane`: a suite lane's argv (one allowlisted flag's value changed in place, proved test-set-preserving
 * with `reporter`) and/or its `cpu`, at least one of the two; `sequence`: a unit to `high`; `build-class`: a build tier's
 * class, one step, never below the tier's built-in class (RC-8); `host`: advice to the owner.
 */
export type FlowAction =
  | Readonly<{ lever: 'concurrency'; cpu: number }>
  | Readonly<{ lever: 'resource-pool'; resource: ResourceName; size: number }>
  | Readonly<{ lever: 'suite-lane'; lane: LaneId; argv?: readonly string[]; reporter?: FlowReporter; cpu?: number }>
  | Readonly<{ lever: 'sequence'; unit: UnitId; priority: 'high' }>
  | Readonly<{ lever: 'build-class'; tier: RiskTier; class: ModelClass }>
  | Readonly<{ lever: 'host'; note: string }>;

/** A proposal; its id is `<job>.0`, assigned by code. */
export type FlowProposal = Readonly<{ id: ProposalId; target: StationId; action: FlowAction; rationale: string; risks: string }>;

/** A suite-lane action's optional fields as recorded: present or absent, never null. */
function suiteLaneAction(lane: LaneId, argv: readonly string[] | undefined, reporter: FlowReporter | undefined, cpu: number | undefined, path: string): FlowAction {
  if (argv === undefined && cpu === undefined) throw new SchemaError(path, 'a suite-lane action changing argv, cpu or both', { lane });
  return { lever: 'suite-lane', lane, ...(argv === undefined ? {} : { argv }), ...(reporter === undefined ? {} : { reporter }), ...(cpu === undefined ? {} : { cpu }) };
}

/** A recorded action (facts, kept inputs): optional fields absent, never null. */
export const flowAction: Read<FlowAction> = tagged('lever', {
  concurrency: object((f): FlowAction => ({ lever: f.get('lever', literal('concurrency')), cpu: f.get('cpu', positive) })),
  'resource-pool': object((f): FlowAction => ({ lever: f.get('lever', literal('resource-pool')), resource: f.get('resource', resourceR), size: f.get('size', positive) })),
  'suite-lane': object((f): FlowAction => {
    f.get('lever', literal('suite-lane'));
    return suiteLaneAction(
      f.get('lane', laneR), f.optional('argv', arrayOf(str, { nonEmpty: true })), f.optional('reporter', oneOf(FLOW_REPORTERS)), f.optional('cpu', positive), f.path,
    );
  }),
  sequence: object((f): FlowAction => ({ lever: f.get('lever', literal('sequence')), unit: f.get('unit', unitR), priority: f.get('priority', literal('high')) })),
  'build-class': object((f): FlowAction => ({ lever: f.get('lever', literal('build-class')), tier: f.get('tier', riskTier), class: f.get('class', modelClass) })),
  host: object((f): FlowAction => ({ lever: f.get('lever', literal('host')), note: f.get('note', str) })),
});

export const flowProposal: Read<FlowProposal> = object((f) => ({
  id: f.get('id', proposalR), target: f.get('target', stationR), action: f.get('action', flowAction), rationale: f.get('rationale', str), risks: f.get('risks', str),
}));

/**
 * What a rejection is remembered by (RC-9): `(station, lever, target)`, never the value. `target` is the lane, resource,
 * tier or unit the action names, `capacity` for `concurrency`, `host` for advice.
 */
export type LeverTarget =
  | Readonly<{ type: 'lane'; lane: LaneId }>
  | Readonly<{ type: 'resource'; resource: ResourceName }>
  | Readonly<{ type: 'tier'; tier: RiskTier }>
  | Readonly<{ type: 'unit'; unit: UnitId }>
  | Readonly<{ type: 'capacity' }>
  | Readonly<{ type: 'host' }>;
export const leverTarget: Read<LeverTarget> = tagged('type', {
  lane: object((f): LeverTarget => ({ type: f.get('type', literal('lane')), lane: f.get('lane', laneR) })),
  resource: object((f): LeverTarget => ({ type: f.get('type', literal('resource')), resource: f.get('resource', resourceR) })),
  tier: object((f): LeverTarget => ({ type: f.get('type', literal('tier')), tier: f.get('tier', riskTier) })),
  unit: object((f): LeverTarget => ({ type: f.get('type', literal('unit')), unit: f.get('unit', unitR) })),
  capacity: object((f): LeverTarget => ({ type: f.get('type', literal('capacity')) })),
  host: object((f): LeverTarget => ({ type: f.get('type', literal('host')) })),
});
/** The target an action names: the one canonical mapping (RC-9). */
export function leverTargetOf(action: FlowAction): LeverTarget {
  switch (action.lever) {
    case 'concurrency': return { type: 'capacity' };
    case 'resource-pool': return { type: 'resource', resource: action.resource };
    case 'suite-lane': return { type: 'lane', lane: action.lane };
    case 'sequence': return { type: 'unit', unit: action.unit };
    case 'build-class': return { type: 'tier', tier: action.tier };
    case 'host': return { type: 'host' };
  }
}

export type RejectionKey = Readonly<{ station: StationId; lever: FlowLever; target: LeverTarget }>;
export const rejectionKey: Read<RejectionKey> = object((f) => ({ station: f.get('station', stationR), lever: f.get('lever', oneOf(FLOW_LEVERS)), target: f.get('target', leverTarget) }));

/**
 * The plan values an applied action replaced, so a `worse` verdict names the revert (RC-6) and an absent field is told from a
 * set one: `cpu` null (no `capacity.cpu`: the host default), a lane's `cpu` null (its tier's default), `priority` null
 * (absent: normal), `class` null (no plan routing at that build seat: the built-in class). `host` is never applied.
 */
export type FlowPreimage =
  | Readonly<{ lever: 'concurrency'; cpu: number | null }>
  | Readonly<{ lever: 'resource-pool'; resource: ResourceName; size: number }>
  | Readonly<{ lever: 'suite-lane'; lane: LaneId; argv: readonly string[]; cpu: number | null }>
  | Readonly<{ lever: 'sequence'; unit: UnitId; priority: UnitPriority | null }>
  | Readonly<{ lever: 'build-class'; tier: RiskTier; class: ModelClass | null }>;
export const flowPreimage: Read<FlowPreimage> = tagged('lever', {
  concurrency: object((f): FlowPreimage => ({ lever: f.get('lever', literal('concurrency')), cpu: f.get('cpu', nullable(positive)) })),
  'resource-pool': object((f): FlowPreimage => ({ lever: f.get('lever', literal('resource-pool')), resource: f.get('resource', resourceR), size: f.get('size', positive) })),
  'suite-lane': object((f): FlowPreimage => ({
    lever: f.get('lever', literal('suite-lane')), lane: f.get('lane', laneR), argv: f.get('argv', arrayOf(str, { nonEmpty: true })), cpu: f.get('cpu', nullable(positive)),
  })),
  sequence: object((f): FlowPreimage => ({ lever: f.get('lever', literal('sequence')), unit: f.get('unit', unitR), priority: f.get('priority', nullable(oneOf(UNIT_PRIORITIES))) })),
  'build-class': object((f): FlowPreimage => ({ lever: f.get('lever', literal('build-class')), tier: f.get('tier', riskTier), class: f.get('class', nullable(modelClass)) })),
});

// ---------------------------------------------------------------------------------------------------
// The constraint (src/flow/constraint.ts) and the role's reading of it

/**
 * Code's constraint over the last min(10, n) points: the station with the largest mean wait in front of it when that
 * wait is ≥ 10 % of mean lead (`internal: true`), else the station with the largest mean service (`internal: false`).
 * `component` names the slot's largest service component exactly when the station is `slot:integration`. The one wait
 * it may name is `wait:finding` (internal, diagnostic: no lever targets it). Rev 3 (RC-10): `host:cpu` (internal), ahead of
 * the wait and service rules when the window's mean pressure is at least `PRESSURE_SATURATED`.
 */
export type CodeConstraint = Readonly<{ station: StationId; internal: boolean; component: StationId | null }>;
export const codeConstraint: Read<CodeConstraint> = object((f) => {
  const out = { station: f.get('station', stationR), internal: f.get('internal', bool), component: f.get('component', nullable(stationR)) };
  const parts = parseStationId(out.station);
  if (parts.type === 'held' || parts.type === 'slot-wait' || parts.type === 'wait') throw new SchemaError(`${f.path}.station`, 'a service station or wait:finding (never held or another wait)', out.station);
  if (parts.type === 'finding-wait' && !out.internal) throw new SchemaError(`${f.path}.internal`, 'true for wait:finding (a wait)', out.internal);
  if (parts.type === 'host-cpu' && !out.internal) throw new SchemaError(`${f.path}.internal`, 'true for host:cpu', out.internal);
  const isSlot = parts.type === 'slot';
  if (isSlot !== (out.component !== null)) throw new SchemaError(`${f.path}.component`, isSlot ? 'the slot\'s largest component' : 'null off the slot', out.component);
  if (out.component !== null) {
    const c = parseStationId(out.component);
    if (c.type !== 'suite' && c.type !== 'component') throw new SchemaError(`${f.path}.component`, 'a slot component (suite:<lane>, arc-lanes, candidate-rest, ff, snapshot)', out.component);
  }
  return out;
});

/** The flow role's reading of the constraint: it may dispute code's (`agree: false`, its own station and the reason). */
export type JudgedConstraint = Readonly<{ station: StationId; agree: boolean; reason: string }>;
const judgedConstraint: Read<JudgedConstraint> = object((f) => ({ station: f.get('station', stationR), agree: f.get('agree', bool), reason: f.get('reason', str) }));

// ---------------------------------------------------------------------------------------------------
// A flow run's kept inputs (`inputs/<sha>.flow-inputs.json`, named by `flow-started`; src/flow/job.ts captures them)

/**
 * Coalesced triggers, in this order (src/flow/trigger.ts). `host-pressure` (rev 3): a unit held for host pressure (a run
 * starved, or red under pressure) since the last run's start, while units are in flight.
 */
export const FLOW_TRIGGERS = ['buffer-red', 'yellow-worsening', 'host-pressure', 'constraint-shift', 'verdict-closed', 'floor', 'requested'] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];
/** Triggers as a fact or the inputs record them: non-empty, each once, in `FLOW_TRIGGERS` order. */
export const flowTriggers: Read<readonly FlowTrigger[]> = sortedBy(oneOf(FLOW_TRIGGERS), (t) => String(FLOW_TRIGGERS.indexOf(t)).padStart(2, '0'), { nonEmpty: true, order: 'in FLOW_TRIGGERS order' });

export const ZONES = ['green', 'yellow', 'red'] as const;
export type Zone = (typeof ZONES)[number];

/** Where the chart's limits came from: ≤ 20 points of completed previous arcs on an equal host, or this arc's first 5 merges. */
export type ChartSeed = Readonly<{ type: 'previous'; arcs: readonly ArcId[]; points: number }> | Readonly<{ type: 'self'; points: number }>;
const chartSeed: Read<ChartSeed> = tagged('type', {
  previous: object((f): ChartSeed => ({ type: f.get('type', literal('previous')), arcs: f.get('arcs', sortedBy((v, p) => arcId(v, p), (a) => a, { nonEmpty: true })), points: f.get('points', positive) })),
  self: object((f): ChartSeed => ({ type: f.get('type', literal('self')), points: f.get('points', positive) })),
});

/** The XmR chart on log(leadMin), frozen for the arc: centre, upper limit and mR̄ on the log scale; recent and in-flight units zoned. */
export type FlowChart = Readonly<{
  centre: number;
  ucl: number;
  mrBar: number;
  seed: ChartSeed;
  recent: readonly Readonly<{ unit: UnitId; leadMin: number; zone: Zone }>[];
  /** In-flight units by age excluding held time (a parked unit's clock stops). */
  inFlight: readonly Readonly<{ unit: UnitId; ageMin: number; zone: Zone }>[];
}>;
const flowChart: Read<FlowChart> = object((f) => {
  const out = {
    centre: f.get('centre', finite), ucl: f.get('ucl', finite), mrBar: f.get('mrBar', amount), seed: f.get('seed', chartSeed),
    recent: f.get('recent', arrayOf(object((g) => ({ unit: g.get('unit', unitR), leadMin: g.get('leadMin', amount), zone: g.get('zone', oneOf(ZONES)) })))),
    inFlight: f.get('inFlight', arrayOf(object((g) => ({ unit: g.get('unit', unitR), ageMin: g.get('ageMin', amount), zone: g.get('zone', oneOf(ZONES)) })))),
  };
  if (out.ucl < out.centre) throw new SchemaError(`${f.path}.ucl`, `not below the centre ${out.centre}`, out.ucl);
  return out;
});

/**
 * One station's mean minutes over the constraint's window, its share of mean lead, and (rev 3) the mean pressure
 * of the spawns that served it, weighted by the station's minutes in each point: null for a station no spawn served (a
 * wait, held time) or when none of them has a pressure.
 */
export type StationRow = Readonly<{ station: StationId; meanMin: number; share: number; pressure: number | null }>;
const stationRow: Read<StationRow> = object((f) => ({
  station: f.get('station', stationR), meanMin: f.get('meanMin', amount), share: f.get('share', fraction), pressure: f.get('pressure', nullable(fraction)),
}));

/**
 * A lever's current value in the plan in force (the catalogue a run reads). `concurrency.set`: the plan sets
 * `capacity.cpu` (else `cpu` is the host default); a suite lane's `cpu` null is its tier's default; `build-class.builtin`
 * is the tier's built-in class, the floor (RC-8).
 */
export type LeverState =
  | Readonly<{ lever: 'concurrency'; cpu: number; set: boolean; hostCpus: number }>
  | Readonly<{ lever: 'resource-pool'; resource: ResourceName; size: number }>
  | Readonly<{ lever: 'suite-lane'; lane: LaneId; argv: readonly string[]; cpu: number | null }>
  | Readonly<{ lever: 'sequence'; unit: UnitId; priority: UnitPriority }>
  | Readonly<{ lever: 'build-class'; tier: RiskTier; class: ModelClass; builtin: ModelClass }>;
const leverState: Read<LeverState> = tagged('lever', {
  concurrency: object((f): LeverState => ({ lever: f.get('lever', literal('concurrency')), cpu: f.get('cpu', positive), set: f.get('set', bool), hostCpus: f.get('hostCpus', positive) })),
  'resource-pool': object((f): LeverState => ({ lever: f.get('lever', literal('resource-pool')), resource: f.get('resource', resourceR), size: f.get('size', positive) })),
  'suite-lane': object((f): LeverState => ({
    lever: f.get('lever', literal('suite-lane')), lane: f.get('lane', laneR), argv: f.get('argv', arrayOf(str, { nonEmpty: true })), cpu: f.get('cpu', nullable(positive)),
  })),
  sequence: object((f): LeverState => ({ lever: f.get('lever', literal('sequence')), unit: f.get('unit', unitR), priority: f.get('priority', oneOf(UNIT_PRIORITIES)) })),
  'build-class': object((f): LeverState => ({
    lever: f.get('lever', literal('build-class')), tier: f.get('tier', riskTier), class: f.get('class', modelClass), builtin: f.get('builtin', modelClass),
  })),
});

/** A given in force: a host given (enforced while its fingerprint matches the host, else `stale`) or a repo given (always enforced). */
export type GivenInForce =
  | Readonly<{ scope: 'host'; id: GivenId; lever: FlowLever; note: string; state: 'enforced' | 'stale' }>
  | Readonly<{ scope: 'repo'; lever: FlowLever; note: string }>;
const givenInForce: Read<GivenInForce> = tagged('scope', {
  host: object((f): GivenInForce => ({
    scope: f.get('scope', literal('host')), id: f.get('id', (v, p) => givenId(v, p)), lever: f.get('lever', oneOf(FLOW_LEVERS)), note: f.get('note', str),
    state: f.get('state', oneOf(['enforced', 'stale'] as const)),
  })),
  repo: object((f): GivenInForce => ({ scope: f.get('scope', literal('repo')), lever: f.get('lever', oneOf(FLOW_LEVERS)), note: f.get('note', str) })),
});

/**
 * A verdict's metric (G7), derived by code from the lever: lead, one suite lane's per-run service, the wait in front of a
 * station, or (rev 3, RC-12: any lever at `host:cpu`) the pressure of the units admitted after.
 */
export type FlowMetric =
  | Readonly<{ type: 'lead' }> | Readonly<{ type: 'suite-run'; lane: LaneId }> | Readonly<{ type: 'wait'; station: StationId }> | Readonly<{ type: 'pressure' }>;
export const flowMetric: Read<FlowMetric> = tagged('type', {
  lead: object((f): FlowMetric => ({ type: f.get('type', literal('lead')) })),
  pressure: object((f): FlowMetric => ({ type: f.get('type', literal('pressure')) })),
  'suite-run': object((f): FlowMetric => ({ type: f.get('type', literal('suite-run')), lane: f.get('lane', laneR) })),
  wait: object((f): FlowMetric => ({ type: f.get('type', literal('wait')), station: f.get('station', stationR) })),
});

/** The one open verdict window arc-wide: opened when the revision came into force; `samples` taken so far. */
export type FlowWindow = Readonly<{ proposal: ProposalId; lever: FlowLever; target: StationId; metric: FlowMetric; openedAt: IsoTime; samples: number }>;
const flowWindow: Read<FlowWindow> = object((f) => ({
  proposal: f.get('proposal', proposalR), lever: f.get('lever', oneOf(FLOW_LEVERS)), target: f.get('target', stationR), metric: f.get('metric', flowMetric),
  openedAt: f.get('openedAt', timeR), samples: f.get('samples', nat),
}));

export const FLOW_VERDICTS = ['improved', 'worse', 'no-effect', 'inconclusive'] as const;
export type FlowVerdictKind = (typeof FLOW_VERDICTS)[number];
/** A closed verdict as a run reads it. */
export type ClosedVerdict = Readonly<{ proposal: ProposalId; lever: FlowLever; target: StationId; verdict: FlowVerdictKind }>;
const closedVerdict: Read<ClosedVerdict> = object((f) => ({
  proposal: f.get('proposal', proposalR), lever: f.get('lever', oneOf(FLOW_LEVERS)), target: f.get('target', stationR), verdict: f.get('verdict', oneOf(FLOW_VERDICTS)),
}));

/** Why a key is remembered: the root rejected the proposal, its verdict was `worse`, or its proof `changed` or `unprovable`. */
export const REJECTION_CAUSES = ['rejected', 'worse', 'changed', 'unprovable'] as const;
export type RejectionCause = (typeof REJECTION_CAUSES)[number];
export type Rejection = Readonly<{ key: RejectionKey; proposal: ProposalId; cause: RejectionCause }>;
const rejection: Read<Rejection> = object((f) => ({ key: f.get('key', rejectionKey), proposal: f.get('proposal', proposalR), cause: f.get('cause', oneOf(REJECTION_CAUSES)) }));

/**
 * `status.flow.pressure` (rev 3): the saturation threshold of cpu wait (src/host/pressure.ts) and whether this host
 * reports schedstat. No live reading: status is derived from the log (the window's pressure is on the constraint).
 */
export type FlowPressureStatus = Readonly<{ threshold: number; available: boolean }>;

/**
 * A run's pressure reading (rev 3), what lets the role tell the arc's own load from an outside tenant's: the threshold
 * and availability (`FlowPressureStatus`); `now` the host's cpu wait over the last minute of the scheduler's ticks
 * (src/host/pressure.ts `hostPressure`; null without schedstat or under a minute of ticks); `window` the mean pressure
 * over the constraint's window (src/flow/constraint.ts `windowPressure`, null when none of its points measured one);
 * `cpuInUse` the arc's own `@cpu` tokens reserved or running now, `hostCpus` the host fingerprint's cpus.
 */
export type FlowInputsPressure = FlowPressureStatus & Readonly<{ now: number | null; window: number | null; cpuInUse: number; hostCpus: number }>;
const flowInputsPressure: Read<FlowInputsPressure> = object((f) => {
  const out = {
    threshold: f.get('threshold', fraction), available: f.get('available', bool), now: f.get('now', nullable(fraction)), window: f.get('window', nullable(fraction)),
    cpuInUse: f.get('cpuInUse', nat), hostCpus: f.get('hostCpus', positive),
  };
  if (!out.available && out.now !== null) throw new SchemaError(`${f.path}.now`, 'null on a host without schedstat', out.now);
  return out;
});

export const FLOW_INPUTS_SCHEMA = 'roadmap/flow-inputs-m4b';

/**
 * What a flow run binds, kept before its call; recovery and a resumed call read only these bytes. `chart` is null before
 * the limits are seeded; `constraint` null before the first point; `advances` the arc's `holistic.advances` clause texts
 * (empty on a non-holistic arc); `pressure` (rev 3) the host's cpu pressure and the arc's own cpu load.
 */
export type FlowInputs = Readonly<{
  schema: typeof FLOW_INPUTS_SCHEMA;
  job: JobId;
  triggers: readonly FlowTrigger[];
  chart: FlowChart | null;
  stations: readonly StationRow[];
  constraint: CodeConstraint | null;
  accounting: FlowAccounting;
  levers: readonly LeverState[];
  givens: readonly GivenInForce[];
  window: FlowWindow | null;
  verdicts: readonly ClosedVerdict[];
  rejections: readonly Rejection[];
  advances: readonly Readonly<{ id: VisionClauseId; text: string }>[];
  pressure: FlowInputsPressure;
}>;
export const flowInputs: Read<FlowInputs> = object((f) => ({
  schema: f.get('schema', literal(FLOW_INPUTS_SCHEMA)),
  job: f.get('job', flowJobR),
  triggers: f.get('triggers', flowTriggers),
  chart: f.get('chart', nullable(flowChart)),
  stations: f.get('stations', arrayOf(stationRow)),
  constraint: f.get('constraint', nullable(codeConstraint)),
  accounting: f.get('accounting', flowAccounting),
  levers: f.get('levers', arrayOf(leverState)),
  givens: f.get('givens', arrayOf(givenInForce)),
  window: f.get('window', nullable(flowWindow)),
  verdicts: f.get('verdicts', arrayOf(closedVerdict)),
  rejections: f.get('rejections', arrayOf(rejection)),
  advances: f.get('advances', idsAscending(object((g) => ({ id: g.get('id', (v, p) => visionClauseId(v, p)), text: g.get('text', str) })), (a) => a.id)),
  pressure: f.get('pressure', flowInputsPressure),
}));
export function parseFlowInputs(value: unknown): FlowInputs {
  return flowInputs(value, 'flowInputs');
}
/** What the flow prompt renders: the kept inputs without their envelope. */
export type FlowPromptInputs = Omit<FlowInputs, 'schema' | 'job'>;

// ---------------------------------------------------------------------------------------------------
// A flow run's outcome (`flow-ended`)

export const FLOW_OUTCOMES = ['done', 'invalid', 'failed'] as const;
export type FlowOutcome = (typeof FLOW_OUTCOMES)[number];
/**
 * Code's checks after the schema (src/flow/levers.ts): each drops the proposal with its reason. `direction` (rev 3): an
 * increase at `host:cpu` (only decreases or `host` advice subordinate to a saturated cpu).
 */
export const FLOW_DROP_REASONS = [
  'target', 'given', 'rejected-before', 'verdict-open', 'direction', 'argv-shape', 'lane-cpu', 'concurrency-cpus', 'sequence-repair-waiting',
  'sequence-high-set', 'build-class-step',
] as const;
export type FlowDropReason = (typeof FLOW_DROP_REASONS)[number];
/**
 * A recorded drop's reason: the checks' reasons, and `elevate-early`, which a 1.0.0-dev.11 executor wrote before dev.12
 * dropped the step-order check (read as recorded, never written; scaffolding, BACKLOG "Scaffolding to delete").
 */
export const RECORDED_DROP_REASONS = [...FLOW_DROP_REASONS, 'elevate-early'] as const;
export type RecordedDropReason = (typeof RECORDED_DROP_REASONS)[number];
export type FlowDropped = Readonly<{ proposal: FlowProposal; reason: RecordedDropReason; detail: string }>;
export const flowDropped: Read<FlowDropped> = object((f) => ({ proposal: f.get('proposal', flowProposal), reason: f.get('reason', oneOf(RECORDED_DROP_REASONS)), detail: f.get('detail', str) }));
/** The constraint a run ended with: code's (null before the first point) and the role's (null unless `done`). */
export type FlowEndedConstraint = Readonly<{ code: CodeConstraint | null; judged: JudgedConstraint | null }>;
export const flowEndedConstraint: Read<FlowEndedConstraint> = object((f) => ({ code: f.get('code', nullable(codeConstraint)), judged: f.get('judged', nullable(judgedConstraint)) }));


// ---------------------------------------------------------------------------------------------------
// The flow role's output (strict schema in src/prompts/schemas.ts): exactly one of `proposal` and `noAction`

/** A proposal as the model writes it: no id (code assigns `<job>.0`). */
export type ProposalOutput = Omit<FlowProposal, 'id'>;
export type FlowOutput = Readonly<{ constraint: JudgedConstraint; diagnosis: string; proposal: ProposalOutput | null; noAction: string | null }>;

/** The model's action: every key present (strict mode), a suite lane's unused `argv`, `reporter` or `cpu` null. */
const actionOutput: Read<FlowAction> = tagged('lever', {
  concurrency: object((f): FlowAction => ({ lever: f.get('lever', literal('concurrency')), cpu: f.get('cpu', positive) })),
  'resource-pool': object((f): FlowAction => ({ lever: f.get('lever', literal('resource-pool')), resource: f.get('resource', resourceR), size: f.get('size', positive) })),
  'suite-lane': object((f): FlowAction => {
    f.get('lever', literal('suite-lane'));
    return suiteLaneAction(
      f.get('lane', laneR), f.get('argv', nullable(arrayOf(str, { nonEmpty: true }))) ?? undefined, f.get('reporter', nullable(oneOf(FLOW_REPORTERS))) ?? undefined,
      f.get('cpu', nullable(positive)) ?? undefined, f.path,
    );
  }),
  sequence: object((f): FlowAction => ({ lever: f.get('lever', literal('sequence')), unit: f.get('unit', unitR), priority: f.get('priority', literal('high')) })),
  'build-class': object((f): FlowAction => ({ lever: f.get('lever', literal('build-class')), tier: f.get('tier', riskTier), class: f.get('class', modelClass) })),
  host: object((f): FlowAction => ({ lever: f.get('lever', literal('host')), note: f.get('note', str) })),
});

export const flowOutput: Read<FlowOutput> = object((f) => {
  const out = {
    constraint: f.get('constraint', judgedConstraint),
    diagnosis: f.get('diagnosis', str),
    proposal: f.get('proposal', nullable(object((g): ProposalOutput => ({
      target: g.get('target', stationR), action: g.get('action', actionOutput), rationale: g.get('rationale', str), risks: g.get('risks', str),
    })))),
    noAction: f.get('noAction', nullable(str)),
  };
  if ((out.proposal === null) === (out.noAction === null)) throw new SchemaError(`${f.path}.noAction`, out.proposal === null ? 'why no action, when there is no proposal' : 'null beside a proposal', out.noAction);
  return out;
});

// ---------------------------------------------------------------------------------------------------
// Proofs (`flow-proof`, src/flow/proof.ts) and verdicts (`flow-verdict`, src/flow/verdict.ts)

/** `preserved`: equal `(testId, selected, outcome)` multisets, the old one non-empty with ≥ 1 pass; `red`: a run failed (rerun once). */
export const PROOF_OUTCOMES = ['preserved', 'changed', 'unprovable', 'red'] as const;
export type ProofOutcome = (typeof PROOF_OUTCOMES)[number];
export type ProofMinutes = Readonly<{ old: number; new: number }>;
export const proofMinutes: Read<ProofMinutes> = object((f) => ({ old: f.get('old', amount), new: f.get('new', amount) }));

/** Paired guard metrics (never folded into T, G8): a breach makes the verdict `worse`. */
export const FLOW_GUARDS = ['lead', 'rework', 'first-run-reds', 'obligation', 'cost'] as const;
export type FlowGuard = (typeof FLOW_GUARDS)[number];
export type GuardBreach = Readonly<{ guard: FlowGuard; detail: string }>;
export const guardBreaches: Read<readonly GuardBreach[]> = sortedBy(
  object((f) => ({ guard: f.get('guard', oneOf(FLOW_GUARDS)), detail: f.get('detail', str) })), (g) => String(FLOW_GUARDS.indexOf(g.guard)).padStart(2, '0'),
  { order: 'in FLOW_GUARDS order, each once' },
);
/** The before-window: its last samples (raw minutes, possibly none), the XmR centre and mR̄ (on log for lead; 0 when empty). */
export type VerdictBefore = Readonly<{ samples: readonly number[]; centre: number; mrBar: number }>;
export const verdictBefore: Read<VerdictBefore> = object((f) => ({ samples: f.get('samples', arrayOf(amount)), centre: f.get('centre', finite), mrBar: f.get('mrBar', amount) }));
/** A verdict window's samples (raw minutes), taken from units admitted after the change or suite runs after it. */
export type VerdictAfter = Readonly<{ samples: readonly number[] }>;
export const verdictAfter: Read<VerdictAfter> = object((f) => ({ samples: f.get('samples', arrayOf(amount)) }));
/** Fewer after-samples, or before-samples, than this is `inconclusive`. */
export const MIN_VERDICT_SAMPLES = 3;

// ---------------------------------------------------------------------------------------------------
// Givens (src/flow/givens.ts): host scope `$(git rev-parse --git-common-dir)/roadmap/givens.json`, repo scope
// `.roadmap/config.json` `flow.givens`

export const HOST_GIVENS_SCHEMA = 'roadmap/flow-givens-m4b';
/** A host given, write-once: what cannot be tuned on this host, enforced only while `fingerprint` matches it. */
export type HostGiven = Readonly<{ id: GivenId; lever: FlowLever; note: string; fingerprint: HostFingerprint; at: IsoTime }>;
export type HostGivens = Readonly<{ schema: typeof HOST_GIVENS_SCHEMA; givens: readonly HostGiven[] }>;
export const hostGivens: Read<HostGivens> = object((f) => ({
  schema: f.get('schema', literal(HOST_GIVENS_SCHEMA)),
  givens: f.get('givens', idsAscending(object((g): HostGiven => ({
    id: g.get('id', (v, p) => givenId(v, p)), lever: g.get('lever', oneOf(FLOW_LEVERS)), note: g.get('note', str), fingerprint: g.get('fingerprint', hostFingerprint),
    at: g.get('at', timeR),
  })), (g) => g.id)),
}));
export function parseHostGivens(value: unknown): HostGivens {
  return hostGivens(value, 'givens');
}
/** A repo given, committed by the owner in `.roadmap/config.json` `flow.givens`. */
export type RepoGiven = Readonly<{ lever: FlowLever; note: string }>;
export const repoGiven: Read<RepoGiven> = object((f) => ({ lever: f.get('lever', oneOf(FLOW_LEVERS)), note: f.get('note', str) }));
