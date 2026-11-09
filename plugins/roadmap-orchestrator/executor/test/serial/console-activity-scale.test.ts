import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { ObservationCache } from '../../src/observation/cache.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { ConsoleActivity } from '../../src/console/activity-query.ts';
import { activityDetail } from '../../src/console/activity-detail.ts';
import { activityShape, activityDetailShape } from '../../src/console/view-shapes.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { consoleGet } from '../helpers/console-http.ts';
import type { ActivityView } from '../../src/console/activity-protocol.ts';

test('300-unit seven-day typed Activity preserves six backend parks/closures, exhaustive keysets and decoded HTTP/detail budgets', {timeout: 90_000}, async t => {
  const generated = performance.now(), m = await generateScaleArc(tmpDir('console-activity-scale')), generationMs = performance.now() - generated;
  const release = await ownScaleArc(m); t.after(release);
  const captureStart = performance.now(), e = new ObservationCache(absPath(m.hostDir), 'activity-scale', 'repo').read({runDir: absPath(m.runDir), arc: arcId(m.arc)}), captureMs = performance.now() - captureStart;
  assert.equal(e.data.display.status.units.length, 300); assert.equal(e.data.display.invocations.length, 1088); assert.equal(e.data.events.length, 7523); assert.equal(e.data.plan!.milestones!.length, 10);
  const a = new ConsoleActivity(), start = performance.now(), index = a.index(e), indexMs = performance.now() - start;
  assert.equal(index.holds.length, 6); assert.ok(index.holds.every(h => h.recordedClass === 'usage-limit' && h.closure?.kind === 'resumed'));
  assert.equal(index.entries.filter(e => e.row.kind === 'backend-park').length, 6); assert.equal(index.entries.filter(e => e.row.kind === 'backend-closure').length, 6);
  const seen = new Set<string>(); let page = a.page(e, {}), maximumPageBytes = 0, pageCount = 0;
  const matching = page.page.matching;
  for (;;) {
    assert.ok(activityShape(page)); maximumPageBytes = Math.max(maximumPageBytes, Buffer.byteLength(JSON.stringify({...e, data: page}) + '\n'));
    assert.ok(page.rows.length <= 50); pageCount++;
    for (const row of page.rows) {assert.equal(seen.has(row.id), false); seen.add(row.id);}
    if (!page.page.next) break;
    page = a.page(e, {cursor: page.page.next}); assert.ok(pageCount < 100);
  }
  assert.equal(seen.size, matching); assert.ok(maximumPageBytes <= 64 * 1024);
  const parks = a.page(e, {kind: 'backend-park,backend-closure'}); assert.equal(parks.rows.length, 12); assert.equal(parks.page.matching, 12);
  for (const day of parks.days) {
    const from = day.date + 'T00:00:00.000Z', to = new Date(Date.parse(from) + 86400_000).toISOString();
    assert.equal(a.page(e, {kind: 'backend-park,backend-closure', from, to}).page.matching, day.count);
  }
  let largestDetailBytes = 0;
  for (const row of parks.rows) {const data = activityDetail(e, a, row.id, {}); assert.ok(activityDetailShape(data)); largestDetailBytes = Math.max(largestDetailBytes, Buffer.byteLength(JSON.stringify({...e, data}) + '\n'));}
  assert.ok(largestDetailBytes <= 32 * 1024);
  const httpStart = performance.now(), s = await serveConsole({repo: absPath(m.repo), common: gitCommonDir(absPath(m.repo)), hostDir: absPath(m.hostDir), host: '127.0.0.1', port: 0}); t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  const shell = await consoleGet(`${base}/shell`), shellBody = await shell.text(), firstShellMs = performance.now() - httpStart;
  assert.equal(shell.status, 200); assert.ok(Buffer.byteLength(shellBody) <= 8 * 1024);
  const initial = await consoleGet(`${base}/activity`), initialBody = await initial.text(), firstActivityMs = performance.now() - httpStart;
  assert.equal(initial.status, 200, initialBody.slice(0, 500)); assert.ok(activityShape(JSON.parse(initialBody).data));
  assert.ok(Buffer.byteLength(initialBody) <= 64 * 1024); assert.ok(Buffer.byteLength(shellBody) + Buffer.byteLength(initialBody) <= 72 * 1024);
  const observedParks = await consoleGet(`${base}/activity?kind=backend-park,backend-closure`); assert.equal(observedParks.status, 200);
  assert.equal((await observedParks.json() as {data: ActivityView}).data.page.matching, 12);
  const samples: number[] = [];
  for (let n = 0; n < 20; n++) {const began = performance.now(), r = await consoleGet(`${base}/activity`); assert.equal(r.status, 200); await r.json(); samples.push(performance.now() - began);}
  samples.sort((a, b) => a - b);
  const queryStart = performance.now(), finalPage = a.page(e, {}), queryMs = performance.now() - queryStart;
  const serializeStart = performance.now(), serialized = JSON.stringify({...e, data: finalPage}), serializationMs = performance.now() - serializeStart;
  const parseStart = performance.now(); JSON.parse(serialized); const parseMs = performance.now() - parseStart;
  t.diagnostic(JSON.stringify({fixture: {units: 300, days: 7, events: 7523, invocations: 1088}, typedRows: index.entries.length, defaultMatching: matching, pageCount,
    bytes: {maximumPage: maximumPageBytes, largestParkDetail: largestDetailBytes, httpShell: Buffer.byteLength(shellBody), httpActivity: Buffer.byteLength(initialBody), httpColdPair: Buffer.byteLength(shellBody) + Buffer.byteLength(initialBody)},
    timingMs: {generation: generationMs, capture: captureMs, activityIndex: indexMs, pageQuery: queryMs, firstShell: firstShellMs, firstActivity: firstActivityMs, warmActivityP95: samples[18], serialization: serializationMs, nodeParse: parseMs}, processRssBytes: process.memoryUsage().rss}));
});
