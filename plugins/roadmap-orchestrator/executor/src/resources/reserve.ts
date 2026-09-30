// The reservation cycle (plan "Reservation cycle", R4; DESIGN §2.2 Locks; M2 "Resources"):
//
//   reserve (all-or-none, lock order, free→reserved) → occupancy probe (probe.ts) → run (→running)
//   → cleanup: clean (→cleaning), one teardown per resource instance that declares one, then per unit:
//     clean → release (→free); failed → fail (→cleanup-failed) with its residue durable in the host
//     index first, never released.
//   cancel = proc.kill{pause|stop} of the holder's live invocation → quiescence → cleanup.
//
// A reservation moves resource units (M2): named resources, estate pool instances `<pool>#<n>`, `@cpu#<n>`
// tokens and `integration-slot`. A request (`ResourceRequest`) names what it needs; `allocate` (pool.ts) picks
// the lowest free instance of each pool and the lowest free tokens, and the whole set is taken at once in lock
// order (named and pool instances ascending, `@cpu#*` numerically, the slot last) or nothing is.
//
// State lives in the journal only. Every transition is one `resource.transition` op that moves a set of
// units in lock order, and the resource table is the fold's (`JournalView.resources()`, kept incrementally;
// `resourceTable`), never kept in a side file. A `Reservation` is a typed handle (its state in the type, so a
// caller cannot run a cleaning reservation); each call re-checks the handle against the table and throws on a
// mismatch.
//
// One process owns the journal, and deciding and journaling a transition is synchronous, so no other
// reservation can interleave between the table check and the durable intent. Because a holder takes its
// whole set at once or nothing, no holder waits while holding (the arbiter, src/schedule/arbiter.ts, queues
// waiters in memory), and contending reservations cannot deadlock.
//
// Holders:
//   stage{unit, stage, attempt}   a unit's stage attempt: the one holder that runs workloads and records a
//                                 failed cleanup (its residues are keyed by its unit).
//   publication{unit, attempt}    the candidate attempt, holding `integration-slot` from candidate start
//                                 through `ff` and `snapshot` (A2). It declares no teardown and never fails.
//   retry{unit, stage, attempt}   a probe reclaiming the unit's own residue (keyed by the stage attempt whose
//                                 cleanup failed, as the residue key names it): reclaim → teardown → the
//                                 residue's `cleaned` disposition → release (F2), so a released instance is
//                                 never dirty (`retryReclaim`).
//   sweep{command}                a `sweep` command. It never runs a workload and never records a failed
//                                 cleanup: what it could not clean stays `cleaning` and its residue undisposed.
//   docs{pub}                     a docs publication (M3, A7), holding `integration-slot` alone, like a
//                                 publication: no teardown, never fails.
//   job{job}                      a durable job's lanes (M3, G4, H4: docs, audit, baseline and batch lanes). It
//                                 never takes the slot, runs workloads like a stage, and records a failed
//                                 cleanup as job-owned residues (keyed by the job). Its recipes carry the job's
//                                 owner label (`jobOwnerLabel`). It reclaims its own residue itself
//                                 (`retryReclaim`), in a unit retry's order: it is both the failing and the
//                                 reclaiming holder, since a job, unlike a stage attempt, outlives its lane.
// A retry, a job or a sweep takes cleanup-failed back through `reclaim` (cleanup-failed→cleaning), the one way out.
import { crashPoint } from '../core/crash.ts';
import { type Holder, type Parent, type ResourceEdge, holderUnit } from '../core/events.ts';
import {
  type ArcId, type InvocationId, type JobId, type OpKey, type ResourceInstance, type ResourceUnit, compareResourceUnits, opKey,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type HeldState, type ResourceEntry, FREE_RESOURCE, afterEdge, sameHolder } from '../core/state.ts';
import type { ResidueKey, SpecM1, Stage } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { type ResidueEntry, readResidues, recordDisposition, undispositioned } from '../host/residues.ts';
import type { PlanM1, PlanUnit } from '../input/plan.ts';
import { type ProcContext, killWorkload } from '../pipeline/invoke.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { type ResidueRecipe, appendFailedCleanupResidues } from '../recover/residue.ts';
import type { ResourceRequest } from '../schedule/types.ts';
import { allocate, instanceEnv } from './pool.ts';
import { type TeardownRun, instancesOf, resolveCommand, resourceDecl, stageRecipes, teardown } from './teardown.ts';

export type StageHolder = Extract<Holder, { type: 'stage' }>;
export type SweepHolder = Extract<Holder, { type: 'sweep' }>;
export type RetryHolder = Extract<Holder, { type: 'retry' }>;
export type PublicationHolder = Extract<Holder, { type: 'publication' }>;
export type DocsHolder = Extract<Holder, { type: 'docs' }>;
export type JobHolder = Extract<Holder, { type: 'job' }>;
/** The holders that reserve through a request (and so through the arbiter). */
export type AcquiringHolder = StageHolder | PublicationHolder | DocsHolder | JobHolder;
/** The acquiring holders that act for a unit (a stage attempt, or its candidate's publication). */
export type UnitAcquiringHolder = StageHolder | PublicationHolder;
/** The holders whose failed cleanup records residues (`RESIDUE_HOLDERS`): keyed by the unit, or by the job. */
export type ResidueHolder = StageHolder | JobHolder;
/** The holders that reclaim their own residue through `retryReclaim`: a unit's retry, or the owning job (G4). */
export type ReclaimHolder = RetryHolder | JobHolder;

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
  resources: readonly ResourceUnit[];
  /**
   * The resolved teardown and owner label of each resource instance that declares one (not `@cpu`, not
   * integration-slot), bound to the holder's instances (F7).
   */
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>;
}>;

/** Some requested unit is not free; nothing was journaled. `busy`: every unit that blocks it, lock order. */
export type Refused = Readonly<{ state: 'refused'; busy: readonly ResourceUnit[] }>;

export type CleanupResult<H extends Holder> =
  | Readonly<{ kind: 'released'; released: readonly ResourceUnit[] }>
  | (H extends ResidueHolder
    /** Residues are durable for `failed`, which are cleanup-failed and never released. */
    ? Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[]; released: readonly ResourceUnit[] }>
    /** A sweep or retry records no failure: `failed` stay cleaning, held by it. A publication or docs holder never fails. */
    : Readonly<{ kind: 'left-cleaning'; failed: readonly ResourceInstance[]; released: readonly ResourceUnit[] }>);

/** The stage a unit holder's needs-user and parents speak of: a publication is its candidate attempt's. */
export function holderStage(holder: UnitAcquiringHolder): Stage {
  return holder.type === 'stage' ? holder.stage : 'candidate';
}

/**
 * The owner label a job's lanes and teardowns carry (G4): `<arc>/job/<job>`. A unit's is `<arc>/<unit>`
 * (`ownerLabel`, teardown.ts); the extra segment keeps a job's objects apart from a unit's even where a unit id
 * reads like a job id (`audit-1`), since a slug never contains `/`.
 */
export function jobOwnerLabel(arc: ArcId, job: JobId): string {
  return `${arc}/job/${job}`;
}

/**
 * The teardown recipe of each resource instance among `resources` under `holder`, bound to `instances`
 * (default: the binding of `resources`; recovery passes the holder's whole set, F7). A unit holder's are
 * `stageRecipes`; a job's carry `jobOwnerLabel`; a docs holder holds integration-slot alone, which has none.
 */
export function holderRecipes(
  plan: PlanM1,
  repo: AbsPath,
  holder: AcquiringHolder,
  resources: readonly ResourceUnit[],
  instances: Readonly<Record<string, string>> = instanceEnv(resources),
): ReadonlyMap<ResourceInstance, ResidueRecipe> {
  switch (holder.type) {
    case 'stage':
    case 'publication':
      return stageRecipes(plan, repo, holder.unit, resources, instances);
    case 'docs':
      if (instancesOf(resources).length > 0) throw new Error(`${canonicalJson(holder)} holds ${JSON.stringify(resources)}: a docs holder holds integration-slot alone`);
      return new Map();
    case 'job': {
      const label = jobOwnerLabel(plan.arc, holder.job);
      return new Map(instancesOf(resources).map((r) => [r, { teardown: resolveCommand(repo, resourceDecl(plan, r).teardown, label, instances), label }]));
    }
  }
}

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

/** Lock order (`compareResourceUnits`); duplicates and an empty set are caller bugs. */
export function lockOrder<U extends ResourceUnit>(resources: readonly U[]): readonly U[] {
  if (resources.length === 0) throw new Error('a reservation needs at least one resource');
  if (new Set(resources).size !== resources.length) throw new Error(`duplicate resources in ${JSON.stringify(resources)}`);
  return [...resources].sort(compareResourceUnits);
}

/** Every unit `holder` holds in any state (cleanup-failed included), lock order: its whole set until released. */
export function holderUnits(view: JournalView, holder: Holder): readonly ResourceUnit[] {
  const units: ResourceUnit[] = [];
  for (const [u, { status }] of resourceTable(view)) if (status.state !== 'free' && sameHolder(status.holder, holder)) units.push(u);
  return units.sort(compareResourceUnits);
}

// ---------------------------------------------------------------------------------------------------
// Transitions

type NonFailEdge = Exclude<ResourceEdge, Readonly<{ type: 'fail' | 'reclaim' }>>;
/** The edges a holder may take outside a failed cleanup or a reclaim: a sweep or a retry never runs. */
export type EdgeFor<H extends Holder> = H extends SweepHolder | RetryHolder ? Exclude<NonFailEdge, Readonly<{ type: 'run' }>> : NonFailEdge;

function holderKey(holder: Holder): OpKey {
  switch (holder.type) {
    case 'stage': return opKey(`resources:${holder.unit}/${holder.stage}/${holder.attempt}`);
    case 'sweep': return opKey(`resources:${holder.command}`);
    case 'retry': return opKey(`resources:retry/${holder.unit}/${holder.stage}/${holder.attempt}`);
    case 'publication': return opKey(`resources:publication/${holder.unit}/${holder.attempt}`);
    case 'docs': return opKey(`resources:docs/${holder.pub}`);
    case 'batch': return opKey(`resources:batch/${holder.finding}/${holder.attempt}`);
    case 'job': return opKey(`resources:job/${holder.job}`);
  }
}

function assertLegal(view: JournalView, holder: Holder, resources: readonly ResourceUnit[], edge: ResourceEdge): void {
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
  resources: readonly ResourceUnit[],
  edge: ResourceEdge,
  parent: Parent,
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>,
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
  const unit = 'unit' in holder ? holder.unit : undefined;
  crashPoint('resource.after-intent', unit);
  if (edge.type === 'fail') {
    const intent = view.latestIntent(op);
    if (intent.kind !== 'resource.transition') throw new Error(`${op} is a ${intent.kind}`);
    appendFailedCleanupResidues(ctx.hostDir, intent, recipes);
  }
  ctx.journal.done(op, 'resource.transition', { kind: 'transitioned' }, null);
  crashPoint('resource.after-done', unit);
}

/** Any transition but `fail` (only `cleanup` takes it, for a stage or job holder) and `reclaim` (a sweep's, a retry's or a job's). */
export function transition<H extends Holder>(
  ctx: ResourceContext,
  holder: H,
  resources: readonly ResourceUnit[],
  edge: EdgeFor<H>,
  parent: Parent,
): void {
  const e = edge as ResourceEdge;
  if (e.type === 'fail') throw new Error('a fail transition is recorded only by a stage or job holder\'s cleanup, with its residues');
  if (e.type === 'reclaim') throw new Error('a reclaim is taken only through reclaimForSweep or retryReclaim');
  if ((holder.type === 'sweep' || holder.type === 'retry') && e.type === 'run') throw new Error(`${canonicalJson(holder)} cannot run a workload`);
  journalTransition(ctx, holder, resources, e, parent, new Map());
}

/**
 * cleaning→cleanup-failed with one residue per failed instance, durable in the host index before the done
 * (step 7's ordering). Only a stage or job holder records one (`RESIDUE_HOLDERS`): it has the owner a residue is
 * keyed by (the unit, or the job, G4).
 */
function recordFailedCleanup(
  ctx: ResourceContext,
  r: Reservation<'cleaning', ResidueHolder>,
  failed: readonly TeardownRun[],
  parent: Parent,
): void {
  const holder = r.holder as Holder;
  if (holder.type !== 'stage' && holder.type !== 'job') throw new Error(`${canonicalJson(holder)} cannot record a failed cleanup: only a stage or job holder records one`);
  const residues = failed.map((t) => ({ resource: t.resource, teardown: t.inv }));
  journalTransition(ctx, holder, residues.map((x) => x.resource), { type: 'fail', residues }, parent, r.recipes);
}

// ---------------------------------------------------------------------------------------------------
// The cycle

/**
 * Reserves a request's whole set in lock order, or nothing (`allocate`: every named resource and the slot free,
 * the lowest free instance of each pool, the lowest free `@cpu` tokens). Synchronous: the arbiter grants through
 * it. Every name must be declared in the plan or be the slot (startup refuses an unknown one, so it is a bug here);
 * `requestOf` (pool.ts) builds a request from declared names.
 */
export function reserve<H extends AcquiringHolder>(
  ctx: ResourceContext,
  holder: H,
  req: ResourceRequest,
  parent: Parent,
): Reservation<'reserved', H> | Refused {
  const plan = ctx.plan();
  const slotAlone = req.publication && req.named.length === 0 && req.pools.length === 0 && req.cpu === 0;
  if ((holder.type === 'publication' || holder.type === 'docs') && !slotAlone) {
    throw new Error(`a ${holder.type} holder reserves integration-slot alone, not ${canonicalJson(req)}`);
  }
  if (holder.type === 'job' && req.publication) throw new Error(`a job holder never reserves integration-slot: ${canonicalJson(req)}`);
  const got = allocate(resourceTable(ctx.journal.view), plan, req);
  if (got.kind === 'busy') return { state: 'refused', busy: got.busy };
  journalTransition(ctx, holder, got.units, { type: 'reserve' }, parent, new Map());
  return { state: 'reserved', holder, resources: got.units, recipes: holderRecipes(plan, ctx.repo, holder, got.units) };
}

/**
 * The handle of what `holder` holds in `state` (every unit it holds must be in it), rebuilt from the table: after
 * an arbiter grant (`Grant` carries the units), or across a restart. Throws when it holds nothing.
 */
export function heldReservation<S extends HeldState, H extends AcquiringHolder>(ctx: ResourceContext, holder: H, state: S): Reservation<S, H> {
  const table = resourceTable(ctx.journal.view);
  const units = holderUnits(ctx.journal.view, holder);
  if (units.length === 0) throw new Error(`${canonicalJson(holder)} holds nothing`);
  for (const u of units) {
    const e = entryOf(table, u);
    if (e.pending !== null || e.status.state !== state) throw new Error(`${canonicalJson(holder)} holds ${u} ${e.status.state}${e.pending === null ? '' : ` (${e.pending.op} open)`}, not ${state}`);
  }
  return { state, holder, resources: units, recipes: holderRecipes(ctx.plan(), ctx.repo, holder, units) };
}

/** A sweep reserves exactly the resource instances it has recipes for (the residues it sweeps). */
export function reserveForSweep(
  ctx: ResourceContext,
  holder: SweepHolder,
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>,
  parent: Parent,
): Reservation<'reserved', SweepHolder> | Refused {
  const resources = lockOrder([...recipes.keys()]);
  const table = resourceTable(ctx.journal.view);
  const busy = resources.filter((r) => !isFree(entryOf(table, r)));
  if (busy.length > 0) return { state: 'refused', busy };
  journalTransition(ctx, holder, resources, { type: 'reserve' }, parent, recipes);
  return { state: 'reserved', holder, resources, recipes };
}

/**
 * cleanup-failed→cleaning under a sweep holder. A sweep takes it for a resource of this arc whose residue it
 * sweeps; `finishCleanup` then reruns the recorded teardown and releases the resource, or leaves it cleaning
 * under the sweep.
 */
export function reclaimForSweep(
  ctx: ResourceContext,
  holder: SweepHolder,
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>,
  parent: Parent,
): Reservation<'cleaning', SweepHolder> {
  const resources = lockOrder([...recipes.keys()]);
  journalTransition(ctx, holder, resources, { type: 'reclaim' }, parent, recipes);
  return { state: 'cleaning', holder, resources, recipes };
}

/** reserved→running: the holder's workload may start. Only after `probe` returned clear. */
export function run<H extends AcquiringHolder>(ctx: ResourceContext, r: Reservation<'reserved', H>, parent: Parent): Reservation<'running', H> {
  transition<AcquiringHolder>(ctx, r.holder, r.resources, { type: 'run' }, parent);
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
 * Tears down every instance of a cleaning reservation that declares a teardown, one at a time in lock
 * order. Failures first: their residues are durable and the fail done written before any release of this
 * reservation (DESIGN §2.2). Then the clean subset is released. Recovery calls this to rerun the teardown
 * of a reservation found cleaning.
 */
export async function finishCleanup<H extends Holder>(
  ctx: ResourceContext,
  r: Reservation<'cleaning', H>,
  parent: Parent,
): Promise<CleanupResult<H>> {
  const holder: Holder = r.holder;
  const unit = holderUnit(holder);
  const runs: TeardownRun[] = [];
  for (const resource of r.resources) {
    const recipe = r.recipes.get(resource as ResourceInstance);
    if (recipe !== undefined) runs.push(await teardown(ctx, unit, resource as ResourceInstance, recipe, parent));
  }
  const failed = runs.filter((t) => !t.clean);
  if (failed.length > 0 && (holder.type === 'publication' || holder.type === 'docs')) throw new Error(`${canonicalJson(holder)} holds a unit with a teardown: ${JSON.stringify(r.resources)}`);
  const released = r.resources.filter((res) => !failed.some((t) => t.resource === res));
  if (failed.length > 0 && recordsResidues(r)) recordFailedCleanup(ctx, r, failed, parent);
  if (released.length > 0) transition<Holder>(ctx, r.holder, released, { type: 'release' }, parent);
  const names = failed.map((t) => t.resource);
  const result: CleanupResult<ResidueHolder> | CleanupResult<SweepHolder> = failed.length === 0
    ? { kind: 'released', released }
    : recordsResidues(r) ? { kind: 'cleanup-failed', failed: names, released } : { kind: 'left-cleaning', failed: names, released };
  return result as CleanupResult<H>;
}

function recordsResidues(r: Reservation<'cleaning', Holder>): r is Reservation<'cleaning', ResidueHolder> {
  return r.holder.type === 'stage' || r.holder.type === 'job';
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
// Retry: a retryable park's resource target (F2, F10)

const residueKeyText = (k: ResidueKey): string => canonicalJson(k);

/** Whose residues `holder` reclaims: a retry its unit's, a job its own (G4). */
const reclaimOwner = (holder: ReclaimHolder): string => (holder.type === 'retry' ? `unit ${holder.unit}` : `job ${holder.job}`);
const ownsKey = (holder: ReclaimHolder, key: ResidueKey): boolean => (holder.type === 'retry' ? key.unit === holder.unit : key.job === holder.job);

/**
 * The residue `holder` reclaims `instance` for: this arc's first undisposed one owned by its unit (a retry) or by
 * the job itself, or, once it is disposed (a crash between the disposition and the release), the last recorded
 * one, whose recipe the teardown replays. Null when none names it.
 */
function ownResidue(ctx: ResourceContext, holder: ReclaimHolder, instance: ResourceInstance): Readonly<{ entry: ResidueEntry; open: boolean }> | null {
  const arc = ctx.journal.view.arc;
  const mine = readResidues(ctx.hostDir).flatMap((l) => (l.type === 'residue' && l.key.arc === arc && ownsKey(holder, l.key) && l.key.resource === instance ? [l as ResidueEntry] : []));
  const open = new Set(undispositioned(ctx.hostDir).map(residueKeyText));
  const pending = mine.filter((r) => open.has(residueKeyText(r.key)));
  if (pending.length > 1) throw new Error(`${instance} has ${pending.length} undisposed residues of ${reclaimOwner(holder)}; one cleanup-failed instance has one`);
  if (pending[0] !== undefined) return { entry: pending[0], open: true };
  const last = mine.at(-1);
  return last === undefined ? null : { entry: last, open: false };
}

/**
 * Reclaims one of the unit's own cleanup-failed instances under a retry `holder` (the attempt whose cleanup
 * failed), or one a job's own holder failed under that job holder (G4), in the order that
 * keeps a released instance clean (F2): `reclaim` (cleanup-failed→cleaning) → the residue's recorded teardown
 * (its instance binding included) → on pass the residue's `cleaned` disposition in the host index → `release`.
 * A failed teardown leaves the instance cleaning under `holder` and the residue undisposed: the next probe of the
 * instance resumes from there. Idempotent from every point, so recovery and a later probe call it again after a
 * crash. `pass` means the instance is free and its residue disposed; the caller then writes the `probe` fact.
 */
export async function retryReclaim(ctx: ResourceContext, holder: ReclaimHolder, instance: ResourceInstance, parent: Parent): Promise<'pass' | 'fail'> {
  const entry = entryOf(resourceTable(ctx.journal.view), instance);
  if (entry.pending !== null) throw new Error(`retry of ${instance}: ${entry.pending.op} is still open on it`);
  const { status } = entry;
  const residue = ownResidue(ctx, holder, instance);
  if (status.state === 'free') {
    // Released: the reclaim order finished (a crash came before the caller's probe fact).
    if (residue?.open === true) throw new Error(`${instance} is free with residue ${residueKeyText(residue.entry.key)} undisposed`);
    return 'pass';
  }
  if (residue === null) throw new Error(`retry of ${instance}: no residue of ${reclaimOwner(holder)} names it`);
  if (status.state === 'cleanup-failed') {
    const own = holder.type === 'retry' ? status.holder.type === 'stage' && status.holder.unit === holder.unit : sameHolder(status.holder, holder);
    if (!own) {
      throw new Error(`retry ${canonicalJson(holder)} of ${instance}, which ${canonicalJson(status.holder)} failed: only the ${holder.type === 'retry' ? 'unit' : 'job'}'s own residue is reclaimed`);
    }
    journalTransition(ctx, holder, [instance], { type: 'reclaim' }, parent, new Map());
  } else if (status.state !== 'cleaning' || !sameHolder(status.holder, holder)) {
    throw new Error(`retry ${canonicalJson(holder)} of ${instance}, which is ${status.state} under ${canonicalJson(status.holder)}`);
  }
  const unit = holderUnit(holder);
  const run = await teardown(ctx, unit, instance, { teardown: residue.entry.teardown, label: residue.entry.label }, parent);
  if (!run.clean) return 'fail';
  if (residue.open) {
    crashPoint('retry.before-disposition', unit ?? undefined);
    recordDisposition(ctx.hostDir, { type: 'disposition', key: residue.entry.key, disposition: 'cleaned', by: { arc: ctx.journal.view.arc, inv: run.inv } });
    crashPoint('retry.after-disposition', unit ?? undefined);
  }
  transition(ctx, holder, [instance], { type: 'release' }, parent);
  return 'pass';
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
