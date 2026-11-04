import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {type Fact, type LogRecord, prevHash, serializeEvent} from '../src/core/events.ts';
import {debtId, laneId, sha, sha256} from '../src/core/ids.ts';
import {ObserverJournal, openJournal, readJournal} from '../src/core/log.ts';
import {Fold, FoldInvariantError, fold} from '../src/core/state.ts';
import {absPath} from '../src/core/values.ts';
import {ARC, chain, inv1, logBytes, spawnIntent, stageParent} from './fixtures/log-records.ts';
import {tmpDir} from './helpers/repo.ts';

type FactOf<K extends Fact['kind']> = Extract<Fact, {kind:K}>;

const head = sha('a'.repeat(40));
const reuse = (attempt: number): FactOf<'lane-reused'> => ({kind:'lane-reused', parent:stageParent('lanes',attempt), lane:laneId('unit'),
  from:{parent:stageParent('lanes',1), inv:inv1(1), at:head}});
const fact = (f: FactOf<'lane-reused'>): LogRecord => ({type:'fact',fact:f});
const duplicate = /a second lane-reused of unit under/;

// A long history exercises the actual fold without a clock assertion or a production test seam.
test('20,000 distinct lane reuses retain their order and still reject the first duplicate', () => {
  const records = [spawnIntent(1), ...Array.from({length:20_000}, (_, i) => fact(reuse(i + 1)))];
  const events = chain([...records, fact(reuse(1))]);
  const f = new Fold(ARC);
  for (const e of events.slice(0,-1)) f.apply(e,prevHash(Buffer.from(serializeEvent(e))));
  assert.equal(f.holistic().laneReuses.length,20_000);
  assert.deepEqual(f.holistic().laneReuses.at(-1)!.parent,stageParent('lanes',20_000));
  const last = events.at(-1)!;
  assert.throws(() => f.apply(last,prevHash(Buffer.from(serializeEvent(last)))),duplicate);
  assert.equal(f.highWater(),records.length);
  assert.equal(f.holistic().laneReuses.length,20_000);
});

test('lane reuse identity keeps legacy defaults, canonical parents, series set and commit', () => {
  const original = reuse(1);
  const reordered = {...original, parent:{attempt:1, stage:'lanes', unit:stageParent('lanes',1).unit, type:'stage'} as const, set:'spec' as const};
  assert.throws(() => fold(ARC,chain([spawnIntent(1),fact(original),fact(reordered)])),duplicate);
  const changed = [{...original,set:'suite' as const}, {...original,at:head}, {...original,lane:laneId('other')}];
  assert.equal(fold(ARC,chain([spawnIntent(1),fact(original),...changed.map(fact)])).holistic.laneReuses.length,4);
});

test('a rejected reuse does not reserve its key', () => {
  const events = chain([spawnIntent(1),fact(reuse(1))]);
  const f = new Fold(ARC);
  f.apply(events[0]!,prevHash(Buffer.from(serializeEvent(events[0]!))));
  const valid = events[1]!;
  const invalid = {...valid, fact:{...reuse(1),from:{...reuse(1).from,inv:inv1(99)}}};
  assert.throws(() => f.apply(invalid,prevHash(Buffer.from(serializeEvent(invalid)))),/which no intent opened/);
  f.apply(valid,prevHash(Buffer.from(serializeEvent(valid))));
  assert.equal(f.holistic().laneReuses.length,1);
});

for (const mode of ['cold','observer','observer-reset'] as const) test(`${mode} replay restores reuse membership and refuses duplicates`, () => {
  const dir = absPath(tmpDir(`reuse-${mode}`));
  const path = join(dir,'events.jsonl');
  writeFileSync(path,logBytes(chain([spawnIntent(1),fact(reuse(1))])));
  const observer = new ObserverJournal(dir,ARC);
  if (mode !== 'cold') {
    assert.equal(observer.read().view.holistic().laneReuses.length,1);
    if (mode === 'observer-reset') {
      writeFileSync(path,'');
      assert.equal(observer.read().view.highWater(),0);
      writeFileSync(path,logBytes(chain([spawnIntent(1),fact(reuse(1))])));
    }
  }
  const journal = mode === 'cold' ? openJournal(dir,ARC) : observer.open();
  try {
    assert.throws(() => journal.fact({...reuse(1),set:'spec'}),duplicate);
    assert.equal(readJournal(dir,ARC).view.holistic().laneReuses.length,1);
  } finally {journal.close();}
});

test('certificate and debt indexes preserve canonical equality and earliest collision messages', () => {
  const certificate: LogRecord = {type:'fact',fact:{kind:'series-certified',parent:stageParent('lanes',1),checkout:absPath('/wt'),at:head}};
  assert.throws(() => fold(ARC,chain([certificate,certificate])),/a second series-certified of \/wt under/);
  const debt = (n: number): FactOf<'debt-banked'> => ({kind:'debt-banked',id:debtId(`B-${n}`),key:sha256(String(n).repeat(64)),
    bankReason:'gate-note',what:`debt ${n}`,source:{type:'gate',unit:stageParent('gate',1).unit,attempt:n,index:0}});
  for (const collision of [{id:debt(1).id},{key:debt(1).key},{source:{index:0,attempt:1,unit:stageParent('gate',1).unit,type:'gate'} as const},
    {id:debt(2).id,source:debt(1).source}]) {
    assert.throws(() => fold(ARC,chain([debt(1),debt(2),{...debt(3),...collision}].map(fact => ({type:'fact',fact})))),
      (e: unknown) => e instanceof FoldInvariantError && e.detail === `debt ${'id' in collision ? collision.id : 'B-3'} banked again: B-1 (seq 1) has its id, key or source (banking is idempotent per source)`);
  }
});
