import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ImplementerSessionId, type JudgmentSessionId, type NumberedId, type RuleId, InvalidIdError, amendmentRef, amendmentRefKey, answerIds, canonicalIds,
  compareIds, idKey, idList, obligationId, ruleId, visionClauseId, arcId, clauseId, commandId, hostNeedsUserId,
  implementerSessionId, invocationDirName, invocationId, invocationIdOf, judgmentSessionId, laneId, needsUserId,
  needsUserIdForOp, opId, opIdOf, opKey, parseInvocationId, parseOpId, resourceName, routingRev, rulingId, sha, sha256,
  specRev, supervisorNeedsUserId, unitId,
} from '../src/core/ids.ts';
import { SchemaError } from '../src/core/validate.ts';

const UUID = '0190f6c2-8f3a-7d21-9a4e-3b5c6d7e8f90';

// [constructor, valid forms, malformed forms]
const TEXTUAL: readonly [string, (v: unknown, p?: string) => unknown, readonly unknown[], readonly unknown[]][] = [
  ['ArcId', arcId, ['arc-1', 'a', 'x'.repeat(64)], ['', 'Arc', '-arc', 'arc-', 'a/b', 'x'.repeat(65), 7, null]],
  ['UnitId', unitId, ['u1', 'auth-cookie'], ['U1', 'u_1', 'u.1', '', undefined]],
  ['ResourceName', resourceName, ['kind-cluster', 'port-8080'], ['Kind', 'a b', '']],
  ['LaneId', laneId, ['L1', 'unit.test_fast'], ['1L', '', 'a/b']],
  ['ClauseId', clauseId, ['A1', 'R1', 'fact.x'], ['1A', '']],
  ['RulingId', rulingId, ['C-7', 'C-126', 'C-01'], ['C7', 'c-7', 'C-']],
  ['Sha', sha, ['0123456789abcdef0123456789abcdef01234567'], ['0123456789ABCDEF0123456789abcdef01234567', 'abc', 'g'.repeat(40)]],
  ['Sha256Hex', sha256, ['a'.repeat(64)], ['a'.repeat(63), 'A'.repeat(64)]],
  ['RoutingRev', routingRev, ['0123456789abcdef'], ['0123456789abcde', '0123456789abcdeF']],
  ['CommandId', commandId, ['cmd-0123456789abcdef'], ['cmd-0123', 'cmd-0123456789ABCDEF', '0123456789abcdef']],
  ['JudgmentSessionId', judgmentSessionId, [UUID], [UUID.toUpperCase(), 'not-a-uuid']],
  ['ImplementerSessionId', implementerSessionId, [UUID], [UUID.slice(1)]],
  ['OpKey', opKey, ['proc.spawn:unit/u1:build', 'resource:kind-cluster'], ['', 'has space', 'x'.repeat(257)]],
  ['OpId', opIdOf, ['arc-1/1', 'arc-1/42'], ['arc-1/0', 'arc-1/01', 'arc-1', '/1', 'Arc/1', 'arc-1/1#1', 'arc-1/1234567890123456']],
  ['InvocationId', invocationIdOf, ['arc-1/42#1', 'arc-1/42#3'], ['arc-1/42', 'arc-1/42#0', 'arc-1/42#', 'arc-1#1']],
  ['NeedsUserId', needsUserId, ['nu-12', 'sup-3-1', 'host-log-corrupt'], ['nu-0', 'nu-', 'sup-3', 'host-', 'other-1', 'host-Log']],
];

describe('ids', () => {
  for (const [kind, make, valid, malformed] of TEXTUAL) {
    it(`${kind} round-trips every valid form`, () => {
      for (const v of valid) assert.equal(make(v), v);
    });
    it(`${kind} rejects every malformed form with InvalidIdError naming the id and field`, () => {
      for (const v of malformed) {
        assert.throws(() => make(v, 'plan.units[0].id'), (err: unknown) => {
          assert.ok(err instanceof InvalidIdError);
          assert.equal(err.idKind, kind);
          assert.equal(err.field, 'plan.units[0].id');
          assert.match(err.message, new RegExp(`^plan\\.units\\[0\\]\\.id: expected ${kind} `));
          return true;
        }, `accepted ${JSON.stringify(v)}`);
      }
    });
  }

  it('SpecRev accepts integers >= 1 and rejects the rest', () => {
    assert.equal(specRev(1), 1);
    assert.equal(specRev(12), 12);
    for (const bad of [0, -1, 1.5, '1', null]) assert.throws(() => specRev(bad), InvalidIdError);
  });

  it('op ids derive from arc and seq and parse back', () => {
    const op = opId(arcId('arc-1'), 42);
    assert.equal(op, 'arc-1/42');
    assert.deepEqual(parseOpId(op), { arc: 'arc-1', seq: 42 });
  });

  it('invocation ids derive from op and ordinal and parse back', () => {
    const op = opId(arcId('arc-1'), 42);
    const inv = invocationId(op, 3);
    assert.equal(inv, 'arc-1/42#3');
    assert.deepEqual(parseInvocationId(inv), { op, ordinal: 3 });
    assert.equal(invocationDirName(inv), '42-3');
    assert.throws(() => invocationId(op, 0), InvalidIdError);
  });

  it('needs-user ids derive per origin', () => {
    assert.equal(needsUserIdForOp(opId(arcId('arc-1'), 7)), 'nu-7');
    assert.equal(supervisorNeedsUserId(2, 1), 'sup-2-1');
    assert.equal(hostNeedsUserId('log-corrupt'), 'host-log-corrupt');
  });

  it('judgment and implementer session ids are distinct brands', () => {
    // Type-level: `resume` takes only an ImplementerSessionId. tsc --noEmit fails if either line compiles.
    const resume = (id: ImplementerSessionId): string => id;
    const judgment: JudgmentSessionId = judgmentSessionId(UUID);
    // @ts-expect-error a judgment session can never be resumed
    const refused = () => resume(judgment);
    // @ts-expect-error a bare string is not a session id
    const alsoRefused = () => resume(UUID);
    assert.equal(typeof refused, 'function');
    assert.equal(typeof alsoRefused, 'function');
    assert.equal(resume(implementerSessionId(UUID)), UUID);
  });
});

// The canonical order of numbered ids (paid M4a run 7: `["T-42","T-120"]` was refused by a string-order reader).
describe('ids.numbered-order', () => {
  const T = (n: number): RuleId => ruleId(`T-${n}`);

  it('compareIds orders by letter, then by number: T-9 < T-10 < T-100', () => {
    assert.deepEqual([T(100), T(10), T(9)].sort(compareIds), ['T-9', 'T-10', 'T-100']);
    assert.ok(compareIds(T(9), T(10)) < 0 && compareIds(T(10), T(100)) < 0 && compareIds(T(100), T(9)) > 0);
    assert.equal(compareIds(T(42), T(42)), 0);
    const mixed: NumberedId[] = [visionClauseId('V-2'), T(10), rulingId('C-12'), rulingId('C-3'), obligationId('I-1')];
    assert.deepEqual(mixed.sort(compareIds), ['C-3', 'C-12', 'I-1', 'T-10', 'V-2']);
  });

  it('idKey: string order of keys is the canonical order; distinct ids keep distinct keys', () => {
    assert.ok(idKey(T(9)) < idKey(T(10)) && idKey(T(10)) < idKey(T(100)));
    assert.notEqual(idKey(rulingId('C-01')), idKey(rulingId('C-1')));
    assert.throws(() => idKey('issue-3' as NumberedId), InvalidIdError);
  });

  it('canonicalIds dedupes and sorts', () => {
    assert.deepEqual(canonicalIds([T(120), T(42), T(120), T(3)]), ['T-3', 'T-42', 'T-120']);
    assert.deepEqual(canonicalIds([]), []);
  });

  it('idList requires canonical order: the run-7 list reads, string order and duplicates are refused', () => {
    const read = idList((v, p) => ruleId(v, p));
    assert.deepEqual(read(['T-42', 'T-120'], 'rules'), ['T-42', 'T-120']);
    assert.throws(() => read(['T-120', 'T-42'], 'rules'), (err: unknown) => err instanceof SchemaError && err.field === 'rules[1]' && /in id order/.test(err.message));
    assert.throws(() => read(['T-9', 'T-9'], 'rules'), /rules\[1\]/);
    assert.throws(() => idList((v, p) => ruleId(v, p), { nonEmpty: true })([], 'rules'), /non-empty/);
  });

  it('idList with legacyStringOrder reads a string-ordered list as written, warning once; a list in neither order is refused', () => {
    const read = idList((v, p) => ruleId(v, p), { legacyStringOrder: true });
    const writes: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      assert.deepEqual(read(['T-10', 'T-9'], 'fact.rules'), ['T-10', 'T-9']);
      assert.deepEqual(read(['T-100', 'T-20', 'T-3'], 'fact.rules'), ['T-100', 'T-20', 'T-3']);
    } finally {
      process.stderr.write = write;
    }
    assert.equal(writes.length, 1, 'once per process');
    assert.match(writes[0]!, /upgrade default \(ids\.string-order\): fact\.rules: a numbered-id list in string order/);
    assert.deepEqual(read(['T-9', 'T-10'], 'fact.rules'), ['T-9', 'T-10'], 'canonical reads too');
    assert.throws(() => read(['T-9', 'T-10', 'T-2'], 'fact.rules'), /fact\.rules\[2\]/);
    assert.throws(() => read(['T-10', 'T-10'], 'fact.rules'), /fact\.rules\[1\]/);
  });

  it('answerIds normalises a judgment answer: any order in, canonical out; a duplicate is still invalid', () => {
    const read = answerIds((v, p) => ruleId(v, p));
    assert.deepEqual(read(['T-120', 'T-42', 'T-9'], 'answer.rules'), ['T-9', 'T-42', 'T-120']);
    assert.throws(() => read(['T-42', 'T-42'], 'answer.rules'), (err: unknown) => err instanceof SchemaError);
  });

  it('amendmentRefKey orders by arc, then by number', () => {
    const refs = ['b/M-1', 'a/M-10', 'a/M-9'].map((r) => amendmentRef(r));
    assert.deepEqual(refs.sort((x, y) => (amendmentRefKey(x) < amendmentRefKey(y) ? -1 : 1)), ['a/M-9', 'a/M-10', 'b/M-1']);
  });
});
