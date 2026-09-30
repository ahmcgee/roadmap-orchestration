// Pools, `@cpu` tokens and the M2 holders (src/resources/{pool,reserve}.ts): all-or-none requests in lock order,
// the instance binding persisted into residue recipes and replayed by a retry's reclaim, the over-capacity rows
// and the legacy reading of a declared `cpu`, the publication holder.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LogRecord } from '../src/core/events.ts';
import {
  type ResourceUnit, INTEGRATION_SLOT, cpuToken, laneId, planRev, poolInstance, resourceName, unitId,
} from '../src/core/ids.ts';
import type { SpecM1 } from '../src/core/records.ts';
import { Fold } from '../src/core/state.ts';
import { prevHash, serializeEvent } from '../src/core/events.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { cpuCapacity, instanceEnv, instanceEnvVar, overCapacity, requestOf } from '../src/resources/pool.ts';
import { probe } from '../src/resources/probe.ts';
import {
  type PublicationHolder, type Reservation, type Refused, type RetryHolder, type StageHolder, cleanup, entryOf, heldReservation, reserve,
  resourceTable, retryReclaim, run,
} from '../src/resources/reserve.ts';
import type { ResourceRequest } from '../src/schedule/types.ts';
import { ARC, H, chain } from './fixtures/log-records.ts';
import { CPU, DB, ESTATE, QUEUE, newRun, openPoolRun, poolPlanFor } from './fixtures/pool-plan.ts';
import { stageHolder, stageParent, transitions } from './fixtures/res-plan.ts';

const T = { timeout: 60_000 };
const req = (r: Partial<ResourceRequest>): ResourceRequest => ({ named: [], pools: [], cpu: 0, publication: false, ...r });

function granted<H extends StageHolder | PublicationHolder>(r: Reservation<'reserved', H> | Refused): Reservation<'reserved', H> {
  if (r.state === 'refused') throw new Error(`refused: ${r.busy.join(', ')}`);
  return r;
}

const holderOf = (unit: string, stage: StageHolder['stage'] = 'build', attempt = 1): StageHolder => stageHolder(stage, attempt, unitId(unit));

function folded(records: readonly LogRecord[]): Fold {
  const f = new Fold(ARC);
  for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}
const planApplied = (scheduling?: 'dag'): LogRecord => ({
  type: 'fact', fact: { kind: 'plan-applied', rev: planRev(1), command: null, planSha256: H, specs: {}, changes: [], ...(scheduling === undefined ? {} : { scheduling }) } as never,
});
const dispatched: LogRecord = {
  type: 'fact',
  fact: { kind: 'dispatch', record: { unit: 'u1', specRev: 1, specSha256: H, scope: ['src/**'], riskFloor: 'low', routingRev: '0123456789abcdef', implementerSeatRev: 'fedcba9876543210', at: '2026-09-25T12:30:00.000Z' } } as never,
};

describe('res.pool-all-or-none', () => {
  it('a request takes its named resources, one instance per pool and its @cpu tokens at once in lock order, or nothing', T, () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const a = holderOf('a');
    const got = granted(reserve(ctx, a, req({ named: [DB], pools: [ESTATE], cpu: 3 }), stageParent(a)));
    assert.deepEqual(got.resources, [DB, poolInstance(ESTATE, 1), cpuToken(1), cpuToken(2), cpuToken(3)]);
    assert.deepEqual([...got.recipes.keys()], [DB, poolInstance(ESTATE, 1)], 'recipes for the instances that declare a teardown only');

    // Two tokens asked, one free: refused, nothing journaled, estate#2 untouched.
    const before = journal.view.highWater();
    const b = holderOf('b');
    const refused = reserve(ctx, b, req({ pools: [ESTATE], cpu: 2 }), stageParent(b));
    assert.equal(refused.state, 'refused');
    assert.deepEqual((refused as Refused).busy, [cpuToken(1), cpuToken(2), cpuToken(3)]);
    assert.equal(journal.view.highWater(), before, 'a refused request journals nothing');
    assert.equal(entryOf(resourceTable(journal.view), poolInstance(ESTATE, 2)).status.state, 'free');

    // One token: the next instance and the last token.
    const c = holderOf('c');
    assert.deepEqual(granted(reserve(ctx, c, req({ pools: [ESTATE], cpu: 1 }), stageParent(c))).resources, [poolInstance(ESTATE, 2), cpuToken(4)]);
    // The pool exhausted: busy names every instance.
    const d = holderOf('d');
    assert.deepEqual((reserve(ctx, d, req({ pools: [ESTATE] }), stageParent(d)) as Refused).busy, [poolInstance(ESTATE, 1), poolInstance(ESTATE, 2)]);
    // A pool is requested by instance, never by name; an M1 name list reads a pool name as one instance.
    assert.throws(() => reserve(ctx, d, req({ named: [ESTATE] }), stageParent(d)), /is a pool/);
    assert.deepEqual(requestOf(ctx.plan(), [ESTATE, INTEGRATION_SLOT, DB], 0), { named: [DB], pools: [ESTATE], cpu: 0, publication: true });

    // Every transition names its set in lock order; the handle is rebuilt from the table.
    for (const t of transitions(r)) assert.equal(t.edge, 'reserve');
    assert.deepEqual(heldReservation(ctx, a, 'reserved'), got);
    journal.close();
  });

  it('released units are granted again: all-or-none never leaves a partial hold', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const a = holderOf('a');
    const held = run(ctx, granted(reserve(ctx, a, req({ cpu: CPU }), stageParent(a))), stageParent(a));
    const b = holderOf('b');
    assert.equal(reserve(ctx, b, req({ named: [QUEUE], cpu: 1 }), stageParent(b)).state, 'refused');
    assert.equal(entryOf(resourceTable(journal.view), QUEUE).status.state, 'free', 'queue was not taken without its token');
    assert.deepEqual(await cleanup(ctx, held, stageParent(a)), { kind: 'released', released: [1, 2, 3, 4].map(cpuToken) });
    assert.deepEqual(granted(reserve(ctx, b, req({ named: [QUEUE], cpu: 1 }), stageParent(b))).resources, [QUEUE, cpuToken(1)]);
    assert.throws(() => reserve(ctx, holderOf('c'), req({ cpu: CPU + 1 }), stageParent(holderOf('c'))), /exceeds the pool/);
    journal.close();
  });
});

describe('res.instance-binding-persisted', () => {
  it('RESOURCE_INSTANCE_<POOL> reaches the probe and teardown, is recorded in the residue recipe, and a retry replays it', T, async () => {
    assert.equal(instanceEnvVar(resourceName('my-pool')), 'RESOURCE_INSTANCE_MY_POOL');
    assert.deepEqual(instanceEnv([DB, poolInstance(ESTATE, 2), cpuToken(1), INTEGRATION_SLOT]), { RESOURCE_INSTANCE_ESTATE: '2' });
    assert.throws(() => instanceEnv([poolInstance(ESTATE, 1), poolInstance(ESTATE, 2)]), /two instances of pool estate/);

    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const other = holderOf('other');
    granted(reserve(ctx, other, req({ pools: [ESTATE] }), stageParent(other)));
    const u1 = holderOf('u1');
    const got = granted(reserve(ctx, u1, req({ named: [DB], pools: [ESTATE] }), stageParent(u1)));
    const instance = poolInstance(ESTATE, 2);
    assert.deepEqual(got.resources, [DB, instance]);
    // The estate fake refuses to run without its binding; the probe finds its instance directory.
    assert.deepEqual(await probe(ctx, got, stageParent(u1)), { kind: 'clear' });
    const held = run(ctx, got, stageParent(u1));
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    const cleaned = await cleanup(ctx, held, stageParent(stageHolder('teardown', 1, unitId('u1'))));
    assert.deepEqual(cleaned, { kind: 'cleanup-failed', failed: [instance], released: [DB] });

    const residues = readResidues(absPath(r.hostDir)).filter((l) => l.type === 'residue');
    assert.equal(residues.length, 1);
    const residue = residues[0]!;
    assert.ok(residue.type === 'residue');
    assert.equal(residue.key.resource, instance);
    assert.equal(residue.teardown.env['RESOURCE_INSTANCE_ESTATE'], '2', 'the binding is in the recorded recipe');
    assert.equal(residue.teardown.env['RESOURCE_OWNER'], `${r.arc}/u1`);
    assert.equal(ctx.journal.view.resources().get(DB)?.status.state, 'free');

    // The retry replays the recorded recipe: the fake tears down estate#2, then the residue is disposed and it is released.
    const retry: RetryHolder = { type: 'retry', unit: unitId('u1'), stage: 'teardown', attempt: 1 };
    assert.equal(await retryReclaim(ctx, retry, instance, { type: 'arc' }), 'pass');
    const calls = readFileSync(join(r.stateDir, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('teardown'));
    assert.deepEqual(calls, [`teardown ${DB} ${r.arc}/u1`, `teardown ${instance} ${r.arc}/u1`, `teardown ${instance} ${r.arc}/u1`]);
    assert.deepEqual(undispositioned(absPath(r.hostDir)), []);
    assert.equal(entryOf(resourceTable(journal.view), instance).status.state, 'free');
    assert.deepEqual(transitions(r).slice(-2).map((t) => `${t.edge} ${t.resources.join(',')}`), [`reclaim ${instance}`, `release ${instance}`]);
    // Idempotent: a second probe of the same target finds the reclaim order complete.
    assert.equal(await retryReclaim(ctx, retry, instance, { type: 'arc' }), 'pass');
    journal.close();
  });

  it('a retry whose teardown fails again leaves the instance cleaning under it and the residue undisposed; the next retry finishes', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const u1 = holderOf('u1');
    const held = run(ctx, granted(reserve(ctx, u1, req({ pools: [ESTATE] }), stageParent(u1))), stageParent(u1));
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    assert.equal((await cleanup(ctx, held, stageParent(u1))).kind, 'cleanup-failed');
    const instance = poolInstance(ESTATE, 1);
    const retry: RetryHolder = { type: 'retry', unit: unitId('u1'), stage: 'build', attempt: 1 };
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    assert.equal(await retryReclaim(ctx, retry, instance, { type: 'arc' }), 'fail');
    const status = entryOf(resourceTable(journal.view), instance).status;
    assert.ok(status.state === 'cleaning' && status.holder.type === 'retry');
    assert.equal(undispositioned(absPath(r.hostDir)).length, 1);
    // Another unit's retry may not take this unit's residue.
    const foreign: RetryHolder = { type: 'retry', unit: unitId('u2'), stage: 'build', attempt: 1 };
    await assert.rejects(retryReclaim(ctx, foreign, instance, { type: 'arc' }), /no residue of unit u2/);
    assert.equal(await retryReclaim(ctx, retry, instance, { type: 'arc' }), 'pass');
    assert.deepEqual(undispositioned(absPath(r.hostDir)), []);
    assert.equal(entryOf(resourceTable(journal.view), instance).status.state, 'free');
    journal.close();
  });
});

describe('res.over-capacity', () => {
  const spec = (lanes: readonly object[]): SpecM1 => ({ lanes } as unknown as SpecM1);
  const lane = (id: string, tier: 'fast' | 'estate', state: string, cpu?: number) => ({ id: laneId(id), tier, state, resources: [], ...(cpu === undefined ? {} : { cpu }) });

  it('a build, a spec lane or a suite lane asking more @cpu than the pool has is a plan-invalid row; judgment and pools cannot exceed', () => {
    const r = newRun();
    const plan = poolPlanFor(r, {
      units: [
        { id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: [DB, ESTATE], cpu: 6 },
        { id: 'u2', spec: 'u2.json', risk: 'low', scope: ['src/**'], resources: [] },
      ],
      suite: { lanes: [{ id: 'suite', argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'estate', resources: [], evidenceGlobs: [] }] },
    });
    const specs = new Map([[unitId('u2'), spec([lane('big', 'fast', 'active', 8), lane('parked', 'estate', 'deferred', 9), lane('ok', 'estate', 'active')])]]);
    assert.deepEqual(overCapacity(plan, { cpu: 4 }, specs, null), [
      { kind: 'plan-invalid', problem: { type: 'over-capacity', unit: 'u1', lane: null, resource: '@cpu', requested: 6, total: 4 } },
      { kind: 'plan-invalid', problem: { type: 'over-capacity', unit: 'u2', lane: 'big', resource: '@cpu', requested: 8, total: 4 } },
    ]);
    // A small host: the default build (4), the suite's estate lane (4) and an estate spec lane (4) exceed 3 too.
    assert.deepEqual(overCapacity(plan, { cpu: 3 }, specs, null).map((x) => `${x.problem.unit}/${x.problem.lane}:${x.problem.requested}`), [
      'null/suite:4', 'u1/null:6', 'u2/null:4', 'u2/big:8', 'u2/ok:4',
    ]);
    // A dag arc is checked like a first start.
    assert.equal(overCapacity(plan, { cpu: 4 }, specs, folded([planApplied('dag')])).length, 2);
    assert.equal(cpuCapacity(plan, 64), CPU, 'plan.capacity.cpu wins');
    assert.equal(cpuCapacity(poolPlanFor(r, { capacity: {} }), 64), 64, 'absent: the host parallelism');
  });
});

describe('res.legacy-named-cpu', () => {
  it('a legacy arc declaring a resource named cpu is never over capacity and reserves the named cpu, no @cpu tokens', T, () => {
    const r = newRun();
    const tool = { argv: ['true'], cwd: '.', env: { set: {}, pass: [] } };
    const plan = poolPlanFor(r, {
      capacity: { cpu: 1 },
      resources: [{ name: 'cpu', probe: tool, teardown: tool }],
      units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: ['cpu'] }],
    });
    const legacy = folded([dispatched, planApplied()]);
    assert.deepEqual(overCapacity(plan, { cpu: 1 }, new Map(), legacy), [], 'legacy: no @cpu request exists to exceed');
    assert.equal(overCapacity(plan, { cpu: 1 }, new Map(), null).length, 1, 'the same plan on a new arc is over capacity');
    const cpu = resourceName('cpu');
    assert.deepEqual(requestOf(plan, [cpu], 0), { named: [cpu], pools: [], cpu: 0, publication: false });

    const { ctx, journal } = openPoolRun(r);
    const legacyCtx = { ...ctx, plan: () => plan };
    const u1 = holderOf('u1');
    // The M1 call form (a name list) is what a legacy arc's stages reserve: the named `cpu`, never a token.
    const got = granted(reserve(legacyCtx, u1, [cpu], stageParent(u1)));
    assert.deepEqual(got.resources, [cpu]);
    assert.deepEqual([...resourceTable(journal.view).keys()], [cpu] as ResourceUnit[]);
    journal.close();
  });
});

describe('res.publication-holder', () => {
  it('publication{unit, attempt} holds integration-slot alone; nobody else reserves the slot meanwhile', T, async () => {
    const r = newRun();
    const { ctx, journal } = openPoolRun(r);
    const pub: PublicationHolder = { type: 'publication', unit: unitId('u1'), attempt: 1 };
    const parent = stageParent(stageHolder('candidate'));
    assert.throws(() => reserve(ctx, pub, req({ publication: true, cpu: 1 }), parent), /integration-slot alone/);
    const got = granted(reserve(ctx, pub, req({ publication: true }), parent));
    assert.deepEqual(got.resources, [INTEGRATION_SLOT]);
    assert.deepEqual(got.recipes, new Map());
    const other: PublicationHolder = { type: 'publication', unit: unitId('u2'), attempt: 1 };
    assert.deepEqual(reserve(ctx, other, req({ publication: true }), parent), { state: 'refused', busy: [INTEGRATION_SLOT] });
    const held = run(ctx, got, parent);
    assert.deepEqual(await cleanup(ctx, held, parent), { kind: 'released', released: [INTEGRATION_SLOT] });
    assert.equal(granted(reserve(ctx, other, req({ publication: true }), parent)).resources[0], INTEGRATION_SLOT);
    journal.close();
  });
});
