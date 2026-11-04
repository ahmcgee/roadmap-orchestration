import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acknowledge, applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { commandId } from '../src/core/ids.ts';
import { branchName } from '../src/core/values.ts';
import { startIntegrationPushes } from '../src/forge/integration-push.ts';
import { PUSH_TIMEOUT_MS, pushBranch, pushWithLease } from '../src/forge/push.ts';
import { openNeedsUser, raiseNeedsUser, readNeedsUser } from '../src/needsuser.ts';
import { publishCloseOut } from '../src/pipeline/publish.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { BRANCH, openPush, publish, pushScene, type PushRun } from './fixtures/integration-push-common.ts';
import { publishArc, wire } from './fixtures/publish-common.ts';
import { admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { applyBody, contextFor, gateStep, mulBuild, syncInputs } from './fixtures/unit-common.ts';
import { reached } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { attachOrigin, makeBareOrigin, originRef } from './helpers/origin.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';

const T = { timeout: 120_000 };
const items = (r: PushRun) => r.journal.view.needsUser().map((n) => readNeedsUser(r.runDir, n.id)!);
async function close(r: PushRun) { try { await r.pushes.close(); } finally { r.journal.close(); } }

// These are actual pipeline publications, not hand-authored done records.
test('integration push: a unit merge, revision docs and close-out each push their exact head; main remains the m5 seed', T, async () => {
  const d = publishArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] }, (d) => {
    git(d.repo, 'branch', BRANCH);
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
    writeFileSync(d.planPath, JSON.stringify({ ...plan, integrationBranch: BRANCH }));
  });
  const origin = makeBareOrigin();
  attachOrigin(d.repo, origin);
  const seed = originRef(origin, 'main');
  const r = contextFor(d);
  const pushes = startIntegrationPushes({ ...r.ctx, journal: r.journal });
  const w = wire(r);
  const tick = setInterval(() => w.arbiter.wake(), 25);
  try {
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' });
    const unit = git(d.repo, 'rev-parse', BRANCH);
    await pushes.drain();
    assert.equal(originRef(origin, BRANCH), unit, 'unit merge head pushed');

    const arbiter = createArbiter(r.ctx);
    const outcome = await publishCloseOut({ ...r.ctx, arbiter });
    assert.equal(outcome.kind, 'published', JSON.stringify(outcome));
    await pushes.drain();
    const closed = git(d.repo, 'rev-parse', BRANCH);
    assert.equal(originRef(origin, BRANCH), closed, 'close-out head pushed');
    assert.notEqual(closed, unit);

    syncInputs(r);
    const ledger = join(d.planPath, '..', 'rulings.md');
    writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}C-2 — Helpers take finite numbers only.\n`);
    const cmd = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { ...applyBody(d), reason: 'Document finite numbers.' });
    const applied = await applyCommand(w.commands, cmd);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    const docs = git(d.repo, 'rev-parse', BRANCH);
    assert.notEqual(docs, closed);
    await pushes.drain();
    assert.equal(originRef(origin, BRANCH), docs, 'revision docs head pushed');
    assert.deepEqual(r.journal.view.integrationPushes().map((p) => p.fact.result), ['pushed', 'pushed', 'pushed']);
    assert.equal(originRef(origin, 'main'), seed, 'm5: origin main stays at the seed');
    assert.deepEqual(pushBranch(r.ctx.repo, BRANCH, r.journal.view.integrationPushes().at(-1)!.fact.head), { kind: 'up-to-date' }, 'roadmap pr uses this same no-op');
  } finally {
    clearInterval(tick);
    await pushes.close();
    r.journal.close();
  }
});

test('integration push: unreachable origin raises one non-blocking notice, publications continue, next ff retries and settles by id', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  git(s.repo, 'remote', 'set-url', 'origin', join(origin, 'unreachable.git'));
  const r = openPush(s);
  try {
    const first = await publish(r);
    await r.pushes.drain();
    await publish(r);
    await r.pushes.drain();
    const [notice] = items(r);
    assert.equal(items(r).length, 1);
    assert.deepEqual([notice!.reason, notice!.blocking, notice!.subject], ['push-failed', false, { type: 'arc' }]);
    assert.match(notice!.summary, /git ls-remote.*not appear to be a git repository/s);
    assert.ok(notice!.summary.includes(first));
    assert.equal(r.journal.view.integrationPushes().length, 2, 'both failures durable; the second publication completed');
    assert.equal(openNeedsUser(r.journal.view).length, 1);
    git(s.repo, 'remote', 'set-url', 'origin', origin);
    const head = await publish(r);
    await r.pushes.drain();
    assert.equal(originRef(origin, BRANCH), head);
    assert.deepEqual(r.journal.view.integrationPushes().at(-1)!.fact.settles, [notice!.id]);
    assert.deepEqual(openNeedsUser(r.journal.view), [], 'success explicitly settles the named item');
    assert.equal(items(r).length, 1, 'settlement keeps the durable notice');
    git(s.repo, 'remote', 'set-url', 'origin', join(origin, 'unreachable.git'));
    await publish(r);
    await r.pushes.drain();
    assert.equal(items(r).length, 2, 'a new failure episode raises a new item');
  } finally { await close(r); }
});

test('integration push: divergence checks keep refusing without force or repeat notices until the remote is an ancestor', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  const r = openPush(s);
  try {
    const seed = originRef(origin, 'main')!;
    const foreign = git(s.repo, 'commit-tree', `${seed}^{tree}`, '-p', seed, '-m', 'foreign branch');
    git(s.repo, 'push', 'origin', `${foreign}:refs/heads/${BRANCH}`);
    // Count real remote push attempts. ls-remote ancestry probes must continue so resolution is detected.
    const count = join(origin, 'attempts');
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\necho push >> '${count}'\n`);
    chmodSync(hook, 0o755);
    await publish(r);
    await r.pushes.drain();
    await publish(r);
    await r.pushes.drain();
    assert.equal(items(r).length, 1);
    assert.equal(items(r)[0]!.reason, 'push-diverged');
    assert.equal(items(r)[0]!.blocking, false);
    assert.equal(originRef(origin, BRANCH), foreign, 'foreign work is preserved');
    assert.equal(git(origin, 'rev-parse', BRANCH), foreign);
    assert.equal(existsSync(count), false, 'no git push attempted while diverged');
    acknowledge(r, commandId('cmd-0000000000000001'), items(r)[0]!.id, null);
    await publish(r);
    await r.pushes.drain();
    assert.equal(items(r).length, 1, 'named ack accepts this episode without raising it again');
    assert.equal(existsSync(count), false, 'ack never bypasses the ancestry rule');
    // The owner resolves the remote back to an ancestor. Automatic publication may now resume.
    git(origin, 'update-ref', `refs/heads/${BRANCH}`, seed, foreign);
    const head = await publish(r);
    await r.pushes.drain();
    assert.equal(originRef(origin, BRANCH), head);
    assert.equal(readFileSync(count, 'utf8'), 'push\n');
    assert.deepEqual(openNeedsUser(r.journal.view), []);
  } finally { await close(r); }
});

test('integration push: main is never pushed; missing origin records one quiet fact across publications and startup', T, async () => {
  const s = pushScene();
  let r = openPush(s);
  await publish(r);
  await publish(r);
  await r.pushes.drain();
  assert.deepEqual(r.journal.view.integrationPushes().map((p) => p.fact.result), ['no-origin']);
  assert.deepEqual(items(r), []);
  await close(r);
  r = openPush(s);
  try {
    r.pushes.recover(BRANCH);
    await r.pushes.drain();
    assert.equal(r.journal.view.integrationPushes().length, 1, 'no repeated start noise');
    const origin = makeBareOrigin();
    attachOrigin(s.repo, origin);
    const seed = originRef(origin, 'main');
    await publish(r, branchName('main'));
    await r.pushes.drain();
    assert.equal(originRef(origin, 'main'), seed);
    assert.match(r.journal.view.integrationPushes().at(-1)!.fact.error!, /refusing to push main/);
    assert.throws(() => pushWithLease(r.repo, BRANCH, r.journal.view.integrationPushes().at(-1)!.fact.head, null, Date.now() - 1), /timed out/);
    assert.equal(PUSH_TIMEOUT_MS, 300_000);
  } finally { await close(r); }
});

test('integration push: slow user-environment network does not hold publication or the scheduler thread', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  const barrier = tmpDir('push-barrier');
  const hook = join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\ntest "$GIT_TERMINAL_PROMPT" = 0 || exit 1\ntest "$SSH_AUTH_SOCK" = '${barrier}/user-agent.sock' || exit 1\ntouch '${barrier}/push.reached'\nwhile ! test -f '${barrier}/release'; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);
  const r = openPush(s);
  const originalAgent = process.env['SSH_AUTH_SOCK'];
  process.env['SSH_AUTH_SOCK'] = join(barrier, 'user-agent.sock');
  try {
    const head = await publish(r); // ff returns while push is outstanding
    await reached(barrier, 'push', 30_000);
    assert.equal(git(s.repo, 'rev-parse', BRANCH), head);
    assert.equal(originRef(origin, BRANCH), null);
    assert.equal(r.journal.view.integrationPushes().length, 0, 'push is still running');
    const next = await publish(r); // next stage/publication also advances during the slow network
    assert.notEqual(next, head);
    writeFileSync(join(barrier, 'release'), 'go');
    await r.pushes.drain();
    assert.equal(originRef(origin, BRANCH), next);
    assert.deepEqual(r.journal.view.integrationPushes().map((p) => p.fact.head), [head, next]);
  } finally {
    if (originalAgent === undefined) delete process.env['SSH_AUTH_SOCK'];
    else process.env['SSH_AUTH_SOCK'] = originalAgent;
    writeFileSync(join(barrier, 'release'), 'go');
    await close(r);
  }
});

test('integration push: crash between durable ff and push recovers current head at startup; already remote is idempotent', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  const seed = originRef(origin, 'main');
  const trigger = writeTrigger(tmpDir('push-crash'), { label: 'integration-push.after-ff', occurrence: 1 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('integration-push-child.ts', [JSON.stringify(s), 'publish'], { env, timeoutMs: 30_000 });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assertFired(trigger);
  assert.equal(originRef(origin, BRANCH), null, 'crash preceded network publication');
  const head = git(s.repo, 'rev-parse', BRANCH);
  assert.notEqual(head, seed);
  const second = await runFixture('integration-push-child.ts', [JSON.stringify(s), 'recover'], { env, timeoutMs: 30_000 });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(originRef(origin, BRANCH), head);
  const r = openPush(s);
  try {
    assert.equal(r.journal.view.opsOf('integration.ff').length, 1, 'no new ff needed to recover');
    r.pushes.recover(BRANCH);
    await r.pushes.drain();
    assert.deepEqual(r.journal.view.integrationPushes().map((p) => p.fact.result), ['pushed', 'up-to-date']);
    assert.equal(originRef(origin, 'main'), seed);
  } finally { await close(r); }
});


test('integration push: crash after remote acceptance recovers as up-to-date without a second push', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  const trigger = writeTrigger(tmpDir('push-accepted-crash'), { label: 'integration-push.after-network', occurrence: 1 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('integration-push-child.ts', [JSON.stringify(s), 'publish'], { env, timeoutMs: 30_000 });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assertFired(trigger);
  assert.equal(originRef(origin, BRANCH), git(s.repo, 'rev-parse', BRANCH));
  const r = openPush(s);
  try {
    assert.deepEqual(r.journal.view.integrationPushes(), [], 'remote accepted before any result fact');
    r.pushes.recover(BRANCH);
    await r.pushes.drain();
    assert.deepEqual(r.journal.view.integrationPushes().map((p) => p.fact.result), ['up-to-date']);
    assert.deepEqual(items(r), []);
  } finally { await close(r); }
});

test('integration push: crash after failed fact reconstructs its one notice before a successful startup settles it', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  git(s.repo, 'remote', 'set-url', 'origin', join(origin, 'unreachable.git'));
  const trigger = writeTrigger(tmpDir('push-result-crash'), { label: 'integration-push.after-result', occurrence: 1 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('integration-push-child.ts', [JSON.stringify(s), 'publish'], { env, timeoutMs: 30_000 });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assertFired(trigger);
  git(s.repo, 'remote', 'set-url', 'origin', origin);
  let r = openPush(s);
  assert.equal(r.journal.view.integrationPushes()[0]!.fact.result, 'failed');
  assert.deepEqual(items(r), [], 'failure fact preceded its notice');
  r.pushes.recover(BRANCH);
  await r.pushes.drain();
  const notice = items(r)[0]!;
  assert.equal(items(r).length, 1);
  assert.equal(notice.reason, 'push-failed');
  assert.deepEqual(r.journal.view.integrationPushes().at(-1)!.fact.settles, [notice.id]);
  await close(r);
  r = openPush(s);
  try {
    assert.deepEqual(openNeedsUser(r.journal.view), [], 'settlement is preserved by replay');
    assert.equal(originRef(origin, BRANCH), git(s.repo, 'rev-parse', BRANCH));
  } finally { await close(r); }
});

// Verify the subscription and recovery are installed by the real executor, not just fixture wiring.
test('integration push: supervised executor startup and unit publication push origin while preserving main', T, async (t) => {
  const { setupExec, SMOKE_DEFAULT, startExec, journalOf } = await import('./fixtures/exec-common.ts');
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  git(r.repo, 'branch', BRANCH);
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8'));
  writeFileSync(r.planPath, JSON.stringify({ ...plan, integrationBranch: BRANCH }));
  const origin = makeBareOrigin();
  attachOrigin(r.repo, origin);
  const seed = originRef(origin, 'main');
  const exit = await startExec(r).exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(originRef(origin, BRANCH), git(r.repo, 'rev-parse', BRANCH));
  assert.equal(originRef(origin, 'main'), seed);
  const results = journalOf(r).view.integrationPushes();
  assert.ok(results.some((p) => p.fact.head === seed && p.fact.result === 'pushed'), 'startup publishes the current integration ref');
  assert.ok(results.some((p) => p.fact.head !== seed && p.fact.result === 'pushed'), 'ff subscription publishes the merged head');
});


test('integration push: the wall deadline kills a real slow git process group, records timeout and keeps the arc running', T, async (t) => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  const barrier = tmpDir('push-timeout');
  const hook = join(origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\ntrap '' TERM\ntouch '${barrier}/push.reached'\nwhile ! test -f '${barrier}/release'; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);
  const r = openPush(s);
  const watcher = watch(barrier);
  const networkStarted = new Promise<void>((resolve) => watcher.on('change', () => {
    if (existsSync(join(barrier, 'push.reached'))) resolve();
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const head = await publish(r);
    await networkStarted;
    assert.equal(originRef(origin, BRANCH), null);
    t.mock.timers.tick(PUSH_TIMEOUT_MS);
    await r.pushes.drain();
    const result = r.journal.view.integrationPushes().at(-1)!.fact;
    assert.equal(result.result, 'failed');
    assert.equal(result.head, head);
    assert.match(result.error!, /timed out after 300000ms/);
    assert.deepEqual(items(r).map((n) => [n.reason, n.blocking]), [['push-failed', false]]);
    assert.equal(originRef(origin, BRANCH), null, 'timed-out git never publishes');
    t.mock.timers.reset();
    writeFileSync(join(barrier, 'release'), 'go');
    const next = await publish(r);
    await r.pushes.drain();
    assert.equal(originRef(origin, BRANCH), next, 'a later ff retries successfully');
    assert.deepEqual(openNeedsUser(r.journal.view), []);
  } finally {
    t.mock.timers.reset();
    watcher.close();
    writeFileSync(join(barrier, 'release'), 'go');
    await close(r);
  }
});


test('integration push: success settles only named push notices and leaves unrelated arc items open (dev.42)', T, async () => {
  const s = pushScene();
  const origin = makeBareOrigin();
  attachOrigin(s.repo, origin);
  git(s.repo, 'remote', 'set-url', 'origin', join(origin, 'unreachable.git'));
  const r = openPush(s);
  try {
    const unrelated = raiseNeedsUser(r.journal, r.runDir, {
      reason: 'revision-notice', subject: { type: 'arc' }, blocking: false,
      summary: 'Review the revision.', recommendation: 'Review and acknowledge by id.', options: [], evidence: [],
    }, { type: 'arc' });
    await publish(r);
    await r.pushes.drain();
    const failed = items(r).find((n) => n.reason === 'push-failed')!;
    git(s.repo, 'remote', 'set-url', 'origin', origin);
    await publish(r);
    await r.pushes.drain();
    assert.deepEqual(r.journal.view.integrationPushes().at(-1)!.fact.settles, [failed.id]);
    assert.deepEqual(openNeedsUser(r.journal.view).map((n) => n.id), [unrelated]);
  } finally { await close(r); }
});
