// The stage/outcome transition table of one serial unit (plan "Pipeline for one serial unit", R3), as data,
// and `transition`, the total pure function that reads it. No I/O and no journal: the stages (step 11b)
// record each outcome as a `stage-outcome` fact (`outcomeFact`) and act on the returned `Next`. The fold
// derives a unit's counters from those facts through the same `afterStageOutcome` this module uses, so a
// decision's predicted counters are the counters the log derives.
//
// Rules the table encodes (test/transitions.test.ts pins them row by row):
// - `chargeableFailures` grows only on design-class rows (`charge`, the plan's C). Deadline, cancel and
//   process faults never charge. The third chargeable failure parks the unit, whatever its row says.
// - Bounded rounds: plan-check redirect ≤ 2, gate revise ≤ 2, red candidate ≤ 1. Within the bound the row's
//   round runs (and a C row charges); beyond it the exhausted action runs uncharged, as no round happened.
//   The redirect bound counts only the redirects since the architect's latest spec revision (a reopen,
//   `redirectsSinceEdit`): plan-check patches bump the rev too, but only a reopen resets the count.
// - One uncharged retry at plan-check, build (a resume), lanes and gate, then park. Retries are counted per
//   stage over the whole unit. A backend call lost with its runner is retried once inside its stage, as a new
//   invocation with the same deadline (dispatch.ts), before any outcome is recorded; an implementer call
//   that may have changed the tree is not retried: `lost-tree-effects` salvages and verifies its work.
// - Route up: a refusal or escalation at a judgment stage re-dispatches that stage on its role's
//   `escalation` seat, a fresh session even when that seat binds the same model (independence is a clean
//   context); at the escalation seat it parks with a needs-user. A routed-up role stays there for the unit.
// - A risk trigger (contract path touched at salvage, scope growth at the candidate) puts the next judgment
//   dispatch, and only that one, on the escalation seat. The implementer keeps the unit's risk seat throughout.
// - A routing change the unit cannot absorb (its implementer's seat moved after a build started;
//   dispatch.ts) parks it at the stage that found it: `routing-changed`, uncharged.
// - An interruption (a pause or stop cancel, or the stage's backend parked arc-wide on a usage limit) holds
//   the unit at its stage: no counter moves, and a resume re-runs the stage as a new attempt (lead ruling).
//   A held build's new attempt continues the interrupted session (the `continue` round, rounds.ts).
// - `attempts` counts stage starts, which only the fold sees; `transition` passes it through unchanged.
// - Every park row names its class (A7): `retryable` (the executor probes its targets, which the stage names,
//   and re-runs the stage once they pass), or operator `env` (`resume <unit>` re-runs it) or `design` (a spec
//   revision or a re-entry). A retry, route-up or bounded round that runs out parks with its own class; the
//   chargeable bound is always `design`. The class is written into the parking `stage-outcome` fact (`park`).
// - `prepare` (M2) is a re-entered unit's first stage; each of its outcomes enters the pipeline where the
//   prepared worktree allows.
// - M3: the bounds are the unit's (`UnitState.bounds`, from its dispatch record's `limits`; the built-in ones
//   below otherwise). `reproduce` is a vacuity repair's first stage. A candidate `preempted` by a docs publication
//   (A7) or `finding-blocked` by an active P1 (G10) goes back to the candidate stage uncharged; admission holds it
//   there while the P1 blocks it.
// - M3 step A3 (R11): a steered unit's pass (`UnitState.steering`) exits in `steerExit`, uncharged: a red series or a
//   gate revise parks `steered` instead of a fix round, and so does a green gate unless the steer said `--resume`.
//   The steer round itself is an entry outside the table (`UnitState.entry`, src/pipeline/unit.ts).
import {
  type HoldCause, type JudgmentStage, type OperatorParkKind, type OutcomeClass, type OutcomeStage, type ParkRecord, type ProbeTarget,
  type RetryStage, type StageOutcomeFact, type StageOutcomeKind, JUDGMENT_STAGES, probeTargetKey,
} from '../core/events.ts';
import { type Bounds, DEFAULT_BOUNDS, type NeedsUserReason } from '../core/records.ts';
import { type UnitCounters, type UnitState, afterStageOutcome, redirectsSinceEdit } from '../core/state.ts';
import type { JudgmentSeat, RiskTier } from '../routing/types.ts';

/** One per (stage, kind) of `STAGE_OUTCOME_KINDS`: a gate outcome for a build stage is unrepresentable. */
export type StageOutcome = { [S in OutcomeStage]: Readonly<{ stage: S; kind: StageOutcomeKind<S> }> }[OutcomeStage];

/**
 * How a decision dispatches the implementer. `fresh`: a new session. `fix`: resume with the failing evidence
 * dirs and any gate directives. `resume`: the uncharged resume after a malformed report. `resolve`: resume to
 * resolve and commit a prepared merge-in conflict. No decision asks for the fifth round, `continue`: the
 * driver runs it in place of the decided round after an interrupted build attempt (rounds.ts).
 */
export type BuildRound = 'fresh' | 'fix' | 'resume' | 'resolve';

/** Executor-only stages: no backend, so no seat. */
export type ExecutorStage = Exclude<OutcomeStage, 'build' | JudgmentStage>;

/** What the needs-user says; the stage adds id, subject, evidence and options when it raises it. */
export type NeedsUserContent = Readonly<{ reason: NeedsUserReason; summary: string }>;

/** `counters` are the unit's counters once this outcome is recorded, which the next stage starts with. */
export type Next =
  | Readonly<{ kind: 'stage'; stage: 'build'; round: BuildRound; seat: RiskTier; counters: UnitCounters }>
  | Readonly<{ kind: 'stage'; stage: JudgmentStage; seat: JudgmentSeat; counters: UnitCounters }>
  | Readonly<{ kind: 'stage'; stage: ExecutorStage; seat: null; counters: UnitCounters }>
  | Readonly<{ kind: 'park'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'stop'; needsUser: NeedsUserContent }>
  /** Interrupted: the unit waits at its stage for a resume, which starts the stage again uncharged. */
  | Readonly<{ kind: 'hold' }>
  | Readonly<{ kind: 'retire' }>;

// ---------------------------------------------------------------------------------------------------
// The table

/**
 * The built-in bounds (`DEFAULT_BOUNDS`); a unit's `limits` override them (M3). Two redirects, not one: arc 1's
 * high-risk adopted units each found real defects in a second round (arc-1 feedback item 2).
 */
export const MAX_REDIRECTS = DEFAULT_BOUNDS.redirects;
export const MAX_REVISE_ROUNDS = DEFAULT_BOUNDS.reviseRounds;
export const MAX_CANDIDATE_REDS = DEFAULT_BOUNDS.candidateReds;
export const MAX_RETRIES = DEFAULT_BOUNDS.retries;

/** Where a decision sends the unit: a build round, or another stage. Never `prepare`: only a re-entry starts there. */
export type Target = Readonly<{ stage: 'build'; round: BuildRound }> | Readonly<{ stage: Exclude<OutcomeStage, 'build' | 'prepare'> }>;

/** A park's class as the table fixes it: probed and re-run, or the architect's (`env` or `design`). */
export type ParkClass = 'retryable' | OperatorParkKind;

/** On to `to`; `chargeable` on the plan's C rows; `trigger` raises a risk trigger. */
type Go = Readonly<{ do: 'go'; to: Target; chargeable: boolean; trigger: boolean }>;
type Park = Readonly<{ do: 'park'; reason: NeedsUserReason; park: ParkClass }>;
type Stop = Readonly<{ do: 'stop'; reason: NeedsUserReason }>;
type Retire = Readonly<{ do: 'retire' }>;
type Hold = Readonly<{ do: 'hold' }>;
/** A refusal or escalation: the role's escalation seat, then park with `reason` (a design park). */
type RouteUp = Readonly<{ do: 'route-up'; reason: 'refusal' | 'escalation' }>;
/** The stage's one uncharged retry, then park with `reason` and class `park`. */
type Retry = Readonly<{ do: 'retry'; reason: NeedsUserReason; park: ParkClass }>;
type BoundedRound = 'redirect' | 'revise' | 'candidate-red';
/** A round the unit may take `bounds[bound]` times; the next one takes `then`, uncharged. */
type Bounded<S extends OutcomeStage> = Readonly<{
  do: 'bounded';
  round: BoundedRound;
  bound: keyof Pick<Bounds, 'redirects' | 'reviseRounds' | 'candidateReds'>;
  to: Target;
  chargeable: boolean;
  then: S extends JudgmentStage ? RouteUp : Park;
}>;

/** Route-ups exist only at judgment stages and retries only at retry stages, as the fact validator requires. */
type Rule<S extends OutcomeStage> =
  | Go | Park | Stop | Retire | Hold | Bounded<S> | (S extends JudgmentStage ? RouteUp : never) | (S extends RetryStage ? Retry : never);

type Table = { readonly [S in OutcomeStage]: { readonly [K in StageOutcomeKind<S>]: Rule<S> } };

const at = (stage: Exclude<OutcomeStage, 'build' | 'prepare'>): Target => ({ stage });
const build = (round: BuildRound): Target => ({ stage: 'build', round });
const go = (to: Target): Go => ({ do: 'go', to, chargeable: false, trigger: false });
const charge = (to: Target): Go => ({ do: 'go', to, chargeable: true, trigger: false });
const park = (reason: NeedsUserReason, cls: ParkClass): Park => ({ do: 'park', reason, park: cls });
const retry = (reason: NeedsUserReason, cls: ParkClass): Retry => ({ do: 'retry', reason, park: cls });
const routeUp = (reason: RouteUp['reason']): RouteUp => ({ do: 'route-up', reason });
const hold: Hold = { do: 'hold' };

/** The plan's table, one rule per (stage, outcome); the type requires every row and admits no other. */
export const TABLE: Table = {
  prepare: {
    'clean-plan-check': go(at('plan-check')),
    'clean-build': go(build('fresh')),
    // Merged cleanly and the tree already verifies the unit's work: straight to its lanes.
    'clean-verify': go(at('lanes')),
    // MERGE_HEAD kept (the M1 conflict precedent): a resolve round, in a fresh session (no session inherits).
    conflicted: go(build('resolve')),
  },
  // M3 (B3): a vacuity repair reproduces its finding's mutant before anything is graded.
  reproduce: {
    reproduced: go(at('plan-check')),
    // The finding is dismissed by code; the unit parks (the checkpoint respecs or cuts it, OR-Q1).
    'not-reproduced': park('not-reproduced', 'design'),
    // The mutant no longer applies: re-evaluated at the next audit; the unit parks meanwhile.
    inapplicable: park('not-reproduced', 'design'),
    blocked: park('lane-blocked', 'retryable'),
    interrupted: hold,
    'cleanup-failed': park('residue', 'retryable'),
  },
  'plan-check': {
    approve: go(build('fresh')),
    redirect: { do: 'bounded', round: 'redirect', bound: 'redirects', to: at('plan-check'), chargeable: false, then: routeUp('escalation') },
    infeasible: routeUp('escalation'),
    escalate: routeUp('escalation'),
    // R2: a redirect cannot lower the risk floor or widen the unit's envelope; refused → escalate.
    'risk-lowered': routeUp('escalation'),
    'scope-widened': routeUp('escalation'),
    refusal: routeUp('refusal'),
    malformed: retry('malformed', 'design'),
    'process-fault': park('process-fault', 'retryable'),
    interrupted: hold,
    'routing-changed': park('routing-changed', 'env'),
  },
  build: {
    success: go(at('quiesce')),
    refusal: park('refusal', 'design'),
    malformed: retry('malformed', 'design'),
    'process-fault': park('process-fault', 'retryable'),
    // The implementer's runner died without exit.json (lost{treeEffects}; the plan's recovery table). No
    // tree effects: the call was already retried once as a new invocation with the same deadline, and was
    // lost again. Tree effects: what the workload left is salvaged and verified like a report, uncharged.
    lost: park('build-lost', 'retryable'),
    'lost-tree-effects': go(at('quiesce')),
    // The reservation cycle's occupancy probe found unlabelled or undeclared occupancy (decided before any charge).
    occupied: park('occupancy-unlabelled', 'env'),
    // The build's resources could not be cleaned after a failed build: a residue, never released.
    'cleanup-failed': park('residue', 'retryable'),
    interrupted: hold,
    'routing-changed': park('routing-changed', 'env'),
  },
  quiesce: { empty: go(at('evidence')) },
  evidence: { captured: go(at('salvage')) },
  salvage: {
    committed: go(at('teardown')),
    'committed-contract-touched': { do: 'go', to: at('teardown'), chargeable: false, trigger: true },
    unmerged: park('salvage-failed', 'env'),
    'commit-failed': park('salvage-failed', 'retryable'),
  },
  // Failed cleanup leaves a residue and never releases its resources.
  teardown: { released: go(at('lanes')), 'cleanup-failed': park('residue', 'retryable') },
  lanes: {
    green: go(at('gate')),
    red: charge(build('fix')),
    'not-certified': charge(build('fix')),
    // A lane the runner ended (deadline) or lost: not a product verdict.
    blocked: retry('lane-blocked', 'retryable'),
    interrupted: hold,
    occupied: park('occupancy-unlabelled', 'env'),
    // A lane's resources could not be cleaned: a residue, never released.
    'cleanup-failed': park('residue', 'retryable'),
  },
  gate: {
    approve: go(at('candidate')),
    revise: { do: 'bounded', round: 'revise', bound: 'reviseRounds', to: build('fix'), chargeable: true, then: routeUp('escalation') },
    escalate: routeUp('escalation'),
    'empty-diff': park('empty-diff', 'design'),
    refusal: routeUp('refusal'),
    malformed: retry('malformed', 'design'),
    'process-fault': park('process-fault', 'retryable'),
    interrupted: hold,
    'routing-changed': park('routing-changed', 'env'),
  },
  candidate: {
    green: go(at('ff')),
    // Scope growth: a C fix round, and a risk trigger for the fresh gate that follows it.
    'transient-violation': { do: 'go', to: build('fix'), chargeable: true, trigger: true },
    // mergein.prepare, then resume "resolve and commit"; uncharged, the diff base is recomputed.
    conflict: go(build('resolve')),
    // Red with T alone green: a fix round, fresh gate, new candidate. Red again parks.
    red: { do: 'bounded', round: 'candidate-red', bound: 'candidateReds', to: build('fix'), chargeable: true, then: park('candidate-red', 'design') },
    // Red with T alone red too: the base is broken, not the unit; uncharged.
    'base-red': park('base-red', 'env'),
    // A suite lane its runner ended (deadline) or lost: no product verdict, and no retry at this stage.
    blocked: park('lane-blocked', 'retryable'),
    occupied: park('occupancy-unlabelled', 'env'),
    // A suite lane's resources could not be cleaned: a residue, never released.
    'cleanup-failed': park('residue', 'retryable'),
    interrupted: hold,
    // M3 (A7): a docs publication took the slot before green; a new candidate later, uncharged.
    preempted: go(at('candidate')),
    // M3 (G10): an active P1 blocks a selected obligation; admission holds the next candidate until it lifts.
    'finding-blocked': go(at('candidate')),
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
  | Readonly<{ to: 'park'; needsUser: NeedsUserContent; park: ParkClass }>
  | Readonly<{ to: 'stop'; needsUser: NeedsUserContent }>
  | Readonly<{ to: 'hold' | 'retire' }>;
type Decision = Readonly<{ class: OutcomeClass; chargeable: boolean; step: Step }>;

const ROUND_COUNTERS = { redirect: 'redirects', revise: 'reviseRounds', 'candidate-red': 'candidateReds' } as const satisfies {
  readonly [R in BoundedRound]: keyof UnitCounters;
};

function ruleOf(o: StageOutcome): Rule<OutcomeStage> {
  switch (o.stage) {
    case 'prepare': return TABLE.prepare[o.kind];
    case 'reproduce': return TABLE.reproduce[o.kind];
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

function risk(u: UnitState): RiskTier {
  if (u.risk === null) throw new Error(`transition: unit ${u.unit} has no dispatch record, so no risk seat`);
  return u.risk;
}

/** The seat a judgment stage is dispatched on in state `u`. */
export function judgmentSeat(u: UnitState, stage: JudgmentStage): JudgmentSeat {
  return u.routedUp.includes(stage) || u.promotion ? 'escalation' : risk(u);
}

function isJudgment(stage: OutcomeStage): stage is JudgmentStage {
  return (JUDGMENT_STAGES as readonly OutcomeStage[]).includes(stage);
}

function halt(to: 'park', reason: NeedsUserReason, o: StageOutcome, why: string, park: ParkClass, chargeable?: boolean): Decision;
function halt(to: 'stop', reason: NeedsUserReason, o: StageOutcome, why: string): Decision;
function halt(to: 'park' | 'stop', reason: NeedsUserReason, o: StageOutcome, why: string, park?: ParkClass, chargeable = false): Decision {
  const needsUser = { reason, summary: `${o.stage} ${o.kind}${why}` };
  if (to === 'stop') return { class: 'stop', chargeable, step: { to: 'stop', needsUser } };
  if (park === undefined) throw new Error(`halt: a park of ${o.stage} ${o.kind} needs its class`);
  return { class: 'park', chargeable, step: { to: 'park', needsUser, park } };
}

function apply(u: UnitState, o: StageOutcome, rule: Rule<OutcomeStage>, why: string): Decision {
  switch (rule.do) {
    case 'go':
      return { class: rule.trigger ? 'trigger' : 'advance', chargeable: rule.chargeable, step: { to: 'stage', target: rule.to } };
    case 'bounded': {
      const taken = rule.round === 'redirect' ? redirectsSinceEdit(u) : u.counters[ROUND_COUNTERS[rule.round]];
      const max = u.bounds[rule.bound];
      if (taken < max) return { class: rule.round, chargeable: rule.chargeable, step: { to: 'stage', target: rule.to } };
      return apply(u, o, rule.then, `${why} beyond ${max} ${rule.round} round${max === 1 ? '' : 's'}`);
    }
    case 'retry': {
      // The rule type admits `retry` only at a retry stage.
      if (u.counters.retries[o.stage as RetryStage] >= u.bounds.retries) return halt('park', rule.reason, o, `${why} after its uncharged retry`, rule.park);
      return { class: 'retry', chargeable: false, step: { to: 'stage', target: o.stage === 'build' ? build('resume') : at(o.stage as Exclude<RetryStage, 'build'>) } };
    }
    case 'route-up': {
      // The rule type admits `route-up` only at a judgment stage.
      const stage = o.stage as JudgmentStage;
      if (judgmentSeat(u, stage) === 'escalation') return halt('park', rule.reason, o, `${why} at the escalation seat`, 'design');
      return { class: 'route-up', chargeable: false, step: { to: 'stage', target: at(stage) } };
    }
    case 'park':
      return halt('park', rule.reason, o, why, rule.park);
    case 'stop':
      return halt('stop', rule.reason, o, why);
    case 'retire':
      return { class: 'retire', chargeable: false, step: { to: 'retire' } };
    case 'hold':
      return { class: 'hold', chargeable: false, step: { to: 'hold' } };
  }
}

/**
 * The steer pass's exits (M3 step A3, R11: one pass): while the unit is steering, a red or not-certified series and a
 * gate revise end the pass instead of a fix round, and so does a gate approve unless the steer said `--resume`; each
 * parks `steered`, uncharged, operator env (`resume <unit>` re-runs the parked stage with the pass over, so the table
 * rules again). Null for every other outcome, which the table decides as always.
 */
function steerExit(u: UnitState, o: StageOutcome): Decision | null {
  if (u.steering === null) return null;
  const ends = (o.stage === 'lanes' && (o.kind === 'red' || o.kind === 'not-certified'))
    || (o.stage === 'gate' && (o.kind === 'revise' || (o.kind === 'approve' && !u.steering.resume)));
  if (!ends) return null;
  const why = o.kind === 'approve' ? ': the steer pass is green; review it, then resume the unit or steer it again' : ': the steer pass ends here';
  return halt('park', 'steered', o, why, 'env');
}

function decide(u: UnitState, o: StageOutcome): Decision {
  const exit = steerExit(u, o);
  if (exit !== null) return exit;
  const d = apply(u, o, ruleOf(o), '');
  if (d.chargeable && u.counters.chargeableFailures + 1 >= u.bounds.chargeable) {
    return halt('park', 'chargeable-bound', o, `: chargeable failure ${u.counters.chargeableFailures + 1} of ${u.bounds.chargeable}`, 'design', true);
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
    case 'hold':
      return { kind: 'hold' };
    case 'stage': {
      const after = afterStageOutcome(u, { stage: outcome.stage, class: d.class, chargeable: d.chargeable });
      const t = d.step.target;
      if (t.stage === 'build') return { kind: 'stage', stage: 'build', round: t.round, seat: risk(after), counters: after.counters };
      if (isJudgment(t.stage)) return { kind: 'stage', stage: t.stage, seat: judgmentSeat(after, t.stage), counters: after.counters };
      return { kind: 'stage', stage: t.stage, seat: null, counters: after.counters };
    }
  }
}

/** The class of the park `transition` decides for `outcome` in state `u`, or null when it decides no park. */
export function parkClassOf(u: UnitState, outcome: StageOutcome): ParkClass | null {
  const d = decide(u, outcome);
  return d.step.to === 'park' ? d.step.park : null;
}

/**
 * What only the stage knows about its outcome. `targets`: a retryable park's probe targets (non-empty; a
 * stage that states none leaves the fact without `park`, read as the pre-M2 operator default until the
 * stages name their targets, M2 step 7a). `cause`: why a hold is not an operator pause or stop (G5).
 */
export type OutcomeContext = Readonly<{ targets?: readonly ProbeTarget[]; cause?: HoldCause }>;

/** The `stage-outcome` fact that records `outcome` of stage attempt `attempt`, as `transition` decides it. */
export function outcomeFact(u: UnitState, outcome: StageOutcome, attempt: number, context: OutcomeContext = {}): StageOutcomeFact {
  const d = decide(u, outcome);
  const parkClass = d.step.to === 'park' ? d.step.park : null;
  if (context.targets !== undefined && parkClass !== 'retryable') throw new Error(`outcomeFact: targets for ${outcome.stage} ${outcome.kind}, which decides no retryable park`);
  if (context.cause !== undefined && d.class !== 'hold') throw new Error(`outcomeFact: a hold cause for ${outcome.stage} ${outcome.kind}, which decides ${d.class}`);
  let park: ParkRecord | null = null;
  if (parkClass === 'env' || parkClass === 'design') park = { class: 'operator', kind: parkClass };
  if (parkClass === 'retryable' && context.targets !== undefined) {
    if (context.targets.length === 0) throw new Error(`outcomeFact: a retryable park of ${outcome.stage} ${outcome.kind} with no targets`);
    const targets = [...new Map(context.targets.map((t) => [probeTargetKey(t), t])).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, t]) => t);
    park = { class: 'retryable', targets };
  }
  return {
    kind: 'stage-outcome', unit: u.unit, stage: outcome.stage, attempt, outcome: outcome.kind, class: d.class, chargeable: d.chargeable,
    ...(park === null ? {} : { park }), ...(context.cause === undefined ? {} : { cause: context.cause }),
  } as StageOutcomeFact;
}

// ---------------------------------------------------------------------------------------------------
// Reading a recorded decision back (the unit driver, src/pipeline/unit.ts)

/** What a recorded outcome decided, read from the fact alone: the unit's next target, or its end. */
export type Decided =
  | Readonly<{ kind: 'stage'; target: Target }>
  | Readonly<{ kind: 'park' | 'stop'; reason: NeedsUserReason }>
  | Readonly<{ kind: 'retire' }>;

/** The halt reason of a rule that ended in park or stop (a retry or route-up past its limit, a bounded round's `then`). */
function haltReasonOf(rule: Rule<OutcomeStage>): NeedsUserReason {
  switch (rule.do) {
    case 'park':
    case 'stop':
    case 'retry':
      return rule.reason;
    case 'route-up':
      return rule.reason;
    case 'bounded':
      return haltReasonOf(rule.then);
    case 'go':
    case 'retire':
    case 'hold':
      throw new Error(`a ${rule.do} rule never halts`);
  }
}

/** Whether a parking fact is a steer pass's exit (`steerExit`): the table's rule for its outcome does not park there. */
function isSteerExit(fact: StageOutcomeFact, rule: Rule<OutcomeStage>): boolean {
  if (rule.do === 'go') return true;
  return rule.do === 'bounded' && fact.stage === 'gate' && fact.park?.class === 'operator' && fact.park.kind === 'env';
}

/**
 * The decision a recorded `stage-outcome` fact carries, from its class and the table. A pure function of
 * the fact, so a restarted driver continues exactly where the log says: the counters that chose the class
 * are no longer needed to read it. `hold` is not a decision (the held stage re-runs the one before it).
 */
export function decidedBy(fact: StageOutcomeFact): Decided {
  const rule = ruleOf({ stage: fact.stage, kind: fact.outcome } as StageOutcome);
  switch (fact.class) {
    case 'advance':
    case 'trigger':
      if (rule.do !== 'go') throw new Error(`${fact.stage} ${fact.outcome}: class ${fact.class}, but the table's rule is ${rule.do}`);
      return { kind: 'stage', target: rule.to };
    case 'redirect':
    case 'revise':
    case 'candidate-red':
      if (rule.do !== 'bounded') throw new Error(`${fact.stage} ${fact.outcome}: class ${fact.class}, but the table's rule is ${rule.do}`);
      return { kind: 'stage', target: rule.to };
    case 'retry':
      return { kind: 'stage', target: fact.stage === 'build' ? build('resume') : at(fact.stage as Exclude<OutcomeStage, 'build' | 'prepare'>) };
    case 'route-up':
      return { kind: 'stage', target: at(fact.stage as Exclude<OutcomeStage, 'build' | 'prepare'>) };
    case 'park':
    case 'stop':
      // A chargeable park is only ever the bound (decide); a steer exit is a park where the table's rule goes on (an
      // env park of a bounded revise: the table's own revise park is design); every other halt carries its rule's reason.
      if (fact.chargeable) return { kind: fact.class, reason: 'chargeable-bound' };
      if (fact.class === 'park' && isSteerExit(fact, rule)) return { kind: 'park', reason: 'steered' };
      return { kind: fact.class, reason: haltReasonOf(rule) };
    case 'retire':
      return { kind: 'retire' };
    case 'hold':
      throw new Error(`decidedBy: a hold decides nothing (${fact.unit} ${fact.stage}#${fact.attempt})`);
  }
}
