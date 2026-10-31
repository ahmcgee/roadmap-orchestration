import { readFileSync } from 'node:fs';
import type { CommandId } from '../core/ids.ts';
import type { CommandBody } from '../core/records.ts';
import { keepInput } from '../input/inforce.ts';
import { BRIEF_INPUT } from '../pipeline/rounds.ts';
import { bytesSha256 } from '../spec/spec.ts';
import type { CommandContext,Effect } from './apply.ts';
export function note(ctx: CommandContext, command: CommandId, body: Extract<CommandBody, {type: 'note'}>): Effect {
  if (!ctx.plan().units.some((u) => u.id === body.unit)) return {kind: 'rejected', reason: `unknown unit ${body.unit}`};
  if (ctx.journal.view.notes(body.unit).some((n) => n.command === command)) return {kind: 'applied', verified: [`note for ${body.unit} recorded`]};
  const bytes = readFileSync(body.brief.path);
  if (bytesSha256(bytes) !== body.brief.sha256) return {kind: 'rejected', reason: `note brief ${body.brief.path} changed since hashed`};
  keepInput(ctx.runDir, bytes, BRIEF_INPUT);
  ctx.journal.fact({kind: 'noted', unit: body.unit, command, brief: body.brief.sha256});
  return {kind: 'applied', verified: [`note for ${body.unit} recorded; delivered to its next build round`]};
}
