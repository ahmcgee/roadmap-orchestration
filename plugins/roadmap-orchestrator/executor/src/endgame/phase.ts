// The arc's phase (dev.83; DESIGN-1.0.md §2.10): the body, while planned work or a milestone checkpoint remains, then the
// endgame, where the executor raises no new unit and the architect finishes what findings raised, by hand.
//
// - **Finding-raised** (`findingRaised`, the one predicate): a unit added after the arc's first plan revision whose origin is
//   not `planned` (repair, polish, deflake), or whose spec repairs something (non-empty `repairs`). A unit the arc started
//   with is its planned work whatever it repairs (an arc planned as repairs is no endgame at its start). The classifier
//   fixes `origin` when a unit is added, never after.
// - **Body** while a unit that is not finding-raised is neither retired, cut nor superseded, or a milestone lacks its
//   checkpoint: a walk of it ended as a round (or it is `abandoned`, src/walk/milestones.ts) and its milestone-trigger audit
//   completed. Otherwise the **endgame**. Pure over the plan in force and the log, so a revision adding a planned unit
//   returns the arc to the body with no latch. Only a holistic arc reaches the endgame: without the layer there are no
//   findings, worklist or item, and the phase stays the body (vacuous).
// - **Episodes** are journaled (`endgame-entered` … `endgame-left`, folded into `HolisticFold.endgame`); the scheduler writes
//   `entered` and `left` on the predicate's edge (src/schedule/scheduler.ts).
// - **Steps** of an episode: `settling` until it opened (no deflake mint, no polish admission, undispatched finding-raised
//   units the entry found held at admission, dispatched ones finishing, units admitted later running; then outstanding
//   walks and the final audit); `open` once the
//   endgame branch, worktree and handover exist (src/endgame/open.ts) while the required worklist is non-empty or the
//   endgame branch holds work the integration head does not (its tip is no ancestor of the head: unlanded); `closing`
//   once neither holds (the executor's own later publications, a close-out say, leave it closing).
// - **Running** (`runningUnits`): an active, dispatched unit whose non-merged dependencies are all running. One waiting on
//   a held or parked unit is not running: settling does not wait for it.
import type { MilestoneId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { RepairRef } from '../core/records.ts';
import type { EndgameEpisode, HolisticFold } from '../core/state.ts';
import { type Milestone, type PlanM1, type PlanUnit, milestonesOf } from '../input/plan.ts';
import { effectiveDependency } from '../schedule/graph.ts';
import { milestoneProgress, walksOf } from '../walk/milestones.ts';

/** What a unit's spec in force repairs (src/core/records.ts `specRepairs`); read only for units the predicate needs. */
export type RepairsOf = (unit: PlanUnit) => readonly RepairRef[];

/**
 * A unit findings raised: added after the arc's first plan revision, with an origin other than `planned` or a spec with
 * non-empty `repairs`. A unit the arc started with is its planned work, whatever it repairs.
 */
export function findingRaised(view: JournalView, unit: PlanUnit, repairs: readonly RepairRef[]): boolean {
  if ((unit.origin ?? 'planned') === 'planned' && repairs.length === 0) return false;
  const added = view.addedSeq(unit.id);
  if (added === null) throw new Error(`unit ${unit.id} is in the plan in force, but no plan-applied fact named it`);
  return view.planAppliedAt(added + 1)?.rev !== 1;
}

export type Phase =
  | Readonly<{ kind: 'body'; planned: readonly UnitId[]; milestones: readonly MilestoneId[] }>
  | Readonly<{ kind: 'endgame'; step: EndgameStep; episode: number }>;
export type EndgameStep = 'settling' | 'open' | 'closing';

/** The phase's kind, without the endgame's step (which reads the worklist and git: src/endgame/open.ts `phaseNow`). */
export type PhaseKind = Extract<Phase, { kind: 'body' }> | Readonly<{ kind: 'endgame' }>;

const TERMINAL: readonly string[] = ['retired', 'cut', 'superseded'];

/** The milestones a completed audit was triggered for (their milestone-trigger audit). */
export function auditedMilestones(fold: HolisticFold): ReadonlySet<MilestoneId> {
  return new Set(fold.audits.filter((a) => a.ended?.outcome === 'completed').flatMap((a) => a.started.triggers.flatMap((t) => (t.type === 'milestone' ? [t.milestone] : []))));
}

/** Whether milestone `m` had its checkpoint: a walk of it ended as a round, or it is abandoned, and its audit completed. */
function checkpointed(view: JournalView, plan: PlanM1, m: Milestone, audited: ReadonlySet<MilestoneId>): boolean {
  if (!audited.has(m.id)) return false;
  if (walksOf(view, m.id).some((w) => w.ended !== null && w.ended.outcome !== 'abandoned')) return true;
  // With no round ended, a milestone's progress reads no repairing units.
  return milestoneProgress(view, plan, m, []).kind === 'abandoned';
}

/** The phase's kind now (see the header). */
export function phaseKind(view: JournalView, plan: PlanM1, repairsOf: RepairsOf): PhaseKind {
  const planned = plan.units.filter((u) => !TERMINAL.includes(view.unit(u.id).status) && !findingRaised(view, u, repairsOf(u))).map((u) => u.id);
  const audited = auditedMilestones(view.holistic());
  const milestones = milestonesOf(plan).filter((m) => !checkpointed(view, plan, m, audited)).map((m) => m.id);
  const holistic = view.holistic().on && plan.holistic !== undefined;
  return holistic && planned.length === 0 && milestones.length === 0 ? { kind: 'endgame' } : { kind: 'body', planned, milestones };
}

/** The open episode (entered, not left), or null. */
export function openEpisode(view: JournalView): EndgameEpisode | null {
  const last = view.holistic().endgame.at(-1);
  return last !== undefined && last.left === null ? last : null;
}

/**
 * The units the endgame holds at admission: in the endgame, each active finding-raised unit with no dispatch record that
 * was in the plan when the episode entered (it goes to the worklist; `resume <unit>` sends one back in: its
 * `endgame-released` in the open episode drops the hold). A unit added in the episode (an architect's or a checkpoint's
 * admit) is the way back into the pipeline and runs. Empty in the body.
 */
export function endgameHeld(view: JournalView, plan: PlanM1, repairsOf: RepairsOf): ReadonlySet<UnitId> {
  if (phaseKind(view, plan, repairsOf).kind !== 'endgame') return new Set();
  // Before the scheduler writes the episode's entry, every unit is one the entry will find.
  const open = openEpisode(view);
  const entered = open?.seq ?? Number.POSITIVE_INFINITY;
  const released = new Set(open?.released.map((r) => r.unit) ?? []);
  const addedBefore = (u: PlanUnit): boolean => {
    const added = view.addedSeq(u.id);
    if (added === null) throw new Error(`unit ${u.id} is in the plan in force, but no plan-applied fact named it`);
    return added <= entered;
  };
  return new Set(plan.units.filter((u) => view.unit(u.id).status === 'active' && view.dispatchOf(u.id) === null && !released.has(u.id) && addedBefore(u) && findingRaised(view, u, repairsOf(u))).map((u) => u.id));
}

/** The running units (see the header), in plan order. */
export function runningUnits(view: JournalView, plan: PlanM1): readonly UnitId[] {
  const byId = new Map(plan.units.map((u) => [u.id, u] as const));
  const memo = new Map<UnitId, boolean>();
  const running = (id: UnitId): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const unit = byId.get(id);
    const out = unit !== undefined && view.unit(id).status === 'active' && view.dispatchOf(id) !== null && unit.after.every((d) => {
      const e = effectiveDependency(view, d);
      return view.unit(e).status === 'retired' || running(e);
    });
    memo.set(id, out);
    return out;
  };
  return plan.units.map((u) => u.id).filter(running);
}

/** An opened episode's step: `closing` once its required worklist is empty and the endgame branch is `landed` (its tip an ancestor of the integration head). */
export function stepOf(episode: EndgameEpisode | null, required: number, landed: boolean): EndgameStep {
  if (episode === null || episode.opened === null) return 'settling';
  return required === 0 && landed ? 'closing' : 'open';
}
