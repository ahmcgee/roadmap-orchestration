import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serializeEvent } from '../src/core/events.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { snapshotRequestOf, verifySnapshot, withSnapshotReads } from '../src/git/snapshot.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { ARC, IDENTITY, runOp } from './fixtures/git-common.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';

test('snapshot sharing verifies exact bytes, keeps stale prefixes, and expires after each projection', async () => {
  const repo = absPath(tmpDir('status-snapshot-repo')); makeRepo(repo, { files: { 'README.md': 'fixture' } });
  const runDir = absPath(tmpDir('status-snapshot-run')); mkdirSync(runDir, { recursive: true });
  const j = openJournal(runDir, ARC);
  j.fact({ kind: 'containment-mode', mode: 'session' });
  const snapshot = await runOp(j, snapshotPublishOp(repo), 'status-snapshot', snapshotRequestOf({ view: j.view, runDir, identity: IDENTITY, message: 'status verification' }));
  j.close();
  const commit = snapshot.post.new;
  const live = readJournal(runDir, ARC);
  withSnapshotReads(live, () => {
    const check = verifySnapshot(repo, commit);
    assert.equal(check.kind, 'verified');
    assert.equal(check.events.length, 1, 'a stale snapshot remains its own high-water, not the moving live fold');
    assert.equal(check.events[0], live.events[0], 'equal verified bytes reuse the parsed event');
    assert.equal(verifySnapshot(repo, commit), check, 'the resolved immutable commit verifies once');
  });
  // A live log holding exactly the snapshot's high-water: its last hash binds the blob's last line.
  const exact = readJournal(runDir, ARC, 1);
  assert.equal(exact.events.length, 1);
  withSnapshotReads(exact, () => {
    const check = verifySnapshot(repo, commit);
    assert.ok(check.kind === 'verified');
    assert.equal(check.events[0], exact.events[0], 'the hash chain stands for the bytes');
  });
  // Another canonical, valid log of the same arc and high-water is not evidence for this snapshot's bytes.
  writeFileSync(join(runDir, 'events.jsonl'), serializeEvent({ ...live.events[0]!, at: '2026-01-01T00:00:00.000Z' as never }));
  const changed = readJournal(runDir, ARC);
  withSnapshotReads(changed, () => {
    const check = verifySnapshot(repo, commit);
    assert.equal(check.kind, 'verified');
    assert.notEqual(check.events[0], changed.events[0]);
    assert.equal(check.events[0]!.at, live.events[0]!.at, 'snapshot events are parsed when the exact bytes differ');
  });
  // A mismatched manifest must still fail, even with an earlier successful verification of the source commit.
  const bad = git(repo, 'commit-tree', git(repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'no manifest');
  withSnapshotReads(live, () => assert.equal(verifySnapshot(repo, bad as never).kind, 'mismatch'));
});
