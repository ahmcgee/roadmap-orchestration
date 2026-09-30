// Recovery of the reservation cycle (plan "Recovery", row resource.transition), per state:
//
//   an open transition   → its act is only the record (and, for `fail`, the residues), so it is closed:
//                          `fail` appends any missing residue first (step 7's reconcileFailedCleanup);
//                          every other edge is done as it stands. recoveredBy: reconciled.
//   reserved | running   → the holder is dead (recovery runs before this executor reserves anything):
//                          settle its invocations (3c's spawn reconciler: adopt a live runner and wait,
//                          or kill orphans and classify lost), so its workload is quiescent → cleaning.
//   cleaning             → settle any teardown invocation still open, then rerun every teardown as a new
//                          op (a fresh deadline: a retried ordinal would inherit a deadline that may have
//                          passed while the executor was down) → release, or fail with residues first.
//   cleanup-failed       → never released by recovery; a `sweep` command (commands/apply.ts) or the probe of
//                          its residue (`retryReclaim`, whether or not a park names it) reclaims it.
//
// Per holder (M2):
//   stage        as above. Recipes are bound to the holder's whole set (F7), exactly as the live cycle bound
//                them, so a residue recovery appends equals the one the live path would have.
//   publication  keeps integration-slot while the unit's decided next stage is `ff` or `snapshot` (a green
//                candidate's mandatory chain, A2); otherwise the candidate is abandoned: its invocations are
//                settled and the slot is cleaned and released.
//   retry        found cleaning: the reclaim order resumes (`retryReclaim`: the recorded teardown again, the
//                `cleaned` disposition unless recorded, then release). A failed teardown leaves it cleaning for
//                the instance's next probe.
//   sweep        re-driven by its command's reconciliation (command.apply, step 13), which knows the residues
//                it sweeps; here only its open transition is closed.
// Per holder (M3):
//   job          (G4) the job is dead (recovery runs before anything is dispatched): like a stage, with its
//                invocations the open spawns parented by `job{job}`, its recipes bound under the job's owner
//                label (`holderRecipes`), and a failed teardown recorded as job-owned residues. A job holder
//                also reclaims its own residue (`retryReclaim`), so an instance it holds cleaning is one of two
//                things, told apart by the fold: with an own-arc residue on the instance (`JournalView.residues()`,
//                which only a release ends) it is a reclaim in progress (a `reclaim` edge took it from
//                cleanup-failed; a live run's clean cannot follow a fail without a release between) and resumes
//                the reclaim order like a retry; without one it is a live run's clean, rerun as a stage's.
//   docs         (A4) a docs publication's slot (src/pipeline/publish.ts `recoverDocs`): its docs `ff` published (and
//                its revision activated by the revision phase before this one) → what is missing of its
//                docs-covered, snapshot and release; otherwise its checkout is removed and the slot released (its
//                revision was aborted, and its source re-evaluates).
//   batch        not yet (step B2).
import type { Holder, IntentOf, Parent } from '../core/events.ts';
import { type ResourceInstance, type ResourceUnit, compareResourceUnits } from '../core/ids.ts';
import type { Disposition, Reconciler } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { instanceEnv } from '../resources/pool.ts';
import {
  type HeldState, type JobHolder, type PublicationHolder, type ReclaimHolder, type Reservation, type ResourceContext, type StageHolder,
  finishCleanup, holderRecipes, holderUnits, resourceTable, retryReclaim, sameHolder, transition,
} from '../resources/reserve.ts';
import { PUBLICATION_CHAIN } from '../schedule/types.ts';
import { reconcileFailedCleanup } from './residue.ts';
import { spawnReconciler } from './spawn.ts';
import { recoverDocs } from '../pipeline/publish.ts';

type ResourceDisposition = Extract<Disposition<'resource.transition'>, { kind: 'done' }>;
type SweepHolderShape = Readonly<{ type: 'sweep' }>;

/** Transitions made by recovery belong to no live stage. */
const RECOVERY: Parent = { type: 'arc' };

/** Closes an open transition, then drives its holder's reservations per the table above. */
export function resourceReconciler(ctx: ResourceContext): Reconciler<'resource.transition'> {
  return async (intent): Promise<ResourceDisposition> => {
    const disposition = close(ctx, intent);
    const { holder } = intent.expect;
    if (holder.type !== 'sweep') await settleHolder(ctx, holder);
    return disposition;
  };
}

function close(ctx: ResourceContext, intent: IntentOf<'resource.transition'>): ResourceDisposition {
  const { holder, resources, edge } = intent.expect;
  let disposition: ResourceDisposition = { kind: 'done', outcome: { kind: 'transitioned' } };
  if (edge.type === 'fail') {
    if (holder.type !== 'stage' && holder.type !== 'job') throw new Error(`${intent.op}: a fail transition held by ${canonicalJson(holder)}`);
    const bound = instanceEnv(holderUnits(ctx.journal.view, holder));
    disposition = reconcileFailedCleanup(ctx.hostDir, intent, holderRecipes(ctx.plan(), ctx.repo, holder, resources, bound));
  }
  ctx.journal.done(intent.op, 'resource.transition', disposition.outcome, 'reconciled');
  return disposition;
}

/**
 * The resources-phase entry for the recovery engine (step 14b): every open transition through the
 * reconciler, then every stage, publication, retry and job holder that still holds anything. Afterwards each unit
 * a stage or job held is free or cleanup-failed; a publication holds the slot only before its `ff` or `snapshot`; a
 * retry, or a job reclaiming its own residue, holds only an instance whose teardown failed again.
 */
export async function recoverReservations(ctx: ResourceContext): Promise<void> {
  const reconcile = resourceReconciler(ctx);
  for (const intent of ctx.journal.view.openIntents()) {
    if (intent.kind === 'resource.transition') await reconcile(intent, ctx.journal.view);
  }
  const holders: Exclude<Holder, SweepHolderShape>[] = [];
  for (const entry of resourceTable(ctx.journal.view).values()) {
    const { status } = entry;
    if (status.state === 'free' || status.state === 'cleanup-failed' || status.holder.type === 'sweep') continue;
    const holder = status.holder;
    if (!holders.some((h) => sameHolder(h, holder))) holders.push(holder);
  }
  for (const holder of holders) await settleHolder(ctx, holder);
}

/** The holder's units per held state, each in lock order (cleanup-failed ones are not held here). */
function heldBy(ctx: ResourceContext, holder: Holder): ReadonlyMap<HeldState, readonly ResourceUnit[]> {
  const held = new Map<HeldState, ResourceUnit[]>();
  for (const [unit, { status }] of resourceTable(ctx.journal.view)) {
    if (status.state === 'free' || status.state === 'cleanup-failed' || !sameHolder(status.holder, holder)) continue;
    held.set(status.state, [...(held.get(status.state) ?? []), unit]);
  }
  // The table is in first-transition order; a transition names its units in lock order.
  for (const units of held.values()) units.sort(compareResourceUnits);
  return held;
}

async function settleHolder(ctx: ResourceContext, holder: Exclude<Holder, SweepHolderShape>): Promise<void> {
  switch (holder.type) {
    case 'stage':
      return settleStage(ctx, holder, { type: 'stage', unit: holder.unit, stage: holder.stage, attempt: holder.attempt });
    case 'publication':
      if (publicationContinues(ctx, holder)) return;
      return settleStage(ctx, holder, { type: 'stage', unit: holder.unit, stage: 'candidate', attempt: holder.attempt });
    case 'retry':
      return settleRetry(ctx, holder);
    case 'job':
      await settleStage(ctx, holder, { type: 'job', job: holder.job });
      return settleRetry(ctx, holder);
    case 'docs':
      return recoverDocs(ctx, holder.pub);
    // Interim (M3 0a): no release before this step holds resources under it.
    case 'batch':
      throw new Error(`recovering a repair batch's reservation: not implemented (step B2)`);
  }
}

/** A green candidate's publication is mid-chain: the unit's decided next stage is `ff` or `snapshot` (A2). */
function publicationContinues(ctx: ResourceContext, holder: PublicationHolder): boolean {
  const { decided } = ctx.journal.view.unit(holder.unit);
  if (decided === null) return false;
  const next = decidedBy(decided);
  return next.kind === 'stage' && (PUBLICATION_CHAIN as readonly string[]).includes(next.target.stage);
}

/**
 * The instances `holder` holds cleaning because it reclaimed its own residue (a retry, or a job, G4): those with an
 * own-arc residue in the fold. A live run's cleaning set never has one: a residue ends only at a release, and a
 * cleanup-failed instance leaves only through `reclaim`.
 */
function reclaiming(ctx: ResourceContext, holder: ReclaimHolder | StageHolder | PublicationHolder): ReadonlySet<ResourceUnit> {
  if (holder.type !== 'retry' && holder.type !== 'job') return new Set();
  return new Set(ctx.journal.view.residues().map((r) => r.key.resource).filter((r) => {
    const status = resourceTable(ctx.journal.view).get(r)?.status;
    return status !== undefined && status.state === 'cleaning' && sameHolder(status.holder, holder);
  }));
}

/**
 * A dead holder whose workload ran under `parent` (a stage attempt, or a job): settle its invocations, clean, rerun
 * teardowns, release or fail (a stage's or job's residues first). A job's instances in a reclaim are `settleRetry`'s.
 */
async function settleStage(ctx: ResourceContext, holder: StageHolder | PublicationHolder | JobHolder, parent: Parent): Promise<void> {
  const spawn = spawnReconciler(ctx);
  const before = heldBy(ctx, holder);
  for (const from of ['reserved', 'running'] as const) {
    const resources = before.get(from);
    if (resources === undefined) continue;
    // The dead holder's invocations: every open spawn parented by its stage attempt (or its job).
    for (const intent of ctx.journal.view.openIntents()) {
      if (intent.kind === 'proc.spawn' && canonicalJson(intent.parent) === canonicalJson(parent)) await spawn(intent, ctx.journal.view);
    }
    transition(ctx, holder, resources, { type: 'clean', from }, RECOVERY);
  }
  const reclaims = reclaiming(ctx, holder);
  const cleaning = heldBy(ctx, holder).get('cleaning')?.filter((u) => !reclaims.has(u));
  if (cleaning === undefined || cleaning.length === 0) return;
  await settleTeardowns(ctx, cleaning);
  const bound = instanceEnv(holderUnits(ctx.journal.view, holder));
  const r: Reservation<'cleaning', StageHolder | PublicationHolder | JobHolder> = {
    state: 'cleaning', holder, resources: cleaning, recipes: holderRecipes(ctx.plan(), ctx.repo, holder, cleaning, bound),
  };
  await finishCleanup(ctx, r, RECOVERY);
}

/**
 * A reclaim in progress: resume the reclaim order per instance. A retry holds only what it reclaimed, cleaning; a
 * job (after `settleStage` settled its live runs) holds cleaning only the instances it reclaims.
 */
async function settleRetry(ctx: ResourceContext, holder: ReclaimHolder): Promise<void> {
  const held = heldBy(ctx, holder);
  for (const state of ['reserved', 'running'] as const) {
    if (held.has(state)) throw new Error(`${canonicalJson(holder)} holds ${held.get(state)!.join(', ')} ${state}; a reclaim never runs`);
  }
  const cleaning = held.get('cleaning') ?? [];
  const reclaims = reclaiming(ctx, holder);
  const stray = cleaning.filter((u) => !reclaims.has(u));
  if (stray.length > 0) throw new Error(`${canonicalJson(holder)} holds ${stray.join(', ')} cleaning with no residue to reclaim`);
  await settleTeardowns(ctx, cleaning);
  for (const instance of cleaning) await retryReclaim(ctx, holder, instance as ResourceInstance, RECOVERY);
}

/** Every teardown invocation still open on one of `units` is settled before its teardown reruns. */
async function settleTeardowns(ctx: ResourceContext, units: readonly ResourceUnit[]): Promise<void> {
  const spawn = spawnReconciler(ctx);
  for (const intent of ctx.journal.view.openIntents()) {
    if (intent.kind !== 'proc.spawn') continue;
    const { subject } = intent.expect;
    if (subject.purpose === 'teardown' && units.some((r) => r === subject.resource)) await spawn(intent, ctx.journal.view);
  }
}
