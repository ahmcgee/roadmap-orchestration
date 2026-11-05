// Real git permission failures, repaired and resumed in the same executor process.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { opKey, sha, unitId } from '../src/core/ids.ts';
import { blockingItems, holdsUnit, openNeedsUser, readNeedsUser } from '../src/needsuser.ts';
import { runOp, unitBranch, verificationWorktree } from '../src/pipeline/dispatch.ts';
import { haltResult, runUnit, step } from '../src/pipeline/unit.ts';
import { worktreeCreateOp } from '../src/recover/ops.ts';
import { recover } from '../src/recover/recover.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { git, tmpDir } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { ADD_BROKEN, type ArcRun, U1, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

after(assertNoSurvivors);
const T = { timeout: SCENARIO_TIMEOUT_MS };
const U2 = unitId('u2');
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const live = async () => true;

/** Stop after one lanes stage, before its fix round or gate. */
function throughLanes() {
  let ran = false;
  return async (next: { stage: string }) => {
    if (ran) return false;
    if (next.stage === 'lanes') ran = true;
    return true;
  };
}

function onlyUnitBlocked(r: ArcRun): void {
  const items = blockingItems(r.ctx.runDir, r.journal.view);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(item.reason, 'residue');
    assert.equal(item.subject, 'unit');
    assert.equal(item.unit, U1);
    assert.equal(holdsUnit(item, U2), false);
    const notice = readNeedsUser(r.ctx.runDir, item.id)!;
    assert.match(notice.recommendation, /sudo chown -R/);
    assert.match(notice.recommendation, /roadmap resume u1/);
    assert.doesNotMatch(notice.recommendation, /Then restart/);
  }
  assert.ok([...resourceTable(r.journal.view).values()].every((e) => e.status.state === 'free'), 'residue holds no reservation');
}

async function resume(r: ArcRun) {
  return applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'resume', target: { type: 'unit', unit: U1 } }));
}

for (const repair of ['removed by hand', 'permissions restored'] as const) {
  test(`base checkout residue parks only u1; ${repair}, resume reconciles without restarting`, T, async () => {
    assert.notEqual(process.getuid?.(), 0, 'permission tests require an ordinary user');
    const marker = join(tmpDir('checkout-residue'), 'armed');
    writeFileSync(marker, '');
    const suite: LaneJson = {
      id: 'suite', cadence: 'unit', argv: ['sh', '-c',
        `node --test test/add.test.js; result=$?; case "$PWD" in *u1.fast-base-*) if [ -e '${marker}' ]; then rm '${marker}'; mkdir -p out/locked; echo residue > out/locked/file; chmod 555 out/locked; fi;; esac; exit "$result"`],
    };
    const d = setupArc({
      units: [{ id: 'u1' }, { id: 'u2' }], suite: [suite],
      steps: ['u1', 'u2'].flatMap((id) => of(id, [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/add.js': ADD_BROKEN })])),
    });
    const r = contextFor(d);
    let path: string | undefined;
    try {
      const result = await runUnit(r.ctx, r.unit('u1'), throughLanes());
      assert.equal(result.kind, 'parked');
      assert.equal(outcomes(d, 'u1').at(-1), 'lanes:checkout-residue');
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
      assert.equal(haltResult(r.ctx, r.unit('u1'))?.needsUser.reason, 'residue', 'park replay preserves its reason and resume advice');
      onlyUnitBlocked(r);
      const intent = r.journal.view.openIntents().find((i) => i.kind === 'worktree.remove');
      assert.ok(intent?.kind === 'worktree.remove');
      path = intent.expect.path;
      assert.match(path, /u1.fast-base-/);

      // Startup uses the same recovery path, remains at a fixed point and raises no arc blocker.
      const recovered = await recover({ stage: r.ctx, commands: commandContextFor(r) });
      assert.deepEqual(recovered.parked, [intent.op]);
      onlyUnitBlocked(r);
      const refused = await resume(r);
      assert.equal(refused.kind, 'rejected', 'permission repair is required before resume un-parks the unit');
      assert.equal(r.journal.view.unit(U1).status, 'park-pending');
      assert.equal(r.journal.view.doneOf(intent.op), null);

      // Same suite and base: u1's rejected shared comparison must not poison u2's work.
      assert.equal((await runUnit(r.ctx, r.unit('u2'), throughLanes())).kind, 'held');
      assert.equal(outcomes(d, 'u2').at(-1), 'lanes:red');
      assert.equal(r.journal.view.unit(U2).status, 'active');
      onlyUnitBlocked(r);

      chmodSync(join(path, 'out/locked'), 0o755);
      if (repair === 'removed by hand') rmSync(path, { recursive: true, force: true });
      assert.equal((await resume(r)).kind, 'applied');
      assert.equal(r.journal.view.doneOf(intent.op)?.recoveredBy, repair === 'removed by hand' ? 'reconciled' : 'redone');
      assert.equal(existsSync(path), false);
      assert.equal(openNeedsUser(r.journal.view).filter((n) => n.blocking).length, 0, 'resume closes unit notices');
      assert.equal((await runUnit(r.ctx, r.unit('u1'), throughLanes())).kind, 'held');
      assert.equal(outcomes(d, 'u1').at(-1), 'lanes:regression', 'the same executor proceeds through lanes');
    } finally {
      if (path && existsSync(join(path, 'out/locked'))) chmodSync(join(path, 'out/locked'), 0o755);
      r.journal.close();
    }
  });

  test(`verification checkout retirement residue is unit-scoped; ${repair} then resume settles it`, T, async () => {
    assert.notEqual(process.getuid?.(), 0);
    const marker = join(tmpDir('checkout-retire'), 'armed');
    writeFileSync(marker, '');
    const spec: LaneJson = { id: 'mul', argv: ['sh', '-c',
      `node --test test/mul.test.js || exit 1; if [ -e '${marker}' ]; then rm '${marker}'; mkdir -p out/locked; echo residue > out/locked/file; chmod 555 out/locked; fi`] };
    const d = setupArc({ units: [{ id: 'u1', lanes: [spec] }], steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
    const r = contextFor(d);
    const path = verificationWorktree(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, U1);
    try {
      const result = await runUnit(r.ctx, r.unit('u1'), live);
      assert.equal(result.kind, 'held');
      assert.ok(result.kind === 'held' && result.needsUser?.reason === 'residue');
      onlyUnitBlocked(r);
      const intent = r.journal.view.openIntents().find((i) => i.kind === 'worktree.remove');
      assert.ok(intent?.kind === 'worktree.remove');
      assert.equal(intent.expect.path, path);
      assert.equal((await resume(r)).kind, 'rejected');
      chmodSync(join(path, 'out/locked'), 0o755);
      if (repair === 'removed by hand') rmSync(path, { recursive: true, force: true });
      assert.equal((await resume(r)).kind, 'applied');
      assert.equal(r.journal.view.doneOf(intent.op)?.recoveredBy, repair === 'removed by hand' ? 'reconciled' : 'redone');
      assert.equal((await resume(r)).kind, 'applied', 'a replay after reconciliation still succeeds');
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live), { kind: 'merged' });
      assert.equal(openNeedsUser(r.journal.view).filter((n) => n.blocking).length, 0);
    } finally {
      if (existsSync(join(path, 'out/locked'))) chmodSync(join(path, 'out/locked'), 0o755);
      r.journal.close();
    }
  });
}

for (const reset of [false, true]) {
  test(`a unit step reconciles its own open ${reset ? 'reset' : 'create'} intent and leaves another unit's intents alone`, T, async () => {
    const d = setupArc({ units: [{ id: 'u1' }, { id: 'u2' }], steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    ] });
    const r = contextFor(d);
    const path = join(r.ctx.plan().worktreeRoot, d.arc, 'u1.pending');
    try {
      await runUnit(r.ctx, r.unit('u1'), throughLanes());
      const at = sha(git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1)));
      const parent = { type: 'stage', unit: U1, stage: 'gate', attempt: r.journal.view.unit(U1).counters.attempts + 1 } as const;
      const op = worktreeCreateOp(r.ctx.repo);
      const request = { path: path as typeof r.ctx.repo, checkout: { type: 'detached', at } } as const;
      if (reset) {
        await runOp(r.journal, op, 'worktree:u1:pending', parent, request);
        mkdirSync(join(path, 'locked'));
        writeFileSync(join(path, 'locked/file'), 'residue');
        chmodSync(join(path, 'locked'), 0o555);
        await assert.rejects(runOp(r.journal, op, 'worktree:u1:pending', parent, { ...request, reset: true }), /Permission residue/);
        chmodSync(join(path, 'locked'), 0o755);
      } else {
        const body = await op.prepare(request);
        r.journal.begin({ kind: 'worktree.create', key: opKey('worktree:u1:pending'), parent, deadlineAt: null, body: () => body });
      }
      const own = r.journal.view.openIntents().find((i) => i.kind === 'worktree.create')!;
      const otherBody = await op.prepare({ ...request, path: `${path}-u2` as typeof r.ctx.repo });
      const other = r.journal.begin({ kind: 'worktree.create', key: opKey('worktree:u2:pending'), parent: { ...parent, unit: U2, stage: 'prepare', attempt: 1 }, deadlineAt: null, body: () => otherBody });
      assert.equal((await step(r.ctx, r.unit('u1'))).kind, 'continue');
      assert.equal(r.journal.view.doneOf(own.op)?.recoveredBy, 'redone');
      assert.ok(r.journal.view.openIntents().some((i) => i.op === other.op));
      assert.equal(existsSync(`${path}-u2`), false);
    } finally {
      if (existsSync(join(path, 'locked'))) chmodSync(join(path, 'locked'), 0o755);
      r.journal.close();
    }
  });
}
