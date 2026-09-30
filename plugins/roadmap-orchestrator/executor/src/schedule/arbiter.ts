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
//     - an active waiter whose request overlaps a blocked higher-ranked one (a shared named resource or pool,
//       `@cpu` included, or both publications; `overlaps`) waits: backfill is disjoint-only, so a lower rank never
//       overtakes a higher one on what the higher one waits for.
//     - otherwise `reserve()`: granted, or refused (busy), which blocks it and everything it overlaps below it.
// A wait cancelled by its signal (pause, stop) resolves `cancelled` at once and journals nothing: it held nothing.
//
// The scheduler calls `wake` after every release and disposal and on each tick (src/schedule/scheduler.ts).
import type { Holder, Parent } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import { envBlocked, overlaps } from '../resources/pool.ts';
import {
  type AcquiringHolder, type BatchHolder, type DocsHolder, type JobHolder, type ResourceContext, type UnitAcquiringHolder, reserve, resourceTable, sameHolder,
} from '../resources/reserve.ts';
import { type Acquire, type Grant, type Rank, type ResourceRequest, compareRank } from './types.ts';

/** A units' waiter as `status` shows it, in the order the arbiter serves them. */
export type WaiterView = Readonly<{ holder: UnitAcquiringHolder; request: ResourceRequest; rank: Rank; envBlocked: boolean }>;

/** A job's holder that waits before every unit: a docs publication's slot, a repair batch's slot (M3 B2), or a job's lanes. */
export type FirstHolder = DocsHolder | BatchHolder | JobHolder;

/**
 * Waits for `request` under a job's holder, served before every unit's waiter (A7). `onBlocked` runs at each
 * evaluation that refuses it (the docs publication preempts a candidate holding the slot before green). `parent`: the
 * job a batch holder reserves for (its `batch{finding, attempt}` names no job); none for any other holder.
 */
export type AcquireFirst = (request: ResourceRequest, holder: FirstHolder, signal: AbortSignal, onBlocked?: () => void, parent?: Parent) => Promise<Grant>;

export type Arbiter = Readonly<{
  acquire: Acquire;
  acquireFirst: AcquireFirst;
  /** Re-evaluates every waiter: grants what can be granted now. */
  wake: () => void;
  /** The units' waiters (a job's are not a unit's queue position). */
  waiting: () => readonly WaiterView[];
}>;

type Waiter<H extends AcquiringHolder> = {
  readonly request: ResourceRequest;
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

  const wake = (): void => {
    const plan = ctx.plan();
    const blocked: ResourceRequest[] = [];
    const refused: FirstWaiter[] = [];
    for (const w of [...first]) {
      if (envBlocked(resourceTable(ctx.journal.view), plan, w.request)) continue;
      if (blocked.some((b) => overlaps(b, w.request))) {
        blocked.push(w.request);
        continue;
      }
      const got = reserve(ctx, w.holder, w.request, w.parent);
      if (got.state === 'refused') {
        blocked.push(w.request);
        refused.push(w);
      } else settle(first, w, { kind: 'granted', units: got.resources });
    }
    for (const { w } of ordered()) {
      if (envBlocked(resourceTable(ctx.journal.view), plan, w.request)) continue;
      if (blocked.some((b) => overlaps(b, w.request))) {
        blocked.push(w.request);
        continue;
      }
      const got = reserve(ctx, w.holder, w.request, parentOf(w.holder));
      if (got.state === 'refused') blocked.push(w.request);
      else settle(units, w, { kind: 'granted', units: got.resources });
    }
    // After the evaluation: a preemption releases nothing synchronously, and the next wake grants it.
    for (const w of refused) w.onBlocked();
  };

  const acquire: Acquire = (request, holder, rank, signal) => {
    const h = acquiring(holder);
    if (units.some((w) => sameHolder(w.holder, h))) throw new Error(`${canonicalJson(h)} already waits`);
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise<Grant>((resolve) => {
      const w: UnitWaiter = { request, holder: h, rank, signal, resolve, onAbort: () => settle(units, w, { kind: 'cancelled' }) };
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
      const w: FirstWaiter = { request, holder, signal, resolve, onBlocked, parent: reservedFor, onAbort: () => settle(first, w, { kind: 'cancelled' }) };
      signal.addEventListener('abort', w.onAbort, { once: true });
      first.push(w);
      wake();
    });
  };

  const waiting = (): readonly WaiterView[] => {
    const plan = ctx.plan();
    const table = resourceTable(ctx.journal.view);
    return ordered().map(({ w, rank }) => ({ holder: w.holder, request: w.request, rank, envBlocked: envBlocked(table, plan, w.request) }));
  };

  return { acquire, acquireFirst, wake, waiting };
}
