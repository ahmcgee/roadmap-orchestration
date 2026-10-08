// Levers, proposals and the ruler fence (plan "Levers, proposals and the fence", G7, RC-3, RC-4, RC-8, RC-9). The tables
// here are frozen in step 0a (SCHEMAS.md "M4b"). A path is the plan.json field it names: dotted keys, `[<key>]` for an
// entry of a keyed list (a resource by name, a lane or unit by id), `<tier>` a build tier. One elision: a pooled
// resource's `pool.size` reads `resources[<name>].size` (its pool is its size), so a resource gaining or losing a pool
// still diffs under `resources[<name>].pool`, outside every lever.
//
// Pure. `flowRevision` builds the next plan from an action alone and asserts the fence; `checkProposal` is code's check
// after the schema, the first failing rule dropping the proposal with its closed reason; `rulerChanges` names the ruler
// paths a revision touched (B1 raises `ruler-changed` from it for a `command` revision after the first admission).
import {
  type Sha256Hex, type StationId, type UnitId, SLOT_COMPONENTS, SLOT_STATION, SLOT_WAIT_STATION, parseStationId, stationId,
} from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type PlanM1, visionFile } from '../input/plan.ts';
import { laneCpu } from '../resources/pool.ts';
import { BUILTIN_SEATS } from '../routing/profiles.ts';
import { MODEL_CLASSES, ROLES, type RiskTier } from '../routing/types.ts';
import {
  type ClosedVerdict, type CodeConstraint, type FlowAction, type FlowDropReason, type FlowDropped, type FlowLever, type FlowMetric, type FlowPreimage,
  type FlowProposal, type FlowWindow, type GivenInForce, type HostFingerprint, type JudgedConstraint, type LeverState, type Rejection, type RejectionKey,
  type TocStep, leverTargetOf,
} from './types.ts';

/** What an applied action may change (the fence: `diffPaths(plan, flowRevision(plan, action)) ⊆ LEVER_PATHS[lever]`, else a bug). */
export const LEVER_PATHS: { readonly [L in FlowLever]: readonly string[] } = {
  concurrency: ['capacity.cpu'],
  'resource-pool': ['resources[<name>].size'],
  'suite-lane': ['suite.lanes[<id>].argv', 'suite.lanes[<id>].cpu'],
  sequence: ['units[<id>].priority'],
  'build-class': ['routing.build.<tier>'],
  host: [],
};

/**
 * The ruler (Goodhart, code-consulted): what the optimizer never touches. A revision after the first admission whose
 * source is `command` (the root agent's `apply`) and that touches one raises a non-blocking `ruler-changed` item.
 * Bundles (checkpoint authority) and the owner's vision applies are not flagged.
 */
export const RULER_PATHS: readonly Readonly<{ path: string; what: string }>[] = [
  { path: 'holistic.obligations', what: 'the obligations file: obligations, their witness lanes, the arc lanes, the census and the impact mapping' },
  { path: 'holistic.audit', what: 'the audit cadence and lens set' },
  { path: 'holistic.advances', what: 'the vision clauses the arc advances' },
  { path: 'vision', what: 'the vision record' },
  { path: 'routing.<judgment role>', what: 'judgment-seat routing in the plan layer: planCheck, gate, lens, checkpoint, packReview, flow' },
  { path: 'units[<id>].routing.<judgment role>', what: 'judgment-seat routing in a unit layer' },
  { path: 'units[<id>].risk', what: 'risk floors' },
];

/** The focusing step each lever serves (G7). */
export const LEVER_STEP: { readonly [L in FlowLever]: TocStep } = {
  'suite-lane': 'exploit', 'build-class': 'exploit', sequence: 'subordinate', concurrency: 'elevate', 'resource-pool': 'elevate', host: 'elevate',
};

/** The one flag a suite-lane argv edit may change in place (RC-4, OI-2): its value only; selectors and every other element never change. */
export const ARGV_FLAGS = ['--test-concurrency'] as const;

// ---------------------------------------------------------------------------------------------------
// Metric and step (G7): code's, never the model's

/** The wait in front of a station: `wait:<s>` before a stage, the slot's wait before the slot or any of its components. */
export function waitInFrontOf(target: StationId): StationId {
  const parts = parseStationId(target);
  switch (parts.type) {
    case 'stage': return stationId(`wait:${parts.stage}`);
    case 'wait': case 'slot-wait': return target;
    case 'slot': case 'suite': case 'component': return stationId(SLOT_WAIT_STATION);
    case 'held': case 'finding-wait': throw new Error(`waitInFrontOf: ${target} is never a target`);
  }
}

/** The verdict metric of an action (G7): a suite lane's per-run service, the wait in front of `target`, or lead; null for `host`. */
export function metricOf(action: FlowAction, target: StationId): FlowMetric | null {
  switch (action.lever) {
    case 'suite-lane': return { type: 'suite-run', lane: action.lane };
    case 'concurrency': case 'resource-pool': return { type: 'wait', station: waitInFrontOf(target) };
    case 'sequence': case 'build-class': return { type: 'lead' };
    case 'host': return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// The fence

/** What `action` would replace in `plan`. `host` is never applied; a pool lever on an unpooled resource is a bug (`checkProposal` drops it). */
export function preimageOf(plan: PlanM1, action: FlowAction): FlowPreimage {
  switch (action.lever) {
    case 'concurrency': return { lever: 'concurrency', cpu: plan.capacity?.cpu ?? null };
    case 'resource-pool': return { lever: 'resource-pool', resource: action.resource, size: poolOf(plan, action.resource) };
    case 'suite-lane': {
      const lane = suiteLaneOf(plan, action.lane);
      return { lever: 'suite-lane', lane: action.lane, argv: lane.argv, cpu: lane.cpu ?? null };
    }
    case 'sequence': return { lever: 'sequence', unit: action.unit, priority: unitOf(plan, action.unit).priority ?? null };
    case 'build-class': return { lever: 'build-class', tier: action.tier, class: plan.routing?.build?.[action.tier] ?? null };
    case 'host': throw new Error('preimageOf: a host action is advice, never applied');
  }
}

/** The next plan, built from the action only; throws when its diff leaves `LEVER_PATHS[lever]`. */
export function flowRevision(plan: PlanM1, action: FlowAction): PlanM1 {
  const next = applyAction(plan, action);
  assertFenced(plan, next, action);
  return next;
}

function applyAction(plan: PlanM1, action: FlowAction): PlanM1 {
  switch (action.lever) {
    case 'concurrency': return { ...plan, capacity: { ...plan.capacity, cpu: action.cpu } };
    case 'resource-pool':
      poolOf(plan, action.resource);
      return { ...plan, resources: plan.resources.map((r) => (r.name === action.resource ? { ...r, pool: { size: action.size } } : r)) };
    case 'suite-lane':
      suiteLaneOf(plan, action.lane);
      return {
        ...plan,
        suite: {
          ...plan.suite,
          lanes: plan.suite.lanes.map((l) => (l.id !== action.lane ? l : {
            ...l, ...(action.argv === undefined ? {} : { argv: action.argv }), ...(action.cpu === undefined ? {} : { cpu: action.cpu }),
          })),
        },
      };
    case 'sequence':
      unitOf(plan, action.unit);
      return { ...plan, units: plan.units.map((u) => (u.id === action.unit ? { ...u, priority: action.priority } : u)) };
    case 'build-class': return { ...plan, routing: { ...plan.routing, build: { ...plan.routing?.build, [action.tier]: action.class } } };
    case 'host': throw new Error('flowRevision: a host action is advice, never applied');
  }
}

/** The lever paths `action` may touch, instantiated with the lane, resource, unit or tier it names. */
function allowedPaths(action: FlowAction): readonly string[] {
  const key = action.lever === 'resource-pool' ? action.resource : action.lever === 'suite-lane' ? action.lane : action.lever === 'sequence' ? action.unit
    : action.lever === 'build-class' ? action.tier : null;
  return LEVER_PATHS[action.lever].map((p) => (key === null ? p : p.replace(/<name>|<id>|<tier>/, key)));
}

/** The fence: every path `next` differs from `plan` at is one `action`'s lever may change; anything else is a bug and throws. */
export function assertFenced(plan: PlanM1, next: PlanM1, action: FlowAction): void {
  const allowed = new Set(allowedPaths(action));
  const outside = diffPaths(plan, next).filter((p) => !allowed.has(p));
  if (outside.length > 0) throw new Error(`flow fence: a ${action.lever} revision touched ${outside.join(', ')} (allowed: ${[...allowed].join(', ') || 'nothing'})`);
}

/** Keyed lists: an entry is named by its key, so a reorder or an edit names the entry, never an index. */
const KEYED: Readonly<Record<string, string>> = { 'suite.lanes': 'id', resources: 'name', units: 'id' };

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b));

/** The plan paths two plans differ at, in the notation above, ascending. */
export function diffPaths(a: PlanM1, b: PlanM1): readonly string[] {
  const out: string[] = [];
  walk(a, b, '', out);
  return [...new Set(out)].sort();
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (same(a, b)) return;
  const join = (key: string): string => (path === '' ? key : `${path}.${key}`);
  if ((isRecord(a) || a === undefined) && (isRecord(b) || b === undefined)) {
    const x = a ?? {};
    const y = b ?? {};
    const pooled = /^resources\[[^\]]+\]$/.test(path) && isRecord(x['pool']) && isRecord(y['pool']);
    for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])]) {
      if (key === 'pool' && pooled) walk(x[key], y[key], path, out);
      else walk(x[key], y[key], join(key), out);
    }
    return;
  }
  const keyField = KEYED[path];
  if (keyField !== undefined && Array.isArray(a) && Array.isArray(b)) {
    const keyOf = (e: unknown): string => String((e as Record<string, unknown>)[keyField]);
    const xs = new Map(a.map((e) => [keyOf(e), e]));
    const ys = new Map(b.map((e) => [keyOf(e), e]));
    const common = (list: readonly unknown[], other: ReadonlyMap<string, unknown>): string[] => list.map(keyOf).filter((k) => other.has(k));
    if (common(a, ys).join('\0') !== common(b, xs).join('\0')) out.push(path);
    for (const k of new Set([...xs.keys(), ...ys.keys()])) {
      if (!xs.has(k) || !ys.has(k)) out.push(`${path}[${k}]`);
      else walk(xs.get(k), ys.get(k), `${path}[${k}]`, out);
    }
    return;
  }
  out.push(path);
}

// ---------------------------------------------------------------------------------------------------
// The ruler

/** What a revision's ruler is read from: its plan and the obligations and vision bytes in force (`plan-applied`'s hashes). */
export type RulerView = Readonly<{ plan: PlanM1; obligationsSha256: Sha256Hex | null; visionSha256: Sha256Hex | null }>;

/** The judgment seats' roles: every role but the implementer. */
const JUDGMENT_ROLES = ROLES.filter((r) => r !== 'build');

/**
 * The ruler paths (`RULER_PATHS`, instantiated) `next` changed against `prev`, ascending; empty when it touched none.
 * Obligations and vision count by their path in the plan or their bytes. A unit's risk and judgment routing count only on
 * a unit both revisions carry (a new unit sets a floor, it does not move one).
 */
export function rulerChanges(prev: RulerView, next: RulerView): readonly string[] {
  const out = new Set<string>();
  const ruler = [
    'holistic.obligations', 'holistic.audit', 'holistic.advances', ...JUDGMENT_ROLES.map((r) => `routing.${r}`),
  ];
  const unitRuler = [...JUDGMENT_ROLES.map((r) => `routing.${r}`), 'risk'];
  for (const p of diffPaths(prev.plan, next.plan)) {
    const hit = ruler.find((r) => p === r || p.startsWith(`${r}.`));
    if (hit !== undefined) out.add(hit);
    if (p === 'holistic.vision' || p.startsWith('holistic.vision.')) out.add('vision');
    const m = /^units\[([^\]]+)\]\.(.+)$/.exec(p);
    if (m !== null) {
      const field = unitRuler.find((r) => m[2] === r || (m[2] as string).startsWith(`${r}.`));
      if (field !== undefined) out.add(`units[${m[1]}].${field}`);
    }
  }
  if (prev.obligationsSha256 !== next.obligationsSha256) out.add('holistic.obligations');
  if (prev.visionSha256 !== next.visionSha256 || !same(visionFile(prev.plan), visionFile(next.plan))) out.add('vision');
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------------
// Rejection identity (RC-9)

/** A proposal's rejection key: `(station, lever, target)`, never the value. A `worse` verdict and a reject add it. */
export function rejectionKeyOf(proposal: Pick<FlowProposal, 'target' | 'action'>): RejectionKey {
  return { station: proposal.target, lever: proposal.action.lever, target: leverTargetOf(proposal.action) };
}

/** The key as one comparable string. */
export function rejectionKeyText(key: RejectionKey): string {
  const t = key.target;
  const target = t.type === 'lane' ? `lane:${t.lane}` : t.type === 'resource' ? `resource:${t.resource}` : t.type === 'tier' ? `tier:${t.tier}`
    : t.type === 'unit' ? `unit:${t.unit}` : t.type;
  return `${key.station}|${key.lever}|${target}`;
}

// ---------------------------------------------------------------------------------------------------
// Code's checks after the schema

/**
 * What the checks read (B1 assembles it from the run's inputs and the log): the plan in force; this host's fingerprint;
 * code's constraint and the role's reading; the lever catalogue (a build tier's class in force and built-in floor); the
 * givens in force; the open window (or an accepted proposal not yet closed, which B1 counts as one); this arc's closed
 * verdicts; the rejection memory; whether a repair unit is ready or waiting; the units a flow `sequence` set `high` that
 * have not merged.
 */
export type ProposalContext = Readonly<{
  plan: PlanM1;
  host: HostFingerprint;
  constraint: CodeConstraint | null;
  judged: JudgedConstraint;
  levers: readonly LeverState[];
  givens: readonly GivenInForce[];
  window: FlowWindow | null;
  verdicts: readonly ClosedVerdict[];
  rejections: readonly Rejection[];
  repairWaiting: boolean;
  flowHigh: readonly UnitId[];
}>;

/** Code's checks after the schema, in `FLOW_DROP_REASONS` order: the first that drops the proposal, or null. */
export function checkProposal(proposal: FlowProposal, context: ProposalContext): FlowDropped | null {
  const drop = (reason: FlowDropReason, detail: string): FlowDropped => ({ proposal, reason, detail });
  const { action } = proposal;

  const target = targetProblem(proposal, context);
  if (target !== null) return drop('target', target);

  const given = context.givens.find((g) => g.lever === action.lever && (g.scope === 'repo' || g.state === 'enforced'));
  if (given !== undefined) return drop('given', `${given.scope === 'host' ? `host given ${given.id}` : 'repo given'} on ${given.lever}: ${given.note}`);

  const key = rejectionKeyText(rejectionKeyOf(proposal));
  const before = context.rejections.find((r) => rejectionKeyText(r.key) === key);
  if (before !== undefined) return drop('rejected-before', `${key} was remembered from ${before.proposal} (${before.cause})`);

  if (context.window !== null && action.lever !== 'host') return drop('verdict-open', `the window of ${context.window.proposal} is open; only host advice meanwhile`);

  if (LEVER_STEP[action.lever] === 'elevate' && action.lever !== 'host') {
    const earlier = context.verdicts.some((v) => v.target === proposal.target && LEVER_STEP[v.lever] !== 'elevate');
    if (!earlier) return drop('elevate-early', `no exploit or subordinate verdict closed on ${proposal.target} this arc`);
  }

  switch (action.lever) {
    case 'suite-lane': {
      const lane = suiteLaneOf(context.plan, action.lane);
      if (action.argv !== undefined) {
        const shape = argvShapeProblem(lane.argv, action.argv);
        if (shape !== null) return drop('argv-shape', shape);
        if (action.reporter === undefined) return drop('argv-shape', 'an argv change names no reporter to prove it with');
      }
      const concurrency = parsedConcurrency(action.argv ?? lane.argv);
      const cpu = action.cpu ?? laneCpu(lane);
      if (concurrency !== null && cpu < concurrency) return drop('lane-cpu', `the lane takes ${cpu} @cpu under --test-concurrency=${concurrency}`);
      return null;
    }
    case 'concurrency':
      return action.cpu > context.host.cpus ? drop('concurrency-cpus', `capacity.cpu ${action.cpu} above the host's ${context.host.cpus} cpus`) : null;
    case 'sequence':
      if (context.repairWaiting) return drop('sequence-repair-waiting', 'a repair unit is ready or waiting');
      if (context.flowHigh.length > 0) return drop('sequence-high-set', `${context.flowHigh.join(', ')} already set high by flow`);
      return null;
    case 'build-class': {
      const state = context.levers.find((l): l is Extract<LeverState, { lever: 'build-class' }> => l.lever === 'build-class' && l.tier === action.tier);
      if (state === undefined) throw new Error(`checkProposal: the lever catalogue has no build-class row for tier ${action.tier}`);
      const step = MODEL_CLASSES.indexOf(action.class) - MODEL_CLASSES.indexOf(state.class);
      if (Math.abs(step) !== 1) return drop('build-class-step', `${state.class} → ${action.class} is not one class step`);
      if (MODEL_CLASSES.indexOf(action.class) < MODEL_CLASSES.indexOf(builtinBuildClass(action.tier))) {
        return drop('build-class-step', `${action.class} is below the built-in ${builtinBuildClass(action.tier)} for build.${action.tier}`);
      }
      return null;
    }
    case 'resource-pool': case 'host': return null;
  }
}

/** The built-in class of a build tier: the floor of the build-class lever (RC-8). */
export const builtinBuildClass = (tier: RiskTier) => BUILTIN_SEATS.build[tier];

/**
 * The target rule (G7): the station is code's constraint, one of its components, or the role's disputed station (or one
 * of its components), never `held` or `wait:finding` (diagnostic: the finding's repair moves it, no lever does); a suite-lane action targets its lane's station or the slot; the action names what the plan has
 * (a suite lane, a pooled resource, a unit not cut) and changes something.
 */
function targetProblem(proposal: FlowProposal, context: ProposalContext): string | null {
  const { target, action } = proposal;
  if (parseStationId(target).type === 'held') return 'held time is never a target';
  if (parseStationId(target).type === 'finding-wait') return 'wait:finding is diagnostic (an open P1 holds the candidate); no lever targets it';
  const allowed = new Set<string>();
  const admit = (s: StationId): void => {
    allowed.add(s);
    if (s === SLOT_STATION) for (const c of slotComponents(context.plan)) allowed.add(c);
  };
  if (context.constraint !== null) admit(context.constraint.station);
  if (!context.judged.agree) admit(context.judged.station);
  if (!allowed.has(target)) return `${target} is neither the constraint${context.constraint === null ? '' : ` ${context.constraint.station}`}, a component of it, nor the disputed station`;

  const plan = context.plan;
  switch (action.lever) {
    case 'suite-lane':
      if (!plan.suite.lanes.some((l) => l.id === action.lane)) return `no suite lane ${action.lane}`;
      if (target !== `suite:${action.lane}` && target !== SLOT_STATION) return `a suite-lane action on ${action.lane} targets suite:${action.lane} or the slot`;
      break;
    case 'resource-pool':
      if (plan.resources.find((r) => r.name === action.resource)?.pool === undefined) return `no pooled resource ${action.resource}`;
      break;
    case 'sequence': {
      const unit = plan.units.find((u) => u.id === action.unit);
      if (unit === undefined || unit.cut !== undefined) return `no live unit ${action.unit}`;
      break;
    }
    case 'concurrency': case 'build-class': case 'host': break;
  }
  if (action.lever !== 'host' && diffPaths(plan, flowRevision(plan, action)).length === 0) return 'the action changes nothing';
  return null;
}

/** The slot's component stations: one per suite lane, then the fixed components. */
function slotComponents(plan: PlanM1): readonly StationId[] {
  return [...plan.suite.lanes.map((l) => stationId(`suite:${l.id}`)), ...SLOT_COMPONENTS.map((c) => stationId(c))];
}

const CONCURRENCY = /^--test-concurrency=([1-9][0-9]*)$/;

/** The `--test-concurrency=<n>` an argv carries, or null. */
export function parsedConcurrency(argv: readonly string[]): number | null {
  for (const a of argv) {
    const m = CONCURRENCY.exec(a);
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/**
 * RC-4's argv shape: the new argv equals the old element for element, except one `--test-concurrency=<n>` whose value
 * changed in place. A selector change, an appended or extra flag, a reorder or a removal is refused; so is no change.
 */
export function argvShapeProblem(old: readonly string[], next: readonly string[]): string | null {
  if (next.length !== old.length) return `argv length ${next.length} differs from ${old.length} (an added or removed element)`;
  const changed = old.flatMap((o, i) => (o === next[i] ? [] : [i]));
  if (changed.length === 0) return 'the argv is unchanged';
  if (changed.length > 1) return `elements ${changed.join(', ')} changed; only one allowlisted flag's value may`;
  const i = changed[0] as number;
  if (!CONCURRENCY.test(old[i] as string) || !CONCURRENCY.test(next[i] as string)) {
    return `element ${i} ${JSON.stringify(old[i])} → ${JSON.stringify(next[i])} is not an in-place ${ARGV_FLAGS.join(' | ')}=<n> edit`;
  }
  return null;
}

function suiteLaneOf(plan: PlanM1, lane: string) {
  const def = plan.suite.lanes.find((l) => l.id === lane);
  if (def === undefined) throw new Error(`flow lever: no suite lane ${lane}`);
  return def;
}

function unitOf(plan: PlanM1, unit: string) {
  const def = plan.units.find((u) => u.id === unit);
  if (def === undefined) throw new Error(`flow lever: no unit ${unit}`);
  return def;
}

function poolOf(plan: PlanM1, resource: string): number {
  const size = plan.resources.find((r) => r.name === resource)?.pool?.size;
  if (size === undefined) throw new Error(`flow lever: no pooled resource ${resource}`);
  return size;
}
