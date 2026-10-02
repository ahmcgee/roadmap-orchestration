// The park table's targets and the park schedule (src/park/{table,schedule}.ts), over the fold and a real
// journal: every retryable row has targets, the backoff, escalation (non-blocking, probing goes on), the
// repeat rule, the breaker and a multi-target park that outlives a restart.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Event, type Fact, type LogRecord, type OutcomeStage, type ProbeTarget, STAGE_OUTCOME_KINDS, prevHash, serializeEvent,
} from '../src/core/events.ts';
import { type UnitId, arcId, commandId, poolInstance, resourceName, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { Fold } from '../src/core/state.ts';
import { type AbsPath, type IsoTime, absPath, isoTime } from '../src/core/values.ts';
import { openBlocking, readNeedsUser } from '../src/needsuser.ts';
import { NO_PARK_FACTS, PARK_TARGETS, isRepeat, parkTargets, repeatNeedsUser, stageOutcomeFact, targetRule } from '../src/park/table.ts';
import {
  dueJobs, escalateAt, escalationsDue, nextProbeAt, raiseDue, retryableParks, trippedTargets, trips,
} from '../src/park/schedule.ts';
import { type StageOutcome, TABLE } from '../src/pipeline/transitions.ts';
import { PARK_ESCALATE_MS, PARK_REPEAT_MS } from '../src/schedule/types.ts';
import { tmpDir } from './helpers/repo.ts';
import { BUILD_CLEANUP_FAILED, LANES_BLOCKED, parkUnit, seedArc } from './fixtures/probe-common.ts';

const U1 = unitId('u1');
const U2 = unitId('u2');
const U3 = unitId('u3');
const HOST: ProbeTarget = { type: 'host' };
const DB: ProbeTarget = { type: 'resource', instance: resourceName('db') };
const ESTATE1: ProbeTarget = { type: 'resource', instance: poolInstance(resourceName('estate'), 1) };
const MINUTE = 60_000;

function newArc(units: readonly UnitId[] = [U1, U2, U3]) {
  const runDir: AbsPath = absPath(tmpDir('park-run'));
  const journal = openJournal(runDir, arcId(`park-${Math.random().toString(16).slice(2, 10)}`));
  seedArc(journal, units);
  return { runDir, journal };
}

/** A failed probe of `target` covering `covers`, written as the prober writes it at `now`. */
function fail(journal: ReturnType<typeof newArc>['journal'], target: ProbeTarget, covers: readonly number[], now: Date): IsoTime {
  const next = nextProbeAt(journal.view, target, covers, now);
  journal.fact({ kind: 'probe', target, covers, result: 'fail', nextProbeAt: next });
  return next;
}

const pass = (journal: ReturnType<typeof newArc>['journal'], target: ProbeTarget, covers: readonly number[]): number =>
  journal.fact({ kind: 'probe', target, covers, result: 'pass', nextProbeAt: null });

// ---------------------------------------------------------------------------------------------------

describe('park table', () => {
  it('park.table-total: exactly the rows that can decide a retryable park name targets, and each yields a sorted, non-empty set', () => {
    const facts = { backend: 'claude', failed: [poolInstance(resourceName('estate'), 1), resourceName('db')] } as const;
    let rows = 0;
    for (const stage of Object.keys(STAGE_OUTCOME_KINDS) as OutcomeStage[]) {
      for (const kind of STAGE_OUTCOME_KINDS[stage]) {
        const rule = (TABLE[stage] as Record<string, { do: string; park?: string; then?: { do: string; park?: string } }>)[kind]!;
        const retryable = ((rule.do === 'park' || rule.do === 'retry') && rule.park === 'retryable')
          || (rule.do === 'bounded' && rule.then?.do === 'park' && rule.then.park === 'retryable');
        const outcome = { stage, kind } as StageOutcome;
        assert.equal(targetRule(outcome) !== null, retryable, `${stage} ${kind}`);
        if (!retryable) continue;
        rows += 1;
        const targets = parkTargets(outcome, facts);
        assert.ok(targets.length > 0, `${stage} ${kind}`);
        const keys = targets.map((t) => JSON.stringify(t));
        assert.equal(new Set(keys).size, keys.length);
      }
    }
    assert.equal(rows, 13, 'plan-check/build/gate process-fault, build lost, five cleanup-failed, lanes, candidate and reproduce blocked, salvage commit-failed');
    assert.equal(Object.keys(PARK_TARGETS).length, 8);
  });

  it('names each row\'s targets: backend, host, one resource per failed instance, and host plus the teardown\'s instances for a salvage (G6)', () => {
    const estate = poolInstance(resourceName('estate'), 2);
    assert.deepEqual(parkTargets({ stage: 'gate', kind: 'process-fault' }, { backend: 'claude', failed: [] }), [{ type: 'backend', backend: 'claude' }]);
    assert.deepEqual(parkTargets({ stage: 'build', kind: 'lost' }, { backend: 'codex', failed: [] }), [{ type: 'backend', backend: 'codex' }]);
    assert.deepEqual(parkTargets({ stage: 'candidate', kind: 'blocked' }, NO_PARK_FACTS), [HOST]);
    assert.deepEqual(parkTargets({ stage: 'teardown', kind: 'cleanup-failed' }, { backend: null, failed: [estate, resourceName('db')] }), [DB, { type: 'resource', instance: estate }]);
    assert.deepEqual(parkTargets({ stage: 'salvage', kind: 'commit-failed' }, NO_PARK_FACTS), [HOST]);
    assert.deepEqual(parkTargets({ stage: 'salvage', kind: 'commit-failed' }, { backend: null, failed: [estate] }), [HOST, { type: 'resource', instance: estate }]);
    assert.throws(() => parkTargets({ stage: 'build', kind: 'process-fault' }, NO_PARK_FACTS), /needs its backend/);
    assert.throws(() => parkTargets({ stage: 'lanes', kind: 'cleanup-failed' }, NO_PARK_FACTS), /needs its failed instances/);
    assert.throws(() => parkTargets({ stage: 'salvage', kind: 'unmerged' }, NO_PARK_FACTS), /decides no retryable park/);
  });

  it('stageOutcomeFact writes the row\'s targets into a retryable park, and leaves every other outcome as outcomeFact has it', () => {
    const { journal } = newArc();
    const u = journal.view.unit(U1);
    const parked = stageOutcomeFact(u, { stage: 'candidate', kind: 'blocked' }, 1, NO_PARK_FACTS, new Date());
    assert.equal(parked.repeat, false);
    assert.deepEqual(parked.fact.park, { class: 'retryable', targets: [HOST] });
    const advance = stageOutcomeFact(u, { stage: 'candidate', kind: 'green' }, 1, NO_PARK_FACTS, new Date());
    assert.equal(advance.fact.park, undefined);
    // The first blocked lane is the stage's uncharged retry, not a park: no targets are asked for.
    assert.equal(stageOutcomeFact(u, { stage: 'lanes', kind: 'blocked' }, 1, NO_PARK_FACTS, new Date()).fact.class, 'retry');
    journal.fact(parked.fact);
    assert.deepEqual(journal.view.unit(U1).park?.park, { class: 'retryable', targets: [HOST] });
  });

  it('park.repeat: parking again on a target recovered on less than 6 h ago parks operator env-blocked; resume re-runs it', () => {
    const { journal } = newArc();
    const p1 = journal.fact(stageOutcomeFact(journal.view.unit(U1), { stage: 'candidate', kind: 'blocked' }, 1, NO_PARK_FACTS, new Date()).fact);
    pass(journal, HOST, [p1]);
    const recovered = journal.view.unit(U1);
    assert.equal(recovered.status, 'active');
    assert.deepEqual(recovered.lastRecovery?.targets, [HOST]);
    const at = Date.parse(recovered.lastRecovery!.at);

    assert.equal(isRepeat(recovered, [HOST], new Date(at + PARK_REPEAT_MS - MINUTE)), true);
    assert.equal(isRepeat(recovered, [HOST], new Date(at + PARK_REPEAT_MS)), false, 'after 6 h it is a fresh park');
    assert.equal(isRepeat(recovered, [DB], new Date(at + MINUTE)), false, 'another target is a fresh park');
    assert.equal(isRepeat(journal.view.unit(U2), [HOST], new Date(at + MINUTE)), false, 'another unit is a fresh park');

    const again = stageOutcomeFact(recovered, { stage: 'candidate', kind: 'blocked' }, 2, NO_PARK_FACTS, new Date(at + MINUTE));
    assert.equal(again.repeat, true);
    assert.deepEqual(again.fact.park, { class: 'operator', kind: 'env' });
    const item = repeatNeedsUser(recovered, again.fact, { reason: 'lane-blocked', summary: 'Unit u1: the candidate suite was blocked.' });
    assert.equal(item.reason, 'env-blocked');
    assert.match(item.summary, /^Unit u1: the candidate suite was blocked\. .*roadmap resume u1/);
    journal.fact(again.fact);
    const u = journal.view.unit(U1);
    assert.equal(u.status, 'park-pending');
    assert.deepEqual(retryableParks(journal.view), [], 'a repeat park is never probed');
    assert.deepEqual(dueJobs(journal.view, new Date(at + PARK_ESCALATE_MS)), []);
    journal.fact({ kind: 'unparked', unit: U1, command: commandId('cmd-0123456789abcdef') });
    assert.equal(journal.view.unit(U1).status, 'active', 'resume <unit> re-runs the stage');
  });
});

describe('park schedule', () => {
  it('a cut unit keeps its park in the fold, but is never probed, escalated or counted by the breaker', () => {
    const { journal } = newArc();
    parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    parkUnit(journal, U2, LANES_BLOCKED, 1, [HOST]);
    journal.fact({
      kind: 'plan-applied', rev: 2, command: commandId('cmd-0000000000000002'), planSha256: 'd'.repeat(64),
      specs: { u2: 'd'.repeat(64), u3: 'd'.repeat(64) }, changes: [{ type: 'unit-cut', unit: U1 }],
    } as unknown as Fact);
    assert.equal(journal.view.unit(U1).status, 'cut');
    assert.deepEqual(retryableParks(journal.view).map((p) => p.unit.unit), [U2]);
    assert.deepEqual(dueJobs(journal.view, new Date()).map((j) => j.covers.length), [1]);
    assert.deepEqual(trippedTargets(journal.view), []);
    assert.deepEqual(escalationsDue(journal.view, new Date(Date.now() + PARK_ESCALATE_MS)).map((i) => i.parent.unit), [U2]);
    journal.close();
  });

  it('park.backoff: the first probe runs at once, then 1, 2, 4, 8, 16, 30, 30 minutes; each fact carries nextProbeAt', () => {
    const { journal, runDir } = newArc();
    const p = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    assert.deepEqual(dueJobs(journal.view, new Date()), [{ target: HOST, covers: [p] }], 'due at once');
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const now = new Date();
      const next = fail(journal, HOST, [p], now);
      waits.push(Math.round((Date.parse(next) - now.getTime()) / MINUTE));
      assert.deepEqual(dueJobs(journal.view, new Date(Date.parse(next) - 1000)), [], 'not due before nextProbeAt');
      assert.equal(dueJobs(journal.view, new Date(next)).length, 1, 'due at nextProbeAt');
    }
    assert.deepEqual(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
    const probe = journal.view.probes()[0]!;
    assert.equal(probe.result, 'fail');
    assert.ok(probe.nextProbeAt !== null);

    // The backoff is read back from the log: a restart continues it.
    journal.close();
    const reopened = openJournal(runDir, journal.view.arc);
    const now = new Date();
    assert.equal(Math.round((Date.parse(nextProbeAt(reopened.view, HOST, [p], now)) - now.getTime()) / MINUTE), 30);

    // A park the failing streak did not cover starts over: probed at once, then after 1 minute.
    const q = parkUnit(reopened, U2, LANES_BLOCKED, 1, [HOST]);
    assert.deepEqual(dueJobs(reopened.view, new Date()), [{ target: HOST, covers: [p, q] }], 'a new park is probed at once');
    pass(reopened, HOST, [p, q]);
    const r = parkUnit(reopened, U3, LANES_BLOCKED, 1, [HOST]);
    const later = new Date();
    assert.equal(Math.round((Date.parse(fail(reopened, HOST, [r], later)) - later.getTime()) / MINUTE), 1, 'after a pass the streak starts over');
    reopened.close();
  });

  it('park.escalate-nonblocking: at 6 h one non-blocking park-escalated item per park; probing goes on at the cap', () => {
    const { journal, runDir } = newArc();
    const p = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    const park = journal.view.unit(U1).park!;
    const at6h = escalateAt(park);
    assert.equal(at6h.getTime() - Date.parse(park.at), PARK_ESCALATE_MS);
    assert.deepEqual(escalationsDue(journal.view, new Date(at6h.getTime() - 1)), []);
    const [item, ...rest] = escalationsDue(journal.view, at6h);
    assert.deepEqual(rest, []);
    assert.equal(item?.content.blocking, false);
    assert.equal(item?.content.reason, 'park-escalated');
    assert.deepEqual(item?.parent, { type: 'stage', unit: U1, stage: 'lanes', attempt: 1 });

    const raised = raiseDue(journal, runDir, at6h);
    assert.equal(raised.length, 1);
    assert.equal(readNeedsUser(runDir, raised[0]!)?.reason, 'park-escalated');
    assert.deepEqual(openBlocking(journal.view), [], 'the item blocks nothing');
    assert.deepEqual(raiseDue(journal, runDir, new Date(at6h.getTime() + 60 * MINUTE)), [], 'raised once');

    // Probing continues: still parked, and due again once the capped wait has passed.
    const next = fail(journal, HOST, [p], at6h);
    assert.equal(journal.view.unit(U1).status, 'park-pending');
    assert.equal(dueJobs(journal.view, new Date(next)).length, 1);
    journal.close();
  });

  it('park.breaker: two units parked on one target within an hour trip it (derived) and raise one env-blocked item; a pass clears it', () => {
    const { journal, runDir } = newArc();
    const p1 = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    assert.deepEqual(trippedTargets(journal.view), [], 'one unit trips nothing');
    const p2 = parkUnit(journal, U2, LANES_BLOCKED, 1, [HOST]);
    assert.deepEqual(trips(journal.view).map((t) => [t.target, t.units]), [[HOST, [U1, U2]]]);
    assert.deepEqual(trippedTargets(journal.view), [HOST]);

    const now = new Date();
    const raised = raiseDue(journal, runDir, now);
    assert.equal(raised.length, 1);
    const record = readNeedsUser(runDir, raised[0]!);
    assert.deepEqual([record?.reason, record?.blocking], ['env-blocked', false]);
    const p3 = parkUnit(journal, U3, LANES_BLOCKED, 1, [HOST]);
    assert.deepEqual(raiseDue(journal, runDir, now), [], 'one item per trip, however many units join it');

    pass(journal, HOST, [p1, p2, p3]);
    assert.deepEqual(trippedTargets(journal.view), [], 'the parks recovered, the breaker is clear');
    journal.close();
  });

  it('park.breaker window: parks more than an hour apart do not trip; a third within an hour of the second does', () => {
    const t0 = Date.parse('2026-09-30T08:00:00.000Z');
    const at = (ms: number): IsoTime => isoTime(new Date(t0 + ms).toISOString());
    const records: [LogRecord, IsoTime][] = [
      [factRecord({ kind: 'plan-applied', rev: 1, command: null, planSha256: 'd'.repeat(64), specs: { u1: 'd'.repeat(64), u2: 'd'.repeat(64), u3: 'd'.repeat(64) }, changes: [], scheduling: 'dag' }), at(0)],
      [parkRecord(U1), at(0)],
      [parkRecord(U2), at(61 * MINUTE)],
    ];
    assert.deepEqual(trippedTargets(foldAt(records)), []);
    assert.deepEqual(trippedTargets(foldAt([...records, [parkRecord(U3), at(120 * MINUTE)]])), [HOST]);
  });

  it('park.multi-target: the first instance passes, a restart, the second fails on: the park stays, only the second is probed, and it escalates at 6 h', () => {
    const { journal, runDir } = newArc();
    const p = parkUnit(journal, U1, BUILD_CLEANUP_FAILED, 1, [DB, ESTATE1]);
    assert.deepEqual(dueJobs(journal.view, new Date()).map((j) => j.target), [DB, ESTATE1]);
    pass(journal, DB, [p]);
    journal.close();
    // The crash: a new process reads the same log.
    const reopened = openJournal(runDir, journal.view.arc);
    assert.deepEqual(reopened.view.unit(U1).park?.passed, [DB]);
    assert.deepEqual(dueJobs(reopened.view, new Date()), [{ target: ESTATE1, covers: [p] }], 'only the outstanding target');
    let now = new Date();
    for (let i = 0; i < 3; i++) now = new Date(fail(reopened, ESTATE1, [p], now));
    assert.equal(reopened.view.unit(U1).status, 'park-pending');
    const [item] = escalationsDue(reopened.view, escalateAt(reopened.view.unit(U1).park!));
    assert.match(item?.content.summary ?? '', /resource:estate#1/);
    assert.doesNotMatch(item?.content.summary ?? '', /resource:db/, 'the escalation names the outstanding target only');
    reopened.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// Helpers

function factRecord(f: object): LogRecord {
  return { type: 'fact', fact: f as Fact };
}

function parkRecord(unit: UnitId): LogRecord {
  return factRecord({ kind: 'stage-outcome', unit, stage: 'lanes', attempt: 1, outcome: 'blocked', class: 'park', chargeable: false, park: { class: 'retryable', targets: [HOST] } });
}

/** A fold over `records`, each event written at its own time. */
function foldAt(records: readonly (readonly [LogRecord, IsoTime])[]): Fold {
  const arc = arcId('arc-1');
  const fold = new Fold(arc);
  let prev: Event | null = null;
  for (const [i, [record, at]] of records.entries()) {
    const event = { v: 1, seq: i + 1, prev: prev === null ? null : prevHash(Buffer.from(serializeEvent(prev))), at, arc, ...record } as Event;
    fold.apply(event, prevHash(Buffer.from(serializeEvent(event))));
    prev = event;
  }
  return fold;
}
