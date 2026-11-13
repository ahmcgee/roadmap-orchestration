// dev.77: the Activity index of an arc is not a cache. It is never refused or evicted for its size (an arc whose index is past
// the 24 MiB the anchors are bounded by still serves Activity), and anchors past their bounds degrade to "Updates available."
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import { ConsoleActivity, ACTIVITY_RETENTION } from '../src/console/activity-query.ts';
import { ConsoleError, CONSOLE_PROTOCOL, type Envelope } from '../src/observation/protocol.ts';
import type { Event } from '../src/core/events.ts';
import type { Metadata } from '../src/console/view-protocol.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { serveConsole } from '../src/console/http.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { absPath } from '../src/core/values.ts';
import { until } from './fixtures/exec-common.ts';
import { frames, type Frame } from './helpers/console-lag.ts';
import { consoleGet } from './helpers/console-http.ts';
const {ViewStore} = await import(new URL('../web-src/app/view-store.ts', import.meta.url).href);
const {preparedRead} = await import(new URL('../web-src/app/prepared-read.ts', import.meta.url).href);

/** `e` grown by `n` findings opened, each with a long claim: a journal whose index is large in few events. */
function grown(e: Envelope, base: Envelope, n: number): Envelope {
  const opened = base.data.events.find((ev) => ev.type === 'fact' && ev.fact.kind === 'finding-opened')!;
  if (opened.type !== 'fact' || opened.fact.kind !== 'finding-opened') throw new Error('the fixture opens a finding');
  const events: Event[] = [...e.data.events];
  for (let k = 0; k < n; k++) {
    const seq = events.at(-1)!.seq + 1;
    events.push({...opened, seq, fact: {...opened.fact, id: `F-${seq}` as typeof opened.fact.id, claim: `Recorded claim ${seq}: ${'the empty input case is not documented '.repeat(8)}`}});
  }
  return {...e, highWater: events.at(-1)!.seq, data: {...e.data, events, capture: {...e.data.capture, materializations: e.data.capture.materializations + events.length}}};
}

test('an arc whose Activity index is past the old 24 MiB bound still serves Activity pages, cursors and change counts', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = new Observations(f.hostDir, 'activity-large', 'repo').read({runDir: f.runDir, arc: f.arc});
  const large = grown(e, e, 26_000), a = new ConsoleActivity(), query = {kind: 'finding-opened', limit: '25'};
  const first = a.page(large, query);
  assert.ok(a.index(large).bytes > ACTIVITY_RETENTION.bytes, `the index retains ${a.index(large).bytes} bytes, past ${ACTIVITY_RETENTION.bytes}`);
  assert.equal(first.page.matching, 26_001);
  const larger = grown(large, e, 40);
  assert.equal(a.changes(larger, {...query, anchor: first.page.anchor}).newMatching, 40);
  const next = a.page(larger, {...query, cursor: first.page.next!});
  assert.equal(next.rows.length, 25); assert.ok(next.rows.every((r) => r.seq < first.rows.at(-1)!.seq));
  assert.equal(a.page(larger, query).page.matching, 26_041);
  const sizes = a.sizes();
  assert.deepEqual([sizes.indexes, sizes.built, sizes.extended], [1, 1, 1], 'the one index is kept and extended, never refused or evicted');
});

test('an anchor past the anchors\' bound answers reset, never unavailable, and its tab keeps its page with "Updates available."', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = new Observations(f.hostDir, 'activity-anchor-bound', 'repo').read({runDir: f.runDir, arc: f.arc}), a = new ConsoleActivity();
  const first = a.page(e, {});
  for (let n = 0; n < ACTIVITY_RETENTION.queries; n++) a.page(e, {q: `eviction ${n}`});
  assert.throws(() => a.changes(e, {anchor: first.page.anchor}), (error: unknown) => error instanceof ConsoleError && error.code === 'reset');
  assert.equal(a.page(e, {}).page.matching, first.page.matching, 'the view itself still answers');

  // Through the console and the page's store: the count's read is `reset`, which the Activity tab shows as "Updates available."
  // with "Show latest" (web-src/app/activity.tsx); the page it shows keeps its rows.
  const s = await serveConsole({repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0});
  t.after(() => s.close());
  const api = `${s.url}/api/${CONSOLE_PROTOCOL}`, base = `${api}/arcs/${f.arc}`;
  const stream = new AbortController(); t.after(() => stream.abort());
  const seen: Frame[] = []; frames((await fetch(`${base}/events`, {signal: stream.signal})).body!, seen);
  const notices = () => seen.filter((x) => x.event === 'revision').map((x) => x.data as Metadata);
  await until(() => notices().length > 0, 30_000, 'first notice');
  const store = new ViewStore(f.arc, CONSOLE_PROTOCOL, (path: string, signal: AbortSignal) => preparedRead(api, CONSOLE_PROTOCOL, path, signal));
  store.notice(notices().at(-1)!);
  const path = 'activity?window=arc&zone=UTC';
  await store.load(path, true);
  const page = store.entry(path).value.data;
  for (let n = 0; n < ACTIVITY_RETENTION.queries; n++) assert.equal((await consoleGet(`${base}/activity?q=eviction${n}`)).status, 200);
  const before = notices().at(-1)!, p = f.begin('u9', 'build');
  f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false} as never);
  await until(() => notices().some((n) => n.highWater > before.highWater), 10_000, 'a new capture');
  store.notice(notices().at(-1)!);
  const changes = `activity/changes?window=arc&zone=UTC&anchor=${encodeURIComponent(page.page.anchor)}`;
  await store.load(changes, true);
  assert.equal(store.entry(changes).code, 'reset', store.entry(changes).error);
  assert.notEqual(store.entry(changes).code, 'unavailable');
  assert.equal(store.entry(path).value.data, page, 'the page keeps what it showed');
  assert.equal(store.entry(path).error, '');
});
