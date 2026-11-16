// Unit lineages (M2 re-entries) and, since dev.81 (A1), delivery through them.
//
// A re-entry supersedes its parent, which never publishes again, so an obligation whose `deliveredBy` names the parent is
// delivered by the lineage's head: the declared unit, or the unit that re-enters it, transitively. Obligations are kept
// by hash as declared (no record persists a resolved `deliveredBy`), so every reader resolves at read time and an
// in-flight arc adopts the rule with no migration. A cut deliverer stays itself (a `carries` successor counts for
// milestones, not for delivery). Two resolvers, one rule:
//   - `deliverers` / `delivers`, from the log (`supersededBy`): every run-time reader (latching, required witnesses,
//     impact, the external-witness latch in src/commands/witness.ts). The log is what those readers hold, and a plan can
//     list a re-entry the log has not applied yet.
//   - `planDeliverers` / `planDelivers`, from a plan's `reenters`: the checks that judge a revision before it is in force
//     (the apply's witness-item rows, Phase 0's advisories), where the re-entry may be new in that very revision.
// Phase 0 rows (src/phase0/rows.ts witness reachability, spanning proof) and the TUI's relations read `deliveredBy` as
// declared: they precede re-entries or only display it.
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { ObligationDef } from '../holistic/types.ts';
import type { PlanM1 } from './plan.ts';

/** The members of `root`'s lineage in order: `root`, then each unit that re-entered the previous one. */
export function lineageMembers(view: JournalView, root: UnitId): readonly UnitId[] {
  const out: UnitId[] = [root];
  for (let next = view.unit(root).supersededBy; next !== null; next = view.unit(next).supersededBy) {
    if (out.includes(next)) throw new Error(`the lineage of ${root} re-enters itself at ${next}`);
    out.push(next);
  }
  return out;
}

/** The lineage behind `unit`, from the log: `unit`, then each unit it re-enters, back to the lineage's first unit. */
export function lineageBack(view: JournalView, unit: UnitId): readonly UnitId[] {
  const out = [unit];
  for (let l = view.unit(unit).lineage; l !== null; l = view.unit(l.reenters).lineage) out.push(l.reenters);
  return out;
}

/**
 * dev.81 (A1): the live head of each of `o`'s declared deliverers, from the log: the declared unit, or the unit that
 * supersedes it, transitively. Declared order, each once.
 */
export function deliverers(view: JournalView, o: Pick<ObligationDef, 'deliveredBy'>): readonly UnitId[] {
  return [...new Set(o.deliveredBy.map((u) => lineageMembers(view, u).at(-1)!))];
}

/** dev.81 (A1): whether `unit` is one of `o`'s deliverers, declared or through lineage (`deliverers`). */
export const delivers = (view: JournalView, o: Pick<ObligationDef, 'deliveredBy'>, unit: UnitId): boolean => deliverers(view, o).includes(unit);

/**
 * dev.81 (A1): `deliverers` from a plan instead of the log: the head of each declared deliverer's chain of `reenters`
 * in `plan`. What a check reads that judges a plan before it is in force.
 */
export function planDeliverers(plan: Pick<PlanM1, 'units'>, o: Pick<ObligationDef, 'deliveredBy'>): readonly UnitId[] {
  // A parsed plan's `reenters` names an earlier unit (src/input/plan.ts), so each chain ends.
  const heads = o.deliveredBy.map((u) => {
    let at = u;
    for (let next = plan.units.find((x) => x.reenters?.unit === at); next !== undefined; next = plan.units.find((x) => x.reenters?.unit === at)) at = next.id;
    return at;
  });
  return [...new Set(heads)];
}

/** dev.81 (A1): whether `unit` is one of `o`'s deliverers in `plan`, declared or through lineage (`planDeliverers`). */
export const planDelivers = (plan: Pick<PlanM1, 'units'>, o: Pick<ObligationDef, 'deliveredBy'>, unit: UnitId): boolean => planDeliverers(plan, o).includes(unit);
