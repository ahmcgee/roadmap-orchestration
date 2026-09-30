// Readiness, admission and rank (M2 plan "Readiness", "Admission", "Priority and aging"; SCHEMAS.md M2), pure
// over the log's view and the plan in force. The scheduler asks `ready` which units to start tasks for, `admit`
// (bound to the routing in force by `admitter`) at every admission boundary of every task, and `rankOf` for the
// arbiter's waiter order.
//
// A DAG arc's unit is ready when it is active (not retired, cut, superseded, parked, held or stop-pending),
// every `after` dependency is merged (D1; the edge follows the lineage once the successor prepared, F15),
// every contingent edge is resolved, and its next stage is an admission stage that `admit` lets in. A legacy
// arc's readiness is 1.0.0-dev.4's serial frontier (`legacyNext`, G4), still subject to admission.
import { type OutcomeStage, JUDGMENT_STAGES, type JudgmentStage, type ProbeTarget } from '../core/events.ts';
import type { OpId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { NeedsUserReason } from '../core/records.ts';
import type { UnitState } from '../core/state.ts';
import { isLegacy, legacyNext } from '../core/upgrade.ts';
import type { PlanM1, PlanUnit } from '../input/plan.ts';
import { judgmentSeat, decidedBy } from '../pipeline/transitions.ts';
import type { Backend, JudgmentRole, RoutingTable } from '../routing/types.ts';
import { effectiveDependency } from './graph.ts';
import {
  ADMISSION_STAGES, type Admission, type AdmissionConstraint, type AdmissionStage, type Admit, type AdmitInput, type ChainStage, type CommandScope,
  PROMOTION_BYPASS, type Rank, compareRank,
} from './types.ts';

// ---------------------------------------------------------------------------------------------------
// The unit's next stage

export type NextStage = Readonly<{ kind: 'admission'; stage: AdmissionStage }> | Readonly<{ kind: 'chain'; stage: ChainStage }>;

const isAdmissionStage = (s: OutcomeStage): s is AdmissionStage => (ADMISSION_STAGES as readonly OutcomeStage[]).includes(s);

/**
 * The stage a unit runs next, from its latest decided outcome: plan-check before one (or after a reopen), and
 * `prepare` for a re-entry that has not prepared yet. null when the decision ends the unit's stages (a park,
 * a stop or a retire). A chain stage runs without admission (F5).
 */
export function nextStage(u: UnitState): NextStage | null {
  if (u.decided === null) return { kind: 'admission', stage: u.lineage !== null && !u.lineage.prepared ? 'prepare' : 'plan-check' };
  const d = decidedBy(u.decided);
  if (d.kind !== 'stage') return null;
  const s = d.target.stage;
  return isAdmissionStage(s) ? { kind: 'admission', stage: s } : { kind: 'chain', stage: s as ChainStage };
}

// ---------------------------------------------------------------------------------------------------
// Admission (A12, A17)

const ROLE_OF: Readonly<Record<JudgmentStage, JudgmentRole>> = { 'plan-check': 'planCheck', gate: 'gate' };

/** Open blocking items with these reasons hold every admission; so does any item whose subject is the host. */
const ADMISSION_BLOCKING: readonly NeedsUserReason[] = ['recovery-required', 'log-corrupt', 'supervisor-crash-limit'];

/**
 * The backend a stage of the unit calls under `routing`, or null for a stage that calls none. A judgment sits
 * on the seat `judgmentSeat` picks and a build on the unit's build tier; before its first dispatch a unit's
 * seat is its plan risk.
 */
function backendOf(routing: RoutingTable, u: UnitState, unit: PlanUnit, stage: AdmissionStage): Backend | null {
  if ((JUDGMENT_STAGES as readonly string[]).includes(stage)) {
    const j = stage as JudgmentStage;
    return routing[ROLE_OF[j]][judgmentSeat({ ...u, risk: u.risk ?? unit.risk }, j)].backend;
  }
  if (stage === 'build') return routing.build[u.buildTier ?? unit.risk].backend;
  return null;
}

/**
 * Whether a tripped breaker on `target` blocks `stage`: `host` blocks builds and lanes, a backend the stages
 * that call it. A resource instance's breaker blocks no admission: the arbiter sets aside the waiters of a
 * dirty instance (F8).
 */
function breakerBlocks(target: ProbeTarget, stage: AdmissionStage, backend: Backend | null): boolean {
  switch (target.type) {
    case 'host':
      return stage === 'build' || stage === 'lanes';
    case 'backend':
      return target.backend === backend;
    case 'resource':
      return false;
  }
}

const scopeCovers = (scope: CommandScope, unit: UnitId): boolean =>
  scope.type === 'arc' || (scope.type === 'units' && scope.units.includes(unit));

/**
 * `admit` under the routing in force: every constraint that holds for the unit's stage now, or admit. Pause,
 * drain and run-only hold per unit; a parked backend (any class) and a tripped breaker only for the stages
 * that need them; `base-red` for candidates; recovery-required, log-corrupt, the supervisor crash limit and
 * host items for every stage (A17).
 */
export function admitter(routing: RoutingTable): Admit {
  return ({ view, unit, stage, blocking, drains, tripped }: AdmitInput): Admission => {
    const c: AdmissionConstraint[] = [];
    const control = view.control();
    if (control.pausedAll) c.push({ type: 'paused', scope: 'arc' });
    if (control.pausedUnits.includes(unit.id)) c.push({ type: 'paused', scope: 'unit' });
    for (const d of drains) if (scopeCovers(d.scope, unit.id)) c.push({ type: 'drain', command: d.command });
    const only = view.runOnly();
    if (only !== null && !only.includes(unit.id)) c.push({ type: 'run-only' });
    const backend = backendOf(routing, view.unit(unit.id), unit, stage);
    for (const p of view.backendParks()) if (p.backend === backend) c.push({ type: 'backend-parked', backend, class: p.class });
    for (const t of tripped) if (breakerBlocks(t, stage, backend)) c.push({ type: 'breaker', target: t });
    if (stage === 'candidate' && blocking.some((b) => b.reason === 'base-red')) c.push({ type: 'base-red' });
    for (const b of blocking) if (b.subject === 'host' || ADMISSION_BLOCKING.includes(b.reason)) c.push({ type: 'blocking-item', id: b.id, reason: b.reason });
    return c.length === 0 ? { kind: 'admit' } : { kind: 'wait', constraints: c };
  };
}

// ---------------------------------------------------------------------------------------------------
// Rank (F17)

/**
 * The event seqs rank needs that `JournalView` does not carry: the stage-outcome fact of a (unit, stage,
 * attempt), a done record's, and the `plan-applied` fact that first named a unit. Each throws for a record
 * the log does not hold.
 */
export type SeqIndex = Readonly<{
  outcomeSeq(unit: UnitId, stage: OutcomeStage, attempt: number): number;
  doneSeq(op: OpId): number;
  addedSeq(unit: UnitId): number;
}>;

/** Every published `integration.ff`: its unit and the seq of its done record, in the order the ops began. */
function publications(view: JournalView, seqs: SeqIndex): readonly Readonly<{ unit: UnitId; seq: number }>[] {
  return view.opsOf('integration.ff').flatMap((i) => {
    const done = view.doneOf(i.op);
    if (done === null || done.kind !== 'integration.ff' || done.outcome.kind !== 'published') return [];
    if (i.parent.type !== 'stage') throw new Error(`integration.ff ${i.op} has a ${i.parent.type} parent, not a unit's stage`);
    return [{ unit: i.parent.unit, seq: seqs.doneSeq(i.op) }];
  });
}

/**
 * The seq of the fact that put the unit into its current wait: its decided stage-outcome; before one, the
 * latest of its addition to the plan, its dependencies' publications and its resolved contingent edges.
 */
function waitStartSeq(view: JournalView, unit: PlanUnit, seqs: SeqIndex, published: readonly Readonly<{ unit: UnitId; seq: number }>[]): number {
  const decided = view.unit(unit.id).decided;
  if (decided !== null) return seqs.outcomeSeq(unit.id, decided.stage, decided.attempt);
  let start = seqs.addedSeq(unit.id);
  const deps = new Set(unit.after.map((d) => effectiveDependency(view, d)));
  for (const p of published) if (deps.has(p.unit)) start = Math.max(start, p.seq);
  for (const e of unit.contingent) start = Math.max(start, view.edgeResolved(e.id)?.seq ?? 0);
  return start;
}

/**
 * A waiter's rank: its origin and plan index, `waitStartSeq`, and `bypassMerges`, the publications by other
 * units after it (inside its waiting interval, which ends at its grant); promoted at `PROMOTION_BYPASS`.
 */
export function rankOf(view: JournalView, plan: PlanM1, id: UnitId, seqs: SeqIndex): Rank {
  const planIndex = plan.units.findIndex((u) => u.id === id);
  if (planIndex < 0) throw new Error(`rank of unit ${id}, which the plan in force does not list`);
  const unit = plan.units[planIndex] as PlanUnit;
  const published = publications(view, seqs);
  const start = waitStartSeq(view, unit, seqs, published);
  const bypassMerges = published.filter((p) => p.unit !== id && p.seq > start).length;
  return { unit: id, origin: unit.origin ?? 'planned', waitStartSeq: start, bypassMerges, promoted: bypassMerges >= PROMOTION_BYPASS, planIndex };
}

// ---------------------------------------------------------------------------------------------------
// Readiness

/** What `ready` reads: admission's inputs for the arc, the routing in force, and the seqs rank needs. */
export type ReadyInput = Omit<AdmitInput, 'unit' | 'stage'> & Readonly<{ routing: RoutingTable; seqs: SeqIndex }>;

export type ReadyUnit = Readonly<{ unit: PlanUnit; stage: AdmissionStage; rank: Rank }>;

/** D1: every `after` dependency, followed to its lineage head once that prepared (F15), is merged; every contingent edge resolved. */
function dependenciesMet(view: JournalView, unit: PlanUnit): boolean {
  return unit.after.every((d) => view.unit(effectiveDependency(view, d)).status === 'retired')
    && unit.contingent.every((e) => view.edgeResolved(e.id) !== null);
}

/**
 * The dispatchable units in rank order, each with the admission stage it runs next. A DAG arc offers every
 * active unit whose dependencies are met; a legacy arc its serial frontier when `legacyNext` does not block
 * it. Either way the unit's next stage must be an admission stage that `admit` lets in.
 */
export function ready(input: ReadyInput): readonly ReadyUnit[] {
  const { view, plan } = input;
  const admit = admitter(input.routing);
  let candidates: readonly PlanUnit[];
  if (isLegacy(view)) {
    const f = legacyNext(view, plan.units);
    candidates = f === null || f.block !== null ? [] : plan.units.filter((u) => u.id === f.unit);
  } else {
    candidates = plan.units.filter((u) => dependenciesMet(view, u));
  }
  const out: ReadyUnit[] = [];
  for (const unit of candidates) {
    const u = view.unit(unit.id);
    if (u.status !== 'active') continue;
    const next = nextStage(u);
    if (next?.kind !== 'admission') continue;
    if (admit({ ...input, unit, stage: next.stage }).kind !== 'admit') continue;
    out.push({ unit, stage: next.stage, rank: rankOf(view, plan, unit.id, input.seqs) });
  }
  return out.sort((a, b) => compareRank(a.rank, b.rank));
}
