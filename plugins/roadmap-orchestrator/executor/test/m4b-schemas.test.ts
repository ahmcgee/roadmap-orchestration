// Retained host telemetry, routing provenance and checkpoint contracts from M4b; schema 2 has no flow loop.
import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { schemaViolation } from '../src/backends/adapter.ts';
import { type Envelope,type Event,type Fact,type LogRecord,parseEventLine,prevHash,serializeEvent } from '../src/core/events.ts';
import {
arcId,jobId,opId,sha256,
} from '../src/core/ids.ts';
import { spawnPressureOf,startPressureOf } from '../src/core/projections.ts';
import { Fold } from '../src/core/state.ts';
import { SchemaError } from '../src/core/validate.ts';
import { isoTime } from '../src/core/values.ts';
import { checkpointIdsOf } from '../src/holistic/checkpoint.ts';
import type { Obligations } from '../src/holistic/types.ts';
import { CHECKPOINT_SCHEMA,checkpointSchemaFor } from '../src/prompts/schemas.ts';
import { arcStack,parseRepoConfig,resolveRouting,routingRevOf,seatsInForce } from '../src/routing/layers.ts';
import { routingProvenance } from '../src/routing/types.ts';
import { ARC as LOG_ARC,H as LOG_H,PROVENANCE,appliedFields,chain } from './fixtures/log-records.ts';
import { checkpointAnswer } from './helpers/holistic.ts';

const ARC = arcId('arc-3');
const H = sha256('d'.repeat(64));
const AT = isoTime('2026-10-08T12:00:00.000Z');

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

describe('m4b rev 3: host pressure records', () => {
  const result = { kind: 'result', resultSha256: H, summary: { type: 'command', verdict: 'stall' } };
  const done = (outcome: object): LogRecord => ({ type: 'done', op: opId(ARC, 2), kind: 'proc.spawn', outcome, recoveredBy: null }) as unknown as LogRecord;

  it('a start records schedstat availability and a spawn result its pressure; both absent on an earlier executor\'s, read with defaults', () => {
    roundTrip(fact({ kind: 'executor-started', generation: 3, host: { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 31 }, pressure: 'available' }));
    roundTrip(fact({ kind: 'executor-started', generation: 3, pressure: 'unavailable' }));
    roundTrip(fact({ kind: 'executor-started', generation: 3, host: { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 31 } }));
    roundTrip(fact({ kind: 'executor-started', generation: 3 }));
    refuses(fact({ kind: 'executor-started', generation: 3, pressure: 'none' }), /\.pressure$/);
    for (const pressure of [0, 0.37, 1, null]) roundTrip(done({ ...result, pressure }));
    for (const pressure of [1.01, -0.1, '0.3']) refuses(done({ ...result, pressure }), /\.pressure$/);
    const old = roundTrip(done(result));
    assert.ok(old.type === 'done' && old.kind === 'proc.spawn' && old.outcome.kind === 'result');
    assert.equal(spawnPressureOf(old.outcome), null);
    assert.equal(spawnPressureOf({ pressure: 0.4 }), 0.4);
    assert.equal(startPressureOf({pressure: 'unavailable'}), 'unavailable');
    assert.equal(startPressureOf({ pressure: 'available' }), 'available');
  });

  it('host-pressure hold cause names the invocation', () => {
    const held = { kind: 'stage-outcome', unit: 'u1', stage: 'lanes', attempt: 1, outcome: 'interrupted', class: 'hold', chargeable: false, cause: { type: 'host-pressure', inv: 'arc-3/7#1' } };
    roundTrip(fact(held));
    refuses(fact({ ...held, cause: { type: 'host-pressure', inv: 'u1' } }), /\.cause\.inv$/);
  });

});

describe('m4b routing: role-set provenance survives flow retirement', () => {
  it('schema 2 refuses retired flow facts, job kinds, routing seats and givens', () => {
    for (const kind of ['flow-series', 'flow-started', 'flow-ended', 'flow-requested', 'flow-decided', 'flow-proof', 'flow-applied', 'flow-verdict']) {
      refuses(fact({ kind }), /\.kind$/);
    }
    for (const kind of ['flow', 'proof']) assert.throws(() => jobId(kind as never, 1), /JobId/);
    assert.throws(() => parseRepoConfig({ routing: { seats: { flow: { arc: 'efficient' } } } }), /\.flow/);
    assert.throws(() => parseRepoConfig({ flow: { givens: [] } }), /\.flow/);
  });

  it('without a role set the rev stays stable; provenance stays additive and flow is never seated', () => {
    const dev7 = resolveRouting(arcStack('default', null, null));
    const m4b = resolveRouting({ ...arcStack('default', null, null), arcRoles: 'm4b' });
    assert.equal(dev7.rev, routingRevOf(dev7.table, 'none', null, false));
    assert.equal(m4b.rev, dev7.rev, 'the retired flow seat is not hashed');
    assert.ok(!seatsInForce(dev7).some((s) => String(s.role) === 'flow'));
    assert.deepEqual(seatsInForce(m4b).filter((s) => String(s.role) === 'flow'), []);
    for (const scope of ['architecture-doc', 'corpus'] as const) {
      assert.equal(routingRevOf(m4b.table, scope, 'm4b', false), routingRevOf(m4b.table, scope, null, false), scope);
      assert.ok(!seatsInForce(resolveRouting({ ...arcStack('default', null, null), arcScope: scope, arcRoles: 'm4b' })).some((s) => String(s.role) === 'flow'), scope);
    }
    // The provenance records the role set additively: absent reads as absent.
    const p = { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} };
    assert.equal(routingProvenance(p, 'p').arcRoles, undefined);
    assert.equal(routingProvenance({ ...p, arcRoles: 'm4b' }, 'p').arcRoles, 'm4b');
    assert.throws(() => routingProvenance({ ...p, arcRoles: 'm4a' }, 'p'), SchemaError);
  });
});

describe('m4b fold: the role set is fixed at revision 1', () => {
  const applied = (rev: number, arcRoles: 'm4b' | null): LogRecord => fact({
    kind: 'plan-applied', rev, command: null, planSha256: LOG_H, specs: {}, changes: [], ...appliedFields(rev, null),
    routingProvenance: arcRoles === null ? PROVENANCE : { ...PROVENANCE, arcRoles },
  });
  const fold = (records: readonly LogRecord[]): Fold => {
    const f = new Fold(LOG_ARC);
    for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    return f;
  };

  it('every later revision carries revision 1\'s role set, absent (dev.7) or m4b', () => {
    assert.equal(fold([applied(1, 'm4b'), applied(2, 'm4b')]).planApplied()?.routingProvenance.arcRoles, 'm4b');
    assert.equal(fold([applied(1, null), applied(2, null)]).planApplied()?.routingProvenance.arcRoles, undefined);
    assert.throws(() => fold([applied(1, null), applied(2, 'm4b')]), /arcRoles m4b; revision 1 fixed none/);
    assert.throws(() => fold([applied(1, 'm4b'), applied(2, null)]), /arcRoles none; revision 1 fixed m4b/);
  });
});

describe('m4b: the checkpoint schema closes the ids its call knows (paid M4b run 5, ckpt-4)', () => {
  const child = (lane: string) => ({
    id: 'I-9', statement: 's', docRef: null, rule: 'T-1', witness: { lane, testIds: ['t'], files: [] }, activation: 'future', deliveredBy: [],
  });
  const split = (obligation: string, lane: string) => checkpointAnswer({
    decision: 'bundle', ops: [{ op: 'obligation-split', obligation, children: [child(lane)], cites: ['V-1'], evidence: ['e'] }],
  });
  const dispose = (obligation: string) => checkpointAnswer({
    decision: 'bundle', ops: [{ op: 'obligation-dispose', obligation, disposition: 'waived', ruling: 'C-2', cites: ['V-1'], evidence: ['e'] }],
  });
  const obligations = {
    lanes: [{ id: 'w-clash' }, { id: 'w-free' }],
    obligations: [{ id: 'I-1', state: { type: 'active' } }, { id: 'I-2', state: { type: 'split', children: ['I-3'] } }, { id: 'I-3', state: { type: 'active' } }],
  } as unknown as Obligations;

  it('checkpointIdsOf: the arc lanes, the active obligations a split may name, every obligation a dispose may name; none outside an arc with obligations', () => {
    assert.deepEqual(checkpointIdsOf(obligations), { arcLanes: ['w-clash', 'w-free'], splittable: ['I-1', 'I-3'], obligations: ['I-1', 'I-2', 'I-3'] });
    assert.equal(checkpointIdsOf(null), null);
  });

  it('an unknown witness lane, a split of an obligation not active, a dispose of one not in force: schema violations; the known ones conform', () => {
    const schema = checkpointSchemaFor(checkpointIdsOf(obligations));
    assert.equal(schemaViolation(schema, split('I-1', 'w-clash')), null);
    assert.match(schemaViolation(schema, split('I-1', 'w-draught')) ?? '', /ops\[0\]/, 'run 5 ckpt-4: w-draught is no arc lane');
    assert.match(schemaViolation(schema, split('I-2', 'w-clash')) ?? '', /ops\[0\]/, 'I-2 is split already');
    assert.throws(() => dispose('I-2'), /expected one of/);
    assert.throws(() => dispose('I-7'), /expected one of/);
  });

  it('no ids known (null, or an empty set): any id, the prompt module\'s schema; the bundle\'s validation refuses an unknown one', () => {
    assert.deepEqual(checkpointSchemaFor(null), CHECKPOINT_SCHEMA);
    assert.equal(schemaViolation(CHECKPOINT_SCHEMA, split('I-1', 'w-draught')), null);
    assert.equal(schemaViolation(checkpointSchemaFor({ arcLanes: [], splittable: [], obligations: [] }), split('I-1', 'w-draught')), null);
  });
});
