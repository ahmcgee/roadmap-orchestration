// M2 fold cases (src/core/state.ts): the incremental resource table, park derivation from probe facts,
// backend park epochs and dominance, hold causes, lineage, cut, build tier, the scheduling flag.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Event, type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type UnitId, commandId, invocationId, opId, opKey, planRev, seatRev, sha, specRev, unitId } from '../src/core/ids.ts';
import { Fold, FoldInvariantError } from '../src/core/state.ts';
import { isoTime, repoPattern } from '../src/core/values.ts';
import { effectiveDependency } from '../src/schedule/graph.ts';
import type { RiskTier } from '../src/routing/types.ts';
import { ARC, H, REV, U1, chain } from './fixtures/log-records.ts';

const U2 = unitId('u2');
const U3 = unitId('u3');
const CMD = commandId('cmd-0123456789abcdef');
const LATER = isoTime('2026-09-25T12:30:00.000Z');

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const outcome = (unit: UnitId, stage: string, attempt: number, out: string, cls: string, extra: object = {}): LogRecord =>
  fact({ kind: 'stage-outcome', unit, stage, attempt, outcome: out, class: cls, chargeable: false, ...extra });
const dispatch = (unit: UnitId, riskFloor: RiskTier = 'med'): LogRecord => fact({
  kind: 'dispatch', record: { unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor, routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: LATER },
});
const planApplied = (rev: number, units: readonly UnitId[], changes: readonly object[] = [], scheduling?: 'dag'): LogRecord => fact({
  kind: 'plan-applied', rev: planRev(rev), command: rev === 1 ? null : commandId(`cmd-${String(rev).padStart(16, '0')}`), planSha256: H,
  specs: Object.fromEntries(units.map((u) => [u, H])), changes, ...(scheduling === undefined ? {} : { scheduling }),
});
const probe = (target: object, covers: readonly number[], result: 'pass' | 'fail'): LogRecord =>
  fact({ kind: 'probe', target, covers, result, nextProbeAt: result === 'pass' ? null : LATER });
const retryable = (...targets: object[]) => ({ park: { class: 'retryable', targets } });

function folded(records: readonly LogRecord[]): Fold {
  const f = new Fold(ARC);
  for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}

function refuses(records: readonly LogRecord[], seq: number, detail: RegExp): void {
  const events: Event[] = chain(records);
  const f = new Fold(ARC);
  assert.throws(() => {
    for (const e of events) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  }, (err: unknown) => {
    assert.ok(err instanceof FoldInvariantError, `expected FoldInvariantError, got ${String(err)}`);
    assert.equal(err.seq, seq, err.message);
    assert.match(err.detail, detail);
    return true;
  });
}

const transitionIntent = (seq: number, holder: object, resources: readonly string[], edge: object, key = 'resources:t'): LogRecord => ({
  type: 'intent', op: opId(ARC, seq), kind: 'resource.transition', key: opKey(key), parent: { type: 'arc' }, ordinal: 1, deadlineAt: null,
  expect: { holder, resources, edge }, post: null,
} as LogRecord);
const transitionDone = (seq: number): LogRecord => ({ type: 'done', op: opId(ARC, seq), kind: 'resource.transition', outcome: { kind: 'transitioned' }, recoveredBy: null });
const stageHolder = { type: 'stage', unit: U1, stage: 'build', attempt: 1 };

describe('fold: the resource table (JournalView.resources)', () => {
  it('follows each transition incrementally: pending while open, moved at done, untouched by an abort', () => {
    const units = ['db', 'estate#1', '@cpu#1', '@cpu#2'];
    const f = folded([
      transitionIntent(1, stageHolder, units, { type: 'reserve' }), // 1
    ]);
    assert.deepEqual([...f.resources()].map(([u, e]) => [u, e.status.state, e.pending?.op ?? null]), units.map((u) => [u, 'free', opId(ARC, 1)]));
    const g = folded([
      transitionIntent(1, stageHolder, units, { type: 'reserve' }), transitionDone(1), // 1, 2
      transitionIntent(3, stageHolder, units, { type: 'run' }), transitionDone(3), // 3, 4
      transitionIntent(5, stageHolder, units, { type: 'clean', from: 'running' }), // 5
      { type: 'abort', op: opId(ARC, 5), reason: { code: 'recovery', detail: 'x' } }, // 6
    ]);
    assert.deepEqual([...g.resources()].map(([u, e]) => [u, e.status.state, e.pending]), units.map((u) => [u, 'running', null]));
    assert.deepEqual(g.derived().resources.map((r) => r.unit), ['db', 'estate#1', '@cpu#1', '@cpu#2']);
  });

  it('refuses an illegal transition at its done and a second open transition on a unit', () => {
    refuses([transitionIntent(1, stageHolder, ['db'], { type: 'run' }), transitionDone(1)], 2, /illegal for db: run of a free resource/);
    refuses([
      transitionIntent(1, stageHolder, ['db'], { type: 'reserve' }),
      transitionIntent(2, { type: 'publication', unit: U2, attempt: 1 }, ['db'], { type: 'reserve' }, 'resources:other'),
    ], 2, /moves db while arc-1\/1 is open on it/);
  });

  it('a retry holder reclaims a cleanup-failed instance; a publication holder may not', () => {
    const failed: LogRecord[] = [
      transitionIntent(1, stageHolder, ['estate#1'], { type: 'reserve' }), transitionDone(1),
      transitionIntent(3, stageHolder, ['estate#1'], { type: 'clean', from: 'reserved' }), transitionDone(3),
      transitionIntent(5, stageHolder, ['estate#1'], { type: 'fail', residues: [{ resource: 'estate#1', teardown: invocationId(opId(ARC, 5), 1) }] }), transitionDone(5),
    ];
    const retry = { type: 'retry', unit: U1, stage: 'build', attempt: 1 };
    const f = folded([...failed, transitionIntent(7, retry, ['estate#1'], { type: 'reclaim' }, 'resources:r'), transitionDone(7)]);
    assert.deepEqual(f.resources().get('estate#1' as never)?.status, { state: 'cleaning', holder: retry });
    refuses([...failed, transitionIntent(7, { type: 'publication', unit: U1, attempt: 1 }, ['estate#1'], { type: 'reclaim' }, 'resources:p'), transitionDone(7)], 8, /reclaim by a publication holder/);
  });
});

describe('fold: parks (A7, F9, F10, G7)', () => {
  const lanesPark = [
    dispatch(U1), // 1
    outcome(U1, 'teardown', 1, 'released', 'advance'), // 2
    outcome(U1, 'lanes', 2, 'cleanup-failed', 'park', retryable({ type: 'resource', instance: 'db' }, { type: 'resource', instance: 'estate#1' })), // 3
  ];

  it('park.multi-target: a park recovers only once every target has a covering pass; the unit re-runs the parked stage', () => {
    const partial = folded([...lanesPark, probe({ type: 'resource', instance: 'db' }, [3], 'pass'), probe({ type: 'resource', instance: 'estate#1' }, [3], 'fail')]);
    const u = partial.unit(U1);
    assert.equal(u.status, 'park-pending');
    assert.deepEqual(u.park?.passed, [{ type: 'resource', instance: 'db' }]);
    assert.equal(u.park?.seq, 3);
    assert.deepEqual(partial.probes().map((p) => [p.target, p.result, p.seq]), [[{ type: 'resource', instance: 'db' }, 'pass', 4], [{ type: 'resource', instance: 'estate#1' }, 'fail', 5]]);

    const done = folded([...lanesPark, probe({ type: 'resource', instance: 'db' }, [3], 'pass'), probe({ type: 'resource', instance: 'estate#1' }, [3], 'pass')]);
    const r = done.unit(U1);
    assert.equal(r.status, 'active');
    assert.equal(r.park, null);
    assert.equal(r.decided?.stage, 'teardown', 'the decision before the park: on to lanes again');
    assert.deepEqual(r.lastRecovery?.targets.map((t) => (t.type === 'resource' ? t.instance : t.type)), ['db', 'estate#1']);
    assert.equal(r.counters.attempts, 2, 'recovery moves no counter');
  });

  it('a pass covering a stale park changes nothing; a cover of no park, of an operator park or of an untargeted target is refused', () => {
    const reopenedLater = folded([
      ...lanesPark, fact({ kind: 'resumed', command: CMD, target: { type: 'all' } }), // 4: no effect on a park
      probe({ type: 'resource', instance: 'db' }, [3], 'pass'), // 5
    ]);
    assert.equal(reopenedLater.unit(U1).status, 'park-pending');
    refuses([...lanesPark, probe({ type: 'host' }, [2], 'pass')], 4, /covers seq 2, which parked nothing/);
    refuses([...lanesPark, probe({ type: 'host' }, [3], 'pass')], 4, /does not target it/);
    refuses([dispatch(U1), outcome(U1, 'candidate', 1, 'base-red', 'park', { park: { class: 'operator', kind: 'env' } }), probe({ type: 'host' }, [2], 'pass')], 3, /operator park/);
  });

  it('a park without a class (1.0.0-dev.4) reads as operator: design for the design rows, env otherwise', () => {
    const f = folded([
      dispatch(U1), outcome(U1, 'lanes', 1, 'blocked', 'park'), // 2: env
      dispatch(U2), outcome(U2, 'gate', 1, 'escalate', 'park'), // 4: design
    ]);
    assert.deepEqual(f.unit(U1).park?.park, { class: 'operator', kind: 'env' });
    assert.deepEqual(f.unit(U2).park?.park, { class: 'operator', kind: 'design' });
  });

  it('unparked re-runs an operator-env park and is refused for any other; rerouted reads as unparked', () => {
    const envPark = [dispatch(U1), outcome(U1, 'lanes', 1, 'green', 'advance'), outcome(U1, 'gate', 2, 'approve', 'advance'), outcome(U1, 'candidate', 3, 'base-red', 'park', { park: { class: 'operator', kind: 'env' } })];
    const f = folded([...envPark, fact({ kind: 'unparked', unit: U1, command: CMD })]);
    assert.equal(f.unit(U1).status, 'active');
    assert.equal(f.unit(U1).decided?.stage, 'gate');
    assert.equal(f.unit(U1).park, null);
    refuses([dispatch(U1), outcome(U1, 'gate', 1, 'empty-diff', 'park', { park: { class: 'operator', kind: 'design' } }), fact({ kind: 'unparked', unit: U1, command: CMD })], 3, /not operator env/);
    refuses([...lanesPark, fact({ kind: 'unparked', unit: U1, command: CMD })], 4, /not operator env/);
    const rerouted = folded([dispatch(U1), outcome(U1, 'build', 1, 'routing-changed', 'park'), fact({ kind: 'rerouted', unit: U1, command: CMD })]);
    assert.equal(rerouted.unit(U1).status, 'active');
  });
});

describe('fold: backend parks (F12, G5)', () => {
  const inv = invocationId(opId(ARC, 99), 1);
  const park = (backend: string, cls: string): LogRecord => fact({ kind: 'backend-park', backend, class: cls, inv: cls === 'outage' ? null : inv });
  const held = (unit: UnitId, attempt: number, backend: string, parkSeq: number): LogRecord =>
    outcome(unit, 'build', attempt, 'interrupted', 'hold', { cause: { type: 'backend', backend, parkSeq } });

  it('probe.stale-epoch-ignored: only a pass covering the current epoch clears a retryable park, and it releases exactly the holds it caused', () => {
    const records = [
      dispatch(U1), dispatch(U2), dispatch(U3), // 1-3
      park('codex', 'capacity'), // 4
      held(U1, 1, 'codex', 4), // 5
      park('codex', 'capacity'), // 6: a later park of the same backend
      held(U2, 1, 'codex', 6), // 7
      park('claude', 'outage'), // 8
      held(U3, 1, 'claude', 8), // 9
      outcome(unitId('u4'), 'build', 1, 'interrupted', 'hold'), // 10: an operator pause's hold, no cause
    ];
    const stale = folded([...records, probe({ type: 'backend', backend: 'codex' }, [4], 'pass')]);
    assert.deepEqual(stale.backendParks(), [{ backend: 'claude', seq: 8, class: 'outage' }, { backend: 'codex', seq: 6, class: 'capacity' }]);
    assert.equal(stale.unit(U1).status, 'held');
    const current = folded([...records, probe({ type: 'backend', backend: 'codex' }, [6], 'pass')]);
    assert.deepEqual(current.parkedBackends(), ['claude']);
    assert.deepEqual([U1, U2, U3, unitId('u4')].map((u) => current.unit(u).status), ['active', 'active', 'held', 'held'], 'codex holds released; claude\'s and the pause\'s kept');
    refuses([...records, probe({ type: 'backend', backend: 'claude' }, [6], 'pass')], 11, /covers backend codex's park/);
    refuses([dispatch(U1), outcome(U1, 'build', 1, 'interrupted', 'hold', { cause: { type: 'backend', backend: 'codex', parkSeq: 1 } })], 2, /no park of that backend/);
  });

  it('probe.usage-limit-dominates: a usage-limit park outlives a later retryable one and every probe; resume --backend clears it', () => {
    const records = [park('codex', 'usage-limit'), park('codex', 'capacity')];
    const f = folded([...records, probe({ type: 'backend', backend: 'codex' }, [2], 'pass')]);
    assert.deepEqual(f.backendParks(), [{ backend: 'codex', seq: 2, class: 'usage-limit' }]);
    const resumed = folded([...records, fact({ kind: 'resumed', command: CMD, target: { type: 'backend', backend: 'codex' } })]);
    assert.deepEqual(resumed.backendParks(), []);
    const replaced = folded([park('codex', 'capacity'), park('codex', 'usage-limit')]);
    assert.deepEqual(replaced.backendParks(), [{ backend: 'codex', seq: 2, class: 'usage-limit' }]);
  });

  it('resume --backend keeps releasing cause-less holds of unpaused units (the pre-M2 usage-limit hold) but not other backends\' holds', () => {
    const f = folded([
      dispatch(U1), dispatch(U2), park('codex', 'usage-limit'), park('claude', 'capacity'), // 1-4
      outcome(U1, 'build', 1, 'interrupted', 'hold'), held(U2, 1, 'claude', 4), // 5, 6
      fact({ kind: 'resumed', command: CMD, target: { type: 'backend', backend: 'codex' } }), // 7
    ]);
    assert.deepEqual([f.unit(U1).status, f.unit(U2).status], ['active', 'held']);
  });
});

describe('fold: lineage, cut, build tier, scheduling', () => {
  const parkedU1 = [
    planApplied(1, [U1, U2], [], 'dag'), // 1
    dispatch(U1, 'med'), // 2
    outcome(U1, 'lanes', 1, 'red', 'advance', { chargeable: true }), // 3
    outcome(U1, 'lanes', 2, 'cleanup-failed', 'park', { park: { class: 'operator', kind: 'env' } }), // 4
  ];

  it('a re-entry inherits counters, attempt numbering and risk floor, supersedes its predecessor, and activates at prepare', () => {
    const reentered = [...parkedU1, planApplied(2, [U1, U2, U3], [{ type: 'unit-added', unit: U3 }, { type: 'unit-reentered', unit: U3, reenters: U1, reset: false }])]; // 5
    const f = folded(reentered);
    const old = f.unit(U1);
    const next = f.unit(U3);
    assert.deepEqual([old.status, old.supersededBy, old.park], ['superseded', U3, null]);
    assert.deepEqual([next.stage, next.risk, next.lineage, next.counters.chargeableFailures, next.counters.attempts], ['prepare', 'med', { reenters: U1, root: U1, prepared: false }, 1, 2]);
    assert.equal(effectiveDependency(f, U1), U1, 'before preparation the edge stays on the superseded unit');
    const prepared = folded([...reentered, dispatch(U3, 'high'), outcome(U3, 'prepare', 3, 'clean-verify', 'advance')]);
    assert.equal(prepared.unit(U3).lineage?.prepared, true);
    assert.equal(effectiveDependency(prepared, U1), U3);
    const reset = folded([...parkedU1, planApplied(2, [U1, U2, U3], [{ type: 'unit-reentered', unit: U3, reenters: U1, reset: true }])]);
    assert.equal(reset.unit(U3).counters.chargeableFailures, 0);
  });

  it('refuses a re-entry of an unparked unit, a reused id, a lowered lineage floor and a prepare outside a lineage', () => {
    refuses([planApplied(1, [U1], [], 'dag'), dispatch(U1), planApplied(2, [U1, U3], [{ type: 'unit-reentered', unit: U3, reenters: U1, reset: false }])], 3, /which is active, not parked or held/);
    refuses([...parkedU1, planApplied(2, [U1, U2], [{ type: 'unit-reentered', unit: U2, reenters: U1, reset: false }])], 5, /an id already used/);
    refuses([...parkedU1, planApplied(2, [U1, U2, U3], [{ type: 'unit-reentered', unit: U3, reenters: U1, reset: false }]), dispatch(U3, 'low')], 6, /lowers its lineage's riskFloor med to low/);
    refuses([dispatch(U1), outcome(U1, 'prepare', 1, 'clean-build', 'advance')], 2, /re-enters no unit/);
  });

  it('a cut unit takes no dispatch or outcome; a merged unit cannot be cut', () => {
    const cut = [planApplied(1, [U1, U2], [], 'dag'), planApplied(2, [U1, U2], [{ type: 'unit-cut', unit: U2 }])];
    assert.equal(folded(cut).unit(U2).status, 'cut');
    refuses([...cut, dispatch(U2)], 3, /dispatch of u2, which is cut/);
    refuses([...cut, outcome(U2, 'plan-check', 1, 'approve', 'advance')], 3, /which is cut/);
    refuses([planApplied(1, [U1], [], 'dag'), outcome(U1, 'snapshot', 1, 'published', 'retire'), planApplied(2, [U1], [{ type: 'unit-cut', unit: U1 }])], 3, /cuts u1, which is retired/);
  });

  it('buildTier: the dispatch floor, raised to high by implementer-escalated and kept there', () => {
    const esc = fact({ kind: 'implementer-escalated', unit: U1, attempt: 3, from: 'low', to: 'high', stalled: 2 });
    const f = folded([dispatch(U1, 'low'), esc, dispatch(U1, 'med')]);
    assert.equal(f.unit(U1).buildTier, 'high');
    assert.equal(f.unit(U1).risk, 'med');
    assert.equal(folded([dispatch(U1, 'low'), dispatch(U1, 'med')]).unit(U1).buildTier, 'med');
    refuses([esc], 1, /never dispatched/);
    refuses([dispatch(U1, 'med'), esc], 2, /from low; its build tier is med/);
    refuses([
      dispatch(U1, 'low'), outcome(U1, 'lanes', 1, 'red', 'advance', { chargeable: true }), outcome(U1, 'lanes', 2, 'red', 'advance', { chargeable: true }),
      outcome(U1, 'lanes', 3, 'red', 'park', { chargeable: true }), esc,
    ], 5, /at the chargeable bound/);
  });

  it('scheduling: dag only on a first revision of an undispatched log; no scheduling on rev 1 is legacy', () => {
    assert.equal(folded([]).scheduling(), null);
    assert.equal(folded([planApplied(1, [U1], [], 'dag')]).scheduling(), 'dag');
    assert.equal(folded([dispatch(U1), planApplied(1, [U1])]).scheduling(), 'legacy');
    assert.equal(folded([planApplied(1, [U1]), planApplied(2, [U1])]).scheduling(), 'legacy');
    refuses([dispatch(U1), planApplied(1, [U1], [], 'dag')], 2, /already dispatched a unit/);
  });

  it('judgment inputs, resolved edges and the run-only allowlist', () => {
    const inputs = { kind: 'judgment-inputs', unit: U1, stage: 'gate', attempt: 4, tip: sha('a'.repeat(40)), head: sha('b'.repeat(40)), specRev: 1, specSha256: H, planRev: 1, routingRev: REV };
    const f = folded([fact(inputs), fact({ kind: 'edge-resolved', edge: 'e-top', command: CMD, evidence: 'landed' }), fact({ kind: 'run-only', command: CMD, units: [U2] })]);
    assert.deepEqual(f.judgmentInputs(U1, 'gate', 4), { unit: U1, stage: 'gate', attempt: 4, tip: inputs.tip, head: inputs.head, specRev: 1, specSha256: H, planRev: 1, routingRev: REV });
    assert.equal(f.judgmentInputs(U1, 'gate', 3), null);
    assert.deepEqual(f.edgeResolved('e-top' as never), { command: CMD, evidence: 'landed', seq: 2 });
    assert.deepEqual(f.runOnly(), [U2]);
    refuses([fact(inputs), fact(inputs)], 2, /second judgment-inputs/);
    refuses([fact({ kind: 'edge-resolved', edge: 'e', command: CMD, evidence: 'x' }), fact({ kind: 'edge-resolved', edge: 'e', command: CMD, evidence: 'y' })], 2, /already resolved/);
  });
});
