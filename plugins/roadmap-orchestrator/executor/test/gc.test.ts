// `roadmap gc` (src/commands/gc.ts; plan "Growth controls", A20/H5, G6-G8), integrated: real repos, real run dirs
// under the repo's git common dir, real snapshot refs published through the op, a real host dir. An arc is sealed
// here as the executor leaves one: its plan applied, raw evidence captured (an evidence snapshot, invocation output,
// witness lines of a job lane, a mutant and a candidate journey, an implementer's work dir), `arc-completed`, then the terminal snapshot. Named tests:
// gc.keeps-records, gc.refuses-live, gc.dry-run, gc.host-files, gc.sealed-after-head-advanced,
// gc.refuses-later-work, gc.verifies-before-delete, gc.generation-cited-kept, gc.crash-resumable.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import { DEFAULT_KEEP, GC_DELETING, type GcOutcome, type GcReport, gc, sealingOf } from '../src/commands/gc.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type ArcId, type NeedsUserId, type Sha, arcId, commandId, invocationId, opId, poolInstance, resourceName, sha, supervisorNeedsUserId, unitId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import type { ProcIdentity } from '../src/core/records.ts';
import { type AbsPath, absPath, repoPattern } from '../src/core/values.ts';
import { writeFileNeedsUser } from '../src/executor.ts';
import { compactResidues } from '../src/host/compact.ts';
import { HOST_LOCK, hostPath, openHostDir } from '../src/host/hostdir.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost, readClaim, releaseHost } from '../src/host/lock.ts';
import { publishOwner } from '../src/host/owner.ts';
import { RESIDUE_ARCHIVE, recordDisposition, recordResidue } from '../src/host/residues.ts';
import { runDir as runDirOf } from '../src/input/cli.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { git as gitRaw, gitCommonDir, lsTree } from '../src/git/git.ts';
import { snapshotRef, snapshotRequestOf } from '../src/git/snapshot.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { evidenceSnapshotOp, snapshotPublishOp } from '../src/recover/ops.ts';
import { status } from '../src/status.ts';
import { runOp } from './fixtures/git-common.ts';
import { claimRecord } from './fixtures/host-records.ts';
import { BASE } from './fixtures/route-common.ts';
import { setupArc } from './fixtures/unit-common.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { GC, crashCells } from './matrix.ts';
import { git, revParse, tmpDir } from './helpers/repo.ts';

const T = { timeout: 60_000 };
const CLI_TIMEOUT_MS = 30_000;

type Arc = Readonly<{ arc: ArcId; repo: AbsPath; planPath: AbsPath; runDir: AbsPath }>;

const newHost = (): AbsPath => openHostDir(absPath(join(tmpDir('gc-host'), 'roadmap')));

/** A fresh repo and plan (unit u1 on `main`); the arc's run dir is under the repo's git common dir, as a start makes it. */
function newArc(): Arc {
  const d = setupArc({ steps: [] });
  const repo = absPath(d.repo);
  const arc = arcId(d.arc);
  return { arc, repo, planPath: absPath(d.planPath), runDir: runDirOf(gitCommonDir(repo), arc) };
}

/** Another arc of `a`'s repo: the same plan files under a new arc name. */
function sibling(a: Arc, name: string): Arc {
  const dir = tmpDir('gc-plan');
  cpSync(dirname(a.planPath), dir, { recursive: true });
  const planPath = absPath(join(dir, 'plan.json'));
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
  const arc = arcId(`${a.arc}-${name}`);
  writeFileSync(planPath, JSON.stringify({ ...plan, arc }));
  return { arc, repo: a.repo, planPath, runDir: runDirOf(gitCommonDir(a.repo), arc) };
}

/** The raw evidence `seal` leaves in `a`'s run dir, as gc names it (evidence snapshot files, witness lines, output, work). */
const rawOf = (a: Arc): readonly AbsPath[] => [
  join(a.runDir, 'evidence', 'u1', '1-lanes', 'mul', 'output', 'files'),
  join(a.runDir, 'evidence', 'jobs', 'docs-1', 'suite', 'witness.lines'),
  join(a.runDir, 'evidence', 'mutants', 'F-1', 'journey-7-1', 'witness.lines'),
  join(a.runDir, 'evidence', 'u1', '1-candidate', 'journey', 'arc-journey-8-1', 'witness.lines'),
  join(a.runDir, 'inv', '9-1', 'stdout'),
  join(a.runDir, 'inv', '9-1', 'stderr'),
  join(a.runDir, 'inv', '9-1', 'runner.log'),
  join(a.runDir, 'work'),
].map((p) => absPath(p));

type SealOptions = Readonly<{ complete?: boolean; cite?: readonly AbsPath[] }>;

/**
 * Runs `a` as the executor leaves a finished arc: the plan applied, raw evidence captured, then (unless `complete`
 * is false) `arc-completed` at the integration tip and the terminal snapshot. `cite`: an open non-blocking
 * needs-user item naming those paths as evidence. Returns the completion head.
 */
async function seal(a: Arc, opts: SealOptions = {}): Promise<Sha> {
  mkdirSync(a.runDir, { recursive: true });
  const j = openJournal(a.runDir, a.arc);
  try {
    const applied = recordPlan(j, a.runDir, readInputFiles(a.planPath), [], BASE);
    const lane = tmpDir('gc-lane');
    writeFileSync(join(lane, 'lane.log'), 'raw lane output\n');
    await runOp(j, evidenceSnapshotOp, `evidence:${a.arc}`, {
      source: absPath(lane), globs: [repoPattern('**/*')], dest: absPath(join(a.runDir, 'evidence', 'u1', '1-lanes', 'mul', 'output')),
    });
    const inv = join(a.runDir, 'inv', '9-1');
    mkdirSync(inv, { recursive: true });
    for (const f of ['stdout', 'stderr', 'runner.log']) writeFileSync(join(inv, f), `raw ${f}\n`);
    writeFileSync(join(inv, 'launch.json'), '{"launch":true}\n');
    writeFileSync(join(inv, 'result.json'), '{"result":true}\n');
    // Witness runs of a job lane, a mutant and a unit candidate's journey: the raw lines go, the records stay.
    for (const rel of [['jobs', 'docs-1', 'suite'], ['mutants', 'F-1', 'journey-7-1'], ['u1', '1-candidate', 'journey', 'arc-journey-8-1']]) {
      const dir = join(a.runDir, 'evidence', ...rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'witness.lines'), '{"test":"raw"}\n');
      writeFileSync(join(dir, 'witness.json'), '{"witness":true}\n');
    }
    mkdirSync(join(a.runDir, 'work', 'u1', '1-build'), { recursive: true });
    writeFileSync(join(a.runDir, 'work', 'u1', '1-build', 'decisions.json'), '{"decisions":[]}\n');
    if (opts.cite !== undefined) {
      raiseNeedsUser(j, a.runDir, {
        blocking: false, subject: { type: 'arc' }, reason: 'audit-owed', summary: 'an audit is owed', recommendation: 'run the audit', options: [], evidence: opts.cite,
      }, { type: 'arc' });
    }
    const head = sha(revParse(a.repo, 'main'));
    if (opts.complete === false) return head;
    j.fact({ kind: 'arc-completed', planRev: applied.rev, head, highWater: j.view.highWater(), units: [] });
    await runOp(j, snapshotPublishOp(a.repo), `snapshot:${a.arc}`, snapshotRequestOf({
      view: j.view, runDir: a.runDir, identity: executorIdentity(), message: `roadmap ${a.arc}: terminal snapshot\n`,
    }));
    return head;
  } finally {
    j.close();
  }
}

async function done(outcome: Promise<GcOutcome>): Promise<GcReport> {
  const o = await outcome;
  assert.equal(o.kind, 'done', JSON.stringify(o));
  return (o as Extract<GcOutcome, { kind: 'done' }>).report;
}

const actionOf = (report: GcReport, arc: ArcId) => report.arcs.find((x) => x.arc === arc);

/** Every path under `root`, relative, with each file's bytes: what "nothing deleted" compares. */
function tree(root: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        out.set(`${relative(root, path)}/`, '');
        walk(path);
      } else out.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const runtimeOf = (a: Arc): string => join(gitCommonDir(a.repo), 'roadmap-runtime');

/** Generation files for generations 1..n and host.generation n, as supervisors leave them. */
function generations(dir: AbsPath, n: number): void {
  for (let g = 1; g <= n; g++) {
    writeFileSync(hostPath(dir, `handshake.${g}`), '');
    writeFileSync(hostPath(dir, `supervisor.ready.${g}`), '');
    writeFileSync(hostPath(dir, `executor.${g}.out`), '');
    writeFileSync(hostPath(dir, `executor.${g}.err`), `generation ${g}\n`);
  }
  writeFileSync(hostPath(dir, 'host.generation'), `${n}\n`);
}
const genFiles = (dir: AbsPath, g: number): readonly AbsPath[] =>
  [`executor.${g}.err`, `executor.${g}.out`, `handshake.${g}`, `supervisor.ready.${g}`].map((n) => hostPath(dir, n));

/** The identity of a process that has exited (and been reaped). */
async function deadIdentity(): Promise<ProcIdentity> {
  const child: ChildProcess = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined);
  const { start } = identityOf(child.pid);
  const identity = { pid: child.pid, start };
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  return identity;
}

const gcCli = (host: AbsPath, argv: readonly string[], env: NodeJS.ProcessEnv = process.env) =>
  runFixture('exec-cli.ts', [host, 'gc', ...argv], { env, timeoutMs: CLI_TIMEOUT_MS });

// ---------------------------------------------------------------------------------------------------

test('gc.keeps-records: a sealed arc within K loses only its raw evidence; its records, fold and status stay, and a re-run deletes nothing', T, async () => {
  const host = newHost();
  const a = newArc();
  await seal(a);
  const before = status(a.runDir, a.arc, host);
  for (const p of rawOf(a)) assert.ok(existsSync(p), p);

  const report = await done(gc({ hostDir: host, repo: a.repo, keep: DEFAULT_KEEP, dryRun: false }));
  assert.deepEqual(report.arcs, [{ arc: a.arc, action: 'evidence' }]);
  assert.deepEqual([...report.deleted].sort(), [...rawOf(a)].sort());
  for (const p of rawOf(a)) assert.equal(existsSync(p), false, p);
  for (const kept of ['events.jsonl', 'inputs', 'evidence/u1/1-lanes/mul/output/manifest.json', 'evidence/jobs/docs-1/suite/witness.json',
    'evidence/mutants/F-1/journey-7-1/witness.json', 'evidence/u1/1-candidate/journey/arc-journey-8-1/witness.json', 'inv/9-1/launch.json', 'inv/9-1/result.json']) {
    assert.ok(existsSync(join(a.runDir, kept)), `${kept} is a record and stays`);
  }
  const untimed = (s: typeof before) => ({ ...s, host: { ...s.host, log: { ...s.host.log, foldMs: 0 } } });
  assert.deepEqual(untimed(status(a.runDir, a.arc, host)), untimed(before), 'the fold and status are unchanged (but for the fold\'s own timing)');
  assert.equal(sealingOf(a.repo, a.runDir, readJournal(a.runDir, a.arc)).kind, 'sealed');
  assert.equal(readClaim(host), null, 'the claim is released');
  assert.deepEqual((await done(gc({ hostDir: host, repo: a.repo, keep: DEFAULT_KEEP, dryRun: false }))).deleted, [], 'idempotent');
});

test('gc.refuses-live: a live holder of the host refuses gc (exit 75) and nothing is deleted; an executor that died holding it refuses too', T, async () => {
  const host = newHost();
  const a = newArc();
  await seal(a);
  const runtime = tree(runtimeOf(a));
  const held = await claimHost(host, { arc: a.arc, runDir: a.runDir, repo: a.repo, supervisor: selfIdentity() }, async () => assert.fail('no previous arc'));
  assert.equal(held.kind, 'claimed');
  if (held.kind !== 'claimed') return;
  const out = await gcCli(host, ['--repo', a.repo]);
  assert.equal(out.code, 75, out.stderr);
  const refused = JSON.parse(out.stdout) as { refused: { kind: string; arc: string } };
  assert.equal(refused.refused.kind, 'host-busy');
  assert.equal(refused.refused.arc, a.arc);
  assert.equal((await gcCli(host, ['--repo', a.repo, '--dry-run'])).code, 75, 'a dry run is refused the same way');
  assert.deepEqual(tree(runtimeOf(a)), runtime, 'nothing deleted');
  releaseHost(host, held.claim);

  // A dead supervisor whose executor died too: that arc's next start recovers it, not gc.
  const claim = claimRecord({ supervisor: await deadIdentity(), bootId: readBootId(), arc: a.arc, generation: 9 });
  writeFileSync(hostPath(host, HOST_LOCK), canonicalJson(claim));
  publishOwner(host, claim, await deadIdentity());
  assert.deepEqual(await gc({ hostDir: host, repo: a.repo, keep: 1, dryRun: false }), { kind: 'refused', rejection: { kind: 'executor-died', arc: a.arc, generation: 9 } });
  assert.deepEqual(tree(runtimeOf(a)), runtime, 'nothing deleted');
});

test('gc.dry-run: lists exactly what the gc after it deletes (raw evidence, run dirs beyond K, generation files) and deletes nothing', T, async () => {
  const host = newHost();
  generations(host, 4);
  const older = newArc();
  await seal(older);
  const newer = sibling(older, 'b');
  await seal(newer);

  const runtime = tree(runtimeOf(older));
  const hostBefore = tree(host);
  const dry = await done(gc({ hostDir: host, repo: older.repo, keep: 1, dryRun: true }));
  assert.deepEqual(tree(runtimeOf(older)), runtime, 'a dry run deletes nothing');
  assert.deepEqual(tree(host), hostBefore, 'nor touches the host dir (no claim)');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.generation, 5, 'the generation a gc would claim');
  assert.deepEqual(actionOf(dry, older.arc), { arc: older.arc, action: 'run-dir' });
  assert.deepEqual(actionOf(dry, newer.arc), { arc: newer.arc, action: 'evidence' });
  // K = 1: generation 4 and gc's own 5 stay.
  assert.deepEqual(dry.deleted, [...rawOf(newer), older.runDir, ...[1, 2, 3].flatMap((g) => genFiles(host, g)).sort()]);

  const real = await done(gc({ hostDir: host, repo: older.repo, keep: 1, dryRun: false }));
  assert.deepEqual({ ...real, dryRun: true }, dry, 'the real gc deletes what the dry run listed');
  assert.equal(existsSync(older.runDir), false);
  assert.equal(existsSync(`${older.runDir}${GC_DELETING}`), false);
  assert.ok(existsSync(join(newer.runDir, 'events.jsonl')));
  for (const g of [1, 2, 3]) for (const p of genFiles(host, g)) assert.equal(existsSync(p), false, p);
  for (const p of genFiles(host, 4)) assert.ok(existsSync(p), p);
  assert.ok(gitRaw(older.repo, ['rev-parse', '--verify', snapshotRef(older.arc)]).trim().length > 0, 'the ref, which restores the run dir, stays');
});

test('gc.host-files: generation files beyond the last K and residue archives beyond the first K on the chain (and any off it) go', T, async () => {
  const host = newHost();
  generations(host, 6);
  const tokens = { old: 'a'.repeat(16), recent: 'b'.repeat(16) };
  writeFileSync(hostPath(host, `supervisor.${tokens.old}.out`), `${canonicalJson({ generation: 2, kind: 'claimed' })}\n`);
  writeFileSync(hostPath(host, `supervisor.${tokens.old}.err`), '');
  writeFileSync(hostPath(host, `supervisor.${tokens.recent}.out`), `${canonicalJson({ generation: 6, kind: 'claimed' })}\n`);
  writeFileSync(hostPath(host, `supervisor.${tokens.recent}.err`), '');
  const a = newArc();
  await seal(a);
  // Three compactions: a chain index → archive 3 → archive 2 → archive 1.
  const runDirs = (arc: ArcId): AbsPath => runDirOf(gitCommonDir(a.repo), arc);
  const chain: string[] = [];
  for (let round = 0; round < 3; round++) {
    const key = { arc: a.arc, unit: unitId('u1'), inv: invocationId(opId(a.arc, 100 + round), 1), resource: poolInstance(resourceName('estate'), 1) };
    recordResidue(host, { type: 'residue', key, teardown: { argv: ['true'], cwd: absPath('/tmp'), env: {} }, label: `r${round}` });
    recordDisposition(host, { type: 'disposition', key, disposition: 'cleaned', by: { arc: a.arc, inv: invocationId(opId(a.arc, 200 + round), 1) } });
    const c = compactResidues(host, runDirs, 1);
    assert.equal(c.kind, 'compacted');
    if (c.kind === 'compacted') chain.unshift(c.archive);
  }
  const stray = 'residues.archive.1.deadbeef.jsonl';
  writeFileSync(hostPath(host, stray), '');

  const report = await done(gc({ hostDir: host, repo: a.repo, keep: 2, dryRun: false }));
  assert.equal(report.generation, 7);
  // K = 2: generations 5, 6 and gc's own 7 stay; the old supervisor's logs go with generation 2.
  const gone = [...[1, 2, 3, 4].flatMap((g) => genFiles(host, g)), hostPath(host, `supervisor.${tokens.old}.err`), hostPath(host, `supervisor.${tokens.old}.out`)].sort();
  const archivesGone = [hostPath(host, chain[2]!), hostPath(host, stray)].sort();
  assert.deepEqual(report.deleted, [...rawOf(a), ...gone, ...archivesGone]);
  for (const p of [...gone, ...archivesGone]) assert.equal(existsSync(p), false, p);
  for (const g of [5, 6]) for (const p of genFiles(host, g)) assert.ok(existsSync(p), p);
  assert.deepEqual(readdirSync(host).filter((n) => RESIDUE_ARCHIVE.test(n)).sort(), [chain[0]!, chain[1]!].sort());
  for (const name of ['host.generation', 'residues.jsonl', `supervisor.${tokens.recent}.out`, `supervisor.${tokens.recent}.err`]) assert.ok(existsSync(hostPath(host, name)), name);
});

test('gc.sealed-after-head-advanced: a later arc publishing onto the branch leaves the older arc sealed; a head out of history does not', T, async () => {
  const host = newHost();
  const a = newArc();
  const head = await seal(a);
  // A later arc publishes onto main: the completion head is behind the tip, still in its history.
  writeFileSync(join(a.repo, 'LATER.md'), 'a later arc\n');
  git(a.repo, 'add', '-A');
  git(a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'later arc');
  assert.notEqual(revParse(a.repo, 'main'), head);
  const log = readJournal(a.runDir, a.arc);
  assert.equal(log.view.holistic().completion?.active, true, 'the fold alone does not see the branch move');
  assert.equal(sealingOf(a.repo, a.runDir, log).kind, 'sealed');

  // main rewritten so the completion head is no longer in its history: not sealed.
  const orphan = git(a.repo, 'commit-tree', `${head}^{tree}`, '-m', 'rewritten');
  git(a.repo, 'update-ref', 'refs/heads/main', orphan);
  const refused = await done(gc({ hostDir: host, repo: a.repo, keep: 1, dryRun: false }));
  const kept = actionOf(refused, a.arc);
  assert.equal(kept?.action, 'kept');
  assert.match(kept?.action === 'kept' ? kept.reason : '', /is not in refs\/heads\/main's history/);
  assert.deepEqual(refused.deleted, []);

  git(a.repo, 'update-ref', 'refs/heads/main', `${head}`);
  git(a.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'later arc again');
  const pruned = await done(gc({ hostDir: host, repo: a.repo, keep: 1, dryRun: false }));
  assert.deepEqual(actionOf(pruned, a.arc), { arc: a.arc, action: 'evidence' });
  assert.deepEqual(pruned.deleted, rawOf(a));
});

test('gc.refuses-later-work: later work in an arc\'s own log or queue (a mutation, a reopening apply, a pending command) or no completion keeps it whole', T, async () => {
  const host = newHost();
  const base = newArc();
  const [mutation, reopened, pending, incomplete] = ['m', 'r', 'p', 'i'].map((n) => sibling(base, n));
  for (const a of [mutation!, reopened!, pending!]) await seal(a);
  await seal(incomplete!, { complete: false });

  const j1 = openJournal(mutation!.runDir, mutation!.arc);
  j1.fact({ kind: 'admissions-closed', command: commandId('cmd-0123456789abcdef') });
  j1.close();
  const j2 = openJournal(reopened!.runDir, reopened!.arc);
  recordPlan(j2, reopened!.runDir, readInputFiles(reopened!.planPath), [], BASE);
  j2.close();
  submitCommand(pending!.runDir, pending!.arc, { type: 'stop' });

  const runtime = tree(runtimeOf(base));
  const report = await done(gc({ hostDir: host, repo: base.repo, keep: 1, dryRun: false }));
  const reason = (a: Arc): string => {
    const x = actionOf(report, a.arc);
    assert.equal(x?.action, 'kept', `${a.arc}: ${JSON.stringify(x)}`);
    return x?.action === 'kept' ? x.reason : '';
  };
  assert.match(reason(mutation!), /^work at seq \d+ follows the completion at seq \d+$/);
  assert.match(reason(reopened!), /^work at seq \d+ follows the completion at seq \d+$/);
  assert.match(reason(pending!), /^pending commands cmd-/);
  assert.equal(reason(incomplete!), 'not completed');
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(tree(runtimeOf(base)), runtime, 'nothing of theirs is deleted');
});

test('gc.verifies-before-delete: a snapshot ref that does not verify refuses the whole gc, and nothing anywhere is deleted', T, async () => {
  const host = newHost();
  generations(host, 5);
  const good = newArc();
  await seal(good);
  const bad = sibling(good, 't');
  await seal(bad);
  // Tamper with one file of bad's snapshot and move its ref there.
  const ref = snapshotRef(bad.arc);
  const at = gitRaw(bad.repo, ['rev-parse', ref]).trim();
  const target = lsTree(bad.repo, at).find((e) => e.path.startsWith('inputs/'))!;
  const forged = gitRaw(bad.repo, ['hash-object', '-w', '--stdin'], { input: 'forged\n' }).trim();
  const entries = lsTree(bad.repo, at).map((e) => `${e.mode} ${e.type} ${e.path === target.path ? forged : e.object}\t${e.path}`);
  const index = absPath(join(tmpDir('gc-tamper'), 'index'));
  gitRaw(bad.repo, ['update-index', '--add', '--index-info'], { indexFile: index, input: `${entries.join('\n')}\n` });
  const treeSha = gitRaw(bad.repo, ['write-tree'], { indexFile: index }).trim();
  git(bad.repo, 'update-ref', ref, gitRaw(bad.repo, ['commit-tree', treeSha, '-m', 'tampered'], { identity: executorIdentity() }).trim());

  const runtime = tree(runtimeOf(good));
  const hostBefore = tree(host);
  const outcome = await gc({ hostDir: host, repo: good.repo, keep: 1, dryRun: false });
  assert.equal(outcome.kind, 'refused');
  const rejection = outcome.kind === 'refused' ? outcome.rejection : null;
  assert.equal(rejection?.kind, 'snapshot-mismatch');
  if (rejection?.kind === 'snapshot-mismatch') {
    assert.deepEqual(rejection.arcs.map((x) => x.arc), [bad.arc]);
    assert.match(rejection.arcs[0]!.detail, new RegExp(`${target.path.replace(/[.]/g, '\\.')} hashes to`));
  }
  assert.deepEqual(tree(runtimeOf(good)), runtime, 'no run dir and no raw evidence is deleted');
  const hostAfter = tree(host);
  for (const [name, bytes] of hostBefore) if (/^(handshake|executor|supervisor)\./.test(name)) assert.equal(hostAfter.get(name), bytes, `${name} stays`);
  assert.equal(readClaim(host), null, 'the claim is released');
  const cli = await gcCli(host, ['--repo', good.repo]);
  assert.equal(cli.code, 78, cli.stderr);
  assert.equal((JSON.parse(cli.stdout) as { refused: { kind: string } }).refused.kind, 'snapshot-mismatch');
});

test('gc.generation-cited-kept: a generation an open needs-user item cites stays beyond K; an acknowledged citation protects nothing', T, async () => {
  const host = newHost();
  generations(host, 6);
  const token = 'c'.repeat(16);
  writeFileSync(hostPath(host, `supervisor.${token}.out`), `${canonicalJson({ generation: 3, kind: 'claimed' })}\n`);
  writeFileSync(hostPath(host, `supervisor.${token}.err`), '');
  // A blocked arc: the supervisor's crash-limit item (file-only) cites generation 2's executor log.
  const blocked = newArc();
  await seal(blocked, { complete: false });
  writeFileNeedsUser(blocked.runDir, blocked.arc, supervisorNeedsUserId(2, 3), {
    blocking: true, subject: { type: 'host' }, reason: 'supervisor-crash-limit', summary: 'three crashes', recommendation: 'read the logs', options: [], evidence: [hostPath(host, 'executor.2.err')],
  });
  // A sealed arc: an open item cites a supervisor log that claimed generation 3.
  const sealed = sibling(blocked, 's');
  await seal(sealed, { cite: [hostPath(host, `supervisor.${token}.err`)] });
  // An acknowledged item citing generation 1 protects nothing.
  const acked = sibling(blocked, 'a');
  await seal(acked, { complete: false, cite: [hostPath(host, 'executor.1.err')] });
  const j = openJournal(acked.runDir, acked.arc);
  const item = j.view.needsUser()[0]!.id as NeedsUserId;
  writeFileSync(join(acked.runDir, 'needs-user', `${item}.ack.json`), '{"ack":true}\n');
  j.fact({ kind: 'needs-user-acked', id: item, command: commandId('cmd-0123456789abcdef'), choice: null });
  j.close();

  const report = await done(gc({ hostDir: host, repo: blocked.repo, keep: 1, dryRun: false }));
  // K = 1: 6 and gc's own 7 stay; of 1..5, the cited 2 and 3 stay too.
  for (const g of [1, 4, 5]) for (const p of genFiles(host, g)) assert.equal(existsSync(p), false, p);
  for (const g of [2, 3, 6]) for (const p of genFiles(host, g)) assert.ok(existsSync(p), p);
  assert.ok(existsSync(hostPath(host, `supervisor.${token}.out`)) && existsSync(hostPath(host, `supervisor.${token}.err`)), 'the cited supervisor log stays');
  assert.deepEqual(report.deleted.filter((p) => dirname(p) === host), [1, 4, 5].flatMap((g) => genFiles(host, g)).sort());
});

for (const cell of crashCells(GC)) {
  test(`gc.crash-resumable ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
    const host = newHost();
    const older = newArc();
    await seal(older);
    const newer = sibling(older, 'n');
    await seal(newer);
    const trigger = writeTrigger(tmpDir('gc-trigger'), { label: cell.label, occurrence: 1 });
    const crashed = await gcCli(host, ['--repo', older.repo, '--keep', '1'], { ...process.env, ROADMAP_TEST_CRASH: trigger });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    assertFired(trigger);
    const leftover = absPath(`${older.runDir}${GC_DELETING}`);
    assert.ok(existsSync(leftover), 'the run dir was renamed before the crash');
    assert.equal(existsSync(older.runDir), false);
    assert.ok(readClaim(host) !== null, 'the dead gc left its claim');
    for (const p of rawOf(newer)) assert.equal(existsSync(p), false, `${p}: raw evidence went first`);

    const report = await done(gc({ hostDir: host, repo: older.repo, keep: 1, dryRun: false }));
    assert.deepEqual(report.arcs, [{ arc: newer.arc, action: 'evidence' }]);
    assert.deepEqual(report.deleted, [leftover]);
    assert.equal(existsSync(leftover), false);
    assert.equal(readClaim(host), null);
    assert.equal(sealingOf(newer.repo, newer.runDir, readJournal(newer.runDir, newer.arc)).kind, 'sealed');
  });
}
