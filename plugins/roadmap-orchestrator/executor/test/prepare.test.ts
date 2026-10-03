// The re-entry stage `prepare` (src/pipeline/prepare.ts), integrated over real git: prepare.clean-plan-check,
// prepare.clean-build, prepare.clean-verify, prepare.conflicted, prepare.evidence, and a crash at every op
// boundary of the stage (the crash-matrix boundaries B2-B5; B1 is the journal.append row's), each restarted
// through `recover()` and the stage again, as the executor does.
//
// The arc: unit u1 is dispatched (its plan-check raised the floor to high), branched with a change to
// src/add.js and held; a plan revision adds u2, which re-enters u1. The integration tip then advances with a
// conflicting change to src/add.js (conflict), an unrelated file (clean), or not at all (up to date).
//
// This file is also its own crash child: with PREPARE_CHILD set to an ArcDescriptor it opens the arc, runs
// recovery when PREPARE_RECOVER is set, then the stage unless the unit has already decided, and prints the
// outcome.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { type UnitId, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { capturedEvidence } from '../src/git/evidence.ts';
import { mergeHead } from '../src/git/mergein.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { dispatchOf, pinDispatch, raiseRisk, runOp, unitBranch } from '../src/pipeline/dispatch.ts';
import { type PrepareDone, prepare } from '../src/pipeline/prepare.ts';
import { at, loadUnitSpec, record, start } from '../src/pipeline/stages.ts';
import { recover } from '../src/recover/recover.ts';
import { worktreeRemoveOp } from '../src/recover/ops.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runUntilExit } from './helpers/proc.ts';
import { commitAll, git, revParse, tmpDir, writeFiles } from './helpers/repo.ts';
import { events } from './fixtures/invoke-specs.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { type ArcDescriptor, type ArcRun, U1, contextFor, outcomes, setupArc, unitWorktreePath } from './fixtures/unit-common.ts';

const U2: UnitId = unitId('u2');
const CHILD_TIMEOUT_MS = 90_000;
const T = { timeout: 600_000 };

const ADD_U1 = 'export function add(a, b) {\n  return a + b; // unit u1\n}\n';
const ADD_MAIN = 'export function add(a, b) {\n  return b + a; // integration\n}\n';

type Tip = 'conflict' | 'clean' | 'up-to-date';
type Setup = Readonly<{ tip: Tip; enterAt?: 'plan-check' | 'build' | 'verify'; scope?: readonly string[] }>;
type Arc = Readonly<{ d: ArcDescriptor; oldTip: string; tip: string }>;

/** u1 dispatched (floor raised to high), branched and held; u2 re-enters it in plan rev 2; the tip advanced per `tip`. */
function reenteredArc(s: Setup): Arc {
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  const u1 = r.unit('u1');
  const { spec, sha256 } = loadUnitSpec(r.ctx, u1);
  const pinned = pinDispatch(r.ctx, u1, { rev: spec.rev, sha256 });
  assert.equal(pinned.kind, 'pinned');
  if (pinned.kind === 'pinned') raiseRisk(r.ctx, pinned.dispatch, 'high', { rev: spec.rev, sha256 });
  record(r.ctx, at(start(r.ctx, U1, 'plan-check'), 'plan-check'), 'interrupted');
  assert.equal(r.journal.view.unit(U1).status, 'held');

  const oldBranch = unitBranch(r.ctx.plan().arc, U1).replace(/^refs\/heads\//, '');
  git(d.repo, 'checkout', '--quiet', '-b', oldBranch);
  writeFiles(d.repo, { 'src/add.js': ADD_U1 });
  const oldTip = commitAll(d.repo, 'u1 work');
  git(d.repo, 'checkout', '--quiet', 'main');
  if (s.tip === 'conflict') writeFiles(d.repo, { 'src/add.js': ADD_MAIN });
  if (s.tip === 'clean') writeFiles(d.repo, { 'NOTES.md': 'integration moved on\n' });
  if (s.tip === 'up-to-date') git(d.repo, 'merge', '--quiet', '--ff-only', oldBranch);
  else commitAll(d.repo, 'integration moves on');

  const planDir = join(d.planPath, '..');
  const u1Spec = JSON.parse(readFileSync(join(planDir, 'u1.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(planDir, 'u2.json'), JSON.stringify({ ...u1Spec, unit: 'u2' }));
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
  const [first] = plan.units;
  plan.units.push({
    ...first, id: 'u2', spec: 'u2.json', risk: 'med', ...(s.scope === undefined ? {} : { scope: s.scope }),
    reenters: { unit: 'u1', ...(s.enterAt === undefined ? {} : { enterAt: s.enterAt }) },
  });
  writeFileSync(d.planPath, JSON.stringify(plan));
  recordPlan(r.journal, absPath(d.runDir), readInputFiles(absPath(d.planPath), absPath(d.repo)), [
    { type: 'unit-added', unit: U2 }, { type: 'unit-reentered', unit: U2, reenters: U1, reset: false },
  ], { profile: 'default', config: null });
  assert.equal(r.journal.view.unit(U1).status, 'superseded');
  r.journal.close();
  return { d, oldTip, tip: revParse(d.repo, 'main') };
}

/** The arc's run over its revised plan, u2 prepared in process. */
async function prepared(s: Setup): Promise<Readonly<{ arc: Arc; r: ArcRun; done: PrepareDone }>> {
  const arc = reenteredArc(s);
  const r = contextFor(arc.d);
  return { arc, r, done: await prepare(r.ctx, r.unit('u2')) };
}

const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const u2Branch = (r: ArcRun): string => unitBranch(r.ctx.plan().arc, U2);

/** What every clean preparation leaves: the pin, the lineage prepared, the branch at the merge of the old tip and T. */
function assertCleanMerge(arc: Arc, r: ArcRun, done: PrepareDone): void {
  assert.deepEqual(parentsOf(arc.d.repo, done.head), [arc.oldTip, arc.tip], 'the branch is the merge of the re-entered tip and T');
  assert.equal(revParse(arc.d.repo, u2Branch(r)), done.head);
  assert.equal(done.worktree, unitWorktreePath(r, U2));
  assert.equal(mergeHead(done.worktree), null);
  assert.equal(git(done.worktree, 'status', '--porcelain'), '', 'the prepared worktree is clean');
  assert.equal(revParse(arc.d.repo, unitBranch(r.ctx.plan().arc, U1)), arc.oldTip, 'the re-entered unit\'s branch is untouched');
  const pin = dispatchOf(r.journal.view, U2);
  assert.equal(pin.riskFloor, 'high', 'the lineage\'s raised floor is inherited over the plan\'s med');
  assert.equal(r.journal.view.unit(U2).lineage?.prepared, true);
}

const outcomeTests = (): unknown => describe('prepare: outcomes', { concurrency: true }, () => {
  test('prepare.clean-plan-check: a clean merge-in with no enterAt enters at plan-check', T, async () => {
    const { arc, r, done } = await prepared({ tip: 'clean' });
    try {
      assert.equal(done.outcome.kind, 'clean-plan-check');
      assert.equal(done.next.kind === 'stage' ? done.next.stage : done.next.kind, 'plan-check');
      assertCleanMerge(arc, r, done);
      assert.deepEqual(outcomes(arc.d, 'u2'), ['prepare:clean-plan-check']);
      const pins = r.journal.view.dispatchesOf(U2);
      assert.equal(pins.length, 1);
      assert.deepEqual(pins[0]!.scope, [...r.unit('u2').scope].sort());
    } finally {
      r.journal.close();
    }
  });

  test('prepare.clean-build: enterAt build enters at a fresh build round', T, async () => {
    const { arc, r, done } = await prepared({ tip: 'clean', enterAt: 'build' });
    try {
      assert.equal(done.outcome.kind, 'clean-build');
      assert.ok(done.next.kind === 'stage' && done.next.stage === 'build' && done.next.round === 'fresh', JSON.stringify(done.next));
      assertCleanMerge(arc, r, done);
    } finally {
      r.journal.close();
    }
  });

  test('prepare.clean-verify: enterAt verify enters at lanes, on the prepared head', T, async () => {
    const { arc, r, done } = await prepared({ tip: 'clean', enterAt: 'verify' });
    try {
      assert.equal(done.outcome.kind, 'clean-verify');
      assert.equal(done.next.kind === 'stage' ? done.next.stage : done.next.kind, 'lanes');
      assertCleanMerge(arc, r, done);
    } finally {
      r.journal.close();
    }
  });

  test('prepare.conflicted: a conflicting merge-in keeps MERGE_HEAD and enters at a resolve round, whatever enterAt says', T, async () => {
    const { arc, r, done } = await prepared({ tip: 'conflict', enterAt: 'verify' });
    try {
      assert.equal(done.outcome.kind, 'conflicted');
      assert.ok(done.next.kind === 'stage' && done.next.stage === 'build' && done.next.round === 'resolve', JSON.stringify(done.next));
      assert.equal(mergeHead(done.worktree), arc.tip, 'MERGE_HEAD = T (A6)');
      assert.equal(done.head, arc.oldTip, 'HEAD stays at the re-entered tip');
      assert.match(readFileSync(join(done.worktree, 'src/add.js'), 'utf8'), /^<<<<<<< /m);
      assert.deepEqual(outcomes(arc.d, 'u2'), ['prepare:conflicted']);
      const merges = r.journal.view.opsOf('mergein.prepare');
      assert.equal(merges.length, 1);
      assert.equal(merges[0]!.post.type, 'conflicted');
      assert.equal(r.journal.view.unit(U2).lineage?.prepared, true);
    } finally {
      r.journal.close();
    }
  });

  test('prepare.evidence: the snapshot of the prepared worktree exists and retire can cite it to remove the worktree', T, async () => {
    const { r, done } = await prepared({ tip: 'conflict' });
    try {
      const intent = r.journal.view.opsOf('evidence.snapshot').find((i) => i.op === done.evidence);
      assert.ok(intent !== undefined && intent.parent.type === 'stage' && intent.parent.stage === 'prepare' && intent.parent.unit === U2);
      const captured = capturedEvidence(r.journal.view, done.evidence);
      assert.ok(existsSync(intent.expect.dest), 'the snapshot is on disk');
      assert.ok(readFileSync(join(intent.expect.dest, 'files', 'src/add.js'), 'utf8').includes('<<<<<<<'), 'it holds the conflicted file');
      await runOp(r.journal, worktreeRemoveOp(r.ctx.repo), `worktree:${U2}:unit`, { type: 'stage', unit: U2, stage: 'prepare', attempt: done.attempt }, {
        path: done.worktree, evidence: captured,
      });
      assert.equal(existsSync(done.worktree), false);
    } finally {
      r.journal.close();
    }
  });

  test('prepare.up-to-date: a branch that already holds T is not merged into again', T, async () => {
    const { arc, r, done } = await prepared({ tip: 'up-to-date' });
    try {
      assert.equal(done.outcome.kind, 'clean-plan-check');
      assert.equal(done.head, arc.oldTip);
      assert.equal(r.journal.view.opsOf('mergein.prepare').length, 0);
      assert.equal(capturedEvidence(r.journal.view, done.evidence).manifest.files.length, 0, 'a clean preparation snapshots zero files');
    } finally {
      r.journal.close();
    }
  });

  test('prepare.envelope: a scope outside the lineage\'s original envelope fails loud before the pin', T, async () => {
    const arc = reenteredArc({ tip: 'clean', scope: ['src/**', 'lib/**'] });
    const r = contextFor(arc.d);
    try {
      await assert.rejects(prepare(r.ctx, r.unit('u2')), /scope lib\/\*\* lies outside its lineage's envelope/);
      assert.equal(r.journal.view.dispatchOf(U2), null);
    } finally {
      r.journal.close();
    }
  });

  test('prepare.envelope-narrower: a scope narrower than the envelope is pinned', T, async () => {
    const { r, done } = await prepared({ tip: 'clean', scope: ['src/lib/**', 'test/*.js'] });
    try {
      assert.equal(done.outcome.kind, 'clean-plan-check');
      assert.deepEqual(dispatchOf(r.journal.view, U2).scope, ['src/lib/**', 'test/*.js']);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash at every op boundary

const SELF = fileURLToPath(import.meta.url);

/**
 * Appends of one uncrashed preparation, in order: worktree.create intent and done, the dispatch fact,
 * mergein.prepare intent and done, evidence.snapshot intent and done, the stage-outcome fact.
 */
const APPENDS = [
  'intent worktree.create', 'done worktree.create', 'fact dispatch', 'intent mergein.prepare', 'done mergein.prepare',
  'intent evidence.snapshot', 'done evidence.snapshot', 'fact stage-outcome',
] as const;

/** The log's last event, as `APPENDS` names it: where a crash after an append's fsync left the log. */
function lastAppend(d: ArcDescriptor): string {
  const e = events(d.runDir).at(-1);
  if (e === undefined) throw new Error('an empty log');
  return e.type === 'fact' ? `fact ${e.fact.kind}` : `${e.type} ${'kind' in e ? e.kind : '?'}`;
}

type Crash = Readonly<{ label: string; occurrence: number }>;
const appends = (): readonly Crash[] => APPENDS.map((_, i) => ({ label: 'log.append.after-fsync', occurrence: i + 1 }));
const once = (...labels: string[]): readonly Crash[] => labels.map((label) => ({ label, occurrence: 1 }));

/** B2 (intent durable, act start), B3 (inside act), B4 (act end), B5 (done durable) of every op, and after the facts. */
const CRASHES: Readonly<Record<'conflict' | 'clean', readonly Crash[]>> = {
  conflict: [
    ...appends(),
    ...once('worktree.create.act-start', 'worktree.add.inside', 'mergein.act-start', 'mergein.after-merge', 'mergein.act-end'),
    ...once('evidence.act-start', 'evidence.after-partial-copy', 'evidence.act-end'),
  ],
  clean: [
    { label: 'log.append.after-fsync', occurrence: 4 }, { label: 'log.append.after-fsync', occurrence: 5 },
    ...once('mergein.act-start', 'mergein.after-commit-tree', 'mergein.after-cas', 'mergein.act-end', 'evidence.act-start', 'evidence.act-end'),
  ],
};

async function child(d: ArcDescriptor, env: NodeJS.ProcessEnv) {
  return runUntilExit(process.execPath, [SELF], { env: { ...env, PREPARE_CHILD: JSON.stringify(d) }, timeoutMs: CHILD_TIMEOUT_MS });
}

/** The state one uncrashed preparation leaves, checked after crash, recovery and the stage again: no effect twice. */
function assertRecovered(arc: Arc, tip: 'conflict' | 'clean'): void {
  const r = contextFor(arc.d);
  try {
    const view = r.journal.view;
    assert.deepEqual(outcomes(arc.d, 'u2'), [tip === 'conflict' ? 'prepare:conflicted' : 'prepare:clean-plan-check'], 'one outcome');
    assert.deepEqual(view.openIntents(), [], 'nothing left open');
    const ofU2 = <K extends 'worktree.create' | 'mergein.prepare' | 'evidence.snapshot'>(kind: K) =>
      view.opsOf(kind).filter((i) => i.parent.type === 'stage' && i.parent.unit === U2 && view.doneOf(i.op) !== null);
    assert.equal(ofU2('worktree.create').length, 1, 'one worktree');
    assert.equal(ofU2('mergein.prepare').length, 1, 'one merge-in');
    assert.equal(ofU2('evidence.snapshot').length, 1, 'one snapshot');
    assert.equal(view.dispatchesOf(U2).length, 1, 'one pin');
    assert.equal(view.unit(U2).lineage?.prepared, true);
    const worktree = unitWorktreePath(r, U2);
    capturedEvidence(view, ofU2('evidence.snapshot')[0]!.op);
    if (tip === 'conflict') {
      assert.equal(mergeHead(worktree), arc.tip);
      assert.equal(revParse(worktree, 'HEAD'), arc.oldTip);
    } else {
      assert.deepEqual(parentsOf(arc.d.repo, revParse(worktree, 'HEAD')), [arc.oldTip, arc.tip]);
      assert.equal(git(worktree, 'status', '--porcelain'), '');
    }
  } finally {
    r.journal.close();
  }
}

if (process.env['PREPARE_CHILD'] !== undefined) {
  const r = contextFor(JSON.parse(process.env['PREPARE_CHILD']) as ArcDescriptor);
  if (process.env['PREPARE_RECOVER'] !== undefined) await recover(recoveryContext(r));
  // As the unit driver: a unit whose preparation already decided is not prepared again.
  const decided = r.journal.view.unit(U2).decided;
  const kind = decided === null ? (await prepare(r.ctx, r.unit('u2'))).outcome.kind : decided.outcome;
  process.stdout.write(`${JSON.stringify({ kind })}\n`);
  r.journal.close();
} else {
  outcomeTests();
  describe('prepare: crash at every op boundary, then recovery and the stage again', { concurrency: 4 }, () => {
    for (const tip of ['conflict', 'clean'] as const) {
      for (const c of CRASHES[tip]) {
        test(`prepare.crash ${tip} ${c.label}#${c.occurrence}`, T, async () => {
          const arc = reenteredArc({ tip });
          const trigger = writeTrigger(tmpDir('prepare-crash'), c);
          const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
          const first = await child(arc.d, env);
          assert.equal(first.signal, 'SIGKILL', `died at its crash point: ${first.stdout}${first.stderr}`);
          assertFired(trigger);
          if (c.label === 'log.append.after-fsync') assert.equal(lastAppend(arc.d), APPENDS[c.occurrence - 1], 'crashed right after that append');
          const second = await child(arc.d, { ...env, PREPARE_RECOVER: '1' });
          assert.equal(second.code, 0, second.stderr);
          assert.deepEqual(JSON.parse(second.stdout), { kind: tip === 'conflict' ? 'conflicted' : 'clean-plan-check' });
          assertRecovered(arc, tip);
        });
      }
    }
  });
}

