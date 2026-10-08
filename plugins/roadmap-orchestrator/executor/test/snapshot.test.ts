// Integrated tests of snapshot.publish (src/git/snapshot.ts, src/recover/snapshot.ts): a real run dir
// holding raw evidence, an evidence snapshot, a needs-user and a spec, published to refs/roadmap/<arc>.
// The plan's snapshot.allowlist, snapshot.manifest-mismatch-detected, and the snapshot.* cells of the
// candidate.merge / integration.ff / snapshot.publish matrix row.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { type IntentOf, parseRevisionPayload } from '../src/core/events.ts';
import {
  type NeedsUserId, type Sha, commandId, envId, invocationDirName, invocationId, jobId, laneId, laneRev, needsUserIdForOp, opKey, planRev, seatRev,
  sha, sha256, specRev, unitId,
} from '../src/core/ids.ts';
import { parsePlan } from '../src/input/plan.ts';
import { provenanceStack, resolveRouting } from '../src/routing/layers.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { PLAN_INPUT, RULINGS_INPUT, SPEC_INPUT, keepInput, keepPayload, routingProvenanceOf } from '../src/input/inforce.ts';
import { type AbsPath, absPath, isoTimeOf, repoPattern } from '../src/core/values.ts';
import { git as gitRaw } from '../src/git/git.ts';
import { parentsOf } from '../src/git/mergein.ts';
import {
  type SnapshotPublishRequest, candidateLaneDir, jobLaneDir, snapshotRef, verifySnapshot,
} from '../src/git/snapshot.ts';
import { ARC, IDENTITY, cloneRepo, openArc, runOp } from './fixtures/git-common.ts';
import { UNIT, crashChild8b, recover8b, revOf, sharedBase } from './fixtures/git8b-common.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { CANDIDATE_FF_SNAPSHOT, crashCells } from './matrix.ts';
import { evidenceSnapshotOp, snapshotPublishOp } from '../src/recover/ops.ts';

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
  journal.done(raised.op, 'needsuser.raise', { kind: 'raised' }, null);
  // The ack file first, then its fact (commands/apply.ts): the fact names it into the closure.
  writeFileSync(join(runDir, 'needs-user', `${needsUser}.ack.json`), '{"ack":true}\n');
  journal.fact({ kind: 'needs-user-acked', id: needsUser as NeedsUserId, command: commandId('cmd-0123456789abcdef'), choice: null });
  journal.close();
  return { repo, runDir, spec, needsUser, evidenceSeq: Number(evidence.op.split('/')[1]) };
}

function request(r: Run, highWater: number): SnapshotPublishRequest {
  return { arc: ARC, runDir: r.runDir, highWater, identity: IDENTITY, message: `roadmap: snapshot ${ARC}\n` };
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
    assert.deepEqual(withExtra, { kind: 'mismatch', detail: 'stdout is not in the manifest' });

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

/** A plan-m1 plan of one unit, the arc's `ARC`. */
const PLAN = {
  schema: 'roadmap/plan-m1', arc: ARC, integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/var/tmp/roadmap-wt', contracts: [],
  rulings: 'rulings.md', architectureDoc: 'docs/architecture.md', direction: 'Converge on the documented target state.',
  suite: { lanes: [{ id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] }] },
  resources: [], units: [{ id: UNIT, spec: 'unit-a.spec.json', risk: 'med', scope: ['src/**'], resources: [] }],
};

type Holistic = Run & Readonly<{ planSha: string; specSha: string; payloadSha: string; witnessInv: string; witnessFile: string }>;

/**
 * The base run plus the records a snapshot must follow beyond it: a `plan-applied` (its kept plan, spec, ledger and
 * revision payload) and its dispatch, start.json with its `executor-started`, and a docs job's lane run that wrote its
 * witness record where src/pipeline/publish.ts keeps it and was `witnessed`.
 */
async function holisticRun(witnessFor: 'job' | 'candidate' = 'job'): Promise<Holistic> {
  const r = await run();
  const planSha = keepInput(r.runDir, Buffer.from(`${JSON.stringify(PLAN)}\n`), PLAN_INPUT);
  const specSha = keepInput(r.runDir, Buffer.from('{"schema":"roadmap/spec-m1"}\n'), SPEC_INPUT);
  const ledgerSha = keepInput(r.runDir, Buffer.from('C-1 — a rule\n'), RULINGS_INPUT);
  const provenance = routingProvenanceOf({ profile: 'default' as never, config: null }, parsePlan(PLAN));
  const payloadSha = keepPayload(r.runDir, parseRevisionPayload({
    v: 1, source: { type: 'start' }, base: 0, rev: 1,
    manifest: { planSha256: planSha, specs: { [UNIT]: specSha }, rulings: { ledgerSha256: ledgerSha, sidecars: {} }, obligations: null, vision: null },
    changes: [], dispositions: [], divergences: [], publication: null, routingProvenance: provenance,
  }));
  writeFileSync(join(r.runDir, 'start.json'), `${JSON.stringify({ v: 1, generation: 1, at: '2026-09-30T00:00:00.000Z', repo: r.repo, planFile: '/plan/plan.json', profile: 'default' })}\n`);
  const journal = openArc(r.runDir);
  journal.fact({
    kind: 'plan-applied', rev: planRev(1), command: null, planSha256: planSha, specs: { [UNIT]: specSha }, changes: [], scheduling: 'dag',
    source: { type: 'start' }, payloadSha256: payloadSha, rulingsSha256: ledgerSha, routingProvenance: provenance,
  });
  journal.fact({
    kind: 'dispatch',
    record: {
      unit: unitId(UNIT), specRev: specRev(1), specSha256: specSha, scope: [repoPattern('src/**')], riskFloor: 'med',
      routingRev: resolveRouting(provenanceStack(provenance, 'none', null)).rev, implementerSeatRev: seatRev('fedcba9876543210'), at: isoTimeOf(new Date()), transientRules: 'm3',
    },
  });
  journal.fact({ kind: 'executor-started', generation: 1 });
  const job = jobId('docs', 1);
  const spawn = journal.begin({
    kind: 'proc.spawn', key: opKey(`lane:${job}`), parent: { type: 'arc' }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'lane', unit: UNIT, lane: laneId('journey'), set: 'suite', at: sha('b'.repeat(40)) }, launchSha256: sha256('c'.repeat(64)) }, post: null }),
  });
  const inv = invocationId(spawn.op, 1);
  const witnessDir = witnessFor === 'job' ? jobLaneDir(r.runDir, job, 'arc', laneId('journey'), invocationDirName(inv)) : candidateLaneDir(r.runDir, UNIT, 1, 'arc', laneId('journey'), invocationDirName(inv));
  mkdirSync(witnessDir, { recursive: true });
  const witness = '{"records":[]}\n';
  writeFileSync(join(witnessDir, 'witness.json'), witness);
  journal.fact({
    kind: 'witnessed', lane: laneId('journey'), laneRev: laneRev('0123456789abcdef'), envId: envId('fedcba9876543210'), treeSha: sha('b'.repeat(40)), inv,
    recordsSha256: sha256(sha256Hex(witness)), purpose: 'witness', for: witnessFor === 'job' ? { type: 'job', job } : { type: 'candidate', unit: UNIT, attempt: 1 },
  });
  journal.close();
  return { ...r, planSha, specSha, payloadSha, witnessInv: invocationDirName(inv), witnessFile: join(witnessDir, 'witness.json') };
}

/** `commit`'s tree with `path` set to `text` (null: removed) and its manifest entry rewritten to match. */
function retreed(repo: AbsPath, commit: string, path: string, text: string | null): Sha {
  const blob = (t: string): string => gitRaw(repo, ['hash-object', '-w', '--stdin'], { input: t }).trim();
  const files = new Map(gitRaw(repo, ['ls-tree', '-r', '-z', commit]).split('\0').filter((l) => l !== '').map((l) => {
    const [meta, name] = l.split('\t') as [string, string];
    return [name, meta.split(' ')[2]!] as const;
  }));
  if (text === null) files.delete(path);
  else files.set(path, blob(text));
  const m = JSON.parse(git(repo, 'show', `${commit}:manifest.json`)) as { files: { path: string; sha256: string; size: number; namedBy: unknown }[] };
  const named = m.files.find((f) => f.path === path)?.namedBy ?? { type: 'log' };
  const rest = m.files.filter((f) => f.path !== path);
  m.files = text === null ? rest : [...rest, { path, sha256: sha256Hex(text), size: Buffer.byteLength(text), namedBy: named }].sort((a, b) => (a.path < b.path ? -1 : 1));
  files.set('manifest.json', blob(canonicalJson(m)));
  const tmp = tmpDir('snapshot-retree');
  const indexFile = absPath(join(tmp, 'index'));
  gitRaw(repo, ['update-index', '--add', '-z', '--index-info'], { indexFile, input: [...files].map(([p, o]) => `100644 ${o}\t${p}\0`).join('') });
  const tree = gitRaw(repo, ['write-tree'], { indexFile }).trim();
  rmSync(tmp, { recursive: true, force: true });
  return sha(gitRaw(repo, ['commit-tree', tree, '-m', 'tampered'], { identity: IDENTITY }).trim());
}

describe('snapshot closure records', () => {
  it('snapshot.closure-records: kept inputs, the revision payload, start.json and a job witness are carried; tampering fails', async () => {
    const r = await holisticRun();
    const intent = await publish(r);
    assertSnapshot(r, intent);
    const at = intent.post.new;
    const paths = treePaths(r.repo, at);
    for (const p of [`inputs/${r.planSha}.plan.json`, `inputs/${r.specSha}.spec.json`, `inputs/${r.payloadSha}.revision.json`, 'start.json', `witness/${r.witnessInv}.json`]) {
      assert.ok(paths.includes(p), `${p} is in the snapshot: ${paths.join(', ')}`);
    }
    const manifest = JSON.parse(git(r.repo, 'show', `${at}:manifest.json`)) as { files: { path: string; namedBy: { type: string } }[] };
    assert.equal(manifest.files.find((f) => f.path === `witness/${r.witnessInv}.json`)?.namedBy.type, 'event', 'the witnessed fact names the record');

    // A named item changed with its manifest entry kept consistent: its naming record still disagrees.
    const forged = verifySnapshot(r.repo, retreed(r.repo, at, `witness/${r.witnessInv}.json`, '{"records":["forged"]}\n'));
    assert.equal(forged.kind, 'mismatch');
    if (forged.kind === 'mismatch') assert.match(forged.detail, /^witness\/.+\.json hashes to [0-9a-f]{64}, event \d+ names [0-9a-f]{64}$/);
    // A file no record names, listed in the manifest: outside the closure.
    assert.deepEqual(verifySnapshot(r.repo, retreed(r.repo, at, 'inv/9-1/stdout', 'raw\n')), { kind: 'mismatch', detail: 'inv/9-1/stdout is not in the snapshot closure' });
    // A named item dropped from tree and manifest alike: the closure misses it.
    const dropped = verifySnapshot(r.repo, retreed(r.repo, at, 'start.json', null));
    assert.equal(dropped.kind, 'mismatch');
    if (dropped.kind === 'mismatch') assert.match(dropped.detail, /^start\.json, which event \d+ names, is not in the snapshot$/);
  });

  it('a named record that cannot be located fails the publication loudly; a candidate\'s witness record is carried from its execution\'s dir', async () => {
    const r = await holisticRun();
    rmSync(r.witnessFile);
    await assert.rejects(publish(r), /witness record .*witness\.json does not exist/);
    const c = await holisticRun('candidate');
    const intent = await publish(c);
    assertSnapshot(c, intent);
    assert.ok(treePaths(c.repo, intent.post.new).includes(`witness/${c.witnessInv}.json`));
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
