// The reservation cycle (plan "Reservation cycle", R4; DESIGN §2.2 Locks):
//
//   reserve (all-or-none, lock order, free→reserved) → occupancy probe (probe.ts) → run (→running)
//   → cleanup: clean (→cleaning), one teardown per resource that declares one, then per resource:
//     clean → release (→free); failed → fail (→cleanup-failed) with its residue durable in the host
//     index first, never released.
//   cancel = proc.kill{pause|stop} of the holder's live invocation → quiescence → cleanup.
//
// State lives in the journal only. Every transition is one `resource.transition` op that moves a set of
// resources in lock order (ascending names, integration-slot last), and the resource table is the fold's
// (`JournalView.resources()`, kept incrementally; `resourceTable`), never kept in a side file. A `Reservation` is a
// typed handle (its state in the type, so a caller cannot run a cleaning reservation); each call re-checks
// the handle against the derived table and throws on a mismatch.
//
// One process owns the journal, and deciding and journaling a transition is synchronous, so no other
// reservation can interleave between the table check and the durable intent. Because a stage takes its
// whole set at once or nothing, no holder ever waits while holding, and contending reservations cannot
// deadlock.
//
// Holders: a unit's stage attempt, or a sweep command. A sweep never runs a workload and never records a
// failed cleanup: it has no unit to key a residue by (lead ruling), so what it could not clean stays
// `cleaning` and the residue it was sweeping stays undisposed. Both rules are in the types and re-checked
// at run time. The one way out of cleanup-failed is a sweep's `reclaim` (cleanup-failed→cleaning under the
// sweep), taken for this arc's own resource whose residue the sweep re-runs (commands/apply.ts).
import { crashPoint } from '../core/crash.ts';
import type { Holder, Parent, ResourceEdge } from '../core/events.ts';
import { type InvocationId, type OpKey, type ResourceName, type ResourceUnit, INTEGRATION_SLOT, opKey } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type HeldState, type ResourceEntry, FREE_RESOURCE, afterEdge } from '../core/state.ts';
import type { SpecM1 } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import type { PlanM1, PlanUnit } from '../input/plan.ts';
import { type ProcContext, killWorkload } from '../pipeline/invoke.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { type ResidueRecipe, appendFailedCleanupResidues } from '../recover/residue.ts';
import { type TeardownRun, stageRecipes, teardown } from './teardown.ts';

export type StageHolder = Extract<Holder, { type: 'stage' }>;
export type SweepHolder = Extract<Holder, { type: 'sweep' }>;

/**
 * What the reservation cycle needs beyond processes: the plan's declarations, the repo root, the host dir.
 * `plan()` is read at each call: in the executor it is the plan in force, which an apply may move.
 */
export type ResourceContext = ProcContext & Readonly<{ plan: () => PlanM1; repo: AbsPath; hostDir: AbsPath }>;

export type { HeldState, ResourceStatus } from '../core/state.ts';
export { sameHolder } from '../core/state.ts';
/** A resource unit's row of the table (`ResourceEntry` in the fold). */
export type TableEntry = ResourceEntry;

export type Reservation<S extends HeldState, H extends Holder> = Readonly<{
  state: S;
  holder: H;
  /** Lock order. */
  resources: readonly ResourceName[];
  /** The resolved teardown and owner label of each resource that declares one (not integration-slot). */
  recipes: ReadonlyMap<ResourceName, ResidueRecipe>;
}>;

/** Some requested resource is not free; nothing was journaled. */
export type Refused = Readonly<{ state: 'refused'; busy: readonly ResourceName[] }>;

export type CleanupResult<H extends Holder> =
  | Readonly<{ kind: 'released'; released: readonly ResourceName[] }>
  | (H extends StageHolder
    /** Residues are durable for `failed`, which are cleanup-failed and never released. */
    ? Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceName[]; released: readonly ResourceName[] }>
    /** A sweep records no failure: `failed` stay cleaning, held by the sweep. */
    : Readonly<{ kind: 'left-cleaning'; failed: readonly ResourceName[]; released: readonly ResourceName[] }>);

// ---------------------------------------------------------------------------------------------------
// The resource table: the fold's

/**
 * Every resource unit any transition named, with its state. Absent units are free. The fold refuses a log
 * holding a transition that was illegal from the state before it, so the table is always a table.
 */
export function resourceTable(view: JournalView): ReadonlyMap<ResourceUnit, TableEntry> {
  return view.resources();
}

export const isFree = (entry: TableEntry): boolean => entry.pending === null && entry.status.state === 'free';

export function entryOf(table: ReadonlyMap<ResourceUnit, TableEntry>, resource: ResourceUnit): TableEntry {
  return table.get(resource) ?? FREE_RESOURCE;
}

/** Ascending names, integration-slot last; duplicates and an empty set are caller bugs. */
export function lockOrder(resources: readonly ResourceName[]): readonly ResourceName[] {
  if (resources.length === 0) throw new Error('a reservation needs at least one resource');
  if (new Set(resources).size !== resources.length) throw new Error(`duplicate resources in ${JSON.stringify(resources)}`);
  const named = resources.filter((r) => r !== INTEGRATION_SLOT).sort();
  return resources.includes(INTEGRATION_SLOT) ? [...named, INTEGRATION_SLOT] : named;
}

// ---------------------------------------------------------------------------------------------------
// Transitions

type NonFailEdge = Exclude<ResourceEdge, Readonly<{ type: 'fail' | 'reclaim' }>>;
/** The edges a holder may take outside a failed cleanup or a reclaim: a sweep never runs. */
export type EdgeFor<H extends Holder> = H extends SweepHolder ? Exclude<NonFailEdge, Readonly<{ type: 'run' }>> : NonFailEdge;

function holderKey(holder: Holder): OpKey {
  switch (holder.type) {
    case 'stage': return opKey(`resources:${holder.unit}/${holder.stage}/${holder.attempt}`);
    case 'sweep': return opKey(`resources:${holder.command}`);
    case 'retry': return opKey(`resources:retry/${holder.unit}/${holder.stage}/${holder.attempt}`);
    case 'publication': return opKey(`resources:publication/${holder.unit}/${holder.attempt}`);
  }
}

function assertLegal(view: JournalView, holder: Holder, resources: readonly ResourceName[], edge: ResourceEdge): void {
  const table = resourceTable(view);
  for (const r of resources) {
    const entry = entryOf(table, r);
    if (entry.pending !== null) throw new Error(`${edge.type} of ${r}: ${entry.pending.op} is still open on it`);
    const next = afterEdge(entry.status, holder, edge);
    if (typeof next === 'string') throw new Error(`${edge.type} of ${r}: ${next}`);
  }
}

/** Journals one transition of `resources` (lock order): intent, then act (residues, for `fail`), then done. */
function journalTransition(
  ctx: ResourceContext,
  holder: Holder,
  resources: readonly ResourceName[],
  edge: ResourceEdge,
  parent: Parent,
  recipes: ReadonlyMap<ResourceName, ResidueRecipe>,
): void {
  const view = ctx.journal.view;
  assertLegal(view, holder, resources, edge);
  const { op } = ctx.journal.begin({
    kind: 'resource.transition',
    key: holderKey(holder),
    parent,
    deadlineAt: null,
    body: () => ({ expect: { holder, resources, edge }, post: null }),
  });
  crashPoint('resource.after-intent');
  if (edge.type === 'fail') {
    const intent = view.latestIntent(op);
    if (intent.kind !== 'resource.transition') throw new Error(`${op} is a ${intent.kind}`);
    appendFailedCleanupResidues(ctx.hostDir, intent, recipes);
  }
  ctx.journal.done(op, 'resource.transition', { kind: 'transitioned' }, null);
  crashPoint('resource.after-done');
}

/** Any transition but `fail`, which only `cleanup` takes, and only for a stage holder. */
export function transition<H extends Holder>(
  ctx: ResourceContext,
  holder: H,
  resources: readonly ResourceName[],
  edge: EdgeFor<H>,
  parent: Parent,
): void {
  const e = edge as ResourceEdge;
  if (e.type === 'fail') throw new Error('a fail transition is recorded only by a stage holder\'s cleanup, with its residues');
  if (e.type === 'reclaim') throw new Error('a reclaim is taken only through reclaimForSweep');
  if (holder.type === 'sweep' && e.type === 'run') throw new Error(`sweep ${holder.command} cannot run a workload`);
  journalTransition(ctx, holder, resources, e, parent, new Map());
}

/**
 * cleaning→cleanup-failed with one residue per failed resource, durable in the host index before the
 * done (step 7's ordering). A sweep holder is refused here as well as in the types.
 */
function recordFailedCleanup(
  ctx: ResourceContext,
  r: Reservation<'cleaning', StageHolder>,
  failed: readonly TeardownRun[],
  parent: Parent,
): void {
  const holder = r.holder as Holder;
  if (holder.type !== 'stage') throw new Error(`${canonicalJson(holder)} cannot record a failed cleanup: only a stage holder records one`);
  const residues = failed.map((t) => ({ resource: t.resource, teardown: t.inv }));
  journalTransition(ctx, holder, residues.map((x) => x.resource), { type: 'fail', residues }, parent, r.recipes);
}

// ---------------------------------------------------------------------------------------------------
// The cycle

function reserveWith<H extends Holder>(
  ctx: ResourceContext,
  holder: H,
  resources: readonly ResourceName[],
  recipes: ReadonlyMap<ResourceName, ResidueRecipe>,
  parent: Parent,
): Reservation<'reserved', H> | Refused {
  const table = resourceTable(ctx.journal.view);
  const busy = resources.filter((r) => !isFree(entryOf(table, r)));
  if (busy.length > 0) return { state: 'refused', busy };
  journalTransition(ctx, holder, resources, { type: 'reserve' }, parent, recipes);
  return { state: 'reserved', holder, resources, recipes };
}

/**
 * Reserves a stage's whole set in lock order, or nothing. Every resource must be declared in the plan or
 * be the integration slot (startup refuses an unknown request, so an unknown one here is a bug).
 */
export function reserve(
  ctx: ResourceContext,
  holder: StageHolder,
  resources: readonly ResourceName[],
  parent: Parent,
): Reservation<'reserved', StageHolder> | Refused {
  const ordered = lockOrder(resources);
  return reserveWith(ctx, holder, ordered, stageRecipes(ctx.plan(), ctx.repo, holder.unit, ordered), parent);
}

/** A sweep reserves exactly the resources it has recipes for (the residues it sweeps). */
export function reserveForSweep(
  ctx: ResourceContext,
  holder: SweepHolder,
  recipes: ReadonlyMap<ResourceName, ResidueRecipe>,
  parent: Parent,
): Reservation<'reserved', SweepHolder> | Refused {
  return reserveWith(ctx, holder, lockOrder([...recipes.keys()]), recipes, parent);
}

/**
 * cleanup-failed→cleaning under a sweep holder: the one way out of cleanup-failed. A sweep takes it for a
 * resource of this arc whose residue it sweeps; `finishCleanup` then reruns the recorded teardown and
 * releases the resource, or leaves it cleaning under the sweep.
 */
export function reclaimForSweep(
  ctx: ResourceContext,
  holder: SweepHolder,
  recipes: ReadonlyMap<ResourceName, ResidueRecipe>,
  parent: Parent,
): Reservation<'cleaning', SweepHolder> {
  const resources = lockOrder([...recipes.keys()]);
  journalTransition(ctx, holder, resources, { type: 'reclaim' }, parent, recipes);
  return { state: 'cleaning', holder, resources, recipes };
}

/** reserved→running: the holder's workload may start. Only after `probe` returned clear. */
export function run(ctx: ResourceContext, r: Reservation<'reserved', StageHolder>, parent: Parent): Reservation<'running', StageHolder> {
  transition(ctx, r.holder, r.resources, { type: 'run' }, parent);
  return { ...r, state: 'running' };
}

/**
 * reserved|running→cleaning, then the teardowns and the outcome. The holder's workload must already be
 * quiescent (its invocation settled, or `cancel`).
 */
export async function cleanup<H extends Holder>(
  ctx: ResourceContext,
  r: Reservation<'reserved' | 'running', H>,
  parent: Parent,
): Promise<CleanupResult<H>> {
  // Widened for the call: EdgeFor<H> is not resolvable while H is generic; transition re-checks at run time.
  transition<Holder>(ctx, r.holder, r.resources, { type: 'clean', from: r.state }, parent);
  return finishCleanup(ctx, { ...r, state: 'cleaning' }, parent);
}

/**
 * Tears down every resource of a cleaning reservation that declares a teardown, one at a time in lock
 * order. Failures first: their residues are durable and the fail done written before any release of this
 * reservation (DESIGN §2.2). Then the clean subset is released. Recovery calls this to rerun the teardown
 * of a reservation found cleaning.
 */
export async function finishCleanup<H extends Holder>(
  ctx: ResourceContext,
  r: Reservation<'cleaning', H>,
  parent: Parent,
): Promise<CleanupResult<H>> {
  const unit = r.holder.type === 'stage' ? r.holder.unit : null;
  const runs: TeardownRun[] = [];
  for (const resource of r.resources) {
    const recipe = r.recipes.get(resource);
    if (recipe !== undefined) runs.push(await teardown(ctx, unit, resource, recipe, parent));
  }
  const failed = runs.filter((t) => !t.clean);
  const released = r.resources.filter((res) => !failed.some((t) => t.resource === res));
  if (failed.length > 0 && isStage(r)) recordFailedCleanup(ctx, r, failed, parent);
  if (released.length > 0) transition<Holder>(ctx, r.holder, released, { type: 'release' }, parent);
  const names = failed.map((t) => t.resource);
  const result: CleanupResult<StageHolder> | CleanupResult<SweepHolder> = failed.length === 0
    ? { kind: 'released', released }
    : isStage(r) ? { kind: 'cleanup-failed', failed: names, released } : { kind: 'left-cleaning', failed: names, released };
  return result as CleanupResult<H>;
}

function isStage(r: Reservation<'cleaning', Holder>): r is Reservation<'cleaning', StageHolder> {
  return r.holder.type === 'stage';
}

/**
 * Cancellation: kill the holder's live invocation (proc.kill{pause|stop}, which resolves only once its
 * workload is empty), then clean up. `live` is null when no invocation of the holder is running.
 */
export async function cancel(
  ctx: ResourceContext,
  r: Reservation<'reserved' | 'running', StageHolder>,
  live: InvocationId | null,
  reason: 'pause' | 'stop',
  parent: Parent,
): Promise<CleanupResult<StageHolder>> {
  if (live !== null) await killWorkload(ctx, { inv: live, scope: 'invocation', reason });
  return cleanup(ctx, r, parent);
}

// ---------------------------------------------------------------------------------------------------
// The fast/estate boundary

export type SpecLane = SpecM1['lanes'][number];
export type LaneTierRefusal = Extract<StartupRejection, { kind: 'spec-lane-unrunnable' }>;

/**
 * The implementer's lanes: the only source of the lane list a build prompt shows (renderSpec with
 * fastLanesOnly shows exactly these). Estate lanes are executor-only.
 */
export function fastLanes(spec: SpecM1): readonly SpecLane[] {
  return spec.lanes.filter((l) => l.tier === 'fast');
}

/**
 * Startup and dispatch check: an active fast lane is one the implementer runs inside its build, which
 * holds exactly the unit's declared resources for its whole run. A fast lane that needs any other
 * resource would give the implementer estate it does not hold, so the spec is refused.
 */
export function checkLaneTiers(spec: SpecM1, unit: PlanUnit): readonly LaneTierRefusal[] {
  return fastLanes(spec)
    .filter((l) => l.state === 'active' && l.resources.some((r) => !unit.resources.includes(r)))
    .map((l) => ({ kind: 'spec-lane-unrunnable', unit: unit.id, lane: l.id, problem: { type: 'estate-lane-for-implementer' } }));
}
