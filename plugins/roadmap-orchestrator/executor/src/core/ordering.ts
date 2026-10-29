// A judgment's explicit ordering wait. Prose reasons never supply dependency identity.
import { type UnitId, unitId } from './ids.ts';
import { type Read, arrayOf, assertUnique, object } from './validate.ts';

export type OrderingWait = Readonly<{ blockers: readonly UnitId[] }>;
export const orderingWait: Read<OrderingWait> = object((f) => {
  const blockers = f.get('blockers', arrayOf((v, p) => unitId(v, p), { nonEmpty: true }));
  assertUnique(blockers, (u) => u, `${f.path}.blockers`);
  return { blockers };
});
