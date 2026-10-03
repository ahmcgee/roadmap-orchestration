// Readiness, admission and rank (M2 plan "Readiness", "Admission", "Priority and aging"; SCHEMAS.md M2), pure
// over the log's view and the plan in force. The scheduler asks `ready` which units to start tasks for, `admit`
// (bound to the routing in force by `admitter`) at every admission boundary of every task, and `rankOf` for the
// arbiter's waiter order.
//
// A unit is ready when it is active (not retired, cut, superseded, parked, held or stop-pending), every `after`
// dependency is merged (D1; the edge follows the lineage once the successor prepared, F15), every contingent edge
// is resolved, and its next stage is an admission stage that `admit` lets in.
//
// M3 (B3): two facts about a unit come from its spec in force, which only the pipeline reads (`SpecFacts`,
// src/pipeline/reproduce.ts `specFacts`): whether it is a vacuity repair that reproduces its mutant first (its first
// stage is `reproduce`, not plan-check), and the obligations it repairs, which exempt it from an active P1's
// `finding-blocked` at candidate admission (G10). Repair units rank first (R6, `ORIGIN_RANK`).
import { type OutcomeStage, JUDGMENT_STAGES, type JudgmentStage, type ProbeTarget } from '../core/events.ts';
import type { ObligationId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type NeedsUserReason, obligationRevsOf } from '../core/records.ts';
import { ENTRY_STAGE, type UnitState } from '../core/state.ts';
import { p1Blocking } from '../holistic/findings.ts';
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
 * M3 (B3): what admission and `nextStage` read from a unit's spec in force. `reproduces`: it repairs an active vacuity
 * finding with a mutant, so it reproduces the mutant before anything is graded. `repairs`: the obligations it repairs
 * (its `I-n` repairs and its findings' obligations).
 */
export type SpecFacts = Readonly<{ reproduces: boolean; repairs: ReadonlySet<ObligationId> }>;
export type SpecFactsOf = (unit: PlanUnit) => SpecFacts;

/**
 * The stage a unit runs next, from its latest decided outcome: before one (or after a reopen) its first stage,
 * `reproduce` for a vacuity repair (`reproduces`, M3 B3), else plan-check; `prepare` for a re-entry that has not
 * prepared yet. null when the decision ends the unit's stages (a park, a stop or a retire). A chain stage runs
 * without admission (F5). M3: an entry a command set goes first (a steer's round is a build, a merge-in's lanes:
 * `ENTRY_STAGE`).
 */
export function nextStage(u: UnitState, reproduces: boolean): NextStage | null {
  if (u.entry !== null) return { kind: 'admission', stage: ENTRY_STAGE[u.entry.kind] };
  if (u.decided === null) return { kind: 'admission', stage: u.lineage !== null && !u.lineage.prepared ? 'prepare' : reproduces ? 'reproduce' : 'plan-check' };
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
 * Whether a tripped breaker on `target` blocks `stage`: `host` blocks builds and lanes (a reproduce runs a lane), a
 * backend the stages that call it. A resource instance's breaker blocks no admission: the arbiter sets aside the
 * waiters of a dirty instance (F8).
 */
function breakerBlocks(target: ProbeTarget, stage: AdmissionStage, backend: Backend | null): boolean {
  switch (target.type) {
    case 'host':
      return stage === 'build' || stage === 'lanes' || stage === 'reproduce';
    case 'backend':
      return target.backend === backend;
    case 'resource':
      return false;
  }
}

const scopeCovers = (scope: CommandScope, unit: UnitId): boolean =>
  scope.type === 'arc' || (scope.type === 'units' && scope.units.includes(unit));

/**
 * The active P1 that holds `unit`'s candidate admission (G10): over an obligation its approval selects that its spec
 * does not repair; null when none does or it has no approval.
 */
function findingBlock(view: JournalView, unit: UnitId, repairs: ReadonlySet<ObligationId>): Extract<AdmissionConstraint, { type: 'finding-blocked' }> | null {
  const approval = view.unit(unit).approval;
  if (approval === null) return null;
  const block = p1Blocking(view.holistic().findings, new Set(obligationRevsOf(approval.fingerprint).map((r) => r.id)), repairs);
  return block === null ? null : { type: 'finding-blocked', ...block };
}

/**
 * `admit` under the routing in force (each unit's, M3: its layer on the arc's stack): every constraint that holds for the unit's stage now, or admit. Pause,
 * drain and run-only hold per unit; a parked backend (any class) and a tripped breaker only for the stages
 * that need them; `base-red` and an active P1 over a selected obligation (M3, G10; `specOf` names the unit's repairs)
 * for candidates; recovery-required, log-corrupt, the supervisor crash limit and host items for every stage (A17).
 */
export function admitter(routing: (unit: UnitId) => RoutingTable, specOf: SpecFactsOf): Admit {
  return ({ view, unit, stage, blocking, drains, tripped }: AdmitInput): Admission => {
    const c: AdmissionConstraint[] = [];
    const control = view.control();
    if (control.pausedAll) c.push({ type: 'paused', scope: 'arc' });
    if (control.pausedUnits.includes(unit.id)) c.push({ type: 'paused', scope: 'unit' });
    for (const d of drains) if (scopeCovers(d.scope, unit.id)) c.push({ type: 'drain', command: d.command });
    const only = view.runOnly();
    if (only !== null && !only.includes(unit.id)) c.push({ type: 'run-only' });
    const backend = backendOf(routing(unit.id), view.unit(unit.id), unit, stage);
    for (const p of view.backendParks()) if (p.backend === backend) c.push({ type: 'backend-parked', backend, class: p.class });
    for (const t of tripped) if (breakerBlocks(t, stage, backend)) c.push({ type: 'breaker', target: t });
    if (stage === 'candidate' && blocking.some((b) => b.reason === 'base-red')) c.push({ type: 'base-red' });
    if (stage === 'candidate') {
      const block = findingBlock(view, unit.id, specOf(unit).repairs);
      if (block !== null) c.push(block);
    }
    for (const b of blocking) if (b.subject === 'host' || ADMISSION_BLOCKING.includes(b.reason)) c.push({ type: 'blocking-item', id: b.id, reason: b.reason });
    return c.length === 0 ? { kind: 'admit' } : { kind: 'wait', constraints: c };
  };
}

// ---------------------------------------------------------------------------------------------------
// Rank (F17)

/**
 * The seq of the fact that put the unit into its current wait: its decided stage-outcome; before one, the
 * latest of its addition to the plan, its dependencies' publications and its resolved contingent edges.
 */
function waitStartSeq(view: JournalView, unit: PlanUnit): number {
  const decided = view.decidedSeq(unit.id);
  if (decided !== null) return decided;
  let start = view.addedSeq(unit.id);
  if (start === null) throw new Error(`unit ${unit.id} is in the plan in force, but no plan-applied fact named it`);
  const deps = new Set(unit.after.map((d) => effectiveDependency(view, d)));
  for (const p of view.publications()) if (deps.has(p.unit)) start = Math.max(start, p.seq);
  for (const e of unit.contingent) start = Math.max(start, view.edgeResolved(e.id)?.seq ?? 0);
  return start;
}

/**
 * A waiter's rank: its origin and plan index, `waitStartSeq`, and `bypassMerges`, the publications by other
 * units after it (inside its waiting interval, which ends at its grant); promoted at `PROMOTION_BYPASS`.
 */
export function rankOf(view: JournalView, plan: PlanM1, id: UnitId): Rank {
  const planIndex = plan.units.findIndex((u) => u.id === id);
  if (planIndex < 0) throw new Error(`rank of unit ${id}, which the plan in force does not list`);
  const unit = plan.units[planIndex] as PlanUnit;
  const start = waitStartSeq(view, unit);
  const bypassMerges = view.publications().filter((p) => p.unit !== id && p.seq > start).length;
  return { unit: id, origin: unit.origin ?? 'planned', waitStartSeq: start, bypassMerges, promoted: bypassMerges >= PROMOTION_BYPASS, planIndex };
}

// ---------------------------------------------------------------------------------------------------
// Readiness

/** What `ready` reads: admission's inputs for the arc, the routing in force and each unit's spec facts. */
export type ReadyInput = Omit<AdmitInput, 'unit' | 'stage'> & Readonly<{ routing: (unit: UnitId) => RoutingTable; spec: SpecFactsOf }>;

export type ReadyUnit = Readonly<{ unit: PlanUnit; stage: AdmissionStage; rank: Rank }>;

/** D1: every `after` dependency, followed to its lineage head once that prepared (F15), is merged; every contingent edge resolved. */
function dependenciesMet(view: JournalView, unit: PlanUnit): boolean {
  return unit.after.every((d) => view.unit(effectiveDependency(view, d)).status === 'retired')
    && unit.contingent.every((e) => view.edgeResolved(e.id) !== null);
}

/**
 * The dispatchable units in rank order, each with the admission stage it runs next: every active unit whose
 * dependencies are met and whose next stage is an admission stage that `admit` lets in.
 */
export function ready(input: ReadyInput): readonly ReadyUnit[] {
  const { view, plan } = input;
  const admit = admitter(input.routing, input.spec);
  const out: ReadyUnit[] = [];
  for (const unit of plan.units.filter((u) => dependenciesMet(view, u))) {
    const u = view.unit(unit.id);
    if (u.status !== 'active') continue;
    const next = nextStage(u, input.spec(unit).reproduces);
    if (next?.kind !== 'admission') continue;
    if (admit({ ...input, unit, stage: next.stage }).kind !== 'admit') continue;
    out.push({ unit, stage: next.stage, rank: rankOf(view, plan, unit.id) });
  }
  return out.sort((a, b) => compareRank(a.rank, b.rank));
}
