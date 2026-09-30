// upgrade.defaults-unit: the 1.0.0-dev.4 → M2 read-time defaults in src/core/upgrade.ts, unit by unit: the
// park class of a pre-M2 park, the legacy flag, and `legacyNext`, which must equal dev.4's own frontier
// (`nextUnit` and `dispatchBlock`, copied below verbatim from 1.0.0-dev.4 as the oracle, since M2 step 7b
// removed them from the tree) on every constructed log.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type UnitId, commandId, needsUserId, opId, opKey, planRev, seatRev, sha256, specRev, unitId } from '../src/core/ids.ts';
import { Fold } from '../src/core/state.ts';
import { isLegacy, legacyNext, legacyParkRecord } from '../src/core/upgrade.ts';
import { absPath, isoTime, planPath, repoPattern } from '../src/core/values.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import type { PlanUnit } from '../src/input/plan.ts';
import { raisedFor } from '../src/needsuser.ts';
import { ARC, H, REV, chain } from './fixtures/log-records.ts';

const A = unitId('a');
const B = unitId('b');
const C = unitId('c');
const CMD = commandId('cmd-0123456789abcdef');
const H2 = sha256('e'.repeat(64));

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const dispatch = (unit: UnitId): LogRecord => fact({
  kind: 'dispatch', record: { unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: isoTime('2026-09-25T12:00:00.000Z') },
});
const outcome = (unit: UnitId, stage: string, attempt: number, out: string, cls: string): LogRecord =>
  fact({ kind: 'stage-outcome', unit, stage, attempt, outcome: out, class: cls, chargeable: false });
const merged = (unit: UnitId): readonly LogRecord[] => [dispatch(unit), outcome(unit, 'snapshot', 1, 'published', 'retire')];
const parked = (unit: UnitId): readonly LogRecord[] => [dispatch(unit), outcome(unit, 'plan-check', 1, 'escalate', 'park')];
/** The needs-user a park raised, at `seq` (its op), parented by the parking attempt; `acked` adds its ack. */
const raised = (unit: UnitId, seq: number, acked: boolean): readonly LogRecord[] => [
  {
    type: 'intent', op: opId(ARC, seq), kind: 'needsuser.raise', key: opKey('needs-user'), parent: { type: 'stage', unit, stage: 'plan-check', attempt: 1 }, ordinal: 1,
    deadlineAt: null, expect: { id: needsUserId(`nu-${seq}`), path: absPath(`/run/needs-user/nu-${seq}.json`), blocking: true }, post: { sha256: H },
  },
  { type: 'done', op: opId(ARC, seq), kind: 'needsuser.raise', outcome: { kind: 'raised' }, recoveredBy: null },
  ...(acked ? [fact({ kind: 'needs-user-acked', id: needsUserId(`nu-${seq}`), command: CMD, choice: null })] : []),
];

function folded(records: readonly LogRecord[]): Fold {
  const f = new Fold(ARC);
  for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}

const plan = (...units: readonly (readonly [UnitId, readonly UnitId[]])[]): readonly PlanUnit[] =>
  units.map(([id, after]) => ({ id, spec: planPath(`specs/${id}.json`), risk: 'med', scope: [repoPattern('src/**')], resources: [], after, contingent: [] }));

// ---------------------------------------------------------------------------------------------------
// The oracle: 1.0.0-dev.4's `nextUnit` (src/executor.ts) and `settledForAfter`/`dispatchBlock`
// (src/pipeline/unit.ts), as that release had them.

function nextUnit(units: readonly UnitId[], view: JournalView): UnitId | null {
  return units.find((u) => {
    const s = view.unit(u).status;
    return s !== 'retired' && s !== 'park-pending';
  }) ?? null;
}

function settledForAfter(view: JournalView, id: UnitId): boolean {
  const u = view.unit(id);
  if (u.status === 'retired') return true;
  if (u.status !== 'park-pending' || u.decided === null) return false;
  const item = raisedFor(view, { type: 'stage', unit: id, stage: u.decided.stage, attempt: u.decided.attempt });
  return item !== null && view.ackOf(item) !== null;
}

function dispatchBlock(view: JournalView, unit: PlanUnit): string | null {
  const c = view.control();
  if (c.pausedAll) return 'the arc is paused';
  if (c.pausedUnits.includes(unit.id)) return `unit ${unit.id} is paused`;
  const after = unit.after.filter((id) => !settledForAfter(view, id));
  if (after.length > 0) return `unit ${unit.id} is held after ${after.join(', ')}`;
  return null;
}

/** dev.4's frontier, from the dev.4 functions themselves. */
function dev4(view: Fold, units: readonly PlanUnit[]): ReturnType<typeof legacyNext> {
  const next = nextUnit(units.map((u) => u.id), view);
  const unit = units.find((u) => u.id === next);
  return unit === undefined ? null : { unit: unit.id, block: dispatchBlock(view, unit) };
}

describe('upgrade.defaults-unit', () => {
  it('a pre-M2 park without its class reads as operator: design for the design rows, env for every other', () => {
    const f = (stage: string, out: string, chargeable = false) => ({ kind: 'stage-outcome', unit: A, stage, attempt: 1, outcome: out, class: 'park', chargeable }) as never;
    for (const [stage, out] of [['plan-check', 'escalate'], ['gate', 'refusal'], ['gate', 'revise'], ['plan-check', 'redirect'], ['build', 'malformed'], ['gate', 'empty-diff'], ['candidate', 'red']]) {
      assert.deepEqual(legacyParkRecord(f(stage!, out!)), { class: 'operator', kind: 'design' }, `${stage} ${out}`);
    }
    assert.deepEqual(legacyParkRecord(f('lanes', 'red', true)), { class: 'operator', kind: 'design' }, 'the chargeable bound');
    for (const [stage, out] of [['lanes', 'blocked'], ['build', 'process-fault'], ['build', 'lost'], ['teardown', 'cleanup-failed'], ['salvage', 'unmerged'], ['candidate', 'base-red'], ['build', 'routing-changed'], ['lanes', 'occupied']]) {
      assert.deepEqual(legacyParkRecord(f(stage!, out!)), { class: 'operator', kind: 'env' }, `${stage} ${out}`);
    }
  });

  it('isLegacy: a first plan revision without scheduling dag is legacy; before one it throws', () => {
    const rev1 = (scheduling?: 'dag') => fact({ kind: 'plan-applied', rev: planRev(1), command: null, planSha256: H, specs: { a: H }, changes: [], ...(scheduling === undefined ? {} : { scheduling }) });
    assert.equal(isLegacy(folded([rev1()])), true);
    assert.equal(isLegacy(folded([rev1('dag')])), false);
    assert.throws(() => isLegacy(folded([])), /no plan revision yet/);
  });

  it('legacyNext equals dev.4\'s nextUnit and dispatchBlock on every constructed log', () => {
    const chainPlan = plan([A, []], [B, []], [C, []]);
    const afterPlan = plan([A, []], [B, [A]], [C, [B]]);
    const cases: readonly (readonly [string, readonly PlanUnit[], readonly LogRecord[]])[] = [
      ['a fresh arc', chainPlan, []],
      ['a merged: b', chainPlan, merged(A)],
      ['every unit merged: none', chainPlan, [...merged(A), ...merged(B), ...merged(C)]],
      ['a parked, b and c not after it: b', chainPlan, parked(A)],
      ['a parked unacknowledged, b after a: b held after a', afterPlan, [...parked(A), ...raised(A, 3, false)]],
      ['a parked and acknowledged: b runs', afterPlan, [...parked(A), ...raised(A, 3, true)]],
      ['a parked, no item raised yet: b held', afterPlan, parked(A)],
      ['a merged, b parked and acknowledged, c after b: c runs', afterPlan, [...merged(A), ...parked(B), ...raised(B, 5, true)]],
      ['the arc paused', chainPlan, [fact({ kind: 'paused', command: CMD, target: { type: 'all' } })]],
      ['the frontier unit paused', chainPlan, [...merged(A), fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: B } })]],
      ['a later unit paused', chainPlan, [fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: C } })]],
      ['a held (interrupted) frontier unit', chainPlan, [dispatch(A), outcome(A, 'build', 1, 'interrupted', 'hold')]],
      ['a and b parked: c', chainPlan, [...parked(A), ...parked(B)]],
      ['a and b parked, then a reopened: a again', chainPlan, [
        ...parked(A), ...parked(B), fact({ kind: 'reopened', unit: A, command: CMD, specRev: specRev(2), specSha256: H2 }),
      ]],
      ['a and b parked, then b reopened, c after b: b', afterPlan, [
        ...parked(A), ...raised(A, 3, true), ...parked(B), fact({ kind: 'reopened', unit: B, command: CMD, specRev: specRev(2), specSha256: H2 }),
      ]],
      ['a parked, then resumed after a reroute: a', chainPlan, [dispatch(A), outcome(A, 'build', 1, 'routing-changed', 'park'), ...merged(B), fact({ kind: 'rerouted', unit: A, command: CMD })]],
      ['every unit parked: none', chainPlan, [...parked(A), ...parked(B), ...parked(C)]],
    ];
    for (const [label, units, records] of cases) {
      const view = folded(records);
      assert.deepEqual(legacyNext(view, units), dev4(view, units), label);
    }
    // The cases above cover each branch of dev.4's frontier.
    const seen = cases.map(([, units, records]) => legacyNext(folded(records), units));
    assert.ok(seen.some((s) => s === null) && seen.some((s) => s?.block === null) && seen.some((s) => s?.block?.includes('held after') === true));
    assert.deepEqual(legacyNext(folded(cases[13]![2]), chainPlan), { unit: A, block: null }, 'the reopened unit is the frontier again');
  });
});
