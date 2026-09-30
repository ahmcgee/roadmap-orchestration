// The reservation cycle on the live path (src/resources/reserve.ts): real `invoke` with res-tool.ts as the
// declared probe and teardown, the fake backend where the holder is a backend, and the resource table
// derived from the journal after every step.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { sessionContainment } from '../src/contain/session.ts';
import type { Holder } from '../src/core/events.ts';
import { type ResourceName, INTEGRATION_SLOT, commandId, invocationId, namedResource, opId, unitId } from '../src/core/ids.ts';
import { specM1 } from '../src/core/records.ts';
import { invocationDir, invoke } from '../src/pipeline/invoke.ts';
import { probe } from '../src/resources/probe.ts';
import {
  type Reservation, type ResourceContext, type StageHolder, type SweepHolder, cancel, checkLaneTiers, cleanup, entryOf, fastLanes,
  lockOrder, reserve, reserveForSweep, resourceTable, run, transition,
} from '../src/resources/reserve.ts';
import { stageRecipes } from '../src/resources/teardown.ts';
import { renderSpec } from '../src/spec/render.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { waitFor } from './helpers/invocation.ts';
import { backend, dones, intents, scenario, specFor } from './fixtures/invoke-specs.ts';
import {
  CACHE, DB, QUEUE, type ResRun, UNIT, calls, laneInvocation, newRun, openRun, stageHolder, stageParent, tableOf, transitions,
} from './fixtures/res-plan.ts';

const T = { timeout: 60_000 };

function reserved<S extends Reservation<'reserved', StageHolder>>(r: S | { state: 'refused'; busy: readonly ResourceName[] }): S {
  if (r.state === 'refused') throw new Error(`refused: ${r.busy.join(', ')}`);
  return r;
}

/** The table of the live journal, as {resource: state@holder}. */
function states(ctx: ResourceContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [r, e] of resourceTable(ctx.journal.view)) {
    const s = e.status;
    out[r] = s.state === 'free' ? 'free' : `${s.state}@${s.holder.type === 'stage' ? `${s.holder.unit}/${s.holder.stage}/${s.holder.attempt}` : s.holder.type === 'sweep' ? s.holder.command : JSON.stringify(s.holder)}`;
  }
  return out;
}

test('res.cycle-per-stage', T, async () => {
  const r = newRun();
  const { ctx, journal } = openRun(r);
  const stages = [
    // The build holds the unit's declared resources for its whole run; its workload is a backend.
    { holder: stageHolder('build'), resources: [QUEUE, DB], work: () => invoke(journal, ctx.containment, specFor(backend({ runDir: r.runDir, arc: r.arc, work: r.repo }, scenario([{ as: 'claude', expect: {}, acts: [{ type: 'emit', value: { ok: true } }] }])))) },
    { holder: stageHolder('lanes'), resources: [DB], work: () => laneInvocation(ctx, stageHolder('lanes')) },
    { holder: stageHolder('candidate'), resources: [INTEGRATION_SLOT, CACHE], work: () => laneInvocation(ctx, stageHolder('candidate'), 'suite') },
  ];
  for (const { holder, resources, work } of stages) {
    const key = `${holder.unit}/${holder.stage}/${holder.attempt}`;
    const ordered = lockOrder(resources);
    const res = reserved(reserve(ctx, holder, resources, stageParent(holder)));
    assert.deepEqual(res.resources, ordered);
    assert.deepEqual(Object.fromEntries(ordered.map((x) => [x, states(ctx)[x]])), Object.fromEntries(ordered.map((x) => [x, `reserved@${key}`])));
    assert.deepEqual(await probe(ctx, res, stageParent(holder)), { kind: 'clear' });
    const running = run(ctx, res, stageParent(holder));
    assert.equal(states(ctx)[ordered[0]!], `running@${key}`);
    const outcome = await work();
    assert.equal(outcome.kind, 'result');
    assert.deepEqual(await cleanup(ctx, running, stageParent(holder)), { kind: 'released', released: ordered });
    assert.ok(ordered.every((x) => states(ctx)[x] === 'free'), JSON.stringify(states(ctx)));
    assert.deepEqual(transitions(r).filter((t) => t.holder === key), [
      { holder: key, resources: ordered, edge: 'reserve' },
      { holder: key, resources: ordered, edge: 'run' },
      { holder: key, resources: ordered, edge: 'clean', from: 'running' },
      { holder: key, resources: ordered, edge: 'release' },
    ]);
  }
  journal.close();
  // Every declared resource was probed before its run and torn down after it; the slot declares neither.
  assert.deepEqual(calls(r).map((c) => c.split(' ').slice(0, 2).join(' ')), [
    'probe db', 'probe queue', 'teardown db', 'teardown queue',
    'probe db', 'teardown db',
    'probe cache', 'teardown cache',
  ]);
  assert.ok(calls(r).every((c) => c.endsWith(` ${r.arc}/u1`)), 'every command carries the unit\'s owner label');
  const spawned = intents(r.runDir, 'proc.spawn').map((i) => (i.kind === 'proc.spawn' ? i.expect.subject.purpose : null));
  assert.deepEqual(spawned, ['probe', 'probe', 'backend', 'teardown', 'teardown', 'probe', 'lane', 'teardown', 'probe', 'lane', 'teardown']);
  assert.deepEqual([...tableOf(r).values()].map((s) => s.state), ['free', 'free', 'free', 'free']);
});

test('res.all-or-none', T, async () => {
  const r = newRun();
  const { ctx, journal } = openRun(r);
  const a = reserved(reserve(ctx, stageHolder('build'), [DB], stageParent(stageHolder('build'))));
  const seq = journal.view.highWater();
  const other = stageHolder('build', 1, unitId('u2'));
  assert.deepEqual(reserve(ctx, other, [CACHE, DB, INTEGRATION_SLOT], stageParent(other)), { state: 'refused', busy: [DB] });
  assert.equal(journal.view.highWater(), seq, 'a refusal journals nothing');
  assert.equal(entryOf(resourceTable(journal.view), CACHE).status.state, 'free', 'the free part of a refused set stays free');
  assert.equal(entryOf(resourceTable(journal.view), INTEGRATION_SLOT).status.state, 'free');
  // Once the holder releases, the same request succeeds as one transition of the whole set.
  await cleanup(ctx, a, stageParent(stageHolder('build')));
  const b = reserved(reserve(ctx, other, [CACHE, DB, INTEGRATION_SLOT], stageParent(other)));
  assert.deepEqual(b.resources, [CACHE, DB, INTEGRATION_SLOT]);
  assert.equal(transitions(r).filter((t) => t.edge === 'reserve').length, 2);
  await cleanup(ctx, b, stageParent(other));
  journal.close();
});

test('res.lock-order', { timeout: 180_000 }, async () => {
  // Two stages of two units contend for overlapping sets in one process; each retries a refused reserve
  // after a random pause and holds for a random time. 50 randomised runs, ten at a time.
  const u2 = unitId('u2');
  const requests: readonly (readonly [StageHolder, readonly ResourceName[]])[] = [
    [stageHolder('build'), [QUEUE, INTEGRATION_SLOT, DB]],
    [stageHolder('candidate', 1, u2), [INTEGRATION_SLOT, DB, CACHE]],
  ];
  const oneRun = async (): Promise<void> => {
    const r = newRun();
    const { ctx, journal } = openRun(r);
    let refusals = 0;
    const actor = async ([holder, resources]: readonly [StageHolder, readonly ResourceName[]]): Promise<void> => {
      await sleep(Math.random() * 20);
      for (;;) {
        const before = journal.view.highWater();
        const got = reserve(ctx, holder, resources, stageParent(holder));
        if (got.state === 'reserved') {
          assert.deepEqual(await probe(ctx, got, stageParent(holder)), { kind: 'clear' });
          const running = run(ctx, got, stageParent(holder));
          await sleep(Math.random() * 30);
          assert.equal((await cleanup(ctx, running, stageParent(holder))).kind, 'released');
          return;
        }
        refusals += 1;
        assert.equal(journal.view.highWater(), before, 'a refused reserve journals nothing');
        assert.ok(got.busy.length > 0 && got.busy.every((x) => resources.includes(x)));
        await sleep(Math.random() * 20);
      }
    };
    await Promise.all(requests.map(actor));
    journal.close();
    const ts = transitions(r);
    // Every transition names its set in lock order, integration-slot last.
    for (const t of ts) assert.deepEqual(t.resources, lockOrder(t.resources.map(namedResource)), JSON.stringify(t));
    // Never two holders at once: replaying the log never reserves a held resource (the fold refuses
    // that), and each reservation is contiguous: its reserve is followed by its own run, clean, release
    // before the other holder's reserve of a shared resource.
    const table = tableOf(r);
    assert.ok([...table.values()].every((s) => s.state === 'free'));
    const reserves = ts.filter((t) => t.edge === 'reserve');
    assert.equal(reserves.length, 2, 'each actor reserved exactly once: refusals wrote nothing');
    const firstRelease = ts.findIndex((t) => t.edge === 'release');
    assert.ok(ts.indexOf(reserves[1]!) > firstRelease, `the second reserve waits for the first release: ${JSON.stringify(ts)} (${refusals} refusals)`);
  };
  for (let batch = 0; batch < 5; batch++) await Promise.all(Array.from({ length: 10 }, oneRun));
});

test('res.estate-refused-for-implementer', () => {
  const lane = (id: string, tier: 'fast' | 'estate', resources: readonly string[], state = 'active') => ({
    id, argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier, resources, evidenceGlobs: [], state,
  });
  const spec = (lanes: readonly unknown[]) => specM1({
    schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes,
    acceptance: [{ id: 'A1', clause: 'It works.', failLoudIfUndelivered: true, state: 'active' }],
    scope: ['src/**'], resources: ['db', 'queue'], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
  }, 'spec');
  const r = newRun();
  const { ctx, journal } = openRun(r);
  journal.close();
  const unit = ctx.plan().units[0]!;

  // Fast lanes within the build's own resources, estate lanes needing anything: accepted.
  const ok = spec([lane('unit', 'fast', ['db']), lane('e2e', 'estate', ['cache', 'db']), lane('old', 'fast', ['cache'], 'struck')]);
  assert.deepEqual(checkLaneTiers(ok, unit), []);
  // The implementer's lane list is the fast lanes, and the build prompt shows exactly those.
  assert.deepEqual(fastLanes(ok).map((l) => l.id), ['unit', 'old']);
  const lanesSection = (text: string): string[] => [...text.split('## Lanes')[1]!.split('## Resources')[0]!.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
  assert.deepEqual(lanesSection(renderSpec(ok, { fastLanesOnly: true })), fastLanes(ok).map((l) => l.id));
  assert.ok(!renderSpec(ok, { fastLanesOnly: true }).includes('e2e'), 'no estate lane is even mentioned to the implementer');
  assert.deepEqual(lanesSection(renderSpec(ok)), ['unit', 'e2e', 'old'], 'the executor view keeps every lane');

  // A fast lane that needs a resource the build does not hold gives the implementer estate: refused.
  const bad = spec([lane('unit', 'fast', ['db']), lane('smoke', 'fast', ['cache', 'db'])]);
  assert.deepEqual(checkLaneTiers(bad, unit), [
    { kind: 'spec-lane-unrunnable', unit: 'u1', lane: 'smoke', problem: { type: 'estate-lane-for-implementer' } },
  ]);
});

test('res.cancel-kills-then-cleans', T, async () => {
  const r = newRun();
  const { ctx, journal } = openRun(r);
  const holder = stageHolder('build');
  const res = reserved(reserve(ctx, holder, [DB], stageParent(holder)));
  assert.deepEqual(await probe(ctx, res, stageParent(holder)), { kind: 'clear' });
  const running = run(ctx, res, stageParent(holder));
  const inv = invocationId(opId(journal.view.arc, journal.view.highWater() + 1), 1);
  const work = laneInvocation(ctx, holder, 'spec', 'setTimeout(() => {}, 60_000)');
  const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
  const child = await waitFor('the lane workload started', 10_000, () => files.read('runner.json')?.child ?? null);

  const result = await cancel(ctx, running, inv, 'pause', stageParent(holder));
  assert.deepEqual(result, { kind: 'released', released: [DB] });
  assert.equal(sessionContainment.empty({ inv, child }), true, 'the holder\'s workload is gone');
  const outcome = await work;
  assert.ok(outcome.kind === 'result' && outcome.result.type === 'command' && outcome.result.verdict === 'cancelled' && outcome.result.reason === 'pause', JSON.stringify(outcome));
  journal.close();

  // Order in the log: the kill is done (quiescent) before the reservation starts cleaning.
  const log = intents(r.runDir, 'proc.kill').concat(intents(r.runDir, 'resource.transition'));
  const kill = log.find((i) => i.kind === 'proc.kill');
  assert.ok(kill !== undefined && kill.kind === 'proc.kill' && kill.expect.reason === 'pause' && kill.expect.inv === inv);
  const killDone = dones(r.runDir, 'proc.kill').find((d) => d.op === kill.op);
  assert.ok(killDone !== undefined);
  const clean = intents(r.runDir, 'resource.transition').find((i) => i.kind === 'resource.transition' && i.expect.edge.type === 'clean');
  assert.ok(clean !== undefined && clean.kind === 'resource.transition');
  assert.ok(Number(clean.op.split('/')[1]) > Number(kill.op.split('/')[1]), 'clean after the kill');
  assert.deepEqual(clean.expect.edge, { type: 'clean', from: 'running' });
  assert.deepEqual(calls(r).map((c) => c.split(' ').slice(0, 2).join(' ')), ['probe db', 'teardown db']);
});

test('res.sweep-cannot-fail', T, async () => {
  const r = newRun();
  const { ctx, journal } = openRun(r);
  const sweep: SweepHolder = { type: 'sweep', command: commandId('cmd-00000000000000aa') };
  const parent = { type: 'command', command: sweep.command } as const;
  const teardownInv = invocationId(opId(journal.view.arc, 1), 1);

  // Compile time: a sweep has no fail edge and never runs.
  assert.throws(
    // @ts-expect-error a sweep holder cannot take a fail transition
    () => transition(ctx, sweep, [QUEUE], { type: 'fail', residues: [{ resource: QUEUE, teardown: teardownInv }] }, parent),
    /only by a stage holder's cleanup/,
  );
  // Run time, for callers that bypass the types: refused before anything is journaled.
  assert.throws(() => transition(ctx, sweep as Holder, [QUEUE], { type: 'run' }, parent), /cannot run a workload/);
  assert.equal(journal.view.highWater(), 0);

  // A sweep whose teardown fails leaves the resource cleaning under the sweep: no fail, no residue, no release.
  writeFileSync(join(r.stateDir, `${QUEUE}.teardown-fails`), '');
  const got = reserveForSweep(ctx, sweep, stageRecipes(ctx.plan(), ctx.repo, UNIT, [QUEUE]), parent);
  assert.ok(got.state === 'reserved');
  // @ts-expect-error a sweep reservation cannot run
  assert.throws(() => run(ctx, got, parent), /cannot run a workload/);
  assert.deepEqual(await cleanup(ctx, got, parent), { kind: 'left-cleaning', failed: [QUEUE], released: [] });
  assert.deepEqual(transitions(r).map((t) => t.edge), ['reserve', 'clean']);
  const status = entryOf(resourceTable(journal.view), QUEUE).status;
  assert.ok(status.state === 'cleaning' && status.holder.type === 'sweep');
  journal.close();
});
