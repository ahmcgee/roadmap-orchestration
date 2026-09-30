// Residue-index compaction at start (src/host/compact.ts, M3 step A5a) and the host dir's generation files
// (`pruneGenerationFiles`, src/supervisor.ts). Real files, real arc logs, child processes killed at the compaction's
// crash points (matrix row RESIDUE_COMPACT), and the M2 retry scenario (pool-child.ts) for H1 retention.
//
//   compact.threshold                 nothing is rewritten below the threshold
//   compact.drops-disposed-keeps-open disposed pairs of released instances go, open residues stay; the head chains to
//                                     a byte-identical archive; appends and a second compaction continue the chain
//   compact.after-retry-disposition   (H1) a crash leaves estate#1 cleaning under a retry after its `cleaned`
//                                     disposition; compaction keeps that pair; recovery and the next probe release it
//   compact.disposer-arc-holds        a pair disposed of by another arc is kept while that arc's fold holds the instance
//   compact.unreadable-log-retains    an arc with no log, or a corrupt one, keeps every pair it is part of
//   compact.dev5-arc                  an index and logs written by the 1.0.0-dev.5 executor, a retry crashed after its
//                                     disposition among them: compacted by HEAD, bodies unchanged, then released
//   compact.stray-archive-link        a crash after the link, then appends: the next compaction relinks under the new name
//   compact.at-start                  the supervisor compacts at `roadmap start`, and the arc runs to complete
//   host.prune-generation-files       generation files before the last K go; a log that claimed nothing stays
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it, test } from 'node:test';
import { prevHash } from '../src/core/events.ts';
import { type ArcId, type ResourceInstance, arcId, invocationId, opId, poolInstance, resourceName, unitId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { COMPACT_TMP, compactResidues } from '../src/host/compact.ts';
import { RESIDUES, hostPath, openHostDir } from '../src/host/hostdir.ts';
import {
  RESIDUE_ARCHIVE, bodyOf, ownArcResidue, readResidueIndex, readResidues, recordDisposition, recordResidue, residueArchiveName, undispositioned,
  undispositionedResidueCheck,
} from '../src/host/residues.ts';
import type { StartupContext } from '../src/preflight/startup.ts';
import { pruneGenerationFiles } from '../src/supervisor.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture, runUntilExit } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import { EXEC_TIMEOUT_MS, SMOKE_DEFAULT, reasonOf, setupExec, startExec } from './fixtures/exec-common.ts';
import { ARC as HOST_ARC, claimRecord } from './fixtures/host-records.ts';
import { ESTATE, newRun, openPoolRun } from './fixtures/pool-plan.ts';
import type { ResRun } from './fixtures/res-plan.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { gateStep, mulBuild } from './fixtures/unit-common.ts';
import { RESIDUE_COMPACT, crashCells } from './matrix.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { readBootId } from '../src/contain/proc.ts';

after(assertNoSurvivors);

const CHILD_TIMEOUT_MS = 30_000;
const T = { timeout: 120_000 };
const INSTANCE = poolInstance(ESTATE, 1);
const DB = resourceName('db');
const U1 = unitId('u1');

function hostDir(): AbsPath {
  return openHostDir(absPath(join(tmpDir('compact-host'), 'roadmap')));
}

/** An arc's run dir with an empty, readable log. */
function emptyLog(runDir: string, arc: ArcId): void {
  mkdirSync(runDir, { recursive: true });
  openJournal(absPath(runDir), arc).close();
}

/** A runtime root holding a readable, empty log for each of `arcs`: every instance free in their folds. */
function runtime(...arcs: readonly ArcId[]): string {
  const root = tmpDir('compact-runtime');
  for (const arc of arcs) emptyLog(join(root, arc), arc);
  return root;
}
const runDirs = (root: string) => (arc: ArcId): AbsPath => absPath(join(root, arc));

let invSeq = 0;
/** Records a residue of `arc` (unit u1) on `resource`; disposed of by `by` unless null. Returns its key. */
function seed(dir: AbsPath, arc: ArcId, resource: ResourceInstance, by: ArcId | null = arc) {
  invSeq += 1;
  const key = { arc, unit: U1, inv: invocationId(opId(arc, 1000 + invSeq), 1), resource };
  recordResidue(dir, { type: 'residue', key, teardown: { argv: ['true'], cwd: absPath('/tmp'), env: {} }, label: `seed ${invSeq}` });
  if (by !== null) recordDisposition(dir, { type: 'disposition', key, disposition: 'cleaned', by: { arc: by, inv: invocationId(opId(by, 5000 + invSeq), 1) } });
  return key;
}
const pairs = (dir: AbsPath, arc: ArcId, n: number, by: ArcId | null = arc) =>
  Array.from({ length: n }, (_, i) => seed(dir, arc, poolInstance(resourceName('estate'), 10 + i), by));

const indexBytes = (dir: AbsPath): Buffer => readFileSync(hostPath(dir, RESIDUES));
const archives = (dir: AbsPath): readonly string[] => readdirSync(dir).filter((n) => RESIDUE_ARCHIVE.test(n)).sort();
const bodies = (dir: AbsPath): readonly string[] => readResidues(dir).map((l) => canonicalJson(bodyOf(l)));
const keyText = (k: unknown): string => canonicalJson(k);
const contextFor = (dir: AbsPath): StartupContext => ({ hostDir: dir }) as unknown as StartupContext;

/** The hash and seq of the index's last line, as a compaction's head names them. */
function lastLineOf(bytes: Buffer): Readonly<{ seq: number; hash: string }> {
  const text = bytes.toString('utf8');
  const lines = text.split('\n').slice(0, -1);
  const last = lines.at(-1)!;
  return { seq: (JSON.parse(last) as { seq: number }).seq, hash: prevHash(Buffer.from(`${last}\n`, 'utf8')) };
}

/** The first (head) line of the index, parsed. */
const headOf = (dir: AbsPath) => JSON.parse(indexBytes(dir).toString('utf8').split('\n')[0]!) as { type: string; archive: string; prevSeq: number; prevHash: string; seq: number; prev: string };

describe('compact.threshold', () => {
  it('below the threshold nothing is written; at it the index is compacted', () => {
    const dir = hostDir();
    const arc = arcId('arc-t');
    const root = runtime(arc);
    pairs(dir, arc, 3);
    const before = indexBytes(dir);
    assert.deepEqual(compactResidues(dir, runDirs(root), 4), { kind: 'below-threshold', droppable: 3 });
    assert.ok(indexBytes(dir).equals(before));
    assert.deepEqual(archives(dir), []);
    assert.equal(existsSync(hostPath(dir, COMPACT_TMP)), false);
    const done = compactResidues(dir, runDirs(root), 3);
    assert.equal(done.kind, 'compacted');
    assert.deepEqual(readResidues(dir), []);
  });

  it('an empty or absent index is below any threshold', () => {
    const dir = hostDir();
    assert.deepEqual(compactResidues(dir, runDirs(runtime()), 1), { kind: 'below-threshold', droppable: 0 });
    assert.equal(existsSync(hostPath(dir, RESIDUES)), false);
  });
});

describe('compact.drops-disposed-keeps-open', () => {
  it('drops released pairs, keeps open residues with their records, archives the old file whole, and the chain continues', async () => {
    const dir = hostDir();
    const arc = arcId('arc-d');
    const root = runtime(arc);
    const disposed = pairs(dir, arc, 5);
    const open = [seed(dir, arc, resourceName('queue'), null), seed(dir, arc, DB, null)];
    const openBodies = readResidues(dir).filter((l) => l.type === 'residue' && open.some((k) => keyText(k) === keyText(l.key))).map((l) => canonicalJson(bodyOf(l)));
    const before = indexBytes(dir);
    const last = lastLineOf(before);

    const done = compactResidues(dir, runDirs(root), 1);
    assert.deepEqual(done, { kind: 'compacted', archive: residueArchiveName(12, last.hash as never), dropped: 5, kept: 2 });
    assert.deepEqual(archives(dir), [done.kind === 'compacted' ? done.archive : '']);
    assert.ok(readFileSync(hostPath(dir, archives(dir)[0]!)).equals(before), 'the archive is the old index, byte for byte');
    const head = headOf(dir);
    assert.deepEqual([head.type, head.prevSeq, head.prevHash, head.seq, head.prev], ['compacted', 12, last.hash, 13, last.hash]);
    assert.deepEqual(bodies(dir), openBodies, 'the open residues, records unchanged');
    assert.deepEqual(undispositioned(dir).map(keyText), open.map(keyText));
    for (const k of disposed) assert.ok(!readResidues(dir).some((l) => keyText(l.key) === keyText(k)));
    const rows = await undispositionedResidueCheck.check(contextFor(dir));
    assert.equal(rows.length, 1, 'the read-only startup row reads a compacted index');
    assert.equal(existsSync(hostPath(dir, COMPACT_TMP)), false);

    // Appends chain after the head; a second compaction archives the compacted file, whose head names the first archive.
    recordDisposition(dir, { type: 'disposition', key: open[0]!, disposition: 'cleaned', by: { arc, inv: invocationId(opId(arc, 9000), 1) } });
    assert.equal(readResidueIndex(dir).lastSeq, 16);
    const first = archives(dir)[0]!;
    const compacted = indexBytes(dir);
    const again = compactResidues(dir, runDirs(root), 1);
    assert.equal(again.kind, 'compacted');
    const second = again.kind === 'compacted' ? again.archive : '';
    assert.deepEqual(archives(dir), [first, second].sort());
    assert.ok(readFileSync(hostPath(dir, second)).equals(compacted));
    assert.equal((JSON.parse(compacted.toString('utf8').split('\n')[0]!) as { archive: string }).archive, first, 'the archived file\'s head names the archive before it');
    assert.deepEqual(undispositioned(dir).map(keyText), [keyText(open[1])]);
    assert.equal(headOf(dir).prevSeq, 16);
  });

  it('a head anywhere but the first line, or not continuing its archive, refuses as corrupt', () => {
    const dir = hostDir();
    const arc = arcId('arc-h');
    pairs(dir, arc, 2);
    compactResidues(dir, runDirs(runtime(arc)), 1);
    const text = indexBytes(dir).toString('utf8');
    const head = JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
    writeFileSync(hostPath(dir, RESIDUES), `${canonicalJson({ ...head, prevSeq: 7, archive: residueArchiveName(7, head['prevHash'] as never) })}\n`);
    assert.throws(() => readResidues(dir), /does not continue its archive/);
  });
});

// ---------------------------------------------------------------------------------------------------
// H1: fold-held retention

const pool = (mode: string, r: ResRun, trigger: string | null, root?: string) =>
  runUntilExit(process.execPath, [join(root ?? fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'pool-child.ts'), mode, JSON.stringify(r)], {
    env: trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

async function poolOk(mode: string, r: ResRun, root?: string): Promise<string> {
  const exit = await pool(mode, r, null, root);
  assert.equal(exit.code, 0, `${mode}: ${exit.stderr}`);
  return exit.stdout.trim();
}

/** The retry scenario of pool-crash.test.ts, its run dir under `root`, killed at `retry.after-disposition` (or run through). */
async function retryRun(root: string, host: string, crash: boolean, testRoot?: string): Promise<ResRun> {
  const base = newRun();
  const r: ResRun = { ...base, hostDir: host, runDir: join(root, base.arc) };
  mkdirSync(r.stateDir, { recursive: true });
  emptyLog(r.runDir, arcId(r.arc));
  writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
  if (!crash) {
    assert.equal(await poolOk('retry', r, testRoot), 'pass');
    return r;
  }
  const trigger = writeTrigger(tmpDir('trigger'), { label: 'retry.after-disposition', occurrence: 1 });
  const exit = await pool('retry', r, trigger, testRoot);
  assert.equal(exit.signal, 'SIGKILL', exit.stderr);
  assertFired(trigger);
  return r;
}

const statusOf = (r: ResRun) => readJournal(absPath(r.runDir), arcId(r.arc)).view.resources().get(INSTANCE)?.status;

describe('compact.after-retry-disposition', () => {
  it('a crash leaves estate#1 cleaning under the retry after its disposition: compaction keeps the pair, then recovery and the probe release it', T, async () => {
    const root = tmpDir('compact-runtime');
    const host = join(tmpDir('compact-host'), 'roadmap');
    const r = await retryRun(root, host, true);
    const dir = absPath(host);
    const status = statusOf(r);
    assert.ok(status !== undefined && status.state === 'cleaning' && status.holder.type === 'retry', JSON.stringify(status));
    assert.deepEqual(undispositioned(dir), [], 'the residue is disposed of');
    assert.equal(readResidues(dir).length, 2);
    // Droppable company: a pair of the same arc on `db` (free in its fold).
    const filler = seed(dir, arcId(r.arc), DB);

    const done = compactResidues(dir, runDirs(root), 1);
    assert.equal(done.kind, 'compacted');
    assert.deepEqual(done.kind === 'compacted' ? [done.dropped, done.kept] : [], [1, 2]);
    assert.deepEqual(readResidues(dir).map((l) => [l.type, l.key.resource]), [['residue', INSTANCE], ['disposition', INSTANCE]]);
    assert.ok(!readResidues(dir).some((l) => keyText(l.key) === keyText(filler)));

    // Recovery, then the park's next probe: the retry replays the kept residue's recipe and releases.
    await poolOk('recover', r);
    assert.equal(await poolOk('reclaim', r), 'pass');
    assert.deepEqual(statusOf(r), { state: 'free' });
    assert.equal(readResidues(dir).filter((l) => l.type === 'disposition').length, 1, 'no second disposition');
    // Released: the next compaction drops it.
    const next = compactResidues(dir, runDirs(root), 1);
    assert.deepEqual(next.kind === 'compacted' ? [next.dropped, next.kept] : next, [1, 0]);
    assert.deepEqual(readResidues(dir), []);
  });
});

describe('compact.disposer-arc-holds', () => {
  it('a pair disposed of by another arc is kept while that arc\'s fold holds its instance, whatever the owning arc\'s fold says', T, async () => {
    const root = tmpDir('compact-runtime');
    const host = join(tmpDir('compact-host'), 'roadmap');
    const holder = await retryRun(root, host, true); // estate#1 cleaning under its retry
    const dir = absPath(host);
    const owner = arcId('arc-owner');
    emptyLog(join(root, owner), owner);
    const byHolder = seed(dir, owner, INSTANCE, arcId(holder.arc));
    const byOwner = seed(dir, owner, INSTANCE, owner);
    const done = compactResidues(dir, runDirs(root), 1);
    assert.equal(done.kind, 'compacted');
    const kept = new Set(readResidues(dir).map((l) => keyText(l.key)));
    assert.ok(kept.has(keyText(byHolder)), 'disposed of by the arc still holding estate#1');
    assert.ok(!kept.has(keyText(byOwner)), 'owner and disposer both free: dropped');
  });
});

describe('compact.unreadable-log-retains', () => {
  it('an arc with no log, or a corrupt one, keeps every pair it owns or disposed of; a readable arc\'s pairs go', () => {
    const dir = hostDir();
    const readable = arcId('arc-ok');
    const absent = arcId('arc-absent');
    const corrupt = arcId('arc-corrupt');
    const root = runtime(readable);
    mkdirSync(join(root, corrupt));
    writeFileSync(join(root, corrupt, 'events.jsonl'), '{"not":"an event"}\n');
    const dropped = pairs(dir, readable, 2);
    const kept = [
      ...pairs(dir, absent, 2),
      ...pairs(dir, corrupt, 2),
      seed(dir, readable, DB, absent), // disposed of by an arc whose log cannot be read
    ];
    const done = compactResidues(dir, runDirs(root), 1);
    assert.deepEqual(done.kind === 'compacted' ? [done.dropped, done.kept] : done, [2, 10]);
    const left = new Set(readResidues(dir).map((l) => keyText(l.key)));
    for (const k of kept) assert.ok(left.has(keyText(k)), keyText(k));
    for (const k of dropped) assert.ok(!left.has(keyText(k)), keyText(k));
  });
});

// ---------------------------------------------------------------------------------------------------
// dev.5

/** The 1.0.0-dev.5 release (the merge of PR #105): its executor tree, extracted from git. */
const DEV5_RELEASE = 'be76132';
const EXECUTOR_PATH = 'plugins/roadmap-orchestrator/executor';

function extractDev5(): string {
  const executor = fileURLToPath(new URL('../', import.meta.url));
  const top = spawnSync('git', ['-C', executor, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.equal(top.status, 0, top.stderr);
  const archive = spawnSync('git', ['-C', top.stdout.trim(), 'archive', '--format=tar', DEV5_RELEASE, EXECUTOR_PATH], { maxBuffer: 1 << 30 });
  assert.equal(archive.status, 0, `git archive ${DEV5_RELEASE}: ${archive.stderr}`);
  const dir = tmpDir('compact-dev5');
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  assert.equal(tar.status, 0, `tar: ${tar.stderr}`);
  const root = join(dir, EXECUTOR_PATH);
  assert.match(readFileSync(join(root, 'package.json'), 'utf8'), /"version": "1\.0\.0-dev\.5"/);
  return join(root, 'test');
}

describe('compact.dev5-arc', () => {
  it('an index and logs the dev.5 executor wrote (one retry finished, one crashed after its disposition) compact under HEAD with bodies unchanged; HEAD then releases the crashed one', T, async () => {
    const dev5 = extractDev5();
    const root = tmpDir('compact-runtime');
    const host = join(tmpDir('compact-host'), 'roadmap');
    const finished = await retryRun(root, host, false, dev5);
    const crashed = await retryRun(root, host, true, dev5);
    const dir = absPath(host);
    const written = indexBytes(dir);
    const lines = readResidues(dir);
    assert.equal(lines.length, 4);
    for (const l of lines) assert.ok(l.key.unit === U1 && l.key.job === undefined, 'a dev.5 key names its unit');
    const crashedBodies = lines.filter((l) => l.key.arc === crashed.arc).map((l) => canonicalJson(bodyOf(l)));

    const done = compactResidues(dir, runDirs(root), 1);
    assert.deepEqual(done.kind === 'compacted' ? [done.dropped, done.kept] : done, [1, 2]);
    assert.ok(readFileSync(hostPath(dir, archives(dir)[0]!)).equals(written), 'the dev.5 index archived byte for byte');
    assert.deepEqual(bodies(dir), crashedBodies, 'the kept dev.5 records unchanged');
    assert.ok(!readResidues(dir).some((l) => l.key.arc === finished.arc));
    const residue = readResidues(dir).find((l) => l.type === 'residue')!;
    assert.equal(ownArcResidue(readJournal(absPath(crashed.runDir), arcId(crashed.arc)).view, residue.key), true, 'still proven the dev.5 arc\'s own');

    // HEAD's recovery and probe finish the dev.5 retry.
    await poolOk('recover', crashed);
    assert.equal(await poolOk('reclaim', crashed), 'pass');
    assert.deepEqual(statusOf(crashed), { state: 'free' });
    const next = compactResidues(dir, runDirs(root), 1);
    assert.deepEqual(next.kind === 'compacted' ? [next.dropped, next.kept] : next, [1, 0]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash matrix

const compactChild = (dir: AbsPath, root: string, threshold: number, trigger: string | null) =>
  runFixture('compact-child.ts', [dir, root, String(threshold)], {
    env: trigger === null ? { PATH: process.env['PATH'] } : { PATH: process.env['PATH'], ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

describe(`crash matrix: ${RESIDUE_COMPACT}`, () => {
  for (const cell of crashCells(RESIDUE_COMPACT)) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const dir = hostDir();
      const arc = arcId('arc-c');
      const root = runtime(arc);
      pairs(dir, arc, 4);
      const open = seed(dir, arc, DB, null);
      const before = indexBytes(dir);
      const openBody = bodies(dir).at(-1);
      const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence: 1 });
      const crashed = await compactChild(dir, root, 2, trigger);
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
      assertFired(trigger);
      // Whatever the crash left reads as the same open residue.
      assert.deepEqual(undispositioned(dir).map(keyText), [keyText(open)]);
      assert.equal(bodies(dir).at(-1), openBody);
      if (cell.label !== 'residue.compact.after-rename') assert.ok(indexBytes(dir).equals(before), 'the index is unchanged before the rename');

      const next = await compactChild(dir, root, 2, null);
      assert.equal(next.code, 0, next.stderr);
      const outcome = JSON.parse(next.stdout) as { kind: string };
      assert.equal(outcome.kind, cell.label === 'residue.compact.after-rename' ? 'below-threshold' : 'compacted');
      assert.equal(archives(dir).length, 1);
      assert.ok(readFileSync(hostPath(dir, archives(dir)[0]!)).equals(before), 'one archive, the pre-compaction index');
      assert.equal(headOf(dir).archive, archives(dir)[0]);
      assert.deepEqual(bodies(dir), [openBody]);
      assert.equal(existsSync(hostPath(dir, COMPACT_TMP)), false);
    });
  }

  it('a crash after the link, then appends: the next compaction unlinks the stale name and archives the index under its new last line', T, async () => {
    const dir = hostDir();
    const arc = arcId('arc-s');
    const root = runtime(arc);
    pairs(dir, arc, 3);
    const trigger = writeTrigger(tmpDir('trigger'), { label: 'residue.compact.after-link', occurrence: 1 });
    assert.equal((await compactChild(dir, root, 1, trigger)).signal, 'SIGKILL');
    const stale = archives(dir);
    assert.equal(stale.length, 1);
    pairs(dir, arc, 1); // the next executor appends
    const before = indexBytes(dir);
    const done = compactResidues(dir, runDirs(root), 1);
    assert.equal(done.kind, 'compacted');
    assert.deepEqual(archives(dir), [done.kind === 'compacted' ? done.archive : '']);
    assert.notEqual(archives(dir)[0], stale[0]);
    assert.ok(readFileSync(hostPath(dir, archives(dir)[0]!)).equals(before));
    assert.deepEqual(readResidues(dir), []);
  });
});

// ---------------------------------------------------------------------------------------------------
// At start, supervised

test('compact.at-start: `roadmap start` compacts an index over the threshold after its claim, and the arc runs to complete', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const dir = openHostDir(absPath(r.hostDir));
  const previous = arcId('arc-previous');
  emptyLog(join(dirname(r.runDir), previous), previous);
  pairs(dir, previous, 64);
  const before = indexBytes(dir);
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  assert.equal(archives(dir).length, 1);
  assert.ok(readFileSync(hostPath(dir, archives(dir)[0]!)).equals(before));
  assert.deepEqual(readResidues(dir), []);
  assert.equal(headOf(dir).type, 'compacted');
});

// ---------------------------------------------------------------------------------------------------
// Generation files

test('host.prune-generation-files: the files of generations before the last K go with the supervisor logs that claimed only them; the rest stays', () => {
  const dir = hostDir();
  const touch = (name: string, text = ''): void => writeFileSync(hostPath(dir, name), text);
  for (let g = 1; g <= 5; g++) {
    touch(`handshake.${g}`);
    touch(`supervisor.${g % 2 === 0 ? 'failed' : 'ready'}.${g}`);
    touch(`executor.${g}.out`);
    touch(`executor.${g}.err`);
  }
  const claimed = (...gs: number[]): string => gs.map((generation) => `${canonicalJson({ generation, kind: 'claimed' })}\n`).join('');
  const tokens = { old: 'a'.repeat(16), spanning: 'b'.repeat(16), live: 'c'.repeat(16), none: 'd'.repeat(16) };
  touch(`supervisor.${tokens.old}.out`, claimed(1, 2));
  touch(`supervisor.${tokens.spanning}.out`, claimed(3, 4));
  touch(`supervisor.${tokens.live}.out`, claimed(5));
  touch(`supervisor.${tokens.none}.out`);
  for (const token of Object.values(tokens)) touch(`supervisor.${token}.err`);
  touch('host.generation', '5\n');
  touch('residues.jsonl');

  const claim = claimRecord({ supervisor: selfIdentity(), bootId: readBootId(), arc: HOST_ARC, generation: 5 });
  const deleted = pruneGenerationFiles(dir, claim, 2);
  const gen = (g: number) => [`executor.${g}.err`, `executor.${g}.out`, `handshake.${g}`, `supervisor.${g % 2 === 0 ? 'failed' : 'ready'}.${g}`];
  assert.deepEqual(deleted, [...gen(1), ...gen(2), ...gen(3), `supervisor.${tokens.old}.err`, `supervisor.${tokens.old}.out`].sort());
  const left = readdirSync(dir).sort();
  for (const g of [4, 5]) for (const name of gen(g)) assert.ok(left.includes(name), name);
  for (const token of [tokens.spanning, tokens.live, tokens.none]) assert.ok(left.includes(`supervisor.${token}.out`) && left.includes(`supervisor.${token}.err`), token);
  assert.ok(left.includes('host.generation') && left.includes('residues.jsonl'));
  assert.deepEqual(pruneGenerationFiles(dir, claim, 2), [], 'idempotent');
  assert.throws(() => pruneGenerationFiles(dir, claim, 0), /always kept/);
});
