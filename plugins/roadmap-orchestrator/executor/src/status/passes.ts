// What status derives by reading every event of the journal, kept as the journal grows. Each pass is a reducer folded
// forward one event at a time (`step`); what it holds after n events is a function of those n events alone, so a reducer
// extended over a journal in any chunks holds what one folded from nothing over the same events holds. The full derivation
// (`roadmap status`, a cold capture) is the same reducers folded from nothing: there is no second implementation.
//
// The console's observer keeps one `StatusPasses` per journal generation and extends it with each capture's appended events;
// a journal that is shorter, or whose folded prefix changed, is a new generation and is folded from nothing. Where a pass
// also reads files (the work runs' exit records, the decisions' command bodies), the read stays outside the reducer, behind
// the write-once memo, and happens when the value is asked for.
import { type Event, type JobStageOutcomeFact, OUTCOME_STAGES, type OutcomeStage } from '../core/events.ts';
import type { LaneId, OpId } from '../core/ids.ts';
import type { IsoTime } from '../core/values.ts';
import { GrindingFold, LaneRunFold, type LaneRun, type WasteFinding, wasteOf } from '../flow/waste.ts';
import { FindingTimesFold } from '../holistic/findings.ts';
import { MeterFold } from '../meter.ts';
import type { StageTiming } from '../phase0/types.ts';
import { LanesAttemptsFold, ReservationFold } from '../status-work.ts';
import { WaitingFold } from './waiting.ts';

/** When each intent was appended, by `<op>#<ordinal>`. */
export class IntentTimesFold {
  readonly #times = new Map<string, IsoTime>();
  step(e: Event): void { if (e.type === 'intent') this.#times.set(`${e.op}#${e.ordinal}`, e.at); }
  get times(): ReadonlyMap<string, IsoTime> { return this.#times; }
}

/** When each stage attempt journaled its first op, by `<unit>/<stage>#<attempt>`. */
export class AttemptStartsFold {
  readonly #starts = new Map<string, IsoTime>();
  /** The attempt key `e` started, when it is a stage attempt's first op. */
  step(e: Event): string | null {
    if (e.type !== 'intent' || e.parent.type !== 'stage') return null;
    const key = `${e.parent.unit}/${e.parent.stage}#${e.parent.attempt}`;
    if (this.#starts.has(key)) return null;
    this.#starts.set(key, e.at);
    return key;
  }
  get starts(): ReadonlyMap<string, IsoTime> { return this.#starts; }
}

/**
 * LR-c: per stage, the durations of the completed attempts whose `stage-outcome` is after `after`: from the attempt's first
 * journaled op to its outcome. An outcome whose attempt journals its first op later (a cleanup op after it) is timed when
 * that op arrives, as one read over the whole journal times it; one whose attempt never journals an op is not timed.
 */
export class StageTimingsFold {
  readonly #after: number;
  readonly #starts = new AttemptStartsFold();
  readonly #untimed = new Map<string, { stage: OutcomeStage; at: IsoTime }[]>();
  readonly #durations = new Map<OutcomeStage, number[]>();
  #timings: readonly StageTiming[] | null = null;
  constructor(after: number) { this.#after = after; }
  step(e: Event): void {
    const started = this.#starts.step(e);
    if (started !== null) {
      for (const o of this.#untimed.get(started) ?? []) this.#time(o.stage, o.at, this.#starts.starts.get(started)!);
      this.#untimed.delete(started);
    }
    if (e.type !== 'fact' || e.fact.kind !== 'stage-outcome' || !('unit' in e.fact) || e.seq <= this.#after) return;
    const f = e.fact, key = `${f.unit}/${f.stage}#${f.attempt}`;
    const start = this.#starts.starts.get(key);
    if (start !== undefined) this.#time(f.stage, e.at, start);
    else this.#untimed.set(key, [...(this.#untimed.get(key) ?? []), { stage: f.stage, at: e.at }]);
  }
  #time(stage: OutcomeStage, at: IsoTime, start: IsoTime): void {
    this.#timings = null;
    const durations = this.#durations.get(stage) ?? [];
    durations.push(Math.max(0, Date.parse(at) - Date.parse(start))); this.#durations.set(stage, durations);
  }
  /** The attempts' first ops, as `AttemptStartsFold` reads them. */
  get starts(): ReadonlyMap<string, IsoTime> { return this.#starts.starts; }
  /** In stage order: the count, median (the lower one) and maximum duration in ms. */
  get timings(): readonly StageTiming[] {
    return this.#timings ??= OUTCOME_STAGES.flatMap((stage) => {
      const ms = [...(this.#durations.get(stage) ?? [])].sort((a, b) => a - b);
      return ms.length === 0 ? [] : [{ stage, count: ms.length, p50Ms: ms[Math.floor((ms.length - 1) / 2)]!, maxMs: ms.at(-1)! }];
    });
  }
}

/** The events a decision is read from (src/status.ts `decisionsAfter`), in log order: spec patches done, and the facts that rule. */
export class DecisionSourcesFold {
  readonly #sources: Event[] = [];
  step(e: Event): void {
    if (e.type === 'done' && e.kind === 'spec.patch') this.#sources.push(e);
    else if (e.type === 'fact' && ['plan-applied', 'steered', 'lanes-rerun', 'divergence'].includes(e.fact.kind)) this.#sources.push(e);
  }
  get sources(): readonly Event[] { return [...this.#sources]; }
}

/** What the summary (src/status/summary.ts) counts and lists over every event besides the meter and the lane runs. */
export class SummaryFold {
  readonly #jobsByMilestone = new Map<string, string[]>();
  readonly #jobsByUnit = new Map<string, string[]>();
  #estimatedCalls = 0;
  #gateRevisions = 0;
  readonly #findings = new Set<string>();
  readonly #byLens: Record<string, number> = {};
  readonly #verdicts: JobStageOutcomeFact[] = [];
  readonly #laneSpawns: Readonly<{ lane: LaneId; op: OpId }>[] = [];
  step(e: Event): void {
    if (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'lane') this.#laneSpawns.push({ lane: e.expect.subject.lane, op: e.op });
    if (e.type !== 'fact') return;
    const f = e.fact;
    const add = (map: Map<string, string[]>, key: string, job: string) => { const jobs = map.get(key) ?? []; jobs.push(job); map.set(key, jobs); };
    if (f.kind === 'walk-started') add(this.#jobsByMilestone, f.milestone, f.job);
    if (f.kind === 'compare-started') add(this.#jobsByUnit, f.unit, f.job);
    if (f.kind === 'meter' && f.usage.costEstimated === true) this.#estimatedCalls++;
    if (f.kind === 'stage-outcome' && 'unit' in f && f.stage === 'gate' && f.outcome === 'revise') this.#gateRevisions++;
    if (f.kind === 'finding-opened' && !this.#findings.has(f.key)) { this.#findings.add(f.key); this.#byLens[f.lens] = (this.#byLens[f.lens] ?? 0) + 1; }
    if (f.kind === 'stage-outcome' && !('unit' in f)) this.#verdicts.push(f);
  }
  /** The jobs of each milestone's walks and of each unit's comparisons, in log order. */
  jobs(by: 'milestone' | 'unit', key: string): readonly string[] { return (by === 'milestone' ? this.#jobsByMilestone : this.#jobsByUnit).get(key) ?? []; }
  get estimatedCalls(): number { return this.#estimatedCalls; }
  /** Gate revisions and the distinct findings opened (by key), with the distinct ones per lens. */
  get caught(): Readonly<{ gateRevisions: number; uniqueFindings: number; byLens: Readonly<Record<string, number>> }> {
    return { gateRevisions: this.#gateRevisions, uniqueFindings: this.#findings.size, byLens: { ...this.#byLens } };
  }
  /** The jobs' stage outcomes, in log order. */
  get verdicts(): readonly JobStageOutcomeFact[] { return [...this.#verdicts]; }
  /** Every lane spawn, in log order (the summary keeps those of the plan's capture lanes). */
  get laneSpawns(): readonly Readonly<{ lane: LaneId; op: OpId }>[] { return [...this.#laneSpawns]; }
}

/** Every pass status makes over the events, extended together. One instance per journal generation. */
export class StatusPasses {
  readonly #intents = new IntentTimesFold();
  readonly #stages = new StageTimingsFold(0);
  readonly #meter = new MeterFold();
  readonly #waiting = new WaitingFold();
  readonly #findings = new FindingTimesFold();
  readonly #reservations = new ReservationFold();
  readonly #lanes = new LanesAttemptsFold();
  readonly #runs = new LaneRunFold();
  readonly #grinding = new GrindingFold();
  readonly #summary = new SummaryFold();
  readonly #decisions = new DecisionSourcesFold();
  #folded = 0;
  /** The last event folded: the journal `extend` is given must be this one, grown. */
  #last: Event | null = null;
  /** How many of the journal's events are folded. */
  get folded(): number { return this.#folded; }
  /** Folds `events[this.folded..]`. `events` is the journal folded so far, grown: a shorter one or another prefix is a bug. */
  extend(events: readonly Event[]): void {
    if (events.length < this.#folded) throw new Error(`status passes: the journal has ${events.length} events, ${this.#folded} were folded`);
    if (this.#folded > 0 && events[this.#folded - 1] !== this.#last) throw new Error(`status passes: event ${this.#folded} is not the one folded`);
    for (let i = this.#folded; i < events.length; i++) {
      const e = events[i]!;
      this.#intents.step(e); this.#stages.step(e); this.#meter.step(e); this.#waiting.step(e); this.#findings.step(e); this.#reservations.step(e);
      this.#lanes.step(e); this.#runs.step(e); this.#grinding.step(e); this.#summary.step(e); this.#decisions.step(e);
    }
    this.#folded = events.length;
    this.#last = events.at(-1) ?? null;
  }
  /** A new set of passes folded over `events` from nothing: the full derivation. */
  static of(events: readonly Event[]): StatusPasses {
    const passes = new StatusPasses();
    passes.extend(events);
    return passes;
  }
  get intentTimes(): ReadonlyMap<string, IsoTime> { return this.#intents.times; }
  get attemptStarts(): ReadonlyMap<string, IsoTime> { return this.#stages.starts; }
  get stageTimings(): readonly StageTiming[] { return this.#stages.timings; }
  get meter() { return this.#meter.meter; }
  get waiting() { return this.#waiting.totals; }
  get findingTimes(): FindingTimesFold { return this.#findings; }
  get reservations(): ReservationFold { return this.#reservations; }
  get certification(): LanesAttemptsFold { return this.#lanes; }
  get laneRuns(): readonly LaneRun[] { return this.#runs.runs; }
  get grinding(): readonly WasteFinding[] { return this.#grinding.findings; }
  /** Every waste detector's findings over the folded events (src/flow/waste.ts `wasteFindings`). */
  get waste(): readonly WasteFinding[] { return wasteOf(this.grinding, this.laneRuns); }
  get summary(): SummaryFold { return this.#summary; }
  get decisionSources(): readonly Event[] { return this.#decisions.sources; }
}
