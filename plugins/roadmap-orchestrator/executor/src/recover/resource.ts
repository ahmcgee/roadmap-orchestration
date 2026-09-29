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
//   cleanup-failed       → never released by recovery; only a `sweep` command reclaims it (commands/apply.ts).
//
// A sweep's reservation is re-driven by its command's reconciliation (command.apply, step 13), which
// knows the residues it sweeps; here only its open transition is closed.
import type { Holder, IntentOf, Parent } from '../core/events.ts';
import type { ResourceName } from '../core/ids.ts';
import type { Disposition, Reconciler } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type HeldState, type Reservation, type ResourceContext, type StageHolder, finishCleanup, lockOrder, resourceTable,
  sameHolder, transition,
} from '../resources/reserve.ts';
import { stageRecipes } from '../resources/teardown.ts';
import { reconcileFailedCleanup } from './residue.ts';
import { spawnReconciler } from './spawn.ts';

type ResourceDisposition = Extract<Disposition<'resource.transition'>, { kind: 'done' }>;

/** Transitions made by recovery belong to no live stage. */
const RECOVERY: Parent = { type: 'arc' };

/** Closes an open transition, then drives a stage holder's reservations to free or cleanup-failed. */
export function resourceReconciler(ctx: ResourceContext): Reconciler<'resource.transition'> {
  return async (intent): Promise<ResourceDisposition> => {
    const disposition = close(ctx, intent);
    const { holder } = intent.expect;
    if (holder.type === 'stage') await settleHolder(ctx, holder);
    return disposition;
  };
}

function close(ctx: ResourceContext, intent: IntentOf<'resource.transition'>): ResourceDisposition {
  const { holder, resources, edge } = intent.expect;
  let disposition: ResourceDisposition = { kind: 'done', outcome: { kind: 'transitioned' } };
  if (edge.type === 'fail') {
    if (holder.type !== 'stage') throw new Error(`${intent.op}: a fail transition held by sweep ${holder.command}`);
    disposition = reconcileFailedCleanup(ctx.hostDir, intent, stageRecipes(ctx.plan(), ctx.repo, holder.unit, resources));
  }
  ctx.journal.done(intent.op, 'resource.transition', disposition.outcome, 'reconciled');
  return disposition;
}

/**
 * The resources-phase entry for the recovery engine (step 14b): every open transition through the
 * reconciler, then every stage holder that still holds anything. Afterwards each resource a stage held
 * is free or cleanup-failed.
 */
export async function recoverReservations(ctx: ResourceContext): Promise<void> {
  const reconcile = resourceReconciler(ctx);
  for (const intent of ctx.journal.view.openIntents()) {
    if (intent.kind === 'resource.transition') await reconcile(intent, ctx.journal.view);
  }
  const holders: StageHolder[] = [];
  for (const entry of resourceTable(ctx.journal.view).values()) {
    const { status } = entry;
    if (status.state === 'free' || status.state === 'cleanup-failed' || status.holder.type !== 'stage') continue;
    const holder = status.holder;
    if (!holders.some((h) => sameHolder(h, holder))) holders.push(holder);
  }
  for (const holder of holders) await settleHolder(ctx, holder);
}

/** The holder's resources per held state, each set in lock order. */
function heldBy(ctx: ResourceContext, holder: Holder): ReadonlyMap<HeldState, readonly ResourceName[]> {
  const held = new Map<HeldState, ResourceName[]>();
  for (const [resource, { status }] of resourceTable(ctx.journal.view)) {
    if (status.state === 'free' || status.state === 'cleanup-failed' || !sameHolder(status.holder, holder)) continue;
    held.set(status.state, [...(held.get(status.state) ?? []), resource]);
  }
  return new Map([...held].map(([state, rs]) => [state, lockOrder(rs)]));
}

async function settleHolder(ctx: ResourceContext, holder: StageHolder): Promise<void> {
  const spawn = spawnReconciler(ctx);
  const before = heldBy(ctx, holder);
  for (const from of ['reserved', 'running'] as const) {
    const resources = before.get(from);
    if (resources === undefined) continue;
    // The dead holder's invocations: every open spawn parented by its stage attempt.
    const stage: Parent = { type: 'stage', unit: holder.unit, stage: holder.stage, attempt: holder.attempt };
    for (const intent of ctx.journal.view.openIntents()) {
      if (intent.kind === 'proc.spawn' && canonicalJson(intent.parent) === canonicalJson(stage)) await spawn(intent, ctx.journal.view);
    }
    transition(ctx, holder, resources, { type: 'clean', from }, RECOVERY);
  }
  const cleaning = heldBy(ctx, holder).get('cleaning');
  if (cleaning === undefined) return;
  for (const intent of ctx.journal.view.openIntents()) {
    if (intent.kind !== 'proc.spawn') continue;
    const { subject } = intent.expect;
    if (subject.purpose === 'teardown' && cleaning.includes(subject.resource)) await spawn(intent, ctx.journal.view);
  }
  const r: Reservation<'cleaning', StageHolder> = {
    state: 'cleaning', holder, resources: cleaning, recipes: stageRecipes(ctx.plan(), ctx.repo, holder.unit, cleaning),
  };
  await finishCleanup(ctx, r, RECOVERY);
}
