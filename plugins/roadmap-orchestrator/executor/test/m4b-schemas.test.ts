// M4b step 0a: the records frozen before their behaviour lands (SCHEMAS.md "M4b: the flow loop"). Round trips of every
// new fact and arm (byte-identical through the canonical reader), the refusals that keep illegal states out, the flow
// role's strict output and its validator, the kept series and inputs readers, and the `arcRoles` gate on the routing rev
// (an arc 1.0.0-dev.7 started keeps its revs; an m4b arc hashes the flow seat too), fixed at revision 1 by the fold.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Envelope, type Event, type Fact, type LogRecord, parseEventLine, prevHash, serializeEvent } from '../src/core/events.ts';
import {
  InvalidIdError, arcId, jobId, opId, opKey, parseStationId, proposalId, proposalIdOf, proposalJob, sha, sha256, stationId,
} from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { commandBody } from '../src/core/records.ts';
import { Fold } from '../src/core/state.ts';
import { ARC as LOG_ARC, H as LOG_H, PROVENANCE, appliedFields, chain } from './fixtures/log-records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { isoTime } from '../src/core/values.ts';
import { parseFlowInputs, parseFlowSeries, parseHostGivens } from '../src/flow/types.ts';
import { CHECKPOINT_SCHEMA, FLOW_SCHEMA, checkpointSchemaFor, validateFlowOutput } from '../src/prompts/schemas.ts';
import { schemaViolation } from '../src/backends/adapter.ts';
import { checkpointIdsOf } from '../src/holistic/checkpoint.ts';
import type { Obligations } from '../src/holistic/types.ts';
import { checkpointAnswer } from './helpers/holistic.ts';
import { arcStack, parseRepoConfig, resolveRouting, routingRevOf, seatsInForce } from '../src/routing/layers.ts';
import { routingProvenance } from '../src/routing/types.ts';
import { spawnPressureOf, startPressureOf } from '../src/core/upgrade.ts';

const ARC = arcId('arc-3');
const A = sha('a'.repeat(40));
const H = sha256('d'.repeat(64));
const AT = isoTime('2026-10-08T12:00:00.000Z');
const CMD = 'cmd-0123456789abcdef';

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

const SUITE_ACTION = { lever: 'suite-lane', lane: 'unit', argv: ['node', '--test', '--test-concurrency=6', 'test/*.test.js'], reporter: 'node-test' };
const PROPOSAL = { id: 'flow-2.0', target: 'suite:unit', action: SUITE_ACTION, rationale: 'six isolated files run serially', risks: 'shared state' };
const SLOT = { station: 'slot:integration', internal: true, component: 'suite:unit' };
const JUDGED = { station: 'slot:integration', agree: true, reason: 'the slot queues' };
const PREIMAGE = { lever: 'suite-lane', lane: 'unit', argv: ['node', '--test', '--test-concurrency=1', 'test/*.test.js'], cpu: null };

describe('m4b ids', () => {
  it('proposals are `<flow job>.<k>`; stations are the closed grammar; jobs flow-n and proof-n', () => {
    assert.equal(proposalIdOf(jobId('flow', 4), 0), 'flow-4.0');
    assert.equal(proposalJob(proposalId('flow-4.0')), 'flow-4');
    assert.throws(() => proposalIdOf(jobId('ckpt', 4), 0), InvalidIdError);
    for (const bad of ['flow-0.0', 'flow-1', 'ckpt-1.0', 'flow-1.01']) assert.throws(() => proposalId(bad), InvalidIdError, bad);
    for (const ok of ['stage:build', 'wait:gate', 'slot:integration', 'wait:slot:integration', 'suite:unit', 'arc-lanes', 'candidate-rest', 'ff', 'snapshot', 'held', 'wait:finding']) {
      assert.equal(stationId(ok), ok);
    }
    assert.deepEqual(parseStationId('wait:plan-check'), { type: 'wait', stage: 'plan-check' });
    assert.deepEqual(parseStationId('wait:finding'), { type: 'finding-wait' });
    for (const bad of ['stage:candidate', 'wait:ff', 'stage:retire', 'suite:9x', 'slot', 'idle']) assert.throws(() => stationId(bad), InvalidIdError, bad);
    assert.equal(jobId('proof', 1), 'proof-1');
  });
});

describe('m4b facts', () => {
  it('each flow fact round-trips byte for byte', () => {
    roundTrip(fact({ kind: 'flow-series', sha256: H, highWater: 812 }));
    roundTrip(fact({ kind: 'flow-started', job: 'flow-2', triggers: ['constraint-shift', 'floor'], inputsSha256: H }));
    roundTrip(fact({ kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: PROPOSAL, dropped: null, constraint: { code: SLOT, judged: JUDGED } }));
    roundTrip(fact({
      kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: null, dropped: { proposal: PROPOSAL, reason: 'rejected-before', detail: 'suite-lane on unit' },
      constraint: { code: SLOT, judged: JUDGED },
    }));
    // A 1.0.0-dev.11 drop reason dev.12 no longer writes reads as recorded (scaffolding: RECORDED_DROP_REASONS).
    roundTrip(fact({
      kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: null, dropped: { proposal: PROPOSAL, reason: 'elevate-early', detail: 'no exploit or subordinate verdict closed on slot:integration this arc' },
      constraint: { code: SLOT, judged: JUDGED },
    }));
    roundTrip(fact({ kind: 'flow-ended', job: 'flow-3', outcome: 'invalid', proposal: null, dropped: null, constraint: { code: null, judged: null } }));
    roundTrip(fact({ kind: 'flow-requested', command: CMD, reason: 'the suite lane ran 6 min on a 1-file change' }));
    roundTrip(fact({ kind: 'flow-decided', proposal: 'flow-2.0', command: CMD, decision: 'accepted', reason: 'test-set-preserving by proof' }));
    roundTrip(fact({
      kind: 'flow-proof', proposal: 'flow-2.0', job: 'proof-1', treeSha: A, oldSha256: H, newSha256: H, outcome: 'preserved', minutes: { old: 6.1, new: 2.1 }, breaksStandIn: false,
    }));
    roundTrip(fact({ kind: 'flow-proof', proposal: 'flow-2.0', job: 'proof-1', treeSha: A, oldSha256: null, newSha256: null, outcome: 'unprovable', minutes: null, breaksStandIn: false }));
    roundTrip(fact({ kind: 'flow-applied', proposal: 'flow-2.0', revision: 4, preimage: PREIMAGE }));
    roundTrip(fact({
      kind: 'flow-verdict', proposal: 'flow-2.0', metric: { type: 'suite-run', lane: 'unit' }, before: { samples: [6.1, 6.3, 5.9, 6.0, 6.2], centre: 6.1, mrBar: 0.2 },
      after: { samples: [2.1, 2.2, 2.0] }, guards: [], verdict: 'improved', preimage: PREIMAGE,
    }));
    roundTrip(fact({ kind: 'executor-started', generation: 3, host: { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 31 } }));
    roundTrip(fact({ kind: 'executor-started', generation: 3 }));
  });

  it('refuses illegal flow states', () => {
    const ended = { kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: PROPOSAL, dropped: null, constraint: { code: SLOT, judged: JUDGED } };
    refuses(fact({ ...ended, outcome: 'failed' }), /\.proposal$/);
    refuses(fact({ ...ended, constraint: { code: SLOT, judged: null } }), /\.constraint\.judged$/);
    refuses(fact({ ...ended, dropped: { proposal: PROPOSAL, reason: 'given', detail: 'd' } }), /\.dropped$/);
    refuses(fact({ ...ended, proposal: { ...PROPOSAL, id: 'flow-1.0' } }), /\.proposal\.id$/);
    refuses(fact({ ...ended, constraint: { code: { ...SLOT, component: null }, judged: JUDGED } }), /\.component$/);
    refuses(fact({ ...ended, constraint: { code: { station: 'stage:build', internal: false, component: 'ff' }, judged: JUDGED } }), /\.component$/);
    refuses(fact({ ...ended, constraint: { code: { station: 'held', internal: true, component: null }, judged: JUDGED } }), /\.station$/);
    refuses(fact({ ...ended, proposal: { ...PROPOSAL, action: { lever: 'suite-lane', lane: 'unit' } } }), /\.action$/);
    refuses(fact({ kind: 'flow-started', job: 'ckpt-2', triggers: ['floor'], inputsSha256: H }), /\.job$/);
    refuses(fact({ kind: 'flow-started', job: 'flow-2', triggers: ['floor', 'buffer-red'], inputsSha256: H }), /\.triggers\[1\]$/);
    refuses(fact({ kind: 'flow-started', job: 'flow-2', triggers: [], inputsSha256: H }), /\.triggers$/);
    refuses(fact({ kind: 'flow-proof', proposal: 'flow-2.0', job: 'proof-1', treeSha: A, oldSha256: H, newSha256: null, outcome: 'changed', minutes: null, breaksStandIn: true }), /\.minutes$/);
    const verdict = {
      kind: 'flow-verdict', proposal: 'flow-2.0', metric: { type: 'lead' }, before: { samples: [40, 42, 38], centre: 3.7, mrBar: 0.2 }, after: { samples: [30, 31, 29] },
      guards: [], verdict: 'improved', preimage: { lever: 'concurrency', cpu: null },
    };
    refuses(fact({ ...verdict, guards: [{ guard: 'rework', detail: '+1 in 3 merges' }] }), /\.verdict$/);
    refuses(fact({ ...verdict, verdict: 'inconclusive' }), /\.verdict$/);
    refuses(fact({ ...verdict, after: { samples: [30] } }), /\.verdict$/);
    refuses(fact({ ...verdict, before: { samples: [40], centre: 3.7, mrBar: 0 } }), /\.verdict$/);
    roundTrip(fact({ ...verdict, before: { samples: [], centre: 0, mrBar: 0 }, verdict: 'inconclusive' }));
    refuses(fact({ ...verdict, guards: [{ guard: 'cost', detail: 'c' }, { guard: 'lead', detail: 'l' }], verdict: 'worse' }), /\.guards\[1\]$/);
  });

  it('the revision source, hold cause and proof spawn arms; the flow commands', () => {
    const stageOutcome = { kind: 'stage-outcome', unit: 'u1', stage: 'candidate', attempt: 1, outcome: 'interrupted', class: 'hold', chargeable: false, cause: { type: 'flow-apply', proposal: 'flow-2.0' } };
    roundTrip(fact(stageOutcome));
    refuses(fact({ ...stageOutcome, cause: { type: 'flow-apply', proposal: 'flow-2' } }), /\.cause\.proposal$/);
    const spawn = (subject: object): LogRecord => ({
      type: 'intent', op: opId(ARC, 2), kind: 'proc.spawn', key: opKey('k:proof'), parent: { type: 'job', job: 'proof-1' }, ordinal: 1, deadlineAt: null,
      expect: { subject, launchSha256: H }, post: null,
    }) as unknown as LogRecord;
    const subject = { purpose: 'proof', job: 'proof-1', proposal: 'flow-2.0', lane: 'unit', side: 'new', at: A };
    roundTrip(spawn(subject));
    refuses(spawn({ ...subject, job: 'flow-1' }), /\.subject\.job$/);
    refuses(spawn({ ...subject, side: 'both' }), /\.subject\.side$/);
    const applied = (source: object, command: string | null) => fact({
      kind: 'plan-applied', rev: 4, command, planSha256: H, specs: { u1: H }, changes: [{ type: 'suite' }], source, payloadSha256: H, rulingsSha256: H,
      routingProvenance: { profile: 'default', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {}, arcRoles: 'm4b' },
    });
    roundTrip(applied({ type: 'flow', proposal: 'flow-2.0' }, null));
    refuses(applied({ type: 'flow', proposal: 'flow-2.0' }, CMD), /\.source$/);
    assert.deepEqual(commandBody({ type: 'flow-decide', proposal: 'flow-2.0', decision: 'reject', reason: 'r' }, 'b'), { type: 'flow-decide', proposal: 'flow-2.0', decision: 'reject', reason: 'r' });
    assert.throws(() => commandBody({ type: 'flow-decide', proposal: 'flow-2.0', decision: 'accepted', reason: 'r' }, 'b'), SchemaError);
    assert.throws(() => commandBody({ type: 'flow-request', reason: '' }, 'b'), SchemaError);
  });
});

describe('m4b rev 3: host pressure records', () => {
  const result = { kind: 'result', resultSha256: H, summary: { type: 'command', verdict: 'stall' } };
  const done = (outcome: object): LogRecord => ({ type: 'done', op: opId(ARC, 2), kind: 'proc.spawn', outcome, recoveredBy: null }) as unknown as LogRecord;
  const ended = (code: object) => fact({ kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: null, dropped: null, constraint: { code, judged: JUDGED } });

  it('a start records schedstat availability and a spawn result its pressure; both absent on an earlier executor\'s, read with defaults', () => {
    roundTrip(fact({ kind: 'executor-started', generation: 3, host: { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 31 }, pressure: 'available' }));
    roundTrip(fact({ kind: 'executor-started', generation: 3, pressure: 'unavailable' }));
    refuses(fact({ kind: 'executor-started', generation: 3, pressure: 'none' }), /\.pressure$/);
    for (const pressure of [0, 0.37, 1, null]) roundTrip(done({ ...result, pressure }));
    for (const pressure of [1.01, -0.1, '0.3']) refuses(done({ ...result, pressure }), /\.pressure$/);
    const old = roundTrip(done(result));
    assert.ok(old.type === 'done' && old.kind === 'proc.spawn' && old.outcome.kind === 'result');
    assert.equal(spawnPressureOf(old.outcome), null);
    assert.equal(spawnPressureOf({ pressure: 0.4 }), 0.4);
    assert.equal(startPressureOf({}), 'unavailable');
    assert.equal(startPressureOf({ pressure: 'available' }), 'available');
  });

  it('host:cpu is an internal station, never a share of lead; the trigger, drop reason, metric and hold cause arms', () => {
    assert.deepEqual(parseStationId('host:cpu'), { type: 'host-cpu' });
    assert.equal(stationId('host:cpu'), 'host:cpu');
    assert.throws(() => stationId('host:mem'), InvalidIdError);
    roundTrip(ended({ station: 'host:cpu', internal: true, component: null }));
    refuses(ended({ station: 'host:cpu', internal: false, component: null }), /\.internal$/);
    refuses(ended({ station: 'host:cpu', internal: true, component: 'ff' }), /\.component$/);
    roundTrip(fact({ kind: 'flow-started', job: 'flow-2', triggers: ['yellow-worsening', 'host-pressure', 'constraint-shift'], inputsSha256: H }));
    refuses(fact({ kind: 'flow-started', job: 'flow-2', triggers: ['constraint-shift', 'host-pressure'], inputsSha256: H }), /\.triggers\[1\]$/);
    const proposal = { ...PROPOSAL, target: 'host:cpu', action: { lever: 'concurrency', cpu: 12 } };
    roundTrip(fact({ kind: 'flow-ended', job: 'flow-2', outcome: 'done', proposal: null, dropped: { proposal, reason: 'direction', detail: 'an increase at host:cpu' }, constraint: { code: null, judged: JUDGED } }));
    roundTrip(fact({
      kind: 'flow-verdict', proposal: 'flow-2.0', metric: { type: 'pressure' }, before: { samples: [0.4, 0.5, 0.45], centre: 0.45, mrBar: 0.07 },
      after: { samples: [0.1, 0.12, 0.09] }, guards: [], verdict: 'improved', preimage: { lever: 'concurrency', cpu: null },
    }));
    const held = { kind: 'stage-outcome', unit: 'u1', stage: 'lanes', attempt: 1, outcome: 'interrupted', class: 'hold', chargeable: false, cause: { type: 'host-pressure', inv: 'arc-3/7#1' } };
    roundTrip(fact(held));
    refuses(fact({ ...held, cause: { type: 'host-pressure', inv: 'u1' } }), /\.cause\.inv$/);
  });

  it('a series point and a suite run carry pressure (series v2), a point per station too; host:cpu is no minutes or station-pressure key', () => {
    const point = { unit: 'u1', admittedAt: AT, mergedAt: AT, leadMin: 5, minutes: { 'stage:build': 5 }, costUsd: null, rework: 0, firstRunReds: 0, pressure: null, stationPressure: { 'stage:build': null } };
    const series = { v: 2, arc: 'arc-3', host: null, points: [point], suiteRuns: [], accounting: { tAdvances: null, tOther: null, tUnits: 0, wip: 0, oeUsdPerHour: 0 } };
    assert.equal(parseFlowSeries(series).points[0]?.pressure, null);
    assert.throws(() => parseFlowSeries({ ...series, points: [{ ...point, minutes: { 'stage:build': 4, 'host:cpu': 1 } }] }), SchemaError);
    assert.throws(() => parseFlowSeries({ ...series, points: [{ ...point, pressure: 2 }] }), SchemaError);
    const { pressure: _, ...withoutPressure } = point;
    assert.throws(() => parseFlowSeries({ ...series, points: [withoutPressure] }), SchemaError);
    assert.equal(parseFlowSeries({ ...series, points: [{ ...point, stationPressure: { 'stage:build': 0.3, 'suite:unit': 0.5 } }] }).points[0]?.stationPressure[stationId('stage:build')], 0.3);
    for (const stationPressure of [{ 'host:cpu': 0.3 }, { 'slot:integration': 0.3 }, { 'stage:build': 1.5 }]) {
      assert.throws(() => parseFlowSeries({ ...series, points: [{ ...point, stationPressure }] }), SchemaError, JSON.stringify(stationPressure));
    }
  });
});

describe('m4b kept records', () => {
  const point = { unit: 'u1', admittedAt: AT, mergedAt: '2026-10-08T12:30:00.000Z', leadMin: 30, minutes: { 'stage:build': 20, 'wait:slot:integration': 4, 'suite:unit': 6 }, costUsd: 1.5, rework: 0, firstRunReds: 0, pressure: 0.12,
    stationPressure: { 'stage:build': 0.1, 'suite:unit': 0.18 } };
  const series = {
    v: 2, arc: 'arc-3', host: null, points: [point], suiteRuns: [{ lane: 'unit', at: AT, minutes: 6, shape: 'stand-in', red: false, pressure: null }],
    accounting: { tAdvances: null, tOther: null, tUnits: 2, wip: 1, oeUsdPerHour: 3 },
  };

  it('a flow series reads; its points partition lead time over leaf stations', () => {
    assert.equal(canonicalJson(parseFlowSeries(JSON.parse(JSON.stringify(series)))), canonicalJson(series));
    assert.throws(() => parseFlowSeries({ ...series, points: [{ ...point, leadMin: 31 }] }), (e: unknown) => e instanceof SchemaError && /\.minutes$/.test(e.field));
    assert.throws(() => parseFlowSeries({ ...series, points: [{ ...point, minutes: { 'slot:integration': 10, 'stage:build': 20 } }] }), SchemaError);
    assert.throws(() => parseFlowSeries({ ...series, accounting: { ...series.accounting, tAdvances: 1 } }), SchemaError);
    assert.throws(() => parseFlowSeries({ ...series, v: 1 }), SchemaError);
    assert.throws(() => parseFlowSeries({ ...series, points: [point, point] }), SchemaError);
  });

  it('flow inputs and host givens read; givens ascend by id', () => {
    const inputs = {
      schema: 'roadmap/flow-inputs-m4b', job: 'flow-1', triggers: ['floor'], chart: null, stations: [{ station: 'stage:build', meanMin: 20, share: 0.66, pressure: 0.12 }], constraint: null,
      accounting: series.accounting, levers: [{ lever: 'concurrency', cpu: 8, set: false, hostCpus: 8 }], givens: [{ scope: 'repo', lever: 'host', note: 'a fixed host' }],
      window: null, verdicts: [], rejections: [], advances: [],
      pressure: { threshold: 0.5, available: true, now: 0.3, window: 0.31, cpuInUse: 6, hostCpus: 8 },
    };
    assert.equal(canonicalJson(parseFlowInputs(JSON.parse(JSON.stringify(inputs)))), canonicalJson(inputs));
    assert.throws(() => parseFlowInputs({ ...inputs, job: 'review-1' }), SchemaError);
    const unavailable = { threshold: 0.5, available: false, now: null, window: null, cpuInUse: 0, hostCpus: 8 };
    assert.equal(parseFlowInputs({ ...inputs, pressure: unavailable }).pressure.now, null);
    assert.equal(parseFlowInputs({ ...inputs, pressure: { ...unavailable, available: true } }).pressure.now, null, 'available, under a minute of ticks');
    assert.throws(() => parseFlowInputs({ ...inputs, pressure: { ...unavailable, now: 0.2 } }), SchemaError, 'a reading on a host without schedstat');
    const { pressure: _p, ...noPressure } = inputs;
    assert.throws(() => parseFlowInputs(noPressure), SchemaError);
    const given = (id: string) => ({ id, lever: 'concurrency', note: 'n', fingerprint: { platform: 'linux', arch: 'x64', cpus: 4, memGiB: 16 }, at: AT });
    assert.equal(parseHostGivens({ schema: 'roadmap/flow-givens-m4b', givens: [given('G-2'), given('G-10')] }).givens.length, 2);
    assert.throws(() => parseHostGivens({ schema: 'roadmap/flow-givens-m4b', givens: [given('G-10'), given('G-2')] }), SchemaError);
    assert.deepEqual(parseRepoConfig({ flow: { givens: [{ lever: 'concurrency', note: 'one runner' }] } }).flow, { givens: [{ lever: 'concurrency', note: 'one runner' }] });
    assert.throws(() => parseRepoConfig({ flow: { givens: [{ lever: 'rope', note: 'n' }] } }), SchemaError);
  });
});

describe('m4b flow output (strict)', () => {
  const ok = {
    constraint: JUDGED, diagnosis: 'the suite lane is most of the slot',
    proposal: { target: 'suite:unit', action: { ...SUITE_ACTION, cpu: null }, rationale: 'r', risks: 'k' }, noAction: null,
  };

  it('exactly one of proposal and noAction; a suite lane\'s unused fields null and read as absent', () => {
    const out = validateFlowOutput(ok);
    assert.deepEqual(out.proposal?.action, SUITE_ACTION);
    assert.deepEqual(validateFlowOutput({ ...ok, proposal: null, noAction: 'common cause only' }).proposal, null);
    for (const bad of [
      { proposal: null }, { noAction: 'both' }, { proposal: { ...ok.proposal, action: { lever: 'suite-lane', lane: 'unit', argv: null, reporter: null, cpu: null } } },
      { proposal: { ...ok.proposal, id: 'flow-1.0' } }, { proposal: { ...ok.proposal, target: 'idle' } },
      { proposal: { ...ok.proposal, action: { lever: 'sequence', unit: 'u1', priority: 'normal' } } }, { proposal: { ...ok.proposal, action: { lever: 'rope', wip: 3 } } },
    ]) assert.throws(() => validateFlowOutput({ ...ok, ...bad }), SchemaError, JSON.stringify(bad));
    assert.ok(JSON.stringify(FLOW_SCHEMA).includes('"go-test-json"'));
  });
});

describe('m4b routing: arcRoles gates the flow seat', () => {
  it('without a role set (an arc 1.0.0-dev.7 started) the rev and seats are dev.7\'s; m4b puts flow in force in every scope', () => {
    const dev7 = resolveRouting(arcStack('default', null, null));
    const m4b = resolveRouting({ ...arcStack('default', null, null), arcRoles: 'm4b' });
    assert.equal(dev7.rev, routingRevOf(dev7.table, 'none', null));
    assert.notEqual(m4b.rev, dev7.rev, 'the flow seat is hashed');
    assert.ok(!seatsInForce(dev7).some((s) => s.role === 'flow'));
    assert.deepEqual(seatsInForce(m4b).filter((s) => s.role === 'flow'), [{ role: 'flow', tier: 'arc' }]);
    assert.deepEqual(m4b.classes.flow, { arc: 'efficient' }, 'the flow seat on efficient (owner ruling 2026-10-15)');
    for (const scope of ['architecture-doc', 'corpus'] as const) {
      assert.notEqual(routingRevOf(m4b.table, scope, 'm4b'), routingRevOf(m4b.table, scope, null), scope);
      assert.ok(seatsInForce(resolveRouting({ ...arcStack('default', null, null), arcScope: scope, arcRoles: 'm4b' })).some((s) => s.role === 'flow'), scope);
    }
    // A flow-seat rebind moves only an m4b arc's rev.
    const moved = { flow: { arc: 'summit' as const } };
    assert.equal(resolveRouting(arcStack('default', null, moved)).rev, dev7.rev);
    assert.notEqual(resolveRouting({ ...arcStack('default', null, moved), arcRoles: 'm4b' }).rev, m4b.rev);
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
    assert.equal(schemaViolation(schema, dispose('I-2')), null);
    assert.match(schemaViolation(schema, dispose('I-7')) ?? '', /ops\[0\]/);
  });

  it('no ids known (null, or an empty set): any id, the prompt module\'s schema; the bundle\'s validation refuses an unknown one', () => {
    assert.deepEqual(checkpointSchemaFor(null), CHECKPOINT_SCHEMA);
    assert.equal(schemaViolation(CHECKPOINT_SCHEMA, split('I-1', 'w-draught')), null);
    assert.equal(schemaViolation(checkpointSchemaFor({ arcLanes: [], splittable: [], obligations: [] }), split('I-1', 'w-draught')), null);
  });
});
