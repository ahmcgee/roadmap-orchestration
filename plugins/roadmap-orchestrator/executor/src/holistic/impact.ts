// Impact selection (DESIGN-1.0.md §2.8 "Impact mapping"; the frozen `SelectObligations` of src/holistic/types.ts;
// M3 step A1). Pure. A candidate selects:
//   - its units' declared obligations and their repairs, and the declared obligations of their dependency closure;
//   - every obligation a changed path touches: one of its contracts, its docRef's document (a rule-anchored one, M4a,
//     touches no document path), a file its witness lane
//     runs (an argv entry resolved against the lane's cwd), or a mapping pattern naming it;
//   - the future obligations its units deliver;
//   - every must-hold obligation when a changed path matches no mapping pattern;
//   - a revision publication's added, split or re-witnessed obligations (G12);
// then the split closure (H14), to a fixed point: a selected child selects its parent, a selected parent its
// children. An id the obligations file does not hold is a caller bug and throws.
import { posix } from 'node:path';
import { type ObligationId, canonicalIds } from '../core/ids.ts';
import { type RepoPath, matchesPattern } from '../core/values.ts';
import { type ArcLaneDef, type ImpactInput, type ObligationDef, type SelectObligations, obligationSource } from './types.ts';

/** Whether `path` is a file `lane` runs: one of its argv entries, resolved against its cwd. */
const runsFile = (lane: ArcLaneDef, path: RepoPath): boolean => lane.argv.some((a) => posix.normalize(posix.join(lane.cwd, a)) === path);

/** Whether `o` is anchored at the document `path` (a docRef); a rule-anchored obligation is anchored at none. */
const anchoredAt = (o: ObligationDef, path: RepoPath): boolean => {
  const src = obligationSource(o);
  return src.kind === 'doc' && src.path === path;
};

export const selectObligations: SelectObligations = (input: ImpactInput) => {
  const all = new Map<ObligationId, ObligationDef>(input.obligations.obligations.map((o) => [o.id, o]));
  const lanes = new Map(input.obligations.lanes.map((l) => [l.id, l]));
  const mapping = input.obligations.mapping.paths;
  const units = input.units.map((u) => u.unit);
  const picked = new Set<ObligationId>([
    ...input.units.flatMap((u) => [...u.declared, ...u.repairs]),
    ...input.closure,
    ...input.revised,
  ]);
  for (const id of picked) if (!all.has(id)) throw new Error(`impact: ${id} is not an obligation in force`);

  for (const path of input.changedPaths) {
    const mapped = mapping.filter((e) => matchesPattern(path, e.pattern));
    mapped.forEach((e) => e.obligations.forEach((id) => picked.add(id)));
    for (const o of all.values()) {
      const lane = o.witness === null ? undefined : lanes.get(o.witness.lane);
      if (o.contracts.includes(path) || anchoredAt(o, path) || (lane !== undefined && runsFile(lane, path))) picked.add(o.id);
      if (mapped.length === 0 && o.activation === 'must-hold') picked.add(o.id);
    }
  }
  for (const o of all.values()) if (o.activation === 'future' && o.deliveredBy.some((u) => units.includes(u))) picked.add(o.id);

  // Split closure, to a fixed point.
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...picked]) {
      const o = all.get(id)!;
      const kin = [...(o.parent === undefined ? [] : [o.parent]), ...(o.state.type === 'split' ? o.state.children : [])];
      for (const k of kin) if (!picked.has(k)) { picked.add(k); grew = true; }
    }
  }
  return canonicalIds(picked);
};
