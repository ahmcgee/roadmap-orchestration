// Pure-module tests of the fold (src/core/state.ts): what it derives and every invariant it refuses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Event, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { canonicalJson } from '../src/core/fsx.ts';
import { arcId, opId } from '../src/core/ids.ts';
import { Fold, FoldInvariantError, fold, writeStateCache } from '../src/core/state.ts';
import { isoTime } from '../src/core/values.ts';
import { tmpDir } from './helpers/repo.ts';
import {
  ARC, H, REV, chain, commandIntent, inv1, meter, needsUserIntent, snapshotIntent, spawnIntent, spawnLost, spawnResult, stageParent,
} from './fixtures/log-records.ts';

const op = (seq: number) => opId(ARC, seq);

function refuses(events: readonly Event[], seq: number, detail: RegExp): void {
  assert.throws(() => fold(ARC, events), (err: unknown) => {
    assert.ok(err instanceof FoldInvariantError, `expected FoldInvariantError, got ${String(err)}`);
    assert.equal(err.seq, seq);
    assert.match(err.detail, detail);
    return true;
  });
}

describe('fold derives', () => {
  it('open intents, units, meter, needs-user, snapshot high-water, last seq', () => {
    const state = fold(ARC, chain([
      spawnIntent(1, { stage: 'plan-check', role: 'planCheck' }), // 1
      meter(inv1(1), 'planCheck', 100, 10, 5), // 2
      spawnResult(op(1)), // 3
      spawnIntent(4), // 4 build attempt 1
      { type: 'fact', fact: { kind: 'usage-unavailable', inv: inv1(4), role: 'build', routingRev: REV, unit: null, reason: 'no-result' } }, // 5
      spawnLost(op(4)), // 6
      spawnIntent(4, { ordinal: 2 }), // 7 retry, same stage attempt
      meter(inv1(4, 2), 'build', 1000, 200, null), // 8 (the retry stays open)
      needsUserIntent(9), // 9
      { type: 'done', op: op(9), kind: 'needsuser.raise', outcome: { kind: 'raised' }, recoveredBy: null }, // 10
      snapshotIntent(11, 10), // 11
      { type: 'done', op: op(11), kind: 'snapshot.publish', outcome: { kind: 'published' }, recoveredBy: null }, // 12
      spawnIntent(13, { attempt: 2 }), // 13 build attempt 2, left open
    ]));
    assert.equal(state.lastSeq, 13);
    assert.equal(state.snapshotHighWater, 10);
    assert.deepEqual(state.openIntents.map((i) => i.op), [op(4), op(13)]);
    // Stage starts: plan-check#1, build#1, build#2. The retry at seq 7 is not a new start.
    assert.deepEqual(state.units, [{ unit: 'u1', stage: 'build', attempts: 3 }]);
    assert.deepEqual(state.needsUser, ['nu-9']);
    assert.deepEqual(state.meter, [
      { role: 'build', routingRev: REV, known: 1, unavailable: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { role: 'planCheck', routingRev: REV, known: 1, unavailable: 0, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 },
    ]);
    assert.deepEqual(state.tailDiscarded, []);
  });

  it('keeps open intents in log order, a retry moving to its own position', () => {
    const state = fold(ARC, chain([spawnIntent(1), spawnIntent(2), spawnLost(op(1)), spawnIntent(1, { ordinal: 2 })]));
    assert.deepEqual(state.openIntents.map((i) => `${i.op}#${i.ordinal}`), [`${op(2)}#1`, `${op(1)}#2`]);
  });

  it('an empty log', () => {
    assert.deepEqual(fold(ARC, []), {
      v: 1, arc: ARC, lastSeq: 0, snapshotHighWater: 0, openIntents: [], units: [], meter: [], needsUser: [], tailDiscarded: [],
    });
  });

  it('the view: latestIntent and doneOf', () => {
    const f = new Fold(ARC);
    for (const e of chain([spawnIntent(1), spawnLost(op(1)), spawnIntent(1, { ordinal: 2 })])) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    assert.equal(f.latestIntent(op(1)).ordinal, 2);
    assert.equal(f.doneOf(op(1)), null, 'ordinal 2 is open');
    assert.throws(() => f.latestIntent(op(9)), /no intent for op arc-1\/9/);
  });
});

describe('fold invariants', () => {
  it('contiguous seq', () => {
    const events = chain([commandIntent(1), commandIntent(2, 'other')]);
    refuses([events[0]!, { ...events[1]!, seq: 3 }], 3, /seq not contiguous: expected 2/);
  });

  it('chain intact', () => {
    const events = chain([commandIntent(1), commandIntent(2, 'other')]);
    refuses([events[0]!, { ...events[1]!, prev: H }], 2, /chain broken/);
    refuses([{ ...events[0]!, arc: arcId('arc-2') }], 1, /arc arc-2 in the log of arc arc-1/);
  });

  it('at most one open intent per key', () => {
    refuses(chain([commandIntent(1, 'k'), commandIntent(2, 'k')]), 2, /key k already has open intent arc-1\/1/);
    // Once closed, the key is free again.
    fold(ARC, chain([commandIntent(1, 'k'), { type: 'abort', op: op(1), reason: { code: 'precondition', detail: 'x' } }, commandIntent(3, 'k')]));
  });

  it('an op is named after its first intent', () => {
    refuses(chain([commandIntent(1), commandIntent(1, 'other')]), 2, /already has an intent/);
    refuses(chain([commandIntent(5)]), 1, /must be named after its first intent's seq 1/);
  });

  it('done and abort match an open intent of the same op and kind', () => {
    refuses(chain([spawnResult(op(1))]), 1, /done of unknown op/);
    refuses(chain([commandIntent(1), spawnResult(op(1))]), 2, /done of kind proc.spawn for arc-1\/1, an intent of kind command.apply/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), spawnResult(op(1))]), 3, /already closed by done result/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), { type: 'abort', op: op(1), reason: { code: 'recovery', detail: 'x' } }]), 3, /abort of arc-1\/1/);
  });

  it('ordinal strictly increasing per op, retries only after lost or abort', () => {
    refuses(chain([spawnIntent(1), spawnLost(op(1)), spawnIntent(1, { ordinal: 3 })]), 3, /ordinal 3 of arc-1\/1 does not follow 1/);
    refuses(chain([spawnIntent(2, { ordinal: 2 })]), 1, /retry ordinal 2 of unknown op/);
    refuses(chain([spawnIntent(1), spawnIntent(1, { ordinal: 2 })]), 2, /while ordinal 1 is open/);
    refuses(chain([spawnIntent(1), spawnResult(op(1)), spawnIntent(1, { ordinal: 2 })]), 3, /after done result/);
    fold(ARC, chain([spawnIntent(1), { type: 'abort', op: op(1), reason: { code: 'recovery', detail: 'x' } }, spawnIntent(1, { ordinal: 2 })]));
  });

  it('retries inherit key, parent and deadlineAt', () => {
    const lost = [spawnIntent(1), spawnLost(op(1))];
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, deadlineAt: isoTime('2026-09-25T14:00:00.000Z') })]), 3, /changes deadlineAt/);
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, deadlineAt: null })]), 3, /changes deadlineAt/);
    refuses(chain([...lost, spawnIntent(1, { ordinal: 2, key: 'elsewhere' })]), 3, /changes key/);
    refuses(chain([...lost, { ...spawnIntent(1, { ordinal: 2 }), parent: stageParent('gate', 1) } as LogRecord]), 3, /changes its parent/);
    refuses(chain([...lost, { ...commandIntent(1, 'spawn:1'), ordinal: 2 } as LogRecord]), 3, /changes kind proc.spawn to command.apply/);
  });

  it('one usage fact per invocation, for an invocation some intent opened', () => {
    refuses(chain([spawnIntent(1), meter(inv1(1), 'build', 1, 1, null), meter(inv1(1), 'build', 1, 1, null)]), 3, /second usage fact for arc-1\/1#1/);
    refuses(chain([spawnIntent(1), meter(inv1(1, 2), 'build', 1, 1, null)]), 2, /which no intent opened/);
    refuses(chain([meter(inv1(7), 'build', 1, 1, null)]), 1, /which no intent opened/);
  });

  it('a refused event leaves the fold unchanged', () => {
    const f = new Fold(ARC);
    const [a, b] = chain([spawnIntent(1, { key: 'k' }), commandIntent(2, 'k')]);
    f.apply(a!, prevHash(Buffer.from(serializeEvent(a!))));
    const before = canonicalJson(f.derived());
    assert.throws(() => f.apply(b!, prevHash(Buffer.from(serializeEvent(b!)))), FoldInvariantError);
    assert.equal(canonicalJson(f.derived()), before);
    assert.equal(f.highWater(), 1);
  });
});

describe('writeStateCache', () => {
  it('writes the derived state as canonical JSON', () => {
    const dir = tmpDir('state');
    const state = fold(ARC, chain([spawnIntent(1)]));
    const path = join(dir, 'state.json');
    writeStateCache(path, state);
    assert.equal(readFileSync(path, 'utf8'), canonicalJson(state));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(JSON.stringify(state)));
  });
});
