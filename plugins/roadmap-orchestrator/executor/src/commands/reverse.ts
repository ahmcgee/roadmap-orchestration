// `roadmap reverse <D-n>` (M3, H13; DESIGN-1.0.md §2.8 "Divergences"; plan "Checkpoint and bundles", Reversal): a
// fresh compensating revision, built at request time from the divergence's preimage and committed like any revision
// (the apply core and the fence, src/commands/apply.ts). A divergence records no executable inverse.
//
//   1. The divergence: unknown → rejected. `compensation.kind` `repair-unit` (its effect is in the product tree) →
//      rejected, naming the path: a verified repair unit (§2.8). `none` → rejected: nothing to restore.
//   2. Its act: the revision its checkpoint job applied (rev P). A no-op's divergence applied none → rejected.
//   3. The touched artifacts, each resolved exactly as the preimage recorded it: the plan of its `planRev`; each
//      spec it names at its recorded spec rev (the latest spec of that unit and rev the log named before P: a machine
//      `spec.patch` advances a spec without a plan revision, so the plan manifest before P need not hold it); the
//      obligations by their recorded hash. Each is touched where P's revision holds another. A ledger or contract
//      preimage is refused: a ruling is withdrawn by superseding it and contract text is edited by a ruling's
//      contract ops (`roadmap rule`).
//   4. Conflicts: a touched artifact a later revision changed again (the one in force is not P's) → rejected with
//      every reason; the architect uses `apply`.
//   5. The proposal: the revision in force with each touched artifact restored to its preimage's content, as a fresh
//      revision of it: a dispatched unit's spec as the next rev of its recorded one; each obligation at the rev
//      the classifier asks of that edit (the one in force, plus one when its statement, docRef or activation changes
//      back), its proof judgment (which judged exactly the restored statement and witness) bound to that rev.
//      Evaluated and committed; the classifier refuses what cannot be undone (a unit the act admitted that has since
//      started, an obligation the act added, which only a ruling retires, …) with reasons.
import { canonicalJson } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import type { Event, PlanAppliedFact } from '../core/events.ts';
import { type CommandId, type DivergenceId, type Sha256Hex, type UnitId, specRev } from '../core/ids.ts';
import type { PlanManifest } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { type ObligationDef, obligationSource, parseObligations } from '../holistic/types.ts';
import {
  type InputFile, type InputFiles, OBLIGATIONS_INPUT, PLAN_INPUT, SPEC_INPUT, inForceFiles, keptInput, keptPayload, requirePlanInForce, revisionInForce,
  specBytesOf, specFilePath,
} from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { bytesSha256, parseSpec, specBytes } from '../spec/spec.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type Manifest = PlanManifest & Readonly<{ obligations: Sha256Hex | null }>;

/** The plan, specs and obligations a `plan-applied` put in force. */
function manifestOf(runDir: AbsPath, fact: PlanAppliedFact): Manifest {
  const m = keptPayload(runDir, fact.payloadSha256).manifest;
  return { planSha256: m.planSha256, specs: m.specs, obligations: m.obligations };
}

const kept = (runDir: AbsPath, sha: Sha256Hex, ext: string): Buffer => {
  const bytes = keptInput(runDir, sha, ext);
  if (bytes === null) throw new Error(`reverse: the preimage names ${ext} ${sha}, which is not kept`);
  return bytes;
};

/** Every spec hash an event names (a revision's manifest, a dispatch, a re-open, a judgment's inputs, a patch). */
function specsNamed(e: Event, intents: ReadonlyMap<string, Event>): readonly Sha256Hex[] {
  if (e.type === 'done') {
    const intent = intents.get(e.op);
    return intent?.type === 'intent' && intent.kind === 'spec.patch' ? [intent.post.newSha256] : [];
  }
  if (e.type !== 'fact') return [];
  const f = e.fact;
  switch (f.kind) {
    case 'plan-applied':
      return Object.values(f.specs);
    case 'dispatch':
      return [f.record.specSha256];
    case 'reopened':
    case 'judgment-inputs':
      return [f.specSha256];
    default:
      return [];
  }
}

/**
 * The spec of `unit` at spec rev `rev` in force before the act's revision (its `plan-applied` at `actRev`): the
 * latest spec of that unit and rev the log names before it. A preimage naming a spec the log never recorded is a bug.
 */
function specAtRev(ctx: CommandContext, events: readonly Event[], unit: UnitId, rev: number, actRev: number): Sha256Hex {
  const intents = new Map<string, Event>();
  const parsed = new Map<Sha256Hex, Readonly<{ unit: UnitId; rev: number }> | null>();
  let found: Sha256Hex | null = null;
  for (const e of events) {
    if (e.type === 'fact' && e.fact.kind === 'plan-applied' && e.fact.rev === actRev) break;
    if (e.type === 'intent') intents.set(e.op, e);
    for (const sha of specsNamed(e, intents)) {
      if (!parsed.has(sha)) {
        const bytes = keptInput(ctx.runDir, sha, SPEC_INPUT);
        const spec = bytes === null ? null : parseSpec(bytes, ctx.planFile);
        parsed.set(sha, spec === null ? null : { unit: spec.unit, rev: spec.rev });
      }
      const s = parsed.get(sha);
      if (s?.unit === unit && s.rev === rev) found = sha;
    }
  }
  if (found === null) throw new Error(`reverse: the preimage names ${unit}'s spec rev ${rev}, which the log never recorded before plan rev ${actRev}`);
  return found;
}

/** Whether two versions of an obligation differ in what its rev counts: statement, docRef or activation. */
const normative = (a: ObligationDef, b: ObligationDef): boolean =>
  a.statement !== b.statement || canonicalJson(obligationSource(a)) !== canonicalJson(obligationSource(b)) || a.activation !== b.activation;

/**
 * The obligations file restoring `pre` (the preimage's bytes) as a fresh revision of `now` (the one in force): each
 * obligation both hold takes the rev the classifier asks (`now`'s, plus one when its normative text changes back),
 * and its proof judgment, which judged exactly the restored statement and witness, is bound to that rev. Every other
 * field is the preimage's JSON as it was.
 */
function compensatingObligations(pre: Buffer, now: Buffer): Buffer {
  const before = parseObligations(JSON.parse(pre.toString('utf8')));
  const inForce = new Map(parseObligations(JSON.parse(now.toString('utf8'))).obligations.map((o) => [o.id, o]));
  const raw = JSON.parse(pre.toString('utf8')) as { obligations: Record<string, unknown>[] };
  raw.obligations = raw.obligations.map((o, i) => {
    const restored = before.obligations[i]!;
    const current = inForce.get(restored.id);
    if (current === undefined) return o;
    const rev = current.rev + (normative(restored, current) ? 1 : 0);
    const proof = o['proofJudgment'] as Record<string, unknown> | null;
    return { ...o, rev, proofJudgment: proof === null ? null : { ...proof, obligationRev: rev } };
  });
  return Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

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

  const events = readJournal(ctx.runDir, view.arc).events;
  const facts = new Map(events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [[e.fact.rev, e.fact] as const] : [])));
  const post = facts.get(decided.planRev);
  const pre = facts.get(d.preimage.planRev as PlanAppliedFact['rev']);
  if (post === undefined || pre === undefined) throw new Error(`${divergence}: plan revs ${d.preimage.planRev} and ${decided.planRev} are not both in the log`);
  const preM = manifestOf(ctx.runDir, pre);
  const postM = manifestOf(ctx.runDir, post);
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);

  // The touched artifacts as the preimage recorded them, and a later revision that changed any of them again.
  const preSpecs = new Map((Object.entries(d.preimage.specs) as [UnitId, number][]).map(([u, rev]) => [u, specAtRev(ctx, events, u, rev, decided.planRev)] as const));
  const conflicts: string[] = [];
  const later = (what: string): string => `${what} changed again after ${divergence}'s act (plan rev ${decided.planRev}); reverse it with \`roadmap apply\``;
  const planTouched = preM.planSha256 !== postM.planSha256;
  if (planTouched && inForce.manifest.planSha256 !== postM.planSha256) conflicts.push(later('the plan'));
  const specsTouched = [...preSpecs].filter(([u, sha]) => sha !== postM.specs[u]).map(([u]) => u).sort();
  for (const u of specsTouched) {
    const now = current.specs.get(u);
    if (now === undefined || now.bytes === null || bytesSha256(now.bytes) !== postM.specs[u]) conflicts.push(later(`the spec of ${u}`));
  }
  const preObligations = d.preimage.obligationsSha256;
  const obligationsTouched = preObligations !== null && preObligations !== postM.obligations;
  if (obligationsTouched && revision.manifest.obligations !== postM.obligations) conflicts.push(later('the obligations'));
  if (!planTouched && specsTouched.length === 0 && !obligationsTouched) return { kind: 'rejected', reason: `${divergence}'s act changed nothing its preimage restores` };
  if (conflicts.length > 0) return { kind: 'rejected', reason: rejectedText(conflicts, 'reverse') };

  // The compensating proposal.
  const planBytes = planTouched ? kept(ctx.runDir, preM.planSha256, PLAN_INPUT) : current.planBytes;
  const plan = planTouched ? parsePlan(JSON.parse(planBytes.toString('utf8'))) : current.plan;
  const specs = new Map<UnitId, InputFile>(plan.units.map((u) => {
    const path = specFilePath(ctx.planFile, u);
    const now = current.specs.get(u.id);
    const restore = specsTouched.includes(u.id) || now === undefined;
    if (!restore) return [u.id, now] as const;
    const sha = preSpecs.get(u.id) ?? preM.specs[u.id];
    if (sha === undefined) throw new Error(`${divergence}: the preimage plan lists ${u.id} without a spec`);
    const bytes = specBytesOf(ctx.runDir, sha);
    const recorded = view.unit(u.id).spec;
    // A dispatched unit takes the preimage's content as the next rev of its recorded spec (its pending revision).
    return [u.id, { path, bytes: recorded === null ? bytes : specBytes({ ...parseSpec(bytes, path), rev: specRev(recorded.rev + 1) }) }] as const;
  }));
  const obligations = obligationsTouched && current.obligations !== null && current.obligations.bytes !== null
    ? { path: current.obligations.path, bytes: compensatingObligations(kept(ctx.runDir, preObligations, OBLIGATIONS_INPUT), current.obligations.bytes) }
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
