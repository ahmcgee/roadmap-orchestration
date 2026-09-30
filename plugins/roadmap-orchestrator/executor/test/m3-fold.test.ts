// M3 fold cases (src/core/state.ts, frozen in step 0a): findings, audits, checkpoints and bundles, divergences and
// digests, draining, completion (A20), the holistic flag (A5), per-unit bounds (`limits`), job-owned residues (G4)
// and a batch publication retiring its members (R7, H4).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Event, type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type UnitId, commandId, invocationId, jobId, opId, opKey, planRev, seatRev, sha, sha256, specRev, unitId } from '../src/core/ids.ts';
import { DEFAULT_BOUNDS } from '../src/core/records.ts';
import { Fold, FoldInvariantError } from '../src/core/state.ts';
import { isoTime, repoPattern } from '../src/core/values.ts';
import { ARC, H, REV, U1, chain } from './fixtures/log-records.ts';

const U2 = unitId('u2');
const CMD = commandId('cmd-0123456789abcdef');
const CMD2 = commandId('cmd-0123456789abcde2');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const C = sha('c'.repeat(40));
const V = sha256('e'.repeat(64));
const AT = isoTime('2026-09-30T12:00:00.000Z');

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const planApplied = (rev: number, extra: object = {}, changes: readonly object[] = []): LogRecord => fact({
  kind: 'plan-applied', rev: planRev(rev), command: rev === 1 ? null : CMD, planSha256: H, specs: { u1: H, u2: H }, changes,
  ...(rev === 1 ? { scheduling: 'dag' } : {}), ...extra,
});
const holisticPlan = (rev: number, extra: object = {}, changes: readonly object[] = []): LogRecord => planApplied(rev, { visionSha256: V, ...extra }, changes);
const opened = (n: number, key = H, extra: object = {}): LogRecord => fact({
  kind: 'finding-opened', id: `F-${n}`, key, lens: 'invariants', severity: 'P1', obligation: 'I-1', visionClauses: [], claim: 'c', evidence: [], mutant: null,
  source: { type: 'job', job: 'audit-1' }, gateHadPassed: false, ...extra,
});
const move = (n: number, to: object): LogRecord => fact({ kind: 'finding-transition', id: `F-${n}`, to });
const auditStarted = (n: number, lenses: readonly string[] = ['invariants', 'vision']): LogRecord => fact({
  kind: 'audit-started', job: `audit-${n}`, triggers: [{ type: 'cadence' }], generation: 1, lenses, integrationSha: A, planRev: 1, ledgerSha256: null,
  obligationsSha256: null, visionSha256: V, owners: [], priorFindings: [], highWater: 1,
});
const auditEnded = (n: number, covered: readonly object[] = [{ lens: 'invariants', from: B, to: A }], findings: readonly string[] = []): LogRecord => fact({
  kind: 'audit-ended', job: `audit-${n}`, covered, findings, suppressed: 0, outcome: 'completed',
});
const ckptInputs = (n: number): LogRecord => fact({
  kind: 'checkpoint-inputs', job: `ckpt-${n}`, trigger: { type: 'audit', job: 'audit-1' }, generation: 1,
  vector: { plan: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256: V, contracts: [] }, headSha: A, visionSha256: V, findings: [], observations: [],
});
const decided = (n: number): LogRecord => fact({ kind: 'bundle-decided', job: `ckpt-${n}`, outcome: { kind: 'no-op' } });
const divergence = (n: number, job: string, index: number): LogRecord => fact({
  kind: 'divergence', id: `D-${n}`, index, job, type: 'interpretation', from: 'V-1', what: 'w', cites: ['V-1'], evidence: ['e'],
  preimage: { planRev: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] }, compensation: { hint: 'h', kind: 'none' },
});
const digest = (seq: number, ids: readonly string[]): LogRecord => fact({ kind: 'divergence-digest', needsUser: `nu-${seq}`, ids });
const dispatch = (unit: UnitId, bounds?: object): LogRecord => fact({
  kind: 'dispatch', record: {
    unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: AT,
    ...(bounds === undefined ? {} : { transientRules: 'm3', bounds }),
  },
});
const chargeable = (unit: UnitId, attempt: number, cls: string): LogRecord =>
  fact({ kind: 'stage-outcome', unit, stage: 'lanes', attempt, outcome: 'red', class: cls, chargeable: true, ...(cls === 'park' ? { park: { class: 'operator', kind: 'design' } } : {}) });
const completed = (rev: number, head = A, highWater = 1): LogRecord => fact({ kind: 'arc-completed', planRev: rev, head, highWater, units: ['u1'] });

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

describe('fold: findings', () => {
  it('open in id order; a key of a live finding merges, a terminal one does not; moves follow the state machine', () => {
    const f = folded([holisticPlan(1), opened(1), move(1, { state: 'owned', unit: 'u1' }), move(1, { state: 'fixed-on-branch', unit: 'u1' }), move(1, { state: 'resolved' }), opened(2)]);
    const [f1, f2] = f.holistic().findings;
    assert.equal(f1?.state, 'resolved');
    assert.equal(f1?.owner, 'u1');
    assert.equal(f2?.state, 'open');
    assert.equal(f.nextFindingId(), 'F-3');
    refuses([holisticPlan(1), opened(2)], 2, /F-2 opened; the next finding is F-1/);
    refuses([holisticPlan(1), opened(1), opened(2)], 3, /has the key of F-1, which is open/);
    refuses([holisticPlan(1), opened(1), move(1, { state: 'resolved' })], 3, /open → resolved/);
    refuses([holisticPlan(1), opened(1), move(1, { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } }), move(1, { state: 'open' })], 4, /ruled → open/);
    refuses([holisticPlan(1), move(1, { state: 'resolved' })], 2, /never opened/);
  });
});

describe('fold: audits and checkpoints', () => {
  it('audits open in order, one at a time, and end covering only lenses they ran', () => {
    const f = folded([holisticPlan(1), auditStarted(1), opened(1), auditEnded(1, [{ lens: 'invariants', from: B, to: A }], ['F-1']), auditStarted(2)]);
    const audits = f.holistic().audits;
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0]?.ended?.covered, [{ lens: 'invariants', from: B, to: A }]);
    assert.equal(audits[1]?.ended, null);
    assert.equal(f.nextJobId('audit'), jobId('audit', 3));
    refuses([holisticPlan(1), auditStarted(2)], 2, /audit-2 opened; the next audit job is audit-1/);
    refuses([holisticPlan(1), auditStarted(1), auditStarted(2)], 3, /while audit-1 is running/);
    refuses([holisticPlan(1), auditStarted(1, ['vision']), auditEnded(1)], 3, /covers lens invariants, which it did not run/);
    refuses([holisticPlan(1), auditStarted(1), auditEnded(1, [], ['F-9'])], 3, /finding F-9, which was never opened/);
    refuses([holisticPlan(1), auditEnded(1)], 2, /not running/);
  });

  it('a checkpoint decides once: a bundle outcome, or the plan revision its bundle applied', () => {
    const f = folded([holisticPlan(1), ckptInputs(1), decided(1), ckptInputs(2), holisticPlan(2, { command: null, source: { type: 'bundle', job: 'ckpt-2' } })]);
    const [c1, c2] = f.holistic().checkpoints;
    assert.deepEqual(c1?.decided, { kind: 'no-op' });
    assert.deepEqual(c2?.decided, { kind: 'applied', planRev: 2 });
    refuses([holisticPlan(1), ckptInputs(1), decided(1), decided(1)], 4, /no undecided checkpoint inputs/);
    refuses([holisticPlan(1), ckptInputs(1), decided(1), holisticPlan(2, { command: null, source: { type: 'bundle', job: 'ckpt-1' } })], 4, /bundle ckpt-1, which has no undecided/);
    refuses([holisticPlan(1), ckptInputs(2)], 2, /the next ckpt job is ckpt-1/);
  });
});

describe('fold: divergences and digests (H11, H12)', () => {
  it('divergences number in order, belong to a checkpoint job, once per (job, index); a digest binds recorded ids no earlier digest bound', () => {
    const f = folded([holisticPlan(1), ckptInputs(1), divergence(1, 'ckpt-1', 0), divergence(2, 'ckpt-1', 1), digest(5, ['D-1']), divergence(3, 'ckpt-1', 2), digest(7, ['D-2', 'D-3'])]);
    assert.deepEqual(f.holistic().digests.map((d) => d.ids), [['D-1'], ['D-2', 'D-3']]);
    assert.equal(f.nextDivergenceId(), 'D-4');
    refuses([holisticPlan(1), ckptInputs(1), divergence(2, 'ckpt-1', 0)], 3, /the next divergence is D-1/);
    refuses([holisticPlan(1), divergence(1, 'ckpt-1', 0)], 2, /no checkpoint job/);
    refuses([holisticPlan(1), ckptInputs(1), divergence(1, 'ckpt-1', 0), divergence(2, 'ckpt-1', 0)], 4, /second divergence ckpt-1#0/);
    refuses([holisticPlan(1), ckptInputs(1), divergence(1, 'ckpt-1', 0), digest(4, ['D-2'])], 4, /D-2, which was never recorded/);
    refuses([holisticPlan(1), ckptInputs(1), divergence(1, 'ckpt-1', 0), digest(4, ['D-1']), digest(5, ['D-1'])], 5, /an earlier digest binds/);
  });
});

describe('fold: draining, the holistic flag, completion', () => {
  it('close-admissions latches draining once; an architect admit reopens it', () => {
    const closed = fact({ kind: 'admissions-closed', command: CMD });
    assert.equal(folded([planApplied(1), closed]).holistic().draining?.command, CMD);
    refuses([planApplied(1), closed, fact({ kind: 'admissions-closed', command: CMD2 })], 3, /already draining/);
    assert.equal(folded([planApplied(1), closed, planApplied(2, {}, [{ type: 'unit-added', unit: 'u2' }])]).holistic().draining, null);
    assert.notEqual(folded([planApplied(1), closed, planApplied(2, {}, [{ type: 'order' }])]).holistic().draining, null);
  });

  it('holistic is on while the plan in force records a vision, and a revision may not drop it (A5)', () => {
    assert.equal(folded([planApplied(1)]).holistic().on, false);
    assert.equal(folded([planApplied(1), holisticPlan(2, {}, [{ type: 'holistic' }])]).holistic().on, true);
    refuses([holisticPlan(1), planApplied(2)], 2, /drops the vision/);
  });

  it('a completion is active while the plan rev and the head hold and no reopen followed (A20)', () => {
    const f = folded([planApplied(1), completed(1)]);
    assert.equal(f.holistic().completion?.active, true);
    assert.equal(folded([planApplied(1), completed(1), planApplied(2)]).holistic().completion?.active, false);
    refuses([planApplied(1), planApplied(2), completed(1)], 3, /plan rev 1; the plan in force is rev 2/);
    refuses([planApplied(1), completed(1, A, 2)], 2, /high-water 2, not before its own seq 2/);
    assert.ok(f.lastWorkSeq() < 2, 'arc-completed is not work');
  });
});

describe('fold: bounds, job residues, batch publications', () => {
  it('a unit takes the bounds of its latest dispatch, and the chargeable invariant reads them', () => {
    const four = { ...DEFAULT_BOUNDS, chargeable: 4 };
    const f = folded([planApplied(1), dispatch(U1, four), chargeable(U1, 1, 'candidate-red'), chargeable(U1, 2, 'candidate-red'), chargeable(U1, 3, 'candidate-red')]);
    assert.deepEqual(f.unit(U1).bounds, four);
    assert.deepEqual(folded([planApplied(1), dispatch(U2)]).unit(U2).bounds, DEFAULT_BOUNDS);
    refuses([planApplied(1), dispatch(U1), chargeable(U1, 1, 'candidate-red'), chargeable(U1, 2, 'candidate-red'), chargeable(U1, 3, 'candidate-red')], 5, /chargeable failure 3, which parks the unit/);
    refuses([planApplied(1), dispatch(U1, four), chargeable(U1, 1, 'advance'), chargeable(U1, 2, 'advance'), chargeable(U1, 3, 'advance'), chargeable(U1, 4, 'advance')], 6, /chargeable failure 4, which parks the unit.*bound is 4/);
  });

  it('a failed cleanup under a job holder leaves a job-owned residue (G4)', () => {
    const inv = invocationId(opId(ARC, 9), 1);
    const holder = { type: 'job', job: 'audit-1' };
    const t = (seq: number, edge: object): readonly LogRecord[] => [
      { type: 'intent', op: opId(ARC, seq), kind: 'resource.transition', key: opKey('resources:job/audit-1'), parent: { type: 'job', job: 'audit-1' }, ordinal: 1, deadlineAt: null, expect: { holder, resources: ['estate#1'], edge }, post: null } as unknown as LogRecord,
      { type: 'done', op: opId(ARC, seq), kind: 'resource.transition', outcome: { kind: 'transitioned' }, recoveredBy: null },
    ];
    const f = folded([holisticPlan(1), ...t(2, { type: 'reserve' }), ...t(4, { type: 'clean', from: 'reserved' }), ...t(6, { type: 'fail', residues: [{ resource: 'estate#1', teardown: inv }] })]);
    const [r] = f.residues();
    assert.deepEqual(r?.key, { arc: ARC, job: 'audit-1', inv, resource: 'estate#1' });
    assert.deepEqual(r?.holder, holder);
    assert.equal(f.nextJobId('audit'), 'audit-2', 'a job named in a parent or holder is seen');
  });

  it('a batch ff publishes and retires every member at once', () => {
    const fp = (commit: string) => ({ unitCommit: commit, specRev: 1, contractRevs: [], rulingRevs: [] });
    const commit = { tree: A, parents: [A, B], author: { name: 'r', email: 'r@x', date: '1790000000 +0000' }, committer: { name: 'r', email: 'r@x', date: '1790000000 +0000' }, message: 'm', gpgsign: false };
    const records: LogRecord[] = [
      planApplied(1),
      {
        type: 'intent', op: opId(ARC, 2), kind: 'candidate.merge', key: opKey('candidate'), parent: { type: 'job', job: 'batch-1' }, ordinal: 1, deadlineAt: null,
        expect: {
          ref: 'refs/roadmap-run/arc-1/candidate/batch-1', old: null, integrationTip: A, unitCommit: B, worktree: '/wt/c', commit,
          batch: { job: 'batch-1', members: [{ unit: 'u1', unitCommit: B, fingerprint: fp(B) }, { unit: 'u2', unitCommit: C, fingerprint: fp(C) }], chain: [{ commit: A, parents: [B, C] }] },
        },
        post: { new: A },
      } as unknown as LogRecord,
      { type: 'done', op: opId(ARC, 2), kind: 'candidate.merge', outcome: { kind: 'merged' }, recoveredBy: null },
      { type: 'intent', op: opId(ARC, 4), kind: 'integration.ff', key: opKey('ff'), parent: { type: 'job', job: 'batch-1' }, ordinal: 1, deadlineAt: null, expect: { ref: 'refs/heads/main', old: C, new: A, subject: { type: 'batch', job: 'batch-1' } }, post: null } as unknown as LogRecord,
      { type: 'done', op: opId(ARC, 4), kind: 'integration.ff', outcome: { kind: 'published' }, recoveredBy: null },
    ];
    const f = folded(records);
    assert.deepEqual(f.publications(), [{ unit: U1, seq: 5 }, { unit: U2, seq: 5 }]);
    assert.equal(f.unit(U1).status, 'retired');
    assert.equal(f.unit(U2).status, 'retired');
    assert.equal(f.integrationHead(), A);
  });
});
