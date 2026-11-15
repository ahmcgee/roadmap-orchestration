// `roadmap witness` (the external evidence path). dev.81 (A3): the root attests at a commit, not at the moving local
// head: `body.expectedHead` (the CLI's `--at`, default the CI ref, src/forge/ciref.ts) is accepted whenever the
// integration branch contains it, and the fact binds to that commit's tree (`inputSha`, `head`), so a verdict holds on
// every later head whose lane inputs match (src/holistic/external.ts). A pass latches a future obligation once every
// deliverer has published a merge the attested commit contains. A fail reopens each delivering lineage's head with a
// brief naming the publications since the obligation's last pass (`since`) up to the attested commit: the suspects.
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import type { CommandId, Sha, UnitId } from '../core/ids.ts';
import { sha256 } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { sha256Hex } from '../core/json.ts';
import type { CommandBody } from '../core/records.ts';
import { branchRef } from '../core/values.ts';
import { isAncestor } from '../git/ff.ts';
import { catFileType, revParse } from '../git/git.ts';
import { inputShaOf } from '../git/reusekey.ts';
import { publishedHeads } from '../holistic/coverage.ts';
import { published } from '../holistic/required.ts';
import { type ObligationDef, laneRevOf } from '../holistic/types.ts';
import { keepInput } from '../input/inforce.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import type { CommandContext, Effect } from './apply.ts';

/**
 * The deliverers of `o` the witness latches or reopens through. dev.81 WS-B: the declared ids exactly; A1 (WS-A)
 * replaces this body with `deliverers(view, o)` from src/input/lineage.ts (each declared deliverer's live lineage head).
 */
function delivering(_view: JournalView, o: ObligationDef): readonly UnitId[] {
  return o.deliveredBy;
}

/** A unit's lineage head: itself, or the unit that supersedes it, transitively (identity on a head). */
function lineageHead(view: JournalView, unit: UnitId): UnitId {
  let u = unit;
  while (view.unit(u).supersededBy !== null) u = view.unit(u).supersededBy!;
  return u;
}

/** The root attests to external evidence explicitly. No output matching or automated seal can attest. */
export function witness(ctx: CommandContext, command: CommandId, body: Extract<CommandBody, { type: 'witness' }>): Effect {
  const view = ctx.journal.view;
  const { obligations } = holisticInForce(ctx);
  const o = obligations?.obligations.find((o) => o.id === body.obligation);
  const lane = obligations?.lanes.find((l) => l.id === o?.witness?.lane);
  if (o === undefined || o.state.type !== 'active' || lane?.witnessClass !== 'external') return { kind: 'rejected', reason: `${body.obligation} is not an active external witness obligation` };
  const at = body.expectedHead;
  const recorded = view.ciFacts().find((f) => f.kind === 'external-witness' && f.command === command);
  if (recorded === undefined) {
    const integration = revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));
    if (catFileType(ctx.repo, at) !== 'commit' || !isAncestor(ctx.repo, at, integration)) {
      return { kind: 'rejected', reason: `external witness at ${at}: not a commit the integration branch contains (integration is at ${integration})` };
    }
  }
  let evidenceSha256 = recorded?.kind === 'external-witness' ? recorded.evidenceSha256 : null;
  if (recorded === undefined && body.evidenceFile !== null) {
    if (!existsSync(body.evidenceFile.path) || !lstatSync(body.evidenceFile.path).isFile()) return { kind: 'rejected', reason: 'external witness evidence is not a regular file' };
    const bytes = readFileSync(body.evidenceFile.path);
    evidenceSha256 = sha256(sha256Hex(bytes));
    if (evidenceSha256 !== body.evidenceFile.sha256) return { kind: 'rejected', reason: 'external witness evidence changed since submission' };
    keepInput(ctx.runDir, bytes, 'external-evidence');
  } else if (recorded === undefined && !/^https?:\/\//.test(body.evidence)) return { kind: 'rejected', reason: 'external witness needs a file or HTTP(S) evidence URL' };
  const tree = revParse(ctx.repo, `${at}^{tree}`);
  if (recorded === undefined) {
    const since = view.ciFacts().findLast((f) => f.kind === 'external-witness' && f.obligation === o.id && f.result === 'pass');
    ctx.journal.fact({
      kind: 'external-witness', command, obligation: o.id, obligationRev: o.rev, laneRev: laneRevOf(lane), head: at,
      inputSha: inputShaOf(ctx.repo, tree, lane, systemsMapInForce(view.planApplied())), result: body.result, evidence: body.evidence, evidenceSha256,
      since: since?.kind === 'external-witness' ? since.head : null,
    });
  }
  const fact = view.ciFacts().find((f) => f.kind === 'external-witness' && f.command === command);
  if (fact?.kind !== 'external-witness') throw new Error(`external witness ${command} has no fact`);
  if (body.result === 'pass' && o.activation === 'future' && !view.holistic().latched.some((l) => l.obligation === o.id)) {
    const unit = latchingUnit(ctx, o, at);
    if (unit !== null) ctx.journal.fact({ kind: 'obligation-latched', obligation: o.id, unit, treeSha: tree });
  }
  if (body.result === 'fail') {
    const suspects = suspectsText(ctx, fact.since ?? null, at);
    for (const deliverer of delivering(view, o)) {
      const unit = lineageHead(view, deliverer);
      if (view.unit(unit).status === 'cut') continue;
      if (view.ciFacts().some((f) => f.kind === 'external-reopened' && f.command === command && f.unit === unit)) continue;
      const brief = Buffer.from(`External witness ${o.id} failed at ${at}. Evidence: ${body.evidence}. Reproduce and repair the delivered claim.\n${suspects}`);
      keepInput(ctx.runDir, brief, 'brief.md');
      if (!view.notes(unit).some((n) => n.command === command)) ctx.journal.fact({ kind: 'noted', unit, command, brief: sha256(sha256Hex(brief)) });
      if (view.dispatchOf(unit) !== null) ctx.journal.fact({ kind: 'external-reopened', command, unit });
    }
  }
  return { kind: 'applied', verified: [`external witness ${o.id} at ${at}: ${body.result}; evidence ${body.evidence}${evidenceSha256 === null ? '' : ` (sha256 ${evidenceSha256})`}`] };
}

/**
 * The deliverer a pass at `at` latches through, or null: every deliverer retired with a published merge `at` contains;
 * the latch names the one whose merge published last (required.ts reads the latching unit's merge).
 */
function latchingUnit(ctx: CommandContext, o: ObligationDef, at: Sha): UnitId | null {
  const view = ctx.journal.view;
  const merges = published(view);
  const units = delivering(view, o);
  for (const u of units) {
    const merge = merges.get(u);
    if (view.unit(u).status !== 'retired' || merge === undefined || !isAncestor(ctx.repo, merge, at)) return null;
  }
  const order = new Map(view.publications().map((p, i) => [p.unit, i]));
  return [...units].sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1)).at(-1) ?? null;
}

/** The publications after `since` (null: the arc start) that `at` contains, one per line as `<subject> <head>`. */
function suspectsText(ctx: CommandContext, since: Sha | null, at: Sha): string {
  const view = ctx.journal.view;
  const rows = publishedHeads(view).filter((h) => isAncestor(ctx.repo, h.head, at) && (since === null || !isAncestor(ctx.repo, h.head, since))).map((h) => {
    const ff = view.latestIntent(h.op);
    const subject = h.subject === 'unit' && ff.parent.type === 'stage' ? `unit ${ff.parent.unit}` : `${h.subject} ${h.pub}`;
    return `- ${subject} ${h.head}`;
  });
  if (rows.length === 0) return '';
  return `Publications since ${since === null ? 'the arc start' : `the last pass at ${since}`} up to ${at} (the suspects):\n${rows.join('\n')}\n`;
}
