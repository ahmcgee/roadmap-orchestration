import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  type CommitInputs, type Envelope, type Event, type Fact, type IntentOf, type LogRecord, type OpKind, type OpOutcome,
  OP_KINDS, parseChainLine, parseEventLine, prevHash, serializeChainLine, serializeEvent,
} from '../src/core/events.ts';
import {
  arcId, commandId, invocationId, laneId, needsUserId, opId, opKey, resourceName, routingRev, seatRev, sha, sha256, specRev, unitId,
  INTEGRATION_SLOT, clauseId, rulingId,
} from '../src/core/ids.ts';
import { type ResidueRecord, residueRecord } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, gitDate, isoTime, refName, repoPath, repoPattern } from '../src/core/values.ts';

const arc = arcId('arc-1');
const op = opId(arc, 7);
const inv = invocationId(op, 1);
const unit = unitId('u1');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const C = sha('c'.repeat(40));
const H = sha256('d'.repeat(64));
const rev = routingRev('0123456789abcdef');
const at = isoTime('2026-09-25T12:00:00.000Z');
const sig = { name: 'roadmap', email: 'roadmap@localhost', date: gitDate('1790000000 +0000') };
const commit = <P extends readonly (typeof A)[]>(parents: P): CommitInputs<P> =>
  ({ tree: C, parents, author: sig, committer: sig, message: 'm', gpgsign: false });
const wt = absPath('/var/tmp/wt/u1');
const parent = { type: 'stage', unit, stage: 'build', attempt: 1 } as const;

function intent<K extends OpKind>(kind: K, expect: IntentOf<K>['expect'], post: IntentOf<K>['post']): IntentOf<K> {
  return { type: 'intent', op, kind, key: opKey(`${kind}:u1`), parent, ordinal: 1, deadlineAt: at, expect, post };
}

// One intent of every op kind, with every input the plan's git-intents table lists.
const INTENTS: { readonly [K in OpKind]: IntentOf<K> } = {
  'worktree.create': intent('worktree.create', { path: wt, checkout: { type: 'branch', branch: refName('refs/heads/u1'), at: A, createBranch: true } }, null),
  'worktree.remove': intent('worktree.remove', { path: wt, evidence: opId(arc, 6) }, null),
  'resource.transition': intent('resource.transition', {
    holder: { type: 'stage', unit, stage: 'lanes', attempt: 2 },
    resources: [resourceName('db'), resourceName('kind-cluster'), INTEGRATION_SLOT],
    edge: { type: 'fail', residues: [
      { resource: resourceName('db'), teardown: inv },
      { resource: resourceName('kind-cluster'), teardown: inv },
      { resource: INTEGRATION_SLOT, teardown: inv },
    ] },
  }, null),
  'proc.spawn': intent('proc.spawn', { subject: { purpose: 'backend', role: 'build', tier: 'med', routingRev: rev, unit, attempt: 1 }, launchSha256: H }, null),
  'proc.kill': intent('proc.kill', { inv, scope: 'op', reason: 'recovery' }, null),
  'evidence.snapshot': intent('evidence.snapshot', { source: wt, globs: [repoPattern('coverage/**')], dest: absPath('/run/inv/7-1/evidence') }, { manifest: absPath('/run/inv/7-1/evidence/manifest.json') }),
  'salvage.commit': intent('salvage.commit', {
    worktree: wt, branch: refName('refs/heads/u1'), old: A, approvedSetSha256: H, rejectedManifestSha256: H, commit: commit([A] as const),
  }, { new: B }),
  'mergein.prepare': intent('mergein.prepare', {
    worktree: wt, branch: refName('refs/heads/u1'), old: A, integrationTip: B, merge: { type: 'clean', commit: commit([A, B] as const) },
  }, { type: 'clean-merged', new: C }),
  'spec.patch': intent('spec.patch', {
    path: absPath('/run/specs/u1.json'), oldSha256: H, expectRev: specRev(1),
    patch: { expectRev: specRev(1), by: { role: 'planCheck', routingRev: rev, inv }, ops: [
      { op: 'add', section: 'acceptance', item: { id: clauseId('A2'), clause: 'x', failLoudIfUndelivered: true } },
      { op: 'replace', section: 'lanes', item: { id: laneId('L1'), argv: ['npm', 'test'], cwd: repoPath('.'), env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] } },
      { op: 'strike', id: clauseId('F1') },
      { op: 'defer', id: clauseId('A1') },
    ] },
  }, { newSha256: H, newRev: specRev(2) }),
  'candidate.merge': intent('candidate.merge', {
    ref: refName('refs/roadmap-run/arc-1/candidate/u1'), old: null, integrationTip: A, unitCommit: B, worktree: wt, commit: commit([A, B] as const),
  }, { new: C }),
  'integration.ff': intent('integration.ff', {
    ref: refName('refs/heads/integration'), old: A, new: C,
    fingerprint: { unitCommit: B, specRev: specRev(2), contractRevs: [{ path: repoPath('docs/arch.md'), blob: A }], rulingRevs: [{ id: rulingId('C-1'), rev: 1 }] },
  }, null),
  'snapshot.publish': intent('snapshot.publish', { ref: refName('refs/roadmap/arc-1'), old: A, highWater: 41, manifestSha256: H, commit: commit([A] as const) }, { new: B }),
  'needsuser.raise': intent('needsuser.raise', { id: needsUserId('nu-7'), path: absPath('/run/needs-user/nu-7.json'), blocking: true }, { sha256: H }),
  'command.apply': intent('command.apply', { command: commandId('cmd-0123456789abcdef'), commandSha256: H }, null),
};

// Every outcome variant of every kind.
const OUTCOMES: { readonly [K in OpKind]: readonly OpOutcome[K][] } = {
  'worktree.create': [{ kind: 'created', head: A }],
  'worktree.remove': [{ kind: 'removed' }],
  'resource.transition': [{ kind: 'transitioned' }],
  'proc.spawn': [
    { kind: 'result', resultSha256: H, summary: { type: 'backend', outcome: 'success' } },
    { kind: 'result', resultSha256: H, summary: { type: 'command', verdict: 'fail' } },
    { kind: 'lost', treeEffects: true },
  ],
  'proc.kill': [{ kind: 'quiesced' }],
  'evidence.snapshot': [{ kind: 'captured', manifestSha256: H, files: 3 }],
  'salvage.commit': [{ kind: 'committed' }],
  'mergein.prepare': [{ kind: 'clean-merged' }, { kind: 'conflicted' }, { kind: 'completed', head: C }],
  'spec.patch': [{ kind: 'patched' }],
  'candidate.merge': [{ kind: 'merged' }],
  'integration.ff': [{ kind: 'published' }, { kind: 'unpublished', tip: B }, { kind: 'recovery-required', observed: null }],
  'snapshot.publish': [{ kind: 'published' }],
  'needsuser.raise': [{ kind: 'raised' }],
  'command.apply': [{ kind: 'applied', receiptSha256: H }, { kind: 'rejected', reason: 'unknown needs-user id' }],
};

const FACTS: readonly Fact[] = [
  { kind: 'tail-discarded', offset: 1024, length: 17, sha256: H },
  { kind: 'containment-mode', mode: 'session' },
  { kind: 'meter', inv, routingRev: rev, subject: { type: 'seat', role: 'gate', tier: 'escalation', unit, attempt: 1 }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: null, turns: 7, costUsd: 0.25 } },
  { kind: 'usage-unavailable', inv, routingRev: rev, subject: { type: 'smoke', backend: 'codex' }, reason: 'no-result' },
  { kind: 'dispatch', record: { unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: rev, implementerSeatRev: seatRev('fedcba9876543210'), at } },
  { kind: 'stage-outcome', unit, stage: 'gate', attempt: 2, outcome: 'revise', class: 'revise', chargeable: true },
  { kind: 'stage-outcome', unit, stage: 'lanes', attempt: 1, outcome: 'blocked', class: 'retry', chargeable: false },
  { kind: 'needs-user-acked', id: needsUserId('nu-7'), command: commandId('cmd-0123456789abcdef'), choice: 'retry' },
  { kind: 'paused', command: commandId('cmd-0123456789abcdef'), target: { type: 'unit', unit } },
  { kind: 'paused', command: commandId('cmd-0123456789abcdef'), target: { type: 'all' } },
  { kind: 'stop-requested', command: commandId('cmd-0123456789abcdef') },
  { kind: 'resumed', command: commandId('cmd-0123456789abcdef'), target: { type: 'backend', backend: 'codex' } },
  { kind: 'rerouted', unit, command: commandId('cmd-0123456789abcdef') },
  { kind: 'executor-started', generation: 3 },
];

function envelope(seq: number): Envelope {
  return { v: 1, seq, prev: seq === 1 ? null : H, at, arc };
}

function event(record: LogRecord, seq = 2): Event {
  return { ...envelope(seq), ...record } as Event;
}

function roundTrip(e: Event): void {
  const line = serializeEvent(e);
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line, newline-terminated');
  assert.deepEqual(parseEventLine(line.slice(0, -1)), e);
}

describe('events', () => {
  it('lists exactly the plan\'s op kinds', () => {
    assert.deepEqual([...OP_KINDS].sort(), [
      'candidate.merge', 'command.apply', 'evidence.snapshot', 'integration.ff', 'mergein.prepare', 'needsuser.raise',
      'proc.kill', 'proc.spawn', 'resource.transition', 'salvage.commit', 'snapshot.publish', 'spec.patch',
      'worktree.create', 'worktree.remove',
    ]);
  });

  for (const kind of OP_KINDS) {
    it(`round-trips an intent and every done outcome of ${kind}`, () => {
      roundTrip(event(INTENTS[kind] as LogRecord));
      for (const outcome of OUTCOMES[kind]) {
        roundTrip(event({ type: 'done', op, kind, outcome, recoveredBy: null } as LogRecord));
        roundTrip(event({ type: 'done', op, kind, outcome, recoveredBy: 'reconciled' } as LogRecord));
      }
    });
  }

  it('round-trips the other intent variants', () => {
    const variants: LogRecord[] = [
      { ...INTENTS['worktree.create'], parent: { type: 'arc' }, deadlineAt: null, expect: { path: wt, checkout: { type: 'detached', at: B } } },
      { ...INTENTS['proc.spawn'], ordinal: 2, parent: { type: 'command', command: commandId('cmd-0123456789abcdef') }, expect: { subject: { purpose: 'lane', unit, lane: laneId('L1'), set: 'suite', at: A }, launchSha256: H } },
      { ...INTENTS['proc.spawn'], parent: { type: 'op', op: opId(arc, 3) }, expect: { subject: { purpose: 'teardown', unit: null, resource: resourceName('db') }, launchSha256: H } },
      { ...INTENTS['proc.spawn'], expect: { subject: { purpose: 'smoke', check: 'judgment', target: { type: 'backend', backend: 'claude', role: 'gate', tier: 'low', routingRev: rev } }, launchSha256: H } },
      { ...INTENTS['proc.spawn'], expect: { subject: { purpose: 'smoke', check: 'shell', target: { type: 'command' } }, launchSha256: H } },
      { ...INTENTS['mergein.prepare'], expect: { ...INTENTS['mergein.prepare'].expect, merge: { type: 'conflicted', conflicts: [repoPath('src/a.ts')] } }, post: { type: 'conflicted' } },
      { ...INTENTS['snapshot.publish'], expect: { ...INTENTS['snapshot.publish'].expect, old: null, commit: commit([] as const) } },
      { ...INTENTS['resource.transition'], expect: { holder: { type: 'sweep', command: commandId('cmd-0123456789abcdef') }, resources: [resourceName('db')], edge: { type: 'clean', from: 'running' } } },
      { ...INTENTS['resource.transition'], expect: { holder: { type: 'sweep', command: commandId('cmd-0123456789abcdef') }, resources: [resourceName('db')], edge: { type: 'reclaim' } } },
    ];
    for (const v of variants) roundTrip(event(v));
  });

  it('a reclaim is a sweep holder\'s edge only', () => {
    const stageReclaim = { ...INTENTS['resource.transition'], expect: { holder: { type: 'stage', unit, stage: 'build', attempt: 1 }, resources: [resourceName('db')], edge: { type: 'reclaim' } } };
    assert.throws(() => parseEventLine(serializeEvent(event(stageReclaim as LogRecord)).slice(0, -1)), /only a sweep reclaims/);
  });

  it('round-trips abort records and every fact', () => {
    roundTrip(event({ type: 'abort', op, reason: { code: 'recovery', detail: 'ref neither old nor new' } }));
    for (const f of FACTS) roundTrip(event({ type: 'fact', fact: f }));
    roundTrip({ ...envelope(1), type: 'fact', fact: { kind: 'containment-mode', mode: 'session' } });
  });

  it('serialises canonically: sorted keys, no whitespace', () => {
    const line = serializeEvent(event({ type: 'abort', op, reason: { detail: 'd', code: 'precondition' } }));
    assert.equal(line, `{"arc":"arc-1","at":"${at}","op":"arc-1/7","prev":"${H}","reason":{"code":"precondition","detail":"d"},"seq":2,"type":"abort","v":1}\n`);
  });

  it('prevHash is sha256 over the exact line bytes including the trailing newline', () => {
    const line = serializeEvent(event({ type: 'fact', fact: FACTS[1] as Fact }, 1));
    const bytes = Buffer.from(line, 'utf8');
    assert.equal(prevHash(bytes), createHash('sha256').update(bytes).digest('hex'));
    assert.notEqual(prevHash(bytes), createHash('sha256').update(bytes.subarray(0, -1)).digest('hex'));
    assert.throws(() => prevHash(bytes.subarray(0, -1)), /torn line/);
    assert.throws(() => prevHash(Buffer.alloc(0)), /torn line/);
  });

  describe('malformed lines throw', () => {
    const good = serializeEvent(event(INTENTS['salvage.commit'])).slice(0, -1);
    const obj = (): Record<string, unknown> => JSON.parse(good) as Record<string, unknown>;
    // [case, line, what the error must name]. Content cases are canonicalised so the content rule is what fails.
    const cases: readonly [string, string, RegExp][] = [
      ['torn JSON', good.slice(0, -5), /^event: expected JSON/],
      ['empty line', '', /^event: expected JSON/],
      ['embedded newline', `${good}\n`, /without its terminating newline/],
      ['non-canonical whitespace', JSON.stringify(obj(), null, 1).replace(/\n/g, ' '), /canonical JSON/],
      ['non-canonical key order', JSON.stringify({ v: 1, ...obj() }), /canonical JSON/],
      ['unknown field', canonical(JSON.stringify({ ...obj(), extra: 1 })), /^event\.extra: expected no such field/],
      ['missing envelope field', canonical(JSON.stringify({ ...obj(), prev: undefined })), /^event\.prev: .*field missing/],
      ['seq 1 with a prev', canonical(JSON.stringify({ ...obj(), seq: 1 })), /^event\.prev: expected null on seq 1/],
      ['wrong version', canonical(JSON.stringify({ ...obj(), v: 2 })), /^event\.v: expected 1/],
      ['unknown record type', canonical(JSON.stringify({ ...obj(), type: 'note' })), /^event\.type:/],
      ['unknown op kind', canonical(JSON.stringify({ ...obj(), kind: 'git.reset' })), /^event\.kind:/],
      ['op of another arc', canonical(JSON.stringify({ ...obj(), op: 'arc-2/7' })), /^event\.op: expected an op of arc arc-1/],
      ['salvage parents not [old]', canonical(JSON.stringify({ ...obj(), expect: { ...(obj()['expect'] as object), old: B } })), /^event\.expect\.commit\.parents:/],
      ['bad time', canonical(JSON.stringify({ ...obj(), at: '2026-09-25 12:00' })), /^event\.at: expected IsoTime/],
    ];
    for (const [name, line, names] of cases) {
      it(name, () => {
        assert.throws(() => parseEventLine(line), (err: unknown) => err instanceof SchemaError && names.test(err.message));
      });
    }

    it('mergein clean merge with a conflicted post', () => {
      const e = { ...event(INTENTS['mergein.prepare']), post: { type: 'conflicted' } };
      assert.throws(() => parseEventLine(serializeEvent(e as Event).slice(0, -1)), /post\.type/);
    });

    it('resource transition out of lock order', () => {
      const e = event({ ...INTENTS['resource.transition'], expect: { ...INTENTS['resource.transition'].expect, resources: [INTEGRATION_SLOT, resourceName('db')], edge: { type: 'reserve' } } });
      assert.throws(() => parseEventLine(serializeEvent(e).slice(0, -1)), /integration-slot last/);
    });

    it('stage-outcome: an outcome of another stage, and classes the stage does not have', () => {
      const line = (f: object): string => serializeEvent(event({ type: 'fact', fact: { kind: 'stage-outcome', unit, attempt: 1, chargeable: false, ...f } } as LogRecord)).slice(0, -1);
      assert.throws(() => parseEventLine(line({ stage: 'build', outcome: 'approve', class: 'advance' })), /^SchemaError: event\.fact\.outcome:/);
      assert.throws(() => parseEventLine(line({ stage: 'retire', outcome: 'published', class: 'retire' })), /^SchemaError: event\.fact\.stage:/);
      assert.throws(() => parseEventLine(line({ stage: 'candidate', outcome: 'red', class: 'retry' })), /event\.fact\.class: expected retry only at/);
      assert.throws(() => parseEventLine(line({ stage: 'build', outcome: 'refusal', class: 'route-up' })), /event\.fact\.class: expected route-up only at/);
    });

    it('spec patch whose newRev is not expectRev + 1', () => {
      const e = event({ ...INTENTS['spec.patch'], post: { newSha256: H, newRev: specRev(3) } });
      assert.throws(() => parseEventLine(serializeEvent(e).slice(0, -1)), /newRev/);
    });
  });

  it('residue lines follow the same chain rules without an arc', () => {
    const key = { arc, unit, inv, resource: resourceName('db') };
    const line = serializeChainLine<ResidueRecord>({ v: 1, seq: 1, prev: null, at, type: 'residue', key, teardown: { argv: ['make', 'down'], cwd: absPath('/repo'), env: {} }, label: 'roadmap.owner=arc-1/u1/arc-1/7#1' });
    const parsed = parseChainLine(line.slice(0, -1), residueRecord, 'residues');
    assert.equal(serializeChainLine(parsed), line);
    const disp = serializeChainLine<ResidueRecord>({ v: 1, seq: 2, prev: H, at, type: 'disposition', key, disposition: 'isolated', by: { arc, needsUser: needsUserId('nu-9') } });
    assert.equal(serializeChainLine(parseChainLine(disp.slice(0, -1), residueRecord, 'residues')), disp);
    const cleanedByAck = disp.replace('"isolated"', '"cleaned"');
    assert.throws(() => parseChainLine(cleanedByAck.slice(0, -1), residueRecord, 'residues'), SchemaError);
  });
});

function canonical(json: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(JSON.parse(json)));
}
