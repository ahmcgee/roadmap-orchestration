// dev.83: the endgame's worklist (src/endgame/worklist.ts) over a folded log: required membership (active P1s, active findings
// over an obligation, obligations not held on the head, finding-raised units not settled) and optional (other active
// findings, obligations on an external lane unattested at the head, polish proposals refused since the episode entered).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type UnitId, commandId, findingId, laneId, obligationId, planRev, sha, sha256, systemName, unitId } from '../src/core/ids.ts';
import { Fold } from '../src/core/state.ts';
import { absPath, branchName, planPath, repoPath } from '../src/core/values.ts';
import { openEpisode } from '../src/endgame/phase.ts';
import { worklist } from '../src/endgame/worklist.ts';
import { type HolisticDoc, PLAN_SCHEMA, type PlanM1, type PlanUnit } from '../src/input/plan.ts';
import { ARC, H, appliedFields, chain } from './fixtures/log-records.ts';

const [U1, U2, R1, R2] = ['u1', 'u2', 'r1', 'r2'].map((s) => unitId(s)) as [UnitId, UnitId, UnitId, UnitId];
const V = sha256('e'.repeat(64));
const A = sha('a'.repeat(40));

const unit = (id: UnitId, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  id, spec: planPath(`specs/${id}.json`), risk: 'med', systems: [systemName('app')], resources: [], after: [], contingent: [], ...extra,
});
const PLAN = {
  schema: PLAN_SCHEMA, arc: ARC, integrationBranch: branchName('main'), baseline: A, worktreeRoot: absPath('/wt'), contracts: [],
  rulings: planPath('rulings.md'), target: 'architecture-doc', architectureDoc: repoPath('ARCH.md'), direction: 'd', suite: { lanes: [] }, resources: [],
  holistic: {} as HolisticDoc,
  units: [unit(U1), unit(U2), unit(R1, { origin: 'repair' }), unit(R2, { origin: 'deflake' })],
} as PlanM1;

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const opened = (n: number, severity: string, obligation: string | null): LogRecord => fact({
  kind: 'finding-opened', id: `F-${n}`, key: sha256(String(n).repeat(64)), lens: 'invariants', severity, obligation, visionClauses: [], claim: 'c',
  evidence: [{ path: `src/f${n}.js`, blob: null }], mutant: null, source: { type: 'job', job: 'audit-1' }, gateHadPassed: false,
});
const proposed = (n: number): LogRecord => fact({
  kind: 'polish-proposed', id: `X-${n}`, job: 'walk-1', milestone: 'MS-1', journey: 'J-1', evidence: ['shot.png'], text: 't', unit: { id: `p${n}`, systems: ['app'], spec: '{}' },
});

/** Plan revision `rev` over every unit, with `changes`. */
const revision = (rev: number, changes: readonly object[]): LogRecord => {
  const command = commandId(`cmd-${String(rev).padStart(16, '0')}`);
  return fact({ kind: 'plan-applied', rev: planRev(rev), command, planSha256: H, specs: { u1: H, u2: H, r1: H, r2: H }, changes, ...appliedFields(rev, command), visionSha256: V });
};

function fold(records: readonly LogRecord[]): Fold {
  const f = new Fold(ARC);
  for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}

const NONE = { notHeld: [], unattested: [] };

describe('endgame: the worklist', () => {
  it('required: active P1s, active findings over an obligation, obligations not held, finding-raised units not settled; optional: the rest, an unattested external obligation included', () => {
    const records = [
      fact({ kind: 'plan-applied', rev: planRev(1), command: null, planSha256: H, specs: { u1: H }, changes: [], ...appliedFields(1, null), visionSha256: V }),
      opened(1, 'P1', null), opened(2, 'P2', 'I-2'), opened(3, 'P3', null), opened(4, 'P1', null),
      fact({ kind: 'finding-transition', id: 'F-4', to: { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } } }),
      revision(2, ['u2', 'r1', 'r2'].map((unit) => ({ type: 'unit-added', unit }))),
      revision(3, [{ type: 'unit-cut', unit: 'r2' }]),
      fact({ kind: 'walk-started', job: 'walk-1', milestone: 'MS-1', round: 1, sha: A, ports: {} }), proposed(1), proposed(2),
      fact({ kind: 'walk-ended', job: 'walk-1', outcome: 'reported', findings: [], proposals: ['X-1', 'X-2'], dropped: [] }),
      fact({ kind: 'polish-refused', proposal: 'X-1', reasons: ['before the endgame'] }),
      fact({ kind: 'endgame-entered', episode: 1, planRev: 3 }),
      fact({ kind: 'polish-refused', proposal: 'X-2', reasons: ['the arc is in the endgame'] }),
    ];
    const view = fold(records);
    // u2 repairs F-1 (a planned unit whose spec repairs: finding-raised); u1 does not.
    const repairsOf = (u: PlanUnit) => (u.id === U2 ? [findingId('F-1')] : []);
    const list = worklist(view, PLAN, repairsOf, { notHeld: [obligationId('I-3')], unattested: [{ obligation: obligationId('I-4'), lane: laneId('L-ci') }] }, openEpisode(view));
    assert.deepEqual(list.required, [
      { type: 'finding', finding: 'F-1', severity: 'P1', obligation: null, evidence: ['src/f1.js'] },
      { type: 'finding', finding: 'F-2', severity: 'P2', obligation: 'I-2', evidence: ['src/f2.js'] },
      { type: 'obligation', obligation: 'I-3' },
      { type: 'unit', unit: U2 },
      { type: 'unit', unit: R1 },
    ]);
    assert.deepEqual(list.optional, [
      { type: 'finding', finding: 'F-3', severity: 'P3', obligation: null, evidence: ['src/f3.js'] },
      { type: 'attestation', obligation: 'I-4', lane: 'L-ci' },
      { type: 'polish-refused', proposal: 'X-2', reasons: ['the arc is in the endgame'] },
    ]);
    assert.deepEqual(worklist(view, PLAN, () => [], NONE, null).optional.map((e) => e.type), ['finding'], 'no episode: no refused proposal is an entry');
    assert.deepEqual(worklist(view, PLAN, () => [], NONE, null).required.map((e) => (e.type === 'unit' ? e.unit : e.type)), ['finding', 'finding', R1], 'u2 repairs nothing: planned');
  });
});
