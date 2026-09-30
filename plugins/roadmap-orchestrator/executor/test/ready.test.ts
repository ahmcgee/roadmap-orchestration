// Readiness, admission and rank (src/schedule/ready.ts): pure over folded logs built here record by record.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Event, type Fact, type LogRecord, type ProbeTarget, prevHash, serializeEvent } from '../src/core/events.ts';
import {
  type CommandId, type NeedsUserId, type UnitId, commandId, edgeId, invocationId, needsUserId, opId, opKey, planRev, seatRev, sha, sha256,
  specRev, unitId,
} from '../src/core/ids.ts';
import type { NeedsUserReason } from '../src/core/records.ts';
import { Fold } from '../src/core/state.ts';
import { legacyNext } from '../src/core/upgrade.ts';
import { absPath, branchName, isoTime, planPath, refName, repoPath, repoPattern } from '../src/core/values.ts';
import { PLAN_SCHEMA, type PlanM1, type PlanUnit } from '../src/input/plan.ts';
import { arcStack, resolveRouting } from '../src/routing/layers.ts';
import type { RiskTier } from '../src/routing/types.ts';
import { type ReadyInput, type SpecFactsOf, admitter, rankOf, ready } from '../src/schedule/ready.ts';
import { type AdmissionStage, type AdmitInput, type CommandScope, type Rank, PROMOTION_BYPASS, compareRank } from '../src/schedule/types.ts';
import { ARC, H, REV, chain } from './fixtures/log-records.ts';

const ROUTING = resolveRouting(arcStack('default', null, null)).table;
const CMD = commandId('cmd-0123456789abcdef');
const LATER = isoTime('2026-09-25T12:30:00.000Z');
const H2 = sha256('e'.repeat(64));
const [A, B, C, D, K, P, Q, M, HI] = ['a', 'b', 'c', 'd', 'k', 'p', 'q', 'm', 'hi'].map((s) => unitId(s)) as [UnitId, UnitId, UnitId, UnitId, UnitId, UnitId, UnitId, UnitId, UnitId];

// ---------------------------------------------------------------------------------------------------
// Plans and records

const unit = (id: UnitId, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  id, spec: planPath(`specs/${id}.json`), risk: 'med', scope: [repoPattern('src/**')], resources: [], after: [], contingent: [], ...extra,
});
const planOf = (units: readonly PlanUnit[]): PlanM1 => ({
  schema: PLAN_SCHEMA, arc: ARC, integrationBranch: branchName('main'), baseline: sha('a'.repeat(40)), worktreeRoot: absPath('/wt'), contracts: [],
  rulings: planPath('rulings.md'), architectureDoc: repoPath('ARCH.md'), direction: 'd', suite: { lanes: [] }, resources: [], units,
});

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const outcome = (u: UnitId, stage: string, attempt: number, out: string, cls: string, extra: object = {}): LogRecord =>
  fact({ kind: 'stage-outcome', unit: u, stage, attempt, outcome: out, class: cls, chargeable: false, ...extra });
const dispatch = (u: UnitId, riskFloor: RiskTier = 'med'): LogRecord => fact({
  kind: 'dispatch', record: { unit: u, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor, routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: LATER },
});
const planApplied = (rev: number, units: readonly UnitId[], changes: readonly object[], scheduling: 'dag' | 'legacy'): LogRecord => fact({
  kind: 'plan-applied', rev: planRev(rev), command: rev === 1 ? null : commandId(`cmd-${String(rev).padStart(16, '0')}`), planSha256: H,
  specs: Object.fromEntries(units.map((u) => [u, H])), changes, ...(scheduling === 'dag' && rev === 1 ? { scheduling } : {}),
});

/** A log under construction: records appended in order, folded and indexed on demand. */
class Log {
  readonly records: LogRecord[] = [];
  readonly scheduling: 'dag' | 'legacy';
  #rev = 0;

  /** `units`: the baseline revision's units; null starts the log without one (a dev.4 log dispatched before it). */
  constructor(scheduling: 'dag' | 'legacy', units: readonly UnitId[] | null) {
    this.scheduling = scheduling;
    if (units !== null) this.plan(units, []);
  }

  add(...records: LogRecord[]): number {
    this.records.push(...records);
    return this.records.length;
  }

  /** The next plan revision, naming `units`. */
  plan(units: readonly UnitId[], changes: readonly object[]): number {
    this.#rev += 1;
    return this.add(planApplied(this.#rev, units, changes, this.scheduling));
  }

  /** A published `integration.ff` of `u` and its retiring snapshot outcome: the unit merged. Returns the ff done's seq. */
  merge(u: UnitId, attempt: number): number {
    const seq = this.records.length + 1;
    const op = opId(ARC, seq);
    const fingerprint = { unitCommit: sha('b'.repeat(40)), specRev: specRev(1), contractRevs: [], rulingRevs: [] };
    this.add(
      { type: 'intent', op, kind: 'integration.ff', key: opKey(`ff:${u}`), parent: { type: 'stage', unit: u, stage: 'ff', attempt }, ordinal: 1, deadlineAt: null,
        expect: { ref: refName('refs/heads/main'), old: sha('c'.repeat(40)), new: sha('d'.repeat(40)), fingerprint }, post: null } as LogRecord,
      { type: 'done', op, kind: 'integration.ff', outcome: { kind: 'published' }, recoveredBy: null } as LogRecord,
    );
    const done = this.records.length;
    this.add(outcome(u, 'snapshot', attempt + 1, 'published', 'retire'));
    return done;
  }

  /** A blocking needs-user raised for `u`'s park at `stage`#`attempt`; returns its id. */
  raise(u: UnitId, stage: string, attempt: number): NeedsUserId {
    const seq = this.records.length + 1;
    const op = opId(ARC, seq);
    const id = needsUserId(`nu-${seq}`);
    this.add(
      { type: 'intent', op, kind: 'needsuser.raise', key: opKey(`needs-user:${seq}`), parent: { type: 'stage', unit: u, stage, attempt }, ordinal: 1, deadlineAt: null,
        expect: { id, path: absPath(`/run/needs-user/nu-${seq}.json`), blocking: true }, post: { sha256: H } } as LogRecord,
      { type: 'done', op, kind: 'needsuser.raise', outcome: { kind: 'raised' }, recoveredBy: null } as LogRecord,
    );
    return id;
  }

  events(): Event[] {
    return chain(this.records);
  }

  view(): Fold {
    const f = new Fold(ARC);
    for (const e of this.events()) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    return f;
  }
}

type Extras = Partial<Pick<AdmitInput, 'blocking' | 'drains' | 'tripped'>>;

/** No unit reproduces a mutant or repairs an obligation: what a spec says, for logs that hold no finding. */
const NO_REPAIRS: SpecFactsOf = () => ({ reproduces: false, repairs: new Set() });

const inputOf = (log: Log, plan: PlanM1, extras: Extras = {}): ReadyInput => ({
  view: log.view(), plan, blocking: [], drains: [], tripped: [], routing: () => ROUTING, spec: NO_REPAIRS, ...extras,
});
const readyOf = (log: Log, plan: PlanM1, extras: Extras = {}): readonly (readonly [UnitId, AdmissionStage])[] =>
  ready(inputOf(log, plan, extras)).map((r) => [r.unit.id, r.stage] as const);

// ---------------------------------------------------------------------------------------------------

describe('fold: rank lookups (JournalView.decidedSeq, publications, addedSeq)', () => {
  it('tracks the decided outcome\'s seq through holds, park and recovery; publications in log order; each unit\'s first naming', () => {
    const log = new Log('dag', [A, B]);
    assert.deepEqual([log.view().decidedSeq(A), log.view().addedSeq(A), log.view().addedSeq(C)], [null, 1, null]);
    log.add(dispatch(A));
    const advanced = log.add(outcome(A, 'teardown', 1, 'released', 'advance'));
    log.add(outcome(A, 'lanes', 2, 'interrupted', 'hold'));
    assert.equal(log.view().decidedSeq(A), advanced, 'a hold decides nothing');
    const parked = log.add(outcome(A, 'lanes', 3, 'cleanup-failed', 'park', { park: { class: 'retryable', targets: [{ type: 'host' }] } }));
    assert.equal(log.view().decidedSeq(A), parked);
    log.add(fact({ kind: 'probe', target: { type: 'host' }, covers: [parked], result: 'pass', nextProbeAt: null }));
    assert.equal(log.view().decidedSeq(A), advanced, 'a recovery restores the pre-park decision and its seq');
    const added = log.plan([A, B, C], [{ type: 'unit-added', unit: C }]);
    log.plan([A, B, C], []);
    log.add(dispatch(B));
    const ffB = log.merge(B, 1);
    log.add(dispatch(C));
    const ffC = log.merge(C, 1);
    const view = log.view();
    assert.equal(view.addedSeq(C), added);
    assert.equal(view.addedSeq(B), 1);
    assert.deepEqual(view.publications(), [{ unit: B, seq: ffB }, { unit: C, seq: ffC }]);
  });
});

describe('ready: DAG arcs', () => {
  it('ready.merged-only: a dependent waits until its dependency merged, not when it parks (acknowledged or not); through a lineage once the head prepared', () => {
    const plan = planOf([unit(A), unit(B, { after: [A] }), unit(C, { after: [A] }), unit(D)]);
    const log = new Log('dag', [A, B, C, D]);
    assert.deepEqual(readyOf(log, plan), [[A, 'plan-check'], [D, 'plan-check']], 'undispatched units without dependencies run in parallel');

    log.add(dispatch(A), outcome(A, 'lanes', 1, 'blocked', 'park', { park: { class: 'operator', kind: 'env' } }));
    const nu = log.raise(A, 'lanes', 1);
    log.add(fact({ kind: 'needs-user-acked', id: nu, command: CMD, choice: null }));
    assert.deepEqual(readyOf(log, plan), [[D, 'plan-check']], 'D1: a parked dependency holds its dependents even acknowledged');

    const merged = new Log('dag', [A, B, C, D]);
    merged.add(dispatch(A));
    merged.merge(A, 1);
    assert.deepEqual(readyOf(merged, plan), [[D, 'plan-check'], [B, 'plan-check'], [C, 'plan-check']], 'B and C wait from A\'s publication, D from its addition');

    // A2 re-enters the parked A (F15): the edges on A move to A2 only once A2 prepared, and are met when A2 merges.
    const A2 = unitId('a2');
    const plan2 = planOf([...plan.units, unit(A2, { reenters: { unit: A } })]);
    log.plan([A, B, C, D, A2], [{ type: 'unit-added', unit: A2 }, { type: 'unit-reentered', unit: A2, reenters: A, reset: false }]);
    assert.deepEqual(readyOf(log, plan2), [[D, 'plan-check'], [A2, 'prepare']]);
    log.add(dispatch(A2), outcome(A2, 'prepare', 2, 'clean-verify', 'advance'));
    assert.deepEqual(readyOf(log, plan2), [[D, 'plan-check'], [A2, 'lanes']], 'prepared: the edge is on A2, which has not merged');
    log.merge(A2, 3);
    assert.deepEqual(readyOf(log, plan2), [[D, 'plan-check'], [B, 'plan-check'], [C, 'plan-check']]);
  });

  it('ready.contingent: a unit waits for each contingent edge\'s edge-resolved fact, which also starts its wait', () => {
    const e = edgeId('e-top');
    const plan = planOf([unit(A), unit(C, { contingent: [{ id: e, condition: 'the upstream API landed' }] })]);
    const log = new Log('dag', [A, C]);
    assert.deepEqual(readyOf(log, plan), [[A, 'plan-check']]);
    const seq = log.add(fact({ kind: 'edge-resolved', edge: e, command: CMD, evidence: 'landed upstream' }));
    const r = ready(inputOf(log, plan));
    assert.deepEqual(r.map((x) => x.unit.id), [A, C]);
    assert.equal(r[1]?.rank.waitStartSeq, seq);
    assert.equal(r[0]?.rank.waitStartSeq, 1, 'A waits since its addition');
  });

  it('ready.run-only: only allowlisted units are offered while an allowlist is in force; clearing it offers every unit again', () => {
    const plan = planOf([unit(A), unit(B), unit(C, { after: [A] })]);
    const log = new Log('dag', [A, B, C]);
    log.add(fact({ kind: 'run-only', command: CMD, units: [B, C] }));
    assert.deepEqual(readyOf(log, plan), [[B, 'plan-check']], 'C is allowed but still waits on A');
    const view = log.view();
    assert.deepEqual(admitter(() => ROUTING, NO_REPAIRS)({ view, plan, unit: unit(A), stage: 'plan-check', blocking: [], drains: [], tripped: [] }), { kind: 'wait', constraints: [{ type: 'run-only' }] });
    log.add(fact({ kind: 'run-only', command: CMD, units: null }));
    assert.deepEqual(readyOf(log, plan), [[A, 'plan-check'], [B, 'plan-check']]);
  });

  it('offers no held, parked or paused unit, and none whose next stage is a chain stage', () => {
    const plan = planOf([unit(A), unit(B), unit(C), unit(D)]);
    const log = new Log('dag', [A, B, C, D]);
    log.add(dispatch(A), outcome(A, 'build', 1, 'interrupted', 'hold'));
    log.add(dispatch(B), outcome(B, 'build', 1, 'success', 'advance'));
    log.add(fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: C } }));
    assert.deepEqual(readyOf(log, plan), [[D, 'plan-check']]);
  });
});

describe('ready: legacy arcs (G4)', () => {
  const plan = planOf([unit(A), unit(B), unit(C, { after: [A] })]);

  /** ready() offers exactly legacyNext's frontier when it is unblocked (no admission constraint holds here). */
  function frontier(log: Log, expected: readonly UnitId[]): void {
    const view = log.view();
    const f = legacyNext(view, plan.units);
    const unblocked = f !== null && f.block === null ? [f.unit] : [];
    const got = ready(inputOf(log, plan)).map((r) => r.unit.id);
    assert.deepEqual(got, unblocked, 'equivalent to legacyNext');
    assert.deepEqual(got, expected);
  }

  const parkAt = (log: Log, u: UnitId, attempt = 1): NeedsUserId => {
    log.add(dispatch(u), outcome(u, 'gate', attempt, 'empty-diff', 'park'));
    return log.raise(u, 'gate', attempt);
  };

  it('ready.legacy-chain: one unit at a time in plan order; past a park; explicit after released by the acknowledgement', () => {
    const log = new Log('legacy', [A, B, C]);
    frontier(log, [A]);
    const nuA = parkAt(log, A);
    frontier(log, [B]);
    parkAt(log, B);
    frontier(log, []);
    assert.match(legacyNext(log.view(), plan.units)?.block ?? '', /held after a/);
    log.add(fact({ kind: 'needs-user-acked', id: nuA, command: CMD, choice: null }));
    frontier(log, [C]);
    log.add(fact({ kind: 'paused', command: CMD, target: { type: 'all' } }));
    frontier(log, []);
  });

  it('ready.legacy-chain: A and B parked, then A reopened, makes A the frontier again', () => {
    const log = new Log('legacy', [A, B, C]);
    parkAt(log, A);
    parkAt(log, B);
    frontier(log, []);
    log.add(fact({ kind: 'reopened', unit: A, command: CMD, specRev: specRev(2), specSha256: H2 }));
    frontier(log, [A]);
    assert.deepEqual(readyOf(log, plan), [[A, 'plan-check']]);
  });

  it('ready.legacy-chain: a dev.4 log (dispatched before its baseline revision) stays serial; the frontier waits on admission too', () => {
    const log = new Log('legacy', null);
    log.add(dispatch(A));
    log.plan([A, B, C], []);
    frontier(log, [A]);
    const blocked = ready({ ...inputOf(log, plan), tripped: [], blocking: [{ id: needsUserId('nu-9'), reason: 'recovery-required', subject: 'arc', unit: null }] });
    assert.deepEqual(blocked, []);
  });
});

describe('admit (A12, A17)', () => {
  const med = unit(M);
  const high = unit(HI, { risk: 'high' });
  const plan = planOf([med, high]);
  const STAGES = ['prepare', 'plan-check', 'build', 'lanes', 'gate', 'candidate'] as const;
  type Blocking = AdmitInput['blocking'][number];
  const item = (reason: NeedsUserReason, subject: Blocking['subject'] = 'arc', u: UnitId | null = null): Blocking =>
    ({ id: needsUserId(`nu-${100 + reason.length}`), reason, subject, unit: u });

  function admits(log: Log, u: PlanUnit, extras: Extras = {}): Readonly<Record<AdmissionStage, unknown>> {
    const admit = admitter(() => ROUTING, NO_REPAIRS);
    const view = log.view();
    return Object.fromEntries(STAGES.map((stage) => {
      const a = admit({ view, plan, unit: u, stage, blocking: [], drains: [], tripped: [], ...extras });
      return [stage, a.kind === 'admit' ? 'admit' : a.constraints];
    })) as Record<AdmissionStage, unknown>;
  }

  const fresh = (): Log => {
    const log = new Log('dag', [M, HI]);
    log.add(dispatch(M, 'med'), dispatch(HI, 'high'));
    return log;
  };

  it('admit.constraints: a parked backend blocks exactly the stages that call it', () => {
    assert.equal(ROUTING.build.med.backend, 'codex', 'default routing: the efficient class builds med on Codex');
    assert.equal(ROUTING.build.high.backend, 'claude');
    assert.equal(ROUTING.gate.med.backend, 'claude');
    const codex = fresh();
    codex.add(fact({ kind: 'backend-park', backend: 'codex', class: 'capacity', inv: invocationId(opId(ARC, 99), 1) }));
    const parked = { type: 'backend-parked', backend: 'codex', class: 'capacity' };
    assert.deepEqual(admits(codex, med), { prepare: 'admit', 'plan-check': 'admit', build: [parked], lanes: 'admit', gate: 'admit', candidate: 'admit' });
    assert.equal(admits(codex, high).build, 'admit', 'a high build sits on Claude');

    const limited = fresh();
    limited.add(fact({ kind: 'backend-park', backend: 'claude', class: 'usage-limit', inv: invocationId(opId(ARC, 99), 1) }));
    const lim = { type: 'backend-parked', backend: 'claude', class: 'usage-limit' };
    assert.deepEqual(admits(limited, med), { prepare: 'admit', 'plan-check': [lim], build: 'admit', lanes: 'admit', gate: [lim], candidate: 'admit' });
    assert.deepEqual(admits(limited, high).build, [lim]);
  });

  it('admit.constraints: breakers, base-red and arc-blocking items', () => {
    const log = fresh();
    const host: ProbeTarget = { type: 'host' };
    assert.deepEqual(admits(log, med, { tripped: [host, { type: 'resource', instance: 'estate#1' as never }] }), {
      prepare: 'admit', 'plan-check': 'admit', build: [{ type: 'breaker', target: host }], lanes: [{ type: 'breaker', target: host }], gate: 'admit', candidate: 'admit',
    });
    const codexT: ProbeTarget = { type: 'backend', backend: 'codex' };
    assert.deepEqual(admits(log, med, { tripped: [codexT] }).build, [{ type: 'breaker', target: codexT }]);
    assert.equal(admits(log, high, { tripped: [codexT] }).build, 'admit');

    assert.deepEqual(admits(log, med, { blocking: [item('base-red'), item('lane-blocked', 'unit', HI)] }), {
      prepare: 'admit', 'plan-check': 'admit', build: 'admit', lanes: 'admit', gate: 'admit', candidate: [{ type: 'base-red' }],
    });
    for (const b of [item('recovery-required'), item('log-corrupt', 'arc'), item('supervisor-crash-limit'), item('residue', 'host')]) {
      const all = admits(log, med, { blocking: [b] });
      for (const s of STAGES) assert.deepEqual(all[s], [{ type: 'blocking-item', id: b.id, reason: b.reason }], `${b.reason} blocks ${s}`);
    }
  });

  it('p1.blocks-selecting: an active P1 over an obligation a candidate\'s approval selects holds its candidate admission alone; its repair is admitted; a ruled P1 holds nothing (G10)', () => {
    const log = fresh();
    const I1 = 'I-1';
    const fingerprint = { unitCommit: sha('b'.repeat(40)), specRev: specRev(1), contractRevs: [], rulingRevs: [], obligationRevs: [{ id: I1, rev: 1 }] };
    log.add(fact({ kind: 'approval', unit: M, attempt: 5, fingerprint }), fact({ kind: 'approval', unit: HI, attempt: 5, fingerprint: { ...fingerprint, obligationRevs: [{ id: 'I-2', rev: 1 }] } }));
    log.add(fact({
      kind: 'finding-opened', id: 'F-1', key: H2, lens: 'witness', severity: 'P1', obligation: I1, visionClauses: [], claim: 'I-1 is not held', evidence: [],
      mutant: null, source: { type: 'job', job: 'audit-1' }, gateHadPassed: true,
    }));
    const blocked = [{ type: 'finding-blocked', finding: 'F-1', obligation: I1 }];
    assert.deepEqual(admits(log, med), { prepare: 'admit', 'plan-check': 'admit', build: 'admit', lanes: 'admit', gate: 'admit', candidate: blocked }, 'only the candidate waits');
    assert.equal(admits(log, high).candidate, 'admit', 'a candidate selecting other obligations is not held');
    const repairs: SpecFactsOf = (u) => ({ reproduces: false, repairs: new Set(u.id === M ? [I1 as never] : []) });
    const view = log.view();
    assert.deepEqual(admitter(() => ROUTING, repairs)({ view, plan, unit: med, stage: 'candidate', blocking: [], drains: [], tripped: [] }), { kind: 'admit' }, 'p1.repair-exempt: the declared repair is admitted');
    log.add(fact({ kind: 'finding-transition', id: 'F-1', to: { state: 'ruled', disposition: 'dismissed', by: { type: 'checkpoint', job: 'ckpt-1' } } }));
    assert.equal(admits(log, med).candidate, 'admit', 'a ruled finding blocks nothing');
    // A reproduce runs a lane: the host breaker holds it as it holds lanes.
    assert.deepEqual(admitter(() => ROUTING, NO_REPAIRS)({ view: log.view(), plan, unit: med, stage: 'reproduce', blocking: [], drains: [], tripped: [{ type: 'host' }] }),
      { kind: 'wait', constraints: [{ type: 'breaker', target: { type: 'host' } }] });
  });

  it('admit.constraints: pause, drain and run-only hold per unit and are all reported', () => {
    const log = fresh();
    const drain = (scope: CommandScope, command: CommandId = CMD) => ({ command, scope });
    assert.equal(admits(log, med, { drains: [drain({ type: 'none' }), drain({ type: 'units', units: [HI] })] }).build, 'admit');
    assert.deepEqual(admits(log, high, { drains: [drain({ type: 'units', units: [HI] })] }).gate, [{ type: 'drain', command: CMD }]);
    log.add(fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: M } }));
    assert.equal(admits(log, high).build, 'admit');
    assert.deepEqual(admits(log, med).build, [{ type: 'paused', scope: 'unit' }]);
    log.add(fact({ kind: 'paused', command: CMD, target: { type: 'all' } }), fact({ kind: 'run-only', command: CMD, units: [HI] }));
    const other = commandId('cmd-00000000000000ff');
    assert.deepEqual(admits(log, med, { drains: [drain({ type: 'arc' }, other)], blocking: [item('recovery-required')] }).lanes, [
      { type: 'paused', scope: 'arc' }, { type: 'paused', scope: 'unit' }, { type: 'drain', command: other }, { type: 'run-only' },
      { type: 'blocking-item', id: item('recovery-required').id, reason: 'recovery-required' },
    ]);
  });
});

describe('priority and aging (F17)', () => {
  it('prio.age-before-origin: a checkpoint outranks an older planned waiter until both are promoted; then age alone decides', () => {
    const [X1, X2, X3] = ['x1', 'x2', 'x3'].map((s) => unitId(s)) as [UnitId, UnitId, UnitId];
    const plan = planOf([unit(P), unit(X1), unit(X2), unit(X3), unit(K, { origin: 'checkpoint' })]);
    const log = new Log('dag', [P, X1, X2, X3]);
    const added = log.plan([P, X1, X2, X3, K], [{ type: 'unit-added', unit: K }]);
    assert.deepEqual(ready(inputOf(log, plan)).map((r) => r.unit.id), [K, P, X1, X2, X3], 'unpromoted: origin, then age, then plan index');

    log.add(dispatch(X1));
    log.merge(X1, 1);
    log.add(dispatch(X2));
    log.merge(X2, 1);
    const two = ready(inputOf(log, plan));
    assert.deepEqual(two.map((r) => [r.unit.id, r.rank.bypassMerges, r.rank.promoted]), [[K, 2, false], [P, 2, false], [X3, 2, false]]);

    log.add(dispatch(X3));
    log.merge(X3, 1);
    const three = ready(inputOf(log, plan));
    assert.deepEqual(three.map((r) => r.rank), [
      { unit: P, origin: 'planned', waitStartSeq: 1, bypassMerges: 3, promoted: true, planIndex: 0 },
      { unit: K, origin: 'checkpoint', waitStartSeq: added, bypassMerges: 3, promoted: true, planIndex: 4 },
    ], 'both promoted: the older planned unit first');
    const view = log.view();
    assert.ok(compareRank(rankOf(view, plan, P), rankOf(view, plan, K)) < 0);
  });

  it('prio.repair-first: a repair unit outranks checkpoint and planned waiters, older ones included (R6), until they are promoted', () => {
    const R = unitId('r');
    const plan = planOf([unit(P), unit(K, { origin: 'checkpoint' }), unit(R, { origin: 'repair' })]);
    const log = new Log('dag', [P]);
    log.plan([P, K], [{ type: 'unit-added', unit: K }]);
    log.plan([P, K, R], [{ type: 'unit-added', unit: R }]);
    const order = ready(inputOf(log, plan));
    assert.deepEqual(order.map((r) => [r.unit.id, r.rank.origin]), [[R, 'repair'], [K, 'checkpoint'], [P, 'planned']], 'origin before age: repair 0, checkpoint 1, planned 2');
    assert.ok(order[0]!.rank.waitStartSeq > order[2]!.rank.waitStartSeq, 'the repair is the youngest waiter');
    const view = log.view();
    assert.ok(compareRank(rankOf(view, plan, R), rankOf(view, plan, K)) < 0 && compareRank(rankOf(view, plan, K), rankOf(view, plan, P)) < 0);
    // M2's aging stands: promoted waiters go first, by age alone.
    const X = unitId('x');
    const plan2 = planOf([...plan.units, unit(X)]);
    log.plan([P, K, R, X], [{ type: 'unit-added', unit: X }]);
    for (let i = 0; i < PROMOTION_BYPASS; i++) {
      const u = unitId(`m${i}`);
      log.plan([P, K, R, X, u], [{ type: 'unit-added', unit: u }]);
      log.add(dispatch(u));
      log.merge(u, 1);
    }
    const aged = ready(inputOf(log, plan2)).map((r) => [r.unit.id, r.rank.promoted]);
    assert.deepEqual(aged.slice(0, 3), [[P, true], [K, true], [R, true]], 'every waiter promoted: the oldest first, whatever its origin');
  });

  it('prio.bypass-promotion: an endless stream of checkpoint units starves a planned waiter only until it is promoted', () => {
    // One overlapping resource: each grant goes to the head of the ready order, and the granted unit publishes.
    // Q (planned, undispatched) waits from seq 1; P (planned) from its plan-check approval, so Q is older.
    const units: PlanUnit[] = [unit(Q), unit(P)];
    const log = new Log('dag', [Q, P]);
    log.add(dispatch(P), outcome(P, 'plan-check', 1, 'approve', 'advance'));
    const grants: { unit: UnitId; rank: Rank; p: Rank }[] = [];
    let pGranted = false;
    for (let round = 1; round <= 20 && !pGranted; round += 1) {
      const ck = unitId(`c${round}`);
      units.push(unit(ck, { origin: 'checkpoint' }));
      log.plan(units.map((u) => u.id), [{ type: 'unit-added', unit: ck }]);
      const plan = planOf(units);
      const order = ready(inputOf(log, plan));
      const head = order[0];
      const p = order.find((r) => r.unit.id === P);
      assert.ok(head !== undefined && p !== undefined, 'P waits for build throughout');
      grants.push({ unit: head.unit.id, rank: head.rank, p: p.rank });
      if (head.unit.id === P) pGranted = true;
      else log.merge(head.unit.id, 1);
    }

    assert.deepEqual(grants.map((g) => g.unit), [unitId('c1'), unitId('c2'), unitId('c3'), Q, P]);
    assert.deepEqual(grants.map((g) => g.p.bypassMerges), [0, 1, 2, 3, 4]);
    const promotedAt = grants.findIndex((g) => g.p.promoted);
    assert.equal(grants[promotedAt]?.p.bypassMerges, PROMOTION_BYPASS);
    for (const g of grants.slice(0, promotedAt)) assert.equal(g.rank.origin, 'checkpoint', 'unpromoted, P loses to every checkpoint unit');
    // The graded property: once P is promoted, every grant goes to P or to a unit promoted before it by age.
    for (const g of grants.slice(promotedAt)) {
      assert.ok(g.unit === P || (g.rank.promoted && compareRank(g.rank, g.p) < 0), `grant to ${g.unit} after P's promotion`);
    }
  });
});
