// Crash tests of the M2 holders (src/resources/reserve.ts, src/recover/resource.ts), driven by pool-child.ts:
//   resource.retry-reclaim     a build's failed cleanup of an estate instance, then a retry's reclaim order
//                              (reclaim → teardown → cleaned disposition → release, F2), crashed at every
//                              occurrence of every label from the reservation through the disposition and
//                              release. At each crash a released instance is clean (never dirty), and an
//                              undisposed residue is the arc's own by A9 (`residue.own-arc-start`). After
//                              recovery and the park's next probe: free, every residue cleaned by a passing
//                              teardown of that instance, nothing open, recovery idempotent.
//   resource.publication-holder  publication{u1, 1} across candidate green, ff and snapshot: recovery keeps the
//                              slot exactly while the unit's decided next stage is ff or snapshot (A2), and
//                              releases it otherwise; nobody else ever holds it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Event, IntentOf, LogRecord } from '../src/core/events.ts';
import { prevHash, serializeEvent } from '../src/core/events.ts';
import {
  INTEGRATION_SLOT, arcId, invocationId, invocationIdOf, opId, poolInstance, resourceName, unitId,
} from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { ResidueKey } from '../src/core/records.ts';
import { Fold } from '../src/core/state.ts';
import { absPath } from '../src/core/values.ts';
import { ownArcResidue, readResidues, undispositioned } from '../src/host/residues.ts';
import { type PublicationHolder, entryOf, reserve } from '../src/resources/reserve.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { RESIDUE_ORDERING, RETRY_RECLAIM, crashCells } from './matrix.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { dones, events } from './fixtures/invoke-specs.ts';
import { ARC, chain } from './fixtures/log-records.ts';
import { ESTATE, newRun, openPoolRun } from './fixtures/pool-plan.ts';
import { type ResRun, tableOf, transitions } from './fixtures/res-plan.ts';

const CHILD_TIMEOUT_MS = 30_000;
const T = { timeout: 120_000 };
const INSTANCE = poolInstance(ESTATE, 1);

const child = (mode: string, r: ResRun, trigger: string | null, extra: readonly string[] = []) =>
  runFixture('pool-child.ts', [mode, JSON.stringify(r), ...extra], {
    env: trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

async function ok(mode: string, r: ResRun): Promise<string> {
  const exit = await child(mode, r, null);
  assert.equal(exit.code, 0, `${mode}: ${exit.stderr}`);
  return exit.stdout.trim();
}

const residueKeys = (r: ResRun): readonly ResidueKey[] => readResidues(absPath(r.hostDir)).flatMap((l) => (l.type === 'residue' ? [l.key] : []));

function transitionIntents(r: ResRun): readonly IntentOf<'resource.transition'>[] {
  return events(r.runDir).filter((e): e is Event & IntentOf<'resource.transition'> => e.type === 'intent' && e.kind === 'resource.transition');
}

// ---------------------------------------------------------------------------------------------------
// resource.retry-reclaim

/**
 * How often each label is reached in the retry scenario: six transitions (reserve, run, clean, fail, reclaim,
 * release), two teardowns (the build's, which fails; the retry's), one residue, one disposition.
 */
const RETRY_OCCURRENCES: Readonly<Record<string, number>> = {
  'resource.after-intent': 6,
  'resource.after-done': 6,
  'spawn.after-intent': 2,
  'launch.after-spawn': 2,
  'spawn.after-runner-exit': 2,
  'residue.before-host-append': 1,
  'residue.after-host-append': 1,
  'retry.before-disposition': 1,
  'retry.after-disposition': 1,
};

function prepareRetry(): ResRun {
  const r = newRun();
  openPoolRun(r).journal.close(); // creates the state dir and an empty log
  writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
  return r;
}

/** Invariants of a crashed (or finished) log, before recovery: F2 and A9. */
function assertCrashedState(r: ResRun): void {
  const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
  const host = absPath(r.hostDir);
  const open = undispositioned(host);
  const entry = entryOf(view.resources(), INSTANCE);
  // F2: a released instance is never dirty.
  if (entry.status.state === 'free' && entry.pending === null) {
    assert.deepEqual(open, [], `estate#1 is free while a residue is undisposed: ${JSON.stringify(open)}`);
  }
  // A9 (residue.own-arc-start): every undisposed residue of this arc is proven the arc's own by its log, so its start
  // or respawn is not refused; another arc's log never owns it.
  for (const key of open) {
    assert.equal(ownArcResidue(view, key), true, `residue ${JSON.stringify(key)} unproven with ${entry.status.state}`);
    assert.equal(ownArcResidue(new Fold(arcId('some-other-arc')), key), false);
  }
}

/** After recovery and the park's next probe: clean, disposed by a passing teardown of estate#1, nothing open. */
function assertReclaimed(r: ResRun): void {
  assert.deepEqual(Object.fromEntries(tableOf(r)), { [INSTANCE]: { state: 'free' } });
  const host = absPath(r.hostDir);
  assert.deepEqual(undispositioned(host), []);
  const lines = readResidues(host);
  const residues = lines.filter((l) => l.type === 'residue');
  assert.ok(residues.length <= 1, 'at most one residue: one failed teardown');
  const passedTeardowns = new Set(
    events(r.runDir)
      .filter((e): e is Event & IntentOf<'proc.spawn'> => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'teardown' && e.expect.subject.resource === INSTANCE)
      .map((i) => invocationId(i.op, i.ordinal)),
  );
  for (const d of lines.filter((l) => l.type === 'disposition')) {
    assert.ok(d.type === 'disposition' && d.disposition === 'cleaned');
    assert.ok(passedTeardowns.has(invocationIdOf(d.by.inv)), `disposed by ${d.by.inv}, a teardown of ${INSTANCE}`);
  }
  // The instance's last move is a release, and no holder but the build and the retry ever took it.
  const ts = transitions(r).filter((t) => t.resources.includes(INSTANCE));
  assert.equal(ts.at(-1)?.edge, 'release');
  const holders = new Set(ts.map((t) => t.holder));
  for (const h of holders) assert.ok(h === 'u1/build/1' || h.includes('"type":"retry"'), h);
  if (residues.length === 1) {
    // Failed, then reclaimed by the retry: fail before reclaim before the final release.
    const edges = ts.map((t) => t.edge);
    assert.ok(edges.indexOf('fail') < edges.indexOf('reclaim'), JSON.stringify(edges));
  }
}

describe('resource.retry-reclaim', { concurrency: 8 }, () => {
  it('crashes every label of its matrix row, and of the fail + residue row it passes through', () => {
    const cited = [...crashCells(RETRY_RECLAIM), ...crashCells(RESIDUE_ORDERING)].map((c) => c.label);
    assert.deepEqual([...new Set(cited)].sort(), Object.keys(RETRY_OCCURRENCES).sort());
  });

  it('the uncrashed scenario reaches each label exactly as counted and ends reclaimed', T, async () => {
    for (const [label, count] of Object.entries(RETRY_OCCURRENCES)) {
      const r = prepareRetry();
      const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: count + 1 });
      const exit = await child('retry', r, trigger);
      assert.equal(exit.code, 0, `${label}: ${exit.stderr}`);
      assert.equal(exit.stdout.trim(), 'pass');
      assertReclaimed(r);
    }
  });

  for (const [label, count] of Object.entries(RETRY_OCCURRENCES)) {
    for (let occurrence = 1; occurrence <= count; occurrence++) {
      it(`${label} #${occurrence}: a released instance is never dirty, an undisposed residue is the arc's own, and recovery then the next probe reclaim it`, T, async () => {
        const r = prepareRetry();
        const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence });
        const exit = await child('retry', r, trigger);
        assert.equal(exit.signal, 'SIGKILL', `the scenario did not crash at ${label} #${occurrence}: ${exit.stderr}`);
        assertFired(trigger);
        assertCrashedState(r);
        await ok('recover', r);
        assertCrashedState(r);
        // The park's next probe (after a restart the prober runs it again).
        assert.equal(await ok('reclaim', r), 'pass');
        assertReclaimed(r);
        // Recovery and the probe are idempotent.
        const before = events(r.runDir).length;
        await ok('recover', r);
        assert.equal(await ok('reclaim', r), 'pass');
        assert.equal(events(r.runDir).length, before, 'nothing left to do');
        // The open transition at an after-intent crash was closed by recovery.
        if (label === 'resource.after-intent') {
          const intent = transitionIntents(r)[occurrence - 1]!;
          assert.equal(dones(r.runDir, 'resource.transition').find((d) => d.op === intent.op)?.recoveredBy, 'reconciled');
        }
      });
    }
  }
});

describe('residue.own-arc-start', () => {
  const u1 = unitId('u1');
  const inv = invocationId(opId(ARC, 4), 1);
  const key: ResidueKey = { arc: ARC, unit: u1, inv, resource: INSTANCE };
  const holder = { type: 'stage', unit: u1, stage: 'build', attempt: 1 } as const;
  const failIntent = (seq: number): LogRecord => ({
    type: 'intent', op: opId(ARC, seq), ordinal: 1, kind: 'resource.transition', key: 'resources:u1/build/1', parent: { type: 'arc' }, deadlineAt: null,
    expect: { holder, resources: [INSTANCE], edge: { type: 'fail', residues: [{ resource: INSTANCE, teardown: inv }] } }, post: null,
  } as never);
  const folded = (records: readonly LogRecord[]): Fold => {
    const f = new Fold(ARC);
    for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    return f;
  };

  it('owned exactly by a fail intent of this arc, open or done, of the key\'s unit naming the key\'s instance and teardown', () => {
    assert.equal(ownArcResidue(folded([]), key), false, 'an empty log proves nothing');
    const open = folded([failIntent(1)]);
    assert.equal(ownArcResidue(open, key), true, 'the fail is still open: the residue may already be durable');
    assert.equal(ownArcResidue(open, { ...key, arc: arcId('other') }), false, 'another arc\'s residue always refuses');
    assert.equal(ownArcResidue(open, { ...key, unit: unitId('u2') }), false);
    assert.equal(ownArcResidue(open, { ...key, inv: invocationId(opId(ARC, 5), 1) }), false);
    assert.equal(ownArcResidue(open, { ...key, resource: resourceName('db') }), false);
    const aborted = folded([failIntent(1), { type: 'abort', op: opId(ARC, 1), reason: { code: 'precondition', detail: 'x' } } as never]);
    assert.equal(ownArcResidue(aborted, key), false, 'an aborted fail never happened');
  });
});

// ---------------------------------------------------------------------------------------------------
// resource.publication-holder

type DieAt = 'none' | 'green' | 'ff' | 'snapshot';
/** Resource labels in the uncrashed publication: reserve, run, clean, release. */
const PUBLICATION_OCCURRENCES = { 'resource.after-intent': 4, 'resource.after-done': 4 } as const;

/** Keeps the slot exactly while the decided next stage is ff or snapshot; never another holder. */
function assertPublication(r: ResRun, kept: boolean): void {
  const table = tableOf(r);
  const slot = table.get(INTEGRATION_SLOT);
  if (kept) {
    assert.ok(slot !== undefined && (slot.state === 'reserved' || slot.state === 'running'), JSON.stringify(slot));
    assert.deepEqual(slot.holder, { type: 'publication', unit: 'u1', attempt: 1 });
  } else {
    assert.deepEqual(slot, { state: 'free' });
  }
  for (const t of transitions(r)) assert.equal(t.holder, JSON.stringify({ type: 'publication', unit: 'u1', attempt: 1 }));
}

describe('resource.publication-holder', { concurrency: 8 }, () => {
  for (const [label, count] of Object.entries(PUBLICATION_OCCURRENCES)) {
    for (let occurrence = 1; occurrence <= count; occurrence++) {
      it(`${label} #${occurrence}: before green or after snapshot, recovery releases the slot`, T, async () => {
        const r = newRun();
        const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence });
        const exit = await child('publication', r, trigger, ['none']);
        assert.equal(exit.signal, 'SIGKILL', `${label} #${occurrence}: ${exit.stderr}`);
        assertFired(trigger);
        await ok('recover', r);
        // Occurrences 1-2 come before green; 3-4 (clean, release) after snapshot published.
        assertPublication(r, false);
        const before = events(r.runDir).length;
        await ok('recover', r);
        assert.equal(events(r.runDir).length, before, 'recovery is idempotent');
      });
    }
  }

  for (const dieAt of ['green', 'ff', 'snapshot'] as const satisfies readonly DieAt[]) {
    const kept = dieAt !== 'snapshot';
    it(`dies after ${dieAt}: recovery ${kept ? 'keeps the slot for the mandatory chain' : 'releases the slot'}`, T, async () => {
      const r = newRun();
      const exit = await child('publication', r, null, [dieAt]);
      assert.equal(exit.signal, 'SIGKILL', exit.stderr);
      await ok('recover', r);
      assertPublication(r, kept);
      const before = events(r.runDir).length;
      await ok('recover', r);
      assert.equal(events(r.runDir).length, before, 'recovery is idempotent');
      if (kept) {
        const { ctx, journal } = openPoolRun(r);
        const other: PublicationHolder = { type: 'publication', unit: unitId('u2'), attempt: 1 };
        assert.deepEqual(reserve(ctx, other, { named: [], pools: [], cpu: 0, publication: true }, { type: 'arc' }), { state: 'refused', busy: [INTEGRATION_SLOT] });
        journal.close();
      }
    });
  }

  it('the uncrashed publication ends released', T, async () => {
    const r = newRun();
    assert.deepEqual(JSON.parse(await ok('publication', r)), { kind: 'released', released: [INTEGRATION_SLOT] });
    assertPublication(r, false);
    for (const [label, count] of Object.entries(PUBLICATION_OCCURRENCES)) {
      const r2 = newRun();
      const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: count + 1 });
      const exit = await child('publication', r2, trigger, ['none']);
      assert.equal(exit.code, 0, `${label} is reached no more than ${count} times: ${exit.stderr}`);
    }
  });
});
