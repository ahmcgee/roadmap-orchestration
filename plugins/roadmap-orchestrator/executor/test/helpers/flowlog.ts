// A synthetic arc log for the flow series' pure tests (src/flow/series.ts): records stamped on a minute clock, holding
// exactly the fields the series reads (the chain hash is not the series' concern, so `prev` is a constant). Plans and
// obligations are the few fields the series reads, behind a `SeriesInputs`.
import type { Event, Fact } from '../../src/core/events.ts';
import { type ArcId, type LaneId, type UnitId, arcId, commandId, laneId, opId, sha, sha256 } from '../../src/core/ids.ts';
import type { LaneDef, Stage } from '../../src/core/records.ts';
import { isoTime, type IsoTime } from '../../src/core/values.ts';
import type { SeriesInputs } from '../../src/flow/series.ts';
import type { HostFingerprint } from '../../src/flow/types.ts';
import type { ArcLaneDef, Obligations } from '../../src/holistic/types.ts';
import type { PlanM1 } from '../../src/input/plan.ts';

export const ARC = arcId('arc-f');
export const T0 = Date.parse('2026-10-08T09:00:00.000Z');
export const CAND = sha('c'.repeat(40));
export const TIP = sha('7'.repeat(40));
export const HOST: HostFingerprint = { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 32 };
const H = sha256('d'.repeat(64));
export const PLAN_A = sha256('a'.repeat(64));

/** Minutes after T0 as an ISO time. */
export const atMin = (min: number): IsoTime => isoTime(new Date(T0 + min * 60_000).toISOString());
/** A command id submitted `min` minutes after T0 (the id's clock: 12 hex of ms). */
export const commandAt = (min: number): ReturnType<typeof commandId> => commandId(`cmd-${Math.round(T0 + min * 60_000).toString(16).padStart(12, '0')}0000`);

export class FlowLog {
  readonly events: Event[] = [];
  readonly arc: ArcId;
  constructor(arc: ArcId = ARC) {
    this.arc = arc;
  }

  #push(min: number, record: object): number {
    const seq = this.events.length + 1;
    this.events.push({ v: 1, seq, prev: seq === 1 ? null : H, at: atMin(min), arc: this.arc, ...record } as unknown as Event);
    return seq;
  }

  fact(min: number, fact: object): number {
    return this.#push(min, { type: 'fact', fact: fact as Fact });
  }

  /** An intent of `kind` under `parent`; returns its op. */
  intent(min: number, kind: string, parent: object, expect: object = {}, post: object | null = null): ReturnType<typeof opId> {
    const op = opId(this.arc, this.events.length + 1);
    this.#push(min, { type: 'intent', op, kind, key: `k${this.events.length + 1}`, parent, ordinal: 1, deadlineAt: null, expect, post });
    return op;
  }

  done(min: number, op: ReturnType<typeof opId>, kind: string, outcome: object): void {
    this.#push(min, { type: 'done', op, kind, outcome, recoveredBy: null });
  }

  started(min: number, host: HostFingerprint | null = HOST): void {
    this.fact(min, { kind: 'executor-started', generation: 1, ...(host === null ? {} : { host }) });
  }

  applied(min: number, rev: number, opts: Readonly<{ command?: string; changes?: readonly object[]; vision?: boolean; plan?: string; obligations?: string }> = {}): void {
    this.fact(min, {
      kind: 'plan-applied', rev, command: opts.command ?? null, changes: opts.changes ?? [], planSha256: opts.plan ?? PLAN_A, specs: {},
      source: opts.command === undefined ? { type: 'start' } : { type: 'command', command: opts.command }, payloadSha256: H, rulingsSha256: H,
      ...(opts.obligations === undefined ? {} : { obligationsSha256: opts.obligations }), ...(opts.vision === true ? { visionSha256: H } : {}),
      routingProvenance: { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} },
    });
  }

  dispatch(min: number, unit: string): void {
    this.fact(min, { kind: 'dispatch', record: { unit, at: atMin(min) } });
  }

  /** A stage-parented op (its first op starts the stage's service). */
  op(min: number, unit: string, stage: Stage, attempt: number): void {
    this.intent(min, 'worktree.create', stageOf(unit, stage, attempt));
  }

  outcome(min: number, unit: string, stage: Stage, attempt: number, outcome: string, cls = 'advance'): void {
    this.fact(min, { kind: 'stage-outcome', unit, stage, attempt, outcome, class: cls, chargeable: false });
  }

  /** One stage step: its first op at `opMin`, its outcome at `outMin`. */
  step(opMin: number | null, outMin: number, unit: string, stage: Stage, attempt: number, outcome = 'ok', cls = 'advance'): void {
    if (opMin !== null) this.op(opMin, unit, stage, attempt);
    this.outcome(outMin, unit, stage, attempt, outcome, cls);
  }

  /** A candidate attempt's slot reserve and merge (candidate CAND onto TIP), at `min`. */
  candidateStart(min: number, unit: string, attempt: number): void {
    this.intent(min, 'resource.transition', stageOf(unit, 'candidate', attempt), { holder: { type: 'publication', unit, attempt }, resources: ['integration-slot'], edge: { type: 'reserve' } });
    this.intent(min, 'candidate.merge', stageOf(unit, 'candidate', attempt), { integrationTip: TIP }, { new: CAND });
  }

  /** A spawn under `parent` from `from` to `to` with `verdict` (null: lost) and, given, its interval `pressure` (M4b rev 3). */
  spawn(from: number, to: number, parent: object, subject: object, verdict: 'pass' | 'fail' | 'stall' | 'cancelled' | null = 'pass', pressure?: number | null): void {
    const op = this.intent(from, 'proc.spawn', parent, { subject, launchSha256: H });
    this.done(to, op, 'proc.spawn', verdict === null
      ? { kind: 'lost', treeEffects: false }
      : { kind: 'result', resultSha256: H, summary: { type: 'command', verdict }, ...(pressure === undefined ? {} : { pressure }) });
  }

  suiteLane(from: number, to: number, unit: string, attempt: number, lane: string, at: string, verdict: 'pass' | 'fail' = 'pass', pressure?: number | null): void {
    this.spawn(from, to, stageOf(unit, 'candidate', attempt), { purpose: 'lane', unit, lane, set: 'suite', at }, verdict, pressure);
  }

  journey(from: number, to: number, parent: object, owner: object, lane: string, at: string, verdict: 'pass' | 'fail' = 'pass'): void {
    this.spawn(from, to, parent, { purpose: 'journey', lane, laneRev: '0123456789abcdef', at, owner }, verdict);
  }

  /** A unit from dispatch at `t` straight through to its retire, each step one minute, the candidate running `suite` for `suiteMin`. */
  straight(t: number, unit: string, suiteMin = 1): number {
    this.dispatch(t, unit);
    this.step(t, t + 1, unit, 'build', 1);
    this.step(t + 1, t + 2, unit, 'gate', 2);
    this.candidateStart(t + 2, unit, 3);
    this.suiteLane(t + 2, t + 2 + suiteMin, unit, 3, 'suite', CAND);
    this.outcome(t + 2 + suiteMin, unit, 'candidate', 3, 'green');
    this.outcome(t + 2 + suiteMin, unit, 'ff', 4, 'published');
    this.outcome(t + 3 + suiteMin, unit, 'snapshot', 5, 'published', 'retire');
    return t + 3 + suiteMin;
  }
}

export const stageOf = (unit: string, stage: Stage, attempt: number) => ({ type: 'stage', unit, stage, attempt }) as const;

export const laneDef = (id: string, argv: readonly string[]): LaneDef =>
  ({ id: laneId(id), argv, cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] }) as unknown as LaneDef;
export const arcLaneDef = (id: string, argv: readonly string[]): ArcLaneDef => ({ ...laneDef(id, argv), reporter: 'node-test' }) as ArcLaneDef;

export type PlanSketch = Readonly<{
  suite?: readonly LaneDef[];
  units?: readonly Readonly<{ id: string; after?: readonly string[]; cut?: boolean; reenters?: string }>[];
  advances?: readonly string[];
}>;

/** The plan fields the series reads. */
export function planOf(s: PlanSketch): PlanM1 {
  return {
    suite: { lanes: s.suite ?? [laneDef('suite', ['node', '--test'])] },
    units: (s.units ?? []).map((u) => ({
      id: u.id, after: u.after ?? [], ...(u.cut === true ? { cut: { reason: 'out' } } : {}), ...(u.reenters === undefined ? {} : { reenters: { unit: u.reenters } }),
    })),
    ...(s.advances === undefined ? {} : { holistic: { advances: s.advances } }),
  } as unknown as PlanM1;
}

/** The obligations fields the series reads: arc lanes and each obligation's `serves`. */
export function obligationsOf(lanes: readonly ArcLaneDef[], serves: Readonly<Record<string, readonly string[]>> = {}): Obligations {
  return { lanes, obligations: Object.entries(serves).map(([id, s]) => ({ id, serves: s })) } as unknown as Obligations;
}

/** Inputs answering every revision with one plan and one obligations file. */
export function inputs(plan: PlanM1, obligations: Obligations | null = null): SeriesInputs {
  return { planOf: () => plan, obligationsOf: () => obligations };
}

export const unit = (id: string): UnitId => id as UnitId;
export const lane = (id: string): LaneId => laneId(id);
