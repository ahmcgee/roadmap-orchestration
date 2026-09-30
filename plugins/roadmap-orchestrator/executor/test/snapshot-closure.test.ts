// The snapshot closure over a real arc (src/git/snapshot.ts; plan "Snapshot = the transitive closure of
// authoritative records", G6/H6): `roadmap start` runs one unit through plan-check, build, gate, ff and snapshot
// with fake backends, then the published ref is checked against the log. Named tests: snapshot.closure,
// snapshot.reconstruct-alone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { type Sha, arcId, invocationDirName, invocationId, sha } from '../src/core/ids.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import { git as gitRaw, gitRun, lsTree } from '../src/git/git.ts';
import { snapshotRef, snapshotRequestOf, verifySnapshot } from '../src/git/snapshot.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { status } from '../src/status.ts';
import { runOp } from './fixtures/git-common.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, setupExec, startExec } from './fixtures/exec-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { gateStep, mulBuild } from './fixtures/unit-common.ts';
import { assertNoSurvivors } from './helpers/reap.ts';

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
