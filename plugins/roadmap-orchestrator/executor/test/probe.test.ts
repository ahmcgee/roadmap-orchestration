// The occupancy probe (src/resources/probe.ts) with real invocations of res-tool.ts: the probe exit
// contract 0/10/11, own-label teardown then one re-probe, and a park decided before run (before any charge).
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ResourceName, invocationDirName, invocationId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { undispositioned } from '../src/host/residues.ts';
import { type Occupancy, probe } from '../src/resources/probe.ts';
import { type CleanupResult, type StageHolder, cleanup, reserve } from '../src/resources/reserve.ts';
import { requestOf } from '../src/resources/pool.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { DB, QUEUE, type ResRun, calls, newRun, openRun, stageHolder, stageParent, tableOf, transitions } from './fixtures/res-plan.ts';

const T = { timeout: 30_000 };
const holder = stageHolder('build');

const occupy = (r: ResRun, resource: ResourceName, label: string): void => writeFileSync(join(r.stateDir, `${resource}.occupant`), label);
const called = (r: ResRun): readonly string[] => calls(r).map((c) => c.split(' ').slice(0, 2).join(' '));

/** Reserve the build's set, probe it, then clean up; returns the verdict and the cleanup result. */
async function probeCycle(r: ResRun): Promise<Readonly<{ verdict: Occupancy; cleaned: CleanupResult<StageHolder> }>> {
  const { ctx, journal } = openRun(r);
  const res = reserve(ctx, holder, requestOf(ctx.plan(), [DB, QUEUE], 0), stageParent(holder));
  assert.ok(res.state === 'reserved');
  const verdict = await probe(ctx, res, stageParent(holder));
  const cleaned = await cleanup(ctx, res, stageParent(holder));
  journal.close();
  return { verdict, cleaned };
}

/** Parked before run: no run edge and no workload spawn, so nothing the unit could be charged for. */
function assertParkedBeforeRun(r: ResRun): void {
  assert.deepEqual(transitions(r).map((t) => t.edge === 'clean' ? `clean from ${t.from}` : t.edge), ['reserve', 'clean from reserved', 'release']);
  const purposes = intents(r.runDir, 'proc.spawn').map((i) => (i.kind === 'proc.spawn' ? i.expect.subject.purpose : null));
  assert.ok(purposes.every((p) => p === 'probe' || p === 'teardown'), JSON.stringify(purposes));
  assert.ok([...tableOf(r).values()].every((s) => s.state === 'free'));
}

test('res.occupancy-unlabelled-parks', T, async () => {
  const r = newRun();
  occupy(r, DB, 'someone-else');
  const { verdict, cleaned } = await probeCycle(r);
  assert.equal(cleaned.kind, 'released');
  assert.ok(verdict.kind === 'parked', JSON.stringify(verdict));
  assert.equal(verdict.resource, DB);
  const { needsUser } = verdict;
  assert.equal(needsUser.reason, 'occupancy-unlabelled');
  assert.equal(needsUser.blocking, true);
  assert.deepEqual(needsUser.subject, { type: 'unit', unit: 'u1' });
  assert.match(needsUser.summary, /db is occupied by something without this unit's label at the first probe/);
  const probeOp = intents(r.runDir, 'proc.spawn')[0]!;
  assert.deepEqual(needsUser.evidence, ['stdout', 'stderr'].map((f) => join(r.runDir, 'inv', invocationDirName(invocationId(probeOp.op, 1)), f)));
  // Decided at the first probe: queue is never probed, and nothing foreign is torn down by the park.
  assert.deepEqual(called(r), ['probe db', 'teardown db', 'teardown queue']);
  assert.ok(existsSync(join(r.stateDir, `${DB}.occupant`)), 'our label-scoped teardown leaves a foreign occupant alone');
  assertParkedBeforeRun(r);
});

test('res.occupancy-faulted-probe-parks', T, async () => {
  const r = newRun();
  writeFileSync(join(r.stateDir, `${QUEUE}.probe-exit`), '3');
  const { verdict, cleaned } = await probeCycle(r);
  assert.equal(cleaned.kind, 'released');
  assert.ok(verdict.kind === 'parked' && verdict.resource === QUEUE);
  assert.match(verdict.needsUser.summary, /queue could not be probed \(probe exited 3\)/);
  assertParkedBeforeRun(r);
});

test('res.occupancy-own-label-teardown', T, async () => {
  const r = newRun();
  occupy(r, DB, `${r.arc}/u1`);
  assert.deepEqual(await probeCycle(r), { verdict: { kind: 'clear' }, cleaned: { kind: 'released', released: [DB, QUEUE] } });
  assert.equal(existsSync(join(r.stateDir, `${DB}.occupant`)), false, 'the unit\'s own leftover was torn down');
  // Own label: teardown, then exactly one re-probe, before the next resource.
  assert.deepEqual(called(r), ['probe db', 'teardown db', 'probe db', 'probe queue', 'teardown db', 'teardown queue']);
});

test('res.occupancy-own-label-teardown-fails-parks', T, async () => {
  const r = newRun();
  occupy(r, DB, `${r.arc}/u1`);
  writeFileSync(join(r.stateDir, `${DB}.teardown-fails`), '');
  const { verdict, cleaned } = await probeCycle(r);
  // The re-probe still sees the own label: parked. The cleanup's teardown of db then fails as well, so db
  // is cleanup-failed with its residue, and only queue is released.
  assert.ok(verdict.kind === 'parked', JSON.stringify(verdict));
  assert.match(verdict.needsUser.summary, /still occupied under this unit's own label after tearing down this unit's own leftovers \(teardown \S+ failed\)/);
  assert.deepEqual(cleaned, { kind: 'cleanup-failed', failed: [DB], released: [QUEUE] });
  assert.deepEqual(called(r), ['probe db', 'teardown db', 'probe db', 'teardown db', 'teardown queue']);
  assert.equal(tableOf(r).get(DB)?.state, 'cleanup-failed');
  assert.deepEqual(undispositioned(absPath(r.hostDir)).map((k) => k.resource), [DB]);
});
