// dev.82: the arc's phase (src/endgame/phase.ts) over folded logs built here record by record: the finding-raised predicate,
// body and endgame (a planned unit open, a milestone without its checkpoint, every planned unit settled, a planned unit
// added back), the units the endgame holds and the running ones, an episode's step, the episode fold's refusals, and the
// classifier's origin row over a real arc.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { type Event, type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type MilestoneId, type UnitId, commandId, findingId, milestoneId, obligationId, opId, opKey, planRev, seatRev, sha, sha256, specRev, systemName, unitId } from '../src/core/ids.ts';
import { Fold, FoldInvariantError } from '../src/core/state.ts';
import { absPath, branchName, isoTime, planPath, refName, repoPath } from '../src/core/values.ts';
import { auditedMilestones, endgameHeld, findingRaised, openEpisode, phaseKind, runningUnits, stepOf } from '../src/endgame/phase.ts';
import { classify } from '../src/input/classify.ts';
import { readInputFiles, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { type HolisticDoc, type Milestone, PLAN_SCHEMA, type PlanM1, type PlanUnit } from '../src/input/plan.ts';
import { ARC, H, REV, appliedFields, chain } from './fixtures/log-records.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';

const [U1, U2, R1, R2] = ['u1', 'u2', 'r1', 'r2'].map((s) => unitId(s)) as [UnitId, UnitId, UnitId, UnitId];
const MS1: MilestoneId = milestoneId('MS-1');
const V = sha256('e'.repeat(64));
const A = sha('a'.repeat(40));
const AT = isoTime('2026-11-17T12:00:00.000Z');

const unit = (id: UnitId, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  id, spec: planPath(`specs/${id}.json`), risk: 'med', systems: [systemName('app')], resources: [], after: [], contingent: [], ...extra,
});
/** A plan of `units`; holistic unless `holistic` is false (the field is only tested for presence). */
const planOf = (units: readonly PlanUnit[], extra: Partial<PlanM1> = {}, holistic = true): PlanM1 => ({
  schema: PLAN_SCHEMA, arc: ARC, integrationBranch: branchName('main'), baseline: A, worktreeRoot: absPath('/wt'), contracts: [],
  rulings: planPath('rulings.md'), target: 'architecture-doc', architectureDoc: repoPath('ARCH.md'), direction: 'd', suite: { lanes: [] }, resources: [], units,
  ...(holistic ? { holistic: {} as HolisticDoc } : {}), ...extra,
}) as PlanM1;
const milestone = (id: MilestoneId, units: readonly UnitId[]): Milestone => ({ id, units } as unknown as Milestone);

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const dispatch = (u: UnitId): LogRecord => fact({
  kind: 'dispatch', record: { unit: u, specRev: specRev(1), specSha256: H, riskFloor: 'med', routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: AT, transientRules: 'm3' },
});

/** A log under construction (as test/ready.test.ts's): records appended in order, folded on demand. */
class Log {
  readonly records: LogRecord[] = [];
  #rev = 0;
  readonly holistic: boolean;
  constructor(units: readonly UnitId[], holistic = true) {
    this.holistic = holistic;
    this.plan(units, []);
  }
  add(...records: LogRecord[]): number {
    this.records.push(...records);
    return this.records.length;
  }
  plan(units: readonly UnitId[], changes: readonly object[]): number {
    this.#rev += 1;
    const command = this.#rev === 1 ? null : commandId(`cmd-${String(this.#rev).padStart(16, '0')}`);
    return this.add(fact({
      kind: 'plan-applied', rev: planRev(this.#rev), command, planSha256: H, specs: Object.fromEntries(units.map((u) => [u, H])), changes,
      ...appliedFields(this.#rev, command), ...(this.holistic ? { visionSha256: V } : {}),
    }));
  }
  /** `u` merged: a published ff and its retiring snapshot outcome. */
  merge(u: UnitId): void {
    const seq = this.records.length + 1;
    const op = opId(ARC, seq);
    const fingerprint = { unitCommit: sha('b'.repeat(40)), specRev: specRev(1), contractRevs: [], rulingRevs: [] };
    this.add(
      { type: 'intent', op, kind: 'integration.ff', key: opKey(`ff:${u}`), parent: { type: 'stage', unit: u, stage: 'ff', attempt: 1 }, ordinal: 1, deadlineAt: null,
        expect: { ref: refName('refs/heads/main'), old: sha('c'.repeat(40)), new: sha('d'.repeat(40)), fingerprint }, post: null } as LogRecord,
      { type: 'done', op, kind: 'integration.ff', outcome: { kind: 'published' }, recoveredBy: null } as LogRecord,
      fact({ kind: 'stage-outcome', unit: u, stage: 'snapshot', attempt: 2, outcome: 'published', class: 'retire', chargeable: false }),
    );
  }
  /** `job` walks `m` and ends `outcome`. */
  walk(job: string, m: MilestoneId, outcome: 'reported' | 'abandoned'): void {
    this.add(fact({ kind: 'walk-started', job, milestone: m, round: 1, sha: A, ports: {} }), fact({ kind: 'walk-ended', job, outcome, findings: [], proposals: [], dropped: [] }));
  }
  /** `audit-<n>` triggered by milestone `m`, completed. */
  audit(n: number, m: MilestoneId): void {
    this.add(
      fact({ kind: 'audit-started', job: `audit-${n}`, triggers: [{ type: 'milestone', milestone: m }], generation: n, lenses: ['invariants'], integrationSha: A, planRev: 1, ledgerSha256: null,
        obligationsSha256: null, visionSha256: V, owners: [], priorFindings: [], highWater: 1, diffBudget: 24000 }),
      fact({ kind: 'audit-ended', job: `audit-${n}`, refused: [], covered: [], findings: [], suppressed: 0, outcome: 'completed' }),
    );
  }
  view(): Fold {
    const f = new Fold(ARC);
    for (const e of chain(this.records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    return f;
  }
}

function refuses(records: readonly LogRecord[], seq: number, detail: RegExp): void {
  const events: Event[] = chain(records);
  const f = new Fold(ARC);
  assert.throws(() => {
    for (const e of events) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  }, (err: unknown) => err instanceof FoldInvariantError && err.seq === seq && detail.test(err.detail));
}

const NONE = (): readonly never[] => [];

describe('endgame: the finding-raised predicate', () => {
  it('a unit added after the first revision is, by an origin other than planned or a spec that repairs; one the arc started with never is', () => {
    const log = new Log([U1]);
    log.plan([U1, U2, R1], [{ type: 'unit-added', unit: U2 }, { type: 'unit-added', unit: R1 }]);
    const view = log.view();
    assert.equal(findingRaised(view, unit(U2), []), false);
    assert.equal(findingRaised(view, unit(U2, { origin: 'planned' }), []), false);
    assert.equal(findingRaised(view, unit(U2), [findingId('F-1')]), true);
    for (const origin of ['repair', 'polish', 'deflake'] as const) assert.equal(findingRaised(view, unit(R1, { origin }), []), true, origin);
    assert.equal(findingRaised(view, unit(U1, { origin: 'repair' }), [findingId('F-1')]), false, 'in the first revision: planned work');
  });
});

describe('endgame: the phase predicate', () => {
  it('a planned unit open is the body; every planned unit settled enters the endgame, finding-raised units open or not', () => {
    const log = new Log([U1]);
    log.plan([U1, R1], [{ type: 'unit-added', unit: R1 }]);
    const plan = planOf([unit(U1), unit(R1, { origin: 'repair' })]);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'body', planned: [U1], milestones: [] });
    log.merge(U1);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'endgame' });
    log.plan([U1, R1], [{ type: 'unit-cut', unit: R1 }]);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'endgame' });
  });

  it('a later planned unit whose spec repairs something is finding-raised; an arc planned as repairs starts in the body', () => {
    const log = new Log([U1]);
    log.plan([U1, U2], [{ type: 'unit-added', unit: U2 }]);
    log.merge(U1);
    const plan = planOf([unit(U1), unit(U2)]);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'body', planned: [U2], milestones: [] });
    assert.deepEqual(phaseKind(log.view(), plan, (u) => (u.id === U2 ? [obligationId('I-1')] : [])), { kind: 'endgame' });
    assert.deepEqual(phaseKind(new Log([R1]).view(), planOf([unit(R1, { origin: 'repair' })]), () => [findingId('F-1')]), { kind: 'body', planned: [R1], milestones: [] });
  });

  it('a milestone lacks its checkpoint until a walk of it ended as a round and its milestone audit completed', () => {
    const log = new Log([U1]);
    const plan = planOf([unit(U1)], { milestones: [milestone(MS1, [U1])] });
    log.merge(U1);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'body', planned: [], milestones: [MS1] }, 'unwalked');
    log.walk('walk-1', MS1, 'abandoned');
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'body', planned: [], milestones: [MS1] }, 'an abandoned walk is no round');
    log.walk('walk-2', MS1, 'reported');
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'body', planned: [], milestones: [MS1] }, 'walked, its audit not completed');
    log.audit(1, MS1);
    assert.deepEqual([...auditedMilestones(log.view().holistic())], [MS1]);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'endgame' });
  });

  it('a milestone abandoned (its round\'s walk failed twice) has its checkpoint once its audit completed', () => {
    const log = new Log([U1]);
    const plan = planOf([unit(U1)], { milestones: [milestone(MS1, [U1])] });
    log.merge(U1);
    log.walk('walk-1', MS1, 'abandoned');
    log.walk('walk-2', MS1, 'abandoned');
    log.audit(1, MS1);
    assert.deepEqual(phaseKind(log.view(), plan, NONE), { kind: 'endgame' });
  });

  it('a revision adding a planned unit returns the arc to the body, with no latch', () => {
    const log = new Log([U1]);
    log.merge(U1);
    assert.deepEqual(phaseKind(log.view(), planOf([unit(U1)]), NONE), { kind: 'endgame' });
    log.plan([U1, U2], [{ type: 'unit-added', unit: U2 }]);
    assert.deepEqual(phaseKind(log.view(), planOf([unit(U1), unit(U2)]), NONE), { kind: 'body', planned: [U2], milestones: [] });
  });

  it('an arc without the holistic layer stays in the body (vacuous)', () => {
    const log = new Log([U1], false);
    log.merge(U1);
    assert.deepEqual(phaseKind(log.view(), planOf([unit(U1)], {}, false), NONE), { kind: 'body', planned: [], milestones: [] });
  });
});

describe('endgame: held and running units, the step', () => {
  it('the endgame holds active finding-raised units the entry found with no dispatch record; the body holds none; one admitted later runs', () => {
    const log = new Log([U1]);
    log.plan([U1, R1, R2], [{ type: 'unit-added', unit: R1 }, { type: 'unit-added', unit: R2 }]);
    const plan = planOf([unit(U1), unit(R1, { origin: 'repair' }), unit(R2, { origin: 'polish' })]);
    log.add(dispatch(R1));
    assert.deepEqual([...endgameHeld(log.view(), plan, NONE)], [], 'body');
    log.merge(U1);
    assert.deepEqual([...endgameHeld(log.view(), plan, NONE)], [R2], 'r1 was dispatched: it finishes');
    log.add(fact({ kind: 'endgame-entered', episode: 1, planRev: 2 }));
    const R3 = unitId('r3');
    log.plan([U1, R1, R2, R3], [{ type: 'unit-added', unit: R3 }]);
    assert.deepEqual([...endgameHeld(log.view(), planOf([...plan.units, unit(R3, { origin: 'repair' })]), NONE)], [R2], 'r3, admitted in the episode, runs');
  });

  it('a running unit is active and dispatched with every unmerged dependency running; one behind a held unit is not', () => {
    const log = new Log([U1, R1, R2]);
    log.add(dispatch(R1), dispatch(U1));
    assert.deepEqual(runningUnits(log.view(), planOf([unit(U1), unit(R1), unit(R2)])), [U1, R1]);
    assert.deepEqual(runningUnits(log.view(), planOf([unit(U1), unit(R1, { after: [R2] }), unit(R2)])), [U1], 'r2 undispatched');
    log.merge(U1);
    assert.deepEqual(runningUnits(log.view(), planOf([unit(U1), unit(R1, { after: [U1] }), unit(R2)])), [R1], 'a merged dependency');
  });

  it('settling until opened; open while required entries remain or the branch is unlanded; closing once neither holds', () => {
    const log = new Log([U1]);
    log.merge(U1);
    log.add(fact({ kind: 'endgame-entered', episode: 1, planRev: 1 }));
    const entered = openEpisode(log.view());
    assert.equal(stepOf(null, 0, true), 'settling');
    assert.equal(stepOf(entered, 0, true), 'settling');
    log.add(fact({ kind: 'endgame-opened', episode: 1, base: A, handoverSha256: H }));
    const opened = openEpisode(log.view());
    assert.deepEqual([stepOf(opened, 1, true), stepOf(opened, 0, false), stepOf(opened, 0, true)], ['open', 'open', 'closing']);
  });
});

describe('endgame: the episode fold', () => {
  const entered = (n: number): LogRecord => fact({ kind: 'endgame-entered', episode: n, planRev: 1 });
  const opened = (n: number): LogRecord => fact({ kind: 'endgame-opened', episode: n, base: A, handoverSha256: H });
  const left = (n: number, cause = 'planned-unit'): LogRecord => fact({ kind: 'endgame-left', episode: n, cause });
  const fix = fact({ kind: 'endgame-fix', command: commandId('cmd-0000000000000009'), closes: ['F-1'], commit: A, note: 'n' });
  const base = new Log([U1]).records;

  const started = (job: string): LogRecord => fact({ kind: 'endgame-job-started', job, command: null, request: { type: 'land' } });
  const ended = (job: string): LogRecord => fact({ kind: 'endgame-job-ended', job, outcome: 'landed', detail: 'landed' });

  it('episodes number in order, open once, and record fixes, landings and reviews only while opened', () => {
    const log = new Log([U1]);
    log.add(entered(1), opened(1), fix, started('endgame-1'), fact({ kind: 'endgame-landed', job: 'endgame-1', old: A, head: A }), ended('endgame-1'), left(1), entered(2));
    const [first, second] = log.view().holistic().endgame;
    assert.deepEqual([first!.episode, first!.opened?.base, first!.fixes.length, first!.landings.length, first!.left?.cause], [1, A, 1, 1, 'planned-unit']);
    assert.deepEqual([second!.episode, second!.opened, second!.left], [2, null, null]);
    assert.equal(openEpisode(log.view())?.episode, 2);
  });

  it('a second open episode, a skipped number, a second open, a fix outside an episode or before it opened, a mismatched left: refused', () => {
    refuses([...base, entered(1), entered(2)], 3, /episode 2 entered while episode 1 is open/);
    refuses([...base, entered(2)], 2, /the next episode is 1/);
    refuses([...base, entered(1), opened(1), opened(1)], 4, /opened twice/);
    refuses([...base, fix], 2, /endgame-fix outside an endgame episode/);
    refuses([...base, entered(1), fix], 3, /endgame-fix in endgame episode 1, which has not opened/);
    refuses([...base, entered(1), left(1), fix], 4, /outside an endgame episode/);
    refuses([...base, entered(1), left(2)], 3, /endgame-left names episode 2; episode 1 is open/);
  });

  it('WS-5: a landing is its running job\'s; one job at a time, numbered in order; no episode is left while one runs; a release once per unit', () => {
    const landed = (job: string): LogRecord => fact({ kind: 'endgame-landed', job, old: A, head: A });
    const released = fact({ kind: 'endgame-released', unit: U1, command: commandId('cmd-0000000000000009') });
    refuses([...base, entered(1), opened(1), landed('endgame-1')], 4, /not the running endgame job/);
    refuses([...base, entered(1), opened(1), started('endgame-1'), started('endgame-2')], 5, /started while endgame-1 runs/);
    refuses([...base, entered(1), opened(1), started('endgame-2')], 4, /the next endgame job is endgame-1/);
    refuses([...base, entered(1), opened(1), started('endgame-1'), left(1)], 5, /left while job endgame-1 runs/);
    refuses([...base, entered(1), released, released], 4, /released from endgame episode 1 twice/);
    const log = new Log([U1]);
    log.add(entered(1), released, opened(1), started('endgame-1'), landed('endgame-1'), ended('endgame-1'));
    const [e] = log.view().holistic().endgame;
    assert.deepEqual([e!.released.map((r) => r.unit), e!.jobs.map((j) => [j.started.job, j.ended?.outcome])], [[U1], [['endgame-1', 'landed']]]);
  });
});

describe('endgame: origin is fixed when a unit is added', () => {
  it('classify refuses an origin edit of a unit already planned', () => {
    const d = setupArc({ steps: [] });
    const r = contextFor(d);
    try {
      const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
      plan.units[0]!['origin'] = 'repair';
      writeFileSync(d.planPath, JSON.stringify(plan));
      const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
      const v = classify({
        runDir: r.ctx.runDir, view: r.journal.view, inForce, revision: revisionInForce(r.ctx.runDir, inForce), next: readInputFiles(absPath(d.planPath), absPath(d.repo)), residues: [],
        routing: { profile: 'default', config: null, arcRoles: 'm4b' }, proposer: { type: 'apply', reason: 'Reviewed revision' },
      });
      assert.equal(v.kind, 'rejected', JSON.stringify(v));
      if (v.kind === 'rejected') assert.ok(v.reasons.includes('unit u1: `origin` is set when a unit is added, never after'), JSON.stringify(v.reasons));
    } finally {
      r.journal.close();
    }
  });
});
