// M3 records frozen in step 0a (SCHEMAS.md "M3: the holistic layer"): ids, the vision, obligations, witness
// records, ruling sidecars, revision payloads, every new fact and plan-applied field, command bodies, plan and spec
// fields, the lens and checkpoint outputs, and the obligation transition table (`table.total`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Envelope, type Event, type Fact, type HolisticFactKind, type LogRecord, type PlanChange, parseEventLine, parseRevisionPayload, serializeEvent,
} from '../src/core/events.ts';
import {
  InvalidIdError, arcId, commandId, divergenceId, envId, findingId, findingIdOf, invocationId, jobId, jobIdOf, jobIdOfKind, laneId, laneRev,
  obligationId, opId, parseJobId, routingRev, sha, sha256, unitId, visionClauseId,
} from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import {
  DEFAULT_BOUNDS, approvalFingerprint, commandBody, dispatchRecord, obligationRevsOf, residueKey, residueOwner, specM1, specObligations,
} from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { isoTime } from '../src/core/values.ts';
import { type ObligationCase, OBLIGATION_EFFECTS, type ObligationEffect, obligationEffect } from '../src/holistic/table.ts';
import {
  type Obligations, OBSERVATION_VERDICTS, findingKey, laneRevOf, parseObligations, parseRulingSidecar, parseVision, witnessRecord,
} from '../src/holistic/types.ts';
import { DEFAULT_CONVERGENCE_K, boundsOf, lensSetOf, parsePlan } from '../src/input/plan.ts';
import { validateCheckpointOutput, validateLensOutput } from '../src/prompts/schemas.ts';
import { ORIGIN_RANK } from '../src/schedule/types.ts';

const ARC = arcId('arc-1');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const H = sha256('d'.repeat(64));
const H2 = sha256('e'.repeat(64));
const REV = routingRev('0123456789abcdef');
const AT = isoTime('2026-09-30T12:00:00.000Z');
const CMD = commandId('cmd-0123456789abcdef');
const U1 = unitId('u1');
const INV = invocationId(opId(ARC, 7), 1);
const LANE_REV = laneRev('0123456789abcdef');
const ENV = envId('fedcba9876543210');

const envelope = (seq: number): Envelope => ({ v: 1, seq, prev: seq === 1 ? null : H, at: AT, arc: ARC });
function roundTrip(record: LogRecord): Event {
  const e = { ...envelope(2), ...record } as Event;
  const line = serializeEvent(e);
  const back = parseEventLine(line.slice(0, -1));
  assert.deepEqual(back, e);
  assert.equal(serializeEvent(back), line, 'byte-identical');
  return back;
}
const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const refusesFact = (f: object, field: RegExp): void => assert.throws(() => roundTrip(fact(f)), (err: unknown) => err instanceof SchemaError && field.test(err.field));

const preimage = { planRev: 3, specs: { u1: 2 }, obligationsSha256: H, ledgerSha256: H2, contracts: [{ path: 'docs/api.md', blob: A }] };
const draft = {
  job: jobId('ckpt', 1), type: 'plan-departed', from: 'plan rev 3', what: 'admitted repair unit r1', cites: [visionClauseId('V-2')], evidence: ['F-1'],
  preimage, compensation: { hint: 'cut r1', kind: 'restore-revision' },
};

// One of every M3 fact, as the frozen shapes allow.
const HOLISTIC_FACTS: { readonly [K in HolisticFactKind]: object } = {
  witnessed: { kind: 'witnessed', lane: laneId('journey'), laneRev: LANE_REV, envId: ENV, treeSha: A, inv: INV, recordsSha256: H, purpose: 'witness', for: { type: 'candidate', unit: U1, attempt: 3 } },
  'obligation-latched': { kind: 'obligation-latched', obligation: obligationId('I-1'), unit: U1, treeSha: A },
  'finding-opened': {
    kind: 'finding-opened', id: findingId('F-1'), key: H, lens: 'vacuity', severity: 'P2', obligation: obligationId('I-2'), visionClauses: ['V-1', 'V-2'],
    claim: 'the test permits a mis-rounding', evidence: [{ path: 'test/round.test.js', blob: A }], mutant: { patchSha256: H2, lane: laneId('journey') },
    source: { type: 'job', job: 'audit-1' }, gateHadPassed: true,
  },
  'finding-transition': { kind: 'finding-transition', id: 'F-1', to: { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } } },
  'audit-started': {
    kind: 'audit-started', job: 'audit-1', triggers: [{ type: 'cadence' }, { type: 'requested', command: CMD }], generation: 1, lenses: ['invariants', 'vision'],
    integrationSha: A, planRev: 4, ledgerSha256: H, obligationsSha256: H2, visionSha256: H, owners: [{ unit: 'u1', head: B }], priorFindings: ['F-1'], highWater: 90,
  },
  'audit-ended': { kind: 'audit-ended', job: 'audit-1', covered: [{ lens: 'invariants', from: B, to: A }], findings: ['F-1'], suppressed: 2, outcome: 'completed' },
  'docs-covered': { kind: 'docs-covered', pub: 'docs-1', from: A, to: B },
  'checkpoint-inputs': {
    kind: 'checkpoint-inputs', job: 'ckpt-1', trigger: { type: 'audit', job: 'audit-1' }, generation: 1,
    vector: { plan: 4, specs: { u1: 2 }, obligationsSha256: H2, ledgerSha256: H, visionSha256: H, contracts: [{ path: 'docs/api.md', blob: A }] },
    headSha: A, visionSha256: H, findings: ['F-1'], observations: [{ treeSha: A, lane: 'journey', laneRev: LANE_REV, envId: ENV }],
  },
  'bundle-decided': { kind: 'bundle-decided', job: 'ckpt-1', outcome: { kind: 'rejected', reason: 'stale', detail: 'the plan moved to rev 5' } },
  divergence: { kind: 'divergence', id: 'D-1', index: 0, ...draft },
  'divergence-digest': { kind: 'divergence-digest', needsUser: 'nu-40', ids: ['D-1', 'D-2'] },
  steered: { kind: 'steered', unit: U1, command: CMD, brief: H, budgetMin: 30, resume: false },
  'merged-in': { kind: 'merged-in', unit: U1, command: CMD, integrationTip: A, head: B },
  'audit-requested': { kind: 'audit-requested', command: CMD, lenses: ['drift'] },
  'admissions-closed': { kind: 'admissions-closed', command: CMD },
  'docs-published': { kind: 'docs-published', pub: 'docs-2', source: 'close-out', commit: B },
  'arc-completed': { kind: 'arc-completed', planRev: 6, head: A, highWater: 120, units: ['u1', 'u2'] },
};

const OBLIGATIONS = {
  schema: 'roadmap/obligations-m3',
  cutLine: 'Everything above the ledger CLI.',
  lanes: [{
    id: 'journey', argv: ['node', '--test', 'test/journey.test.js'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [],
    evidenceGlobs: [], evidenceExcludes: [], reporter: 'node-test',
  }],
  obligations: [
    {
      id: 'I-1', rev: 1, statement: 'a month reconciles in one command', docRef: { path: 'docs/target.md', anchor: '#reconcile', quotedText: 'one command' },
      serves: ['V-1'], witness: { lane: 'journey', testIds: ['reconcile month'] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness: { lane: 'journey', testIds: ['reconcile month'] } },
      deliveredBy: ['parse', 'report'], activation: 'future', contracts: [], state: { type: 'active' },
    },
    {
      id: 'I-2', rev: 2, statement: 'money is never silently mis-rounded', docRef: { path: 'docs/target.md', anchor: '#money', quotedText: 'never mis-rounded' },
      serves: ['V-2'], witness: null, proofJudgment: null, deliveredBy: [], activation: 'must-hold', contracts: ['docs/money.md'], state: { type: 'split', children: ['I-4'] },
    },
    {
      id: 'I-4', rev: 1, statement: 'totals round half-even', docRef: { path: 'docs/target.md', anchor: '#money', quotedText: 'never mis-rounded' },
      serves: ['V-2'], witness: { lane: 'journey', testIds: ['half-even'] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness: { lane: 'journey', testIds: ['half-even'] } },
      deliveredBy: [], activation: 'must-hold', parent: 'I-2', contracts: [], state: { type: 'active' },
    },
  ],
  mapping: { paths: [{ pattern: 'src/format.js', obligations: ['I-4'] }, { pattern: 'src/**', obligations: ['I-1', 'I-4'] }] },
};

describe('M3 ids', () => {
  it('numbered ids, job ids of each kind, lane revs and environment ids', () => {
    assert.equal(visionClauseId('V-3'), 'V-3');
    assert.equal(obligationId('I-12'), 'I-12');
    assert.equal(findingIdOf(4), 'F-4');
    assert.equal(divergenceId('D-1'), 'D-1');
    for (const bad of ['V-0', 'V-01', 'I-', 'F-x', 'D-1a']) assert.throws(() => (bad[0] === 'V' ? visionClauseId(bad) : bad[0] === 'I' ? obligationId(bad) : bad[0] === 'F' ? findingId(bad) : divergenceId(bad)), InvalidIdError, bad);
    assert.deepEqual(parseJobId(jobIdOf('baseline-2')), { kind: 'baseline', n: 2 });
    for (const k of ['audit', 'ckpt', 'docs', 'batch', 'baseline'] as const) assert.equal(jobId(k, 3), `${k}-3`);
    assert.throws(() => jobIdOf('review-1'), InvalidIdError);
    assert.throws(() => jobIdOfKind('docs')('audit-1'), InvalidIdError);
    assert.throws(() => laneRev('0123'), InvalidIdError);
    assert.throws(() => envId('XYZ'), InvalidIdError);
  });
});

describe('M3 inputs: vision, obligations, ruling sidecars', () => {
  const clauses = [
    { id: 'V-1', kind: 'purpose', text: 'bookkeepers reconcile a month in one command', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'money is never silently mis-rounded', rank: null, state: 'active' },
    { id: 'V-3', kind: 'tradeoff', text: 'clear errors over permissive input', rank: 1, state: 'withdrawn' },
  ];
  const v = { schema: 'roadmap/vision-m3', rev: 1, confirmation: { ref: 'phase0/playback#3', at: AT }, clauses };

  it('the vision: a tradeoff is ranked and nothing else is; ids unique; one active clause at least', () => {
    assert.deepEqual(parseVision(v), v);
    assert.throws(() => parseVision({ ...v, clauses: [{ ...clauses[2], rank: null }] }), /rank/);
    assert.throws(() => parseVision({ ...v, clauses: [{ ...clauses[0], rank: 2 }] }), /rank/);
    assert.throws(() => parseVision({ ...v, clauses: [clauses[0], clauses[0]] }), /clauses/);
    assert.throws(() => parseVision({ ...v, clauses: [clauses[2]] }), /active clause/);
  });

  it('obligations: split parents carry no witness (H14), children name their parent, the mapping names known ids', () => {
    const o: Obligations = parseObligations(OBLIGATIONS);
    assert.equal(canonicalJson(o), canonicalJson(OBLIGATIONS));
    assert.match(laneRevOf(o.lanes[0]!), /^[0-9a-f]{16}$/);
    const [i1, i2, i4] = OBLIGATIONS.obligations as readonly Record<string, unknown>[];
    const with2 = (x: Record<string, unknown>) => ({ ...OBLIGATIONS, obligations: [i1, x, i4] });
    assert.throws(() => parseObligations(with2({ ...i2, witness: { lane: 'journey', testIds: ['t'] } })), /witness/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, obligations: [{ ...i1, witness: null }, i2, i4] }), /witness/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, obligations: [{ ...i1, deliveredBy: [] }, i2, i4] }), /deliveredBy/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, obligations: [i1, i2, { ...i4, parent: 'I-1' }] }), /parent/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, mapping: { paths: [{ pattern: 'src/**', obligations: ['I-9'] }] } }), /mapping/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, lanes: [{ ...OBLIGATIONS.lanes[0], env: { set: { NODE_OPTIONS: '-r x' }, pass: [] } }] }), /env/);
    assert.throws(() => parseObligations({ ...OBLIGATIONS, obligations: [{ ...i1, witness: { lane: 'nope', testIds: ['t'] } }, i2, i4] }), /witness\.lane/);
  });

  it('a ruling sidecar requires consistency (G21), contract ops for a deviation, cites and evidence from the checkpoint', () => {
    const r = {
      schema: 'roadmap/ruling-m3', id: 'C-7', statement: 'totals round half-even', kind: 'constraint', ruledBy: { type: 'checkpoint', job: 'ckpt-1' }, trigger: 'F-1',
      supersedes: [{ id: 'C-3', part: null }], condition: null,
      docRefs: [{ path: 'docs/money.md', anchor: '#rounding', quotedText: 'round half-even', relation: 'deviates' }],
      contractRefs: ['docs/money.md'], contractOps: [{ path: 'docs/money.md', anchor: '#rounding', oldText: 'round half-up', newText: 'round half-even' }],
      obligations: ['I-2'], obligationDispositions: [{ id: 'I-2', disposition: 'amended' }], cites: ['V-2'], evidence: ['F-1 on S'],
      appliesTo: { type: 'arc' }, lifetime: 'standing', status: 'active',
      consistency: {
        verdict: 'consistent', judgedRevs: { head: A, ledgerSha256: H, obligationsSha256: H2, visionSha256: H, contracts: [{ path: 'docs/money.md', blob: B }] },
        by: { type: 'judgment', role: 'checkpoint', routingRev: REV },
      },
    };
    assert.equal(canonicalJson(parseRulingSidecar(r)), canonicalJson(r));
    const { consistency: _c, ...noConsistency } = r;
    assert.throws(() => parseRulingSidecar(noConsistency), /consistency/);
    assert.throws(() => parseRulingSidecar({ ...r, contractOps: [] }), /contractOps/);
    assert.throws(() => parseRulingSidecar({ ...r, cites: [] }), /cites/);
    assert.throws(() => parseRulingSidecar({ ...r, consistency: { ...r.consistency, by: { type: 'judgment', role: 'build', routingRev: REV } } }), /role/);
  });

  it('a witness record: a malformed run records no tests', () => {
    const w = {
      v: 1, lane: 'journey', laneRev: LANE_REV, envId: ENV, treeSha: A, inv: INV, runner: 'node-test', purpose: 'witness',
      records: [{ testId: 'a', selected: 1, outcome: 'pass' }, { testId: 'b', selected: 0, outcome: 'zero-selected' }], malformed: false,
    };
    assert.deepEqual(witnessRecord(w, 'w'), w);
    assert.throws(() => witnessRecord({ ...w, malformed: true }, 'w'), /records/);
    assert.throws(() => witnessRecord({ ...w, records: [...w.records].reverse() }, 'w'), /records/);
  });

  it('finding keys hash (lens, obligation, cause) only', () => {
    assert.equal(findingKey('invariants', obligationId('I-2'), 'rounding'), findingKey('invariants', obligationId('I-2'), 'rounding'));
    assert.notEqual(findingKey('invariants', obligationId('I-2'), 'rounding'), findingKey('drift', obligationId('I-2'), 'rounding'));
    assert.notEqual(findingKey('invariants', null, 'rounding'), findingKey('invariants', obligationId('I-2'), 'rounding'));
  });
});

describe('M3 event records', () => {
  it('every holistic fact round-trips byte-identically', () => {
    for (const f of Object.values(HOLISTIC_FACTS)) roundTrip(fact(f));
  });

  it('fact rules: mutant runs never certify (G13), plan-check opens P3 vision conflicts (R17), witness findings are P1', () => {
    refusesFact({ ...HOLISTIC_FACTS.witnessed, purpose: 'mutant' }, /\.for$/);
    refusesFact({ ...HOLISTIC_FACTS.witnessed, for: { type: 'mutant', finding: 'F-1', of: A } }, /\.for$/);
    roundTrip(fact({ ...HOLISTIC_FACTS.witnessed, purpose: 'mutant', for: { type: 'mutant', finding: 'F-1', of: A } }));
    const opened = HOLISTIC_FACTS['finding-opened'];
    refusesFact({ ...opened, lens: 'invariants' }, /mutant/);
    refusesFact({ ...opened, lens: 'plan-check', mutant: null }, /source/);
    const planCheck = { ...opened, lens: 'plan-check', mutant: null, severity: 'P3', source: { type: 'stage', unit: 'u1', stage: 'plan-check', attempt: 2 } };
    roundTrip(fact(planCheck));
    refusesFact({ ...planCheck, severity: 'P2' }, /severity/);
    refusesFact({ ...planCheck, visionClauses: [] }, /severity/);
    refusesFact({ ...opened, lens: 'witness', mutant: null, severity: 'P2' }, /severity/);
    refusesFact({ ...opened, lens: 'vision', mutant: null, severity: 'P1' }, /severity/);
    refusesFact({ ...HOLISTIC_FACTS['audit-started'], job: 'ckpt-1' }, /job/);
    refusesFact({ ...HOLISTIC_FACTS['checkpoint-inputs'], visionSha256: H2 }, /vector\.visionSha256/);
    refusesFact({ ...HOLISTIC_FACTS['divergence-digest'], ids: [] }, /ids/);
    refusesFact({ ...HOLISTIC_FACTS.divergence, cites: [] }, /cites/);
  });

  const planApplied = {
    kind: 'plan-applied', rev: 5, command: CMD, planSha256: H, specs: { u1: H },
    changes: [
      { type: 'obligation', id: 'I-4', edit: 'split' }, { type: 'mapping' }, { type: 'vision', rev: 2 }, { type: 'limits', unit: null },
      { type: 'limits', unit: 'u1' }, { type: 'routing', routingRev: REV, unit: 'u1' }, { type: 'holistic' },
    ] satisfies readonly object[],
    source: { type: 'command', command: CMD }, payloadSha256: H2, rulingsSha256: H, obligationsSha256: H2, visionSha256: H,
    publication: { pub: 'docs-1', head: A },
    routingProvenance: { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: { build: { low: 'frontier' } }, unitLayers: { u1: { gate: { med: 'summit' } } } },
  };

  it('plan-applied: the M3 fields round-trip; a dev.5 fact without them is read as written', () => {
    roundTrip(fact(planApplied));
    const { source: _s, payloadSha256: _p, rulingsSha256: _r, obligationsSha256: _o, visionSha256: _v, publication: _pub, routingProvenance: _rp, ...dev5 } = planApplied;
    const back = roundTrip(fact({ ...dev5, changes: [{ type: 'routing', routingRev: REV }] }));
    assert.ok(back.type === 'fact' && back.fact.kind === 'plan-applied' && back.fact.source === undefined);
    refusesFact({ ...planApplied, source: { type: 'start' } }, /source/);
    refusesFact({ ...planApplied, source: { type: 'bundle', job: 'audit-1' } }, /source/);
    refusesFact({ ...planApplied, command: null, source: { type: 'command', command: CMD } }, /source/);
    roundTrip(fact({ ...planApplied, command: null, source: { type: 'bundle', job: 'ckpt-1' } }));
    roundTrip(fact({ ...planApplied, command: null, source: { type: 'executor', inv: INV } }));
    const { visionSha256: _vision, ...noVision } = planApplied;
    refusesFact(noVision, /obligationsSha256/);
  });

  it('the revision payload (G1) holds the manifest, changes, dispositions, divergences, publication plan and provenance', () => {
    const p = {
      v: 1, source: { type: 'bundle', job: 'ckpt-1' }, base: 4, rev: 5,
      manifest: { planSha256: H, specs: { u1: H }, rulings: { ledgerSha256: H, sidecars: { 'C-7': H2 } }, obligations: H2, vision: H },
      changes: planApplied.changes as readonly PlanChange[], dispositions: [{ obligation: 'I-2', disposition: 'amended', ruling: 'C-7' }], divergences: [draft],
      publication: { renders: [{ path: '.roadmap/invariants.md', sha256: H }], contractOps: [] }, routingProvenance: planApplied.routingProvenance,
    };
    assert.equal(canonicalJson(parseRevisionPayload(p)), canonicalJson(p));
    assert.throws(() => parseRevisionPayload({ ...p, rev: 6 }), /rev/);
    assert.throws(() => parseRevisionPayload({ ...p, manifest: { planSha256: H, specs: { u1: H } } }), /rulings/);
  });

  it('holders, parents, subjects and meter subjects of jobs; batch candidates; docs and batch ffs', () => {
    const transition = (holder: object): LogRecord => ({
      type: 'intent', op: opId(ARC, 2), kind: 'resource.transition', key: 'resources:x', parent: { type: 'job', job: 'audit-1' }, ordinal: 1, deadlineAt: null,
      expect: { holder, resources: ['integration-slot'], edge: { type: 'reserve' } }, post: null,
    } as unknown as LogRecord);
    for (const holder of [{ type: 'docs', pub: 'docs-1' }, { type: 'batch', finding: 'F-1', attempt: 2 }, { type: 'job', job: 'baseline-1' }]) roundTrip(transition(holder));
    assert.throws(() => roundTrip(transition({ type: 'docs', pub: 'audit-1' })), SchemaError);
    const spawn = (subject: object): LogRecord => ({
      type: 'intent', op: opId(ARC, 2), kind: 'proc.spawn', key: 'spawn:x', parent: { type: 'job', job: 'audit-1' }, ordinal: 1, deadlineAt: null,
      expect: { subject, launchSha256: H }, post: null,
    } as unknown as LogRecord);
    roundTrip(spawn({ purpose: 'arc-backend', role: 'lens', tier: 'arc', routingRev: REV, job: 'audit-1', attempt: 1 }));
    roundTrip(spawn({ purpose: 'journey', lane: 'journey', laneRev: LANE_REV, at: A, owner: { type: 'job', job: 'audit-1' } }));
    roundTrip(spawn({ purpose: 'mutant', finding: 'F-1', lane: 'journey', laneRev: LANE_REV, tree: B }));
    assert.throws(() => roundTrip(spawn({ purpose: 'arc-backend', role: 'gate', tier: 'arc', routingRev: REV, job: 'audit-1', attempt: 1 })), SchemaError);
    assert.throws(() => roundTrip(spawn({ purpose: 'backend', role: 'lens', tier: 'arc', routingRev: REV, unit: 'u1', attempt: 1 })), SchemaError);
    roundTrip(fact({ kind: 'meter', inv: INV, routingRev: REV, subject: { type: 'job', role: 'checkpoint', tier: 'arc', job: 'ckpt-1', attempt: 1 }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, turns: null, costUsd: null } }));

    const fp = { unitCommit: B, specRev: 2, contractRevs: [], rulingRevs: [] };
    const batch = (members: readonly object[], chain: readonly object[], next: string): LogRecord => ({
      type: 'intent', op: opId(ARC, 2), kind: 'candidate.merge', key: 'candidate', parent: { type: 'job', job: 'batch-1' }, ordinal: 1, deadlineAt: null,
      expect: {
        ref: 'refs/roadmap-run/arc-1/candidate/batch-1', old: null, integrationTip: A, unitCommit: B, worktree: '/wt/c',
        commit: { tree: A, parents: [A, B], author: { name: 'r', email: 'r@x', date: '1790000000 +0000' }, committer: { name: 'r', email: 'r@x', date: '1790000000 +0000' }, message: 'm', gpgsign: false },
        batch: { job: 'batch-1', members, chain },
      },
      post: { new: next },
    } as unknown as LogRecord);
    const C = sha('c'.repeat(40));
    const members = [{ unit: 'r1', unitCommit: B, fingerprint: fp }, { unit: 'r2', unitCommit: C, fingerprint: { ...fp, unitCommit: C } }];
    roundTrip(batch(members, [{ commit: A, parents: [B, C] }], A));
    assert.throws(() => roundTrip(batch(members, [{ commit: A, parents: [B, B] }], A)), /parents\[1\]/);
    assert.throws(() => roundTrip(batch(members, [], B)), /chain/);
    assert.throws(() => roundTrip(batch(members.slice(0, 1), [], B)), /members/);
    const ff = (expect: object): LogRecord => ({
      type: 'intent', op: opId(ARC, 2), kind: 'integration.ff', key: 'ff', parent: { type: 'job', job: 'docs-1' }, ordinal: 1, deadlineAt: null, expect, post: null,
    } as unknown as LogRecord);
    roundTrip(ff({ ref: 'refs/heads/main', old: A, new: B, subject: { type: 'docs', pub: 'docs-1' } }));
    roundTrip(ff({ ref: 'refs/heads/main', old: A, new: B, subject: { type: 'batch', job: 'batch-1' } }));
    assert.throws(() => roundTrip(ff({ ref: 'refs/heads/main', old: A, new: B, subject: { type: 'docs', pub: 'docs-1' }, fingerprint: fp })), SchemaError);
  });

  it('stage outcomes: reproduce, and a candidate preempted or finding-blocked', () => {
    for (const out of ['reproduced', 'not-reproduced', 'inapplicable']) {
      roundTrip(fact({ kind: 'stage-outcome', unit: U1, stage: 'reproduce', attempt: 1, outcome: out, class: out === 'reproduced' ? 'advance' : 'park', chargeable: false }));
    }
    for (const out of ['preempted', 'finding-blocked']) roundTrip(fact({ kind: 'stage-outcome', unit: U1, stage: 'candidate', attempt: 4, outcome: out, class: 'advance', chargeable: false }));
  });

  it('judgment-inputs: a gate\'s carry its captured fingerprint at its head (Checkpoint A); a dev.5 one has none; a plan-check\'s never', () => {
    const gate = { kind: 'judgment-inputs', unit: U1, stage: 'gate', attempt: 4, tip: A, head: B, specRev: 2, specSha256: H, planRev: 3, routingRev: REV };
    const fingerprint = { unitCommit: B, specRev: 2, contractRevs: [{ path: 'ARCHITECTURE.md', blob: A }], rulingRevs: [{ id: 'C-1', rev: 2 }] };
    roundTrip(fact(gate));
    roundTrip(fact({ ...gate, fingerprint }));
    refusesFact({ ...gate, fingerprint: { ...fingerprint, unitCommit: A } }, /fingerprint\.unitCommit$/);
    refusesFact({ ...gate, stage: 'plan-check', head: null, fingerprint }, /\.fingerprint$/);
  });
});

describe('M3 file records', () => {
  it('the approval fingerprint: obligationRevs absent exactly when there are none (a dev.5 fingerprint reads as none)', () => {
    const fp = { unitCommit: A, specRev: 2, contractRevs: [], rulingRevs: [] };
    assert.deepEqual(obligationRevsOf(approvalFingerprint(fp, 'fp')), []);
    const withRevs = { ...fp, obligationRevs: [{ id: 'I-1', rev: 1 }, { id: 'I-2', rev: 3 }] };
    assert.deepEqual(approvalFingerprint(withRevs, 'fp'), withRevs);
    assert.throws(() => approvalFingerprint({ ...fp, obligationRevs: [] }, 'fp'), /obligationRevs/);
    assert.throws(() => approvalFingerprint({ ...fp, obligationRevs: [{ id: 'I-2', rev: 1 }, { id: 'I-1', rev: 1 }] }, 'fp'), /obligationRevs/);
  });

  it('the dispatch record: transientRules and bounds are optional and kept as written', () => {
    const d = { unit: 'u1', specRev: 1, specSha256: H, scope: ['src/**'], riskFloor: 'med', routingRev: REV, implementerSeatRev: 'fedcba9876543210', at: AT };
    assert.deepEqual(dispatchRecord(d, 'd'), d);
    const m3 = { ...d, transientRules: 'm3', bounds: { ...DEFAULT_BOUNDS, chargeable: 4 } };
    assert.deepEqual(dispatchRecord(m3, 'd'), m3);
    assert.throws(() => dispatchRecord({ ...d, transientRules: 'dev5' }, 'd'), /transientRules/);
    assert.throws(() => dispatchRecord({ ...d, bounds: { chargeable: 4 } }, 'd'), /bounds/);
  });

  it('a residue key names a unit or a job, never both (G4)', () => {
    const base = { arc: 'arc-1', inv: INV, resource: 'estate#1' };
    assert.deepEqual(residueOwner(residueKey({ ...base, unit: 'u1' }, 'k')), { type: 'unit', unit: 'u1' });
    assert.deepEqual(residueOwner(residueKey({ ...base, job: 'audit-2' }, 'k')), { type: 'job', job: 'audit-2' });
    assert.throws(() => residueKey({ ...base, unit: 'u1', job: 'audit-2' }, 'k'), /unit/);
    assert.throws(() => residueKey(base, 'k'), /unit/);
  });

  it('command bodies: the M3 commands, and an apply manifest in either shape (G15)', () => {
    const bodies = [
      { type: 'rule', path: '/r/rulings/C-7.json', sha256: H },
      { type: 'reverse', divergence: 'D-3' },
      { type: 'steer', unit: 'u1', brief: { path: '/r/brief.md', sha256: H }, budgetMin: 45, class: 'frontier', resume: true },
      { type: 'steer', unit: 'u1', brief: { path: '/r/brief.md', sha256: H }, budgetMin: 45, class: null, resume: false },
      { type: 'merge-in', unit: 'u1' },
      { type: 'audit', lenses: ['drift', 'vision'] },
      { type: 'audit', lenses: null },
      { type: 'close-admissions' },
      { type: 'apply', expectRev: 3, manifest: { planSha256: H, specs: { u1: H } } },
      { type: 'apply', expectRev: null, manifest: { planSha256: H, specs: { u1: H }, rulings: { ledgerSha256: H, sidecars: {} }, obligations: null, vision: H2 } },
    ];
    for (const b of bodies) assert.deepEqual(commandBody(b, 'b'), b);
    assert.throws(() => commandBody({ type: 'steer', unit: 'u1', brief: { path: '/r/b', sha256: H }, budgetMin: 0, class: null, resume: false }, 'b'), /budgetMin/);
    assert.throws(() => commandBody({ type: 'audit', lenses: ['vision', 'drift'] }, 'b'), /lenses/);
    assert.throws(() => commandBody({ type: 'apply', expectRev: null, manifest: { planSha256: H, specs: { u1: H }, rulings: { ledgerSha256: H, sidecars: {} } } }, 'b'), /obligations/);
  });

  it('spec: obligations and repairs, absent when none', () => {
    const spec = {
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [], acceptance: [{ id: 'A1', clause: 'x', failLoudIfUndelivered: true, state: 'active' }], scope: ['src/**'],
      resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    };
    assert.deepEqual(specM1(spec, 's'), spec);
    assert.deepEqual(specObligations(specM1(spec, 's')), []);
    const m3 = { ...spec, obligations: ['I-1'], repairs: ['F-2', 'I-2'] };
    assert.deepEqual(specM1(m3, 's'), m3);
    assert.throws(() => specM1({ ...spec, obligations: [] }, 's'), /obligations/);
    assert.throws(() => specM1({ ...spec, repairs: ['F-2', 'F-2'] }, 's'), /repairs/);
    assert.throws(() => specM1({ ...spec, repairs: ['C-2'] }, 's'), /repairs/);
  });

  it('plan: holistic, limits, a unit routing layer and limits, the repair origin; bounds resolve unit over plan over built-in', () => {
    const unit = { id: 'u1', spec: 'specs/u1.json', risk: 'med', scope: ['src/**'], resources: [], after: [], contingent: [] };
    const base = {
      schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
      architectureDoc: 'docs/arch.md', direction: 'd', suite: { lanes: [] }, resources: [], units: [unit],
    };
    const m3 = {
      ...base,
      holistic: { vision: 'vision.json', obligations: 'obligations.json', audit: { every: 2, lenses: ['invariants', 'vision'], wallClockMin: 120 } },
      limits: { chargeable: 4, convergenceK: 1 },
      units: [{ ...unit, origin: 'repair', routing: { gate: { med: 'summit' } }, limits: { redirects: 1 } }, { ...unit, id: 'u2', spec: 'specs/u2.json' }],
    };
    const plan = parsePlan(m3);
    assert.deepEqual(plan, m3);
    assert.deepEqual(boundsOf(plan, plan.units[0]!), { ...DEFAULT_BOUNDS, chargeable: 4, redirects: 1 });
    assert.deepEqual(boundsOf(plan, plan.units[1]!), { ...DEFAULT_BOUNDS, chargeable: 4 });
    assert.deepEqual(lensSetOf(plan.holistic!), ['invariants', 'vision']);
    assert.deepEqual(lensSetOf({ vision: plan.holistic!.vision }), ['invariants', 'drift', 'vacuity', 'vision']);
    assert.equal(DEFAULT_CONVERGENCE_K, 3);
    const noM3 = parsePlan(base);
    assert.equal(noM3.holistic, undefined);
    assert.deepEqual(boundsOf(noM3, noM3.units[0]!), DEFAULT_BOUNDS);
    assert.throws(() => parsePlan({ ...base, holistic: { obligations: 'o.json' } }), /holistic\.vision/);
    assert.throws(() => parsePlan({ ...base, holistic: { vision: 'v.json', audit: { lenses: ['vision', 'drift'] } } }), /lenses/);
    assert.throws(() => parsePlan({ ...base, limits: { chargeable: 0 } }), /limits\.chargeable/);
    assert.throws(() => parsePlan({ ...base, units: [{ ...unit, limits: { convergenceK: 2 } }] }), /convergenceK/);
    assert.deepEqual(ORIGIN_RANK, { repair: 0, checkpoint: 1, planned: 2 });
  });
});

describe('M3 judgment outputs', () => {
  const lens = {
    findings: [{ severity: 'P2', obligation: null, visionClauses: ['V-1'], claim: 'c', cause: 'k', evidence: [{ path: 'src/a.js', line: 2 }], mutant: { patch: '--- a\n+++ b\n', lane: 'journey' } }],
    reasons: ['r'], premises: [],
  };
  const op = { op: 'admit', unit: { id: 'r1', risk: 'med', scope: ['src/format.js'], after: [], origin: 'repair' }, spec: '{}', cites: ['V-2'], evidence: ['F-1'] };
  const ckpt = {
    decision: 'bundle', reasons: ['F-1'], ops: [op], rulings: [], findingDispositions: [{ finding: 'F-1', disposition: 'accepted', reason: 'r' }],
    interpretations: [{ clauses: ['V-1'], situation: 's', reading: 'r' }], cites: { vision: ['V-2'], observations: [{ treeSha: A, lane: 'journey', laneRev: LANE_REV, envId: ENV }], findings: ['F-1'] },
    premises: [],
  };

  it('lens: severities P1-P3, obligation ids, unique clauses', () => {
    validateLensOutput(lens);
    assert.throws(() => validateLensOutput({ ...lens, findings: [{ ...lens.findings[0], severity: 'blocking' }] }), /severity/);
    assert.throws(() => validateLensOutput({ ...lens, findings: [{ ...lens.findings[0], visionClauses: ['V-1', 'V-1'] }] }), /visionClauses/);
  });

  it('checkpoint: every op cites active-looking clauses and evidence; ops exactly on a bundle; owner-only acts only as a request (A16)', () => {
    validateCheckpointOutput(ckpt);
    validateCheckpointOutput({ ...ckpt, decision: 'no-op', ops: [] });
    assert.throws(() => validateCheckpointOutput({ ...ckpt, decision: 'no-op' }), /ops/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [] }), /ops/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, decision: 'no-op', ops: [], rulings: ['{}'] }), /rulings/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [{ ...op, cites: [] }] }), /cites/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [{ ...op, evidence: [] }] }), /evidence/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [{ op: 'vision', cites: ['V-1'], evidence: ['e'] }] }), /op/);
    const more = [
      { op: 'patch-spec', unit: 'u1', patch: [{ op: 'strike', id: 'A3' }] },
      { op: 'reenter', unit: 'u2', reenters: 'u1', enterAt: null, reset: 'C-4' },
      { op: 'cut', unit: 'u1', reason: 'r' },
      { op: 'route', unit: 'u1', seats: [{ role: 'gate', tier: 'med', class: 'summit' }] },
      { op: 'limits', unit: null, limits: [{ field: 'convergenceK', value: 2 }] },
      {
        op: 'obligation-split', obligation: 'I-2',
        children: [{ id: 'I-5', statement: 's', docRef: { path: 'docs/t.md', anchor: '#a', quotedText: 'q' }, witness: { lane: 'journey', testIds: ['t'] }, activation: 'must-hold', deliveredBy: [] }],
      },
      { op: 'obligation-dispose', obligation: 'I-3', disposition: 'deferred', ruling: 'C-9' },
      { op: 'invalidate-approval', unit: 'u1' },
      { op: 'rule', ruling: 'C-9' },
      { op: 'request', class: 'cost', summary: 'a paid estate' },
    ].map((o) => ({ ...o, cites: ['V-1'], evidence: ['e'] }));
    const out = validateCheckpointOutput({ ...ckpt, ops: more });
    assert.equal(out.ops.length, more.length);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [{ ...more[3], seats: [{ role: 'build', tier: 'arc', class: 'summit' }] }] }), /tier/);
    assert.throws(() => validateCheckpointOutput({ ...ckpt, ops: [{ ...more[9], class: 'anything' }] }), /class/);
  });
});

describe('table.total: the obligation transition table', () => {
  const verdicts = [...OBSERVATION_VERDICTS, null] as const;
  /** Every case the table takes, split parents over every pair of child effects included. */
  function* cases(): Generator<Readonly<{ c: ObligationCase; expected: ObligationEffect }>> {
    yield { c: { type: 'exempt' }, expected: 'exempt' };
    for (const verdict of verdicts) {
      yield { c: { type: 'future', completing: false, verdict }, expected: 'measured' };
      yield { c: { type: 'future', completing: true, verdict }, expected: verdict === 'held' ? 'latch' : 'red' };
      yield { c: { type: 'must-hold', verdict }, expected: verdict === 'held' ? 'discharged' : 'red' };
    }
    for (const a of OBLIGATION_EFFECTS) for (const b of OBLIGATION_EFFECTS) for (const sa of [true, false]) for (const sb of [true, false]) {
      const children = [{ effect: a, selected: sa }, { effect: b, selected: sb }];
      const nonExempt = children.filter((ch) => ch.effect !== 'exempt');
      const expected: ObligationEffect = children.some((ch) => ch.selected && ch.effect === 'red') ? 'red'
        : nonExempt.every((ch) => ch.effect === 'discharged') ? 'discharged' : 'measured';
      yield { c: { type: 'split', children }, expected };
    }
  }

  it('maps every case to exactly its row, and every effect is reached', () => {
    const reached = new Set<ObligationEffect>();
    let n = 0;
    for (const { c, expected } of cases()) {
      const effect = obligationEffect(c);
      assert.equal(effect, expected, JSON.stringify(c));
      reached.add(effect);
      n += 1;
    }
    assert.equal(n, 1 + verdicts.length * 3 + OBLIGATION_EFFECTS.length ** 2 * 4);
    assert.deepEqual([...reached].sort(), [...OBLIGATION_EFFECTS].sort());
  });

  it('a split parent: red only through a selected child; an unselected red child leaves it measured', () => {
    assert.equal(obligationEffect({ type: 'split', children: [{ effect: 'red', selected: false }, { effect: 'discharged', selected: true }] }), 'measured');
    assert.equal(obligationEffect({ type: 'split', children: [{ effect: 'discharged', selected: false }, { effect: 'exempt', selected: false }] }), 'discharged');
    assert.equal(obligationEffect({ type: 'split', children: [{ effect: 'latch', selected: true }, { effect: 'discharged', selected: true }] }), 'measured');
  });
});
