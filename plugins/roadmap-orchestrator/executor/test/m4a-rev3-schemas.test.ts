// M4a rev 3 step N0: the records frozen before their behaviour lands (SCHEMAS.md "M4a rev 3"). Round trips of every new
// record and arm (byte-identical through the canonical reader), the refusals that keep illegal states out, the dev.6
// read-time defaults (`upgrade.defaults-rev3`), the lane-rev normalisation (F7), the open-attempt reading (R50), the new
// plan and spec fields, the role schemas and the CLI forms.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Envelope, type Event, type Fact, type LogRecord, parseEventLine, serializeEvent } from '../src/core/events.ts';
import {
  InvalidIdError, arcId, commandId, jobId, knownDefectId, laneId, opId, opKey, opportunityId, sha, sha256, unitId, witnessItemId,
} from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { DEFAULT_BOUNDS, boundsOfRecord, commandBody, dispatchRecord, laneDef, redFile, specM1, specPatchOp } from '../src/core/records.ts';
import { Fold, openAttempt } from '../src/core/state.ts';
import {
  HOST_SIGNATURES_DEV6, buildExperimentsDefault, bundleClassesOf, dev6SmokeBounds, mutantSubjectDefault,
} from '../src/core/upgrade.ts';
import { SchemaError } from '../src/core/validate.ts';
import { isoTime } from '../src/core/values.ts';
import { debtSource } from '../src/debt/types.ts';
import { HOST_SIGNATURES } from '../src/host/signatures.ts';
import { type ArcLaneDef, admitClass, conversion, laneRevMatches, laneRevOf, parseObligations, witnessLaneFile } from '../src/holistic/types.ts';
import { CliError, parseCommand } from '../src/input/cli.ts';
import { knownDefectsOf, parsePlan, planCheckShapeOf, priorityOf } from '../src/input/plan.ts';
import { DETAILED_OUTCOMES, STAGE_OUTCOME_KINDS } from '../src/core/events.ts';
import {
  BUILD_SCHEMA, PLAN_ASSESSMENT_SCHEMA, buildOutputFor, buildSchemaFor, validateBuildOutput, validatePlanAssessment, validatePlanCheckAcceptanceOutput,
} from '../src/prompts/schemas.ts';
import { compareRank } from '../src/schedule/types.ts';
import { canonicalJson as cj } from '../src/core/json.ts';
import { sha256Hex } from '../src/core/json.ts';
import { ARC as LOG_ARC, H as LOG_H, U1, chain, spawnIntent, spawnResult } from './fixtures/log-records.ts';
import { prevHash } from '../src/core/events.ts';

const ARC = arcId('arc-2');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const H = sha256('d'.repeat(64));
const AT = isoTime('2026-10-06T12:00:00.000Z');
const CKPT = jobId('ckpt', 3);
const INV = `arc-2/7#1`;

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
const refuses = (record: LogRecord, field: RegExp): void =>
  assert.throws(() => roundTrip(record), (err: unknown) => err instanceof SchemaError && field.test(err.field), JSON.stringify(record));
const intent = (kind: string, expect: object, post: object | null = null, parent: object = { type: 'stage', unit: 'u1', stage: 'lanes', attempt: 2 }): LogRecord =>
  ({ type: 'intent', op: opId(ARC, 2), kind, key: opKey(`k:${kind}`), parent, ordinal: 1, deadlineAt: null, expect, post }) as unknown as LogRecord;
const same = (read: (v: unknown, p: string) => unknown, value: object): void => assert.equal(canonicalJson(read(JSON.parse(JSON.stringify(value)), 'x')), canonicalJson(value));

const LANE = { id: 'unit', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [] };
const ARC_LANE = { ...LANE, id: 'journey', reporter: 'jsonl' };
const obligationsWith = (lane: object) => ({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [lane], obligations: [], mapping: { paths: [] } });

// ---------------------------------------------------------------------------------------------------

describe('m4a-rev3 ids', () => {
  it('known defects K-n, opportunities O-n, witness items W-n; the canonical form only', () => {
    assert.equal(knownDefectId('K-3'), 'K-3');
    assert.equal(opportunityId('O-1'), 'O-1');
    assert.equal(witnessItemId('W-12'), 'W-12');
    for (const [read, bad] of [[knownDefectId, 'K-0'], [opportunityId, 'O-01'], [witnessItemId, 'W-'], [witnessItemId, 'A-1']] as const) {
      assert.throws(() => (read as (v: unknown) => unknown)(bad), InvalidIdError, String(bad));
    }
  });
});

describe('m4a-rev3 spawn subjects and mutant records', () => {
  it('a lane spawn carries redRev and a reuse identity (spec lanes only); a journey spawn redRev', () => {
    const identity = { laneRev: '0123456789abcdef', envId: 'fedcba9876543210', argv0: { path: '/usr/bin/node', sha256: H } };
    const lane = { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'spec', at: A, redRev: 2, identity };
    roundTrip(intent('proc.spawn', { subject: lane, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { ...lane, identity: { ...identity, argv0: null } }, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'suite', at: A }, launchSha256: H }));
    refuses(intent('proc.spawn', { subject: { ...lane, set: 'suite' }, launchSha256: H }), /identity$/);
    refuses(intent('proc.spawn', { subject: { ...lane, redRev: 0 }, launchSha256: H }), /redRev$/);
    roundTrip(intent('proc.spawn', { subject: { purpose: 'journey', lane: 'journey', laneRev: '0123456789abcdef', at: A, owner: { type: 'unit', unit: 'u1' }, redRev: 1 }, launchSha256: H }));
  });

  it('a mutant names what it was made for: a finding or a unit attempt\'s smoke; a dev.6 subject\'s finding reads as written', () => {
    const base = { purpose: 'mutant', lane: 'journey', laneRev: '0123456789abcdef', tree: B };
    roundTrip(intent('proc.spawn', { subject: { ...base, of: { type: 'finding', finding: 'F-2' } }, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { ...base, of: { type: 'smoke', unit: 'u1', attempt: 2 } }, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { ...base, finding: 'F-2' }, launchSha256: H }));
    refuses(intent('proc.spawn', { subject: { ...base, finding: 'F-2', of: { type: 'finding', finding: 'F-2' } }, launchSha256: H }), /\.of$/);
    refuses(intent('proc.spawn', { subject: base, launchSha256: H }), /\.of$/);
    const apply = { worktree: '/wt/m', at: A, patchSha256: H };
    roundTrip(intent('mutant.apply', { ...apply, of: { type: 'smoke', unit: 'u1', attempt: 2 } }));
    roundTrip(intent('mutant.apply', { ...apply, finding: 'F-2' }));
    refuses(intent('mutant.apply', apply), /\.of$/);
  });

  it('mutant.subject-dev6-default: a dev.6 subject or intent reads as of: finding; a rev-3 one keeps its own', () => {
    assert.deepEqual(mutantSubjectDefault({ finding: 'F-2' as never }), { type: 'finding', finding: 'F-2' });
    assert.deepEqual(mutantSubjectDefault({ of: { type: 'smoke', unit: unitId('u1'), attempt: 2 } }), { type: 'smoke', unit: 'u1', attempt: 2 });
  });

  it('a smoke run is witnessed as a mutant and never certifies', () => {
    const w = { kind: 'witnessed', lane: 'journey', laneRev: '0123456789abcdef', envId: 'fedcba9876543210', treeSha: B, inv: INV, recordsSha256: H };
    roundTrip(fact({ ...w, purpose: 'mutant', for: { type: 'smoke', unit: 'u1', attempt: 2, of: A } }));
    refuses(fact({ ...w, purpose: 'witness', for: { type: 'smoke', unit: 'u1', attempt: 2, of: A } }), /\.for$/);
  });
});

describe('m4a-rev3 checkpoint records', () => {
  const admits = [
    { index: 0, unit: 'u4', class: { type: 'repair', refs: ['F-3', 'I-2'], followUp: 'O-1' } },
    { index: 2, unit: 'u5', class: { type: 'opportunity', id: 'O-2', clauses: ['V-5'] } },
    { index: 3, unit: 'u6', class: { type: 'oversight', clauses: ['V-1', 'V-2'] } },
  ];
  const conversions = [{ index: 1, unit: 'u7', reason: 'follow-up-overrun', opportunity: 'O-1' }, { index: 4, unit: 'u8', reason: 'unrelated', opportunity: null }];

  it('a bundle revision\'s source carries its admit classes and conversions, together or not at all', () => {
    const expect = (source: object) => ({ source, base: 4, rev: 5, payloadSha256: H, docs: false });
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits, conversions }), null, { type: 'job', job: CKPT }));
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits: [], conversions: [] }), null, { type: 'job', job: CKPT }));
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT }), null, { type: 'job', job: CKPT }));
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits }), null, { type: 'job', job: CKPT }), /admits$/);
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits, conversions: [{ ...conversions[1], index: 2 }] }), null, { type: 'job', job: CKPT }), /conversions$/);
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits: [admits[1], admits[0]], conversions }), null, { type: 'job', job: CKPT }), /admits\[1\]$/);
  });

  it('admit classes and conversions: closed, with their cross-field rules', () => {
    for (const a of admits) same(admitClass, a.class);
    for (const c of conversions) same(conversion, c);
    assert.throws(() => admitClass({ type: 'unrelated' }, 'x'), SchemaError);
    assert.throws(() => admitClass({ type: 'repair', refs: [], followUp: null }, 'x'), SchemaError);
    assert.throws(() => conversion({ index: 1, unit: 'u7', reason: 'over-budget', opportunity: 'O-1' }, 'x'), /only a follow-up overrun/);
    assert.throws(() => conversion({ index: 1, unit: 'u7', reason: 'follow-up-overrun', opportunity: null }, 'x'), /the opportunity/);
  });

  it('bundle-decided: an all-converted no-op lists its conversions; a busy rejection names the open attempts', () => {
    roundTrip(fact({ kind: 'bundle-decided', job: CKPT, outcome: { kind: 'no-op', conversions: [conversions[1]] } }));
    roundTrip(fact({ kind: 'bundle-decided', job: CKPT, outcome: { kind: 'no-op' } }));
    refuses(fact({ kind: 'bundle-decided', job: CKPT, outcome: { kind: 'no-op', conversions: [] } }), /conversions$/);
    const busy = { kind: 'rejected', reason: 'busy', detail: 'u1 is running build attempt 3', units: [{ unit: 'u1', stage: 'build', attempt: 3 }] };
    roundTrip(fact({ kind: 'bundle-decided', job: CKPT, outcome: busy }));
    const { units: _u, ...busyBare } = busy;
    refuses(fact({ kind: 'bundle-decided', job: CKPT, outcome: busyBare }), /units$/);
    refuses(fact({ kind: 'bundle-decided', job: CKPT, outcome: { ...busy, reason: 'invalid' } }), /units$/);
  });

  it('a converted admit\'s amendment and its overrun debt name their source; the debt names the opportunity', () => {
    roundTrip(fact({ kind: 'corpus-amendment', id: 'M-1', source: { type: 'admit', job: CKPT, index: 1, reason: 'follow-up-overrun' }, rules: [], proposal: 'p', why: 'w', evidence: [] }));
    const debt = { kind: 'debt-banked', id: 'B-4', bankReason: 'opportunity-overrun', what: 'the third repair of O-1', key: H, source: { type: 'admit', job: CKPT, index: 1 }, opportunity: 'O-1' };
    roundTrip(fact(debt));
    const { opportunity: _o, ...debtBare } = debt;
    refuses(fact(debtBare), /opportunity$/);
    refuses(fact({ ...debt, bankReason: 'gate-note' }), /opportunity$/);
    refuses(fact({ ...debtBare, bankReason: 'gate-note' }), /source$/);
    same(debtSource, { type: 'admit', job: CKPT, index: 0 });
  });

  it('an in-session assessment opens a P3 plan-check finding from its build attempt', () => {
    roundTrip(fact({
      kind: 'finding-opened', id: 'F-1', key: H, lens: 'plan-check', severity: 'P3', obligation: null, visionClauses: ['V-2'], claim: 'c', evidence: [], mutant: null,
      source: { type: 'stage', unit: 'u1', stage: 'build', attempt: 1 }, gateHadPassed: false,
    }));
  });

  it('a specs-only drift names its units; absent is a full drift', () => {
    const started = {
      kind: 'audit-started', job: 'audit-2', generation: 1, lenses: ['vision'], integrationSha: A, planRev: 3, ledgerSha256: null, obligationsSha256: null,
      visionSha256: H, owners: [], priorFindings: [], highWater: 9,
    };
    roundTrip(fact({ ...started, triggers: [{ type: 'drift', planRev: 3, specsOnly: ['u1', 'u2'] }] }));
    roundTrip(fact({ ...started, triggers: [{ type: 'drift', planRev: 3 }] }));
    refuses(fact({ ...started, triggers: [{ type: 'drift', planRev: 3, specsOnly: [] }] }), /specsOnly$/);
  });
});

describe('m4a-rev3 facts and outcomes', () => {
  it('lane reuse, series certificates, smoke runs and cross-lens corroboration', () => {
    const parent = { type: 'stage', unit: 'u1', stage: 'lanes', attempt: 3 };
    roundTrip(fact({ kind: 'lane-reused', parent, lane: 'unit', from: { parent: { ...parent, attempt: 2 }, inv: INV, at: A } }));
    roundTrip(fact({ kind: 'series-certified', parent, checkout: '/wt/u1.lanes-3', at: B }));
    const verdict = { killed: [{ lane: 'journey', testId: 't1' }], survived: [{ lane: 'journey', testId: 't2' }], inconclusive: [] };
    roundTrip(fact({ kind: 'smoke-ran', unit: 'u1', attempt: 3, key: H, verdict }));
    refuses(fact({ kind: 'smoke-ran', unit: 'u1', attempt: 3, key: H, verdict: { killed: [], survived: [], inconclusive: [] } }), /verdict$/);
    refuses(fact({ kind: 'smoke-ran', unit: 'u1', attempt: 3, key: H, verdict: { ...verdict, inconclusive: [{ lane: 'journey', testId: 't1' }] } }), /verdict$/);
    roundTrip(fact({ kind: 'finding-corroborated', id: 'F-4', lens: 'invariants', claim: 'the same defect, seen by invariants' }));
  });

  it('the new stage outcomes carry their detail, and only they do', () => {
    const outcome = (stage: string, kind: string, cls: string, chargeable: boolean, detail?: object) =>
      fact({ kind: 'stage-outcome', unit: 'u1', stage, attempt: 2, outcome: kind, class: cls, chargeable, ...(detail === undefined ? {} : { detail }) });
    const missing = { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't1' }], failed: [{ lane: 'journey', testId: 't2' }] };
    roundTrip(outcome('lanes', 'witnesses-missing', 'advance', true, missing));
    roundTrip(outcome('lanes', 'smoke-survived', 'smoke', true, { kind: 'smoke-survived', obligations: ['I-2'], testIds: [{ lane: 'journey', testId: 't2' }] }));
    roundTrip(outcome('lanes', 'known-defect', 'advance', false, { kind: 'known-defect', id: 'K-1', match: { type: 'output', lane: 'mul', contains: 'boom' } }));
    roundTrip(outcome('build', 'infeasible', 'park', false, { kind: 'infeasible', notes: 'the corpus forbids it' }));
    roundTrip(outcome('build', 'risk-raised', 'advance', false));
    roundTrip(outcome('plan-check', 'in-session', 'advance', false));
    refuses(outcome('lanes', 'witnesses-missing', 'advance', true), /detail$/);
    refuses(outcome('lanes', 'witnesses-missing', 'advance', true, { kind: 'witnesses-missing', missing: [], failed: [] }), /detail$/);
    refuses(outcome('lanes', 'green', 'advance', false, missing), /detail$/);
    refuses(outcome('plan-check', 'infeasible', 'route-up', false, { kind: 'infeasible', notes: 'n' }), /detail$/);
    refuses(outcome('lanes', 'known-defect', 'advance', false, missing), /detail$/);
    for (const key of Object.keys(DETAILED_OUTCOMES)) {
      const [stage, kind] = key.split('/') as [keyof typeof STAGE_OUTCOME_KINDS, string];
      assert.ok((STAGE_OUTCOME_KINDS[stage] as readonly string[]).includes(kind), key);
    }
  });

  it('plan changes: priority, known defects, plan-check shape; a re-entry widened by a ruling', () => {
    const applied = (changes: readonly object[]) => fact({
      kind: 'plan-applied', rev: 2, command: 'cmd-0123456789abcdef', planSha256: H, specs: { u1: H }, changes,
      source: { type: 'command', command: 'cmd-0123456789abcdef' }, payloadSha256: H, rulingsSha256: H,
      routingProvenance: { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} },
    });
    roundTrip(applied([{ type: 'unit-priority', unit: 'u1' }, { type: 'known-defects' }, { type: 'plan-check-shape' }]));
    roundTrip(applied([{ type: 'unit-reentered', unit: 'u2', reenters: 'u1', reset: false, widened: { patterns: ['src/b/**', 'test/b/**'], ruling: 'C-4' } }]));
    refuses(applied([{ type: 'unit-reentered', unit: 'u2', reenters: 'u1', reset: false, widened: { patterns: [], ruling: 'C-4' } }]), /patterns$/);
  });

  it('a dispatch record\'s bounds carry the smoke bounds; a dev.6 record\'s, without them, read as written', () => {
    const record = {
      unit: 'u1', specRev: 1, specSha256: H, scope: ['src/**'], riskFloor: 'med', routingRev: '0123456789abcdef', implementerSeatRev: '0123456789abcdef', at: AT,
      transientRules: 'm3',
    };
    const { smokeRounds: _r, smokeRuns: _n, ...dev6 } = DEFAULT_BOUNDS;
    roundTrip(fact({ kind: 'dispatch', record: { ...record, bounds: DEFAULT_BOUNDS } }));
    roundTrip(fact({ kind: 'dispatch', record: { ...record, bounds: dev6 } }));
    refuses(fact({ kind: 'dispatch', record: { ...record, bounds: { ...dev6, smokeRuns: 2 } } }), /smokeRounds$/);
    assert.deepEqual(boundsOfRecord(dispatchRecord({ ...record, bounds: { ...DEFAULT_BOUNDS, smokeRounds: 3, smokeRuns: 5 } }, 'r')), { ...DEFAULT_BOUNDS, smokeRounds: 3, smokeRuns: 5 });
  });
});

describe('m4a-rev3 files', () => {
  it('red.json: a red run\'s class, written once before the rerun decision', () => {
    same(redFile, { v: 1, class: { kind: 'repeat', attempt: 2, inv: INV }, failure: H, redRev: 2 });
    same(redFile, { v: 1, class: { kind: 'host-signature', signatures: ['eagain', 'enospc'] }, failure: H, redRev: 2 });
    same(redFile, { v: 1, class: { kind: 'diagnostic' }, failure: H, redRev: 1 });
    assert.throws(() => redFile({ v: 1, class: { kind: 'host-signature', signatures: ['enospc', 'eagain'] }, failure: H, redRev: 2 }, 'r'), /table order/);
    assert.throws(() => redFile({ v: 1, class: { kind: 'host-signature', signatures: [] }, failure: H, redRev: 2 }, 'r'), SchemaError);
  });

  it('a witness-check lane file: the lane to run and the ids it must make pass', () => {
    same(witnessLaneFile, { v: 1, lane: 'journey', argv: ['node', '--test'], cwd: '.', env: { set: { TZ: 'UTC' }, pass: ['PATH'] }, reporter: 'node-test', required: ['a', 'b'] });
    assert.throws(() => witnessLaneFile({ v: 1, lane: 'journey', argv: ['node'], cwd: '.', env: { set: {}, pass: [] }, reporter: 'jsonl', required: [] }, 'w'), SchemaError);
  });
});

describe('m4a-rev3 plan and spec', () => {
  const unit = { id: 'u1', spec: 'specs/u1.json', risk: 'med', scope: ['src/**'], resources: [] };
  const plan = {
    schema: 'roadmap/plan-m1', arc: 'arc-2', integrationBranch: 'main', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
    direction: 'd', suite: { lanes: [] }, resources: [], units: [unit, { ...unit, id: 'u2', spec: 'specs/u2.json' }], architectureDoc: 'docs/arch.md',
  };

  it('plan.knowndefects-parse: known defects, unit priority and the plan-check shape; absent reads as none, normal and uniform', () => {
    const p = parsePlan({
      ...plan, units: [{ ...unit, priority: 'high' }, { ...unit, id: 'u2', spec: 'specs/u2.json' }], planCheck: { shape: 'by-builder' },
      knownDefects: [{ id: 'K-1', match: { type: 'lane', lane: 'e2e' }, fixUnit: 'u2' }, { id: 'K-2', match: { type: 'output', lane: 'unit', contains: 'ETIMEDOUT' }, fixUnit: 'u2' }],
    });
    assert.deepEqual(knownDefectsOf(p).map((k) => k.id), ['K-1', 'K-2']);
    assert.equal(planCheckShapeOf(p), 'by-builder');
    assert.deepEqual(p.units.map(priorityOf), ['high', 'normal']);
    const bare = parsePlan(plan);
    assert.deepEqual([knownDefectsOf(bare), planCheckShapeOf(bare), priorityOf(bare.units[0]!)], [[], 'uniform', 'normal']);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [] }), SchemaError);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [{ id: 'K-1', match: { type: 'lane', lane: 'a' }, fixUnit: 'u2' }, { id: 'K-1', match: { type: 'lane', lane: 'b' }, fixUnit: 'u2' }] }), /knownDefects/);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [{ id: 'K-1', match: { type: 'output', lane: 'a' }, fixUnit: 'u2' }] }), /contains/);
    assert.throws(() => parsePlan({ ...plan, planCheck: { shape: 'per-unit' } }), /shape/);
    assert.throws(() => parsePlan({ ...plan, units: [{ ...unit, priority: 'urgent' }] }), /priority/);
  });

  it('spec.inputs-only-spec-lanes: a spec lane may declare inputs; a suite or arc lane may not', () => {
    const withInputs = { ...LANE, inputs: ['src/**', 'package.json'] };
    assert.deepEqual(laneDef(withInputs, 'l').inputs, ['src/**', 'package.json']);
    assert.throws(() => laneDef({ ...LANE, inputs: [] }, 'l'), SchemaError);
    assert.throws(() => parsePlan({ ...plan, suite: { lanes: [withInputs] } }), (e: unknown) => e instanceof SchemaError && e.field === 'plan.suite.lanes[0].inputs');
    assert.throws(() => parseObligations(obligationsWith({ ...ARC_LANE, inputs: ['src/**'] })), /an arc lane/);
    // An arc lane's testPaths (D2): non-empty when present.
    assert.deepEqual(parseObligations(obligationsWith({ ...ARC_LANE, testPaths: ['test/**'] })).lanes[0]!.testPaths, ['test/**']);
    assert.throws(() => parseObligations(obligationsWith({ ...ARC_LANE, testPaths: [] })), SchemaError);
  });

  it('a spec\'s witness items: unique among its item ids, absent reads as none', () => {
    const spec = {
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 2, lanes: [], acceptance: [{ id: 'A1', clause: 'c', failLoudIfUndelivered: false, state: 'active' }], scope: ['src/**'],
      resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    };
    const witness = { id: 'W-1', lane: 'journey', testId: 'cancel refunds', clause: 'A1', skeleton: 'cancel then assert the refund', state: 'active' };
    same(specM1, { ...spec, witnesses: [witness] });
    assert.throws(() => specM1({ ...spec, witnesses: [] }, 's'), SchemaError);
    assert.throws(() => specM1({ ...spec, witnesses: [{ ...witness, id: 'A1' }] }, 's'), InvalidIdError);
    assert.throws(() => specM1({ ...spec, facts: [{ id: 'W-1', text: 't', state: 'active' }], witnesses: [witness] }, 's'), /a unique id/);
    same(specPatchOp, { op: 'add', section: 'witnesses', item: { id: 'W-2', lane: 'journey', testId: 't', clause: 'A1', skeleton: 's' } });
  });
});

describe('m4a-rev3 apply body (I2, step N3)', () => {
  it('apply.body-rulings: `rulings` round-trips in the order given; absent reads as none, byte-preserving; empty is refused', () => {
    const H = 'a'.repeat(64);
    const plain = { type: 'apply', expectRev: null, manifest: { planSha256: H, specs: { u1: H }, rulings: { ledgerSha256: H, sidecars: {} }, obligations: null, vision: null } };
    assert.deepEqual(commandBody(plain, 'b'), plain);
    assert.equal(cj(commandBody(plain, 'b')), cj(plain), 'a queued dev.6 apply reads back byte-identical');
    const ruled = { ...plain, rulings: [{ path: '/r/C-3.json', sha256: H }, { path: '/r/C-2.json', sha256: 'b'.repeat(64) }] };
    assert.deepEqual(commandBody(ruled, 'b'), ruled);
    assert.throws(() => commandBody({ ...plain, rulings: [] }, 'b'), /rulings/);
    assert.throws(() => commandBody({ ...plain, rulings: [{ path: 'relative.json', sha256: H }] }, 'b'), /path/);
  });
});

describe('m4a-rev3 role schemas', () => {
  it('the build answer: experiments, and a per-call lane enum', () => {
    const answer = { summary: 's', changedPaths: [], lanesRun: [{ lane: 'unit', exit: 0 }], blockers: [], experiments: [{ name: 'probe', argv: ['node', 'x.js'], exit: 1 }] };
    assert.deepEqual(validateBuildOutput(answer).experiments, answer.experiments);
    assert.throws(() => buildOutputFor([laneId('lint')])(answer, 'build'), /one of lint/);
    assert.equal(buildOutputFor([laneId('unit')])(answer, 'build').lanesRun[0]!.lane, 'unit');
    const schema = buildSchemaFor([laneId('lint'), laneId('unit')]) as { properties: { lanesRun: { items: { properties: { lane: unknown } } }; experiments: unknown } };
    assert.deepEqual(schema.properties.lanesRun.items.properties.lane, { type: 'string', enum: ['lint', 'unit'] });
    assert.ok(schema.properties.experiments !== undefined);
    assert.deepEqual(BUILD_SCHEMA, buildSchemaFor(null), 'one schema for the build role: the modules carry buildSchemaFor(null), each call its own lanes');
    assert.ok('experiments' in (BUILD_SCHEMA as { properties: object }).properties);
  });

  it('the in-session assessment and the acceptance-shape plan-check', () => {
    const a = { planAssessment: { feasible: false, riskFloor: 'high', visionConflict: [{ clauses: ['V-2'], note: 'n' }], premises: [], notes: 'the corpus forbids it' } };
    assert.deepEqual(validatePlanAssessment(a), a);
    assert.ok(canonicalJson(PLAN_ASSESSMENT_SCHEMA).includes('"riskFloor"'));
    assert.throws(() => validatePlanAssessment({ planAssessment: { ...a.planAssessment, riskFloor: 'urgent' } }), SchemaError);
    const redirect = (patch: readonly object[]) => ({ decision: 'redirect', reasons: ['r'], patch, risk: 'med', notes: '', premises: [], visionConflict: [] });
    const witness = { op: 'add', section: 'witnesses', item: { id: 'W-1', lane: 'journey', testId: 't', clause: 'A1', skeleton: 's' } };
    validatePlanCheckAcceptanceOutput(redirect([witness, { op: 'cite', contracts: [], rulings: ['C-1'] }, { op: 'replace', section: 'facts', item: { id: 'F1', text: 't' } }]));
    assert.throws(() => validatePlanCheckAcceptanceOutput(redirect([{ op: 'add', section: 'acceptance', item: { id: 'A9', clause: 'c', failLoudIfUndelivered: false } }])), /acceptance shape/);
    assert.throws(() => validatePlanCheckAcceptanceOutput(redirect([{ op: 'strike', id: 'A1' }])), /acceptance shape/);
  });
});

describe('m4a-rev3 rank', () => {
  it('high priority ranks first, ahead of promotion (R42)', () => {
    const r = (unit: string, extra: object) => ({ unit: unitId(unit), priority: 'normal', origin: 'planned', waitStartSeq: 10, bypassMerges: 0, promoted: false, planIndex: 0, ...extra }) as never;
    assert.ok(compareRank(r('a', { priority: 'high', waitStartSeq: 99 }), r('b', { promoted: true, waitStartSeq: 1 })) < 0);
    assert.ok(compareRank(r('a', { promoted: true }), r('b', { origin: 'repair' })) < 0);
  });
});

describe('types.lane-rev-normalised', () => {
  it('a lane\'s rev is its validated, normalised form: raw input missing a defaulted field hashes as the parsed lane does', () => {
    const parsed = parseObligations(obligationsWith(ARC_LANE)).lanes[0]!;
    const { evidenceExcludes: _e, ...raw } = ARC_LANE;
    assert.equal(laneRevOf(raw as unknown as ArcLaneDef), laneRevOf(parsed));
    // The executor's dev.6 revs are this form already: the hash of the parsed lane's canonical JSON.
    assert.equal(laneRevOf(parsed), sha256Hex(cj(parsed)).slice(0, 16));
    // A spec lane item's state is the item's, not the definition's.
    assert.equal(laneRevOf({ ...laneDef(LANE, 'l'), state: 'active' } as never), laneRevOf(laneDef(LANE, 'l')));
    assert.notEqual(laneRevOf(laneDef({ ...LANE, inputs: ['src/**'] }, 'l')), laneRevOf(laneDef(LANE, 'l')), 'inputs are part of the definition');
  });
});

describe('upgrade.defaults-rev3', () => {
  it('upgrade.dev6-minimal-lane-rev-equal: a rev of the minimal form (defaults omitted) matches; any other rev does not', () => {
    const parsed = parseObligations(obligationsWith(ARC_LANE)).lanes[0]!;
    const { evidenceExcludes: _e, ...minimal } = parsed;
    const minimalRev = sha256Hex(cj(minimal)).slice(0, 16) as never;
    assert.notEqual(minimalRev, laneRevOf(parsed));
    assert.equal(laneRevMatches(minimalRev, parsed), true);
    assert.equal(laneRevMatches(laneRevOf(parsed), parsed), true);
    assert.equal(laneRevMatches('0123456789abcdef' as never, parsed), false);
    const excluded = parseObligations(obligationsWith({ ...ARC_LANE, evidenceExcludes: ['tmp/**'] })).lanes[0]!;
    const { evidenceExcludes: _x, ...dropped } = excluded;
    assert.equal(laneRevMatches(sha256Hex(cj(dropped)).slice(0, 16) as never, excluded), false, 'a non-default field is never dropped');
  });

  it('every dev.6 read-time default: smoke bounds, mutant subjects, build experiments, unclassified bundles, the frozen signature table', () => {
    assert.deepEqual(dev6SmokeBounds(), { smokeRounds: 1, smokeRuns: 2 });
    const { smokeRounds: _r, smokeRuns: _n, ...dev6 } = DEFAULT_BOUNDS;
    const record = dispatchRecord({
      unit: 'u1', specRev: 1, specSha256: H, scope: ['src/**'], riskFloor: 'med', routingRev: '0123456789abcdef', implementerSeatRev: '0123456789abcdef', at: AT,
      transientRules: 'm3', bounds: { ...dev6, chargeable: 4 },
    }, 'r');
    assert.equal(record.bounds?.smokeRounds, undefined, 'read as written');
    assert.deepEqual(boundsOfRecord(record), { ...DEFAULT_BOUNDS, chargeable: 4 });
    assert.deepEqual(mutantSubjectDefault({ finding: 'F-9' as never }), { type: 'finding', finding: 'F-9' });
    const dev6Answer = { summary: 's', changedPaths: [], lanesRun: [], blockers: [] };
    assert.deepEqual(validateBuildOutput(dev6Answer).experiments, []);
    assert.deepEqual(buildExperimentsDefault(), []);
    assert.equal(bundleClassesOf({ type: 'bundle', job: CKPT }), 'unclassified');
    assert.deepEqual(bundleClassesOf({ type: 'bundle', job: CKPT, admits: [], conversions: [] }), { admits: [], conversions: [] });
    assert.deepEqual(HOST_SIGNATURES_DEV6.map((s) => [s.id, String(s.pattern)]), [
      ['golangci-lint-lock', String(/parallel golangci-lint is running/i)],
      ['kind-boot-timeout', String(/failed to create cluster:.*(timed out waiting for the condition|failed to init node with kubeadm)/i)],
      ['eagain', String(/\bEAGAIN\b|Resource temporarily unavailable/)],
      ['enospc', String(/\bENOSPC\b|No space left on device/)],
    ], 'the 4 entries at 0a58349');
    assert.ok(HOST_SIGNATURES_DEV6.every((s) => HOST_SIGNATURES.some((t) => t.id === s.id)));
  });

  it('a dev.6 log folds with no smoke rounds spent and no rev-3 facts', () => {
    const f = new Fold(LOG_ARC);
    for (const e of chain([spawnIntent(1)])) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    assert.equal(f.unit(U1).counters.smokeRounds, 0);
    const h = f.holistic();
    assert.deepEqual([h.laneReuses, h.certificates, h.smokeRuns, h.corroborations], [[], [], [], []]);
  });
});

describe('state.open-attempt-live-vs-abandoned', () => {
  it('an attempt started after the latest executor start is live; one an executor restart found open is abandoned; closed is none', () => {
    const records: LogRecord[] = [
      { type: 'fact', fact: { kind: 'executor-started', generation: 1 } },
      spawnIntent(2, { stage: 'build', attempt: 1 }),
    ];
    const foldOf = (rs: readonly LogRecord[]): Fold => {
      const f = new Fold(LOG_ARC);
      for (const e of chain(rs)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
      return f;
    };
    assert.deepEqual(openAttempt(foldOf(records), U1), { stage: 'build', attempt: 1, live: true });
    const restarted = [...records, { type: 'fact', fact: { kind: 'executor-started', generation: 2 } } as LogRecord];
    assert.deepEqual(openAttempt(foldOf(restarted), U1), { stage: 'build', attempt: 1, live: false });
    const closed = [...restarted, spawnResult(opId(LOG_ARC, 2)),
      { type: 'fact', fact: { kind: 'stage-outcome', unit: U1, stage: 'build', attempt: 1, outcome: 'success', class: 'advance', chargeable: false } } as LogRecord];
    assert.equal(openAttempt(foldOf(closed), U1), null);
    // A later attempt started under the new executor is live again.
    const next = [...closed, { ...spawnIntent(6, { stage: 'quiesce', attempt: 2, key: 'q' }) }];
    assert.deepEqual(openAttempt(foldOf(next), U1), { stage: 'quiesce', attempt: 2, live: true });
    void LOG_H;
  });
});

describe('cli.m4a-rev3', () => {
  it('parses witness-check, resume-arc, inputs export and apply --ruling (repeatable)', () => {
    assert.deepEqual(parseCommand(['witness-check', '--lane-file', 'w.json']), { command: 'witness-check', laneFile: 'w.json' });
    assert.deepEqual(parseCommand(['resume-arc', '--repo', '.']), { command: 'resume-arc', repo: '.' });
    assert.deepEqual(parseCommand(['inputs', 'export', '--repo', '.', '--arc', 'arc-1', '--out', 'x']), { command: 'inputs-export', repo: '.', arc: 'arc-1', out: 'x' });
    assert.deepEqual(parseCommand(['apply', '--ruling', 'a.json', '--ruling', 'b.json']), { command: 'apply', expectRev: null, dryRun: false, rulings: ['a.json', 'b.json'], run: { type: 'host' } });
    assert.deepEqual(parseCommand(['apply']), { command: 'apply', expectRev: null, dryRun: false, rulings: [], run: { type: 'host' } });
    const refuses = (argv: readonly string[], message: RegExp): void => assert.throws(() => parseCommand(argv), (e: unknown) => e instanceof CliError && message.test(e.message), argv.join(' '));
    refuses(['witness-check'], /--lane-file <file> is required/);
    refuses(['resume-arc', '--repo', '.', 'x'], /unexpected argument/);
    refuses(['inputs', 'import'], /expected the subcommand export/);
    refuses(['inputs', 'export', '--repo', '.', '--arc', 'Bad Arc', '--out', 'x'], /ArcId/);
    refuses(['apply', '--ruling', 'a.json', '--ruling', 'a.json'], /given twice/);
    refuses(['apply', '--dry-run', '--dry-run'], /given twice/);
    void commandId;
  });
});
