// `roadmap withdraw <command-id>` (dev.81, C3a): the root takes back a pending mutation, typically an `apply` queued behind a
// running stage (`queued` receipt) whose drain holds the units its scope covers. A control command: it applies at once, in the
// control step of the scheduler's loop, before that iteration starts any mutation.
//
// The effect is the target's terminal receipt, `rejected{reason: 'withdrawn by <id>'}`, written straight through
// `writeReceipt` (not `finish`, so a withdrawn queued apply raises no `apply-dropped` item: the root dropped it on purpose).
// The receipt is its own postcondition: once it exists the target is no longer pending (`pendingCommandIds`), so its drain is
// gone at the next admission. Run again after a crash past it, the effect finds its own receipt and applies.
//
// Refused: the withdraw itself; an unknown command; one already terminal (applied or rejected, by anything but this
// withdraw); a control command (it applied at once, there is nothing to take back); a mutation whose `command.apply` op has
// begun (it lands or is refused on its own: the receipt is that op's to write).
import { existsSync } from 'node:fs';
import type { CommandId } from '../core/ids.ts';
import { isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { CommandContext,Effect } from './apply.ts';
import { incomingPath,isControl,readCommand,terminalReceipt,writeReceipt } from './queue.ts';

/** The reason a withdrawn command's rejected receipt carries. */
export const withdrawnReason = (by: CommandId): string => `withdrawn by ${by}`;

export function withdraw(ctx: CommandContext, id: CommandId, target: CommandId): Effect {
  if (target === id) return { kind: 'rejected', reason: `withdraw ${id} names itself` };
  if (!existsSync(incomingPath(ctx.runDir, target))) return { kind: 'rejected', reason: `unknown command ${target}` };
  const verified = [`command ${target} withdrawn: its rejected receipt names ${id}, and its drain is released`];
  const terminal = terminalReceipt(ctx.runDir, target);
  if (terminal?.state === 'rejected' && terminal.reason === withdrawnReason(id)) return { kind: 'applied', verified };
  if (terminal !== null) return { kind: 'rejected', reason: `command ${target} is already ${terminal.state}: nothing to withdraw` };
  const { file } = readCommand(ctx.runDir, target, ctx.journal.view.arc);
  if (isControl(file.body)) return { kind: 'rejected', reason: `command ${target} is a ${file.body.type}, a control command: it applies at once, so there is nothing to withdraw` };
  const op = ctx.journal.view.opsOf('command.apply').find((i) => i.expect.command === target);
  if (op !== undefined) return { kind: 'rejected', reason: `command ${target} is applying (op ${op.op} began): it lands or is refused on its own` };
  writeReceipt(ctx.runDir, { v: SCHEMA_VERSION, command: target, state: 'rejected', at: isoTimeOf(new Date()), reason: withdrawnReason(id) });
  return { kind: 'applied', verified };
}
