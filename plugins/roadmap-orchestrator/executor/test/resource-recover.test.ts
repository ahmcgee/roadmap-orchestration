// Recovery of the reservation cycle (src/recover/resource.ts): the resource.transition reserve/run/clean/
// release row of the crash matrix, driven by res-child.ts killed at each crashPoint occurrence, then
// recovered by the resources phase alone. The oracle is the recovery table's row: a dead holder's set is
// cleaned, its teardowns rerun, and it ends free, or cleanup-failed for a resource whose teardown fails;
// never two holders, never a release after a failed cleanup, nothing left open.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Event, IntentOf } from '../src/core/events.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { dones, events } from './fixtures/invoke-specs.ts';
import { DB, QUEUE, type ResRun, calls, newRun, tableOf, transitions } from './fixtures/res-plan.ts';
import { RESERVE_CYCLE, RESIDUE_ORDERING, crashCells } from './matrix.ts';

const CHILD_TIMEOUT_MS = 30_000;
const T = { timeout: 90_000 };

type Scenario = 'cycle' | 'fail';

/** How often each label is reached in each scenario: 4 or 5 transitions; 2 probes, 1 lane, 2 teardowns. */
const OCCURRENCES: Readonly<Record<Scenario, Readonly<Record<string, number>>>> = {
  cycle: { 'resource.after-intent': 4, 'resource.after-done': 4, 'spawn.after-intent': 5, 'launch.after-spawn': 5, 'spawn.after-runner-exit': 5 },
  fail: { 'resource.after-intent': 5, 'resource.after-done': 5, 'spawn.after-intent': 5, 'launch.after-spawn': 5, 'spawn.after-runner-exit': 5 },
};

function prepare(scenario: Scenario): ResRun {
  const r = newRun();
  if (scenario === 'fail') writeFileSync(join(r.stateDir, `${QUEUE}.teardown-fails`), '');
  return r;
}

const child = (mode: 'cycle' | 'recover', r: ResRun, trigger: string | null) =>
  runFixture('res-child.ts', [mode, JSON.stringify(r)], {
    env: trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

/** Crash the cycle at (label, occurrence); returns the run and whether the label was reached. */
async function crash(scenario: Scenario, label: string, occurrence: number): Promise<ResRun> {
  const r = prepare(scenario);
  const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence });
  const exit = await child('cycle', r, trigger);
  assert.equal(exit.signal, 'SIGKILL', `the cycle did not crash at ${label} #${occurrence}: ${exit.stderr}`);
  assertFired(trigger);
  return r;
}

async function recover(r: ResRun): Promise<void> {
  const exit = await child('recover', r, null);
  assert.equal(exit.code, 0, exit.stderr);
}

/** The recovery table's oracle for a finished run. */
function assertRecovered(r: ResRun, scenario: Scenario): void {
  // Derived after recovery (tableOf also asserts no intent is left open, spawns included).
  const table = tableOf(r);
  assert.deepEqual(Object.fromEntries(table), scenario === 'cycle'
    ? { [DB]: { state: 'free' }, [QUEUE]: { state: 'free' } }
    : { [DB]: { state: 'free' }, [QUEUE]: { state: 'cleanup-failed', holder: { type: 'stage', unit: 'u1', stage: 'build', attempt: 1 } } });
  const ts = transitions(r);
  assert.ok(ts.every((t) => t.holder === 'u1/build/1'), 'one holder only: recovery never takes a second one');
  // Never a release after a failed cleanup: nothing names a resource after its fail.
  const failAt = ts.findIndex((t) => t.edge === 'fail');
  if (scenario === 'fail') {
    assert.ok(failAt !== -1);
    assert.deepEqual(ts[failAt]!.resources, [QUEUE]);
    assert.ok(ts.slice(failAt + 1).every((t) => !t.resources.includes(QUEUE)), JSON.stringify(ts));
    const host = absPath(r.hostDir);
    assert.deepEqual(undispositioned(host).map((k) => k.resource), [QUEUE], 'exactly one residue, for queue');
    assert.equal(readResidues(host).length, 1);
  } else {
    assert.equal(failAt, -1);
  }
  // Every resource was torn down after its last probe: a dead holder's leftovers are always cleaned.
  for (const res of [DB, QUEUE]) {
    const mine = calls(r).filter((c) => c.split(' ')[1] === res);
    assert.ok(mine.length > 0 && mine.at(-1)!.startsWith('teardown '), `${res}: ${JSON.stringify(mine)}`);
  }
  // Recovery's own transitions belong to no stage.
  const log = events(r.runDir);
  const recovered = dones(r.runDir, 'resource.transition').filter((d) => d.recoveredBy !== null);
  for (const d of recovered) assert.equal(d.recoveredBy, 'reconciled');
  void log;
}

function transitionIntents(r: ResRun): readonly IntentOf<'resource.transition'>[] {
  return events(r.runDir).filter((e): e is Event & IntentOf<'resource.transition'> => e.type === 'intent' && e.kind === 'resource.transition');
}

describe('crash matrix: resource.transition reserve/run/clean/release', { concurrency: 8 }, () => {
  it('covers exactly the row\'s crash labels', () => {
    for (const scenario of ['cycle', 'fail'] as const) {
      assert.deepEqual(crashCells(RESERVE_CYCLE).map((c) => c.label).sort(), Object.keys(OCCURRENCES[scenario]).sort());
    }
  });

  for (const scenario of ['cycle', 'fail'] as const) {
    for (const cell of crashCells(RESERVE_CYCLE)) {
      const count = OCCURRENCES[scenario][cell.label]!;
      for (let occurrence = 1; occurrence <= count; occurrence++) {
        it(`${scenario} ${cell.boundary} ${cell.label} #${occurrence}: ${cell.recovery}`, T, async () => {
          const r = await crash(scenario, cell.label, occurrence);
          await recover(r);
          assertRecovered(r, scenario);
          if (cell.label === 'resource.after-intent') {
            // The transition open at the crash was closed as it stood, by recovery.
            const open = transitionIntents(r)[occurrence - 1]!;
            const done = dones(r.runDir, 'resource.transition').find((d) => d.op === open.op);
            assert.equal(done?.recoveredBy, 'reconciled');
          }
          // A second recovery finds nothing to do.
          const before = events(r.runDir).length;
          await recover(r);
          assert.equal(events(r.runDir).length, before, 'recovery is idempotent');
        });
      }
      it(`${scenario} ${cell.label} is reached no more than ${count} times`, T, async () => {
        const r = prepare(scenario);
        const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence: count + 1 });
        const exit = await child('cycle', r, trigger);
        assert.equal(exit.code, 0, exit.stderr);
        assertRecovered(r, scenario);
      });
    }
  }
});

describe('res.failed-cleanup-residue-first-never-released', { concurrency: 4 }, () => {
  // Step 7's crash cells, reached through the cycle: residues durable (or not yet), local done not written.
  for (const { label } of crashCells(RESIDUE_ORDERING)) {
    it(`${label}: recovery appends each missing residue once, closes the fail, and never releases queue`, T, async () => {
      const r = await crash('fail', label, 1);
      const failIntent = transitionIntents(r).find((i) => i.expect.edge.type === 'fail');
      assert.ok(failIntent !== undefined, 'the fail intent is durable before any residue');
      assert.ok(!transitionIntents(r).some((i) => i.expect.edge.type === 'release'), 'nothing released before the fail is done');
      await recover(r);
      assertRecovered(r, 'fail');
      const done = dones(r.runDir, 'resource.transition').find((d) => d.op === failIntent.op);
      assert.equal(done?.recoveredBy, 'reconciled');
    });
  }

  it('B5: the fail done is written, the crash comes before the release of the clean subset; queue is never released', T, async () => {
    // Occurrences of resource.after-done in the fail scenario: reserve, run, clean, fail (4th), release.
    const r = await crash('fail', 'resource.after-done', 4);
    assert.deepEqual(transitions(r).map((t) => t.edge), ['reserve', 'run', 'clean', 'fail']);
    await recover(r);
    assertRecovered(r, 'fail');
    // Recovery tore down db again (it was still cleaning) and released it alone.
    assert.deepEqual(transitions(r).slice(4).map((t) => `${t.edge} ${t.resources.join(',')}`), ['release db']);
  });
});
