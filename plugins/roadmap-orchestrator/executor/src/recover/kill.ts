// The proc.kill reconciler (plan "Recovery", row proc.kill: re-run until empty). The postcondition is that
// no targeted member is alive and no targeted runner still runs. Already true → done{reconciled}.
// Otherwise the act runs again (a live runner is cancelled and awaited, the rest killed) → done{redone},
// returned as `redo`.
import type { Disposition, Reconciler } from '../core/interfaces.ts';
import { type ProcContext, invocationDir, liveRunner, quiesce, quiescent } from '../pipeline/invoke.ts';
import { runnerFiles } from '../runner/files.ts';

type KillDisposition = Extract<Disposition<'proc.kill'>, { kind: 'done' | 'redo' }>;

export function killReconciler(ctx: ProcContext): Reconciler<'proc.kill'> {
  return async (intent): Promise<KillDisposition> => {
    const target = intent.expect;
    // A live runner still owes the cancel this kill asked for, even while its workload happens to be empty.
    const runnerAlive = liveRunner(runnerFiles(invocationDir(ctx.runDir, target.inv), target.inv)) !== null;
    if (!runnerAlive && quiescent(ctx, target)) {
      ctx.journal.done(intent.op, 'proc.kill', { kind: 'quiesced' }, 'reconciled');
      return { kind: 'done', outcome: { kind: 'quiesced' } };
    }
    await quiesce(ctx, target);
    ctx.journal.done(intent.op, 'proc.kill', { kind: 'quiesced' }, 'redone');
    return { kind: 'redo' };
  };
}
