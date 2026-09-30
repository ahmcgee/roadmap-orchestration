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
//   cleanup-failed       → never released by recovery; a `sweep` command (commands/apply.ts) or a retryable
//                          park's probe (`retryReclaim`) reclaims it.
//
// Per holder (M2):
//   stage        as above. Recipes are bound to the holder's whole set (F7), exactly as the live cycle bound
//                them, so a residue recovery appends equals the one the live path would have.
//   publication  keeps integration-slot while the unit's decided next stage is `ff` or `snapshot` (a green
//                candidate's mandatory chain, A2); otherwise the candidate is abandoned: its invocations are
//                settled and the slot is cleaned and released.
//   retry        found cleaning: the reclaim order resumes (`retryReclaim`: the recorded teardown again, the
//                `cleaned` disposition unless recorded, then release). A failed teardown leaves it cleaning for
//                the park's next probe.
//   sweep        re-driven by its command's reconciliation (command.apply, step 13), which knows the residues
//                it sweeps; here only its open transition is closed.
import type { Holder, IntentOf, Parent } from '../core/events.ts';
import { type ResourceInstance, type ResourceUnit, compareResourceUnits } from '../core/ids.ts';
import type { Disposition, Reconciler } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { instanceEnv } from '../resources/pool.ts';
import {
  type HeldState, type PublicationHolder, type Reservation, type ResourceContext, type RetryHolder, type StageHolder, finishCleanup,
  holderUnits, resourceTable, retryReclaim, sameHolder, transition,
} from '../resources/reserve.ts';
import { stageRecipes } from '../resources/teardown.ts';
import { PUBLICATION_CHAIN } from '../schedule/types.ts';
import { reconcileFailedCleanup } from './residue.ts';
import { spawnReconciler } from './spawn.ts';

type ResourceDisposition = Extract<Disposition<'resource.transition'>, { kind: 'done' }>;
type Settled = StageHolder | PublicationHolder | RetryHolder;

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
    if (holder.type !== 'stage') throw new Error(`${intent.op}: a fail transition held by ${canonicalJson(holder)}`);
    const bound = instanceEnv(holderUnits(ctx.journal.view, holder));
    disposition = reconcileFailedCleanup(ctx.hostDir, intent, stageRecipes(ctx.plan(), ctx.repo, holder.unit, resources, bound));
  }
  ctx.journal.done(intent.op, 'resource.transition', disposition.outcome, 'reconciled');
  return disposition;
}

/**
 * The resources-phase entry for the recovery engine (step 14b): every open transition through the
 * reconciler, then every stage, publication and retry holder that still holds anything. Afterwards each unit a
 * stage held is free or cleanup-failed; a publication holds the slot only before its `ff` or `snapshot`; a
 * retry holds only an instance whose teardown failed again.
 */
export async function recoverReservations(ctx: ResourceContext): Promise<void> {
  const reconcile = resourceReconciler(ctx);
  for (const intent of ctx.journal.view.openIntents()) {
    if (intent.kind === 'resource.transition') await reconcile(intent, ctx.journal.view);
  }
  const holders: Settled[] = [];
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

async function settleHolder(ctx: ResourceContext, holder: Settled): Promise<void> {
  switch (holder.type) {
    case 'stage':
      return settleStage(ctx, holder, { type: 'stage', unit: holder.unit, stage: holder.stage, attempt: holder.attempt });
    case 'publication':
      if (publicationContinues(ctx, holder)) return;
      return settleStage(ctx, holder, { type: 'stage', unit: holder.unit, stage: 'candidate', attempt: holder.attempt });
    case 'retry':
      return settleRetry(ctx, holder);
  }
}

/** A green candidate's publication is mid-chain: the unit's decided next stage is `ff` or `snapshot` (A2). */
function publicationContinues(ctx: ResourceContext, holder: PublicationHolder): boolean {
  const { decided } = ctx.journal.view.unit(holder.unit);
  if (decided === null) return false;
  const next = decidedBy(decided);
  return next.kind === 'stage' && (PUBLICATION_CHAIN as readonly string[]).includes(next.target.stage);
}

/** A dead holder whose workload ran under `stage`: settle its invocations, clean, rerun teardowns, release or fail. */
async function settleStage(ctx: ResourceContext, holder: StageHolder | PublicationHolder, stage: Parent): Promise<void> {
  const spawn = spawnReconciler(ctx);
  const before = heldBy(ctx, holder);
  for (const from of ['reserved', 'running'] as const) {
    const resources = before.get(from);
    if (resources === undefined) continue;
    // The dead holder's invocations: every open spawn parented by its stage attempt.
    for (const intent of ctx.journal.view.openIntents()) {
      if (intent.kind === 'proc.spawn' && canonicalJson(intent.parent) === canonicalJson(stage)) await spawn(intent, ctx.journal.view);
    }
    transition(ctx, holder, resources, { type: 'clean', from }, RECOVERY);
  }
  const cleaning = heldBy(ctx, holder).get('cleaning');
  if (cleaning === undefined) return;
  await settleTeardowns(ctx, cleaning);
  const bound = instanceEnv(holderUnits(ctx.journal.view, holder));
  const r: Reservation<'cleaning', StageHolder | PublicationHolder> = {
    state: 'cleaning', holder, resources: cleaning, recipes: stageRecipes(ctx.plan(), ctx.repo, holder.unit, cleaning, bound),
  };
  await finishCleanup(ctx, r, RECOVERY);
}

/** A retry holds only what it reclaimed, cleaning: resume the reclaim order per instance. */
async function settleRetry(ctx: ResourceContext, holder: RetryHolder): Promise<void> {
  const held = heldBy(ctx, holder);
  for (const state of ['reserved', 'running'] as const) {
    if (held.has(state)) throw new Error(`${canonicalJson(holder)} holds ${held.get(state)!.join(', ')} ${state}; a retry only reclaims`);
  }
  const cleaning = held.get('cleaning') ?? [];
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
