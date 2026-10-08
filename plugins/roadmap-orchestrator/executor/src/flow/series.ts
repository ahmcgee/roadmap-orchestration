// The flow series (plan "Stations and the flow series", G3, R2, R3, R14), a pure fold over one arc's log and the plan and
// obligations bytes its revisions kept.
//
// A point per merged unit: admitted at its first `dispatch`, merged when its publication ends (the `snapshot` stage's
// outcome, which retires it: the slot's `ff` and `snapshot` components are inside the lead time). Units a repair batch
// merged are counted in T and excluded from the points. The lead time is cut into disjoint stations whose minutes sum to
// `leadMin`, walking the unit's stage outcomes in log order from its admission:
//   - each outcome closes one step: the wait from the previous outcome (or the admission) to the step's first op, then
//     the service from that op to the outcome. The first op is the earliest stage-parented intent of the unit after the
//     previous outcome whose attempt has no outcome yet (an attempt a restart cut short is service of the next one); a
//     stage with no op (quiesce, an in-session plan-check) is all wait;
//   - `wait:<s>` / `stage:<s>` for the pipeline stages (`FLOW_STAGES`); `wait:slot:integration` in front of a candidate
//     (it ends at the publication's slot reserve, the candidate's first op); the slot's service split into its components:
//     `suite:<lane>` (the suite runs on the candidate commit: a `lane{set: suite}` spawn, or an arc lane standing in for an
//     identical suite lane, F6), `arc-lanes` (journey and mutant runs), `candidate-rest` (the rest of the candidate's hold,
//     including a red suite's T-alone rerun, which is rework, never service), `ff` and `snapshot` (each whole step, wait
//     included: the slot is held through them);
//   - `held`, never a constraint: the whole wait after a hold, park or stop outcome (a blocking needs-user item about the
//     unit comes with one), and within any other pipeline or slot wait the time under a pause (all, or the unit), a stop
//     until the next executor start, or an ARC-scope drain (an applied command revision that `drainsArc`, from the
//     command's submission to its `plan-applied`). An open blocking item is no held time by itself: whether it holds a
//     unit is its record's subject and reason (src/needsuser.ts `holdsUnit`, admission), which the log does not carry.
// A spawn's run time is from its latest intent to its done (or abort), clipped to its step.
//
// Suite-lane service is sampled per run in all four shapes (`suiteRuns`): `lane` and `stand-in` on a unit's candidate,
// `batch` on a repair batch's candidate, `rerun` on the tip alone (a unit's or a batch's red path). Only runs with a
// verdict count (pass, fail, stall; a cancelled, faulted or lost run measures nothing). Docs publications run the suite
// too; the plan's four shapes leave them out.
//
// The accounting (RC-2) is diagnostic only: T per hour of the log's span (first to last event); `tAdvances` / `tOther`
// split the obligations held for the first time this arc (their `obligation-latched` facts) by whether the obligation in
// force serves a clause of the plan's `holistic.advances`; null both on a non-holistic arc. `wip` counts the active
// admitted-not-merged units and the undispatched active units whose `after` units have all merged. `oeUsdPerHour` is
// every metered call's cost.
import type { Buffer } from 'node:buffer';
import { submittedAtMs } from '../commands/queue.ts';
import type { Event, IntentOf, OutcomeClass, PlanAppliedFact } from '../core/events.ts';
import {
  type ArcId, type LaneId, type ObligationId, type OpId, type Sha, type Sha256Hex, type StationId, type UnitId, FLOW_STAGES, type FlowStage, HELD_STATION,
  SLOT_STATION, SLOT_WAIT_STATION, parseJobId, parseStationId, stationId,
} from '../core/ids.ts';
import { isRed, type Stage } from '../core/records.ts';
import { type IsoTime, isoTime } from '../core/values.ts';
import { type Obligations, parseObligations } from '../holistic/types.ts';
import { drainsArc } from '../input/classify.ts';
import { OBLIGATIONS_INPUT, PLAN_INPUT } from '../input/inforce.ts';
import { type PlanM1, advancesOf, parsePlan } from '../input/plan.ts';
import { sameExecution } from '../pipeline/lanes.ts';
import { FLOW_SERIES_V, type FlowAccounting, type FlowPoint, type FlowSeries, type HostFingerprint, type StationRow, type SuiteRun, type SuiteRunShape } from './types.ts';

/** What the series reads beyond the log: the plan and the obligations (null: none) a `plan-applied` put in force. */
export type SeriesInputs = Readonly<{
  planOf: (applied: PlanAppliedFact) => PlanM1;
  obligationsOf: (applied: PlanAppliedFact) => Obligations | null;
}>;

/** `SeriesInputs` over kept inputs (a run dir's `inputs/`, or a ref's), each file parsed once. */
export function seriesInputs(input: (sha: Sha256Hex, ext: string) => Buffer): SeriesInputs {
  const plans = new Map<Sha256Hex, PlanM1>();
  const obligations = new Map<Sha256Hex, Obligations>();
  const json = (sha: Sha256Hex, ext: string): unknown => JSON.parse(input(sha, ext).toString('utf8'));
  return {
    planOf: (a) => plans.get(a.planSha256) ?? plans.set(a.planSha256, parsePlan(json(a.planSha256, PLAN_INPUT))).get(a.planSha256)!,
    obligationsOf: (a) => {
      const sha = a.obligationsSha256;
      if (sha === undefined) return null;
      return obligations.get(sha) ?? obligations.set(sha, parseObligations(json(sha, OBLIGATIONS_INPUT))).get(sha)!;
    },
  };
}

const MS_PER_MIN = 60_000;
const ms = (at: IsoTime): number => Date.parse(at);

/** A half-open span of the clock, in ms; `end` Infinity while open. */
type Span = Readonly<{ start: number; end: number }>;

/** The time within [a, b] that `spans` cover (overlaps counted once). */
function covered(spans: readonly Span[], a: number, b: number): number {
  const clipped = spans.map((s) => ({ start: Math.max(s.start, a), end: Math.min(s.end, b) })).filter((s) => s.end > s.start).sort((x, y) => x.start - y.start);
  let total = 0;
  let reach = a;
  for (const s of clipped) {
    const from = Math.max(s.start, reach);
    if (s.end > from) {
      total += s.end - from;
      reach = s.end;
    }
  }
  return total;
}

type Outcome = Readonly<{ seq: number; at: number; stage: Exclude<Stage, 'retire'>; attempt: number; cls: OutcomeClass }>;
type StageOp = Readonly<{ seq: number; at: number; key: string }>;
type Spawn = Readonly<{
  intent: IntentOf<'proc.spawn'>;
  /** The latest intent's seq and time: the run's start. */
  seq: number;
  start: number;
  /** The done or abort time, null while open. */
  end: number | null;
  /** The run's verdict (a command's), null when it has none. */
  red: boolean | null;
}>;
/** A candidate merge's two trees: the candidate commit and the tip it merged onto (a T-alone run's tree). */
type CandidateTrees = Readonly<{ candidate: Sha; tip: Sha }>;

const attemptKey = (stage: Stage, attempt: number): string => `${stage}#${attempt}`;
const HOLDING: readonly OutcomeClass[] = ['hold', 'park', 'stop'];
const ROUNDS: readonly OutcomeClass[] = ['redirect', 'revise', 'candidate-red', 'smoke'];
const isFlowStage = (s: Stage): s is FlowStage => (FLOW_STAGES as readonly string[]).includes(s);

/** The suite lane an arc lane stands in for under the plan in force (F6, `sameExecution`), or null. */
type SuiteLanes = Readonly<{ suite: ReadonlySet<LaneId>; standIn: (arcLane: LaneId) => LaneId | null }>;

/** One pass over the log: everything the points, the runs and the accounting read. */
class LogIndex {
  readonly outcomes = new Map<UnitId, Outcome[]>();
  readonly admitted = new Map<UnitId, Readonly<{ seq: number; at: number }>>();
  readonly stageOps = new Map<UnitId, StageOp[]>();
  readonly spawns: Spawn[] = [];
  /** Candidate merges by their parent: a unit's candidate attempt (`<unit>#<attempt>`) or a batch job. */
  readonly candidates = new Map<string, CandidateTrees>();
  readonly applied: Readonly<{ seq: number; fact: PlanAppliedFact }>[] = [];
  readonly globalHeld: Span[] = [];
  readonly unitHeld = new Map<UnitId, Span[]>();
  readonly batchMerged = new Map<UnitId, number>();
  readonly gone = new Set<UnitId>();
  readonly latches: Readonly<{ seq: number; obligation: ObligationId }>[] = [];
  readonly unitCost = new Map<UnitId, number | null>();
  costUsd = 0;
  host: HostFingerprint | null = null;
  first = Number.NaN;
  last = Number.NaN;

  constructor(events: readonly Event[]) {
    const intents = new Map<OpId, Readonly<{ seq: number; at: number; intent: IntentOf<'proc.spawn'> }>>();
    const batchCandidates = new Map<string, readonly UnitId[]>();
    const batchFfs = new Map<OpId, string>();
    let pausedAllAt: number | null = null;
    const pausedUnit = new Map<UnitId, number>();
    let stopAt: number | null = null;
    const closeAll = (at: number): void => {
      for (const [u, start] of pausedUnit) this.held(u, { start, end: at });
      pausedUnit.clear();
    };
    for (const e of events) {
      const at = ms(e.at);
      if (Number.isNaN(this.first)) this.first = at;
      this.last = at;
      if (e.type === 'intent') {
        if (e.parent.type === 'stage') this.push(this.stageOps, e.parent.unit, { seq: e.seq, at, key: attemptKey(e.parent.stage, e.parent.attempt) });
        if (e.kind === 'proc.spawn') intents.set(e.op, { seq: e.seq, at, intent: e });
        if (e.kind === 'candidate.merge') {
          const trees = { candidate: e.post.new, tip: e.expect.integrationTip };
          if (e.expect.batch !== undefined) {
            this.candidates.set(e.expect.batch.job, trees);
            batchCandidates.set(e.expect.batch.job, e.expect.batch.members.map((m) => m.unit));
          } else if (e.parent.type === 'stage') {
            this.candidates.set(`${e.parent.unit}#${e.parent.attempt}`, trees);
          }
        }
        if (e.kind === 'integration.ff' && e.expect.subject?.type === 'batch') batchFfs.set(e.op, e.expect.subject.job);
        continue;
      }
      if (e.type === 'done' || e.type === 'abort') {
        const spawn = intents.get(e.op);
        if (spawn !== undefined) {
          intents.delete(e.op);
          const red = e.type === 'done' && e.kind === 'proc.spawn' && e.outcome.kind === 'result' && e.outcome.summary.type === 'command'
            && ['pass', 'fail', 'stall'].includes(e.outcome.summary.verdict) ? isRed(e.outcome.summary.verdict) : null;
          this.spawns.push({ intent: spawn.intent, seq: spawn.seq, start: spawn.at, end: at, red });
        }
        const job = batchFfs.get(e.op);
        if (job !== undefined && e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published') {
          for (const u of batchCandidates.get(job) ?? []) this.batchMerged.set(u, at);
        }
        continue;
      }
      const f = e.fact;
      switch (f.kind) {
        case 'dispatch':
          if (!this.admitted.has(f.record.unit)) this.admitted.set(f.record.unit, { seq: e.seq, at });
          break;
        case 'stage-outcome':
          this.push(this.outcomes, f.unit, { seq: e.seq, at, stage: f.stage, attempt: f.attempt, cls: f.class });
          break;
        case 'plan-applied':
          this.applied.push({ seq: e.seq, fact: f });
          for (const c of f.changes) {
            if (c.type === 'unit-cut' || c.type === 'unit-removed') this.gone.add(c.unit);
            if (c.type === 'unit-reentered') this.gone.add(c.reenters);
          }
          if (f.source.type === 'command' && f.changes.some(drainsArc)) this.globalHeld.push({ start: Math.min(submittedAtMs(f.source.command), at), end: at });
          break;
        case 'paused':
          if (f.target.type === 'all') pausedAllAt ??= at;
          else if (!pausedUnit.has(f.target.unit)) pausedUnit.set(f.target.unit, at);
          break;
        case 'resumed':
          if (f.target.type === 'all') {
            if (pausedAllAt !== null) this.globalHeld.push({ start: pausedAllAt, end: at });
            pausedAllAt = null;
            closeAll(at);
          } else if (f.target.type === 'unit') {
            const start = pausedUnit.get(f.target.unit);
            if (start !== undefined) this.held(f.target.unit, { start, end: at });
            pausedUnit.delete(f.target.unit);
          }
          break;
        case 'stop-requested':
          stopAt ??= at;
          break;
        case 'executor-started':
          if (stopAt !== null) this.globalHeld.push({ start: stopAt, end: at });
          stopAt = null;
          if (f.host !== undefined) this.host = f.host;
          break;
        case 'obligation-latched':
          this.latches.push({ seq: e.seq, obligation: f.obligation });
          break;
        case 'meter': {
          const cost = f.usage.costUsd;
          this.costUsd += cost ?? 0;
          if (f.subject.type === 'seat') {
            const sum = this.unitCost.get(f.subject.unit);
            this.unitCost.set(f.subject.unit, sum === null || cost === null ? null : (sum ?? 0) + cost);
          }
          break;
        }
        case 'usage-unavailable':
          if (f.subject.type === 'seat') this.unitCost.set(f.subject.unit, null);
          break;
        default:
          break;
      }
    }
    // Still open at the end of the log.
    for (const s of intents.values()) this.spawns.push({ intent: s.intent, seq: s.seq, start: s.at, end: null, red: null });
    this.spawns.sort((a, b) => a.seq - b.seq);
    if (pausedAllAt !== null) this.globalHeld.push({ start: pausedAllAt, end: Infinity });
    for (const [u, start] of pausedUnit) this.held(u, { start, end: Infinity });
    if (stopAt !== null) this.globalHeld.push({ start: stopAt, end: Infinity });
  }

  private push<T>(map: Map<UnitId, T[]>, unit: UnitId, item: T): void {
    const list = map.get(unit);
    if (list === undefined) map.set(unit, [item]);
    else list.push(item);
  }

  private held(unit: UnitId, span: Span): void {
    this.push(this.unitHeld, unit, span);
  }

  /** The `plan-applied` in force at `seq`. */
  appliedAt(seq: number): PlanAppliedFact {
    const a = this.applied.findLast((x) => x.seq < seq);
    if (a === undefined) throw new Error(`flow series: no plan in force at seq ${seq}`);
    return a.fact;
  }
}

/**
 * A unit's partition up to `end` (its merge, or in flight the time asked, or its last outcome when later): its stations'
 * ms, its rework, its first-run suite reds and all its held time.
 */
type Partition = Readonly<{ ms: ReadonlyMap<StationId, number>; rework: number; firstRunReds: number; held: number; end: number }>;

const SLOT_COMPONENT = { candidateRest: stationId('candidate-rest'), arcLanes: stationId('arc-lanes'), ff: stationId('ff'), snapshot: stationId('snapshot') } as const;
const HELD = stationId(HELD_STATION);
const suiteStation = (lane: LaneId): StationId => stationId(`suite:${lane}`);

class SeriesFold {
  readonly #log: LogIndex;
  readonly #inputs: SeriesInputs;
  readonly #lanes = new Map<string, SuiteLanes>();

  constructor(log: LogIndex, inputs: SeriesInputs) {
    this.#log = log;
    this.#inputs = inputs;
  }

  /** The suite lanes and their stand-ins under the plan in force at `seq`. */
  suiteLanesAt(seq: number): SuiteLanes {
    const applied = this.#log.appliedAt(seq);
    const key = `${applied.planSha256}:${applied.obligationsSha256 ?? ''}`;
    const known = this.#lanes.get(key);
    if (known !== undefined) return known;
    const plan = this.#inputs.planOf(applied);
    const arcLanes = this.#inputs.obligationsOf(applied)?.lanes ?? [];
    const lanes: SuiteLanes = {
      suite: new Set(plan.suite.lanes.map((l) => l.id)),
      standIn: (arcLane) => {
        const def = arcLanes.find((l) => l.id === arcLane);
        return def === undefined ? null : plan.suite.lanes.find((s) => sameExecution(s, def))?.id ?? null;
      },
    };
    this.#lanes.set(key, lanes);
    return lanes;
  }

  /** The suite lane a spawn ran and the run's shape, or null for any other spawn; `trees`: its parent's candidate merge. */
  suiteRunOf(s: Spawn, trees: CandidateTrees | undefined): Readonly<{ lane: LaneId; shape: SuiteRunShape }> | null {
    const subject = s.intent.expect.subject;
    if (trees === undefined) return null;
    if (subject.purpose === 'lane' && subject.set === 'suite' && s.intent.parent.type === 'stage') {
      if (subject.at === trees.tip) return { lane: subject.lane, shape: 'rerun' };
      return subject.at === trees.candidate ? { lane: subject.lane, shape: 'lane' } : null;
    }
    if (subject.purpose !== 'journey') return null;
    const lanes = this.suiteLanesAt(s.seq);
    const onTip = subject.at === trees.tip;
    if (!onTip && subject.at !== trees.candidate) return null;
    if (subject.owner.type === 'unit') {
      // A unit's candidate runs only stand-ins in its suite series; its brake's journeys reuse them (arc lanes otherwise).
      const lane = onTip ? null : lanes.standIn(subject.lane);
      return lane === null ? null : { lane, shape: 'stand-in' };
    }
    if (parseJobId(subject.owner.job).kind !== 'batch') return null;
    const lane = lanes.suite.has(subject.lane) ? subject.lane : lanes.standIn(subject.lane);
    return lane === null ? null : { lane, shape: onTip ? 'rerun' : 'batch' };
  }

  /** The candidate merge a spawn's parent made. */
  treesOf(s: Spawn): CandidateTrees | undefined {
    const p = s.intent.parent;
    if (p.type === 'stage' && p.stage === 'candidate') return this.#log.candidates.get(`${p.unit}#${p.attempt}`);
    if (p.type === 'job') return this.#log.candidates.get(p.job);
    return undefined;
  }

  suiteRuns(): readonly SuiteRun[] {
    const out: SuiteRun[] = [];
    for (const s of this.#log.spawns) {
      if (s.end === null || s.red === null) continue;
      const run = this.suiteRunOf(s, this.treesOf(s));
      if (run === null) continue;
      out.push({ lane: run.lane, at: iso(s.start), minutes: minutesOf(s.end - s.start), shape: run.shape, red: s.red });
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /** The unit's partition from its admission to its merge, or (`until`) to that time while it is in flight. */
  partition(unit: UnitId, until: number | null): Partition {
    const log = this.#log;
    const admitted = log.admitted.get(unit);
    if (admitted === undefined) throw new Error(`flow series: unit ${unit} has no dispatch`);
    const out = new Map<StationId, number>();
    const add = (station: StationId, t: number): void => {
      if (t > 0) out.set(station, (out.get(station) ?? 0) + t);
    };
    const holds = [...log.globalHeld, ...(log.unitHeld.get(unit) ?? [])];
    let heldTotal = 0;
    const wait = (station: StationId, a: number, b: number, whole: boolean): void => {
      const h = whole ? b - a : covered(holds, a, b);
      heldTotal += h;
      add(HELD, h);
      add(station, b - a - h);
    };
    const ops = log.stageOps.get(unit) ?? [];
    const closed = new Set<string>();
    const firstOp = (after: number, before: number): number | null => ops.find((o) => o.seq > after && o.seq < before && !closed.has(o.key))?.at ?? null;
    let cursor = { seq: admitted.seq, at: admitted.at };
    let holding = false;
    let rework = 0;
    let firstRunReds = 0;
    for (const o of log.outcomes.get(unit) ?? []) {
      if (o.seq < admitted.seq) throw new Error(`flow series: unit ${unit} recorded ${o.stage}#${o.attempt} before its first dispatch`);
      if (until !== null && o.at > until) break;
      if (o.at < cursor.at) throw new Error(`flow series: unit ${unit} recorded ${o.stage}#${o.attempt} at ${new Date(o.at).toISOString()}, before its previous step`);
      const start = Math.min(Math.max(firstOp(cursor.seq, o.seq) ?? o.at, cursor.at), o.at);
      if (o.stage === 'ff' || o.stage === 'snapshot') {
        add(o.stage === 'ff' ? SLOT_COMPONENT.ff : SLOT_COMPONENT.snapshot, o.at - cursor.at);
      } else if (o.stage === 'candidate') {
        wait(stationId(SLOT_WAIT_STATION), cursor.at, start, holding);
        const c = this.candidate(unit, o.attempt, start, o.at);
        for (const [station, t] of c.ms) add(station, t);
        rework += c.reruns;
        firstRunReds += c.firstRunReds;
      } else if (isFlowStage(o.stage)) {
        wait(stationId(`wait:${o.stage}`), cursor.at, start, holding);
        add(stationId(`stage:${o.stage}`), o.at - start);
      } else {
        throw new Error(`flow series: unit ${unit} recorded an outcome of stage ${o.stage}`);
      }
      if (ROUNDS.includes(o.cls)) rework++;
      closed.add(attemptKey(o.stage, o.attempt));
      cursor = { seq: o.seq, at: o.at };
      holding = HOLDING.includes(o.cls);
      if (o.stage === 'snapshot' && o.cls === 'retire') return { ms: out, rework, firstRunReds, held: heldTotal, end: o.at };
    }
    if (until === null) throw new Error(`flow series: unit ${unit} has no snapshot outcome`);
    // In flight: the open step's wait is held after a hold, park or stop (a parked unit's clock stops), else held where
    // the arc or the unit is; a service it began is never held.
    const end = Math.max(until, cursor.at);
    const begun = firstOp(cursor.seq, Infinity);
    const waitEnd = begun === null ? end : Math.min(Math.max(begun, cursor.at), end);
    heldTotal += holding ? waitEnd - cursor.at : covered(holds, cursor.at, waitEnd);
    return { ms: out, rework, firstRunReds, held: heldTotal, end };
  }

  /** A candidate attempt's service [start, end] split into the slot's components, and its reruns and first-run reds. */
  candidate(unit: UnitId, attempt: number, start: number, end: number): Readonly<{ ms: ReadonlyMap<StationId, number>; reruns: number; firstRunReds: number }> {
    const out = new Map<StationId, number>();
    let assigned = 0;
    const add = (station: StationId, t: number): void => {
      if (t <= 0) return;
      out.set(station, (out.get(station) ?? 0) + t);
      assigned += t;
    };
    let rerun = false;
    let firstRunReds = 0;
    const seen = new Set<LaneId>();
    const trees = this.#log.candidates.get(`${unit}#${attempt}`);
    for (const s of this.#log.spawns) {
      const p = s.intent.parent;
      if (p.type !== 'stage' || p.unit !== unit || p.stage !== 'candidate' || p.attempt !== attempt) continue;
      const t = Math.min(s.end ?? end, end) - Math.max(s.start, start);
      const run = this.suiteRunOf(s, trees);
      if (run !== null && run.shape === 'rerun') {
        rerun = true; // rework: the rest of the hold
      } else if (run !== null) {
        add(suiteStation(run.lane), t);
        if (!seen.has(run.lane) && s.red === true) firstRunReds++;
        seen.add(run.lane);
      } else if (s.intent.expect.subject.purpose === 'journey' || s.intent.expect.subject.purpose === 'mutant') {
        add(SLOT_COMPONENT.arcLanes, t);
      }
    }
    const rest = end - start - assigned;
    if (rest < 0) throw new Error(`flow series: unit ${unit}'s candidate#${attempt} ran overlapping lanes (${-rest} ms beyond its span)`);
    if (rest > 0) out.set(SLOT_COMPONENT.candidateRest, rest);
    return { ms: out, reruns: rerun ? 1 : 0, firstRunReds };
  }
}

const minutesOf = (t: number): number => t / MS_PER_MIN;
const iso = (t: number): IsoTime => isoTime(new Date(t).toISOString());
const retired = (log: LogIndex, u: UnitId): boolean => (log.outcomes.get(u) ?? []).some((o) => o.stage === 'snapshot' && o.cls === 'retire');
const merged = (log: LogIndex, u: UnitId): boolean => log.batchMerged.has(u) || retired(log, u);

/** Units admitted, not merged, and still in the plan (not cut, removed or superseded by a re-entry). */
function inFlightUnits(log: LogIndex): readonly UnitId[] {
  return [...log.admitted.keys()].filter((u) => !merged(log, u) && !log.gone.has(u)).sort();
}

/**
 * The arc's flow series over `events` (a run dir's log, or a ref's `events.jsonl[0..highWater]`) and the plan and
 * obligations bytes its revisions kept; its host is the latest start's fingerprint (null when no start recorded one).
 */
export function flowSeries(arc: ArcId, events: readonly Event[], inputs: SeriesInputs): FlowSeries {
  const log = new LogIndex(events);
  const fold = new SeriesFold(log, inputs);
  const points: FlowPoint[] = [];
  for (const unit of [...log.admitted.keys()].sort()) {
    if (log.batchMerged.has(unit) || !retired(log, unit)) continue;
    const p = fold.partition(unit, null);
    const admittedAt = log.admitted.get(unit)!.at;
    const minutes: Record<StationId, number> = {};
    for (const [station, t] of [...p.ms].sort(([a], [b]) => (a < b ? -1 : 1))) minutes[station] = minutesOf(t);
    points.push({
      unit, admittedAt: iso(admittedAt), mergedAt: iso(p.end), leadMin: minutesOf(p.end - admittedAt), minutes,
      costUsd: log.unitCost.has(unit) ? log.unitCost.get(unit)! : 0, rework: p.rework, firstRunReds: p.firstRunReds,
    });
  }
  points.sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : 0));
  return { v: FLOW_SERIES_V, arc, host: log.host, points, suiteRuns: fold.suiteRuns(), accounting: accounting(log, inputs, points.length) };
}

function accounting(log: LogIndex, inputs: SeriesInputs, unitPoints: number): FlowAccounting {
  const hours = Number.isNaN(log.first) ? 0 : (log.last - log.first) / 3_600_000;
  const rate = (n: number): number => (hours === 0 ? 0 : n / hours);
  const latest = log.applied.at(-1)?.fact ?? null;
  let tAdvances: number | null = null;
  let tOther: number | null = null;
  if (latest !== null && latest.visionSha256 !== undefined) {
    const firstHeld = new Map<ObligationId, number>();
    for (const l of log.latches) if (!firstHeld.has(l.obligation)) firstHeld.set(l.obligation, l.seq);
    let advancing = 0;
    for (const [obligation, seq] of firstHeld) {
      const applied = log.appliedAt(seq);
      const def = inputs.obligationsOf(applied)?.obligations.find((o) => o.id === obligation);
      if (def === undefined) throw new Error(`flow series: obligation ${obligation}, latched at seq ${seq}, is not in the obligations in force`);
      const advances = new Set(advancesOf(inputs.planOf(applied)));
      if (def.serves.some((c) => advances.has(c))) advancing++;
    }
    tAdvances = rate(advancing);
    tOther = rate(firstHeld.size - advancing);
  }
  let queued = 0;
  if (latest !== null) {
    const plan = inputs.planOf(latest);
    const superseded = new Set(plan.units.flatMap((u) => (u.reenters === undefined ? [] : [u.reenters.unit])));
    queued = plan.units.filter((u) => u.cut === undefined && !superseded.has(u.id) && !log.admitted.has(u.id) && u.after.every((d) => merged(log, d))).length;
  }
  return { tAdvances, tOther, tUnits: rate(unitPoints + log.batchMerged.size), wip: inFlightUnits(log).length + queued, oeUsdPerHour: rate(log.costUsd) };
}

/** The in-flight units' ages at `now`, held time excluded (a parked or paused unit's clock stops). */
export function inFlightAges(events: readonly Event[], now: IsoTime, inputs: SeriesInputs): readonly Readonly<{ unit: UnitId; ageMin: number }>[] {
  const log = new LogIndex(events);
  const fold = new SeriesFold(log, inputs);
  return inFlightUnits(log).map((unit) => {
    const p = fold.partition(unit, ms(now));
    return { unit, ageMin: minutesOf(p.end - log.admitted.get(unit)!.at - p.held) };
  });
}

const SLOT = stationId(SLOT_STATION);
/** Whether a leaf station is one of the integration slot's service components (`suite:<lane>` or `SLOT_COMPONENTS`). */
export function isSlotComponent(station: StationId): boolean {
  const t = parseStationId(station).type;
  return t === 'suite' || t === 'component';
}

/** Mean minutes per station over `points`, each leaf and `slot:integration` (its components' sum). */
export function stationMeans(points: readonly FlowPoint[]): ReadonlyMap<StationId, number> {
  const sums = new Map<StationId, number>();
  for (const p of points) {
    for (const [station, m] of Object.entries(p.minutes) as [StationId, number][]) {
      sums.set(station, (sums.get(station) ?? 0) + m);
      if (isSlotComponent(station)) sums.set(SLOT, (sums.get(SLOT) ?? 0) + m);
    }
  }
  return new Map([...sums].map(([s, sum]) => [s, sum / points.length]));
}

/**
 * Each station's mean minutes and share of mean lead over `points` (the constraint's window), largest first: every leaf
 * station and `slot:integration` (its components' sum, so the shares of the leaves alone sum to 1).
 */
export function stationTable(points: readonly FlowPoint[]): readonly StationRow[] {
  if (points.length === 0) return [];
  const lead = points.reduce((a, p) => a + p.leadMin, 0) / points.length;
  return [...stationMeans(points)].map(([station, meanMin]) => ({ station, meanMin, share: lead === 0 ? 0 : Math.min(1, meanMin / lead) }))
    .sort((a, b) => b.meanMin - a.meanMin || (a.station < b.station ? -1 : 1));
}
