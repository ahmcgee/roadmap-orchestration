import { systemName } from '../src/core/ids.ts';
// Pools, `@cpu` tokens and the M2 holders (src/resources/{pool,reserve}.ts): all-or-none requests in lock order,
// the instance binding persisted into residue recipes and replayed by a retry's reclaim, the over-capacity rows
// and the legacy reading of a declared `cpu`, the publication holder; dev.81: capacity read live (res.capacity-live) and
// the `@fast-suite` pool (res.fast-suites).
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,it } from 'node:test';
import {
INTEGRATION_SLOT,type ResourceUnit,cpuToken,fastSuiteToken,laneId,poolInstance,resourceName,unitId,
} from '../src/core/ids.ts';
import type { SpecM1 } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues,undispositioned } from '../src/host/residues.ts';
import { cpuCapacity,defaultFastSuites,fastSuiteCapacity,instanceEnv,instanceEnvVar,overCapacity,overlaps,requestOf } from '../src/resources/pool.ts';
import { probe } from '../src/resources/probe.ts';
import {
type PublicationHolder,
type Refused,
type Reservation,
type RetryHolder,type StageHolder,cleanup,entryOf,heldReservation,reserve,
resourceTable,retryReclaim,run,transition as move,
} from '../src/resources/reserve.ts';
import type { ResourceRequest } from '../src/schedule/types.ts';
import { CPU,DB,ESTATE,QUEUE,newRun,openPoolRun,poolPlanFor } from './fixtures/pool-plan.ts';
import { stageHolder,stageParent,transitions } from './fixtures/res-plan.ts';

const T = { timeout: 60_000 };
const req = (r: Partial<ResourceRequest>): ResourceRequest => ({ named: [], pools: [], cpu: 0, publication: false, ...r });

function granted<H extends StageHolder | PublicationHolder>(r: Reservation<'reserved', H> | Refused): Reservation<'reserved', H> {
  if (r.state === 'refused') throw new Error(`refused: ${r.busy.join(', ')}`);
  return r;
}

const holderOf = (unit: string, stage: StageHolder['stage'] = 'build', attempt = 1): StageHolder => stageHolder(stage, attempt, unitId(unit));

/** Cleans and releases `units` of `holder` (reserved) without teardowns: the table is all allocation reads. */
function transition(ctx: Parameters<typeof reserve>[0], holder: StageHolder, units: readonly ResourceUnit[]): void {
  move(ctx, holder, units, { type: 'clean', from: 'reserved' }, stageParent(holder));
  move(ctx, holder, units, { type: 'release' }, stageParent(holder));
}

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
    assert.deepEqual([residue.teardown.envPass, residue.teardown.env['PATH']], [['PATH'], undefined], 'a passed variable is recorded by name, its value never');
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
  const lane = (id: string, cadence: 'build' | 'unit', state: string, cpu?: number) => ({ id: laneId(id), cadence, state, resources: [], ...(cpu === undefined ? {} : { cpu }) });

  it('a build, a spec lane or a suite lane asking more @cpu than the pool has is a plan-invalid row; judgment and pools cannot exceed', () => {
    const r = newRun();
    const plan = poolPlanFor(r, {
      units: [
        { id: 'u1', spec: 'u1.json', risk: 'low', systems: [systemName('app')], resources: [DB, ESTATE], cpu: 6 },
        { id: 'u2', spec: 'u2.json', risk: 'low', systems: [systemName('app')], resources: [] },
      ],
      suite: { lanes: [{ id: 'suite', argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, cadence: 'candidate', resources: [], evidenceGlobs: [] }] },
    });
    const specs = new Map([[unitId('u2'), spec([lane('big', 'build', 'active', 8), lane('parked', 'unit', 'deferred', 9), lane('ok', 'unit', 'active')])]]);
    assert.deepEqual(overCapacity(plan, { cpu: 4 }, specs), [
      { kind: 'plan-invalid', problem: { type: 'over-capacity', unit: 'u1', lane: null, resource: '@cpu', requested: 6, total: 4 } },
      { kind: 'plan-invalid', problem: { type: 'over-capacity', unit: 'u2', lane: 'big', resource: '@cpu', requested: 8, total: 4 } },
    ]);
    // A small host: the default build (4), the suite's candidate lane (4) and a unit-cadence spec lane (4) exceed 3 too.
    assert.deepEqual(overCapacity(plan, { cpu: 3 }, specs).map((x) => `${x.problem.unit}/${x.problem.lane}:${x.problem.requested}`), [
      'null/suite:4', 'u1/null:6', 'u2/null:4', 'u2/big:8', 'u2/ok:4',
    ]);
    assert.equal(cpuCapacity(plan, 64), CPU, 'plan.capacity.cpu wins');
    assert.equal(cpuCapacity(poolPlanFor(r, { capacity: {} }), 64), 64, 'absent: the host parallelism');
  });
});

// dev.81 (C3b): the token pools are sized by the plan in force at each allocation, so a capacity edit drains nothing.
describe('res.capacity-live', () => {
  it('an increase grants at once; a decrease counts every held token, those above the new size too, and grants nothing until the held fall below it', T, () => {
    const r = newRun();
    const { ctx: base, journal } = openPoolRun(r);
    let cpu = 2;
    const ctx = { ...base, plan: () => ({ ...base.plan(), capacity: { cpu } }) };
    const a = holderOf('a');
    granted(reserve(ctx, a, req({ cpu: 2 }), stageParent(a)));
    const b = holderOf('b');
    assert.deepEqual((reserve(ctx, b, req({ cpu: 1 }), stageParent(b)) as Refused).busy, [cpuToken(1), cpuToken(2)]);
    cpu = 4;
    assert.deepEqual(granted(reserve(ctx, b, req({ cpu: 2 }), stageParent(b))).resources, [cpuToken(3), cpuToken(4)], 'the increase grants at once');

    // a releases @cpu#1..2; b still holds #3..4, above the decreased size 2: nothing is granted while they are held.
    transition(ctx, a, [cpuToken(1), cpuToken(2)]);
    cpu = 2;
    const c = holderOf('c');
    assert.deepEqual((reserve(ctx, c, req({ cpu: 1 }), stageParent(c)) as Refused).busy, [cpuToken(3), cpuToken(4)], 'the holders above the size count');
    transition(ctx, b, [cpuToken(3), cpuToken(4)]);
    assert.deepEqual(granted(reserve(ctx, c, req({ cpu: 2 }), stageParent(c))).resources, [cpuToken(1), cpuToken(2)]);
    journal.close();
  });
});

// dev.81 (C4): the `@fast-suite` pool caps the lanes-stage suite lanes running at once.
describe('res.fast-suites', () => {
  it('a fast-suite request takes one @fast-suite token; at capacity it is refused on the tokens alone; other requests never count; the default is one per 12 GiB', T, () => {
    const r = newRun();
    const { ctx: base, journal } = openPoolRun(r);
    const ctx = { ...base, plan: () => ({ ...base.plan(), capacity: { cpu: CPU, fastSuites: 1 } }) };
    const a = holderOf('a', 'lanes');
    assert.deepEqual(granted(reserve(ctx, a, req({ cpu: 1, fastSuite: true }), stageParent(a))).resources, [cpuToken(1), fastSuiteToken(1)]);
    const b = holderOf('b', 'lanes');
    assert.deepEqual((reserve(ctx, b, req({ cpu: 1, fastSuite: true }), stageParent(b)) as Refused).busy, [fastSuiteToken(1)]);
    const c = holderOf('c', 'candidate');
    assert.deepEqual(granted(reserve(ctx, c, req({ cpu: 1 }), stageParent(c))).resources, [cpuToken(2)], 'a candidate suite lane is not counted');
    transition(ctx, a, [cpuToken(1), fastSuiteToken(1)]);
    assert.deepEqual(granted(reserve(ctx, b, req({ cpu: 1, fastSuite: true }), stageParent(b))).resources, [cpuToken(1), fastSuiteToken(1)]);
    assert.ok(overlaps(req({ fastSuite: true }), req({ fastSuite: true })) && !overlaps(req({ fastSuite: true }), req({ named: [DB] })));

    assert.deepEqual([defaultFastSuites(8), defaultFastSuites(30), defaultFastSuites(64)], [1, 2, 5]);
    assert.equal(fastSuiteCapacity(ctx.plan(), 64), 1, 'plan.capacity.fastSuites wins');
    assert.equal(fastSuiteCapacity(poolPlanFor(r, { capacity: {} }), 30), 2, 'absent: derived from host memory');
    assert.deepEqual(poolPlanFor(r, { capacity: { fastSuites: 3 } }).capacity, { fastSuites: 3 });
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
