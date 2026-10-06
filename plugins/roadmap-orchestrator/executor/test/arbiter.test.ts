// The arbiter (src/schedule/arbiter.ts) over a real journal, with synthetic ranks: rank order, disjoint-only
// backfill, environment-blocked waiters set aside, cancellation holding nothing, a fresh arbiter after a restart,
// and a randomized interleaving (fixed seed) checking that no two holders ever share a unit and that no grant
// overtakes a higher-ranked active waiter it overlaps.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { type ResourceUnit, INTEGRATION_SLOT, arcId, parseResourceUnit, poolInstance, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { isDirty, overlaps } from '../src/resources/pool.ts';
import {
  type AcquiringHolder, type RetryHolder, type StageHolder, cleanup, entryOf, holderUnits, reserve, resourceTable, retryReclaim, run,
  sameHolder, transition,
} from '../src/resources/reserve.ts';
import { type Arbiter, createArbiter } from '../src/schedule/arbiter.ts';
import { type Grant, type Rank, type ResourceRequest, compareRank } from '../src/schedule/types.ts';
import { CACHE, CPU, DB, ESTATE, ESTATE_SIZE, QUEUE, newRun, openPoolRun } from './fixtures/pool-plan.ts';
import { stageHolder, stageParent } from './fixtures/res-plan.ts';

const T = { timeout: 60_000 };
const req = (r: Partial<ResourceRequest>): ResourceRequest => ({ named: [], pools: [], cpu: 0, publication: false, ...r });
const holderOf = (unit: string, attempt = 1): StageHolder => stageHolder('build', attempt, unitId(unit));
const rank = (unit: string, waitStartSeq: number, extra: Partial<Rank> = {}): Rank => ({
  unit: unitId(unit), priority: 'normal', origin: 'planned', waitStartSeq, bypassMerges: 0, promoted: false, planIndex: 0, ...extra,
});

/** Starts a wait and records its answer once it settles. */
function wait(arb: Arbiter, request: ResourceRequest, holder: AcquiringHolder, r: Rank, signal = new AbortController().signal) {
  const box: { grant: Grant | null } = { grant: null };
  const done = arb.acquire(request, holder, () => r, signal).then((g) => (box.grant = g));
  return { box, done };
}

/** Releases what `holder` holds (reserved) without teardowns: the table is all the arbiter reads. */
function release(ctx: Parameters<typeof reserve>[0], holder: StageHolder): void {
  const units = holderUnits(ctx.journal.view, holder);
  transition(ctx, holder, units, { type: 'clean', from: 'reserved' }, stageParent(holder));
  transition(ctx, holder, units, { type: 'release' }, stageParent(holder));
}

describe('arbiter.priority', () => {
  it('waiters on one resource are served promoted-oldest first, then checkpoint before planned, then age', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const x = holderOf('x');
    assert.ok(reserve(ctx, x, req({ named: [DB] }), stageParent(x)).state === 'reserved');
    const ws = [
      ['planned-old', rank('planned-old', 10)],
      ['checkpoint-new', rank('checkpoint-new', 40, { origin: 'checkpoint' })],
      ['promoted-new', rank('promoted-new', 30, { promoted: true, bypassMerges: 3 })],
      ['promoted-old', rank('promoted-old', 20, { promoted: true, bypassMerges: 4 })],
      ['planned-new', rank('planned-new', 50)],
    ] as const;
    const waits = ws.map(([u, rk]) => ({ u, h: holderOf(u), ...wait(arb, req({ named: [DB] }), holderOf(u), rk) }));
    assert.deepEqual(arb.waiting().map((w) => w.holder.unit), ['promoted-old', 'promoted-new', 'checkpoint-new', 'planned-old', 'planned-new']);
    let holder: StageHolder = x;
    const order: string[] = [];
    for (let i = 0; i < ws.length; i++) {
      release(ctx, holder);
      arb.wake();
      await tick();
      const got = waits.filter((w) => w.box.grant !== null && !order.includes(w.u));
      assert.equal(got.length, 1, 'one grant per release');
      assert.deepEqual(got[0]!.box.grant, { kind: 'granted', units: [DB] });
      order.push(got[0]!.u);
      holder = got[0]!.h;
    }
    assert.deepEqual(order, ['promoted-old', 'promoted-new', 'checkpoint-new', 'planned-old', 'planned-new']);
    journal.close();
  });
});

describe('arbiter.priority-first', () => {
  it('a high-priority waiter is served before promoted, checkpoint and older planned ones (M4a rev 3, R42)', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const x = holderOf('x');
    assert.ok(reserve(ctx, x, req({ named: [DB] }), stageParent(x)).state === 'reserved');
    const ws = [
      ['promoted-old', rank('promoted-old', 10, { promoted: true, bypassMerges: 5 })],
      ['checkpoint-old', rank('checkpoint-old', 20, { origin: 'checkpoint' })],
      ['high-new', rank('high-new', 90, { priority: 'high' })],
      ['high-newer', rank('high-newer', 95, { priority: 'high' })],
    ] as const;
    const waits = ws.map(([u, rk]) => ({ u, h: holderOf(u), ...wait(arb, req({ named: [DB] }), holderOf(u), rk) }));
    assert.deepEqual(arb.waiting().map((w) => w.holder.unit), ['high-new', 'high-newer', 'promoted-old', 'checkpoint-old']);
    let holder: StageHolder = x;
    const order: string[] = [];
    for (let i = 0; i < ws.length; i++) {
      release(ctx, holder);
      arb.wake();
      await tick();
      const got = waits.filter((w) => w.box.grant !== null && !order.includes(w.u));
      assert.equal(got.length, 1, 'one grant per release');
      order.push(got[0]!.u);
      holder = got[0]!.h;
    }
    assert.deepEqual(order, ['high-new', 'high-newer', 'promoted-old', 'checkpoint-old']);
    journal.close();
  });
});

describe('arbiter.backfill-no-overtake', () => {
  it('a lower rank passes a blocked higher one only on a disjoint request; one pool (and @cpu) counts as overlapping', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const x = holderOf('x');
    assert.ok(reserve(ctx, x, req({ named: [DB] }), stageParent(x)).state === 'reserved');
    // hi waits on db; queue, estate#1 and every token are free.
    const hi = wait(arb, req({ named: [DB, QUEUE], pools: [ESTATE], cpu: 1 }), holderOf('hi'), rank('hi', 1));
    const sharesNamed = wait(arb, req({ named: [QUEUE] }), holderOf('named'), rank('named', 2));
    const sharesPool = wait(arb, req({ pools: [ESTATE] }), holderOf('pool'), rank('pool', 3));
    const sharesCpu = wait(arb, req({ cpu: 1 }), holderOf('cpu'), rank('cpu', 4));
    const disjoint = wait(arb, req({ named: [CACHE] }), holderOf('disjoint'), rank('disjoint', 5));
    await tick();
    assert.deepEqual(disjoint.box.grant, { kind: 'granted', units: [CACHE] }, 'a disjoint request backfills');
    for (const w of [hi, sharesNamed, sharesPool, sharesCpu]) assert.equal(w.box.grant, null);
    assert.equal(entryOf(resourceTable(journal.view), QUEUE).status.state, 'free', 'nothing hi waits for was given away');
    // db released: hi first, then the rest as far as hi leaves room.
    release(ctx, x);
    arb.wake();
    await tick();
    assert.deepEqual(hi.box.grant, { kind: 'granted', units: [DB, poolInstance(ESTATE, 1), QUEUE, '@cpu#1'] });
    assert.equal(sharesNamed.box.grant, null, 'queue is hi\'s now');
    assert.deepEqual(sharesPool.box.grant, { kind: 'granted', units: [poolInstance(ESTATE, 2)] });
    assert.deepEqual(sharesCpu.box.grant, { kind: 'granted', units: ['@cpu#2'] });
    journal.close();
  });
});

describe('arbiter.env-blocked-no-starve', () => {
  it('a waiter on a residue-dirty resource is set aside, never blocks backfill, and is granted once the residue is disposed', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    // db fails its cleanup: cleanup-failed, with its residue.
    const u1 = holderOf('u1');
    const held = reserve(ctx, u1, req({ named: [DB] }), stageParent(u1));
    assert.ok(held.state === 'reserved');
    writeFileSync(join(r.stateDir, `${DB}.teardown-fails`), '');
    assert.equal((await cleanup(ctx, run(ctx, held, stageParent(u1)), stageParent(u1))).kind, 'cleanup-failed');
    assert.ok(isDirty(entryOf(resourceTable(journal.view), DB)));

    const hi = wait(arb, req({ named: [DB, QUEUE] }), holderOf('hi'), rank('hi', 1, { promoted: true, bypassMerges: 9 }));
    const lo = wait(arb, req({ named: [QUEUE] }), holderOf('lo'), rank('lo', 2));
    await tick();
    assert.deepEqual(arb.waiting().map((w) => [w.holder.unit, w.envBlocked]), [['hi', true]]);
    assert.deepEqual(lo.box.grant, { kind: 'granted', units: [QUEUE] }, 'the set-aside waiter does not block an overlapping lower one');

    // The retry reclaims db (teardown passes now), disposes the residue and releases: hi re-activates.
    const { rmSync } = await import('node:fs');
    rmSync(join(r.stateDir, `${DB}.teardown-fails`));
    const retry: RetryHolder = { type: 'retry', unit: unitId('u1'), stage: 'build', attempt: 1 };
    // Mid-reclaim (cleaning under the retry) db is still dirty.
    const reclaiming = retryReclaim(ctx, retry, DB, { type: 'arc' });
    assert.equal(entryOf(resourceTable(journal.view), DB).status.state, 'cleaning');
    assert.ok(isDirty(entryOf(resourceTable(journal.view), DB)));
    arb.wake();
    assert.equal(arb.waiting()[0]!.envBlocked, true);
    assert.equal(await reclaiming, 'pass');
    arb.wake();
    await tick();
    assert.deepEqual(arb.waiting().map((w) => [w.holder.unit, w.envBlocked]), [['hi', false]], 'active again, waiting for queue');
    release(ctx, holderOf('lo'));
    arb.wake();
    await tick();
    assert.deepEqual(hi.box.grant, { kind: 'granted', units: [DB, QUEUE] });
    journal.close();
  });

  it('a pool with no healthy instance blocks by environment; one healthy but busy instance is an ordinary wait', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const failing = async (unit: string): Promise<void> => {
      const h = holderOf(unit);
      const got = reserve(ctx, h, req({ pools: [ESTATE] }), stageParent(h));
      assert.ok(got.state === 'reserved');
      writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
      assert.equal((await cleanup(ctx, got, stageParent(h))).kind, 'cleanup-failed');
    };
    await failing('a');
    const busy = holderOf('busy');
    assert.ok(reserve(ctx, busy, req({ pools: [ESTATE] }), stageParent(busy)).state === 'reserved');
    const w = wait(arb, req({ pools: [ESTATE], cpu: 1 }), holderOf('w'), rank('w', 1));
    const cpuOnly = wait(arb, req({ cpu: 1 }), holderOf('cpu'), rank('cpu', 2));
    await tick();
    assert.equal(arb.waiting()[0]!.envBlocked, false, 'estate#2 is healthy, only busy');
    assert.equal(cpuOnly.box.grant, null, 'an ordinary blocked waiter holds back an overlapping lower one');
    release(ctx, busy);
    await failing('b');
    arb.wake();
    await tick();
    assert.equal(ESTATE_SIZE, 2);
    assert.deepEqual(arb.waiting().map((x) => [x.holder.unit, x.envBlocked]), [['w', true]], 'both instances dirty');
    assert.deepEqual(cpuOnly.box.grant, { kind: 'granted', units: ['@cpu#1'] });
    assert.equal(w.box.grant, null);
    journal.close();
  });
});

describe('arbiter.cancel-holds-nothing', () => {
  it('a cancelled wait resolves cancelled, journals nothing and is never granted', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const x = holderOf('x');
    assert.ok(reserve(ctx, x, req({ named: [DB] }), stageParent(x)).state === 'reserved');
    const before = journal.view.highWater();
    const ac = new AbortController();
    const w = wait(arb, req({ named: [DB, QUEUE] }), holderOf('w'), rank('w', 1), ac.signal);
    await tick();
    assert.equal(w.box.grant, null);
    ac.abort();
    await w.done;
    assert.deepEqual(w.box.grant, { kind: 'cancelled' });
    assert.equal(journal.view.highWater(), before, 'waiting and cancelling journal nothing');
    assert.deepEqual(arb.waiting(), []);
    release(ctx, x);
    arb.wake();
    assert.equal(entryOf(resourceTable(journal.view), QUEUE).status.state, 'free');
    // Already aborted: cancelled at once, never queued.
    const dead = new AbortController();
    dead.abort();
    assert.deepEqual(await arb.acquire(req({ named: [QUEUE] }), holderOf('late'), () => rank('late', 2), dead.signal), { kind: 'cancelled' });
    assert.deepEqual(arb.waiting(), []);
    // Only stage and publication holders wait here; one wait per holder.
    const retry: RetryHolder = { type: 'retry', unit: unitId('u1'), stage: 'build', attempt: 1 };
    assert.throws(() => arb.acquire(req({ named: [QUEUE] }), retry, () => rank('u1', 3), new AbortController().signal), /does not acquire/);
    journal.close();
  });
});

describe('arbiter.rebuild-after-restart', () => {
  it('a fresh arbiter over the reopened log sees what the dead process held and grants from there', T, async () => {
    const r = newRun();
    const first = openPoolRun(r);
    const x = holderOf('x');
    assert.ok(reserve(first.ctx, x, req({ pools: [ESTATE], cpu: CPU - 1 }), stageParent(x)).state === 'reserved');
    first.journal.close();

    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    const big = wait(arb, req({ cpu: 2 }), holderOf('big'), rank('big', 1));
    const small = wait(arb, req({ pools: [ESTATE] }), holderOf('small'), rank('small', 2));
    await tick();
    assert.equal(big.box.grant, null, 'one token left');
    assert.deepEqual(small.box.grant, { kind: 'granted', units: [poolInstance(ESTATE, 2)] });
    release(ctx, x);
    arb.wake();
    await tick();
    assert.deepEqual(big.box.grant, { kind: 'granted', units: ['@cpu#1', '@cpu#2'] });
    journal.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// res.no-overlap-randomized

/** mulberry32: a small seeded PRNG, so the interleaving is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('res.no-overlap-randomized', () => {
  it('seeded interleavings of waits, grants, releases and cancellations: holders never share a unit, pools and @cpu never exceed, no overtaking', { timeout: 240_000 }, async () => {
    const random = prng(0x5eed_2026);
    const pick = <X>(xs: readonly X[]): X => xs[Math.floor(random() * xs.length)]!;
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const arb = createArbiter(ctx);
    type Live = { holder: StageHolder; request: ResourceRequest; ac: AbortController; grant: Grant | null };
    const live: Live[] = [];
    let serial = 0;
    let grants = 0;
    let cancels = 0;

    const randomRequest = (): ResourceRequest => {
      const named = [DB, QUEUE, CACHE].filter(() => random() < 0.3).sort();
      const pools = random() < 0.4 ? [ESTATE] : [];
      const cpu = random() < 0.7 ? 1 + Math.floor(random() * CPU) : 0;
      const request = req({ named, pools, cpu });
      return named.length + pools.length + cpu === 0 ? req({ cpu: 1 }) : request;
    };

    const check = (before: ReturnType<Arbiter['waiting']>): void => {
      const after = arb.waiting();
      const table = resourceTable(journal.view);
      // 1. Every unit held by at most one live holder, and exactly the shape each asked for.
      const owner = new Map<ResourceUnit, string>();
      for (const l of live) {
        const units = holderUnits(journal.view, l.holder);
        if (units.length === 0) continue;
        for (const u of units) {
          assert.equal(owner.get(u), undefined, `${u} held twice`);
          owner.set(u, l.holder.unit);
        }
        const parts = units.map(parseResourceUnit);
        assert.deepEqual(parts.filter((p) => p.type === 'named').map((p) => p.type === 'named' && p.name), [...l.request.named]);
        assert.deepEqual(parts.filter((p) => p.type === 'instance').map((p) => p.type === 'instance' && p.pool), [...l.request.pools]);
        assert.equal(parts.filter((p) => p.type === 'cpu').length, l.request.cpu);
        assert.equal(units.includes(INTEGRATION_SLOT), false);
      }
      // 2. Pools and @cpu within their size.
      const used = [...table.entries()].filter(([, e]) => e.status.state !== 'free').map(([u]) => parseResourceUnit(u));
      assert.ok(used.filter((p) => p.type === 'cpu').every((p) => p.type === 'cpu' && p.n <= CPU));
      assert.ok(used.filter((p) => p.type === 'instance').every((p) => p.type === 'instance' && p.n <= ESTATE_SIZE));
      // 3. No overtaking: a waiter granted by this wake overlaps no active waiter ranked above it that still waits.
      const stillWaiting = new Set(after.map((w) => w.holder.unit));
      const granted = before.filter((w) => !stillWaiting.has(w.holder.unit));
      for (const g of granted) {
        const at = before.indexOf(g);
        for (const higher of before.slice(0, at)) {
          if (!stillWaiting.has(higher.holder.unit) || higher.envBlocked) continue;
          assert.ok(!overlaps(higher.request, g.request), `${g.holder.unit} overtook ${higher.holder.unit} on an overlapping request`);
        }
      }
      for (const [u, e] of table) assert.ok(!isDirty(e), `${u} dirty`);
    };

    for (let step = 0; step < 300; step++) {
      const roll = random();
      const held = live.filter((l) => l.grant?.kind === 'granted');
      const waiting = live.filter((l) => l.grant === null);
      if (roll < 0.5 || live.length === 0) {
        serial += 1;
        const holder = holderOf(`u${serial}`);
        const l: Live = { holder, request: randomRequest(), ac: new AbortController(), grant: null };
        live.push(l);
        const rk = rank(`u${serial}`, Math.floor(random() * 50), random() < 0.2 ? { promoted: true, bypassMerges: 3 } : { origin: pick(['planned', 'checkpoint'] as const) });
        const before = [...arb.waiting()];
        void arb.acquire(l.request, holder, () => rk, l.ac.signal).then((g) => {
          l.grant = g;
          if (g.kind === 'granted') grants += 1;
          else cancels += 1;
        });
        // acquire evaluates at once: compare against the queue including the new waiter (nothing is dirty here).
        check([...before, { holder, request: l.request, rank: rk, envBlocked: false }].sort((a, b) => compareRank(a.rank, b.rank)));
      } else if (roll < 0.85 && held.length > 0) {
        const l = pick(held);
        release(ctx, l.holder);
        live.splice(live.indexOf(l), 1);
        const before = [...arb.waiting()];
        arb.wake();
        check(before);
      } else if (waiting.length > 0) {
        const l = pick(waiting);
        l.ac.abort();
        live.splice(live.indexOf(l), 1);
        const before = [...arb.waiting()];
        arb.wake();
        check(before);
      }
      await tick();
    }
    // Liveness: with no dirt, releasing everything drains the queue.
    for (let round = 0; arb.waiting().length > 0; round++) {
      assert.ok(round < 500, 'the queue drains');
      for (const l of live.filter((x) => x.grant?.kind === 'granted')) {
        release(ctx, l.holder);
        live.splice(live.indexOf(l), 1);
      }
      arb.wake();
      await tick();
    }
    assert.ok(grants > 50 && cancels > 5, `a meaningful run: ${grants} grants, ${cancels} cancellations`);
    for (const l of live) {
      assert.ok(l.grant?.kind === 'granted');
      assert.ok(holderUnits(journal.view, l.holder).length > 0);
      assert.ok(live.every((o) => o === l || !sameHolder(o.holder, l.holder)));
    }
    journal.close();
    // The fold replays the whole log: the table was a table at every step.
    const reopened = openJournal(absPath(r.runDir), arcId(r.arc));
    reopened.close();
  });
});
