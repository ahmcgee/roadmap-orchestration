// The first recovery pass (src/recover/recover.ts) over a real arc: open intents of several kinds left as a
// dead executor leaves them, closed in the fixed order and to a fixed point; a park raises one needs-user.
// Named tests: recover.fixed-point, recover.park-raises-needs-user.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommandContext } from '../src/commands/apply.ts';
import { opKey, sha, sha256, specRev } from '../src/core/ids.ts';
import { absPath, isoTimeOf, repoPattern } from '../src/core/values.ts';
import { worktreeCreateOp } from '../src/git/worktree.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { backendEnv } from '../src/preflight/smoke.ts';
import { type RecoveryContext, recover } from '../src/recover/recover.ts';
import { specPatchFileOp } from '../src/spec/patch.ts';
import { writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type ArcRun, U1, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: 60_000 };
const STAGE = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;

function recoveryContext(r: ArcRun): RecoveryContext {
  const commands: CommandContext = { ...r.ctx, hostEnv: backendEnv(r.ctx.hostEnv), routing: { profile: 'default', resolved: r.ctx.routing } };
  return { stage: r.ctx, commands };
}

/** A redirect-shaped patch of u1's spec, prepared (so its intent records every input) but not acted. */
async function openSpecPatch(r: ArcRun) {
  const path = absPath(join(r.ctx.planDir, 'u1.json'));
  const body = await specPatchFileOp.prepare({
    path,
    patch: { expectRev: specRev(1), by: { role: 'executor', inv: `${r.ctx.plan.arc}/1#1` as never }, ops: [{ op: 'add', section: 'facts', item: { id: 'F1' as never, text: 'mul is pure.' } }] },
  });
  const { op } = r.journal.begin({ kind: 'spec.patch', key: opKey('spec:u1'), parent: STAGE, deadlineAt: null, body: () => body });
  return { op, path };
}

test('recover.fixed-point: open spawn, worktree, spec and needs-user intents are closed in order, and a second recovery finds nothing', T, async () => {
  const d = setupArc({ steps: [] });
  // A needs-user raise killed after its intent, before the staged file was published.
  const trigger = writeTrigger(tmpDir('recover-crash'), { label: 'needsuser.raise.before-publish', occurrence: 1 });
  const child = await runFixture('needsuser-child.ts', [d.runDir, d.arc], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 20_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);

  const r = contextFor(d);
  try {
    // A spawn whose runner never started (no launch.json): lost, with no tree effects.
    const spawn = r.journal.begin({
      kind: 'proc.spawn', key: opKey('lane:u1:unit'), parent: STAGE, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
      body: () => ({ expect: { subject: { purpose: 'lane', unit: U1, lane: 'mul' as never, set: 'spec', at: sha(git(d.repo, 'rev-parse', 'main')) }, launchSha256: sha256('0'.repeat(64)) }, post: null }),
    });
    // A worktree the dead executor never created: redone.
    const path = absPath(join(r.ctx.plan.worktreeRoot, r.ctx.plan.arc, 'u1.verify-1'));
    const wtOp = worktreeCreateOp(r.ctx.repo);
    const wtBody = await wtOp.prepare({ path, checkout: { type: 'detached', at: sha(git(d.repo, 'rev-parse', 'main')) } });
    const worktree = r.journal.begin({ kind: 'worktree.create', key: opKey('worktree:u1:verify'), parent: STAGE, deadlineAt: null, body: () => wtBody });
    // A spec patch whose write landed before the crash: done as it stands.
    const patch = await openSpecPatch(r);
    await specPatchFileOp.act(r.journal.view.latestIntent(patch.op) as never);

    const report = await recover(recoveryContext(r));
    assert.deepEqual(report.parked, []);
    assert.deepEqual(r.journal.view.openIntents(), [], 'every intent closed');
    const [raise] = r.journal.view.opsOf('needsuser.raise');
    assert.ok(raise !== undefined);
    assert.deepEqual(report.recovered.map((x) => [x.kind, x.op, x.disposition]), [
      ['proc.spawn', spawn.op, 'lost'],
      ['worktree.create', worktree.op, 'redo'],
      ['spec.patch', patch.op, 'done'],
      ['needsuser.raise', raise.op, 'redo'],
    ], 'processes, then git, then files; the second pass found nothing');
    const byOp = (op: string) => r.journal.view.doneOf(op as never);
    assert.deepEqual([byOp(spawn.op)?.recoveredBy, byOp(worktree.op)?.recoveredBy, byOp(patch.op)?.recoveredBy, byOp(raise.op)?.recoveredBy], ['reconciled', 'redone', 'reconciled', 'redone']);
    assert.equal(git(path, 'rev-parse', 'HEAD'), git(d.repo, 'rev-parse', 'main'), 'the worktree exists at its recorded commit');
    assert.ok(readNeedsUser(r.ctx.runDir, raise.expect.id) !== null, 'the staged needs-user is published');

    const again = await recover(recoveryContext(r));
    assert.deepEqual(again, { recovered: [], parked: [] }, 'recovery at its fixed point changes nothing');
  } finally {
    r.journal.close();
  }
});

test('recover.park-raises-needs-user: a spec file changed by someone else parks its patch; one blocking recovery-required needs-user names the op', T, async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const { op, path } = await openSpecPatch(r);
    const spec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...spec, scope: [repoPattern('elsewhere/**')] }));

    const report = await recover(recoveryContext(r));
    assert.deepEqual(report.parked, [op]);
    assert.deepEqual(report.recovered.map((x) => x.disposition), ['park', 'park'], 'parked in both passes');
    assert.deepEqual(r.journal.view.openIntents().map((i) => i.op), [op], 'a park leaves the intent open');
    const raises = r.journal.view.opsOf('needsuser.raise');
    assert.equal(raises.length, 1, 'one needs-user for the op');
    assert.deepEqual(raises[0]!.parent, { type: 'op', op });
    const item = readNeedsUser(r.ctx.runDir, raises[0]!.expect.id);
    assert.ok(item !== null);
    assert.equal(item.reason, 'recovery-required');
    assert.equal(item.blocking, true);
    assert.deepEqual(item.subject, { type: 'unit', unit: 'u1' });
    assert.match(item.summary, new RegExp(`spec\\.patch ${op}`));

    const again = await recover(recoveryContext(r));
    assert.deepEqual(again.parked, [op]);
    assert.equal(r.journal.view.opsOf('needsuser.raise').length, 1, 'a later recovery does not raise it again');
    assert.equal(r.journal.view.unit(U1).counters.attempts, 1, 'the needs-user is parented by the op, so it starts no stage attempt');
  } finally {
    r.journal.close();
  }
});
