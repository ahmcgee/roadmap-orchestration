import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IntentOf, LogRecord, Parent } from '../src/core/events.ts';
import { prevHash, serializeEvent } from '../src/core/events.ts';
import { laneId, sha, unitId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { Fold } from '../src/core/state.ts';
import { laneSpawns } from '../src/pipeline/lanes.ts';
import { ARC, chain, spawnIntent, stageParent } from './fixtures/log-records.ts';

test('laneSpawns equals the full scan among many parents, including canonical parents and retried intents', () => {
  const records: LogRecord[] = [];
  const at = sha('a'.repeat(40));
  const elsewhere = sha('b'.repeat(40));
  const lane = laneId('unit');
  const other = laneId('other');
  const parent = stageParent('lanes', 1);
  const append = (p: Parent, id = lane, tree = at, set: 'spec' | 'suite' = 'spec') => {
    const base = spawnIntent(records.length + 1);
    assert.equal(base.kind, 'proc.spawn');
    const intent: IntentOf<'proc.spawn'> = { ...base, parent: p, expect: { ...base.expect,
      subject: { purpose: 'lane', unit: parent.unit, lane: id, set, at: tree },
    } };
    records.push(intent);
    return intent;
  };
  const first = append(parent);
  for (let n = 0; n < 2_000; n++) append(stageParent(n % 2 === 0 ? 'lanes' : 'candidate', n % 10 + 1, unitId(`other-${Math.floor(n / 10)}`)));
  append({ attempt: 1, stage: 'lanes', unit: parent.unit, type: 'stage' });
  append(parent, other);
  append(parent, lane, elsewhere);
  append(parent, lane, at, 'suite');
  append(stageParent('lanes', 2));
  append(stageParent('candidate', 1));
  records.push({ ...spawnIntent(records.length + 1), parent }); // A backend in the same attempt.
  records.push({ type: 'abort', op: first.op, reason: { code: 'cancelled', detail: 'retry' } });
  records.push({ ...first, ordinal: 2 });

  const view = new Fold(ARC);
  const events = chain(records);
  const apply = (event: typeof events[number]) => view.apply(event, prevHash(Buffer.from(serializeEvent(event))));
  for (const event of events.slice(0, -2)) apply(event);
  const before = laneSpawns(view, parent, lane, at);
  assert.equal(before.length, 2, 'first and rerun retain their order');
  for (const event of events.slice(-2)) apply(event);
  for (const p of [parent, stageParent('lanes', 2), stageParent('candidate', 1), stageParent('lanes', 99)]) {
    for (const id of [lane, other]) for (const tree of [at, elsewhere]) for (const set of ['spec', 'suite'] as const) {
      const scanned = view.opsOf('proc.spawn').filter((i) => {
        const s = i.expect.subject;
        return s.purpose === 'lane' && s.set === set && s.lane === id && s.at === tree && canonicalJson(i.parent) === canonicalJson(p);
      });
      assert.deepEqual(laneSpawns(view, p, id, tree, set), scanned);
    }
  }
  assert.equal(laneSpawns(view, parent, lane, at)[0]!.ordinal, 2, 'latest intent replaces the first in place');
  assert.equal(before[0]!.ordinal, 1, 'an earlier read stays a snapshot');
});
