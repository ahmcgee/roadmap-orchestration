// Integrated tests of evidence.snapshot (src/git/evidence.ts, src/recover/evidence.ts): real files, the
// idempotent copy, manifest verification, and the evidence cells of the crash matrix.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { sha256Hex } from '../src/core/json.ts';
import { ManifestMismatchError, type SnapshotRequest, manifestComplete, manifestPath, verifyManifest } from '../src/git/evidence.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { crashChild, openArc, recoverOp, runOp } from './fixtures/git-common.ts';
import { tmpDir, writeFiles } from './helpers/repo.ts';
import { WORKTREE_EVIDENCE, crashCells } from './matrix.ts';
import { evidenceSnapshotOp } from '../src/recover/ops.ts';

const FILES = { stdout: 'out\n', stderr: 'err\n', 'lanes/unit/decisions.json': '{"d":1}\n', 'lanes/unit/scratch.tmp': 'not evidence\n' };
const GLOBS = ['stdout', 'stderr', 'lanes/**/*.json'];
const CAPTURED = ['lanes/unit/decisions.json', 'stderr', 'stdout'];

function setup(): { runDir: string; request: SnapshotRequest } {
  const runDir = tmpDir('evidence');
  const source = join(runDir, 'inv');
  writeFiles(source, FILES);
  return { runDir, request: { source: absPath(source), globs: GLOBS.map((g) => repoPattern(g)), dest: absPath(join(runDir, 'evidence', 'snap')) } };
}

const manifestSha = (dest: string): string => sha256Hex(readFileSync(manifestPath(absPath(dest))));

async function snapshot(runDir: string, request: SnapshotRequest): Promise<IntentOf<'evidence.snapshot'>> {
  const journal = openArc(runDir);
  const intent = await runOp(journal, evidenceSnapshotOp, 'evidence:unit', request);
  journal.close();
  return intent;
}

describe('evidence', () => {
  it('captures the matching files with a complete manifest written last', async () => {
    const { runDir, request } = setup();
    assert.equal(manifestComplete(request.dest), false);
    await snapshot(runDir, request);
    assert.equal(manifestComplete(request.dest), true);
    const manifest = verifyManifest(request.dest);
    assert.deepEqual(manifest.files.map((f) => f.path), CAPTURED);
    assert.deepEqual(manifest.files.find((f) => f.path === 'stdout'), { path: 'stdout', sha256: sha256Hex('out\n'), size: 4 });
    assert.equal(readFileSync(join(request.dest, 'files/lanes/unit/decisions.json'), 'utf8'), '{"d":1}\n');
  });

  it('evidence.idempotent: a re-run fills gaps and half-copied files and gives the same manifest', async () => {
    const { runDir, request } = setup();
    const intent = await snapshot(runDir, request);
    const first = manifestSha(request.dest);
    await evidenceSnapshotOp.act(intent);
    assert.equal(manifestSha(request.dest), first, 'a plain re-run rewrites the same manifest');

    writeFileSync(join(request.dest, 'files/stdout'), 'ou'); // half-copied
    rmSync(join(request.dest, 'files/stderr')); // never copied
    assert.throws(() => verifyManifest(request.dest), ManifestMismatchError);
    const journal = openArc(runDir);
    assert.deepEqual(await evidenceSnapshotOp.reconcile(intent, journal.view), { kind: 'redo' });
    journal.close();
    await evidenceSnapshotOp.act(intent);
    assert.equal(manifestSha(request.dest), first);
    assert.equal(verifyManifest(request.dest).files.length, 3);
  });

  it('a manifest that no longer lists the source\'s evidence set is redone', async () => {
    const { runDir, request } = setup();
    const intent = await snapshot(runDir, request);
    writeFiles(request.source, { 'lanes/unit/late.json': '{}\n' });
    const journal = openArc(runDir);
    assert.deepEqual(await evidenceSnapshotOp.reconcile(intent, journal.view), { kind: 'redo' });
    journal.close();
  });
});

describe(`matrix row ${WORKTREE_EVIDENCE}: evidence cells`, () => {
  const EXPECTED: Readonly<Record<string, Readonly<{ occurrences: number; recoveredBy: 'redone' | 'reconciled' }>>> = {
    'evidence.act-start': { occurrences: 1, recoveredBy: 'redone' },
    'evidence.after-partial-copy': { occurrences: CAPTURED.length, recoveredBy: 'redone' },
    'evidence.act-end': { occurrences: 1, recoveredBy: 'reconciled' },
  };
  const cells = crashCells(WORKTREE_EVIDENCE).filter((c) => c.label.startsWith('evidence.'));
  const scenario = (runDir: string, request: SnapshotRequest) => ({ op: 'evidence', runDir, ...request });

  it('covers exactly the row\'s evidence labels', () => {
    assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  for (const cell of cells) {
    const { occurrences, recoveredBy } = EXPECTED[cell.label]!;
    for (let occurrence = 1; occurrence <= occurrences; occurrence++) {
      it(`${cell.boundary} ${cell.label} #${occurrence}: ${cell.recovery}`, async () => {
        const control = setup();
        await snapshot(control.runDir, control.request);
        const { runDir, request } = setup();
        assert.equal(await crashChild(scenario(runDir, request), cell.label, occurrence), true, 'the scenario reaches the label');
        const journal = openArc(runDir);
        const recovery = await recoverOp(journal, evidenceSnapshotOp);
        assert.equal(recovery.kind === 'closed' && recovery.recoveredBy, recoveredBy);
        assert.equal(journal.view.doneOf(recovery.intent.op)?.recoveredBy, recoveredBy);
        journal.close();
        assert.equal(manifestSha(request.dest), manifestSha(control.request.dest), 'the same manifest as an uncrashed run');
        verifyManifest(request.dest);
      });
    }

    it(`${cell.label}: the scenario reaches it exactly ${occurrences} time(s)`, async () => {
      const { runDir, request } = setup();
      assert.equal(await crashChild(scenario(runDir, request), cell.label, occurrences + 1), false);
      verifyManifest(request.dest);
    });
  }
});
