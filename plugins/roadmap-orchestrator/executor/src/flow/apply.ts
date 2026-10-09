// An accepted flow proposal's phases and its apply (plan "Decisions", R6, R7; SCHEMAS.md "M4b"). Derived from the log
// alone (`flowFacts`): an accepted appliable proposal moves through `pending-proof` (a suite-lane argv change, RC-4) →
// `pending-apply` → `applied`, or `refused` by its proof (`changed`, `unprovable`, or `red` twice: a first `red` is
// proved again by a fresh proof job). An accepted `host` proposal is advice, never applied.
//
// While a proposal is `pending-apply` the scheduler holds new candidate starts (`flowApplyHolds`, hold cause
// `flow-apply`). Once no candidate op is open, `applyPendingFlow` commits `flowRevision` (the fence, src/flow/levers.ts)
// as a revision with source `flow{proposal}` through the apply core and the revision fence (the bundle commit path),
// writes its plan bytes back to the live plan file (as `steer --class` does), and journals `flow-applied{proposal,
// revision, preimage}`. A classifier refusal (a suite edit while a candidate is under way, a routing-changed risk) is
// retried at the next tick, never stored; a `build-class` change waits while its tier has units whose build started.
// Crash after the commit: the revision with source `flow{proposal}` is the postcondition, and `flow-applied` follows.
import type { FlowFact, PlanAppliedFact } from '../core/events.ts';
import { type JobId, type PlanRev, type ProposalId, type UnitId, proposalJob } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import type { AbsPath } from '../core/values.ts';
import { type FencedCommitContext, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { writeBack } from '../commands/steer.ts';
import { PLAN_INPUT, inForceFiles, keptInput, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { type PlanM1, parsePlan } from '../input/plan.ts';
import { buildStarted } from '../pipeline/dispatch.ts';
import type { RiskTier } from '../routing/types.ts';
import { flowRevision, preimageOf } from './levers.ts';
import { rejectionKeyOf } from './levers.ts';
import type { FlowAction, FlowProposal, Rejection } from './types.ts';

/** What an apply touches: the commit context (log, run dir, plan file, routing base, docs publisher) and the repo. */
export type FlowApplyContext = FencedCommitContext & Readonly<{ repo: AbsPath }>;

/** Proofs a proposal gets: a first `red` is proved again; a second refuses it (unremembered). */
export const PROOF_REDS = 2;

export type FlowPhase =
  | Readonly<{ phase: 'pending-proof'; reds: number }>
  | Readonly<{ phase: 'pending-apply' }>
  | Readonly<{ phase: 'applied'; revision: PlanRev }>
  | Readonly<{ phase: 'refused'; reason: string }>
  /** An accepted `host` proposal: owner advice, never applied. */
  | Readonly<{ phase: 'advice' }>;

export type AcceptedProposal = Readonly<{ proposal: FlowProposal; phase: FlowPhase }>;

/** Whether an action is applied only after a proof: a suite-lane argv change (RC-4). */
export const needsProof = (action: FlowAction): boolean => action.lever === 'suite-lane' && action.argv !== undefined;

/** Every accepted proposal with its phase, in decision order. */
export function acceptedProposals(view: JournalView): readonly AcceptedProposal[] {
  const facts = view.flowFacts().map((x) => x.fact);
  const proposals = new Map(facts.flatMap((f) => (f.kind === 'flow-ended' && f.proposal !== null ? [[f.proposal.id, f.proposal] as const] : [])));
  return facts.flatMap((f): AcceptedProposal[] => {
    if (f.kind !== 'flow-decided' || f.decision !== 'accepted') return [];
    const proposal = proposals.get(f.proposal);
    if (proposal === undefined) throw new Error(`flow-decided of ${f.proposal}, which no flow-ended proposed`);
    return [{ proposal, phase: phaseOf(facts, proposal) }];
  });
}

function phaseOf(facts: readonly FlowFact[], proposal: FlowProposal): FlowPhase {
  if (proposal.action.lever === 'host') return { phase: 'advice' };
  const applied = facts.find((f) => f.kind === 'flow-applied' && f.proposal === proposal.id);
  if (applied !== undefined && applied.kind === 'flow-applied') return { phase: 'applied', revision: applied.revision };
  if (!needsProof(proposal.action)) return { phase: 'pending-apply' };
  const proofs = facts.flatMap((f) => (f.kind === 'flow-proof' && f.proposal === proposal.id ? [f] : []));
  const last = proofs.at(-1);
  if (last === undefined) return { phase: 'pending-proof', reds: 0 };
  switch (last.outcome) {
    case 'preserved': return { phase: 'pending-apply' };
    case 'changed': case 'unprovable': return { phase: 'refused', reason: `its proof ${last.job} was ${last.outcome}` };
    case 'red': {
      const reds = proofs.filter((p) => p.outcome === 'red').length;
      return reds >= PROOF_REDS ? { phase: 'refused', reason: `its proofs were red ${reds} times (${proofs.map((p) => p.job).join(', ')})` } : { phase: 'pending-proof', reds };
    }
  }
}

/** True while an accepted proposal is `pending-apply`: new candidate starts are held (cause `flow-apply`). */
export function flowApplyHolds(view: JournalView): boolean {
  return acceptedProposals(view).some((a) => a.phase.phase === 'pending-apply');
}

/** The proof due now: the first `pending-proof` proposal and the proof job that runs it (a crashed one's id is reused). */
export function proofDue(view: JournalView): Readonly<{ proposal: FlowProposal; job: JobId }> | null {
  const due = acceptedProposals(view).find((a) => a.phase.phase === 'pending-proof');
  return due === undefined ? null : { proposal: due.proposal, job: view.nextJobId('proof') };
}

/** Applies each `pending-apply` proposal that can be applied now; the others wait for a later tick. */
export async function applyPendingFlow(ctx: FlowApplyContext): Promise<void> {
  for (const a of acceptedProposals(ctx.journal.view)) {
    if (a.phase.phase === 'pending-apply') await applyOne(ctx, a.proposal);
  }
}

async function applyOne(ctx: FlowApplyContext, proposal: FlowProposal): Promise<void> {
  const view = ctx.journal.view;
  const committed = flowRevisionFact(ctx, proposal);
  if (committed !== null) {
    settle(ctx, proposal, committed);
    return;
  }
  if (candidateOpen(view)) return;
  const { action } = proposal;
  if (action.lever === 'build-class' && tierBuilding(view, action.tier)) return;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const next = flowRevision(inForce.plan, action);
  const proposalFiles = { ...current, plan: next, planBytes: planBytesOf(current.planBytes, action, next) };
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const evaluated = evaluateRevision(rctx, proposalFiles, { type: 'executor' });
  // A refusal (a suite edit while a candidate is under way, a moved seat) is retried at the next tick.
  if (evaluated.kind === 'rejected') return;
  if (evaluated.kind === 'unchanged') {
    // The plan in force holds the action's values already (an architect applied them since the proposal): that revision
    // is the one in force for the verdict, and the preimage is what the plan held then.
    ctx.journal.fact({ kind: 'flow-applied', proposal: proposal.id, revision: inForce.rev, preimage: preimageOf(inForce.plan, action) });
    return;
  }
  const out = await commitUnderFence(ctx, evaluated, { type: 'executor' }, { type: 'flow', proposal: proposal.id }, { type: 'job', job: proposalJob(proposal.id) });
  if (out.kind === 'rejected') return;
  settle(ctx, proposal, out.fact);
}

/** After the commit (or a crash past it): the plan file written back, then `flow-applied` with the preimage. */
function settle(ctx: FlowApplyContext, proposal: FlowProposal, fact: PlanAppliedFact): void {
  writeBack(ctx, fact);
  ctx.journal.fact({ kind: 'flow-applied', proposal: proposal.id, revision: fact.rev, preimage: preimageOf(planBefore(ctx, fact), proposal.action) });
}

/** Every `plan-applied` fact of the log, in order. */
function revisions(ctx: FlowApplyContext): readonly PlanAppliedFact[] {
  return readJournal(ctx.runDir, ctx.journal.view.arc).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' ? [e.fact] : []));
}

/** The revision with source `flow{proposal}`, or null before its commit. */
function flowRevisionFact(ctx: FlowApplyContext, proposal: FlowProposal): PlanAppliedFact | null {
  return revisions(ctx).find((f) => f.source.type === 'flow' && f.source.proposal === proposal.id) ?? null;
}

/** The plan in force before revision `fact`. */
function planBefore(ctx: FlowApplyContext, fact: PlanAppliedFact): PlanM1 {
  const all = revisions(ctx);
  const previous = all[all.findIndex((f) => f.rev === fact.rev) - 1];
  if (previous === undefined) throw new Error(`plan rev ${fact.rev} (flow) has no plan in force before it in the log`);
  const bytes = keptInput(ctx.runDir, previous.planSha256, PLAN_INPUT);
  if (bytes === null) throw new Error(`plan rev ${previous.rev} is ${previous.planSha256}, which is not kept`);
  return parsePlan(JSON.parse(bytes.toString('utf8')));
}

/** A candidate op is open (the classifier's own test for a suite edit). */
const candidateOpen = (view: JournalView): boolean =>
  view.openIntents().some((i) => i.kind === 'candidate.merge' || (i.parent.type === 'stage' && i.parent.stage === 'candidate'));

const LIVE = new Set(['active', 'held', 'park-pending', 'stop-pending']);

/** A live, unmerged unit of build tier `tier` whose build has started: a class change at that seat would move it mid-unit. */
function tierBuilding(view: JournalView, tier: RiskTier): boolean {
  const merged = new Set<UnitId>(view.publications().map((p) => p.unit));
  return view.plannedUnits().some((u) => {
    const s = view.unit(u);
    return s.buildTier === tier && LIVE.has(s.status) && !merged.has(u) && buildStarted(view, u);
  });
}

type Json = Record<string, unknown>;

/** The keyed entry of a raw plan list (a lane, resource or unit). */
function entryOf(list: unknown, key: string, value: string): Json {
  const found = Array.isArray(list) ? (list as Json[]).find((e) => e[key] === value) : undefined;
  if (found === undefined) throw new Error(`flow apply: the plan's bytes have no entry ${key} ${value}`);
  return found;
}

/**
 * The plan's own JSON with only the action's fields set, so every other byte stays as the architect wrote it; it must
 * parse to `next` (the fenced revision), else a bug.
 */
function planBytesOf(bytes: Buffer, action: FlowAction, next: PlanM1): Buffer {
  const raw = JSON.parse(bytes.toString('utf8')) as Json;
  switch (action.lever) {
    case 'concurrency':
      raw['capacity'] = { ...(raw['capacity'] as Json | undefined), cpu: action.cpu };
      break;
    case 'resource-pool': {
      const r = entryOf(raw['resources'], 'name', action.resource);
      r['pool'] = { ...(r['pool'] as Json | undefined), size: action.size };
      break;
    }
    case 'suite-lane': {
      const lane = entryOf((raw['suite'] as Json | undefined)?.['lanes'], 'id', action.lane);
      if (action.argv !== undefined) lane['argv'] = action.argv;
      if (action.cpu !== undefined) lane['cpu'] = action.cpu;
      break;
    }
    case 'sequence':
      entryOf(raw['units'], 'id', action.unit)['priority'] = action.priority;
      break;
    case 'build-class': {
      const routing = (raw['routing'] as Json | undefined) ?? {};
      raw['routing'] = { ...routing, build: { ...(routing['build'] as Json | undefined), [action.tier]: action.class } };
      break;
    }
    case 'host':
      throw new Error('flow apply: a host action is advice, never applied');
  }
  const out = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  if (canonicalJson(parsePlan(JSON.parse(out.toString('utf8')))) !== canonicalJson(next)) {
    throw new Error(`flow apply: the plan bytes edited for ${action.lever} do not parse to the fenced revision`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Decisions and the rejection memory

/** The surviving proposal `id` of a done flow run, or null (never proposed, or dropped by code's checks). */
export function proposalOf(view: JournalView, id: ProposalId): FlowProposal | null {
  for (const { fact } of view.flowFacts()) if (fact.kind === 'flow-ended' && fact.proposal?.id === id) return fact.proposal;
  return null;
}

/** The decision already recorded on `id`, or null. */
export function decisionOf(view: JournalView, id: ProposalId) {
  for (const { fact } of view.flowFacts()) if (fact.kind === 'flow-decided' && fact.proposal === id) return fact;
  return null;
}

/**
 * The rejection memory (RC-9), in log order: each rejected decision, each `worse` verdict, and each `changed` or
 * `unprovable` proof, keyed by `(station, lever, target)`, never the value. A `red` proof is not remembered.
 */
export function rejectionMemory(view: JournalView): readonly Rejection[] {
  const out: Rejection[] = [];
  const remember = (id: ProposalId, cause: Rejection['cause']): void => {
    const proposal = proposalOf(view, id);
    if (proposal === null) throw new Error(`rejection memory: ${id} was never proposed`);
    out.push({ key: rejectionKeyOf(proposal), proposal: id, cause });
  };
  for (const { fact } of view.flowFacts()) {
    if (fact.kind === 'flow-decided' && fact.decision === 'rejected') remember(fact.proposal, 'rejected');
    if (fact.kind === 'flow-verdict' && fact.verdict === 'worse') remember(fact.proposal, 'worse');
    if (fact.kind === 'flow-proof' && (fact.outcome === 'changed' || fact.outcome === 'unprovable')) remember(fact.proposal, fact.outcome);
  }
  return out;
}
