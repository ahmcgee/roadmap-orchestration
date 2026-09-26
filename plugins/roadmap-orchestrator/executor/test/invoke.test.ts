// `invoke` and proc.kill on the live path, with real runners, real workloads and the fake backend:
// results and their done records, deadline and cancel as uncharged process faults, one usage fact per
// invocation, the backstop's orphan kill, and the proc.kill crash row of the matrix.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAlive, signal } from '../src/contain/proc.ts';
import { sessionContainment } from '../src/contain/session.ts';
import type { DoneOf, Fact } from '../src/core/events.ts';
import { arcId, invocationId, opId, parseInvocationId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { invocationDir, invoke, killWorkload } from '../src/pipeline/invoke.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { TEST_DEADLINE_GRACE_MS, TEST_DEADLINE_MS, waitFor, workload } from './helpers/invocation.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import {
  backend, command, context, dones, intents, open, recover, run, runChild, scenario, specFor, usageFacts,
} from './fixtures/invoke-specs.ts';
import { PROC_KILL, crashCells } from './matrix.ts';

const T = { timeout: 30_000 };
const OK = { ok: true } as const;

const spawnDones = (runDir: string): readonly DoneOf<'proc.spawn'>[] => dones(runDir, 'proc.spawn') as readonly DoneOf<'proc.spawn'>[];

function summaryOf(runDir: string, index = 0) {
  const done = spawnDones(runDir)[index];
  assert.ok(done !== undefined, 'the spawn is done');
  assert.equal(done.outcome.kind, 'result');
  if (done.outcome.kind !== 'result') throw new Error('unreachable');
  return done.outcome.summary;
}

test('invoke.backend-result', T, async () => {
  const r = run();
  const s = scenario([{ as: 'claude', expect: { argv: ['--tools', 'Read,Grep,Glob'] }, acts: [{ type: 'emit', value: OK }] }]);
  const journal = open(r.runDir, r.arc);
  const outcome = await invoke(journal, context(journal, r.runDir).containment, specFor(backend(r, s)));
  journal.close();
  assert.equal(outcome.kind, 'result');
  if (outcome.kind !== 'result' || outcome.result.type !== 'backend') throw new Error(JSON.stringify(outcome));
  assert.deepEqual(outcome.result.outcome, { kind: 'success', value: OK });
  assert.equal(spawnDones(r.runDir)[0]?.recoveredBy, null);
  assert.deepEqual(summaryOf(r.runDir), { type: 'backend', outcome: 'success' });
  assert.deepEqual(usageFacts(r.runDir).map((f) => f.kind), ['meter']);
  assert.equal(readCalls(s.path).length, 1);
  // Quiescent at the end: the runner is gone and no member of the invocation is alive.
  assert.equal(sessionContainment.empty({ inv: outcome.inv, child: null }), true);
  assert.deepEqual(intents(r.runDir, 'proc.kill'), []);
});

test('invoke.command-verdicts', T, async () => {
  const r = run();
  const journal = open(r.runDir, r.arc);
  const containment = context(journal, r.runDir).containment;
  for (const [purpose, code, verdict] of [['lane', '0', 'pass'], ['teardown', '3', 'fail'], ['probe', '0', 'pass']] as const) {
    const outcome = await invoke(journal, containment, specFor(command(r, purpose, workload('workload-exit.ts', code))));
    assert.equal(outcome.kind, 'result');
    if (outcome.kind !== 'result' || outcome.result.type !== 'command') throw new Error(JSON.stringify(outcome));
    assert.equal(outcome.result.verdict, verdict);
    assert.equal(outcome.result.purpose, purpose);
  }
  journal.close();
  assert.deepEqual(spawnDones(r.runDir).map((d) => d.outcome.kind === 'result' ? d.outcome.summary : null), [
    { type: 'command', verdict: 'pass' }, { type: 'command', verdict: 'fail' }, { type: 'command', verdict: 'pass' },
  ]);
  assert.deepEqual(usageFacts(r.runDir), [], 'commands carry no usage');
});

test('invoke.deadline', T, async () => {
  const r = run();
  const s = scenario([{ as: 'claude', expect: {}, acts: [{ type: 'hang', ms: 60_000 }, { type: 'emit', value: OK }] }]);
  const journal = open(r.runDir, r.arc);
  const containment = context(journal, r.runDir).containment;
  const b = await invoke(journal, containment, specFor(backend(r, s, TEST_DEADLINE_MS, TEST_DEADLINE_GRACE_MS)));
  const l = await invoke(journal, containment, specFor(command(r, 'lane', workload('workload-hang.ts'), TEST_DEADLINE_MS, TEST_DEADLINE_GRACE_MS)));
  journal.close();
  for (const outcome of [b, l]) {
    const exit = runnerFiles(invocationDir(absPath(r.runDir), outcome.inv), outcome.inv).read('exit.json');
    assert.equal(exit?.cause, 'deadline');
  }
  // The uncharged classification is in the done record itself.
  assert.deepEqual(summaryOf(r.runDir, 0), { type: 'backend', outcome: 'process-fault' });
  assert.deepEqual(summaryOf(r.runDir, 1), { type: 'command', verdict: 'process-fault' });
  const facts = usageFacts(r.runDir);
  assert.equal(facts.length, 1, 'one usage fact, for the backend call only');
  assert.equal(facts[0]?.kind, 'usage-unavailable');
});

test('invoke.cancel', T, async () => {
  const r = run();
  const s = scenario([{ as: 'claude', expect: {}, acts: [{ type: 'hang', ms: 60_000 }] }]);
  const journal = open(r.runDir, r.arc);
  const ctx = context(journal, r.runDir);
  const inv = invocationId(opId(journal.view.arc, 1), 1);
  const running = invoke(journal, ctx.containment, specFor(backend(r, s)));
  const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
  await waitFor('the workload', 10_000, () => files.read('runner.json')?.child ?? null);
  await killWorkload(ctx, { inv, scope: 'invocation', reason: 'pause' });
  const outcome = await running;
  journal.close();
  assert.equal(outcome.kind, 'result');
  assert.equal(files.read('cancel.json')?.reason, 'pause');
  assert.equal(files.read('exit.json')?.cause, 'cancel');
  assert.deepEqual(summaryOf(r.runDir), { type: 'backend', outcome: 'cancelled' });
  const result = files.read('result.json');
  assert.deepEqual(result?.type === 'backend' ? result.outcome : null, { kind: 'cancelled', reason: 'pause' }, 'an honest record: a pause, not a fault');
  const [kill] = intents(r.runDir, 'proc.kill');
  assert.ok(kill !== undefined && kill.kind === 'proc.kill');
  assert.deepEqual(kill.expect, { inv, scope: 'invocation', reason: 'pause' });
  assert.deepEqual(kill.parent, { type: 'op', op: outcome.op });
  assert.deepEqual(dones(r.runDir, 'proc.kill').map((d) => [d.outcome, d.recoveredBy]), [[{ kind: 'quiesced' }, null]]);
});

test('invoke.meter-per-inv', T, async () => {
  const r = run();
  const s = scenario([
    { as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] },
    { as: 'claude', expect: {}, acts: [{ type: 'noUsage', value: OK }] },
    { as: 'claude', expect: {}, acts: [{ type: 'hang', ms: 60_000 }] },
  ]);
  const journal = open(r.runDir, r.arc);
  const ctx = context(journal, r.runDir);
  const known = await invoke(journal, ctx.containment, specFor(backend(r, s)));
  const absent = await invoke(journal, ctx.containment, specFor(backend(r, s)));
  await invoke(journal, ctx.containment, specFor(command(r, 'lane', workload('workload-exit.ts', '0'))));

  // Lost: the runner hangs (stopped), the executor's backstop kills it, and the workload it leaves behind
  // is killed by a proc.kill{recovery} before the invocation is classified.
  const lostInv = invocationId(opId(journal.view.arc, journal.view.highWater() + 1), 1);
  const lostSpec = backend(r, s, TEST_DEADLINE_MS);
  const running = invoke(journal, ctx.containment, specFor(lostSpec));
  const files = runnerFiles(invocationDir(ctx.runDir, lostInv), lostInv);
  const runner = await waitFor('the workload', TEST_DEADLINE_MS, () => {
    const f = files.read('runner.json');
    return f?.child == null ? null : f;
  });
  signal(runner.runner, 'SIGSTOP');
  // Stopped before its deadline, the runner cannot enforce it: only the backstop can end the invocation.
  assert.ok(Date.now() < new Date(lostSpec.deadlineAt).getTime(), 'the runner was stopped only after its deadline');
  const lost = await running;
  journal.close();
  assert.deepEqual(lost, { kind: 'lost', op: parseInvocationId(lostInv).op, inv: lostInv, treeEffects: true });
  assert.equal(isAlive(runner.runner), false);
  assert.ok(runner.child !== null);
  assert.equal(isAlive(runner.child), false, 'the orphaned workload was killed');
  assert.deepEqual(intents(r.runDir, 'proc.kill').map((k) => k.kind === 'proc.kill' ? k.expect : null), [{ inv: lostInv, scope: 'invocation', reason: 'recovery' }]);

  const byInv = new Map<string, Fact[]>();
  for (const f of usageFacts(r.runDir)) if (f.kind === 'meter' || f.kind === 'usage-unavailable') byInv.set(f.inv, [...(byInv.get(f.inv) ?? []), f]);
  assert.deepEqual([...byInv.keys()].sort(), [known.inv, absent.inv, lostInv].sort(), 'backend invocations only');
  for (const facts of byInv.values()) assert.equal(facts.length, 1, 'exactly one usage fact per invocation');
  const reason = (inv: string): string => {
    const f = byInv.get(inv)?.[0];
    return f === undefined ? 'none' : f.kind === 'meter' ? 'known' : f.kind === 'usage-unavailable' ? f.reason : f.kind;
  };
  assert.equal(reason(known.inv), 'known');
  assert.equal(reason(absent.inv), 'absent');
  assert.equal(reason(lostInv), 'no-result');
});

// The proc.kill row: the executor (invoke-child `pause`) crashes inside a pause kill of a hanging backend
// call; recovery runs the kill reconciler, then the spawn's.
const KILL_EXPECT: Readonly<Record<string, Readonly<{ kill: readonly (string | null)[]; spawn: readonly (string | null)[] }>>> = {
  'kill.after-intent': { kill: ['redone'], spawn: ['redone'] },
  'kill.after-cancel': { kill: ['reconciled', 'redone'], spawn: ['redone'] },
  'kill.after-quiesced': { kill: ['reconciled'], spawn: [null, 'redone'] },
  'kill.after-done': { kill: [null], spawn: [null, 'redone'] },
};

const killCells = crashCells(PROC_KILL);
test('matrix: proc.kill cells are the kill crash cases', () => {
  assert.deepEqual(killCells.map((c) => c.label).sort(), Object.keys(KILL_EXPECT).sort());
});

for (const { boundary, label } of killCells) {
  test(`proc.kill.crash.${boundary}.${label}`, T, async () => {
    const r = run();
    const s = scenario([{ as: 'claude', expect: {}, acts: [{ type: 'hang', ms: 60_000 }] }]);
    const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
    const exit = await runChild('pause', backend(r, s), trigger);
    assert.equal(exit.signal, 'SIGKILL', exit.stderr);
    assertFired(trigger);

    await recover(r.runDir, r.arc);
    const want = KILL_EXPECT[label]!;
    const kills = dones(r.runDir, 'proc.kill');
    assert.equal(kills.length, 1);
    assert.ok(want.kill.includes(kills[0]!.recoveredBy), `kill recoveredBy ${kills[0]!.recoveredBy}`);
    const spawns = spawnDones(r.runDir);
    assert.equal(spawns.length, 1);
    assert.ok(want.spawn.includes(spawns[0]!.recoveredBy), `spawn recoveredBy ${spawns[0]!.recoveredBy}`);
    assert.deepEqual(summaryOf(r.runDir), { type: 'backend', outcome: 'cancelled' });
    const inv = invocationId(opId(arcId(r.arc), 1), 1);
    const files = runnerFiles(invocationDir(absPath(r.runDir), inv), inv);
    assert.equal(files.read('exit.json')?.cause, 'cancel');
    assert.equal(existsSync(join(files.invDir, 'result.json')), true);
    assert.equal(readCalls(s.path).length, 1, 'no second invocation');
    assert.equal(sessionContainment.empty({ inv, child: null }), true);
    assert.equal(usageFacts(r.runDir).length, 1);
    assert.equal(readFileSync(join(files.invDir, 'runner.log'), 'utf8'), '');
  });
}
