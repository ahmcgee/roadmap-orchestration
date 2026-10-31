import { existsSync, readFileSync, lstatSync } from 'node:fs';
import type { CommandId } from '../core/ids.ts';
import { sha256 } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { CommandBody } from '../core/records.ts';
import { branchRef } from '../core/values.ts';
import { revParse } from '../git/git.ts';
import { inputShaOf } from '../git/reusekey.ts';
import { laneRevOf } from '../holistic/types.ts';
import { keepInput } from '../input/inforce.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import type { CommandContext, Effect } from './apply.ts';

/** The root attests to external evidence explicitly. No output matching or automated seal can attest. */
export function witness(ctx: CommandContext, command: CommandId, body: Extract<CommandBody, { type: 'witness' }>): Effect {
  const { obligations } = holisticInForce(ctx);
  const o = obligations?.obligations.find((o) => o.id === body.obligation);
  const lane = obligations?.lanes.find((l) => l.id === o?.witness?.lane);
  if (o === undefined || o.state.type !== 'active' || lane?.witnessClass !== 'external') return { kind: 'rejected', reason: `${body.obligation} is not an active external witness obligation` };
  const head = revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));
  let evidenceSha256 = null;
  if (body.evidenceFile !== null) {
    if (!existsSync(body.evidenceFile.path) || !lstatSync(body.evidenceFile.path).isFile()) return { kind: 'rejected', reason: 'external witness evidence is not a regular file' };
    const bytes = readFileSync(body.evidenceFile.path);
    evidenceSha256 = sha256(sha256Hex(bytes));
    if (evidenceSha256 !== body.evidenceFile.sha256) return { kind: 'rejected', reason: 'external witness evidence changed since submission' };
    keepInput(ctx.runDir, bytes, 'external-evidence');
  } else if (!/^https?:\/\//.test(body.evidence)) return { kind: 'rejected', reason: 'external witness needs a file or HTTP(S) evidence URL' };
  if (!ctx.journal.view.ciFacts().some((f) => f.kind === 'external-witness' && f.command === command)) ctx.journal.fact({
    kind: 'external-witness', command, obligation: o.id, obligationRev: o.rev, laneRev: laneRevOf(lane), head,
    inputSha: inputShaOf(ctx.repo, revParse(ctx.repo, `${head}^{tree}`), lane, systemsMapInForce(ctx.journal.view.planApplied())), result: body.result, evidence: body.evidence, evidenceSha256,
  });
  if (body.result === 'pass' && !ctx.journal.view.holistic().latched.some((l) => l.obligation === o.id) && o.activation === 'future' && o.deliveredBy.every((u) => ctx.journal.view.unit(u).status === 'retired')) {
    const unit = o.deliveredBy[0]!;
    ctx.journal.fact({ kind: 'obligation-latched', obligation: o.id, unit, treeSha: revParse(ctx.repo, `${head}^{tree}`) });
  }
  if (body.result === 'fail') for (const deliverer of o.deliveredBy) {
    let unit = deliverer;
    while (ctx.journal.view.unit(unit).supersededBy !== null) unit = ctx.journal.view.unit(unit).supersededBy!;
    if (ctx.journal.view.unit(unit).status === 'cut') continue;
    if (ctx.journal.view.ciFacts().some((f) => f.kind === 'external-reopened' && f.command === command && f.unit === unit)) continue;
    const brief = Buffer.from(`External witness ${o.id} failed. Evidence: ${body.evidence}. Reproduce and repair the delivered claim.\n`);
    keepInput(ctx.runDir, brief, 'brief.md');
    if (!ctx.journal.view.notes(unit).some((n) => n.command === command)) ctx.journal.fact({ kind: 'noted', unit, command, brief: sha256(sha256Hex(brief)) });
    if (ctx.journal.view.dispatchOf(unit) !== null) ctx.journal.fact({ kind: 'external-reopened', command, unit });
  }
  return { kind: 'applied', verified: [`external witness ${o.id}: ${body.result}; evidence ${body.evidence}${evidenceSha256 === null ? '' : ` (sha256 ${evidenceSha256})`}`] };
}
