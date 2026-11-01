import { systemName } from '../src/core/ids.ts';
// M4a rev 3 step N0: the records frozen before their behaviour lands (SCHEMAS.md "M4a rev 3"). Round trips of every new
// record and arm (byte-identical through the canonical reader), the refusals that keep illegal states out, the dev.6
// read-time defaults (`upgrade.defaults-rev3`), the lane-rev normalisation (F7), the open-attempt reading (R50), the new
// plan and spec fields, the role schemas and the CLI forms. Run 10 (D): checkpoint.admit-spec-schema, checkpoint.admit-spec-read,
// upgrade.admit-spec-text.
import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { schemaViolation } from '../src/backends/adapter.ts';
import { DETAILED_OUTCOMES,type Envelope,type Event,type Fact,type LogRecord,STAGE_OUTCOME_KINDS,parseEventLine,prevHash,serializeEvent } from '../src/core/events.ts';
import {
InvalidIdError,arcId,commandId,jobId,knownDefectId,
opId,opKey,opportunityId,sha,sha256,unitId,witnessItemId
} from '../src/core/ids.ts';
import { canonicalJson,canonicalJson as cj,sha256Hex } from '../src/core/json.ts';
import { DEFAULT_BOUNDS,boundsOfRecord,dispatchRecord,laneDef,laneDefOf,redFile,specM1,specPatchOp } from '../src/core/records.ts';
import { Fold,openAttempt } from '../src/core/state.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath,isoTime } from '../src/core/values.ts';
import { debtSource } from '../src/debt/types.ts';
import { type ArcLaneDef,admitClass,conversion,laneRevOf,parseObligations,witnessLaneFile } from '../src/holistic/types.ts';
import { CliError,parseCommand } from '../src/input/cli.ts';
import { knownDefectsOf,parsePlan,priorityOf } from '../src/input/plan.ts';
import {
BUILD_SCHEMA,CHECKPOINT_SCHEMA,buildOutput,
validateCheckpointOutput
} from '../src/prompts/schemas.ts';
import { compareRank } from '../src/schedule/types.ts';
import { parseSpec,specBytes } from '../src/spec/spec.ts';
import { ARC as LOG_ARC,H as LOG_H,U1,chain,spawnIntent,spawnResult } from './fixtures/log-records.ts';

const ARC = arcId('arc-2');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const H = sha256('d'.repeat(64));
const AT = isoTime('2026-10-06T12:00:00.000Z');
const CKPT = jobId('ckpt', 3);
const INV = `arc-2/7#1`;

const envelope = (seq: number): Envelope => ({ v: 2, seq, prev: seq === 1 ? null : H, at: AT, arc: ARC });
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

const LANE = { id: 'unit', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, cadence: 'build', resources: [], evidenceGlobs: [], evidenceExcludes: [] };
const ARC_LANE = { ...LANE, id: 'journey', reporter: 'jsonl' };
const obligationsWith = (lane: object) => ({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [lane], obligations: [], mapping: { systems: [] } });

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
  it('a lane spawn carries redRev and a reuse identity (spec and, since dev.17, suite lanes); a journey spawn redRev', () => {
    const identity = { laneRev: '0123456789abcdef', envId: 'fedcba9876543210', argv0: { path: '/usr/bin/node', sha256: H } };
    const lane = { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'spec', at: A, redRev: 2, identity };
    roundTrip(intent('proc.spawn', { subject: lane, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { ...lane, identity: { ...identity, argv0: null } }, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'suite', at: A }, launchSha256: H }));
    roundTrip(intent('proc.spawn', { subject: { ...lane, set: 'suite' }, launchSha256: H }));
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

  it('a bundle revision\'s source carries its admit classes and conversions, together or not at all (dev.13: a brake\'s conversions alone)', () => {
    const expect = (source: object) => ({ source, base: 4, rev: 5, payloadSha256: H, docs: false });
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits, conversions }), null, { type: 'job', job: CKPT }));
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits: [], conversions: [] }), null, { type: 'job', job: CKPT }));
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT }), null, { type: 'job', job: CKPT }));
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, admits }), null, { type: 'job', job: CKPT }), /conversions$/);
    const braked = [{ index: 0, unit: 'u4', reason: 'regress-brake', opportunity: null }, { index: 1, unit: 'u5', reason: 'settled-brake', opportunity: null }];
    roundTrip(intent('revision.commit', expect({ type: 'bundle', job: CKPT, conversions: braked }), null, { type: 'job', job: CKPT }));
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, conversions }), null, { type: 'job', job: CKPT }), /conversions$/);
    refuses(intent('revision.commit', expect({ type: 'bundle', job: CKPT, conversions: [] }), null, { type: 'job', job: CKPT }), /conversions$/);
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
    // The 2026-10-15 batch: a fast suite red on the unit's diff base alone too.
    const base = '0'.repeat(40);
    roundTrip(outcome('lanes', 'base-red', 'advance', false, { kind: 'base-red', base, lanes: ['lint'], changedCheckout: false }));
    roundTrip(outcome('lanes', 'base-red', 'advance', false, { kind: 'base-red', base, lanes: [], changedCheckout: true }));
    refuses(outcome('lanes', 'base-red', 'advance', false), /detail$/);
    refuses(outcome('lanes', 'base-red', 'advance', false, { kind: 'base-red', base, lanes: [], changedCheckout: false }), /detail$/);
    for (const key of Object.keys(DETAILED_OUTCOMES)) {
      const [stage, kind] = key.split('/') as [keyof typeof STAGE_OUTCOME_KINDS, string];
      assert.ok((STAGE_OUTCOME_KINDS[stage] as readonly string[]).includes(kind), key);
    }
  });

  it('plan changes: priority, known defects, plan-check shape; a re-entry', () => {
    const applied = (changes: readonly object[]) => fact({
      kind: 'plan-applied', rev: 2, command: 'cmd-0123456789abcdef', planSha256: H, specs: { u1: H }, changes,
      source: { type: 'command', command: 'cmd-0123456789abcdef' }, payloadSha256: H, rulingsSha256: H,
      routingProvenance: { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} },
    });
    roundTrip(applied([{ type: 'unit-priority', unit: 'u1' }, { type: 'known-defects' }, { type: 'plan-check-shape' }]));
    roundTrip(applied([{ type: 'unit-reentered', unit: 'u2', reenters: 'u1', reset: false }]));
  });

  it('a dispatch record\'s bounds carry the smoke bounds; a dev.6 record\'s, without them, read as written', () => {
    const record = {
      unit: 'u1', specRev: 1, specSha256: H,  riskFloor: 'med', routingRev: '0123456789abcdef', implementerSeatRev: '0123456789abcdef', at: AT,
      transientRules: 'm3',
    };
    const { smokeRounds: _r, smokeRuns: _n, ...dev6 } = DEFAULT_BOUNDS;
    roundTrip(fact({ kind: 'dispatch', record: { ...record, bounds: DEFAULT_BOUNDS } }));
    assert.throws(() => roundTrip(fact({ kind: 'dispatch', record: { ...record, bounds: dev6 } })), /smokeRounds/);
    refuses(fact({ kind: 'dispatch', record: { ...record, bounds: { ...dev6, smokeRuns: 2 } } }), /smokeRounds$/);
    assert.deepEqual(boundsOfRecord(dispatchRecord({ ...record, bounds: { ...DEFAULT_BOUNDS, smokeRounds: 3, smokeRuns: 5 } }, 'r')), { ...DEFAULT_BOUNDS, smokeRounds: 3, smokeRuns: 5 });
  });
});

describe('m4a-rev3 files', () => {
  it('red.json: a red run\'s class, written once before the rerun decision', () => {
    same(redFile, { v: 2, class: { kind: 'repeat', attempt: 2, inv: INV }, failure: H, redRev: 2 });
    same(redFile, { v: 2, class: { kind: 'host-signature', signatures: ['eagain', 'enospc'] }, failure: H, redRev: 2 });
    same(redFile, { v: 2, class: { kind: 'diagnostic' }, failure: H, redRev: 1 });
    assert.throws(() => redFile({ v: 2, class: { kind: 'host-signature', signatures: ['enospc', 'eagain'] }, failure: H, redRev: 2 }, 'r'), /table order/);
    assert.throws(() => redFile({ v: 2, class: { kind: 'host-signature', signatures: [] }, failure: H, redRev: 2 }, 'r'), SchemaError);
  });

  it('a witness-check lane file: the lane to run and the ids it must make pass', () => {
    same(witnessLaneFile, { v: 2, lane: 'journey', argv: ['node', '--test'], cwd: '.', env: { set: { TZ: 'UTC' }, pass: ['PATH'] }, reporter: 'node-test', required: ['a', 'b'] });
    assert.throws(() => witnessLaneFile({ v: 2, lane: 'journey', argv: ['node'], cwd: '.', env: { set: {}, pass: [] }, reporter: 'jsonl', required: [] }, 'w'), SchemaError);
  });
});

describe('m4a-rev3 plan and spec', () => {
  const unit = { id: 'u1', spec: 'specs/u1.json', risk: 'med', systems: [systemName('app')], resources: [] };
  const plan = {
    schema: 'roadmap/plan-m1', arc: 'arc-2', integrationBranch: 'main', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
    direction: 'd', suite: { lanes: [] }, resources: [], units: [unit, { ...unit, id: 'u2', spec: 'specs/u2.json' }], architectureDoc: 'docs/arch.md',
  };

  it('plan.knowndefects-parse: known defects and unit priority; absent reads as none and normal; a dev.16 plan-check shape reads and drops (dev.17)', () => {
    const p = parsePlan({
      ...plan, units: [{ ...unit, priority: 'high' }, { ...unit, id: 'u2', spec: 'specs/u2.json' }], planCheck: { shape: 'by-builder' },
      knownDefects: [{ id: 'K-1', match: { type: 'lane', lane: 'e2e' }, fixUnit: 'u2' }, { id: 'K-2', match: { type: 'output', lane: 'unit', contains: 'ETIMEDOUT' }, fixUnit: 'u2' }],
    });
    assert.deepEqual(knownDefectsOf(p).map((k) => k.id), ['K-1', 'K-2']);
    assert.ok(!('planCheck' in p), 'dev.17: the removed field is dropped at read (planCheckShapeDefault)');
    assert.deepEqual(p.units.map(priorityOf), ['high', 'normal']);
    const bare = parsePlan(plan);
    assert.deepEqual([knownDefectsOf(bare), priorityOf(bare.units[0]!)], [[], 'normal']);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [] }), SchemaError);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [{ id: 'K-1', match: { type: 'lane', lane: 'a' }, fixUnit: 'u2' }, { id: 'K-1', match: { type: 'lane', lane: 'b' }, fixUnit: 'u2' }] }), /knownDefects/);
    assert.throws(() => parsePlan({ ...plan, knownDefects: [{ id: 'K-1', match: { type: 'output', lane: 'a' }, fixUnit: 'u2' }] }), /contains/);
    assert.throws(() => parsePlan({ ...plan, planCheck: { shape: 'per-unit' } }), /shape/);
    assert.throws(() => parsePlan({ ...plan, units: [{ ...unit, priority: 'urgent' }] }), /priority/);
  });

  it('spec.inputs-kept: spec, suite and arc lanes preserve declared reuse inputs', () => {
    const withInputs = { ...LANE, inputs: ['src/**', 'package.json'] };
    assert.deepEqual(laneDefOf('spec')(withInputs, 'l').inputs, ['src/**', 'package.json']);
    assert.deepEqual(laneDef({ ...laneDefOf('spec')(LANE, 'l'), inputs: ['src/**'] }, 'l').inputs, ['src/**']);
    assert.deepEqual(parsePlan({ ...plan, suite: { lanes: [withInputs] } }).suite.lanes[0]!.inputs, ['src/**', 'package.json']);
    assert.deepEqual(parseObligations(obligationsWith({ ...ARC_LANE, inputs: ['src/**'] })).lanes[0]!.inputs, ['src/**']);
    // An arc lane's testPaths (D2): non-empty when present.
    assert.deepEqual(parseObligations(obligationsWith({ ...ARC_LANE, testPaths: ['test/**'] })).lanes[0]!.testPaths, ['test/**']);
    assert.throws(() => parseObligations(obligationsWith({ ...ARC_LANE, testPaths: [] })), SchemaError);
  });

  it('a spec\'s witness items: unique among its item ids, absent reads as none', () => {
    const spec = { intent: 'Implement the stated acceptance.', nonGoals: ['No unrelated changes.'],
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 2, lanes: [], acceptance: [{ id: 'A1', clause: 'c', failLoudIfUndelivered: false, state: 'active' }],
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



});

describe('m4a-rev3 role schemas', () => {
  it('the build answer: targeted experiments, with old lanesRun accepted and ignored', () => {
    const answer = { docsOnlySince: null, summary: 's', changedPaths: [], lanesRun: [{ lane: 'unit', exit: 0 }], blockers: [], experiments: [{ name: 'probe', argv: ['node', 'x.js'], exit: 1 }], final: true };
    const {lanesRun: _legacy, ...fresh} = answer;
    const out = buildOutput(fresh, 'build');
    assert.throws(() => buildOutput(answer, 'build'), /lanesRun/);
    assert.deepEqual(out.experiments, answer.experiments);
    assert.ok(!('lanesRun' in out));
    const { lanesRun: _old, ...current } = answer;
    assert.deepEqual(buildOutput(current, 'build'), out);
    const schema = BUILD_SCHEMA as { required: string[]; properties: Record<string, unknown> };
    assert.ok(!('lanesRun' in schema.properties));
    assert.ok(!schema.required.includes('lanesRun'));
    assert.ok('experiments' in schema.properties);
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
    const spec = laneDefOf('spec');
    assert.equal(laneRevOf({ ...spec(LANE, 'l'), state: 'active' } as never), laneRevOf(spec(LANE, 'l')));
    assert.notEqual(laneRevOf(spec({ ...LANE, systems: ['api'] }, 'l')), laneRevOf(spec(LANE, 'l')), 'systems are part of the definition');
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
  it('parses witness-check, resume-arc, inputs export and the removed ruling option is refused', () => {
    assert.deepEqual(parseCommand(['witness-check', '--lane-file', 'w.json']), { command: 'witness-check', laneFile: 'w.json' });
    assert.deepEqual(parseCommand(['resume-arc', '--repo', '.']), { command: 'resume-arc', repo: '.' });
    assert.deepEqual(parseCommand(['inputs', 'export', '--repo', '.', '--arc', 'arc-1', '--out', 'x']), { command: 'inputs-export', repo: '.', arc: 'arc-1', out: 'x' });
    const refuses = (argv: readonly string[], message: RegExp): void => assert.throws(() => parseCommand(argv), (e: unknown) => e instanceof CliError && message.test(e.message), argv.join(' '));
    refuses(['witness-check'], /--lane-file <file> is required/);
    refuses(['resume-arc', '--repo', '.', 'x'], /unexpected argument/);
    refuses(['inputs', 'import'], /expected the subcommand export/);
    refuses(['inputs', 'export', '--repo', '.', '--arc', 'Bad Arc', '--out', 'x'], /ArcId/);
    refuses(['apply', '--ruling', 'a.json'], /unknown option/);
    refuses(['apply', '--dry-run', '--dry-run'], /given twice/);
    void commandId;
  });
});

describe('run 10 (D): a checkpoint admit\'s spec is constrained by the schema', () => {
  const wire = { intent: 'Implement the stated acceptance.', nonGoals: ['No unrelated changes.'],
    schema: 'roadmap/spec-m1', unit: 'gap', rev: 1,  resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
    lanes: [{
      id: 'unit', argv: ['node', '--test'], cwd: '.', env: { set: [{ name: 'TZ', value: 'UTC' }], pass: [] }, expectedExit: 0, cadence: 'build', resources: [],
      evidenceGlobs: [], evidenceExcludes: [], state: 'active',
    }],
    acceptance: [{ id: 'A1', clause: 'A booking names one berth.', failLoudIfUndelivered: true, state: 'active' }],
    obligations: [], repairs: ['F-1'],
  };
  const admit = (spec: unknown) => ({
    op: 'admit', unit: { id: 'gap', risk: 'low', systems: [systemName('app')], after: [], origin: 'repair' }, spec, targets: [], cites: ['V-1'], evidence: ['F-1'],
  });
  const answer = (spec: unknown) => ({
    decision: 'bundle', reasons: ['r'], ops: [admit(spec)],  findingDispositions: [], interpretations: [],
    cites: { vision: ['V-1'], observations: [], findings: [] }, premises: [], corpusAmendments: [],
  });

  it('checkpoint.admit-spec-schema: the wire object conforms; JSON text or a spec missing a field is a schema violation the adapter catches', () => {
    assert.equal(schemaViolation(CHECKPOINT_SCHEMA, answer(wire)), null);
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer(JSON.stringify(wire))) ?? '', /ops\[0\]/);
    const { acceptance: _a, ...missing } = wire;
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer(missing)) ?? '', /ops\[0\]/);
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer({ ...wire, schema: 'roadmap/spec-m2' })) ?? '', /ops\[0\]/);
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer({ ...wire, witnesses: [] })) ?? '', /ops\[0\]/, 'no witness items in an admit');
  });

  it('checkpoint.admit-spec-read: the reader turns the wire object into spec.json\'s canonical text (env.set a map, empty lists absent) and refuses a spec the spec reader refuses', () => {
    const out = validateCheckpointOutput(answer(wire));
    const op = out.ops[0]!;
    assert.equal(op.op, 'admit');
    if (op.op !== 'admit') return;
    const spec = parseSpec(Buffer.from(op.spec, 'utf8'), absPath('/gap.json'));
    assert.equal(op.spec, specBytes(spec).toString('utf8'), 'canonical text');
    assert.deepEqual(spec.lanes[0]!.env, { set: { TZ: 'UTC' }, pass: [] });
    assert.equal(spec.obligations, undefined, 'obligations [] reads as none');
    assert.deepEqual(spec.repairs, ['F-1']);
    assert.throws(() => validateCheckpointOutput(answer({ ...wire, acceptance: [] })), (e: unknown) => e instanceof SchemaError && e.field.startsWith('checkpoint.ops[0].spec'));
    assert.throws(() => validateCheckpointOutput(answer({ ...wire, facts: [{ id: 'A1', text: 't', state: 'active' }] })), /a unique id/);
    assert.throws(() => validateCheckpointOutput(answer({ ...wire, lanes: [{ ...wire.lanes[0], env: { set: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }], pass: [] } }] })), SchemaError);
  });


});

describe('schema 2 command forms', () => {
  const run = { type: 'explicit', repo: '.', arc: 'arc-2' };
  const apply = ['apply', '--repo', '.', '--arc', 'arc-2', '--from', 'export', '--rev', '7', '--reason', 'Keep the new contract.'];
  const refuses = (argv: readonly string[], message: RegExp): void => assert.throws(() => parseCommand(argv), (e: unknown) => e instanceof CliError && message.test(e.message), argv.join(' '));

  it('apply parses --from, --rev, --reason and --dry-run', () => {
    assert.deepEqual(parseCommand(apply), { command: 'apply', run, from: 'export', rev: 7, reason: 'Keep the new contract.', dryRun: false });
    assert.deepEqual(parseCommand([...apply, '--dry-run']), { ...parseCommand(apply), dryRun: true });
    for (const flag of ['from', 'rev', 'reason']) {
      const i = apply.indexOf(`--${flag}`);
      refuses([...apply.slice(0, i), ...apply.slice(i + 2)], new RegExp(`--${flag} .* is required`));
    }
    for (const rev of ['0', '-1', '1.5', 'NaN']) refuses(apply.map((v) => v === '7' ? rev : v), /--rev must be a positive integer/);
    for (const reason of [' ', 'first\nsecond']) refuses([...apply.slice(0, -1), reason], /--reason must be one non-empty line/);
    for (const flag of ['--base', '--ruling', '--vision-edit']) refuses([...apply, flag, 'old'], /unknown option/);
  });

  it('note parses its unit and brief and refuses missing arguments', () => {
    assert.deepEqual(parseCommand(['note', 'u1', '--brief', 'note.md', '--repo', '.', '--arc', 'arc-2']), { command: 'note', run, unit: 'u1', brief: 'note.md' });
    refuses(['note', 'u1', '--repo', '.', '--arc', 'arc-2'], /--brief <file> is required/);
    refuses(['note', '--brief', 'note.md', '--repo', '.', '--arc', 'arc-2'], /<unit> is required/);
  });

  it('ack parses an offered choice; optionless-item refusal remains in command execution', () => {
    assert.deepEqual(parseCommand(['ack', 'nu-3', '--choice', 'resolved', '--repo', '.', '--arc', 'arc-2']), { command: 'ack', run, id: 'nu-3', choice: 'resolved' });
    assert.deepEqual(parseCommand(['ack', 'nu-3', '--repo', '.', '--arc', 'arc-2']), { command: 'ack', run, id: 'nu-3', choice: null });
    refuses(['ack', '--repo', '.', '--arc', 'arc-2'], /<needs-user-id> is required/);
    refuses(['ack', 'bad', '--repo', '.', '--arc', 'arc-2'], /NeedsUserId/);
    refuses(['ack', 'nu-3', '--choice', '--repo', '.', '--arc', 'arc-2'], /--choice/);
  });
});
