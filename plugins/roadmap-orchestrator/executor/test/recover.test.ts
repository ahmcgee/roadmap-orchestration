// The recovery engine (src/recover/recover.ts) over real arcs: open intents of every kind left as a dead
// executor leaves them, closed in the fixed order and to a fixed point; a park raises one needs-user; a
// recovery that itself crashes (at every op boundary, and between an effect and its done) is finished by the
// next to the same fixed point with no effect twice; a backend call adopted or settled by recovery is
// consumed by the driver, never dispatched again; and the adversarial cells of a live runner through a crash
// in recovery and through a cross-arc takeover that dies mid-adoption.
// Named tests: recover.fixed-point, recover.park-raises-needs-user, recover.fixed-point-after-crash-in-recovery,
// recover.no-duplicate-needs-user, recover.adopted-build-consumed, recover.adopted-judgment-consumed, and the
// matrix rows "crash during recovery" and the two adversarial rows (test/matrix.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive } from '../src/contain/proc.ts';
import type { IntentRecord } from '../src/core/events.ts';
import { invocationId, opKey, sha, sha256, specRev } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { needsUserRecord } from '../src/core/records.ts';
import { absPath, isoTimeOf, repoPattern } from '../src/core/values.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { type RecoveryReport, recover } from '../src/recover/recover.ts';
import { worktreeCreateOp } from '../src/recover/ops.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { specPatchOp } from '../src/spec/patch.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { SPEC_INPUT, inputPath } from '../src/input/inforce.ts';
import { reached, release } from './helpers/barrier.ts';
import { writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { type Owner, assertNoSurvivors } from './helpers/reap.ts';
import { ADVERSARIAL_LIVE_RUNNER, ADVERSARIAL_TAKEOVER, RECOVERY_CRASH, RECOVERY_EFFECT_LABELS, crashCells, killCells } from './matrix.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, cli, journalOf, reasonOf, setupExec, startExec, until } from './fixtures/exec-common.ts';
import {
  BARRIER, type CallStage, REC_KINDS, type RecKind, assertNoDuplicateEffect, callsOf, crashRecovery, deadRun, driveUnit, fixedPoint, highWater,
  killBackground, openNow, recoverInBackground, recoveredBy, recoveryContext, strandedCall,
} from './fixtures/rec-common.ts';
import { CLAUDE_ONLY, UNIT_CLAUDE_ONLY, WAIT_MS, blockedCheck, executorOf, kill, smokes, startCli, startLine, supervisorOf } from './fixtures/sup-common.ts';
import { type ArcDescriptor, U1, contextFor, isGateCall, outcomes, setupArc } from './fixtures/unit-common.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

const T = { timeout: 120_000 };
const LONG = { timeout: 600_000 };
const STAGE = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

/** The recovery engine in this process over `d`'s journal. */
async function recoverHere(d: ArcDescriptor): Promise<RecoveryReport> {
  const r = contextFor(d);
  try {
    return await recover(recoveryContext(r));
  } finally {
    r.journal.close();
  }
}

/** Recovery to its fixed point: a first run, then a second that must find nothing but the same parks. */
async function recoverToFixedPoint(d: ArcDescriptor): Promise<RecoveryReport> {
  const first = await recoverHere(d);
  const mark = highWater(d);
  const again = await recoverHere(d);
  assert.deepEqual(again.parked, first.parked, 'the same ops stay parked');
  assert.ok(again.recovered.every((r) => r.disposition === 'park'), `a recovery at its fixed point only re-parks: ${JSON.stringify(again.recovered)}`);
  assert.equal(highWater(d), mark, 'a recovery at its fixed point appends nothing');
  return first;
}

// ---------------------------------------------------------------------------------------------------
// The first pass, in order

/** A redirect-shaped patch of u1's spec, prepared (so its intent records every input) but not acted. */
async function openSpecPatch(r: ReturnType<typeof contextFor>) {
  const path = absPath(join(r.ctx.planDir, 'u1.json'));
  const body = await specPatchOp(r.ctx.runDir).prepare({
    path, oldSha256: fileSha256(path),
    patch: { expectRev: specRev(1), by: { role: 'executor', inv: `${r.ctx.plan().arc}/1#1` as never }, ops: [{ op: 'add', section: 'facts', item: { id: 'F1' as never, text: 'mul is pure.' } }] },
  });
  const { op } = r.journal.begin({ kind: 'spec.patch', key: opKey('spec:u1'), parent: STAGE, deadlineAt: null, body: () => body });
  return { op, path };
}

/**
 * A dead executor's log with four open intents across the phases: a needs-user raise killed before its
 * publish, a spawn whose runner never started, a worktree never created, a spec patch whose write landed.
 */
async function mixedDeadRun(): Promise<ArcDescriptor> {
  const d = setupArc({ steps: [] });
  const trigger = writeTrigger(tmpDir('recover-crash'), { label: 'needsuser.raise.before-publish', occurrence: 1 });
  const child = await runFixture('needsuser-child.ts', [d.runDir, d.arc], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 20_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const r = contextFor(d);
  try {
    r.journal.begin({
      kind: 'proc.spawn', key: opKey('lane:u1:unit'), parent: STAGE, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
      body: () => ({ expect: { subject: { purpose: 'lane', unit: U1, lane: 'mul' as never, set: 'spec', at: sha(git(d.repo, 'rev-parse', 'main')) }, launchSha256: sha256('0'.repeat(64)) }, post: null }),
    });
    const path = absPath(join(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, 'u1.verify-1'));
    const wtOp = worktreeCreateOp(r.ctx.repo);
    const wtBody = await wtOp.prepare({ path, checkout: { type: 'detached', at: sha(git(d.repo, 'rev-parse', 'main')) } });
    r.journal.begin({ kind: 'worktree.create', key: opKey('worktree:u1:verify'), parent: STAGE, deadlineAt: null, body: () => wtBody });
    const patch = await openSpecPatch(r);
    await specPatchOp(r.ctx.runDir).act(r.journal.view.latestIntent(patch.op) as never);
  } finally {
    r.journal.close();
  }
  return d;
}

test('recover.fixed-point: open spawn, worktree, spec and needs-user intents are closed in order, and a second recovery finds nothing', T, async () => {
  const d = await mixedDeadRun();
  const open = openNow(d);
  const [raise, spawn, worktree, patch] = open;
  assert.deepEqual(open.map((i) => i.kind), ['needsuser.raise', 'proc.spawn', 'worktree.create', 'spec.patch']);
  const report = await recoverHere(d);
  assert.deepEqual(report.parked, []);
  assert.deepEqual(openNow(d), [], 'every intent closed');
  assert.deepEqual(report.recovered.map((x) => [x.kind, x.op, x.disposition]), [
    ['proc.spawn', spawn!.op, 'lost'],
    ['worktree.create', worktree!.op, 'redo'],
    ['spec.patch', patch!.op, 'done'],
    ['needsuser.raise', raise!.op, 'redo'],
  ], 'processes, then git, then files; the second pass found nothing');
  assert.deepEqual(recoveredBy(d, open), ['redone', 'reconciled', 'redone', 'reconciled']);
  assert.ok(raise!.kind === 'needsuser.raise' && readNeedsUser(absPath(d.runDir), raise!.expect.id) !== null, 'the staged needs-user is published');
  assert.ok(worktree!.kind === 'worktree.create');
  assert.equal(git(worktree!.expect.path, 'rev-parse', 'HEAD'), git(d.repo, 'rev-parse', 'main'), 'the worktree exists at its recorded commit');

  const again = await recoverHere(d);
  assert.deepEqual(again, { recovered: [], parked: [] }, 'recovery at its fixed point changes nothing');
});

test('recover.park-raises-needs-user: a patch whose old spec is gone (not kept, the file changed by someone else) parks; one blocking recovery-required needs-user names the op', T, async () => {
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  let op: string;
  try {
    const opened = await openSpecPatch(r);
    op = opened.op;
    const spec = JSON.parse(readFileSync(opened.path, 'utf8')) as Record<string, unknown>;
    writeFileSync(opened.path, JSON.stringify({ ...spec, scope: [repoPattern('elsewhere/**')] }));
    loseKeptOldSpec(r.journal.view.latestIntent(opened.op as never), d);
  } finally {
    r.journal.close();
  }
  const report = await recoverToFixedPoint(d);
  assert.deepEqual(report.parked, [op]);
  assert.deepEqual(report.recovered.map((x) => x.disposition), ['park', 'park'], 'parked in both passes');
  const { view } = readJournal(absPath(d.runDir), d.arc as never);
  assert.deepEqual(view.openIntents().map((i) => i.op), [op], 'a park leaves the intent open');
  const raises = view.opsOf('needsuser.raise');
  assert.equal(raises.length, 1, 'one needs-user for the op');
  assert.deepEqual(raises[0]!.parent, { type: 'op', op });
  const item = readNeedsUser(absPath(d.runDir), raises[0]!.expect.id);
  assert.ok(item !== null);
  assert.deepEqual([item.reason, item.blocking, item.subject], ['recovery-required', true, { type: 'unit', unit: 'u1' }]);
  assert.match(item.summary, new RegExp(`spec\\.patch ${op}`));

  const again = await recoverHere(d);
  assert.deepEqual(again.parked, [op]);
  const after = readJournal(absPath(d.runDir), d.arc as never).view;
  assert.equal(after.opsOf('needsuser.raise').length, 1, 'a later recovery does not raise it again');
  assert.equal(after.unit(U1).counters.attempts, 1, 'the needs-user is parented by the op, so it starts no stage attempt');
});

test('recover.fixed-point-after-crash-in-recovery: a recovery killed before or after each op it handles is finished by the next, to the fixed point an uncrashed one reaches', LONG, async () => {
  const reference = await mixedDeadRun();
  const refOpen = openNow(reference);
  const refMark = highWater(reference);
  await recoverToFixedPoint(reference);
  const expected = fixedPoint(reference, refOpen, refMark);
  const expectedBy = recoveredBy(reference, refOpen);
  // A pass handles the four intents and the resources phase: five boundaries of each kind.
  for (const label of ['recover.before-op', 'recover.after-op']) {
    for (let occurrence = 1; occurrence <= 5; occurrence++) {
      const d = await mixedDeadRun();
      const open = openNow(d);
      const mark = highWater(d);
      await crashRecovery(d, label, occurrence);
      await recoverToFixedPoint(d);
      assert.deepEqual(fixedPoint(d, open, mark), expected, `${label}#${occurrence}`);
      recoveredBy(d, open).forEach((by, i) => assert.ok(by === expectedBy[i] || by === 'reconciled', `${label}#${occurrence}: ${open[i]!.kind} recoveredBy ${by}`));
      assertNoDuplicateEffect(d, callsOf(d));
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// Matrix row: crash during recovery

type RecoveryCell = Readonly<{ boundary: string; label: string; occurrence: number }>;

function cellsOf(kind: RecKind): readonly RecoveryCell[] {
  const effect = (RECOVERY_EFFECT_LABELS as Readonly<Partial<Record<RecKind, string>>>)[kind];
  return crashCells(RECOVERY_CRASH).flatMap((c): RecoveryCell[] => {
    if (c.label === 'recover.before-op' || c.label === 'recover.after-op') return [1, 2].map((occurrence) => ({ ...c, occurrence }));
    return c.label === effect ? [{ ...c, occurrence: 1 }] : [];
  });
}

describe(`matrix row ${RECOVERY_CRASH}`, { concurrency: 3 }, () => {
  test('its effect labels name one crash point per op kind but proc.kill', () => {
    assert.deepEqual(Object.keys(RECOVERY_EFFECT_LABELS).sort(), REC_KINDS.filter((k) => k !== 'proc.kill').sort());
  });

  for (const kind of REC_KINDS) {
    test(`${kind}: every crash of its recovery reaches the uncrashed fixed point`, LONG, async (t) => {
      const ref = await deadRun(kind);
      const refOpen = openNow(ref.d);
      assert.ok(refOpen.some((i) => i.kind === kind), `the dead run left a ${kind} open: ${refOpen.map((i) => i.kind).join(', ')}`);
      const refMark = highWater(ref.d);
      const refCalls = callsOf(ref.d);
      await recoverToFixedPoint(ref.d);
      const expected = fixedPoint(ref.d, refOpen, refMark);
      assert.equal(expected.stillOpen, 0, 'the scenario recovers without a park');
      const expectedBy = recoveredBy(ref.d, refOpen);
      assertNoDuplicateEffect(ref.d, refCalls);

      for (const cell of cellsOf(kind)) {
        await t.test(`${cell.boundary} ${cell.label}#${cell.occurrence}`, async () => {
          const { d } = await deadRun(kind);
          const open = openNow(d);
          const mark = highWater(d);
          const calls = callsOf(d);
          await crashRecovery(d, cell.label, cell.occurrence);
          await recoverToFixedPoint(d);
          assert.deepEqual(fixedPoint(d, open, mark), expected);
          recoveredBy(d, open).forEach((by, i) => assert.ok(by === expectedBy[i] || by === 'reconciled', `${open[i]!.kind} recoveredBy ${by}, uncrashed ${expectedBy[i]}`));
          assertNoDuplicateEffect(d, calls);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// One needs-user per cause

/** Removes the run dir's kept copy of the spec a patch applies to: with the file changed too, it is gone. */
function loseKeptOldSpec(i: IntentRecord, d: ArcDescriptor): void {
  if (i.kind !== 'spec.patch') throw new Error('not a spec.patch');
  rmSync(inputPath(absPath(d.runDir), i.expect.oldSha256, SPEC_INPUT));
}

/** A root commit with main's tree: integration "rewritten", neither T, a descendant, nor the publication. */
function rewindIntegration(repo: string): void {
  const root = git(repo, 'commit-tree', `${git(repo, 'rev-parse', 'main')}^{tree}`, '-m', 'someone rewrote main');
  git(repo, 'update-ref', 'refs/heads/main', root);
}

const CAUSES = {
  // A spec patch whose old spec is gone (not kept, the file changed by someone else): park (the op stays open).
  park: { kind: 'spec.patch', disturb: (d: ArcDescriptor, i: IntentRecord) => {
    if (i.kind !== 'spec.patch') throw new Error('not a spec.patch');
    writeFileSync(i.expect.path, JSON.stringify({ ...JSON.parse(readFileSync(i.expect.path, 'utf8')) as object, scope: ['elsewhere/**'] }));
    loseKeptOldSpec(i, d);
  }, closure: 'open' },
  // The executor-owned candidate ref moved by someone else: abort.
  abort: { kind: 'candidate.merge', disturb: (d: ArcDescriptor, i: IntentRecord) => {
    if (i.kind !== 'candidate.merge') throw new Error('not a candidate.merge');
    git(d.repo, 'update-ref', i.expect.ref, git(d.repo, 'rev-parse', 'main'));
  }, closure: 'abort' },
  // Integration rewritten under a pending ff: recovery-required.
  'recovery-required': { kind: 'integration.ff', disturb: (d: ArcDescriptor) => rewindIntegration(d.repo), closure: 'done recovery-required' },
} as const satisfies Record<string, Readonly<{ kind: RecKind; disturb: (d: ArcDescriptor, i: IntentRecord) => void; closure: string }>>;

describe('recover.no-duplicate-needs-user: a recovery killed around the raise of a park, an abort or a recovery-required raises it once', { concurrency: 3 }, () => {
  for (const [cause, c] of Object.entries(CAUSES)) {
    for (const label of [null, 'needsuser.raise.before-publish', 'needsuser.raise.after-publish'] as const) {
      test(`${cause}${label === null ? '' : `, killed at ${label}`}`, LONG, async () => {
        const { d } = await deadRun(c.kind);
        const [target] = openNow(d).filter((i) => i.kind === c.kind);
        assert.ok(target !== undefined);
        c.disturb(d, target);
        if (label !== null) await crashRecovery(d, label, 1);
        await recoverToFixedPoint(d);
        const { view, events } = readJournal(absPath(d.runDir), d.arc as never);
        const raises = view.opsOf('needsuser.raise').filter((i) => i.parent.type === 'op' && i.parent.op === target.op);
        assert.equal(raises.length, 1, 'one raise for the op');
        assert.ok(view.doneOf(raises[0]!.op) !== null, 'the raise is done');
        const files = readdirSync(join(d.runDir, 'needs-user')).filter((n) => /^nu-[0-9]+\.json$/.test(n));
        assert.deepEqual(files, [`${raises[0]!.expect.id}.json`], 'one needs-user file');
        const item = needsUserRecord(JSON.parse(readFileSync(join(d.runDir, 'needs-user', files[0]!), 'utf8')), files[0]!);
        assert.deepEqual([item.reason, item.blocking], ['recovery-required', true]);
        const closures = events.filter((e) => (e.type === 'done' || e.type === 'abort') && e.op === target.op).length;
        assert.equal(closures, c.closure === 'open' ? 0 : 1, 'closed once, or left open by a park');
        assert.equal(fixedPoint(d, [target], 0).closures[0], `${c.kind} ${c.closure}`);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// A completed call is consumed, never dispatched again

/** The stranded call recovered while its runner lives (adopted), then the driver runs the unit to its end. */
async function adoptThenDrive(d: ArcDescriptor): Promise<void> {
  const recovery = await recoverInBackground(d);
  release(d.scenarioDir, BARRIER);
  assert.equal(await recovery.exit, 0, 'the recovery adopted the runner and finished');
  assert.deepEqual(await driveUnit(d), { kind: 'merged' });
}

/** The one backend spawn of `role`, its done and its stage attempt's outcome. */
function soleCall(d: ArcDescriptor, role: 'planCheck' | 'build' | 'gate') {
  const { view, events } = readJournal(absPath(d.runDir), d.arc as never);
  const spawns = view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === role);
  assert.equal(spawns.length, 1, `one ${role} invocation`);
  const spawn = spawns[0]!;
  const parent = spawn.parent;
  assert.ok(parent.type === 'stage');
  const outcomesAt = events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.stage === parent.stage && e.fact.attempt === parent.attempt ? [e.fact.outcome] : []));
  return { spawn, done: view.doneOf(spawn.op), outcomesAt, view, events };
}

test('recover.adopted-build-consumed: a build whose executor died mid-call is adopted by recovery and consumed as the build\'s outcome; it is never re-run and publishes once', T, async () => {
  const d = await strandedCall('build');
  await adoptThenDrive(d);
  const { done, outcomesAt, view, events } = soleCall(d, 'build');
  assert.ok(done?.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.recoveredBy === 'adopted', JSON.stringify(done));
  assert.deepEqual(outcomesAt, ['success'], 'the stranded attempt recorded success from the adopted result');
  assert.deepEqual(outcomes(d), STRAIGHT);
  assert.equal(readCalls(d.scenarioPath).filter((c) => c.as === 'codex').length, 1, 'one build call');
  assert.equal(view.unit(U1).counters.chargeableFailures, 0);
  assert.equal(events.filter((e) => e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published').length, 1, 'published once');
});

describe('recover.adopted-judgment-consumed: a judgment whose executor died mid-call is adopted and consumed, never asked again', { concurrency: 2 }, () => {
  for (const [stage, role] of [['plan-check', 'planCheck'], ['gate', 'gate']] as const) {
    test(stage, T, async () => {
      const d = await strandedCall(stage as CallStage);
      await adoptThenDrive(d);
      const { done, outcomesAt, view } = soleCall(d, role);
      assert.ok(done?.kind === 'proc.spawn' && done.recoveredBy === 'adopted', JSON.stringify(done));
      assert.deepEqual(outcomesAt, ['approve'], 'the stranded attempt recorded the adopted approval');
      assert.deepEqual(outcomes(d), STRAIGHT);
      const calls = readCalls(d.scenarioPath);
      assert.equal(calls.filter((c) => c.as === 'claude' && (stage === 'gate') === isGateCall(c)).length, 1, `one ${stage} call`);
      if (stage === 'gate') {
        const approvals = readJournal(absPath(d.runDir), d.arc as never).events.filter((e) => e.type === 'fact' && e.fact.kind === 'approval');
        assert.equal(approvals.length, 1, 'one approval fact');
        assert.equal(view.unit(U1).approval?.fingerprint.unitCommit, git(d.repo, 'rev-parse', `refs/heads/roadmap/${d.arc}/u1`));
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Adversarial: a live runner through a crash in recovery

/** The stranded build's runner, from its runner.json. */
function runnerOf(d: ArcDescriptor) {
  const spawn = openNow(d).find((i) => i.kind === 'proc.spawn');
  assert.ok(spawn !== undefined, 'the build spawn is open');
  const inv = invocationId(spawn.op, spawn.ordinal);
  const file = runnerFiles(invocationDir(absPath(d.runDir), inv), inv).read('runner.json');
  assert.ok(file !== null);
  return { spawn, runner: file.runner };
}

/** After the cell: the build closed as `allowed`, consumed, run once, the unit merged. */
async function survived(d: ArcDescriptor, allowed: readonly string[]): Promise<void> {
  const { spawn } = soleCall(d, 'build');
  const { done } = soleCall(d, 'build');
  assert.ok(done?.kind === 'proc.spawn' && done.outcome.kind === 'result' && allowed.includes(done.recoveredBy ?? 'live'), `${spawn.op}: ${JSON.stringify(done)}`);
  assert.deepEqual(await driveUnit(d), { kind: 'merged' });
  const after = soleCall(d, 'build');
  assert.deepEqual(after.outcomesAt, ['success']);
  assert.deepEqual(outcomes(d), STRAIGHT);
  assert.equal(readCalls(d.scenarioPath).filter((c) => c.as === 'codex').length, 1, 'the build ran once');
  assertNoDuplicateEffect(d, callsOf(d));
}

describe(`matrix row ${ADVERSARIAL_LIVE_RUNNER}`, { concurrency: 3 }, () => {
  const crashes = crashCells(ADVERSARIAL_LIVE_RUNNER);
  const kills = killCells(ADVERSARIAL_LIVE_RUNNER);
  test('its cells', () => {
    assert.deepEqual(crashes.map((c) => `${c.boundary} ${c.label}`), ['B2 recover.before-op', 'B4 spawn.after-result', 'B5 recover.after-op']);
    assert.deepEqual(kills.map((c) => c.boundary), ['B3']);
  });

  test('B2 recover.before-op: killed before it reached the live runner; the next recovery adopts it once', T, async () => {
    const d = await strandedCall('build');
    await crashRecovery(d, 'recover.before-op', 1);
    assert.ok(isAlive(runnerOf(d).runner), 'the runner lives on');
    await adoptThenDrive(d);
    await survived(d, ['adopted']);
  });

  test('B3 killed while it waits on the adopted runner, which still lives at the next recovery: adopted once', T, async () => {
    const d = await strandedCall('build');
    await killBackground(await recoverInBackground(d));
    assert.ok(isAlive(runnerOf(d).runner), 'the runner survived the second crash');
    await adoptThenDrive(d);
    await survived(d, ['adopted']);
  });

  test('B3 killed while it waits on the adopted runner, which exits before the next recovery: its exit.json is adapted once', T, async () => {
    const d = await strandedCall('build');
    await killBackground(await recoverInBackground(d));
    const { runner } = runnerOf(d);
    release(d.scenarioDir, BARRIER);
    await until(() => !isAlive(runner), WAIT_MS, 'the runner to exit');
    await recoverToFixedPoint(d);
    await survived(d, ['redone']);
  });

  for (const label of ['spawn.after-result', 'recover.after-op']) {
    test(`${label === 'spawn.after-result' ? 'B4' : 'B5'} ${label}: killed after the adopted runner exited; the next recovery closes it once`, T, async () => {
      const d = await strandedCall('build');
      const trigger = writeTrigger(tmpDir('rec-trigger'), { label, occurrence: 1 });
      const recovery = await recoverInBackground(d, trigger);
      release(d.scenarioDir, BARRIER);
      assert.equal(await recovery.exit, null, 'the recovery died at its crash point');
      await recoverToFixedPoint(d);
      await survived(d, label === 'spawn.after-result' ? ['reconciled'] : ['adopted']);
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Adversarial: a cross-arc takeover that dies mid-adoption

/** Arc A parked in a plan-check at barrier `check1`, then its supervisor and executor SIGKILLed: its runner lives. */
async function strandedArc(t: Owner): Promise<Readonly<{ a: ExecRun; spawn: IntentRecord }>> {
  const a = setupExec(t, { steps: [...smokes(1), blockedCheck('check1')] });
  const line = startLine(await startCli(a));
  assert.equal(line.kind, 'ready', JSON.stringify(line));
  await reached(a.scenarioDir, 'check1', WAIT_MS);
  const executor = await executorOf(a, line.generation as number);
  await kill(supervisorOf(a));
  await kill(executor);
  const open = journalOf(a).view.openIntents().filter((i) => i.kind === 'proc.spawn');
  assert.equal(open.length, 1, 'the plan-check spawn is open');
  return { a, spawn: open[0]! };
}

const recoveryLock = (r: ExecRun): string => join(r.hostDir, 'host.recovery.lock');
/** Past the recovery lock's appearance, by when B's supervisor waits on A's live runner. */
const ADOPTION_SETTLE_MS = 1_500;

/** B's next start refuses: the dead supervisor still holds the recovery lock. One host needs-user, however often. */
async function refusedHolderDead(b: ExecRun): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const exit = await startCli(b);
    assert.equal(exit.code, 78, exit.stdout + exit.stderr);
    assert.equal(reasonOf(exit).kind, 'refused');
    const r = reasonOf(exit);
    assert.ok(r.kind === 'refused' && r.rejections[0]?.kind === 'recovery-holder-dead');
  }
  const items = readdirSync(join(b.runDir, 'needs-user')).filter((n) => n.startsWith('host-recovery-holder-dead-') && !n.endsWith('.ack.json'));
  assert.deepEqual(items, ['host-recovery-holder-dead-1.json']);
}

/** The user's decision: clear the dead recovery lock; then B runs, acknowledging its host item, to complete. */
async function clearAndRunB(b: ExecRun, releaseA: (() => void) | null): Promise<void> {
  await cli(b, ['ack', 'host-recovery-holder-dead-1']);
  rmSync(recoveryLock(b));
  const running = startExec(b, CLAUDE_ONLY);
  if (releaseA !== null) {
    await until(() => existsSync(recoveryLock(b)), WAIT_MS, 'B to reconcile A under the recovery lock');
    // As in the B3 and B4 cells: B scans A's survivors just after the lock appears. Released before that, A's
    // runner can exit first, and B finds it re-adaptable (redone) instead of live (adopted).
    await sleep(ADOPTION_SETTLE_MS);
    releaseA();
  }
  const exit = await running.exit;
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
}

describe(`matrix row ${ADVERSARIAL_TAKEOVER}`, { concurrency: 2 }, () => {
  test('its cells', () => {
    assert.deepEqual(crashCells(ADVERSARIAL_TAKEOVER).map((c) => `${c.boundary} ${c.label}`), ['B4 spawn.after-result']);
    assert.deepEqual(killCells(ADVERSARIAL_TAKEOVER).map((c) => c.boundary), ['B3']);
  });

  test('B3 B\'s supervisor killed while it adopts A\'s live runner: B refuses recovery-holder-dead until the user clears it; then A\'s invocation is adopted once and B runs', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
    const { a, spawn } = await strandedArc(t);
    const b = { ...setupExec(t, { steps: [...smokes(1), ...UNIT_CLAUDE_ONLY] }), hostDir: a.hostDir };
    const starting = startCli(b);
    await until(() => existsSync(recoveryLock(b)), WAIT_MS, 'B to reconcile A under the recovery lock');
    await sleep(ADOPTION_SETTLE_MS);
    const holder = (JSON.parse(readFileSync(recoveryLock(b), 'utf8')) as { holder: { pid: number; start: number } }).holder;
    await kill(holder);
    assert.equal((await starting).code, 70, 'B\'s start reports its supervisor gone');
    const logBefore = readFileSync(join(a.runDir, 'events.jsonl'));
    await refusedHolderDead(b);
    assert.deepEqual(readFileSync(join(a.runDir, 'events.jsonl')), logBefore, 'A\'s log untouched');
    const inv = invocationId(spawn.op, spawn.ordinal);
    const { runner } = JSON.parse(readFileSync(join(invocationDir(absPath(a.runDir), inv), 'runner.json'), 'utf8')) as { runner: { pid: number; start: number } };
    assert.ok(isAlive(runner), 'A\'s runner lives on');

    await clearAndRunB(b, () => release(a.scenarioDir, 'check1'));
    const { view, events } = journalOf(a);
    const done = view.doneOf(spawn.op);
    assert.ok(done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.recoveredBy === 'adopted', JSON.stringify(done));
    assert.equal(events.filter((e) => e.type === 'done' && e.op === spawn.op).length, 1, 'one done');
    assert.ok(existsSync(join(invocationDir(absPath(a.runDir), inv), 'result.json')), 'one result');
  });

  test('B4 spawn.after-result: B\'s supervisor dies after A\'s result, before its done; B refuses until cleared; then nothing of A survives and A\'s own recovery closes it once', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
    const { a, spawn } = await strandedArc(t);
    const b = { ...setupExec(t, { steps: [...smokes(1), ...UNIT_CLAUDE_ONLY] }), hostDir: a.hostDir };
    const trigger = writeTrigger(tmpDir('rec-trigger'), { label: 'spawn.after-result', occurrence: 1 });
    const starting = startCli(b, CLAUDE_ONLY, { ROADMAP_TEST_CRASH: trigger });
    await until(() => existsSync(recoveryLock(b)), WAIT_MS, 'B to reconcile A under the recovery lock');
    // Nothing shows the moment B starts waiting on the runner; its scan takes milliseconds after the lock.
    await sleep(ADOPTION_SETTLE_MS);
    release(a.scenarioDir, 'check1');
    assert.equal((await starting).code, 70, 'B\'s supervisor died at its crash point');
    const inv = invocationId(spawn.op, spawn.ordinal);
    assert.ok(existsSync(join(invocationDir(absPath(a.runDir), inv), 'result.json')), 'A\'s result is written');
    assert.equal(journalOf(a).view.doneOf(spawn.op), null, 'its done is not');
    await refusedHolderDead(b);

    const logBefore = readFileSync(join(a.runDir, 'events.jsonl'));
    await clearAndRunB(b, null);
    assert.deepEqual(readFileSync(join(a.runDir, 'events.jsonl')), logBefore, 'with nothing of A alive, B wrote nothing to A\'s log');
    await recoverToFixedPoint(a);
    const { view, events } = journalOf(a);
    const done = view.doneOf(spawn.op);
    assert.ok(done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.recoveredBy === 'reconciled', JSON.stringify(done));
    assert.equal(events.filter((e) => (e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable')) && e.fact.inv === inv).length, 1, 'one usage fact');
  });
});
