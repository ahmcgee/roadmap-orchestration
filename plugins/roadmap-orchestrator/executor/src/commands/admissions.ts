// `close-admissions` (M3 B7; DESIGN-1.0.md §2.10 `draining`): latches `draining` with `admissions-closed{command}`.
// While draining, new P1/P2 findings raise blocking `new-finding-draining` items. Planned units run on.
// Only an architect `apply` that adds a unit reopens admissions (the fold, src/core/state.ts). A mutation with no scope.
//
// Refused while already draining. The effect checks its postcondition first, so a re-run after a crash writes nothing
// twice.
import type { CommandId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { Effect } from './apply.ts';

export function closeAdmissions(ctx: Readonly<{ journal: Journal }>, id: CommandId): Effect {
  const draining = ctx.journal.view.holistic().draining;
  if (draining !== null && draining.command !== id) return { kind: 'rejected', reason: `close-admissions: the arc is already draining (admissions closed by ${draining.command})` };
  if (draining === null) ctx.journal.fact({ kind: 'admissions-closed', command: id });
  return { kind: 'applied', verified: ['admissions closed: the arc drains (an architect apply that adds a unit reopens admissions)'] };
}
