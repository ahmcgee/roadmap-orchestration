// The arbiter (M2 "Arbiter"; A1, F8, F17): who of the waiting holders gets resources next.
//
// In memory only. Waiters are the pending `acquire` calls; everything else is the fold's resource table, so a
// restarted executor builds a fresh arbiter over the recovered log and its tasks wait again (the arbiter is
// rebuilt, not restored; persisted tickets are deferred, F20). Each evaluation (`wake`) is synchronous and
// grants through the synchronous `reserve()`, all-or-none, so no await separates a grant decision from its
// durable intent.
//
// One evaluation, waiters in rank order (`compareRank`, ranks read fresh):
//   - environment-blocked (F8: a named resource dirty, or a pool without a healthy instance; `envBlocked`) are
//     set aside: never granted, never blocking anyone. They re-activate by themselves once the residue is
//     disposed and the unit released, at the next wake.
//   - an active waiter whose request overlaps a blocked higher-ranked one (a shared named resource or pool,
//     `@cpu` included, or both publications; `overlaps`) waits: backfill is disjoint-only, so a lower rank never
//     overtakes a higher one on what the higher one waits for.
//   - otherwise `reserve()`: granted, or refused (busy), which blocks it and everything it overlaps below it.
// A wait cancelled by its signal (pause, stop) resolves `cancelled` at once and journals nothing: it held nothing.
//
// The scheduler calls `wake` after every release and disposal and on each tick (src/schedule/scheduler.ts).
import type { Holder, Parent } from '../core/events.ts';
import { canonicalJson } from '../core/json.ts';
import { envBlocked, overlaps } from '../resources/pool.ts';
import { type AcquiringHolder, type ResourceContext, reserve, resourceTable, sameHolder } from '../resources/reserve.ts';
import { type Acquire, type Grant, type Rank, type ResourceRequest, compareRank } from './types.ts';

/** A waiter as `status` shows it, in the order the arbiter serves them. */
export type WaiterView = Readonly<{ holder: AcquiringHolder; request: ResourceRequest; rank: Rank; envBlocked: boolean }>;

export type Arbiter = Readonly<{
  acquire: Acquire;
  /** Re-evaluates every waiter: grants what can be granted now. */
  wake: () => void;
  waiting: () => readonly WaiterView[];
}>;

type Waiter = {
  readonly request: ResourceRequest;
  readonly holder: AcquiringHolder;
  readonly rank: () => Rank;
  readonly signal: AbortSignal;
  readonly resolve: (grant: Grant) => void;
  readonly onAbort: () => void;
};

/** The parent of a grant's `reserve` transition: the stage attempt that waits (a publication's is its candidate). */
function parentOf(holder: AcquiringHolder): Parent {
  return holder.type === 'stage'
    ? { type: 'stage', unit: holder.unit, stage: holder.stage, attempt: holder.attempt }
    : { type: 'stage', unit: holder.unit, stage: 'candidate', attempt: holder.attempt };
}

function acquiring(holder: Holder): AcquiringHolder {
  if (holder.type !== 'stage' && holder.type !== 'publication') throw new Error(`${canonicalJson(holder)} does not acquire through the arbiter`);
  return holder;
}

export function createArbiter(ctx: ResourceContext): Arbiter {
  const queue: Waiter[] = [];

  const settle = (w: Waiter, grant: Grant): void => {
    const i = queue.indexOf(w);
    if (i === -1) throw new Error(`${canonicalJson(w.holder)} settled twice`);
    queue.splice(i, 1);
    w.signal.removeEventListener('abort', w.onAbort);
    w.resolve(grant);
  };

  const ordered = (): readonly Readonly<{ w: Waiter; rank: Rank }>[] =>
    queue.map((w) => ({ w, rank: w.rank() })).sort((a, b) => compareRank(a.rank, b.rank));

  const wake = (): void => {
    const plan = ctx.plan();
    const blocked: ResourceRequest[] = [];
    for (const { w } of ordered()) {
      if (envBlocked(resourceTable(ctx.journal.view), plan, w.request)) continue;
      if (blocked.some((b) => overlaps(b, w.request))) {
        blocked.push(w.request);
        continue;
      }
      const got = reserve(ctx, w.holder, w.request, parentOf(w.holder));
      if (got.state === 'refused') blocked.push(w.request);
      else settle(w, { kind: 'granted', units: got.resources });
    }
  };

  const acquire: Acquire = (request, holder, rank, signal) => {
    const h = acquiring(holder);
    if (queue.some((w) => sameHolder(w.holder, h))) throw new Error(`${canonicalJson(h)} already waits`);
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise<Grant>((resolve) => {
      const w: Waiter = { request, holder: h, rank, signal, resolve, onAbort: () => settle(w, { kind: 'cancelled' }) };
      signal.addEventListener('abort', w.onAbort, { once: true });
      queue.push(w);
      wake();
    });
  };

  const waiting = (): readonly WaiterView[] => {
    const plan = ctx.plan();
    const table = resourceTable(ctx.journal.view);
    return ordered().map(({ w, rank }) => ({ holder: w.holder, request: w.request, rank, envBlocked: envBlocked(table, plan, w.request) }));
  };

  return { acquire, wake, waiting };
}
