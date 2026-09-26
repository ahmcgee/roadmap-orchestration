// The proc.spawn reconciler after executor crashes, and runner deaths under a live executor: the plan's
// named recover.* tests for the quiescent paths, the proc.spawn row's B2/B4/B5 cells and the runner-death
// row's B3 cells (test/matrix.ts), each with the oracle: the exact allowed recoveredBy, no second
// invocation for completed work, and for lost work one retry with a new inv and the same deadline.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { opMembers } from '../src/contain/session.ts';
import type { DoneOf, IntentOf } from '../src/core/events.ts';
import { type OpId, arcId, invocationId, opId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { invocationDir, invoke } from '../src/pipeline/invoke.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Scenario, readCalls } from './helpers/scenario.ts';
import {
  type Run, type SpecDescriptor, backend, context, dones, intents, invocationDirs, open, openIntents, recover, run, runChild, scenario, specFor,
  usageFacts,
} from './fixtures/invoke-specs.ts';
import { PROC_SPAWN, RUNNER_DEATH, crashCells } from './matrix.ts';

const T = { timeout: 30_000 };
const OK = { ok: true } as const;

const spawnIntents = (runDir: string): readonly IntentOf<'proc.spawn'>[] => intents(runDir, 'proc.spawn') as readonly IntentOf<'proc.spawn'>[];
const spawnDones = (runDir: string): readonly DoneOf<'proc.spawn'>[] => dones(runDir, 'proc.spawn') as readonly DoneOf<'proc.spawn'>[];

function oneCall(): Scenario {
  return scenario([{ as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] }]);
}

/** Runs the child executor with a crash trigger at `label` and asserts it died there. */
async function crashAt(label: string, d: SpecDescriptor): Promise<void> {
  const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
  const exit = await runChild('invoke', d, trigger);
  assert.equal(exit.signal, 'SIGKILL', `the executor did not crash at ${label}: ${exit.stderr}`);
  assertFired(trigger);
}

const firstOp = (r: Run): OpId => opId(arcId(r.arc), 1);
const files = (r: Run, ordinal: number) => {
  const inv = invocationId(firstOp(r), ordinal);
  return runnerFiles(invocationDir(absPath(r.runDir), inv), inv);
};

/** The caller's one retry of a lost op: the next ordinal, which must inherit the deadline and complete. */
async function retryOnce(r: Run, d: SpecDescriptor): Promise<void> {
  const journal = open(r.runDir, r.arc);
  const outcome = await invoke(journal, context(journal, r.runDir).containment, specFor({ ...d, retryOf: firstOp(r) }));
  journal.close();
  assert.equal(outcome.kind, 'result');
  assert.equal(outcome.inv, invocationId(firstOp(r), 2));
  const [first, second] = spawnIntents(r.runDir);
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual([first.ordinal, second.ordinal], [1, 2]);
  assert.equal(second.deadlineAt, first.deadlineAt, 'a retry inherits the deadline');
  assert.notEqual(second.expect.launchSha256, first.expect.launchSha256, 'a retry is a new invocation');
  assert.equal(files(r, 2).read('launch.json')?.deadlineAt, first.deadlineAt);
}

/** One done per ordinal, the last a success, one usage fact per ordinal, nothing open, nothing alive. */
function assertSettled(r: Run, ordinals: number): void {
  const d = spawnDones(r.runDir);
  assert.equal(d.length, ordinals);
  const last = d.at(-1)?.outcome;
  assert.deepEqual(last?.kind === 'result' ? last.summary : last, { type: 'backend', outcome: 'success' });
  const facts = usageFacts(r.runDir);
  assert.equal(facts.length, ordinals, 'one usage fact per invocation');
  assert.equal(new Set(facts.map((f) => (f.kind === 'meter' || f.kind === 'usage-unavailable' ? f.inv : ''))).size, ordinals);
  assert.deepEqual(openIntents(r.runDir, r.arc), []);
  assert.deepEqual(opMembers(firstOp(r)), []);
}

test('recover.completed-unrecorded', T, async () => {
  const r = run();
  const s = oneCall();
  await crashAt('spawn.after-result', backend(r, s));
  const resultBefore = readFileSync(join(files(r, 1).invDir, 'result.json'));
  const recovered = await recover(r.runDir, r.arc);
  assert.deepEqual(recovered.map((x) => x.disposition.kind), ['done']);
  assert.deepEqual(spawnDones(r.runDir).map((x) => x.recoveredBy), ['reconciled']);
  assert.deepEqual(readFileSync(join(files(r, 1).invDir, 'result.json')), resultBefore, 'result.json is certified, not rewritten');
  assert.equal(readCalls(s.path).length, 1, 'no second invocation');
  assert.deepEqual(invocationDirs(r.runDir), ['1-1']);
  assertSettled(r, 1);
});

test('recover.exit-without-result', T, async () => {
  const r = run();
  const s = oneCall();
  await crashAt('spawn.after-runner-exit', backend(r, s));
  assert.ok(files(r, 1).read('exit.json') !== null);
  assert.equal(files(r, 1).read('result.json'), null);
  await recover(r.runDir, r.arc);
  assert.deepEqual(spawnDones(r.runDir).map((x) => x.recoveredBy), ['redone']);
  assert.equal(files(r, 1).read('result.json')?.type, 'backend');
  assert.equal(readCalls(s.path).length, 1, 'the adapter re-ran; the backend did not');
  assertSettled(r, 1);
});

test('recover.before-pidfile', T, async () => {
  const r = run();
  const s = oneCall();
  const d = backend(r, s);
  await crashAt('launch.after-launch-json', d);
  assert.ok(files(r, 1).read('launch.json') !== null);
  assert.equal(existsSync(join(files(r, 1).invDir, 'runner.json')), false);
  const recovered = await recover(r.runDir, r.arc);
  assert.deepEqual(recovered.map((x) => x.disposition), [{ kind: 'lost', treeEffects: false }]);
  assert.deepEqual(spawnDones(r.runDir).map((x) => [x.outcome, x.recoveredBy]), [[{ kind: 'lost', treeEffects: false }, 'reconciled']]);
  assert.deepEqual(usageFacts(r.runDir).map((f) => (f.kind === 'usage-unavailable' ? f.reason : f.kind)), ['no-result']);
  await retryOnce(r, d);
  assert.equal(readCalls(s.path).length, 1, 'the lost ordinal never reached the backend');
  assert.deepEqual(invocationDirs(r.runDir), ['1-1', '1-2']);
  assertSettled(r, 2);
});

// proc.spawn B2, B4, B5: the executor crashes around `invoke`; the restarted one recovers.
type SpawnExpect = Readonly<{ disposition: 'done' | 'lost' | null; recoveredBy: 'reconciled' | 'redone' | null }>;
const SPAWN_EXPECT: Readonly<Record<string, SpawnExpect>> = {
  'spawn.after-intent': { disposition: 'lost', recoveredBy: 'reconciled' },
  'spawn.after-runner-exit': { disposition: 'done', recoveredBy: 'redone' },
  'spawn.after-result': { disposition: 'done', recoveredBy: 'reconciled' },
  'spawn.after-usage': { disposition: 'done', recoveredBy: 'reconciled' },
  'spawn.after-done': { disposition: null, recoveredBy: null },
};

const executorCells = crashCells(PROC_SPAWN).filter((c) => c.boundary !== 'B3');
test('matrix: proc.spawn B2/B4/B5 are the executor crash cases', () => {
  assert.deepEqual(executorCells.map((c) => c.label).sort(), Object.keys(SPAWN_EXPECT).sort());
});

for (const { boundary, label } of executorCells) {
  test(`proc.spawn.crash.${boundary}.${label}`, T, async () => {
    const r = run();
    const s = oneCall();
    const d = backend(r, s);
    await crashAt(label, d);
    const want = SPAWN_EXPECT[label]!;
    const recovered = await recover(r.runDir, r.arc);
    assert.deepEqual(recovered.map((x) => x.disposition.kind), want.disposition === null ? [] : [want.disposition]);
    assert.deepEqual(spawnDones(r.runDir).map((x) => x.recoveredBy), [want.recoveredBy]);
    if (want.disposition === 'lost') {
      assert.deepEqual(spawnDones(r.runDir)[0]?.outcome, { kind: 'lost', treeEffects: false });
      await retryOnce(r, d);
      assert.deepEqual(invocationDirs(r.runDir), ['1-2'], 'the lost ordinal never wrote launch.json');
      assertSettled(r, 2);
    } else {
      assert.deepEqual(invocationDirs(r.runDir), ['1-1']);
      assertSettled(r, 1);
    }
    assert.equal(readCalls(s.path).length, 1, 'exactly one backend call');
  });
}

// Runner death, executor alive: the runner SIGKILLs itself at each of its crash points (the trigger rides
// launch.json into it); the executor settles the invocation on its own, then the caller retries once.
const RUNNER_EXPECT: Readonly<Record<string, Readonly<{ kind: 'result' } | { kind: 'lost'; treeEffects: boolean }>>> = {
  'runner.before-runner-json': { kind: 'lost', treeEffects: false },
  'runner.after-runner-json': { kind: 'lost', treeEffects: false },
  'runner.after-child-spawn': { kind: 'lost', treeEffects: true },
  'runner.child-exited-before-exit-json': { kind: 'lost', treeEffects: true },
  'runner.after-exit-json': { kind: 'result' },
};

const runnerCells = crashCells(RUNNER_DEATH);
test('matrix: runner death through invoke covers every runner crash point', () => {
  assert.deepEqual(runnerCells.map((c) => c.label).sort(), Object.keys(RUNNER_EXPECT).sort());
});

for (const { boundary, label } of runnerCells) {
  test(`runner-death.${boundary}.${label}`, T, async () => {
    const r = run();
    const s = scenario([
      { as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] },
      { as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] },
    ]);
    const d = backend(r, s);
    const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
    const exit = await runChild('invoke', d, trigger);
    assert.equal(exit.code, 0, exit.stderr);
    assertFired(trigger);
    const want = RUNNER_EXPECT[label]!;
    assert.equal(exit.stdout, `${want.kind}\n`);
    const [first] = spawnDones(r.runDir);
    assert.equal(first?.recoveredBy, null, 'the live executor settled it');
    if (want.kind === 'lost') {
      assert.deepEqual(first.outcome, want);
      // A live orphan was killed by its own proc.kill{recovery} before the invocation was classified.
      const kills = intents(r.runDir, 'proc.kill');
      assert.ok(kills.length <= 1);
      for (const k of kills) if (k.kind === 'proc.kill') assert.deepEqual(k.expect, { inv: invocationId(firstOp(r), 1), scope: 'invocation', reason: 'recovery' });
      assert.deepEqual(usageFacts(r.runDir).map((f) => (f.kind === 'usage-unavailable' ? f.reason : f.kind)), ['no-result']);
      await retryOnce(r, d);
      assertSettled(r, 2);
    } else {
      assertSettled(r, 1);
      assert.equal(readCalls(s.path).length, 1);
    }
  });
}
