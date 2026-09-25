// The proc.spawn reconciler (plan "Recovery", row proc.spawn). It reattaches to the invocation and closes
// the intent itself; the disposition it returns reports what it found:
//
//   adopt → the runner was alive, was waited for, and its result is done{recoveredBy: adopted};
//   done  → the runner was gone and result.json was certified (reconciled) or re-derived by the adapter
//           from exit.json (redone), after any live member was killed;
//   lost  → no exit.json: done{lost{treeEffects}, recoveredBy: reconciled}, usage unavailable{no-result}.
//
// A lost op is retried by its caller (the unit driver) as the next ordinal, which inherits the deadline.
// Recovery must reconcile open proc.kill intents before proc.spawn ones: a spawn's own recovery kill
// would otherwise collide with a kill of the same key still open from before the crash.
import type { Disposition, Reconciler } from '../core/interfaces.ts';
import type { ProcContext } from '../pipeline/invoke.ts';
import { reattach } from '../runner/reattach.ts';

type SpawnDisposition = Extract<Disposition<'proc.spawn'>, { kind: 'done' | 'adopt' | 'lost' }>;

export function spawnReconciler(ctx: ProcContext): Reconciler<'proc.spawn'> {
  return async (intent): Promise<SpawnDisposition> => {
    const { how, settled } = await reattach(ctx, intent);
    const { outcome } = settled;
    if (outcome.kind === 'lost') return { kind: 'lost', treeEffects: outcome.treeEffects };
    if (how === 'adopted') return { kind: 'adopt' };
    const done = ctx.journal.view.doneOf(intent.op);
    if (done === null || done.kind !== 'proc.spawn') throw new Error(`${intent.op} was settled but has no proc.spawn done`);
    return { kind: 'done', outcome: done.outcome };
  };
}
