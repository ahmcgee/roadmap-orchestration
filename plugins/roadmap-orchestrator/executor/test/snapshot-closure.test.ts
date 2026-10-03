// The snapshot closure over a real arc (src/git/snapshot.ts; plan "Snapshot = the transitive closure of
// authoritative records", G6/H6): `roadmap start` runs one unit through plan-check, build, gate, ff and snapshot
// with fake backends, then the published ref is checked against the log. Named tests: snapshot.closure,
// snapshot.reconstruct-alone. M4a step C2, over a sealed corpus arc (test/helpers/corpusarc.ts): snapshot.corpus-closure,
// snapshot.phase0-capture-closure, snapshot.issues-and-packreview-closure, and snapshot.reconstruct-alone extended to the
// corpus inputs, a checkpoint's issue capture and a pack review's inputs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { type Sha, type Sha256Hex, arcId, invocationDirName, invocationId, jobId, sha, sha256 } from '../src/core/ids.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { materialiseCorpus } from '../src/corpus/materialise.ts';
import { type CorpusPin, parseCorpusPin } from '../src/corpus/types.ts';
import { parseIssueCapture } from '../src/forge/types.ts';
import { PACK_REVIEW_INPUTS_SCHEMA, parsePackReviewInputs } from '../src/holistic/types.ts';
import { packReviewKey } from '../src/holistic/packreview.ts';
import {
  CORPUS_FILE_INPUT, ISSUES_INPUT, PACK_REVIEW_INPUT, keepInput, keptInput, planInForce, revisionInForce,
} from '../src/input/inforce.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { git as gitRaw, gitRun, lsTree } from '../src/git/git.ts';
import { type SnapshotFile, snapshotRef, snapshotRequestOf, verifySnapshot } from '../src/git/snapshot.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { status } from '../src/status.ts';
import { runOp } from './fixtures/git-common.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, setupExec, startExec } from './fixtures/exec-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { gateStep, mulBuild } from './fixtures/unit-common.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { CAPTURE_FILE, type CorpusArc, PHASE0_FILE, PIN_FILE, corpusArc, newHostDir, runDirOfArc, seal } from './helpers/corpusarc.ts';
import { DEFAULT_REPO } from './helpers/forge.ts';
import { git, tmpDir } from './helpers/repo.ts';

after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };

/** One unit run to complete by the real executor: plan-check and gate are Claude judgments, the build Codex's. */
async function completedArc(t: Parameters<typeof setupExec>[0]): Promise<ExecRun> {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 0, exit.stderr);
  return r;
}

const refAt = (r: ExecRun): Sha => sha(gitRaw(absPath(r.repo), ['rev-parse', snapshotRef(arcId(r.arc))]).trim());
const blob = (r: ExecRun, commit: string, path: string): string => gitRun(absPath(r.repo), ['cat-file', 'blob', `${commit}:${path}`]).stdout;

/** What the log up to `highWater` names, computed here independently of the collector: path → the sha256 it states, or null. */
function expectedClosure(r: ExecRun, events: readonly Event[]): ReadonlyMap<string, string | null> {
  const out = new Map<string, string | null>();
  const input = (s: string, ext: string): void => void out.set(`inputs/${s}.${ext}`, s);
  const intents = new Map(events.flatMap((e) => (e.type === 'intent' ? [[e.op, e] as const] : [])));
  for (const e of events) {
    if (e.type === 'fact' && e.fact.kind === 'plan-applied') {
      const f = e.fact;
      assert.ok(f.payloadSha256 !== undefined && f.routingProvenance !== undefined, 'a dev.6 start records its payload and routing provenance');
      input(f.payloadSha256, 'revision.json');
      input(f.planSha256, 'plan.json');
      for (const s of Object.values(f.specs)) input(s, 'spec.json');
      if (f.rulingsSha256 !== undefined) input(f.rulingsSha256, 'rulings.md');
    }
    if (e.type === 'fact' && e.fact.kind === 'dispatch') input(e.fact.record.specSha256, 'spec.json');
    if (e.type === 'fact' && e.fact.kind === 'judgment-inputs') input(e.fact.specSha256, 'spec.json');
    if (e.type === 'fact' && e.fact.kind === 'executor-started') out.set('start.json', null);
    if (e.type !== 'done') continue;
    const intent = intents.get(e.op)!;
    if (intent.kind === 'spec.patch') input(intent.post.newSha256, 'spec.json');
    if (e.kind === 'evidence.snapshot' && e.outcome.kind === 'captured') out.set(`evidence-manifests/${e.op.split('/')[1]}.json`, e.outcome.manifestSha256);
    if (e.kind === 'proc.spawn' && e.outcome.kind === 'result' && intent.kind === 'proc.spawn' && intent.expect.subject.purpose === 'backend') {
      const dir = `inv/${invocationDirName(invocationId(intent.op, intent.ordinal))}`;
      out.set(`${dir}/result.json`, e.outcome.resultSha256);
      if (existsSync(join(r.runDir, dir, 'reads.json'))) out.set(`${dir}/reads.json`, null);
    }
  }
  return out;
}

test('snapshot.closure: the ref published after the unit holds every record its log names, verifies, and a tampered item fails', T, async (t) => {
  const r = await completedArc(t);
  const at = refAt(r);
  const check = verifySnapshot(absPath(r.repo), at);
  assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
  if (check.kind !== 'verified') return;

  const events = readJournal(absPath(r.runDir), arcId(r.arc)).events.filter((e) => e.seq <= check.manifest.highWater);
  const expected = expectedClosure(r, events);
  const listed = new Map(check.manifest.files.map((f) => [f.path as string, f.sha256 as string]));
  for (const [path, want] of expected) {
    assert.ok(listed.has(path), `${path} is in the snapshot`);
    if (want !== null) assert.equal(listed.get(path), want, `${path} hashes as its naming record states`);
  }
  const judgments = events.filter((e) => e.type === 'fact' && e.fact.kind === 'judgment-inputs');
  assert.equal(judgments.length, 2, 'plan-check and gate were admitted with judgment inputs');
  const results = [...expected.keys()].filter((p) => p.endsWith('/result.json'));
  assert.ok(results.length >= 3, `plan-check, build and gate results are carried: ${results.join(', ')}`);
  assert.ok([...expected.keys()].some((p) => p.endsWith('/reads.json')), 'a Claude judgment\'s reads.json is carried');
  for (const path of listed.keys()) assert.ok(!/(^|\/)(stdout|stderr)$/.test(path), `${path}: raw output never enters the snapshot`);

  // Tamper with the gate's result.json: the tree then disagrees with the manifest.
  const repo = absPath(r.repo);
  const target = results.at(-1)!;
  const entries = lsTree(repo, at).map((e) => `${e.mode} ${e.type} ${e.path === target ? gitRaw(repo, ['hash-object', '-w', '--stdin'], { input: `${blob(r, at, target).trimEnd()} \n` }).trim() : e.object}\t${e.path}`);
  const index = absPath(join(dirname(r.runDir), 'tamper-index'));
  gitRaw(repo, ['update-index', '--add', '--index-info'], { indexFile: index, input: `${entries.join('\n')}\n` });
  const tree = gitRaw(repo, ['write-tree'], { indexFile: index }).trim();
  rmSync(index);
  const tampered = verifySnapshot(repo, sha(gitRaw(repo, ['commit-tree', tree, '-m', 'tampered'], { identity: executorIdentity() }).trim()));
  assert.equal(tampered.kind, 'mismatch');
  if (tampered.kind === 'mismatch') assert.match(tampered.detail, new RegExp(`^${target.replace(/[.]/g, '\\.')} hashes to `));
});

/** Writes every file of snapshot `commit` but its manifest into `runDir`: its records at their run-dir paths. */
function restore(r: ExecRun, commit: Sha, runDir: AbsPath): void {
  for (const e of lsTree(absPath(r.repo), commit)) {
    if (e.path === 'manifest.json') continue;
    const bytes = blob(r, commit, e.path);
    mkdirSync(dirname(join(runDir, e.path)), { recursive: true });
    writeFileSync(join(runDir, e.path), bytes);
  }
}

test('snapshot.reconstruct-alone: the run dir deleted and restored from the ref alone derives the same status', T, async (t) => {
  const r = await completedArc(t);
  const runDir = absPath(r.runDir);
  const arc = arcId(r.arc);
  // The terminal snapshot: everything the arc logged, published through the op at the log's high-water mark.
  const journal = openJournal(runDir, arc);
  await runOp(journal, snapshotPublishOp(absPath(r.repo)), `snapshot:${arc}`, snapshotRequestOf({
    view: journal.view, runDir, identity: executorIdentity(), message: `roadmap ${arc}: terminal snapshot\n`,
  }));
  journal.close();
  const before = status(runDir, arc, absPath(r.hostDir));
  const at = refAt(r);
  assert.equal(verifySnapshot(absPath(r.repo), at).kind, 'verified');

  rmSync(runDir, { recursive: true, force: true });
  restore(r, at, runDir);
  const after = status(runDir, arc, absPath(r.hostDir));
  assert.equal(before.run.state, 'complete');
  assert.ok(before.plan !== null && before.routing !== null && before.spend.byModel.models.length > 0, 'plan in force, routing and spend by model are derived');
  // heartbeat.json is liveness, not a record: the only field the snapshot does not carry. `host.log` measures the log
  // file itself, which the snapshot carries up to its high-water (its own publication's op lines come after).
  const records = (s: typeof before) => ({ ...s, run: { ...s.run, heartbeatAt: null }, host: { ...s.host, log: null } });
  assert.deepEqual(records(after), records(before));
});

// ---------------------------------------------------------------------------------------------------
// M4a (C2): a corpus arc's closure

type Sealed = Readonly<{ a: CorpusArc; at: Sha; captureSha: Sha256Hex; packSha: Sha256Hex; pinSha: Sha256Hex }>;

/**
 * A corpus arc in force, completed and sealed by its terminal snapshot, after a checkpoint's issue capture (`issues-captured`,
 * its bytes kept as `inputs/<sha>.issues.json`) and a pack review's kept inputs (`pack-review-started`).
 */
async function sealedCorpusArc(): Promise<Sealed> {
  const a = await corpusArc();
  const runDir = runDirOfArc(a);
  let captureSha: Sha256Hex | null = null;
  let packSha: Sha256Hex | null = null;
  await seal(a, {
    before: (j) => {
      // The checkpoint's capture: the Phase-0 one with its issue since closed (other bytes, so its own naming record).
      const phase0Capture = parseIssueCapture(JSON.parse(readFileSync(join(a.planDir, CAPTURE_FILE), 'utf8')));
      assert.ok(phase0Capture.issues.length > 0);
      captureSha = keepInput(runDir, Buffer.from(canonicalJson({ ...phase0Capture, issues: [] }), 'utf8'), ISSUES_INPUT);
      j.fact({ kind: 'issues-captured', job: jobId('ckpt', 1), sha256: captureSha, repo: DEFAULT_REPO, filtered: { comments: 0, pullRequests: 0 } });
      const inForce = planInForce(runDir, j.view)!;
      const revision = revisionInForce(runDir, inForce);
      const inputs = parsePackReviewInputs({
        schema: PACK_REVIEW_INPUTS_SCHEMA, job: 'review-1', planRev: inForce.rev, planSha256: inForce.manifest.planSha256,
        specs: Object.entries(inForce.manifest.specs).map(([unit, sha256]) => ({ unit, sha256 })), obligationsSha256: revision.obligations!.sha256,
        corpusPinSha256: revision.corpus!.pin.sha256, phase0Sha256: revision.corpus!.phase0.sha256, visionSha256: revision.vision!.sha256,
        head: git(a.repo, 'rev-parse', 'HEAD'), routingRev: '0123456789abcdef',
      });
      packSha = keepInput(runDir, Buffer.from(canonicalJson(inputs), 'utf8'), PACK_REVIEW_INPUT);
      j.fact({ kind: 'pack-review-started', job: jobId('review', 1), planRev: inForce.rev, inputsSha256: packSha, key: packReviewKey(inputs) });
    },
  });
  const at = sha(gitRaw(a.repo, ['rev-parse', snapshotRef(a.arc)]).trim());
  return { a, at, captureSha: captureSha!, packSha: packSha!, pinSha: sha256(sha256Hex(readFileSync(join(a.planDir, PIN_FILE)))) };
}

/** The verified manifest of `s`'s ref, by path. */
function listedOf(s: Sealed): ReadonlyMap<string, SnapshotFile> {
  const check = verifySnapshot(s.a.repo, s.at);
  assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
  if (check.kind !== 'verified') throw new Error('unreachable');
  return new Map(check.manifest.files.map((f) => [f.path as string, f]));
}

const pinOf = (s: Sealed): CorpusPin => parseCorpusPin(JSON.parse(readFileSync(join(s.a.planDir, PIN_FILE), 'utf8')));

/** The tree of `commit` without `drop`, its manifest rewritten to match: what a collector that missed `drop` would publish. */
function withoutFile(repo: AbsPath, commit: Sha, drop: string): Sha {
  const manifest = JSON.parse(gitRun(repo, ['cat-file', 'blob', `${commit}:manifest.json`]).stdout) as { files: { path: string }[] };
  const rewritten = { ...manifest, files: manifest.files.filter((f) => f.path !== drop) };
  const blob = gitRaw(repo, ['hash-object', '-w', '--stdin'], { input: canonicalJson(rewritten) }).trim();
  const entries = lsTree(repo, commit).filter((e) => e.path !== drop).map((e) => `${e.mode} ${e.type} ${e.path === 'manifest.json' ? blob : e.object}\t${e.path}`);
  const index = absPath(join(tmpDir('c2-tamper'), 'index'));
  gitRaw(repo, ['update-index', '--add', '--index-info'], { indexFile: index, input: `${entries.join('\n')}\n` });
  const tree = gitRaw(repo, ['write-tree'], { indexFile: index }).trim();
  return sha(gitRaw(repo, ['commit-tree', tree, '-m', 'tampered'], { identity: executorIdentity() }).trim());
}

test('snapshot.corpus-closure: the ref carries the guide, the pin and every pinned corpus file (named by the pin); one missing fails verification', T, async () => {
  const s = await sealedCorpusArc();
  const listed = listedOf(s);
  const pinPath = `inputs/${s.pinSha}.corpus.json`;
  assert.ok(listed.get(pinPath)?.namedBy.type === 'item', 'the pin is named by its revision payload');
  const guide = [...listed.keys()].filter((p) => p.endsWith('.corpus-guide.md'));
  assert.equal(guide.length, 1);
  assert.equal(gitRun(s.a.repo, ['cat-file', 'blob', `${s.at}:${guide[0]}`]).stdout, readFileSync(join(s.a.repo, '.roadmap/corpus.md'), 'utf8'));
  const pin = pinOf(s);
  for (const f of pin.files) {
    const entry = listed.get(`inputs/${f.sha256}.corpus-file`);
    assert.ok(entry !== undefined, `${f.path} is carried`);
    assert.deepEqual(entry.namedBy, { type: 'item', path: pinPath });
  }
  const dropped = `inputs/${pin.files[0]!.sha256}.corpus-file`;
  const tampered = verifySnapshot(s.a.repo, withoutFile(s.a.repo, s.at, dropped));
  assert.equal(tampered.kind, 'mismatch');
  if (tampered.kind === 'mismatch') assert.match(tampered.detail, new RegExp(`^${dropped.replace(/[.]/g, '\\.')}, which inputs/`));
});

test('snapshot.phase0-capture-closure: the ref carries the Phase-0 record and the issue capture it names, as the plan dir holds them', T, async () => {
  const s = await sealedCorpusArc();
  const listed = listedOf(s);
  for (const [file, ext] of [[PHASE0_FILE, 'phase0.json'], [CAPTURE_FILE, 'issues.json']] as const) {
    const bytes = readFileSync(join(s.a.planDir, file));
    const path = `inputs/${sha256Hex(bytes)}.${ext}`;
    assert.ok(listed.get(path)?.namedBy.type === 'item', `${file} is named by its revision payload`);
    assert.equal(gitRun(s.a.repo, ['cat-file', 'blob', `${s.at}:${path}`]).stdout, bytes.toString('utf8'));
  }
  const tampered = verifySnapshot(s.a.repo, withoutFile(s.a.repo, s.at, `inputs/${sha256Hex(readFileSync(join(s.a.planDir, CAPTURE_FILE)))}.issues.json`));
  assert.equal(tampered.kind, 'mismatch');
});

test('snapshot.issues-and-packreview-closure: a checkpoint\'s kept capture and a pack review\'s kept inputs are named by their facts', T, async () => {
  const s = await sealedCorpusArc();
  const listed = listedOf(s);
  const events = readJournal(runDirOfArc(s.a), s.a.arc).events;
  const seqOf = (kind: string): number => events.find((e) => e.type === 'fact' && e.fact.kind === kind)!.seq;
  assert.deepEqual(listed.get(`inputs/${s.captureSha}.issues.json`)?.namedBy, { type: 'event', seq: seqOf('issues-captured') });
  assert.deepEqual(listed.get(`inputs/${s.packSha}.pack-review.json`)?.namedBy, { type: 'event', seq: seqOf('pack-review-started') });
  const tampered = verifySnapshot(s.a.repo, withoutFile(s.a.repo, s.at, `inputs/${s.packSha}.pack-review.json`));
  assert.equal(tampered.kind, 'mismatch');
});

test('snapshot.reconstruct-alone (corpus): the run dir deleted and restored from the ref alone holds the corpus inputs in force, the pinned files, the captures and the pack-review inputs; status is unchanged', T, async () => {
  const s = await sealedCorpusArc();
  const runDir = runDirOfArc(s.a);
  const hostDir = newHostDir();
  const before = status(runDir, s.a.arc, hostDir);
  rmSync(runDir, { recursive: true, force: true });
  for (const e of lsTree(s.a.repo, s.at)) {
    if (e.path === 'manifest.json') continue;
    mkdirSync(dirname(join(runDir, e.path)), { recursive: true });
    writeFileSync(join(runDir, e.path), gitRun(s.a.repo, ['cat-file', 'blob', `${s.at}:${e.path}`]).stdout);
  }
  const journal = openJournal(runDir, s.a.arc);
  try {
    const corpus = revisionInForce(runDir, planInForce(runDir, journal.view)!).corpus;
    assert.ok(corpus !== null, 'the corpus inputs in force read back');
    assert.equal(corpus.pin.sha256, s.pinSha);
    assert.equal(corpus.guide.bytes.toString('utf8'), readFileSync(join(s.a.repo, '.roadmap/corpus.md'), 'utf8'));
    assert.equal(corpus.capture.bytes.toString('utf8'), readFileSync(join(s.a.planDir, CAPTURE_FILE), 'utf8'));
    for (const f of corpus.pin.value.files) assert.ok(keptInput(runDir, f.sha256, CORPUS_FILE_INPUT) !== null, `${f.path} restored`);
    const dir = materialiseCorpus(runDir, corpus.pin.value, corpus.pin.sha256, 'without-vision', (f) => keptInput(runDir, f.sha256, CORPUS_FILE_INPUT)!);
    assert.ok(existsSync(join(dir, corpus.pin.value.rules[0]!.file)), 'the gate\'s view materialises from the restored bytes');
    assert.ok(keptInput(runDir, s.captureSha, ISSUES_INPUT) !== null, 'the checkpoint\'s capture restored');
    const pack = keptInput(runDir, s.packSha, PACK_REVIEW_INPUT);
    assert.ok(pack !== null, 'the pack review\'s inputs restored');
    assert.equal(parsePackReviewInputs(JSON.parse(pack.toString('utf8'))).corpusPinSha256, s.pinSha);
  } finally {
    journal.close();
  }
  const after = status(runDir, s.a.arc, hostDir);
  const records = (x: typeof before) => ({ ...x, run: { ...x.run, heartbeatAt: null }, host: { ...x.host, log: null } });
  assert.deepEqual(records(after), records(before));
});
