// The code-applied polish revision (dev.13, plan §4 "Polish skips the checkpoint", R3 revised; SCHEMAS.md "dev.13"): a
// walk's polish proposals are full units the walkthrough authored, and code admits them as one plan revision under the
// revision fence, through THE admit path a checkpoint `admit` takes (src/holistic/bundle.ts `admitUnit` and
// `fillMappedObligations`, then the classifier, `evaluateRevision`): one admit path, two authors. No model call.
//
// Due (`polishDue`): the first walk, in log order, that ended `reported` with an applied proposal (its proposals less its
// `dropped`, the last round's) carried by no unit of the plan and not refused. Each such proposal is refused
// (`polish-refused{proposal, reasons}`, settled: never applied) when
//   - the arc is draining (admissions closed);
//   - it is not from its milestone's latest round (a later walk of the milestone ended as a round since);
//   - its scope covers none of the milestone's references (src/walk/report.ts `coversReference`);
//   - the admit path or the classifier refuses its unit admitted alone.
// The rest are admitted together: each a unit with origin `polish`, `polish{milestone, proposal}`, risk `high` (Opus
// judges design tweaks; dev.17: an efficient builder), `after: []`, the milestone's resources, the proposal's scope and spec. The whole revision refused
// (the units refused together, each accepted alone) refuses each of them with its reasons. The commit is
// `plan-applied{source: walk{job}}` with proposer `walk{job}` (src/input/classify.ts `polishRows`); a commit the arc moved
// under is retried at the next run. The rounds brake treats a refused proposal as settled (src/walk/milestones.ts).
// Crash labels: `polish.after-refused` (a refusal written, the revision not yet), `polish.after-revision`.
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { WalkFact } from '../core/events.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { UnitId } from '../core/ids.ts';
import { SchemaError } from '../core/validate.ts';
import { absPath } from '../core/values.ts';
import { type FencedCommitContext, type RevisionVerdict, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { type RawPlan, admitUnit, fillMappedObligations } from '../holistic/bundle.ts';
import { type InputFile, type InputFiles, inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { type Milestone, type PlanM1, milestoneOf, parsePlan } from '../input/plan.ts';
import type { AbsPath } from '../core/values.ts';
import { type WalkRecord, refusedProposals, walksOf } from './milestones.ts';
import { coversReference } from './report.ts';

type Proposed = Extract<WalkFact, { kind: 'polish-proposed' }>;

/** What the polish revision needs: the fenced commit's context and the repository. */
export type PolishContext = FencedCommitContext & Readonly<{ repo: AbsPath }>;

/** The walk whose applied proposals the polish revision has yet to settle, with those proposals (log order); null when none. */
export function polishDue(view: JournalView, plan: PlanM1): Readonly<{ walk: WalkRecord; proposals: readonly Proposed[] }> | null {
  const carried = new Set(plan.units.flatMap((u) => (u.polish === undefined ? [] : [u.polish.proposal])));
  const refused = refusedProposals(view);
  const proposed = view.walkFacts().flatMap((x) => (x.fact.kind === 'polish-proposed' ? [x.fact] : []));
  for (const w of walksOf(view)) {
    if (w.ended?.outcome !== 'reported') continue;
    const dropped = new Set(w.ended.dropped);
    const ids = new Set(w.ended.proposals.filter((p) => !dropped.has(p) && !carried.has(p) && !refused.has(p)));
    const proposals = proposed.filter((p) => ids.has(p.id));
    if (proposals.length > 0) return { walk: w, proposals };
  }
  return null;
}

/** Whether the polish revision has proposals to settle now (the scheduler's question). */
export const polishPending = (ctx: PolishContext): boolean => polishDue(ctx.journal.view, requirePlanInForce(ctx.runDir, ctx.journal.view).plan) !== null;

/** The revision in force with `proposals` admitted as polish units of `m`, or every reason the admit path refuses. */
function proposalFiles(ctx: PolishContext, current: InputFiles, m: Milestone, proposals: readonly Proposed[]): Readonly<{ files: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const raw = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const specs = new Map<UnitId, InputFile>(current.specs);
  const specPath = (id: UnitId): AbsPath => absPath(join(ctx.planFile, '..', `${id}.json`));
  const reasons: string[] = [];
  for (const p of proposals) {
    const admitted = admitUnit(raw, specs, {
      id: p.unit.id, risk: 'high', scope: p.unit.scope, after: [], resources: m.resources, origin: 'polish', polish: { milestone: m.id, proposal: p.id },
    }, p.unit.spec, specPath(p.unit.id), `proposal ${p.id} (unit ${p.unit.id})`);
    if ('reasons' in admitted) reasons.push(...admitted.reasons);
  }
  if (reasons.length > 0) return { reasons };
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  let plan: PlanM1;
  try {
    plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return { reasons: [`the plan with the proposals admitted does not parse: ${error.message}`] };
  }
  const inForce = requirePlanInForce(ctx.runDir, ctx.journal.view);
  fillMappedObligations(revisionInForce(ctx.runDir, inForce).obligations?.value ?? null, plan, specs, new Set(proposals.map((p) => p.unit.id)));
  return { files: { ...current, plan, planBytes, specs: new Map(plan.units.map((u) => [u.id, specs.get(u.id) ?? { path: specPath(u.id), bytes: null }] as const)) } };
}

/** `proposals` admitted and judged by the classifier: the accepted verdict, or the reasons. */
function evaluate(ctx: PolishContext, current: InputFiles, m: Milestone, job: WalkRecord['job'], proposals: readonly Proposed[]): Extract<RevisionVerdict, { kind: 'accepted' }> | Readonly<{ kind: 'rejected'; reasons: readonly string[] }> {
  const built = proposalFiles(ctx, current, m, proposals);
  if ('reasons' in built) return { kind: 'rejected', reasons: built.reasons };
  const rctx = { runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const verdict = evaluateRevision(rctx, built.files, { type: 'walk', job });
  if (verdict.kind === 'unchanged') throw new Error(`${job}: admitting ${proposals.map((p) => p.id).join(', ')} left the plan unchanged`);
  return verdict;
}

/** Why `p`, of walk `w` on `m`, is refused before its unit is admitted (see the header); empty when it is not. */
function preReasons(view: JournalView, w: WalkRecord, m: Milestone, p: Proposed): readonly string[] {
  const reasons: string[] = [];
  const draining = view.holistic().draining;
  if (draining !== null) reasons.push(`the arc is draining (admissions closed by ${draining.command}): no polish unit is admitted`);
  const latest = walksOf(view, m.id).filter((x) => x.ended !== null && x.ended.outcome !== 'abandoned').at(-1);
  if (latest !== undefined && latest.job !== w.job) reasons.push(`it is from ${w.job} (round ${w.round}); ${m.id}'s latest round is ${latest.job} (round ${latest.round})`);
  if (!coversReference(m.references, p.unit.scope)) reasons.push(`its scope (${p.unit.scope.join(', ')}) covers none of ${m.id}'s references (${m.references.join(', ')})`);
  return reasons;
}

export type PolishOutcome =
  | Readonly<{ kind: 'none' }>
  /** The due walk's proposals are settled: `admitted` in one revision (none when every one was refused), the rest refused. */
  | Readonly<{ kind: 'applied'; admitted: readonly UnitId[]; refused: readonly Proposed['id'][] }>
  /** The commit found the arc moved under it: the next run evaluates again. */
  | Readonly<{ kind: 'retry'; reasons: readonly string[] }>;

/** Settles the due walk's proposals (see the header). */
export async function applyPolish(ctx: PolishContext): Promise<PolishOutcome> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const due = polishDue(view, inForce.plan);
  if (due === null) return { kind: 'none' };
  const m = milestoneOf(inForce.plan, due.proposals[0]!.milestone);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const refused: Proposed['id'][] = [];
  const refuse = (p: Proposed, reasons: readonly string[]): void => {
    ctx.journal.fact({ kind: 'polish-refused', proposal: p.id, reasons });
    refused.push(p.id);
    crashPoint('polish.after-refused');
  };
  const alone: Proposed[] = [];
  for (const p of due.proposals) {
    const pre = preReasons(view, due.walk, m, p);
    const verdict = pre.length > 0 ? { kind: 'rejected' as const, reasons: pre } : evaluate(ctx, current, m, due.walk.job, [p]);
    if (verdict.kind === 'rejected') refuse(p, verdict.reasons);
    else alone.push(p);
  }
  if (alone.length === 0) return { kind: 'applied', admitted: [], refused };
  const together = evaluate(ctx, current, m, due.walk.job, alone);
  if (together.kind === 'rejected') {
    for (const p of alone) refuse(p, [`admitted together with ${alone.filter((x) => x !== p).map((x) => x.id).join(', ')}: ${together.reasons.join('; ')}`]);
    return { kind: 'applied', admitted: [], refused };
  }
  const out = await commitUnderFence(ctx, together, { type: 'walk', job: due.walk.job }, { type: 'walk', job: due.walk.job }, { type: 'job', job: due.walk.job });
  if (out.kind === 'rejected') return { kind: 'retry', reasons: out.reasons };
  crashPoint('polish.after-revision');
  return { kind: 'applied', admitted: alone.map((p) => p.unit.id), refused };
}
