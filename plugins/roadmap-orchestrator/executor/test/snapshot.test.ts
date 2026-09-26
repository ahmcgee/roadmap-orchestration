// Integrated tests of snapshot.publish (src/git/snapshot.ts, src/recover/snapshot.ts): a real run dir
// holding raw evidence, an evidence snapshot, a needs-user and a spec, published to refs/roadmap/<arc>.
// The plan's snapshot.allowlist, snapshot.manifest-mismatch-detected, and the snapshot.* cells of the
// candidate.merge / integration.ff / snapshot.publish matrix row.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { needsUserIdForOp, opKey, sha, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { type AbsPath, absPath, repoPattern } from '../src/core/values.ts';
import { evidenceSnapshotOp } from '../src/git/evidence.ts';
import { git as gitRaw } from '../src/git/git.ts';
import { parentsOf } from '../src/git/mergein.ts';
import { type SnapshotPublishRequest, snapshotPublishOp, snapshotRef, verifySnapshot } from '../src/git/snapshot.ts';
import { ARC, IDENTITY, cloneRepo, openArc, runOp } from './fixtures/git-common.ts';
import { UNIT, crashChild8b, recover8b, revOf, sharedBase } from './fixtures/git8b-common.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { CANDIDATE_FF_SNAPSHOT, crashCells } from './matrix.ts';

const REF = snapshotRef(ARC);

let base: string;
before(() => {
  base = sharedBase();
});

type Run = Readonly<{ repo: AbsPath; runDir: AbsPath; spec: AbsPath; needsUser: string; evidenceSeq: number }>;

/**
 * A run dir as the pipeline leaves it: raw runner output under inv/, an evidence snapshot (raw files plus
 * its manifest) done in the journal, a raised needs-user with its ack, and the unit's spec beside the plan.
 */
async function run(): Promise<Run> {
  const root = tmpDir('snapshot');
  const repo = cloneRepo(base, join(root, 'repo'));
  const runDir = absPath(join(root, 'run'));
  mkdirSync(join(runDir, 'inv', '1-1'), { recursive: true });
  writeFileSync(join(runDir, 'inv', '1-1', 'stdout'), 'raw stdout\n');
  writeFileSync(join(runDir, 'inv', '1-1', 'stderr'), 'raw stderr\n');
  const source = join(root, 'lane-out');
  mkdirSync(source);
  writeFileSync(join(source, 'lane.log'), 'raw lane output\n');
  const spec = absPath(join(root, 'plan', 'unit-a.spec.json'));
  mkdirSync(join(root, 'plan'));
  writeFileSync(spec, '{"schema":"roadmap/spec-m1"}\n');

  const journal = openArc(runDir);
  const evidence = await runOp(journal, evidenceSnapshotOp, 'evidence:unit', {
    source: absPath(source), globs: [repoPattern('**/*')], dest: absPath(join(runDir, 'evidence', 'lane-1')),
  });
  const content = '{"needs":"user"}\n';
  let needsUser = '';
  const raised = journal.begin({
    kind: 'needsuser.raise', key: opKey('needsuser'), parent: { type: 'arc' }, deadlineAt: null,
    body: (op) => {
      needsUser = needsUserIdForOp(op);
      return { expect: { id: needsUserIdForOp(op), path: absPath(join(runDir, 'needs-user', `${needsUser}.json`)), blocking: true }, post: { sha256: sha256(sha256Hex(content)) } };
    },
  });
  mkdirSync(join(runDir, 'needs-user'));
  writeFileSync(join(runDir, 'needs-user', `${needsUser}.json`), content);
  writeFileSync(join(runDir, 'needs-user', `${needsUser}.ack.json`), '{"ack":true}\n');
  journal.done(raised.op, 'needsuser.raise', { kind: 'raised' }, null);
  journal.close();
  return { repo, runDir, spec, needsUser, evidenceSeq: Number(evidence.op.split('/')[1]) };
}

function request(r: Run, highWater: number): SnapshotPublishRequest {
  return { arc: ARC, runDir: r.runDir, highWater, specs: [{ unit: UNIT, path: r.spec }], identity: IDENTITY, message: `roadmap: snapshot ${ARC}\n` };
}

async function publish(r: Run): Promise<IntentOf<'snapshot.publish'>> {
  const journal = openArc(r.runDir);
  const intent = await runOp(journal, snapshotPublishOp(r.repo), 'snapshot:arc', request(r, journal.view.highWater()));
  journal.close();
  return intent;
}

const treePaths = (repo: string, rev: string): string[] => git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n');

/** The oracle: the ref at the recorded commit, which verifies against its own manifest at the recorded mark. */
function assertSnapshot(r: Run, intent: IntentOf<'snapshot.publish'>): void {
  const next = intent.post.new;
  assert.equal(revOf(r.repo, REF), next);
  const check = verifySnapshot(r.repo, next);
  assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
  if (check.kind !== 'verified') return;
  assert.equal(check.manifest.highWater, intent.expect.highWater, 'the high-water mark is carried');
  assert.equal(check.manifestSha256, intent.expect.manifestSha256);
  assert.deepEqual(parentsOf(r.repo, next), intent.expect.old === null ? [] : [intent.expect.old], 'one commit on the old ref: no duplicate');
}

describe('snapshot.publish', () => {
  it('snapshot.allowlist: evidence never appears; the manifest verifies; the mark is carried; a second publish has the first as parent', async () => {
    const r = await run();
    const first = await publish(r);
    assertSnapshot(r, first);
    assert.equal(first.expect.old, null);
    assert.deepEqual(first.expect.commit.parents, []);
    assert.deepEqual(treePaths(r.repo, first.post.new), [
      'events.jsonl',
      `evidence-manifests/${r.evidenceSeq}.json`,
      'manifest.json',
      `needs-user/${r.needsUser}.ack.json`,
      `needs-user/${r.needsUser}.json`,
      'specs/unit-a.json',
      'state.json',
    ]);
    for (const raw of ['raw stdout', 'raw stderr', 'raw lane output']) {
      assert.throws(() => git(r.repo, 'grep', '-q', '--fixed-strings', raw, first.post.new), /exited 1/, `${raw} is not in the snapshot`);
    }
    const events = git(r.repo, 'show', `${first.post.new}:events.jsonl`).split('\n');
    assert.equal(events.length, first.expect.highWater);
    const state = JSON.parse(git(r.repo, 'show', `${first.post.new}:state.json`)) as { lastSeq: number; needsUser: string[] };
    assert.equal(state.lastSeq, first.expect.highWater, 'the state folded from exactly the carried events');
    assert.deepEqual(state.needsUser, [r.needsUser]);
    const evidenceManifest = git(r.repo, 'show', `${first.post.new}:evidence-manifests/${r.evidenceSeq}.json`);
    assert.match(evidenceManifest, /"path":"lane\.log","sha256":"[0-9a-f]{64}"/, 'the evidence is carried as its sha256 manifest only');

    const second = await publish(r);
    assertSnapshot(r, second);
    assert.equal(second.expect.old, first.post.new);
    assert.deepEqual(second.expect.commit.parents, [first.post.new]);
    assert.ok(second.expect.highWater > first.expect.highWater, 'the first publication\'s own events are in the second');
    assert.equal(revOf(r.repo, `${REF}^`), first.post.new);
  });

  it('snapshot.manifest-mismatch-detected: a tampered blob or an extra file fails verifySnapshot', async () => {
    const r = await run();
    const intent = await publish(r);
    const entries = gitRaw(r.repo, ['ls-tree', intent.post.new]);
    const retree = (replace: (lines: string[]) => string[]): string => {
      const tree = gitRaw(r.repo, ['mktree'], { input: `${replace(entries.trimEnd().split('\n')).join('\n')}\n` }).trim();
      return gitRaw(r.repo, ['commit-tree', tree, '-m', 'tampered'], { identity: IDENTITY }).trim();
    };
    const blob = (text: string): string => gitRaw(r.repo, ['hash-object', '-w', '--stdin'], { input: text }).trim();

    const events = git(r.repo, 'show', `${intent.post.new}:events.jsonl`);
    const tampered = retree((lines) => lines.map((l) => (l.endsWith('\tevents.jsonl') ? `100644 blob ${blob(`${events.replace('"arc"', '"arc" ')}\n`)}\tevents.jsonl` : l)));
    const bad = verifySnapshot(r.repo, sha(tampered));
    assert.equal(bad.kind, 'mismatch');
    if (bad.kind === 'mismatch') assert.match(bad.detail, /^events\.jsonl hashes to /);

    const extra = retree((lines) => [...lines, `100644 blob ${blob('raw stdout\n')}\tstdout`]);
    const withExtra = verifySnapshot(r.repo, sha(extra));
    assert.deepEqual(withExtra, { kind: 'mismatch', detail: 'stdout is not an allowlisted snapshot path' });

    const missing = retree((lines) => lines.filter((l) => !l.endsWith('\tstate.json')));
    assert.deepEqual(verifySnapshot(r.repo, sha(missing)), { kind: 'mismatch', detail: 'manifest lists missing files state.json' });

    assert.equal(verifySnapshot(r.repo, intent.post.new).kind, 'verified', 'the published one still verifies');
  });

  it('aborts recovery when someone else moved the snapshot ref', async () => {
    const r = await run();
    const scenario = { op: 'snapshot', runDir: r.runDir, repo: r.repo, spec: r.spec } as const;
    assert.equal(await crashChild8b(scenario, 'snapshot.act-start', 1), true);
    git(r.repo, 'update-ref', REF, revOf(r.repo, 'main'));
    const journal = openArc(r.runDir);
    const recovery = await recover8b(journal, snapshotPublishOp(r.repo));
    assert.equal(recovery.kind, 'aborted');
    assert.equal(journal.view.openIntents().length, 0);
    journal.close();
  });
});

describe(`matrix row ${CANDIDATE_FF_SNAPSHOT}: snapshot.publish`, () => {
  const EXPECTED: Readonly<Record<string, 'redone' | 'reconciled'>> = {
    'snapshot.act-start': 'redone',
    'snapshot.after-commit-tree': 'redone',
    'snapshot.act-end': 'reconciled',
  };
  const cells = crashCells(CANDIDATE_FF_SNAPSHOT).filter((c) => c.label.startsWith('snapshot.'));

  it('covers exactly the row\'s snapshot labels', () => {
    assert.deepEqual(cells.map((c) => c.label).sort(), Object.keys(EXPECTED).sort());
  });

  for (const cell of cells) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const r = await run();
      const scenario = { op: 'snapshot', runDir: r.runDir, repo: r.repo, spec: r.spec } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 1), true, 'the scenario reaches the label');

      const journal = openArc(r.runDir);
      const recovery = await recover8b(journal, snapshotPublishOp(r.repo));
      assert.equal(recovery.kind, 'closed', recovery.kind !== 'closed' ? recovery.detail : '');
      if (recovery.kind !== 'closed') return;
      assert.equal(recovery.recoveredBy, EXPECTED[cell.label]);
      assert.deepEqual(journal.view.doneOf(recovery.intent.op)?.outcome, { kind: 'published' });
      assert.equal(journal.view.openIntents().length, 0);
      assert.equal(journal.derived().snapshotHighWater, (recovery.intent as IntentOf<'snapshot.publish'>).expect.highWater);
      journal.close();
      assertSnapshot(r, recovery.intent as IntentOf<'snapshot.publish'>);
    });

    it(`${cell.label}: the scenario reaches it exactly once`, async () => {
      const r = await run();
      const scenario = { op: 'snapshot', runDir: r.runDir, repo: r.repo, spec: r.spec } as const;
      assert.equal(await crashChild8b(scenario, cell.label, 2), false);
      assert.equal(verifySnapshot(r.repo, revOf(r.repo, REF)).kind, 'verified');
    });
  }
});
