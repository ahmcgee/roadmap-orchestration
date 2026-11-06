import { workloadCpu } from '../core/cpu.ts';
import type { WaitReason } from '../core/waiting.ts';
import { WaitAccumulator } from './waits.ts';
// The arbiter (M2 "Arbiter"; A1, F8, F17): who of the waiting holders gets resources next.
//
// In memory only. Waiters are the pending `acquire` calls; everything else is the fold's resource table, so a
// restarted executor builds a fresh arbiter over the recovered log and its tasks wait again (the arbiter is
// rebuilt, not restored; persisted tickets are deferred, F20). Each evaluation (`wake`) is synchronous and
// grants through the synchronous `reserve()`, all-or-none, so no await separates a grant decision from its
// durable intent.
//
// One evaluation:
//   - first the jobs' waiters (M3, A7: a docs publication's slot and its lanes, `acquireFirst`), in arrival order:
//     a docs publication outranks every unit publication. One that is refused blocks what it overlaps below it,
//     and its `onBlocked` runs (the docs publication preempts a candidate holding the slot before green).
//   - then the units' waiters in rank order (`compareRank`, ranks read fresh):
//     - environment-blocked (F8: a named resource dirty, or a pool without a healthy instance; `envBlocked`) are
//       set aside: never granted, never blocking anyone. They re-activate by themselves once the residue is
//       disposed and the unit released, at the next wake.
//     - pressure-held workloads are also set aside before overlap checks, including jobs before unit judgments.
//     - an active waiter whose request overlaps a blocked higher-ranked one (a shared named resource or pool,
//       `@cpu` included, or both publications; `overlaps`) waits: backfill is disjoint-only, so a lower rank never
//       overtakes a higher one on what the higher one waits for.
//     - otherwise `reserve()`: granted, or refused (busy), which blocks it and everything it overlaps below it.
// A wait cancelled by its signal (pause, stop) resolves `cancelled` at once and journals nothing: it held nothing.
//
// The scheduler calls `wake` after every release and disposal and on each tick (src/schedule/scheduler.ts).
import { PressureTicks, PRESSURE_SATURATED, hostCpuPressure } from '../host/pressure.ts';
import { parseResourceUnit } from '../core/ids.ts';
import type { Holder, Parent } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import { allocate, envBlocked, overlaps } from '../resources/pool.ts';
import {
  type AcquiringHolder, type BatchHolder, type DocsHolder, type JobHolder, type ResourceContext, type UnitAcquiringHolder, reserve, resourceTable, sameHolder, publicationOwner, holderUnits,
} from '../resources/reserve.ts';
import { type Acquire, type CandidateEntry, type Grant, type Rank, type ResourceRequest, compareRank } from './types.ts';

/** A units' waiter as `status` shows it, in the order the arbiter serves them. */
export type WaiterView = Readonly<{ holder: UnitAcquiringHolder; request: ResourceRequest; rank: Rank; envBlocked: boolean; pressureBlocked: boolean; queuedAt: number; reasons?: readonly WaitReason[] }>;

/** A job's holder that waits before every unit: a docs publication's slot, a repair batch's slot (M3 B2), or a job's lanes. */
export type FirstHolder = DocsHolder | BatchHolder | JobHolder;

/**
 * Waits for `request` under a job's holder, served before every unit's waiter (A7). `onBlocked` runs at each
 * evaluation that refuses it (the docs publication preempts a candidate holding the slot before green). `parent`: the
 * job a batch holder reserves for (its `batch{finding, attempt}` names no job); none for any other holder.
 */
export type AcquireFirst = (request: ResourceRequest, holder: FirstHolder, signal: AbortSignal, onBlocked?: () => void, parent?: Parent) => Promise<Grant>;

export type Arbiter = Readonly<{
  pressure: PressureTicks;
  acquire: Acquire;
  acquireFirst: AcquireFirst;
  /** Re-evaluates every waiter: grants what can be granted now. */
  wake: () => void;
  /** The units' waiters (a job's are not a unit's queue position). */
  waiting: () => readonly WaiterView[];
  /** M3 (B7): the jobs' waiters (a docs publication's slot, a batch's slot, a job's lanes), served first, in arrival order. */
  waitingFirst: () => readonly FirstWaiterView[];
}>;

/** A job's waiter as `sched.json` lists it, in the order the arbiter serves them (before every unit). */
export type FirstWaiterView = Readonly<{ holder: FirstHolder; request: ResourceRequest; envBlocked: boolean; pressureBlocked: boolean; queuedAt: number; reasons?: readonly WaitReason[] }>;

type Waiter<H extends AcquiringHolder> = {
  readonly queuedAt: number;
  readonly wait: WaitAccumulator;
  request: ResourceRequest;
  readonly entry?: CandidateEntry;
  readonly holder: H;
  readonly signal: AbortSignal;
  readonly resolve: (grant: Grant) => void;
  readonly onAbort: () => void;
};
type UnitWaiter = Waiter<UnitAcquiringHolder> & { readonly rank: () => Rank };
type FirstWaiter = Waiter<FirstHolder> & { readonly onBlocked: () => void; readonly parent: Parent };

/** The parent of a grant's `reserve` transition: the stage attempt that waits (a publication's is its candidate), or the job. */
function parentOf(holder: AcquiringHolder): Parent {
  switch (holder.type) {
    case 'stage':
      return { type: 'stage', unit: holder.unit, stage: holder.stage, attempt: holder.attempt };
    case 'publication':
      return { type: 'stage', unit: holder.unit, stage: 'candidate', attempt: holder.attempt };
    case 'docs':
      return { type: 'job', job: holder.pub };
    case 'job':
      return { type: 'job', job: holder.job };
    case 'batch':
      throw new Error(`${canonicalJson(holder)}: a batch holder's parent is its job, given to acquireFirst`);
  }
}

function acquiring(holder: Holder): UnitAcquiringHolder {
  if (holder.type !== 'stage' && holder.type !== 'publication') throw new Error(`${canonicalJson(holder)} does not acquire as a unit (a job's holder uses acquireFirst)`);
  return holder;
}

export function createArbiter(ctx: ResourceContext): Arbiter {
  const pressure = new PressureTicks();
  const units: UnitWaiter[] = [];
  const first: FirstWaiter[] = [];

  const settle = <W extends UnitWaiter | FirstWaiter>(queue: W[], w: W, grant: Grant): void => {
    const i = queue.indexOf(w);
    if (i === -1) throw new Error(`${canonicalJson(w.holder)} settled twice`);
    queue.splice(i, 1);
    w.signal.removeEventListener('abort', w.onAbort);
    w.resolve(grant);
  };

  const ordered = (): readonly Readonly<{ w: UnitWaiter; rank: Rank }>[] =>
    units.map((w) => ({ w, rank: w.rank() })).sort((a, b) => compareRank(a.rank, b.rank));

  const pressureReasons = (w: UnitWaiter | FirstWaiter): WaitReason[] => {
    if (w.request.cpu === 0) return [];
    const h = w.holder;
    const workload = workloadCpu(h, w.request.cpu, w.request.cpuBasis);
    if (!workload) return [];
    const reasons: WaitReason[] = [];
    if ((pressure.memory() ?? 0) >= PRESSURE_SATURATED) reasons.push('memory-pressure');
    const owner = publicationOwner(ctx.journal.view);
    const ownsSlot = owner !== null && sameHolder(owner, h);
    if (!ownsSlot && (hostCpuPressure(pressure.ticks(), 0) ?? 0) >= PRESSURE_SATURATED && [...resourceTable(ctx.journal.view)].some(([u, e]) => parseResourceUnit(u).type === 'cpu' && (e.workload === true || (e.pending?.expect.edge.type === 'reserve' && workloadCpu(e.pending.expect.holder, 1, e.pending.expect.cpuBasis))))) reasons.push('cpu-pressure');
    return reasons;
  };

  const reasonsFor = (w: UnitWaiter | FirstWaiter, blocked: readonly ResourceRequest[]): readonly WaitReason[] => {
    const reasons = pressureReasons(w);
    const allocation = allocate(resourceTable(ctx.journal.view), ctx.plan(), w.request);
    if (allocation.kind === 'busy') for (const unit of allocation.busy) {
      const parsed = parseResourceUnit(unit);
      reasons.push(parsed.type === 'cpu' ? 'cpu-tokens' : unit === 'integration-slot' ? 'publication-slot' : `named-resource:${parsed.type === 'instance' ? parsed.pool : unit}`);
    }
    if (blocked.some((b) => overlaps(b, w.request))) reasons.push('queue-precedence');
    return [...new Set(reasons)];
  };

  const wake = (): void => {
    const plan = ctx.plan();
    const blocked: ResourceRequest[] = [];
    const refused: FirstWaiter[] = [];
    const evaluate = <W extends UnitWaiter | FirstWaiter>(queue: W[], w: W, parent: Parent): void => {
      if (w.entry !== undefined) w.request = w.entry.refresh();
      const reasons = reasonsFor(w, blocked);
      w.wait.observe(reasons);
      if (reasons.length > 0) {
        if ('onBlocked' in w) refused.push(w as FirstWaiter);
        if (w.request.publication && reasons.includes('publication-slot')) blocked.push({ named: [], pools: [], cpu: 0, publication: true });
        else if (!envBlocked(resourceTable(ctx.journal.view), plan, w.request) && pressureReasons(w).length === 0) blocked.push(w.request);
        return;
      }
      const got = reserve(ctx, w.holder, w.request, parent, Math.max(0, Date.now() - w.queuedAt), w.wait.measured(), w.entry?.slotHolder);
      if (got.state === 'refused') throw new Error('availability changed during synchronous reservation');
      settle(queue, w, { kind: 'granted', units: got.resources });
    };
    for (const w of [...first]) evaluate(first, w, w.parent);
    for (const { w } of ordered()) evaluate(units, w, parentOf(w.holder));
    for (const w of refused) w.onBlocked();
  };

  const acquire: Acquire = (request, holder, rank, signal, entry) => {
    const h = acquiring(holder);
    if (request.publication && holderUnits(ctx.journal.view, h).some((u) => u !== 'integration-slot')) throw new Error('cannot wait for publication while retaining workload resources');
    if (units.some((w) => sameHolder(w.holder, h))) throw new Error(`${canonicalJson(h)} already waits`);
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise<Grant>((resolve) => {
      const w: UnitWaiter = { queuedAt: Date.now(), wait: new WaitAccumulator(), request, ...(entry === undefined ? {} : { entry }), holder: h, rank, signal, resolve, onAbort: () => settle(units, w, { kind: 'cancelled' }) };
      signal.addEventListener('abort', w.onAbort, { once: true });
      units.push(w);
      wake();
    });
  };

  const acquireFirst: AcquireFirst = (request, holder, signal, onBlocked = () => {}, parent) => {
    if (first.some((w) => sameHolder(w.holder, holder))) throw new Error(`${canonicalJson(holder)} already waits`);
    if ((holder.type === 'docs' || holder.type === 'batch') && !(request.publication && request.named.length === 0 && request.pools.length === 0 && request.cpu === 0)) {
      throw new Error(`a ${holder.type} holder waits for integration-slot alone, not ${canonicalJson(request)}`);
    }
    if ((holder.type === 'batch') !== (parent !== undefined)) throw new Error(`${canonicalJson(holder)}: a parent is given exactly for a batch holder`);
    const reservedFor = parent ?? parentOf(holder);
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise<Grant>((resolve) => {
      const w: FirstWaiter = { queuedAt: Date.now(), wait: new WaitAccumulator(), request, holder, signal, resolve, onBlocked, parent: reservedFor, onAbort: () => settle(first, w, { kind: 'cancelled' }) };
      signal.addEventListener('abort', w.onAbort, { once: true });
      first.push(w);
      wake();
    });
  };

  const waiting = (): readonly WaiterView[] => {
    const plan = ctx.plan();
    const table = resourceTable(ctx.journal.view);
    return ordered().map(({ w, rank }) => ({ holder: w.holder, request: w.request, rank, envBlocked: envBlocked(table, plan, w.request), pressureBlocked: pressureReasons(w).length > 0, queuedAt: w.queuedAt, reasons: w.wait.reasons() }));
  };

  const waitingFirst = (): readonly FirstWaiterView[] => {
    const plan = ctx.plan();
    const table = resourceTable(ctx.journal.view);
    return first.map((w) => ({ holder: w.holder, request: w.request, envBlocked: envBlocked(table, plan, w.request), pressureBlocked: pressureReasons(w).length > 0, queuedAt: w.queuedAt, reasons: w.wait.reasons() }));
  };

  return { pressure, acquire, acquireFirst, wake, waiting, waitingFirst };
}
