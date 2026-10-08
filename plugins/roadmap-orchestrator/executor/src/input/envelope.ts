// A lineage's scope envelope and the one rule that lets a scope leave what is fixed (M3 A3; M4a rev 3, F5).
//
//   lineageEnvelope   the union of every lineage member's dispatched scopes (each pin and re-pin), ascending: what a
//                     re-entry may claim without a ruling (the classifier's re-entry row; `prepare.pinReentry`)
//   withinEnvelope    a pattern lies within an envelope: one of its patterns, or matched by one as a path
//   rulingNaming      the ruling that backs added patterns: one the unit's spec cites, active in the ledger and as a
//                     sidecar, applying to the unit, whose statement names (in backticks) exactly the added patterns
//                     besides those already held. A dispatched unit's scope growth (classify `scopeGrowthReason`) and a
//                     re-entry widening its lineage's envelope (`unit-reentered.widened`) both use it.
import { matchesGlob } from 'node:path';
import type { RulingId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { RepoPattern } from '../core/values.ts';
import type { RulingSidecar } from '../holistic/types.ts';
import type { Ruling } from '../spec/rulings.ts';

/** The members of `root`'s lineage in order: `root`, then each unit that re-entered the previous one. */
export function lineageMembers(view: JournalView, root: UnitId): readonly UnitId[] {
  const out: UnitId[] = [root];
  for (let next = view.unit(root).supersededBy; next !== null; next = view.unit(next).supersededBy) {
    if (out.includes(next)) throw new Error(`the lineage of ${root} re-enters itself at ${next}`);
    out.push(next);
  }
  return out;
}

/** The patterns every member of `root`'s lineage was dispatched with, ascending and unique; empty when none was dispatched. */
export function lineageEnvelope(view: JournalView, root: UnitId): readonly RepoPattern[] {
  const all = lineageMembers(view, root).flatMap((u) => view.dispatchesOf(u).flatMap((d) => d.scope));
  return [...new Set(all)].sort();
}

/** Whether `pattern` lies within `envelope`: one of its patterns, or matched by one as a path. */
export const withinEnvelope = (pattern: RepoPattern, envelope: readonly RepoPattern[]): boolean =>
  envelope.some((e) => pattern === e || matchesGlob(pattern, e));

/** Backticked tokens of a ruling statement: the patterns it names. */
const namedPatterns = (statement: string): readonly string[] => [...statement.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/**
 * The ruling backing `added` (ascending) for `unit`: the first of `cites` active in `ledger` and as a sidecar, applying to
 * `unit`, whose statement names exactly `added` besides the patterns of `held`. Null when none does.
 */
export function rulingNaming(
  unit: UnitId, held: readonly RepoPattern[], added: readonly RepoPattern[], cites: readonly RulingId[], ledger: readonly Ruling[], sidecars: readonly RulingSidecar[],
): RulingId | null {
  const want = JSON.stringify([...added].sort());
  return cites.find((id) => {
    const r = ledger.find((x) => x.id === id);
    const s = sidecars.find((x) => x.id === id);
    if (r?.status !== 'active' || s === undefined || s.status !== 'active') return false;
    if (s.appliesTo.type !== 'units' || !s.appliesTo.units.includes(unit)) return false;
    return JSON.stringify([...new Set(namedPatterns(s.statement).filter((p) => !held.includes(p as RepoPattern)))].sort()) === want;
  }) ?? null;
}
