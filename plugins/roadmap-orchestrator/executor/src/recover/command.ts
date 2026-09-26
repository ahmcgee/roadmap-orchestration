// Recovery of an open `command.apply` (plan "Recovery", row command.apply): an `applied` receipt naming the
// op, or a `rejected` one, decides alone; otherwise the command's own open invocations (a sweep's teardown)
// are settled, the remainder of its effect is applied once (every effect checks its postcondition before
// acting) and the receipt is written. The recovery engine records the done (recoveredBy: reconciled).
//
// A sweep crashed between reserve and release leaves its resource reserved or cleaning under its holder:
// the remainder re-drives it (commands/apply.ts, sweep step 1) before sweeping what is still undisposed.
import { type CommandContext, finish, parentOf } from '../commands/apply.ts';
import { readCommand } from '../commands/queue.ts';
import type { Reconciler } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { spawnReconciler } from './spawn.ts';

export function commandReconciler(ctx: CommandContext): Reconciler<'command.apply'> {
  return async (intent) => {
    const { file, sha256 } = readCommand(ctx.runDir, intent.expect.command, ctx.journal.view.arc);
    if (sha256 !== intent.expect.commandSha256) throw new Error(`command ${file.id} hashes to ${sha256}, not the ${intent.expect.commandSha256} its op recorded`);
    const spawn = spawnReconciler(ctx);
    const parent = canonicalJson(parentOf(file.id));
    for (const open of ctx.journal.view.openIntents()) {
      if (open.kind === 'proc.spawn' && canonicalJson(open.parent) === parent) await spawn(open, ctx.journal.view);
    }
    return { kind: 'done', outcome: await finish(ctx, intent, file) };
  };
}
