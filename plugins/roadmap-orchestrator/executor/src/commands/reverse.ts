// `roadmap reverse <D-n>` (M3, H13; DESIGN-1.0.md §2.8 "Divergences"; plan "Checkpoint and bundles", Reversal): a
// fresh compensating revision, built at request time from the divergence's preimage and committed like any revision
// (the apply core and the fence, src/commands/apply.ts). A divergence records no executable inverse.
//
//   1. The divergence: unknown → rejected. `compensation.kind` `repair-unit` (its effect is in the product tree) →
//      rejected, naming the path: a verified repair unit (§2.8). `none` → rejected: nothing to restore.
//   2. Its act: the revision its checkpoint job applied (rev P) and the one before (the preimage's plan rev). A
//      no-op's divergence applied none → rejected.
//   3. The touched artifacts: the plan, the specs the preimage names and the obligations, each where P changed it.
//      A ledger or contract preimage is refused: a ruling is withdrawn by superseding it and contract text is edited
//      by a ruling's contract ops (`roadmap rule`).
//   4. Conflicts: a touched artifact a later revision changed again (the one in force is not P's) → rejected with
//      every reason; the architect uses `apply`.
//   5. The proposal: the revision in force with each touched artifact restored to its preimage bytes (a dispatched
//      unit's spec as the next rev of its recorded one, with the preimage's content), evaluated and committed; the
//      classifier refuses what cannot be undone (a unit the act admitted that has since started, …) with reasons.
import { canonicalJson } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import type { PlanAppliedFact } from '../core/events.ts';
import { type CommandId, type DivergenceId, type Sha256Hex, type UnitId, specRev } from '../core/ids.ts';
import type { PlanManifest } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import {
  type InputFile, type InputFiles, OBLIGATIONS_INPUT, PLAN_INPUT, inForceFiles, keptInput, keptPayload, requirePlanInForce, revisionInForce, specBytesOf,
  specFilePath,
} from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { bytesSha256, parseSpec, specBytes } from '../spec/spec.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type Manifest = PlanManifest & Readonly<{ obligations: Sha256Hex | null }>;

/** The plan, specs and obligations a `plan-applied` put in force (a dev.5 revision names no obligations). */
function manifestOf(runDir: AbsPath, fact: PlanAppliedFact): Manifest {
  if (fact.payloadSha256 === undefined) return { planSha256: fact.planSha256, specs: fact.specs, obligations: null };
  const m = keptPayload(runDir, fact.payloadSha256).manifest;
  return { planSha256: m.planSha256, specs: m.specs, obligations: m.obligations };
}

const kept = (runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer => {
  const bytes = keptInput(runDir, sha, ext);
  if (bytes === null) throw new Error(`reverse: the preimage names ${ext} ${sha}, which is not kept`);
  return bytes;
};

export async function reverse(ctx: CommandContext, id: CommandId, divergence: DivergenceId): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition.
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: ${divergence} reversed`] };
  const d = view.holistic().divergences.find((x) => x.id === divergence);
  if (d === undefined) return { kind: 'rejected', reason: `unknown divergence ${divergence}` };
  if (d.compensation.kind === 'repair-unit') {
    return { kind: 'rejected', reason: `${divergence}'s effect is in the product tree: a verified repair unit reverses it (§2.8), not \`reverse\` (${d.compensation.hint})` };
  }
  if (d.compensation.kind === 'none') return { kind: 'rejected', reason: `${divergence} records nothing to restore (${d.compensation.hint})` };
  const decided = view.holistic().checkpoints.find((c) => c.inputs.job === d.job)?.decided;
  if (decided?.kind !== 'applied') return { kind: 'rejected', reason: `${divergence}'s checkpoint ${d.job} applied no revision: nothing to restore` };
  const refused: string[] = [];
  if (d.preimage.ledgerSha256 !== null) refused.push(`${divergence} touched the rulings ledger: a ruling is withdrawn by superseding it (\`roadmap rule\`)`);
  if (d.preimage.contracts.length > 0) refused.push(`${divergence} touched contracts ${d.preimage.contracts.map((c) => c.path).join(', ')}: contract text is restored by a ruling's contract ops (\`roadmap rule\`)`);
  if (refused.length > 0) return { kind: 'rejected', reason: rejectedText(refused, 'reverse') };

  const facts = new Map(readJournal(ctx.runDir, view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [[e.fact.rev, e.fact] as const] : [])));
  const post = facts.get(decided.planRev);
  const pre = facts.get(d.preimage.planRev as PlanAppliedFact['rev']);
  if (post === undefined || pre === undefined) throw new Error(`${divergence}: plan revs ${d.preimage.planRev} and ${decided.planRev} are not both in the log`);
  const preM = manifestOf(ctx.runDir, pre);
  const postM = manifestOf(ctx.runDir, post);
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce, ctx.planFile);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile);

  // The touched artifacts, and a later revision that changed any of them again.
  const conflicts: string[] = [];
  const later = (what: string): string => `${what} changed again after ${divergence}'s act (plan rev ${decided.planRev}); reverse it with \`roadmap apply\``;
  const planTouched = preM.planSha256 !== postM.planSha256;
  if (planTouched && inForce.manifest.planSha256 !== postM.planSha256) conflicts.push(later('the plan'));
  const specsTouched = (Object.keys(d.preimage.specs) as UnitId[]).filter((u) => preM.specs[u] !== postM.specs[u]).sort();
  for (const u of specsTouched) {
    const now = current.specs.get(u);
    if (now === undefined || now.bytes === null || bytesSha256(now.bytes) !== postM.specs[u]) conflicts.push(later(`the spec of ${u}`));
  }
  const obligationsTouched = preM.obligations !== postM.obligations;
  if (obligationsTouched && revision.manifest.obligations !== postM.obligations) conflicts.push(later('the obligations'));
  if (!planTouched && specsTouched.length === 0 && !obligationsTouched) return { kind: 'rejected', reason: `${divergence}'s act changed nothing its preimage restores` };
  if (conflicts.length > 0) return { kind: 'rejected', reason: rejectedText(conflicts, 'reverse') };

  // The compensating proposal.
  const planBytes = planTouched ? kept(ctx.runDir, preM.planSha256, PLAN_INPUT) : current.planBytes;
  const plan = planTouched ? parsePlan(JSON.parse(planBytes.toString('utf8'))) : current.plan;
  const specs = new Map<UnitId, InputFile>(plan.units.map((u) => {
    const path = specFilePath(ctx.planFile, u);
    const restore = specsTouched.includes(u.id) || !current.specs.has(u.id);
    const sha = restore ? preM.specs[u.id] : undefined;
    if (!restore) return [u.id, current.specs.get(u.id)!] as const;
    if (sha === undefined) throw new Error(`${divergence}: the preimage plan lists ${u.id} without a spec`);
    const bytes = specBytesOf(ctx.runDir, sha, path).bytes;
    const recorded = view.unit(u.id).spec;
    // A dispatched unit takes the preimage's content as the next rev of its recorded spec.
    return [u.id, { path, bytes: recorded === null ? bytes : specBytes({ ...parseSpec(bytes, path), rev: specRev(recorded.rev + 1) }) }] as const;
  }));
  const obligations = obligationsTouched && current.obligations !== null && preM.obligations !== null
    ? { path: current.obligations.path, bytes: kept(ctx.runDir, preM.obligations, OBLIGATIONS_INPUT) }
    : current.obligations;
  const proposal: InputFiles = { ...current, plan, planBytes, specs, obligations };

  const evaluated = evaluateRevision(
    { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase }, proposal, { type: 'reverse' },
  );
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons, 'reverse') };
  if (evaluated.kind === 'unchanged') return { kind: 'applied', verified: [`${divergence}'s preimage is in force already (rev ${evaluated.rev})`] };
  const committed = await commitUnderFence(ctx, evaluated, { type: 'reverse' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons, 'reverse') };
  return { kind: 'applied', verified: [`plan rev ${committed.fact.rev} in force: ${divergence} reversed`, ...committed.fact.changes.map((c) => canonicalJson(c))] };
}
