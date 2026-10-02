// M2 records (SCHEMAS.md "M2"): round-trips of every new or changed record and the validators' refusals.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Envelope, type Event, type Fact, type LogRecord, parseEventLine, probeTargetKey, serializeEvent } from '../src/core/events.ts';
import {
  CPU_POOL, INTEGRATION_SLOT, arcId, commandId, compareResourceUnits, cpuToken, edgeId, invocationId, opId, opKey,
  parseResourceUnit, planRev, resourceInstance, resourceName, resourceUnit, routingRev, sha, sha256, specRev, unitId,
} from '../src/core/ids.ts';
import { commandBody, laneDef, residueKey } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { isoTime } from '../src/core/values.ts';
import { parsePlan } from '../src/input/plan.ts';

const arc = arcId('arc-1');
const op = opId(arc, 7);
const inv = invocationId(op, 1);
const unit = unitId('u1');
const cmd = commandId('cmd-0123456789abcdef');
const H = sha256('d'.repeat(64));
const A = sha('a'.repeat(40));
const rev = routingRev('0123456789abcdef');
const at = isoTime('2026-09-30T12:00:00.000Z');

function event(record: LogRecord, seq = 2): Event {
  const env: Envelope = { v: 1, seq, prev: H, at, arc };
  return { ...env, ...record } as Event;
}

function roundTrip(e: Event): void {
  assert.deepEqual(parseEventLine(serializeEvent(e).slice(0, -1)), e);
}

function refusesLine(record: LogRecord, field: RegExp): void {
  assert.throws(() => parseEventLine(serializeEvent(event(record)).slice(0, -1)), (err: unknown) => {
    assert.ok(err instanceof SchemaError, String(err));
    assert.match(err.message, field);
    return true;
  });
}

const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const transition = (holder: object, resources: readonly string[], edge: object = { type: 'reserve' }): LogRecord => ({
  type: 'intent', op, kind: 'resource.transition', key: opKey('resources:u1'), parent: { type: 'stage', unit, stage: 'build', attempt: 1 }, ordinal: 1,
  deadlineAt: null, expect: { holder, resources, edge }, post: null,
} as LogRecord);

describe('M2 ids', () => {
  it('resource units: named, pool instances and @cpu tokens, each read and taken apart', () => {
    assert.deepEqual(parseResourceUnit(resourceUnit('db')), { type: 'named', name: 'db' });
    assert.deepEqual(parseResourceUnit(resourceUnit('estate#12')), { type: 'instance', pool: 'estate', n: 12 });
    assert.deepEqual(parseResourceUnit(resourceUnit('@cpu#3')), { type: 'cpu', n: 3 });
    assert.equal(cpuToken(2), '@cpu#2');
    assert.equal(CPU_POOL, '@cpu');
    assert.throws(() => resourceName('@cpu'), SchemaError, '@ never occurs in a declared name');
    assert.throws(() => resourceInstance('@cpu#1'), SchemaError, 'a token is no instance');
    for (const bad of ['estate#0', 'estate#', '#1', '@cpu', '@cpu#0', 'Estate#1']) assert.throws(() => resourceUnit(bad), SchemaError, bad);
  });

  it('lock order: names and instances ascending (instances numerically), then @cpu numerically, integration-slot last', () => {
    const units = ['@cpu#10', INTEGRATION_SLOT, 'estate#10', 'db', '@cpu#2', 'estate#2', 'estate-a', 'cpu'].map((u) => resourceUnit(u));
    assert.deepEqual([...units].sort(compareResourceUnits), ['cpu', 'db', 'estate#2', 'estate#10', 'estate-a', '@cpu#2', '@cpu#10', 'integration-slot']);
  });
});

describe('M2 event records', () => {
  it('round-trips the new holders, instances and tokens in lock order, and the reclaim by a retry holder', () => {
    roundTrip(event(transition({ type: 'publication', unit, attempt: 3 }, ['integration-slot'])));
    roundTrip(event(transition({ type: 'stage', unit, stage: 'build', attempt: 1 }, ['db', 'estate#1', 'estate#2', '@cpu#1', '@cpu#4'])));
    roundTrip(event(transition({ type: 'retry', unit, stage: 'lanes', attempt: 4 }, ['estate#2'], { type: 'reclaim' })));
    roundTrip(event(transition({ type: 'stage', unit, stage: 'lanes', attempt: 1 }, ['estate#1'], { type: 'fail', residues: [{ resource: 'estate#1', teardown: inv }] })));
    refusesLine(transition({ type: 'stage', unit, stage: 'build', attempt: 1 }, ['@cpu#1', 'db']), /lock order/);
    refusesLine(transition({ type: 'stage', unit, stage: 'build', attempt: 1 }, ['estate#10', 'estate#2']), /lock order/);
    refusesLine(transition({ type: 'stage', unit, stage: 'build', attempt: 1 }, ['integration-slot', '@cpu#1']), /lock order/);
    refusesLine(transition({ type: 'publication', unit, attempt: 1 }, ['integration-slot'], { type: 'reclaim' }), /only these reclaim/);
    refusesLine(transition({ type: 'stage', unit, stage: 'lanes', attempt: 1 }, ['@cpu#1'], { type: 'fail', residues: [{ resource: '@cpu#1', teardown: inv }] }), /ResourceInstance/);
  });

  it('round-trips a prepare outcome, a park of each class and a hold with a backend cause', () => {
    const facts: object[] = [
      { kind: 'stage-outcome', unit, stage: 'prepare', attempt: 5, outcome: 'conflicted', class: 'advance', chargeable: false },
      {
        kind: 'stage-outcome', unit, stage: 'lanes', attempt: 3, outcome: 'cleanup-failed', class: 'park', chargeable: false,
        park: { class: 'retryable', targets: [{ type: 'resource', instance: 'db' }, { type: 'resource', instance: 'estate#1' }] },
      },
      {
        kind: 'stage-outcome', unit, stage: 'salvage', attempt: 3, outcome: 'commit-failed', class: 'park', chargeable: false,
        park: { class: 'retryable', targets: [{ type: 'backend', backend: 'codex' }, { type: 'host' }, { type: 'resource', instance: 'estate#1' }] },
      },
      { kind: 'stage-outcome', unit, stage: 'candidate', attempt: 9, outcome: 'base-red', class: 'park', chargeable: false, park: { class: 'operator', kind: 'env' } },
      { kind: 'stage-outcome', unit, stage: 'lanes', attempt: 9, outcome: 'red', class: 'park', chargeable: true, park: { class: 'operator', kind: 'design' } },
      { kind: 'stage-outcome', unit, stage: 'build', attempt: 2, outcome: 'interrupted', class: 'hold', chargeable: false, cause: { type: 'backend', backend: 'claude', parkSeq: 40 } },
    ];
    for (const f of facts) roundTrip(event(fact(f)));
    const outcome = (extra: object) => fact({ kind: 'stage-outcome', unit, stage: 'lanes', attempt: 3, outcome: 'cleanup-failed', class: 'park', chargeable: false, ...extra });
    refusesLine(outcome({ park: { class: 'retryable', targets: [] } }), /non-empty/);
    refusesLine(outcome({ park: { class: 'retryable', targets: [{ type: 'host' }, { type: 'backend', backend: 'codex' }] } }), /ascending/);
    refusesLine(outcome({ park: { class: 'retryable', targets: [{ type: 'resource', instance: '@cpu#1' }] } }), /ResourceInstance/);
    refusesLine(fact({ kind: 'stage-outcome', unit, stage: 'lanes', attempt: 1, outcome: 'green', class: 'advance', chargeable: false, park: { class: 'operator', kind: 'env' } }), /park: expected absent unless/);
    refusesLine(fact({ kind: 'stage-outcome', unit, stage: 'lanes', attempt: 1, outcome: 'red', class: 'park', chargeable: true, park: { class: 'operator', kind: 'env' } }), /operator design for the chargeable bound/);
    refusesLine(fact({ kind: 'stage-outcome', unit, stage: 'gate', attempt: 1, outcome: 'approve', class: 'advance', chargeable: false, cause: { type: 'backend', backend: 'claude', parkSeq: 4 } }), /cause: expected absent unless/);
    assert.deepEqual([probeTargetKey({ type: 'backend', backend: 'codex' }), probeTargetKey({ type: 'host' }), probeTargetKey({ type: 'resource', instance: resourceInstance('db') })], ['backend:codex', 'host', 'resource:db']);
  });

  it('round-trips every new fact, and refuses their malformed variants', () => {
    const facts: object[] = [
      { kind: 'backend-park', backend: 'codex', class: 'capacity', inv },
      { kind: 'backend-park', backend: 'claude', class: 'outage', inv: null },
      { kind: 'unparked', unit, command: cmd },
      { kind: 'probe', target: { type: 'host' }, covers: [12, 40], result: 'fail', nextProbeAt: at },
      { kind: 'probe', target: { type: 'backend', backend: 'codex' }, covers: [7], result: 'pass', nextProbeAt: null },
      { kind: 'judgment-inputs', unit, stage: 'gate', attempt: 4, tip: A, head: A, specRev: specRev(2), specSha256: H, planRev: planRev(3), routingRev: rev },
      { kind: 'judgment-inputs', unit, stage: 'plan-check', attempt: 1, tip: A, head: null, specRev: specRev(1), specSha256: H, planRev: planRev(1), routingRev: rev },
      { kind: 'edge-resolved', edge: 'e-top', command: cmd, evidence: 'the migration landed in #412' },
      { kind: 'run-only', command: cmd, units: ['a', 'b'] },
      { kind: 'run-only', command: cmd, units: null },
      { kind: 'implementer-escalated', unit, attempt: 6, from: 'low', to: 'high', stalled: 5 },
      { kind: 'plan-applied', rev: 1, command: null, planSha256: H, specs: { u1: H }, changes: [], scheduling: 'dag' },
      {
        kind: 'plan-applied', rev: 2, command: cmd, planSha256: H, specs: { u1: H, u2: H },
        changes: [{ type: 'unit-cut', unit: 'u3' }, { type: 'unit-reentered', unit: 'u2', reenters: 'u1', reset: false }, { type: 'plan-field', field: 'capacity' }],
      },
    ];
    for (const f of facts) roundTrip(event(fact(f)));
    refusesLine(fact({ kind: 'backend-park', backend: 'codex', class: 'outage', inv }), /null for an outage/);
    refusesLine(fact({ kind: 'backend-park', backend: 'codex', class: 'capacity', inv: null }), /the failed invocation/);
    refusesLine(fact({ kind: 'probe', target: { type: 'host' }, covers: [], result: 'pass', nextProbeAt: null }), /non-empty/);
    refusesLine(fact({ kind: 'probe', target: { type: 'host' }, covers: [4, 4], result: 'pass', nextProbeAt: null }), /ascending seqs/);
    refusesLine(fact({ kind: 'probe', target: { type: 'host' }, covers: [4], result: 'pass', nextProbeAt: at }), /null on a pass/);
    refusesLine(fact({ kind: 'probe', target: { type: 'host' }, covers: [4], result: 'fail', nextProbeAt: null }), /next probe time/);
    refusesLine(fact({ kind: 'judgment-inputs', unit, stage: 'plan-check', attempt: 1, tip: A, head: A, specRev: 1, specSha256: H, planRev: 1, routingRev: rev }), /null for a plan-check/);
    refusesLine(fact({ kind: 'judgment-inputs', unit, stage: 'build', attempt: 1, tip: A, head: A, specRev: 1, specSha256: H, planRev: 1, routingRev: rev }), /plan-check \| gate/);
    refusesLine(fact({ kind: 'run-only', command: cmd, units: ['b', 'a'] }), /ascending/);
    refusesLine(fact({ kind: 'run-only', command: cmd, units: [] }), /non-empty/);
    refusesLine(fact({ kind: 'implementer-escalated', unit, attempt: 6, from: 'high', to: 'high', stalled: 5 }), /below high/);
    refusesLine(fact({ kind: 'implementer-escalated', unit, attempt: 6, from: 'low', to: 'high', stalled: 6 }), /a build attempt before 6/);
    refusesLine(fact({ kind: 'plan-applied', rev: 2, command: null, planSha256: H, specs: { u1: H }, changes: [], scheduling: 'dag' }), /absent after rev 1/);
    refusesLine(fact({ kind: 'plan-applied', rev: 2, command: null, planSha256: H, specs: { u1: H }, changes: [{ type: 'unit-reentered', unit: 'u1', reenters: 'u1', reset: false }] }), /other than the re-entering one/);
    assert.deepEqual(edgeId('e-top'), 'e-top');
  });
});

describe('M2 file records', () => {
  it('commands: resolve-edge and run-only', () => {
    assert.deepEqual(commandBody({ type: 'resolve-edge', edge: 'e-top', evidence: 'done' }, 'body'), { type: 'resolve-edge', edge: 'e-top', evidence: 'done' });
    assert.deepEqual(commandBody({ type: 'run-only', units: ['a', 'b'] }, 'body'), { type: 'run-only', units: ['a', 'b'] });
    assert.deepEqual(commandBody({ type: 'run-only', units: null }, 'body'), { type: 'run-only', units: null });
    assert.throws(() => commandBody({ type: 'resolve-edge', edge: 'e-top', evidence: '' }, 'body'), SchemaError);
    assert.throws(() => commandBody({ type: 'run-only', units: ['b', 'a'] }, 'body'), SchemaError);
  });

  it('a residue is keyed by a named resource or a pool instance, never a token', () => {
    const key = { arc: 'arc-1', unit: 'u1', inv, resource: 'estate#2' };
    assert.deepEqual(residueKey(key, 'key'), key);
    assert.throws(() => residueKey({ ...key, resource: '@cpu#1' }, 'key'), SchemaError);
  });

  it('a lane may name its @cpu tokens; absent stays absent', () => {
    const lane = { id: 'L1', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'estate', resources: [], evidenceGlobs: [], evidenceExcludes: [] };
    assert.equal('cpu' in laneDef(lane, 'lane'), false);
    assert.equal(laneDef({ ...lane, cpu: 6 }, 'lane').cpu, 6);
    assert.throws(() => laneDef({ ...lane, cpu: 0 }, 'lane'), SchemaError);
  });
});

describe('M2 plan fields', () => {
  const tool = { argv: ['true'], cwd: '.', env: { set: {}, pass: [] } };
  const base = {
    schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'integration', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
    architectureDoc: 'docs/arch.md', direction: 'Ship it.', suite: { lanes: [] }, resources: [],
  };
  const u = (id: string, extra: object = {}) => ({ id, spec: `specs/${id}.json`, risk: 'med', scope: ['src/**'], resources: [], ...extra });

  it('capacity, pools, origin, cpu, contingent edges, re-entry and cut parse; absent fields stay absent', () => {
    const plan = parsePlan({
      ...base, capacity: { cpu: 12 }, resources: [{ name: 'estate', probe: tool, teardown: tool, pool: { size: 2 } }],
      units: [
        u('base', { origin: 'planned', cpu: 2 }),
        u('top', { after: ['base'], contingent: [{ id: 'e-top', condition: 'the API is live' }], cut: { reason: 'descoped', ruling: 'C-4' } }),
        u('base2', { reenters: { unit: 'base', enterAt: 'verify', reset: { ruling: 'C-5' } }, origin: 'checkpoint' }),
      ],
    });
    assert.deepEqual(plan.capacity, { cpu: 12 });
    assert.deepEqual(plan.resources[0]?.pool, { size: 2 });
    assert.deepEqual(plan.units.map((x) => [x.origin, x.cpu, x.contingent, x.reenters, x.cut]), [
      ['planned', 2, [], undefined, undefined],
      [undefined, undefined, [{ id: 'e-top', condition: 'the API is live' }], undefined, { reason: 'descoped', ruling: 'C-4' }],
      ['checkpoint', undefined, [], { unit: 'base', enterAt: 'verify', reset: { ruling: 'C-5' } }, undefined],
    ]);
    const plain = parsePlan({ ...base, units: [u('a')] });
    for (const k of ['capacity']) assert.equal(k in plain, false, k);
    for (const k of ['origin', 'cpu', 'reenters', 'cut']) assert.equal(k in (plain.units[0] as object), false, k);
    assert.deepEqual(parsePlan({ ...base, capacity: {}, units: [u('a')] }).capacity, {});
  });

  it('refuses a duplicate contingent id, a re-entry of itself or of a later unit, and non-positive sizes', () => {
    const refuses = (plan: object, field: string): void => {
      assert.throws(() => parsePlan(plan), (err: unknown) => err instanceof SchemaError && err.field.startsWith(field), field);
    };
    refuses({ ...base, units: [u('a', { contingent: [{ id: 'e', condition: 'x' }] }), u('b', { contingent: [{ id: 'e', condition: 'y' }] })] }, 'plan.units[].contingent');
    refuses({ ...base, units: [u('a', { reenters: { unit: 'a' } })] }, 'plan.units[0].reenters.unit');
    refuses({ ...base, units: [u('a', { reenters: { unit: 'b' } }), u('b')] }, 'plan.units[0].reenters.unit');
    refuses({ ...base, units: [u('a', { reenters: { unit: 'b', enterAt: 'candidate' } }), u('b')] }, 'plan.units[0].reenters.enterAt');
    refuses({ ...base, capacity: { cpu: 0 }, units: [u('a')] }, 'plan.capacity.cpu');
    refuses({ ...base, resources: [{ name: 'estate', probe: tool, teardown: tool, pool: { size: 0 } }], units: [u('a')] }, 'plan.resources[0].pool.size');
    refuses({ ...base, units: [u('a', { origin: 'imported' })] }, 'plan.units[0].origin');
  });
});
