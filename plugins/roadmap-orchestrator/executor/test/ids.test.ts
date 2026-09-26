import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ImplementerSessionId, type JudgmentSessionId, InvalidIdError, arcId, clauseId, commandId, hostNeedsUserId,
  implementerSessionId, invocationDirName, invocationId, invocationIdOf, judgmentSessionId, laneId, needsUserId,
  needsUserIdForOp, opId, opIdOf, opKey, parseInvocationId, parseOpId, resourceName, routingRev, rulingId, sha, sha256,
  specRev, supervisorNeedsUserId, unitId,
} from '../src/core/ids.ts';

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
