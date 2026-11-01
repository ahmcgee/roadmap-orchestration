// Root-only finding dismissal. The fact is the effect and its replay marker; closure follows in finish().
import type { CommandId } from '../core/ids.ts';
import type { CommandBody } from '../core/records.ts';
import { crashPoint } from '../core/crash.ts';
import { isActive } from '../holistic/findings.ts';
import type { CommandContext, Effect } from './apply.ts';

export function dismiss(ctx: CommandContext, command: CommandId, body: Extract<CommandBody, {type: 'dismiss'}>): Effect {
  if (body.counterEvidence.trim() === '') return {kind: 'rejected', reason: 'dismiss requires non-empty counter-evidence'};
  const finding = ctx.journal.view.holistic().findings.find((f) => f.id === body.finding);
  if (finding === undefined) return {kind: 'rejected', reason: `unknown finding ${body.finding}`};
  if (finding.last?.state === 'ruled' && finding.last.by.type === 'root' && finding.last.by.command === command) return {kind: 'applied', verified: [`finding ${body.finding} dismissed with counter-evidence`]};
  if (!isActive(finding)) return {kind: 'rejected', reason: `finding ${body.finding} is ${finding.state}`};
  ctx.journal.fact({kind: 'finding-dismissed', id: body.finding, command, counterEvidence: body.counterEvidence, by: {role: 'root', routingRev: ctx.routing(null).resolved.rev}});
  crashPoint('dismiss.after-fact');
  return {kind: 'applied', verified: [`finding ${body.finding} dismissed with counter-evidence`]};
}
