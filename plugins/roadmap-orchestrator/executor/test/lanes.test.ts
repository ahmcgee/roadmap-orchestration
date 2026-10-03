// The lanes stage (src/pipeline/lanes.ts through stages.lanes): real lane commands, run serially and
// verbatim in a clean detached checkout of the salvage SHA, each under its reservation, with one evidence
// dir per lane. Named tests: verify.verbatim-serial, verify.dirty-tree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { invocationId, laneId, opIdOf, resourceName, sha, specRev } from '../src/core/ids.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { checkManifest } from '../src/git/evidence.ts';
import { worktreeList } from '../src/git/git.ts';
import { pinDispatch, unitBranch } from '../src/pipeline/dispatch.ts';
import { fingerprintAt } from '../src/pipeline/gate.ts';
import { laneLedgerText } from '../src/prompts/inputs.ts';
import { killWorkload } from '../src/pipeline/invoke.ts';
import { LANE_STALL_MS, type LaneRecord, seriesDirty, seriesLedger, specSeriesRoot } from '../src/pipeline/lanes.ts';
import { laneFixRound } from '../src/pipeline/rounds.ts';
import { lanes, loadUnitSpec } from '../src/pipeline/stages.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { absPath, isoTimeOf } from '../src/core/values.ts';
import { waitFor } from './helpers/invocation.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { events, intents } from './fixtures/invoke-specs.ts';
import { DB, type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, keptSpec, headOf, launchOf, outcomeFacts, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

function laneRun(lanesJson: readonly LaneJson[], resources: readonly string[] = []): StageRun {
  const run = setupUnit({ steps: [], lanes: lanesJson, resources });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
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

  const done = started(await lanes(run.ctx, run.unit, run.base));
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
    assert.deepEqual(launch.env, { LOG: log, PATH: run.ctx.hostEnv['PATH'], RESOURCE_OWNER: `${run.ctx.plan().arc}/${U1}` });
    assert.equal(s.expect.subject.purpose === 'lane' && s.expect.subject.at, run.base);
    // The stall watchdog, not a short deadline, ends a hung lane.
    assert.equal(launch.stallMs, LANE_STALL_MS);
  }
  // Serial: each lane's spawn is done before the next one's intent, and the workloads never overlapped.
  const all = events(run.runDir);
  for (let i = 1; i < spawns.length; i++) {
    const prevDone = all.find((e) => e.type === 'done' && e.op === spawns[i - 1]!.op)!;
    assert.ok(prevDone.seq < spawns[i]!.seq, `${order[i - 1]} done before ${order[i]} starts`);
  }
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), order.flatMap((id) => [`start ${id}`, `end ${id}`]));
  // The estate lane ran under its reservation: probe, run, teardown, released.
  assert.deepEqual(readFileSync(join(run.stateDir, 'calls.log'), 'utf8').trim().split('\n'), [`probe db ${run.ctx.plan().arc}/${U1}`, `teardown db ${run.ctx.plan().arc}/${U1}`]);
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free');
  // One evidence dir per lane, and the checkout the gate reads: clean, detached at the salvage SHA.
  for (const l of done.ledger) assert.equal(checkManifest(absPath(join(l.evidenceDir, 'output'))).kind, 'verified');
  assert.ok(done.verification !== null);
  assert.equal(headOf(done.verification.path), run.base);
});

test('verify.dirty-tree: a lane that writes into the checkout is not certified (chargeable), its writes preserved', T, async () => {
  // A dirty path is snapshotted as itself even when its name is a glob.
  const writer: LaneJson = { id: 'writer', argv: ['sh', '-c', "mkdir -p out && echo ignored > out/x && echo stray > src/stray.txt && echo odd > 'src/w[1]*.txt'"] };
  const run = laneRun([writer]);
  const done = started(await lanes(run.ctx, run.unit, run.base));
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
  assert.deepEqual(manifest.manifest.files.map((f) => f.path), ['src/stray.txt', 'src/w[1]*.txt']);
  assert.ok(dirty.parent.type === 'stage');
  assert.deepEqual(seriesDirty(run.journal.view, specSeriesRoot(run.runDir, dirty.parent)), ['src/stray.txt', 'src/w[1]*.txt'], 'read back as paths');
  assert.ok(intents(run.runDir, 'worktree.remove').length === 1);
  // The fix round names the dirt.
  assert.ok(done.fix !== null && done.fix.kind === 'fix');
  assert.match(done.fix.fix.directives.join('\n'), /src\/stray\.txt/);
});

test('lanes.occupied-before-tree: unlabelled occupancy parks before any lane runs or any checkout exists', T, async () => {
  const run = laneRun([{ id: 'needs-db', argv: ['true'], tier: 'estate', resources: [DB] }], [DB]);
  writeFileSync(join(run.stateDir, `${DB}.occupant`), 'someone-else');
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'occupied');
  assert.equal(done.next.kind === 'park' && done.next.needsUser.reason, 'occupancy-unlabelled');
  assert.equal(done.needsUser?.reason, 'occupancy-unlabelled');
  assert.deepEqual(laneSpawns(run), []);
  assert.deepEqual(intents(run.runDir, 'worktree.create'), []);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);
  assert.equal(resourceTable(run.journal.view).get(resourceName(DB))?.status.state, 'free');
});

test('lanes.interrupted-holds: a pause mid-lane holds the unit, removes the checkout and charges nothing; its result.json records cancelled{pause}', T, async () => {
  const mark = join(tmpDir('lanes-mark'), 'running');
  const sleeper: LaneJson = { id: 'sleeper', argv: ['sh', '-c', `touch "${mark}"; sleep 60`] };
  const held = laneRun([sleeper]);
  const going = lanes(held.ctx, held.unit, held.base);
  await waitFor('the lane to start', 60_000, () => (existsSync(mark) ? true : null));
  const spawn = held.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined);
  await killWorkload(held.ctx, { inv: invocationId(spawn.op, spawn.ordinal), scope: 'invocation', reason: 'pause' });
  const done = started(await going);
  assert.equal(done.outcome.kind, 'interrupted');
  assert.equal(done.next.kind, 'hold');
  assert.equal(done.verification, null);
  const inv = invocationId(spawn.op, spawn.ordinal);
  const result = runnerFiles(invocationDir(held.runDir, inv), inv).read('result.json');
  assert.ok(result?.type === 'command' && result.verdict === 'cancelled', `one shape with a backend call's cancel: ${JSON.stringify(result)}`);
  assert.equal(result.reason, 'pause');
  assert.deepEqual(done.ledger.map((l) => l.verdict), ['cancelled']);
  const u = held.journal.view.unit(U1);
  assert.equal(u.status, 'held');
  assert.equal(u.counters.chargeableFailures, 0);
  assert.equal(u.counters.retries.lanes, 0);
});

test('lanes.stall-fix-round: a stalled lane is red; its fix round reads its output and is told it hung', () => {
  const lane = (id: string, verdict: LaneRecord['verdict']): LaneRecord => ({
    lane: laneId(id), argv: ['make', id], expectedExit: 0, exitCode: verdict === 'fail' ? 1 : null, verdict, evidenceDir: absPath(`/ev/${id}`), ignored: null,
    inv: invocationId(opIdOf('arc-1/9'), 1), at: isoTimeOf(new Date(0)), endedAt: isoTimeOf(new Date(1)), fixDirs: [absPath(`/ev/${id}/output/files`)],
    host: null, signatures: [], voided: null, diagnostic: null, flaky: false,
  });
  const salvage = sha('a'.repeat(40));
  const stalled = laneFixRound([lane('fast', 'pass'), lane('suite', 'stall')], [], salvage);
  assert.equal(stalled.kind, 'fix');
  if (stalled.kind !== 'fix') return;
  assert.deepEqual(stalled.fix.failingEvidenceDirs, ['/ev/suite/output/files']);
  assert.equal(stalled.fix.directives.length, 1);
  assert.match(stalled.fix.directives[0]!, /^Lane suite hung: .* for 10 minutes/);
  const red = laneFixRound([lane('suite', 'fail')], [], salvage);
  assert.ok(red.kind === 'fix' && red.fix.directives.length === 0);
});

const IGNORES = 'out/\n.local/\nnode_modules/\n';
const readJsonFile = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const capturedFiles = (dir: string): readonly string[] => {
  const m = checkManifest(absPath(dir));
  assert.ok(m.kind === 'verified', `${dir}: ${m.kind}`);
  return m.manifest.files.map((f) => f.path);
};

test('lanes.ignored-capture: a failing lane\'s undeclared ignored output is captured, filtered, and read by its fix round', T, async () => {
  const script = [
    'mkdir -p out .local/demo node_modules/dep',
    'echo declared > out/d.log', 'echo run > .local/demo/run.log', "echo meta > '.local/demo/a[1]*.log'",
    'echo key > .local/demo/tls.key', 'echo dep > node_modules/dep/i.js', 'echo "step 3: deploy failed" >&2', 'exit 1',
  ].join(' && ');
  const run = setupUnit({ steps: [], lanes: [{ id: 'deploy', argv: ['sh', '-c', script], evidenceGlobs: ['out/**'] }], gitignore: IGNORES });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'red');
  const [record] = done.ledger;
  assert.ok(record !== undefined && record.verdict === 'fail');
  const dir = record.evidenceDir;
  // Declared evidence stays in `tree`; the rest, minus build output and secrets, goes to `ignored`.
  assert.deepEqual(capturedFiles(join(dir, 'tree')), ['out/d.log']);
  assert.deepEqual(capturedFiles(join(dir, 'ignored')), ['.local/demo/a[1]*.log', '.local/demo/run.log']);
  assert.deepEqual(record.fixDirs, ['output', 'tree', 'ignored'].map((d) => join(dir, d, 'files')));
  const census = {
    v: 1, written: { files: 5, bytes: 9 + 4 + 5 + 4 + 4 }, captured: { files: 3, bytes: 9 + 4 + 5 },
    uncaptured: [{ dir: '.local/demo/', reason: 'excluded', files: 1, bytes: 4 }, { dir: 'node_modules/dep/', reason: 'build-output', files: 1, bytes: 4 }],
  };
  assert.deepEqual(record.ignored, census);
  assert.deepEqual(readJsonFile(join(dir, 'ignored.json')), census, 'recorded durably, read back the same');
  // The fix round reads the captured files and is told the census.
  assert.ok(done.fix !== null && done.fix.kind === 'fix');
  assert.deepEqual(done.fix.fix.failingEvidenceDirs, record.fixDirs);
  assert.deepEqual(done.fix.fix.directives, [
    'Lane deploy ignored writes: 5 files (26 B), 3 captured; uncaptured: 1 under .local/demo/ (excluded), 1 under node_modules/dep/ (build-output).',
  ]);
});

test('lanes.ignored-census-pass: a passing lane\'s ignored writes are counted, not captured; each lane counts only its own', T, async () => {
  const run = setupUnit({
    steps: [], gitignore: IGNORES,
    lanes: [
      { id: 'first', argv: ['sh', '-c', 'mkdir -p .local/demo && echo one > .local/demo/a.log'] },
      { id: 'second', argv: ['sh', '-c', 'mkdir -p .local/b && echo two > .local/b/x.log && echo three > .local/b/y.log'] },
      { id: 'quiet', argv: ['true'] },
    ],
  });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'green');
  assert.deepEqual(done.ledger.map((l) => [l.lane, l.ignored?.written.files, l.ignored?.captured.files]), [['first', 1, 0], ['second', 2, 0], ['quiet', 0, 0]]);
  for (const l of done.ledger) {
    assert.ok(!existsSync(join(l.evidenceDir, 'ignored')), 'nothing is captured for a passing lane');
    assert.deepEqual(l.fixDirs, [join(l.evidenceDir, 'output', 'files')]);
  }
  const text = laneLedgerText(done.ledger).split('\n');
  assert.match(text[0]!, /; ignored writes: 1 file \(4 B\), 0 captured; uncaptured: 1 under \.local\/demo\/ \(not-declared\)$/);
  assert.match(text[1]!, /; ignored writes: 2 files \(10 B\), 0 captured; uncaptured: 2 under \.local\/b\/ \(not-declared\)$/);
  assert.doesNotMatch(text[2]!, /ignored writes/, 'a lane that wrote no ignored file has no clause');

  // A lane an older executor ran has no census: it reads back as null, and the ledger says nothing of it.
  const [spawn] = laneSpawns(run);
  assert.ok(spawn !== undefined && spawn.parent.type === 'stage');
  rmSync(join(done.ledger[0]!.evidenceDir, 'ignored.json'));
  const [first] = seriesLedger(run.ctx, spawn.parent, loadUnitSpec(run.ctx, run.unit).spec.lanes, run.base, specSeriesRoot(run.runDir, spawn.parent));
  assert.equal(first?.ignored, null);
  assert.doesNotMatch(laneLedgerText([first!]), /ignored writes/);
});

test('lanes.ignored-killed: a lane killed mid-run gets its ignored output captured too', T, async () => {
  const mark = join(tmpDir('lanes-mark'), 'running');
  const run = setupUnit({
    steps: [], gitignore: IGNORES,
    lanes: [{ id: 'sleeper', argv: ['sh', '-c', `mkdir -p .local && echo partial > .local/k.log && touch "${mark}" && sleep 60`] }],
  });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  const going = lanes(run.ctx, run.unit, run.base);
  await waitFor('the lane to start', 60_000, () => (existsSync(mark) ? true : null));
  const spawn = run.journal.view.openIntents().find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined);
  await killWorkload(run.ctx, { inv: invocationId(spawn.op, spawn.ordinal), scope: 'invocation', reason: 'pause' });
  const done = started(await going);
  assert.equal(done.outcome.kind, 'interrupted');
  const [record] = done.ledger;
  assert.ok(record !== undefined && record.verdict === 'cancelled');
  assert.deepEqual(capturedFiles(join(record.evidenceDir, 'ignored')), ['.local/k.log']);
  assert.ok(record.fixDirs.includes(absPath(join(record.evidenceDir, 'ignored', 'files'))));
  assert.deepEqual(record.ignored?.captured, { files: 1, bytes: 8 });
});

test('lanes.evidence-globs-in-flight: evidenceGlobs and evidenceExcludes edited at the same rev are read at the next lanes attempt and leave the approval fingerprint alone', T, async () => {
  const run = setupUnit({
    steps: [], gitignore: IGNORES,
    lanes: [{ id: 'writer', argv: ['sh', '-c', 'mkdir -p out && echo a > out/a.log && echo b > out/b.log'], evidenceGlobs: ['out/a.log'] }],
  });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  git(run.repo, 'update-ref', unitBranch(run.ctx.plan().arc, U1), run.base);
  const before = fingerprintAt(run.ctx, run.unit, run.base);
  const first = started(await lanes(run.ctx, run.unit, run.base));
  assert.deepEqual(capturedFiles(join(first.ledger[0]!.evidenceDir, 'tree')), ['out/a.log']);

  const spec = JSON.parse(readFileSync(run.specPath, 'utf8')) as { rev: number; lanes: Record<string, unknown>[] };
  writeFileSync(run.specPath, JSON.stringify({ ...spec, lanes: spec.lanes.map((l) => ({ ...l, evidenceGlobs: ['out/b.log'], evidenceExcludes: ['out/secret/**'] })) }));
  assert.equal(spec.rev, 1);
  // The architect's evidence-only edit, applied: the unit's spec in force at once.
  recordPlan(run.journal, run.runDir, readInputFiles(absPath(join(run.planDir, 'plan.json'))), [
    { type: 'spec', unit: U1, edit: 'evidence', specRev: specRev(1), specSha256: fileSha256(run.specPath) },
  ], { profile: 'default', config: null });
  assert.deepEqual(fingerprintAt(run.ctx, run.unit, run.base), before, 'evidence plumbing is outside the approval fingerprint');

  const second = started(await lanes(run.ctx, run.unit, run.base));
  const [lane] = second.ledger;
  assert.ok(lane !== undefined && lane.evidenceDir !== first.ledger[0]!.evidenceDir);
  assert.deepEqual(capturedFiles(join(lane.evidenceDir, 'tree')), ['out/b.log'], 'the edited globs were read');
  assert.deepEqual(lane.ignored?.uncaptured, [{ dir: 'out/', reason: 'not-declared', files: 1, bytes: 2 }]);
});
