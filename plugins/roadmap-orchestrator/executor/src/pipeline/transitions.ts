// The stage/outcome transition table of one serial unit (plan "Pipeline for one serial unit", R3), as data,
// and `transition`, the total pure function that reads it. No I/O and no journal: the stages (step 11b)
// record each outcome as a `stage-outcome` fact (`outcomeFact`) and act on the returned `Next`. The fold
// derives a unit's counters from those facts through the same `afterStageOutcome` this module uses, so a
// decision's predicted counters are the counters the log derives.
//
// Rules the table encodes (test/transitions.test.ts pins them row by row):
// - `chargeableFailures` grows only on design-class rows (`charge`, the plan's C). Deadline, cancel and
//   process faults never charge. The third chargeable failure parks the unit, whatever its row says.
// - Bounded rounds: plan-check redirect ≤ 1, gate revise ≤ 2, red candidate ≤ 1. Within the bound the row's
//   round runs (and a C row charges); beyond it the exhausted action runs uncharged, as no round happened.
// - One uncharged retry at plan-check, build (a resume), lanes and gate, then park. Retries are counted per
//   stage over the whole unit.
// - Route up: a refusal or escalation at a judgment stage re-dispatches that stage on its role's high seat;
//   at the high seat it parks with a needs-user. A routed-up role stays on the high seat for the unit.
// - A risk trigger (contract path touched at salvage, scope growth at the candidate) puts the next judgment
//   dispatch, and only that one, on the high seat. The implementer keeps the unit's risk seat throughout.
// - `attempts` counts stage starts, which only the fold sees; `transition` passes it through unchanged.
import {
  type JudgmentStage, type OutcomeClass, type OutcomeStage, type RetryStage, type StageOutcomeFact, type StageOutcomeKind,
  JUDGMENT_STAGES,
} from '../core/events.ts';
import type { NeedsUserReason } from '../core/records.ts';
import { CHARGEABLE_BOUND, type UnitCounters, type UnitState, afterStageOutcome } from '../core/state.ts';
import type { RiskTier } from '../routing/types.ts';

/** A seat is a role's risk tier in the routing table. */
export type Seat = RiskTier;

/** One per (stage, kind) of `STAGE_OUTCOME_KINDS`: a gate outcome for a build stage is unrepresentable. */
export type StageOutcome = { [S in OutcomeStage]: Readonly<{ stage: S; kind: StageOutcomeKind<S> }> }[OutcomeStage];

/**
 * How the implementer is dispatched. `fresh`: a new session. `fix`: resume with the failing evidence dirs
 * and any gate directives. `resume`: the uncharged resume after a malformed report. `resolve`: resume to
 * resolve and commit a prepared merge-in conflict.
 */
export type BuildRound = 'fresh' | 'fix' | 'resume' | 'resolve';

/** Executor-only stages: no backend, so no seat. */
export type ExecutorStage = Exclude<OutcomeStage, 'build' | JudgmentStage>;

/** What the needs-user says; the stage adds id, subject, evidence and options when it raises it. */
export type NeedsUserContent = Readonly<{ reason: NeedsUserReason; summary: string }>;

/** `counters` are the unit's counters once this outcome is recorded, which the next stage starts with. */
export type Next =
  | Readonly<{ kind: 'stage'; stage: 'build'; round: BuildRound; seat: Seat; counters: UnitCounters }>
  | Readonly<{ kind: 'stage'; stage: JudgmentStage; seat: Seat; counters: UnitCounters }>
  | Readonly<{ kind: 'stage'; stage: ExecutorStage; seat: null; counters: UnitCounters }>
  | Readonly<{ kind: 'park'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'stop'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'retire' }>;

// ---------------------------------------------------------------------------------------------------
// The table

export const MAX_REDIRECTS = 1;
export const MAX_REVISE_ROUNDS = 2;
export const MAX_CANDIDATE_REDS = 1;
export const MAX_RETRIES = 1;

type Target = Readonly<{ stage: 'build'; round: BuildRound }> | Readonly<{ stage: Exclude<OutcomeStage, 'build'> }>;

/** On to `to`; `chargeable` on the plan's C rows; `trigger` raises a risk trigger. */
type Go = Readonly<{ do: 'go'; to: Target; chargeable: boolean; trigger: boolean }>;
type Park = Readonly<{ do: 'park'; reason: NeedsUserReason }>;
type Stop = Readonly<{ do: 'stop'; reason: NeedsUserReason }>;
type Retire = Readonly<{ do: 'retire' }>;
/** A refusal or escalation: the role's high seat, then park with `reason`. */
type RouteUp = Readonly<{ do: 'route-up'; reason: 'refusal' | 'escalation' }>;
/** The stage's one uncharged retry, then park with `reason`. */
type Retry = Readonly<{ do: 'retry'; reason: NeedsUserReason }>;
type BoundedRound = 'redirect' | 'revise' | 'candidate-red';
/** A round the unit may take `max` times; the next one takes `then`, uncharged. */
type Bounded<S extends OutcomeStage> = Readonly<{
  do: 'bounded';
  round: BoundedRound;
  max: number;
  to: Target;
  chargeable: boolean;
  then: S extends JudgmentStage ? RouteUp : Park;
}>;

/** Route-ups exist only at judgment stages and retries only at retry stages, as the fact validator requires. */
type Rule<S extends OutcomeStage> =
  | Go | Park | Stop | Retire | Bounded<S> | (S extends JudgmentStage ? RouteUp : never) | (S extends RetryStage ? Retry : never);

type Table = { readonly [S in OutcomeStage]: { readonly [K in StageOutcomeKind<S>]: Rule<S> } };

const at = (stage: Exclude<OutcomeStage, 'build'>): Target => ({ stage });
const build = (round: BuildRound): Target => ({ stage: 'build', round });
const go = (to: Target): Go => ({ do: 'go', to, chargeable: false, trigger: false });
const charge = (to: Target): Go => ({ do: 'go', to, chargeable: true, trigger: false });
const park = (reason: NeedsUserReason): Park => ({ do: 'park', reason });
const retry = (reason: NeedsUserReason): Retry => ({ do: 'retry', reason });
const routeUp = (reason: RouteUp['reason']): RouteUp => ({ do: 'route-up', reason });

/** The plan's table, one rule per (stage, outcome); the type requires every row and admits no other. */
export const TABLE: Table = {
  'plan-check': {
    approve: go(build('fresh')),
    redirect: { do: 'bounded', round: 'redirect', max: MAX_REDIRECTS, to: at('plan-check'), chargeable: false, then: routeUp('escalation') },
    infeasible: routeUp('escalation'),
    escalate: routeUp('escalation'),
    // R2: a redirect cannot lower the risk floor (scope is not patchable in M1); refused → escalate.
    'risk-lowered': routeUp('escalation'),
    refusal: routeUp('refusal'),
    malformed: retry('malformed'),
    'process-fault': park('process-fault'),
  },
  build: {
    success: go(at('quiesce')),
    refusal: park('refusal'),
    malformed: retry('malformed'),
    'process-fault': park('process-fault'),
    // The reservation cycle's occupancy probe found unlabelled or undeclared occupancy (decided before any charge).
    occupied: park('occupancy-unlabelled'),
  },
  quiesce: { empty: go(at('evidence')) },
  evidence: { captured: go(at('salvage')) },
  salvage: {
    committed: go(at('teardown')),
    'committed-contract-touched': { do: 'go', to: at('teardown'), chargeable: false, trigger: true },
    unmerged: park('salvage-failed'),
    'commit-failed': park('salvage-failed'),
  },
  // Failed cleanup leaves a residue and never releases its resources.
  teardown: { released: go(at('lanes')), 'cleanup-failed': park('residue') },
  lanes: {
    green: go(at('gate')),
    red: charge(build('fix')),
    'not-certified': charge(build('fix')),
    blocked: retry('lane-blocked'),
    interrupted: retry('process-fault'),
    occupied: park('occupancy-unlabelled'),
  },
  gate: {
    approve: go(at('candidate')),
    revise: { do: 'bounded', round: 'revise', max: MAX_REVISE_ROUNDS, to: build('fix'), chargeable: true, then: routeUp('escalation') },
    escalate: routeUp('escalation'),
    'empty-diff': park('empty-diff'),
    refusal: routeUp('refusal'),
    malformed: retry('malformed'),
    'process-fault': park('process-fault'),
  },
  candidate: {
    green: go(at('ff')),
    // Scope growth: a C fix round, and a risk trigger for the fresh gate that follows it.
    'transient-violation': { do: 'go', to: build('fix'), chargeable: true, trigger: true },
    // mergein.prepare, then resume "resolve and commit"; uncharged, the diff base is recomputed.
    conflict: go(build('resolve')),
    // Red with T alone green: a fix round, fresh gate, new candidate. Red again parks.
    red: { do: 'bounded', round: 'candidate-red', max: MAX_CANDIDATE_REDS, to: build('fix'), chargeable: true, then: park('candidate-red') },
    // Red with T alone red too: the base is broken, not the unit; uncharged.
    'base-red': park('base-red'),
    occupied: park('occupancy-unlabelled'),
  },
  ff: {
    published: go(at('snapshot')),
    // CAS failed, the tip advanced, the fingerprint still holds: a fresh candidate, no new gate.
    'cas-stale': go(at('candidate')),
    'fingerprint-invalid': go(at('gate')),
    // Integration rewound, or an executor-owned ref moved by another.
    'foreign-move': { do: 'stop', reason: 'foreign-ref-move' },
  },
  snapshot: { published: { do: 'retire' } },
};

// ---------------------------------------------------------------------------------------------------
// The function

type Step =
  | Readonly<{ to: 'stage'; target: Target }>
  | Readonly<{ to: 'park' | 'stop'; needsUser: NeedsUserContent }>
  | Readonly<{ to: 'retire' }>;
type Decision = Readonly<{ class: OutcomeClass; chargeable: boolean; step: Step }>;

const ROUND_COUNTERS = { redirect: 'redirects', revise: 'reviseRounds', 'candidate-red': 'candidateReds' } as const satisfies {
  readonly [R in BoundedRound]: keyof UnitCounters;
};

function ruleOf(o: StageOutcome): Rule<OutcomeStage> {
  switch (o.stage) {
    case 'plan-check': return TABLE['plan-check'][o.kind];
    case 'build': return TABLE.build[o.kind];
    case 'quiesce': return TABLE.quiesce[o.kind];
    case 'evidence': return TABLE.evidence[o.kind];
    case 'salvage': return TABLE.salvage[o.kind];
    case 'teardown': return TABLE.teardown[o.kind];
    case 'lanes': return TABLE.lanes[o.kind];
    case 'gate': return TABLE.gate[o.kind];
    case 'candidate': return TABLE.candidate[o.kind];
    case 'ff': return TABLE.ff[o.kind];
    case 'snapshot': return TABLE.snapshot[o.kind];
    default: return unreachable(o);
  }
}

function unreachable(o: never): never {
  throw new Error(`transition: no row for ${JSON.stringify(o)}`);
}

function risk(u: UnitState): Seat {
  if (u.risk === null) throw new Error(`transition: unit ${u.unit} has no dispatch record, so no risk seat`);
  return u.risk;
}

/** The seat a judgment stage is dispatched on in state `u`. */
export function judgmentSeat(u: UnitState, stage: JudgmentStage): Seat {
  return u.routedUp.includes(stage) || u.promotion ? 'high' : risk(u);
}

function isJudgment(stage: OutcomeStage): stage is JudgmentStage {
  return (JUDGMENT_STAGES as readonly OutcomeStage[]).includes(stage);
}

function halt(to: 'park' | 'stop', reason: NeedsUserReason, o: StageOutcome, why: string, chargeable = false): Decision {
  return { class: to, chargeable, step: { to, needsUser: { reason, summary: `${o.stage} ${o.kind}${why}` } } };
}

function apply(u: UnitState, o: StageOutcome, rule: Rule<OutcomeStage>, why: string): Decision {
  switch (rule.do) {
    case 'go':
      return { class: rule.trigger ? 'trigger' : 'advance', chargeable: rule.chargeable, step: { to: 'stage', target: rule.to } };
    case 'bounded': {
      const taken = u.counters[ROUND_COUNTERS[rule.round]];
      if (taken < rule.max) return { class: rule.round, chargeable: rule.chargeable, step: { to: 'stage', target: rule.to } };
      return apply(u, o, rule.then, `${why} beyond ${rule.max} ${rule.round} round${rule.max === 1 ? '' : 's'}`);
    }
    case 'retry': {
      // The rule type admits `retry` only at a retry stage.
      if (u.counters.retries[o.stage as RetryStage] >= MAX_RETRIES) return halt('park', rule.reason, o, `${why} after its uncharged retry`);
      return { class: 'retry', chargeable: false, step: { to: 'stage', target: o.stage === 'build' ? build('resume') : at(o.stage) } };
    }
    case 'route-up': {
      // The rule type admits `route-up` only at a judgment stage.
      const stage = o.stage as JudgmentStage;
      if (judgmentSeat(u, stage) === 'high') return halt('park', rule.reason, o, `${why} at the high seat`);
      return { class: 'route-up', chargeable: false, step: { to: 'stage', target: at(stage) } };
    }
    case 'park':
      return halt('park', rule.reason, o, why);
    case 'stop':
      return halt('stop', rule.reason, o, why);
    case 'retire':
      return { class: 'retire', chargeable: false, step: { to: 'retire' } };
  }
}

function decide(u: UnitState, o: StageOutcome): Decision {
  const d = apply(u, o, ruleOf(o), '');
  if (d.chargeable && u.counters.chargeableFailures + 1 >= CHARGEABLE_BOUND) {
    return halt('park', 'chargeable-bound', o, `: chargeable failure ${u.counters.chargeableFailures + 1} of ${CHARGEABLE_BOUND}`, true);
  }
  return d;
}

/** The next step for a unit in state `u` (as the fold derives it) once `outcome` is recorded. Total and pure. */
export function transition(u: UnitState, outcome: StageOutcome): Next {
  const d = decide(u, outcome);
  switch (d.step.to) {
    case 'park':
      return { kind: 'park', needsUser: d.step.needsUser };
    case 'stop':
      return { kind: 'stop', needsUser: d.step.needsUser };
    case 'retire':
      return { kind: 'retire' };
    case 'stage': {
      const after = afterStageOutcome(u, { stage: outcome.stage, class: d.class, chargeable: d.chargeable });
      const t = d.step.target;
      if (t.stage === 'build') return { kind: 'stage', stage: 'build', round: t.round, seat: risk(after), counters: after.counters };
      if (isJudgment(t.stage)) return { kind: 'stage', stage: t.stage, seat: judgmentSeat(after, t.stage), counters: after.counters };
      return { kind: 'stage', stage: t.stage, seat: null, counters: after.counters };
    }
  }
}

/** The `stage-outcome` fact that records `outcome` of stage attempt `attempt`, as `transition` decides it. */
export function outcomeFact(u: UnitState, outcome: StageOutcome, attempt: number): StageOutcomeFact {
  const d = decide(u, outcome);
  return {
    kind: 'stage-outcome', unit: u.unit, stage: outcome.stage, attempt, outcome: outcome.kind, class: d.class, chargeable: d.chargeable,
  } as StageOutcomeFact;
}
