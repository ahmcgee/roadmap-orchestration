import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { activityShape, activityChangesShape, activityDetailShape } from '../src/console/view-shapes.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { round4Fixture } from './fixtures/console-round4.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { absPath } from '../src/core/values.ts';
import { consoleGet } from './helpers/console-http.ts';
import type { ActivityView, ActivityDetail, ActivityChanges } from '../src/console/activity-protocol.ts';

test('typed Activity HTTP is independent of the model, preserves security/admission and provides a real target for every row', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const messages: any[] = [], post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function(this: Worker, m: any, ...rest: any[]) {messages.push(m); return post.call(this, m, ...rest);});
  const s = await serveConsole({repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0}); t.after(() => s.close());
  const url = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity`;
  const response = await consoleGet(url), text = await response.text(), e = JSON.parse(text) as {epoch: string; highWater: number; data: ActivityView};
  assert.equal(response.status, 200, text); assert.ok(activityShape(e.data)); assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('content-security-policy')?.includes("default-src 'self'")); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const head = await consoleGet(url); assert.equal(head.status, 200);
  const actualHead = await fetch(url, {method: 'HEAD'}); assert.ok([200, 202].includes(actualHead.status)); assert.equal(await actualHead.text(), '');
  assert.equal((await fetch(url, {method: 'POST'})).status, 405);
  assert.equal((await consoleGet(url + '?epoch=old')).status, 409);
  assert.equal((await consoleGet(url + `?minHighWater=${e.highWater + 1000}`)).status, 503);
  for (const q of ['offset=0', 'q=x&q=x', 'cursor=x', 'limit=30', 'unit=missing', 'housekeeping=maybe', 'beforeSeq=-1', 'from=2026-02-30T00:00:00Z', 'typo=1']) assert.equal((await consoleGet(`${url}?${q}`)).status, 400, q);
  assert.equal((await fetch(`${url}/a%2fb`)).status, 400);
  const seen = new Set<string>();
  let page = e.data;
  for (;;) {
    for (const row of page.rows) {
      assert.equal(seen.has(row.id), false); seen.add(row.id); assert.equal(row.detail.type, 'event');
      const detail = await consoleGet(`${url}/${row.detail.id}`), body = await detail.text(), d = JSON.parse(body) as {data: ActivityDetail};
      assert.equal(detail.status, 200, body); assert.ok(activityDetailShape(d.data)); assert.equal(d.data.row.id, row.id); assert.ok(Buffer.byteLength(body) <= 32 * 1024);
    }
    if (!page.page.next) break;
    const next = await consoleGet(`${url}?cursor=${encodeURIComponent(page.page.next)}`); assert.equal(next.status, 200); page = (await next.json() as {data: ActivityView}).data;
  }
  assert.equal(seen.size, e.data.page.matching);
  const changes = await consoleGet(`${url}/changes?anchor=${encodeURIComponent(e.data.page.anchor)}`), c = await changes.json() as {data: ActivityChanges};
  assert.equal(changes.status, 200); assert.ok(activityChangesShape(c.data)); assert.equal(c.data.newMatching, 0); assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 2048);
  assert.equal((await consoleGet(url + '/changes')).status, 400); assert.equal((await consoleGet(url + '/foreign')).status, 404);
  const invalid = {...e.data, raw: {hidden: true}}; assert.equal(activityShape(invalid), false); assert.equal(activityShape({...e.data, uiSchema: 999}), false);
  assert.equal(messages.some(m => m.kind === 'read' && ['snapshot', 'activity-legacy', 'status'].includes(m.path[2])), false);
  // The canonical observer's evidence integrity still holds for views: the integrity sweep finds the rewritten record within
  // its detection bound (a step or two on this fixture), and reads answer the corruption from then on. Until then a view
  // that opens the record itself refuses it (its digest no longer matches) and none serves it.
  const path = join(f.runDir, 'inv', f.review.routeId, 'result.json'), original = readFileSync(path); writeFileSync(path, '{}');
  const deadline = Date.now() + 10_000;
  let refused = await consoleGet(url);
  while (refused.status !== 500 && Date.now() < deadline) { assert.notEqual(refused.status, 200, 'a tampered record is never served'); await new Promise((r) => setTimeout(r, 200)); refused = await consoleGet(url); }
  assert.equal(refused.status, 500); assert.match(await refused.text(), /corruption|invalid|result|digest/);
  writeFileSync(path, original);
});

test('typed Activity hides successful housekeeping before counts/pages, retains failed cleanup and supports direct ranges', async t => {
  const f = await round4Fixture(); t.after(() => f.close());
  for (let n = 0; n < 60; n++) {const p = f.begin('u7', 'quiesce'); f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'quiesce', attempt: p.attempt, outcome: 'empty', class: 'advance', chargeable: false});}
  const s = await serveConsole({repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0}); t.after(() => s.close());
  const url = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/activity`;
  const page = async (query: string) => {const response = await consoleGet(url + query), raw = await response.json() as {data: ActivityView}; assert.equal(response.status, 200, JSON.stringify(raw)); assert.ok(activityShape(raw.data)); return raw.data;};
  const ordinary = await page(''), all = await page('?housekeeping=1');
  assert.ok(ordinary.rows.some(r => /Cleanup failed/.test(r.summary.text))); assert.ok(ordinary.rows.every(r => !r.housekeeping));
  assert.equal(all.rows.length, 50); assert.ok(all.rows.every(r => r.housekeeping)); assert.ok(all.page.next);
  let current = all, failure = false, count = 0;
  for (;;) {failure ||= current.rows.some(r => /Cleanup failed/.test(r.summary.text)); count += current.rows.length; if (!current.page.next) break; current = await page(`?housekeeping=1&cursor=${encodeURIComponent(current.page.next)}`);}
  assert.equal(failure, true); assert.equal(count, all.page.matching); assert.equal(all.page.matching - ordinary.page.matching, 64);
  const from = all.days[0]!.date + 'T00:00:00.000Z', to = new Date(Date.parse(from) + 86400_000).toISOString();
  const day = await page(`?housekeeping=1&from=${from}&to=${to}`); assert.equal(day.page.matching, all.days[0]!.count);
});
