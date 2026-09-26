// The lanes stage (src/pipeline/lanes.ts through stages.lanes): real lane commands, run serially and
// verbatim in a clean detached checkout of the salvage SHA, each under its reservation, with one evidence
// dir per lane. Named tests: verify.verbatim-serial, verify.dirty-tree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { invocationId, resourceName, sha256, specRev } from '../src/core/ids.ts';
import { checkManifest } from '../src/git/evidence.ts';
import { worktreeList } from '../src/git/git.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { killWorkload } from '../src/pipeline/invoke.ts';
import { lanes } from '../src/pipeline/stages.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { absPath } from '../src/core/values.ts';
import { waitFor } from './helpers/invocation.ts';
import { tmpDir } from './helpers/repo.ts';
import { events, intents } from './fixtures/invoke-specs.ts';
import { DB, type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, headOf, launchOf, outcomeFacts, setupUnit, spawnIntents } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

function laneRun(lanesJson: readonly LaneJson[], resources: readonly string[] = []): StageRun {
  const run = setupUnit({ steps: [], lanes: lanesJson, resources });
  pinDispatch(run.ctx, run.unit, { rev: specRev(1), sha256: sha256('1'.repeat(64)) });
  return run;
}

const laneSpawns = (run: StageRun) => spawnIntents(run).filter((i) => i.expect.subject.purpose === 'lane');

test('verify.verbatim-serial: lanes run one at a time, fast before estate, with the spec\'s exact argv and env', T, async () => {
  const log = join(tmpDir('lanes-log'), 'lanes.log');
  const lane = (id: string, tier: 'fast' | 'estate', resources: readonly string[] = []): LaneJson => ({
    id, tier, resources,
    argv: ['sh', '-c', `echo "start ${id}" >> "$LOG"; sleep 0.3; echo "end ${id}" >> "$LOG"`],
    env: { set: { LOG: log }, pass: ['PATH'] },
  });
  // Spec order puts the estate lane first; the executor still runs the fast lanes before it.
  const specLanes = [lane('estate1', 'estate', [DB]), lane('fast1', 'fast'), lane('fast2', 'fast')];
  const run = laneRun(specLanes, [DB]);

  const done = await lanes(run.ctx, run.unit, run.base);
  assert.equal(done.outcome.kind, 'green');
  assert.equal(done.next.kind === 'stage' && done.next.stage, 'gate');
  assert.deepEqual(done.ledger.map((l) => [l.lane, l.verdict, l.exitCode]), [['fast1', 'pass', 0], ['fast2', 'pass', 0], ['estate1', 'pass', 0]]);

  // Verbatim: each launch is the spec's argv, cwd under the checkout, and exactly the declared env plus the owner label.
  const spawns = laneSpawns(run);
  const order = ['fast1', 'fast2', 'estate1'];
  assert.deepEqual(spawns.map((s) => s.expect.subject.purpose === 'lane' && s.expect.subject.lane), order);
  for (const [i, s] of spawns.entries()) {
    const spec = specLanes.find((l) => l.id === order[i])!;
    const launch = launchOf(run, s);
    assert.deepEqual(launch.argv, spec.argv, `${order[i]} argv`);
    assert.equal(launch.cwd, done.verification?.path);
    assert.deepEqual(launch.env, { LOG: log, PATH: run.ctx.hostEnv['PATH'], RESOURCE_OWNER: `${run.ctx.plan.arc}/${U1}` });
    assert.equal(s.expect.subject.purpose === 'lane' && s.expect.subject.at, run.base);
  }
  // Serial: each lane's spawn is done before the next one's intent, and the workloads never overlapped.
  const all = events(run.runDir);
  for (let i = 1; i < spawns.length; i++) {
    const prevDone = all.find((e) => e.type === 'done' && e.op === spawns[i - 1]!.op)!;
    assert.ok(prevDone.seq < spawns[i]!.seq, `${order[i - 1]} done before ${order[i]} starts`);
  }
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), order.flatMap((id) => [`start ${id}`, `end ${id}`]));
  // The estate lane ran under its reservation: probe, run, teardown, released.
  assert.deepEqual(readFileSync(join(run.stateDir, 'calls.log'), 'utf8').trim().split('\n'), [`probe db ${run.ctx.plan.arc}/${U1}`, `teardown db ${run.ctx.plan.arc}/${U1}`]);
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free');
  // One evidence dir per lane, and the checkout the gate reads: clean, detached at the salvage SHA.
  for (const l of done.ledger) assert.equal(checkManifest(absPath(join(l.evidenceDir, 'output'))).kind, 'verified');
  assert.ok(done.verification !== null);
  assert.equal(headOf(done.verification.path), run.base);
});

test('verify.dirty-tree: a lane that writes into the checkout is not certified (chargeable), its writes preserved', T, async () => {
  const writer: LaneJson = { id: 'writer', argv: ['sh', '-c', 'mkdir -p out && echo ignored > out/x && echo stray > src/stray.txt'] };
  const run = laneRun([writer]);
  const done = await lanes(run.ctx, run.unit, run.base);
  assert.deepEqual(done.ledger.map((l) => l.verdict), ['pass'], 'the lane itself passed');
  assert.equal(done.outcome.kind, 'not-certified');
  assert.ok(done.next.kind === 'stage' && done.next.stage === 'build' && done.next.round === 'fix');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.outcome === 'not-certified' && fact.chargeable, 'not-certified charges');
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 1);
  // The dirty checkout is never kept; what the lane wrote is snapshotted first (ignored output is not dirt).
  assert.equal(done.verification, null);
  assert.ok(!worktreeList(run.repo).some((w) => w.path.includes('.verify-')));
  const snapshots = intents(run.runDir, 'evidence.snapshot');
  const dirty = snapshots.find((s) => s.kind === 'evidence.snapshot' && s.expect.dest.endsWith('/_dirty'));
  assert.ok(dirty !== undefined && dirty.kind === 'evidence.snapshot');
  const manifest = checkManifest(dirty.expect.dest);
  assert.ok(manifest.kind === 'verified');
  assert.deepEqual(manifest.manifest.files.map((f) => f.path), ['src/stray.txt']);
  assert.ok(intents(run.runDir, 'worktree.remove').length === 1);
  // The fix round names the dirt.
  assert.ok(done.fix !== null && done.fix.kind === 'fix');
  assert.match(done.fix.fix.directives.join('\n'), /src\/stray\.txt/);
});

test('lanes.occupied-before-tree: unlabelled occupancy parks before any lane runs or any checkout exists', T, async () => {
  const run = laneRun([{ id: 'needs-db', argv: ['true'], tier: 'estate', resources: [DB] }], [DB]);
  writeFileSync(join(run.stateDir, `${DB}.occupant`), 'someone-else');
  const done = await lanes(run.ctx, run.unit, run.base);
  assert.equal(done.outcome.kind, 'occupied');
  assert.equal(done.next.kind === 'park' && done.next.needsUser.reason, 'occupancy-unlabelled');
  assert.equal(done.needsUser?.reason, 'occupancy-unlabelled');
  assert.deepEqual(laneSpawns(run), []);
  assert.deepEqual(intents(run.runDir, 'worktree.create'), []);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free');
});

test('lanes.interrupted-holds: a pause mid-lane holds the unit, removes the checkout and charges nothing', T, async () => {
  const mark = join(tmpDir('lanes-mark'), 'running');
  const sleeper: LaneJson = { id: 'sleeper', argv: ['sh', '-c', `touch "${mark}"; sleep 60`] };
  const held = laneRun([sleeper]);
  const going = lanes(held.ctx, held.unit, held.base);
  await waitFor('the lane to start', 60_000, () => (existsSync(mark) ? true : null));
  const spawn = held.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined);
  await killWorkload(held.ctx, { inv: invocationId(spawn.op, spawn.ordinal), scope: 'invocation', reason: 'pause' });
  const done = await going;
  assert.equal(done.outcome.kind, 'interrupted');
  assert.equal(done.next.kind, 'hold');
  assert.equal(done.verification, null);
  const u = held.journal.view.unit(U1);
  assert.equal(u.status, 'held');
  assert.equal(u.counters.chargeableFailures, 0);
  assert.equal(u.counters.retries.lanes, 0);
});
