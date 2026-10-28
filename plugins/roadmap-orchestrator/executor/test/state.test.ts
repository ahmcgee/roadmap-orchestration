// Pure-module tests of the fold (src/core/state.ts): what it derives and every invariant it refuses.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Event, type IntentOf, type IntentRecord, type LogRecord, type Parent, type StageOutcomeFact, OP_KINDS, prevHash, serializeEvent } from '../src/core/events.ts';
import { CounterRegressionError, canonicalJson } from '../src/core/fsx.ts';
import { type UnitId, arcId, commandId, invocationId, jobId, journeyIdOf, laneId, milestoneIdOf, needsUserId, opId, opKey, planRev, polishIdOf, sha, seatRev, sha256, specRev, unitId } from '../src/core/ids.ts';
import { DEFAULT_BOUNDS, type Stage } from '../src/core/records.ts';
import { type CounterRefs, Fold, FoldInvariantError, type MeterTotal, fold, monotonicSince, newUnitState } from '../src/core/state.ts';
import { absPath, isoTime, refName, repoPattern } from '../src/core/values.ts';
import { DEV17_UNIT_ROLES, UNIT_ROLES, type RiskTier } from '../src/routing/types.ts';
import {
  ARC, AT, H, REV, U1, appliedFields, chain, commandIntent, inv1, meter, needsUserIntent, snapshotIntent, spawnIntent, spawnLost, spawnResult, stageParent,
} from './fixtures/log-records.ts';

const op = (seq: number) => opId(ARC, seq);

type OutcomeFields = Readonly<{ stage: Stage; attempt: number; outcome: string; class: string; chargeable?: boolean; unit?: UnitId }>;
/** A stage-outcome fact record; `chain()` hands it to the fold without parsing, so the fields are as given. */
const stageOutcome = (f: OutcomeFields): LogRecord =>
  ({ type: 'fact', fact: { kind: 'stage-outcome', unit: f.unit ?? U1, stage: f.stage, attempt: f.attempt, outcome: f.outcome, class: f.class, chargeable: f.chargeable ?? false } }) as LogRecord;
const dispatch = (riskFloor: RiskTier, scope = 'src/**'): LogRecord =>
  ({ type: 'fact', fact: { kind: 'dispatch', record: { unit: U1, specRev: specRev(1), specSha256: H, scope: [repoPattern(scope)], riskFloor, routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: AT, transientRules: 'm3' } } });

function refuses(events: readonly Event[], seq: number, detail: RegExp): void {
  assert.throws(() => fold(ARC, events), (err: unknown) => {
    assert.ok(err instanceof FoldInvariantError, `expected FoldInvariantError, got ${String(err)}`);
    assert.equal(err.seq, seq);
    assert.match(err.detail, detail);
    return true;
  });
}

describe('fold derives', () => {
  it('open intents, units, meter, needs-user, snapshot high-water, last seq', () => {
    const state = fold(ARC, chain([
      spawnIntent(1, { stage: 'plan-check', role: 'planCheck' }), // 1
      meter(inv1(1), 'planCheck', 100, 10, 5), // 2
      spawnResult(op(1)), // 3
      spawnIntent(4), // 4 build attempt 1
      { type: 'fact', fact: { kind: 'usage-unavailable', inv: inv1(4), routingRev: REV, subject: { type: 'seat', role: 'build', tier: 'med', unit: U1, attempt: 1 }, reason: 'no-result' } }, // 5
      spawnLost(op(4)), // 6
      spawnIntent(4, { ordinal: 2 }), // 7 retry, same stage attempt
      meter(inv1(4, 2), 'build', 1000, 200, null), // 8 (the retry stays open)
      needsUserIntent(9), // 9
      { type: 'done', op: op(9), kind: 'needsuser.raise', outcome: { kind: 'raised' }, recoveredBy: null }, // 10
      snapshotIntent(11, 10), // 11
      { type: 'done', op: op(11), kind: 'snapshot.publish', outcome: { kind: 'published' }, recoveredBy: null }, // 12
      spawnIntent(13, { attempt: 2 }), // 13 build attempt 2, left open
    ]));
    assert.equal(state.lastSeq, 13);
    assert.equal(state.snapshotHighWater, 10);
    assert.deepEqual(state.openIntents.map((i) => i.op), [op(4), op(13)]);
    // Stage starts: plan-check#1, build#1, build#2. The retry at seq 7 is not a new start.
    const u1 = newUnitState(U1, 'build', null);
    assert.deepEqual(state.units, [{ ...u1, counters: { ...u1.counters, attempts: 3 }, open: { stage: 'build', attempt: 2, seq: 13 } }], 'build#2 has no outcome: open (first started at seq 13)');
    assert.deepEqual(state.needsUser, ['nu-9']);
    assert.deepEqual(state.meter, [
      { charge: { type: 'role', role: 'build' }, routingRev: REV, known: 1, unavailable: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, costUsd: 0 },
      { charge: { type: 'role', role: 'planCheck' }, routingRev: REV, known: 1, unavailable: 0, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, turns: 0, costUsd: 0 },
    ]);
    assert.deepEqual(state.tailDiscarded, []);
  });

  it('state.stage-outcome-derives-counters: counters, seats and status from stage-outcome facts', () => {
    const state = fold(ARC, chain([
      dispatch('low'), // 1
      spawnIntent(2, { stage: 'plan-check', role: 'planCheck' }), // 2 plan-check#1 starts
      spawnResult(op(2)), // 3
      stageOutcome({ stage: 'plan-check', attempt: 1, outcome: 'redirect', class: 'redirect' }), // 4
      stageOutcome({ stage: 'plan-check', attempt: 2, outcome: 'refusal', class: 'route-up' }), // 5 a start with no intent
      stageOutcome({ stage: 'plan-check', attempt: 3, outcome: 'approve', class: 'advance' }), // 6
      dispatch('med'), // 7 the plan-check raised the risk: re-pinned
      stageOutcome({ stage: 'build', attempt: 1, outcome: 'malformed', class: 'retry' }), // 8
      stageOutcome({ stage: 'build', attempt: 2, outcome: 'success', class: 'advance' }), // 9
      stageOutcome({ stage: 'salvage', attempt: 1, outcome: 'committed-contract-touched', class: 'trigger' }), // 10
      stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true }), // 11
    ]));
    assert.deepEqual(state.units, [{
      unit: U1, stage: 'lanes', risk: 'med', status: 'active', routedUp: ['plan-check'], promotion: true, approval: null, open: null, interrupted: null,
      pressureHold: null, pressureHolds: 0, spec: { rev: 1, sha256: H }, reopened: null, pendingRevision: null, staleRev: null, redirectBase: 0,
      park: null, lastRecovery: null, buildTier: 'med', lineage: null, supersededBy: null, bounds: DEFAULT_BOUNDS, entry: null, steering: null, scopeDecisions: [], pocs: 0,
      // The charged lanes red is the unit's one failure outcome (arc feedback 2026-10-16: what a re-entry's `fixes` names).
      failures: [{
        seq: 11, fact: { kind: 'stage-outcome', unit: U1, stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true }, park: null,
      }],
      decided: { kind: 'stage-outcome', unit: U1, stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true },
      counters: {
        attempts: 7, chargeableFailures: 1, redirects: 1, reviseRounds: 0, candidateReds: 0, smokeRounds: 0,
        retries: { 'plan-check': 0, build: 1, lanes: 0, gate: 0 },
      },
    }]);

    // Two more chargeable failures: the third bounds the unit, which the log records as a park.
    const bounded = fold(ARC, chain([
      stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true }),
      stageOutcome({ stage: 'gate', attempt: 1, outcome: 'revise', class: 'revise', chargeable: true }),
      stageOutcome({ stage: 'gate', attempt: 2, outcome: 'revise', class: 'park', chargeable: true }),
    ]));
    const u = bounded.units[0]!;
    assert.equal(u.status, 'park-pending');
    assert.equal(u.counters.chargeableFailures, 3);
    assert.equal(u.counters.reviseRounds, 1);
    assert.equal(u.risk, null, 'no dispatch fact in this log');

    // A judgment decision spends a pending promotion; a retry of the same judgment does not.
    const spent = fold(ARC, chain([
      stageOutcome({ stage: 'salvage', attempt: 1, outcome: 'committed-contract-touched', class: 'trigger' }),
      stageOutcome({ stage: 'gate', attempt: 1, outcome: 'malformed', class: 'retry' }),
    ]));
    assert.equal(spent.units[0]!.promotion, true);
    const decided = fold(ARC, chain([
      stageOutcome({ stage: 'salvage', attempt: 1, outcome: 'committed-contract-touched', class: 'trigger' }),
      stageOutcome({ stage: 'gate', attempt: 1, outcome: 'approve', class: 'advance' }),
    ]));
    assert.equal(decided.units[0]!.promotion, false);
  });

  it('keeps open intents in log order, a retry moving to its own position', () => {
    const state = fold(ARC, chain([spawnIntent(1), spawnIntent(2), spawnLost(op(1)), spawnIntent(1, { ordinal: 2 })]));
    assert.deepEqual(state.openIntents.map((i) => `${i.op}#${i.ordinal}`), [`${op(2)}#1`, `${op(1)}#2`]);
  });

  it('an empty log', () => {
    assert.deepEqual(fold(ARC, []), {
      v: 1, arc: ARC, plan: null, lastSeq: 0, snapshotHighWater: 0, openIntents: [], units: [], meter: [], needsUser: [], needsUserBlocking: [], needsUserAcked: [],
      control: { stop: null, pausedAll: false, pausedUnits: [] }, containmentMode: null, tailDiscarded: [], parkedBackends: [],
      backendParks: [], resources: [], runOnly: null, resolvedEdges: [],
      holistic: {
        on: false, witnessed: [], latched: [], findings: [], audits: [], auditRequests: [], docsCovered: [], docsPublished: [], checkpoints: [], checkpointSkips: [], divergences: [],
        digests: [], steered: [], mergedIn: [], debt: [], amendments: [], packReviews: [], draining: null, completion: null, laneReuses: [], certificates: [], smokeRuns: [], corroborations: [],
      },
    });
  });

  it('the view: latestIntent and doneOf', () => {
    const f = new Fold(ARC);
    for (const e of chain([spawnIntent(1), spawnLost(op(1)), spawnIntent(1, { ordinal: 2 })])) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    assert.equal(f.latestIntent(op(1)).ordinal, 2);
    assert.equal(f.doneOf(op(1)), null, 'ordinal 2 is open');
    assert.throws(() => f.latestIntent(op(9)), /no intent for op arc-1\/9/);
  });
});

describe('fold invariants', () => {
  it('contiguous seq', () => {
    const events = chain([commandIntent(1), commandIntent(2, 'other')]);
    refuses([events[0]!, { ...events[1]!, seq: 3 }], 3, /seq not contiguous: expected 2/);
  });

  it('chain intact', () => {
    const events = chain([commandIntent(1), commandIntent(2, 'other')]);
    refuses([events[0]!, { ...events[1]!, prev: H }], 2, /chain broken/);
    refuses([{ ...events[0]!, arc: arcId('arc-2') }], 1, /arc arc-2 in the log of arc arc-1/);
  });

  it('at most one open intent per key', () => {
    refuses(chain([commandIntent(1, 'k'), commandIntent(2, 'k')]), 2, /key k already has open intent arc-1\/1/);
    // Once closed, the key is free again.
    fold(ARC, chain([commandIntent(1, 'k'), { type: 'abort', op: op(1), reason: { code: 'precondition', detail: 'x' } }, commandIntent(3, 'k')]));
  });

  it('an op is named after its first intent', () => {
    refuses(chain([commandIntent(1), commandIntent(1, 'other')]), 2, /already has an intent/);
    refuses(chain([commandIntent(5)]), 1, /must be named after its first intent's seq 1/);
  });

  it('done and abort match an open intent of the same op and kind', () => {
    refuses(chain([spawnResult(op(1))]), 1, /done of unknown op/);
    refuses(chain([commandIntent(1), spawnResult(op(1))]), 2, /done of kind proc.spawn for arc-1\/1, an intent of kind command.apply/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), spawnResult(op(1))]), 3, /already closed by done result/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), { type: 'abort', op: op(1), reason: { code: 'recovery', detail: 'x' } }]), 3, /abort of arc-1\/1/);
  });

  it('ordinal strictly increasing per op, retries only after lost or abort', () => {
    refuses(chain([spawnIntent(1), spawnLost(op(1)), spawnIntent(1, { ordinal: 3 })]), 3, /ordinal 3 of arc-1\/1 does not follow 1/);
    refuses(chain([spawnIntent(2, { ordinal: 2 })]), 1, /retry ordinal 2 of unknown op/);
    refuses(chain([spawnIntent(1), spawnIntent(1, { ordinal: 2 })]), 2, /while ordinal 1 is open/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), spawnIntent(1, { ordinal: 2 })]), 3, /after done result/);
    fold(ARC, chain([spawnIntent(1), { type: 'abort', op: op(1), reason: { code: 'recovery', detail: 'x' } }, spawnIntent(1, { ordinal: 2 })]));
  });

  it('retries inherit key, parent and deadlineAt', () => {
    const lost = [spawnIntent(1), spawnLost(op(1))];
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, deadlineAt: isoTime('2026-09-25T14:00:00.000Z') })]), 3, /changes deadlineAt/);
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, deadlineAt: null })]), 3, /changes deadlineAt/);
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, key: 'elsewhere' })]), 3, /changes key/);
    refuses(chain([...lost, { ...spawnIntent(1, { ordinal: 2 }), parent: stageParent('gate', 1) } as LogRecord]), 3, /changes its parent/);
    refuses(chain([...lost, { ...commandIntent(1, 'spawn:1'), ordinal: 2 } as LogRecord]), 3, /changes kind proc.spawn to command.apply/);
  });

  it('one usage fact per invocation, for an invocation some intent opened', () => {
    refuses(chain([spawnIntent(1), meter(inv1(1), 'build', 1, 1, null), meter(inv1(1), 'build', 1, 1, null)]), 3, /second usage fact for arc-1\/1#1/);
    refuses(chain([spawnIntent(1), meter(inv1(1, 2), 'build', 1, 1, null)]), 2, /which no intent opened/);
    refuses(chain([meter(inv1(7), 'build', 1, 1, null)]), 1, /which no intent opened/);
  });

  it('state.stage-outcome-duplicate-refused: one stage-outcome per (unit, stage, attempt)', () => {
    const first = stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'green', class: 'advance' });
    refuses(chain([first, stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true })]), 2, /second stage-outcome for u1 lanes#1/);
    // Other attempts, stages and units are distinct keys.
    fold(ARC, chain([
      first,
      stageOutcome({ stage: 'lanes', attempt: 2, outcome: 'green', class: 'advance' }),
      stageOutcome({ stage: 'gate', attempt: 1, outcome: 'approve', class: 'advance' }),
      stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'green', class: 'advance', unit: unitId('u2') }),
    ]));
  });

  it('the third chargeable failure must park the unit', () => {
    const charged = (attempt: number, cls: string): LogRecord => stageOutcome({ stage: 'lanes', attempt, outcome: 'red', class: cls, chargeable: true });
    refuses(chain([charged(1, 'advance'), charged(2, 'advance'), charged(3, 'advance')]), 3, /chargeable failure 3, which parks the unit, but its class is advance/);
    fold(ARC, chain([charged(1, 'advance'), charged(2, 'advance'), charged(3, 'park')]));
  });

  it('a dispatch re-pin keeps the scope and never lowers the risk floor', () => {
    fold(ARC, chain([dispatch('low'), dispatch('high')]));
    refuses(chain([dispatch('med'), dispatch('low')]), 2, /dispatch of u1 lowers riskFloor med to low/);
    refuses(chain([dispatch('med'), dispatch('med', 'lib/**')]), 2, /dispatch of u1 changes its pinned scope/);
  });

  it('monotonicSince: a replaced record whose counter fell, or a vanished one, is refused', () => {
    const unit = newUnitState(U1, 'build', 'med');
    const total: MeterTotal = {
      charge: { type: 'role', role: 'build' }, routingRev: REV, known: 2, unavailable: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: 0.5,
    };
    const refs = (units: CounterRefs['units'], meter: CounterRefs['meter'], lastSeq = 1): CounterRefs => ({ lastSeq, snapshotHighWater: 0, units, meter });
    const before = refs(new Map([[U1, unit]]), new Map([['build r', total]]));
    const regressed = (f: () => void, counter: string): void => {
      assert.throws(f, (err: unknown) => err instanceof CounterRegressionError && err.counter === counter);
    };
    monotonicSince(before, refs(new Map([[U1, { ...unit, counters: { ...unit.counters, attempts: 1 } }]]), new Map([['build r', { ...total, known: 3 }]]), 2));
    regressed(() => monotonicSince(before, refs(new Map([[U1, unit]]), new Map([['build r', { ...total, known: 1 }]]), 2)), 'meter build r known');
    regressed(() => monotonicSince(before, refs(new Map(), new Map([['build r', total]]), 2)), `unit ${U1} attempts`);
    regressed(() => monotonicSince(before, refs(before.units, before.meter, 0)), 'lastSeq');
  });

  it('a meter event still reports the first regressing counter of its touched total', () => {
    const events = chain([
      spawnIntent(1), meter(inv1(1), 'build', 100, 10, 5), spawnLost(op(1)),
      spawnIntent(4), meter(inv1(4), 'build', -200, -20, 0),
    ]);
    assert.throws(() => fold(ARC, events), {
      name: 'CounterRegressionError',
      message: `counter meter build ${REV} inputTokens regressed from 100 to -100`,
    });
  });

  it('open start selection keeps highest-attempt order, first-start ties and closed winners', () => {
    const records: LogRecord[] = [
      spawnIntent(1, { stage: 'build', attempt: 4 }), spawnLost(op(1)),
      spawnIntent(3, { stage: 'lanes', attempt: 1 }), spawnLost(op(3)),
      stageOutcome({ stage: 'build', attempt: 4, outcome: 'success', class: 'advance' }),
      spawnIntent(6, { stage: 'gate', attempt: 4 }), spawnLost(op(6)),
      spawnIntent(8, { stage: 'lanes', attempt: 5 }),
      stageOutcome({ stage: 'lanes', attempt: 5, outcome: 'green', class: 'advance' }),
      stageOutcome({ stage: 'gate', attempt: 6, outcome: 'approve', class: 'advance' }),
      spawnLost(op(8)), spawnIntent(8, { stage: 'lanes', attempt: 5, ordinal: 2 }),
    ];
    const starts = new Map<string, { stage: Stage; attempt: number; seq: number }>();
    const outcomes = new Set<string>();
    const view = new Fold(ARC);
    for (const event of chain(records)) {
      const start = event.type === 'intent' && event.parent.type === 'stage' ? event.parent
        : event.type === 'fact' && event.fact.kind === 'stage-outcome' ? event.fact : null;
      if (start !== null) {
        const key = `${start.stage}#${start.attempt}`;
        if (!starts.has(key)) starts.set(key, { stage: start.stage, attempt: start.attempt, seq: event.seq });
        if (event.type === 'fact') outcomes.add(key);
      }
      view.apply(event, prevHash(Buffer.from(serializeEvent(event))));
      const firstHighest = [...starts.values()].sort((a, b) => b.attempt - a.attempt)[0];
      const expected = firstHighest === undefined || outcomes.has(`${firstHighest.stage}#${firstHighest.attempt}`) ? null : firstHighest;
      assert.deepEqual(view.unit(U1).open, expected);
    }
  });

  it('walk openness is per job, and ended or unstarted jobs reject the same records', () => {
    const start = (n: number): LogRecord => ({ type: 'fact', fact: {
      kind: 'walk-started', job: jobId('walk', n), milestone: milestoneIdOf(1), round: 1, sha: sha('a'.repeat(40)), ports: {},
    } });
    const end = (n: number): LogRecord => ({ type: 'fact', fact: {
      kind: 'walk-ended', job: jobId('walk', n), outcome: 'reported', findings: [], proposals: [], dropped: [],
    } });
    const proposal = { type: 'fact', fact: {
      kind: 'polish-proposed', id: polishIdOf(1), job: jobId('walk', 1), milestone: milestoneIdOf(1), journey: journeyIdOf(1),
      evidence: [], text: 'Polish', unit: { id: unitId('polish-1'), scope: [repoPattern('src/**')], spec: '{}' },
    } } as const satisfies LogRecord;
    fold(ARC, chain([start(1), start(2), end(1), end(2)]));
    refuses(chain([end(1)]), 1, /walk-ended of walk-1, which is not a started, unended walk/);
    refuses(chain([start(1), start(2), end(1), end(1)]), 4, /walk-ended of walk-1, which is not a started, unended walk/);
    refuses(chain([proposal]), 1, /polish-proposed X-1 of walk-1, which is not a started, unended walk/);
    refuses(chain([start(1), start(2), end(1), proposal]), 4, /polish-proposed X-1 of walk-1, which is not a started, unended walk/);
    const second: LogRecord = { ...proposal, fact: { ...proposal.fact, id: polishIdOf(2), job: jobId('walk', 2) } };
    const firstEnd: LogRecord = { type: 'fact', fact: { kind: 'walk-ended', job: jobId('walk', 1), outcome: 'reported', findings: [], proposals: [polishIdOf(1)], dropped: [] } };
    const secondEnd: LogRecord = { type: 'fact', fact: { kind: 'walk-ended', job: jobId('walk', 2), outcome: 'reported', findings: [], proposals: [polishIdOf(2)], dropped: [] } };
    fold(ARC, chain([start(1), start(2), proposal, second, firstEnd, secondEnd]));
    refuses(chain([start(1), proposal, end(1)]), 3, /walk-ended of walk-1 names proposals ; it proposed X-1/);
  });

  it('a refused event leaves the fold unchanged', () => {
    const f = new Fold(ARC);
    const [a, b] = chain([spawnIntent(1, { key: 'k' }), commandIntent(2, 'k')]);
    f.apply(a!, prevHash(Buffer.from(serializeEvent(a!))));
    const before = canonicalJson(f.derived());
    assert.throws(() => f.apply(b!, prevHash(Buffer.from(serializeEvent(b!)))), FoldInvariantError);
    assert.equal(canonicalJson(f.derived()), before);
    assert.equal(f.highWater(), 1);
  });
});

describe('fold indexes', () => {
  it('every index equals a full scan at each log prefix, including retries that move subjects', () => {
    const units = [U1, unitId('u2'), unitId('u3'), unitId('unnamed')];
    const jobs = [jobId('audit', 1), jobId('audit', 2), jobId('audit', 3)];
    const records: LogRecord[] = [];
    const retried: IntentOf<'proc.spawn'>[] = [];
    for (const unit of units.slice(0, 3)) {
      for (const [stage, role] of [['plan-check', 'planCheck'], ['build', 'build'], ['gate', 'gate']] as const) {
        const base = spawnIntent(records.length + 1, { stage, role });
        assert.equal(base.kind, 'proc.spawn');
        const spawn: IntentOf<'proc.spawn'> = {
          ...base, parent: stageParent(stage, 1, unit), expect: {
            ...base.expect, subject: { purpose: 'backend', unit, role, tier: 'med', routingRev: REV, attempt: 1 },
          },
        };
        records.push(spawn, meter(invocationId(spawn.op, 1), role, 100, 10, 5), spawnLost(spawn.op));
        if (stage === 'build') retried.push(spawn);
        records.push(stageOutcome({ unit, stage, attempt: 1, outcome: 'success', class: 'advance' }));
      }
      const base = spawnIntent(records.length + 1, { stage: 'lanes' });
      assert.equal(base.kind, 'proc.spawn');
      records.push({ ...base, parent: stageParent('lanes', 1, unit), expect: { ...base.expect,
        subject: { purpose: 'lane', unit, lane: laneId('test'), set: 'spec', at: sha('a'.repeat(40)) },
      } });
    }
    // The checkout and evidence scans used by retire include several op kinds under the same unit.
    for (const unit of units.slice(0, 3)) {
      records.push({ type: 'intent', kind: 'worktree.create', op: op(records.length + 1), key: opKey(`checkout:${unit}`),
        parent: stageParent('prepare', 1, unit), ordinal: 1, deadlineAt: null,
        expect: { path: absPath(`/work/${unit}`), checkout: { type: 'branch', branch: refName(`refs/heads/${unit}`), at: sha('a'.repeat(40)), createBranch: true } }, post: null,
      });
      records.push({ type: 'intent', kind: 'evidence.snapshot', op: op(records.length + 1), key: opKey(`evidence:${unit}`),
        parent: stageParent('evidence', 1, unit), ordinal: 1, deadlineAt: null,
        expect: { source: absPath(`/work/${unit}`), globs: [repoPattern('**')], dest: absPath(`/run/evidence/${unit}`) },
        post: { manifest: absPath(`/run/evidence/${unit}/manifest.json`) },
      });
    }
    for (const job of jobs.slice(0, 2)) {
      const base = spawnIntent(records.length + 1);
      assert.equal(base.kind, 'proc.spawn');
      const spawn: IntentOf<'proc.spawn'> = { ...base, parent: { type: 'job', job }, expect: { ...base.expect,
        subject: { purpose: 'arc-backend', job, role: 'lens', tier: 'arc', routingRev: REV, attempt: 1 },
      } };
      records.push(spawn, spawnLost(spawn.op));
      retried.push(spawn);
    }
    const first = retried[0]!;
    const kill: IntentOf<'proc.kill'> = {
      type: 'intent', kind: 'proc.kill', op: op(records.length + 1), key: opKey('kill'), parent: { type: 'op', op: first.op },
      ordinal: 1, deadlineAt: null, expect: { inv: invocationId(first.op, 1), reason: 'pause', scope: 'invocation' }, post: null,
    };
    records.push(kill, { type: 'abort', op: kill.op, reason: { code: 'cancelled', detail: 'retry' } });
    records.push(commandIntent(records.length + 1));
    records.push(snapshotIntent(records.length + 1, records.length));
    // A retry preserves op order even if its current subject now belongs in an older position of another bucket.
    // Parent field insertion order may differ; canonical equality still identifies the same stage attempt.
    for (const previous of retried) {
      records.push({ ...previous, ordinal: 2,
        parent: previous.parent.type === 'stage'
          ? { attempt: previous.parent.attempt, stage: previous.parent.stage, unit: previous.parent.unit, type: 'stage' }
          : previous.parent,
        expect: { ...previous.expect, subject: { purpose: 'backend', unit: units[1]!, role: 'gate', tier: 'med', routingRev: REV, attempt: 1 } },
      });
    }
    records.push({ ...kill, ordinal: 2, expect: { ...kill.expect, inv: invocationId(first.op, 2), reason: 'stop' } });
    // A backend-to-job retry also removes both the unit and the unit/role memberships.
    records.push(spawnLost(first.op));
    records.push({ ...first, ordinal: 3, expect: { ...first.expect,
      subject: { purpose: 'arc-backend', job: jobs[1]!, role: 'lens', tier: 'arc', routingRev: REV, attempt: 1 },
    } });

    const latest = new Map<IntentRecord['op'], IntentRecord>();
    const parents: Parent[] = [{ type: 'arc' }, { type: 'command', command: commandId('cmd-0000000000000001') }];
    for (const record of records) if (record.type === 'intent') parents.push(record.parent);
    const invs = [invocationId(first.op, 1), invocationId(first.op, 2), invocationId(first.op, 3)];
    const view = new Fold(ARC);
    const retained: { answer: readonly IntentRecord[]; copy: readonly IntentRecord[] }[] = [];
    for (const event of chain(records)) {
      if (event.type === 'intent') latest.set(event.op, event);
      view.apply(event, prevHash(Buffer.from(serializeEvent(event))));
      const all = [...latest.values()];
      for (const kind of OP_KINDS) {
        const expected = all.filter((i) => i.kind === kind);
        assert.deepEqual(view.opsOf(kind), expected);
        for (const parent of parents) {
          assert.deepEqual(view.opsOfParent(kind, parent), expected.filter((i) => canonicalJson(i.parent) === canonicalJson(parent)));
        }
        for (const unit of units) {
          assert.deepEqual(view.opsOfUnit(kind, unit), expected.filter((i) => i.parent.type === 'stage' && i.parent.unit === unit));
        }
      }
      const spawns = all.filter((i) => i.kind === 'proc.spawn');
      for (const unit of units) {
        assert.deepEqual(view.spawnsOfUnit(unit), spawns.filter((i) => 'unit' in i.expect.subject && i.expect.subject.unit === unit));
        for (const role of [...UNIT_ROLES, ...DEV17_UNIT_ROLES]) {
          assert.deepEqual(view.spawnsOfUnit(unit, role), spawns.filter((i) => {
            const s = i.expect.subject;
            return s.purpose === 'backend' && s.unit === unit && s.role === role;
          }));
        }
      }
      for (const job of jobs) assert.deepEqual(view.spawnsOfJob(job), spawns.filter((i) => 'job' in i.expect.subject && i.expect.subject.job === job));
      for (const inv of invs) assert.deepEqual(view.killsOfInvocation(inv), all.filter((i) => i.kind === 'proc.kill' && i.expect.inv === inv));
      const answers = [view.opsOf('proc.spawn'), view.opsOfParent('proc.spawn', first.parent), view.opsOfUnit('proc.spawn', U1), view.spawnsOfUnit(U1, 'build')];
      for (const answer of answers) retained.push({ answer, copy: [...answer] });
      for (const { answer, copy } of retained) assert.deepEqual(answer, copy, 'previously returned arrays retain their values across appends');
    }
  });
});

describe('fold: command effects (step 13)', () => {
  const C = commandId('cmd-00000000000000c1');
  const fact = (f: object): LogRecord => ({ type: 'fact', fact: f }) as LogRecord;
  const hold = stageOutcome({ stage: 'build', attempt: 1, outcome: 'interrupted', class: 'hold' });

  it('pause and stop markers; resume clears a unit\'s pause and hold, all of them, or a backend\'s park', () => {
    const f = new Fold(ARC);
    const events = chain([
      hold, // 1
      fact({ kind: 'paused', command: C, target: { type: 'unit', unit: U1 } }), // 2
      fact({ kind: 'stop-requested', command: C }), // 3
      fact({ kind: 'backend-park', backend: 'codex', class: 'usage-limit', inv: inv1(1) }), // 4
    ]);
    for (const e of events) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    assert.deepEqual(f.control(), { stop: C, pausedAll: false, pausedUnits: [U1] });
    assert.equal(f.unit(U1).status, 'held');
    // A backend resume releases holds no pause covers: u1 is paused, so it stays held.
    const resumed = chain([hold, fact({ kind: 'paused', command: C, target: { type: 'unit', unit: U1 } }), fact({ kind: 'backend-park', backend: 'codex', class: 'usage-limit', inv: inv1(1) }), fact({ kind: 'resumed', command: C, target: { type: 'backend', backend: 'codex' } })]);
    const s1 = fold(ARC, resumed);
    assert.deepEqual([s1.parkedBackends, s1.units[0]?.status], [[], 'held']);
    const s2 = fold(ARC, chain([hold, fact({ kind: 'paused', command: C, target: { type: 'unit', unit: U1 } }), fact({ kind: 'resumed', command: C, target: { type: 'unit', unit: U1 } })]));
    assert.deepEqual([s2.control.pausedUnits, s2.units[0]?.status, s2.units[0]?.counters.attempts], [[], 'active', 1]);
    const s3 = fold(ARC, chain([hold, fact({ kind: 'paused', command: C, target: { type: 'all' } }), fact({ kind: 'resumed', command: C, target: { type: 'all' } })]));
    assert.deepEqual([s3.control.pausedAll, s3.units[0]?.status], [false, 'active']);
  });

  it('interrupted: the latest hold since the last decision; a resume keeps it, the next decided outcome clears it', () => {
    const decided = stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'red', class: 'advance', chargeable: true });
    const again = stageOutcome({ stage: 'build', attempt: 3, outcome: 'interrupted', class: 'hold' });
    const held = fold(ARC, chain([decided, hold, again, fact({ kind: 'resumed', command: C, target: { type: 'all' } })])).units[0]!;
    const at = (f: StageOutcomeFact | null): string | null => (f === null ? null : `${f.stage}#${f.attempt}`);
    assert.deepEqual([at(held.decided), at(held.interrupted), held.status], ['lanes#1', 'build#3', 'active']);
    const next = fold(ARC, chain([decided, hold, stageOutcome({ stage: 'build', attempt: 2, outcome: 'success', class: 'advance' })])).units[0]!;
    assert.equal(next.interrupted, null);
  });

  it('executor-started clears the stop marker and nothing else: pauses and holds persist', () => {
    const s = fold(ARC, chain([
      hold, fact({ kind: 'paused', command: C, target: { type: 'all' } }), fact({ kind: 'stop-requested', command: C }), fact({ kind: 'executor-started', generation: 2 }),
    ]));
    assert.deepEqual(s.control, { stop: null, pausedAll: true, pausedUnits: [] });
    assert.equal(s.units[0]?.status, 'held');
  });

  it('refuses a resume of an unparked backend, a unit resume under pause --all, and a second acknowledgement', () => {
    refuses(chain([fact({ kind: 'resumed', command: C, target: { type: 'backend', backend: 'claude' } })]), 1, /not parked/);
    refuses(chain([fact({ kind: 'paused', command: C, target: { type: 'all' } }), fact({ kind: 'resumed', command: C, target: { type: 'unit', unit: U1 } })]), 2, /whole arc is paused/);
    const ack = fact({ kind: 'needs-user-acked', id: needsUserId('sup-1-1'), command: C, choice: null });
    const s = fold(ARC, chain([ack]));
    assert.deepEqual(s.needsUserAcked, ['sup-1-1'], 'any id form may be acknowledged');
    refuses(chain([ack, ack]), 2, /second acknowledgement/);
  });

  it('state.reopen: a reopen of a unit parked at a judgment stage onto the next spec rev starts it over at plan-check, counters kept and the redirect bound reset; any other reopen is refused', () => {
    const H2 = sha256('e'.repeat(64));
    const reopen = (rev: number): LogRecord => fact({ kind: 'reopened', unit: U1, command: C, specRev: specRev(rev), specSha256: H2 });
    const redirect = stageOutcome({ stage: 'plan-check', attempt: 1, outcome: 'redirect', class: 'redirect' });
    const gatePark = stageOutcome({ stage: 'gate', attempt: 2, outcome: 'escalate', class: 'park' });
    const s = fold(ARC, chain([dispatch('med'), redirect, gatePark, reopen(2)]));
    const u = s.units[0]!;
    assert.deepEqual(
      [u.status, u.stage, u.decided, u.spec, u.reopened, u.redirectBase, u.counters.redirects, u.counters.attempts],
      ['active', 'plan-check', null, { rev: 2, sha256: H2 }, { command: C, specRev: 2 }, 1, 1, 2],
    );
    refuses(chain([dispatch('med'), redirect, reopen(2)]), 3, /which is active without a pending revision/);
    refuses(chain([dispatch('med'), stageOutcome({ stage: 'lanes', attempt: 1, outcome: 'blocked', class: 'park' }), reopen(2)]), 3, /parked at lanes, not at a judgment stage/);
    refuses(chain([dispatch('med'), gatePark, reopen(3)]), 3, /spec rev 3; its recorded rev is 1/);
  });

  it('state.repin-spec: a re-pin keeps the spec of the first pin', () => {
    const H2 = sha256('e'.repeat(64));
    const OTHER = '0123456789abcdee';
    const pin = (rev: number, sha = H, routing: string = REV): LogRecord =>
      ({ type: 'fact', fact: { kind: 'dispatch', record: { unit: U1, specRev: specRev(rev), specSha256: sha, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: routing as never, implementerSeatRev: seatRev('fedcba9876543210'), at: AT, transientRules: 'm3' } } }) as LogRecord;
    const gatePark = (attempt: number) => stageOutcome({ stage: 'gate', attempt, outcome: 'escalate', class: 'park' });
    const reopen = (rev: number): LogRecord => fact({ kind: 'reopened', unit: U1, command: C, specRev: specRev(rev), specSha256: H2 });
    // The first pin names the spec, before the unit has any stage state and after.
    const applied = fact({ kind: 'plan-applied', rev: planRev(1), command: null, planSha256: H, specs: { [U1]: H }, changes: [], ...appliedFields(1, null) });
    const f = new Fold(ARC);
    for (const e of chain([applied, pin(1), pin(2, H2, OTHER)])) f.apply(e, prevHash(Buffer.from(serializeEvent(e), 'utf8')));
    assert.deepEqual(f.unit(U1).spec, { rev: 1, sha256: H }, 'no stage state yet');
    const kept = fold(ARC, chain([applied, pin(1), gatePark(1), reopen(2), pin(1, H, OTHER), gatePark(2)])).units[0]!;
    assert.deepEqual(kept.spec, { rev: 2, sha256: H2 }, 'the re-pin after the reopen keeps the reopened spec');
    refuses(chain([applied, pin(1), gatePark(1), reopen(2), pin(1, H, OTHER), gatePark(2), reopen(2)]), 7, /spec rev 2; its recorded rev is 2/);
  });

});

describe('snapshot state', () => {
  it('round-trips the derived state as canonical JSON', () => {
    const state = fold(ARC, chain([spawnIntent(1)]));
    assert.deepEqual(JSON.parse(canonicalJson(state)), JSON.parse(JSON.stringify(state)));
  });
});
