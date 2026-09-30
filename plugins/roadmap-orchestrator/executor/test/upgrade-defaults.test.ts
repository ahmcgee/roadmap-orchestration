// upgrade.defaults-unit: the 1.0.0-dev.4 → M2 read-time defaults in src/core/upgrade.ts, unit by unit: the
// park class of a pre-M2 park, the legacy flag, and `legacyNext`, which must equal dev.4's own frontier
// (`nextUnit` and `dispatchBlock`, copied below verbatim from 1.0.0-dev.4 as the oracle, since M2 step 7b
// removed them from the tree) on every constructed log.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Fact, type LogRecord, parseEventLine, prevHash, serializeEvent, unitFfFingerprint } from '../src/core/events.ts';
import { type UnitId, commandId, jobIdOf, needsUserId, opId, opKey, planRev, seatRev, sha256, specRev, unitId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { DEFAULT_BOUNDS, boundsOfRecord, commandBody, obligationRevsOf } from '../src/core/records.ts';
import { Fold } from '../src/core/state.ts';
import {
  applyInputsOf, isLegacy, legacyNext, legacyParkRecord, revisionSourceOf, routingProvenanceOf, rulingsFromLiveFile, transientRulesOf,
} from '../src/core/upgrade.ts';
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

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.5 → M3 (1.0.0-dev.6): byte-preserving readers (G14) and the read-time helpers.

describe('upgrade.defaults-unit (dev.5 → M3)', () => {
  const envelope = { v: 1, seq: 2, prev: H, at: '2026-09-29T12:00:00.000Z', arc: ARC };
  const line = (record: object): string => canonicalJson({ ...envelope, ...record });

  it('dev.5 lines read as written: validated raw, re-serialised byte for byte, normalised only by the helpers', () => {
    const fp = { contractRevs: [], rulingRevs: [{ id: 'C-1', rev: 1 }], specRev: 2, unitCommit: 'b'.repeat(40) };
    const dev5 = [
      line({ type: 'fact', fact: { kind: 'approval', unit: 'a', attempt: 4, fingerprint: fp } }),
      line({ type: 'fact', fact: { kind: 'plan-applied', rev: 3, command: CMD, planSha256: H, specs: { a: H }, changes: [{ type: 'routing', routingRev: REV }] } }),
      line({ type: 'fact', fact: { kind: 'plan-applied', rev: 1, command: null, planSha256: H, specs: { a: H }, changes: [], scheduling: 'dag' } }),
      line({ type: 'fact', fact: { kind: 'dispatch', record: { unit: 'a', specRev: 1, specSha256: H, scope: ['src/**'], riskFloor: 'med', routingRev: REV, implementerSeatRev: 'fedcba9876543210', at: '2026-09-29T12:00:00.000Z' } } }),
      line({ type: 'intent', op: `${ARC}/2`, kind: 'integration.ff', key: 'ff', parent: { type: 'stage', unit: 'a', stage: 'ff', attempt: 5 }, ordinal: 1, deadlineAt: null, expect: { ref: 'refs/heads/main', old: 'a'.repeat(40), new: 'c'.repeat(40), fingerprint: fp }, post: null }),
    ];
    // A dev.5 gate's judgment-inputs carries no captured fingerprint (M3 Checkpoint A): read as written, defaulted when consumed.
    const inputs = line({ type: 'fact', fact: { kind: 'judgment-inputs', unit: 'a', stage: 'gate', attempt: 4, tip: 'a'.repeat(40), head: 'b'.repeat(40), specRev: 2, specSha256: H, planRev: 3, routingRev: REV } });
    assert.equal(serializeEvent(parseEventLine(inputs)), `${inputs}\n`);
    const parsedInputs = parseEventLine(inputs);
    assert.ok(parsedInputs.type === 'fact' && parsedInputs.fact.kind === 'judgment-inputs' && parsedInputs.fact.fingerprint === undefined);
    for (const l of dev5) assert.equal(serializeEvent(parseEventLine(l)), `${l}\n`, l);
    const [approval, applied, first, dispatched, ff] = dev5.map(parseEventLine);
    assert.ok(approval?.type === 'fact' && approval.fact.kind === 'approval');
    assert.deepEqual(obligationRevsOf(approval.fact.fingerprint), [], 'a dev.5 fingerprint selects no obligation');
    assert.ok(applied?.type === 'fact' && applied.fact.kind === 'plan-applied' && first?.type === 'fact' && first.fact.kind === 'plan-applied');
    assert.deepEqual(revisionSourceOf(applied.fact), { type: 'command', command: CMD });
    assert.deepEqual(revisionSourceOf(first.fact), { type: 'start' });
    assert.equal(applied.fact.rulingsSha256, undefined, 'the ledger is read live until the first M3 revision records it');
    assert.ok(dispatched?.type === 'fact' && dispatched.fact.kind === 'dispatch');
    assert.equal(transientRulesOf(dispatched.fact.record), 'dev5');
    assert.deepEqual(boundsOfRecord(dispatched.fact.record), DEFAULT_BOUNDS);
    assert.ok(ff?.type === 'intent' && ff.kind === 'integration.ff');
    assert.deepEqual(unitFfFingerprint(ff.expect), fp, 'a dev.5 ff is a unit ff');
    // An M3 record states what the helpers default.
    assert.equal(transientRulesOf({ ...dispatched.fact.record, transientRules: 'm3' }), 'm3');
    assert.deepEqual(revisionSourceOf({ ...applied.fact, source: { type: 'bundle', job: jobIdOf('ckpt-1') }, command: null }), { type: 'bundle', job: 'ckpt-1' });
  });

  it('a dev.5 apply command keeps its bytes and reads as the ledger live, no obligations or vision (G15)', () => {
    const body = { type: 'apply', expectRev: null, manifest: { planSha256: H, specs: { a: H } } };
    const parsed = commandBody(body, 'body');
    assert.ok(parsed.type === 'apply');
    assert.equal(canonicalJson(parsed), canonicalJson(body));
    assert.deepEqual(applyInputsOf(parsed.manifest), { rulings: 'live', obligations: null, vision: null });
    const m3 = { planSha256: H, specs: { a: H }, rulings: { ledgerSha256: H2, sidecars: {} }, obligations: null, vision: H2 };
    const read = commandBody({ ...body, manifest: m3 }, 'body');
    assert.ok(read.type === 'apply');
    assert.deepEqual(applyInputsOf(read.manifest), { rulings: m3.rulings, obligations: null, vision: H2 });
  });

  it('rulingsFromLiveFile reads the ledger file; routingProvenanceOf rebuilds only a dev.5 revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-upgrade-'));
    const path = join(dir, 'rulings.md');
    writeFileSync(path, 'C-1 — a rule\n');
    assert.equal(rulingsFromLiveFile(path).toString('utf8'), 'C-1 — a rule\n');
    const provenance = { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} } as const;
    const applied = parseEventLine(line({ type: 'fact', fact: { kind: 'plan-applied', rev: 1, command: null, planSha256: H, specs: { a: H }, changes: [] } }));
    assert.ok(applied.type === 'fact' && applied.fact.kind === 'plan-applied');
    let rebuilt = 0;
    assert.deepEqual(routingProvenanceOf(applied.fact, () => { rebuilt += 1; return provenance; }), provenance);
    assert.equal(rebuilt, 1);
    const recorded = { ...provenance, profile: 'claude-only' } as const;
    assert.deepEqual(routingProvenanceOf({ ...applied.fact, routingProvenance: recorded }, () => { throw new Error('rebuilt a recorded provenance'); }), recorded);
  });
});
