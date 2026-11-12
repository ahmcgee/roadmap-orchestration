// dev.71 stage 1 in real Chromium: while the console is behind (every capture made slower than five seconds by a git on PATH
// that waits), the page loads every view from the last observation, says calmly how far behind it is, and clears the line by
// itself when captures are fast again; a lost connection is "Reconnecting".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { unitId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { investigationFixture } from '../fixtures/console-investigations.ts';
import { until } from '../fixtures/exec-common.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { slowGit } from '../helpers/console-lag.ts';
import { tmpDir } from '../helpers/repo.ts';

const CATCHING_UP = /^Catching up\. Showing the arc as of \d+s ago\.$/;
type Page = { line: string | null; pill: string | null; alerts: string[]; rows: number; history: string | null; api: number };
const PAGE = `()=>({line:document.querySelector('.lag-line')?.textContent??null,pill:document.querySelector('.connection')?.textContent??null,
  alerts:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent),rows:document.querySelectorAll('#content tbody tr').length,
  history:document.querySelector('.agent-detail')?.textContent??null,api:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).length})`;

test('T9 and T10: behind, every tab loads from the last observation under one calm line that clears itself; agent history keeps following; a lost connection reconnects', { timeout: 240_000 }, async (t) => {
  const f = await investigationFixture(), git = slowGit(), path = process.env['PATH'];
  t.after(() => { process.env['PATH'] = path; git.close(); f.close(); });
  process.env['PATH'] = `${git.dir}:${path}`;
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  let open = true; t.after(async () => { if (open) await s.close(); });
  let appending = true;
  const appends = (async () => { while (appending) { f.journal.fact({ kind: 'stage-admitted', unit: unitId('u7'), stage: 'build', waited: { totalMs: 1, byReasonMs: { 'cpu-tokens': 1 } } }); await new Promise((r) => setTimeout(r, 700)); } })();
  t.after(() => { appending = false; return appends; });
  const b = new ConsoleBrowser(tmpDir('console-lag-browser')); t.after(() => b.close()); await b.initialize();
  await b.call('browser_resize', { width: 1440, height: 900 });
  const page = () => b.evaluate<Page>(PAGE);
  const go = (hash: string) => b.evaluate(`()=>{location.hash=${JSON.stringify(hash)};return true;}`);
  await b.call('browser_navigate', { url: `${s.url}/#/arcs/${f.arc}/graph` });
  await b.evaluate('()=>{performance.setResourceTimingBufferSize(100000);return true;}');
  await until(async () => (await page()).pill === 'Connected', 20_000, 'connected');
  // T10: the running invocation's agent history, following live.
  await go(`#/arcs/${f.arc}/graph/invocations/${f.live.routeId}`);
  await until(async () => /Following live/.test((await page()).history ?? ''), 15_000, 'agent history following live');

  git.slow(true);
  await until(async () => CATCHING_UP.test((await page()).line ?? ''), 40_000, 'the lag line');
  const behindFrom = (await page()).api;
  let p = await page();
  assert.equal(p.pill, 'Connected'); assert.deepEqual(p.alerts, []);
  assert.match(p.history ?? '', /Following live/, 'T10: still following live');
  assert.equal(await b.evaluate<string | null>(`()=>[...document.querySelectorAll('.invocation-status>div')].find(d=>d.querySelector('dt').textContent==='Status')?.querySelector('dd').textContent??null`), 'Running', 'T10: Status reads Running');
  await go(`#/arcs/${f.arc}/graph`);
  for (const tab of ['activity', 'timeline', 'effort']) {
    const began = Date.now(); await go(`#/arcs/${f.arc}/${tab}`);
    await until(async () => (await page()).rows > 0, 2_000, `${tab} rows within 2 s while behind`);
    p = await page();
    assert.match(p.line ?? '', CATCHING_UP, `${tab}: the line stays`); assert.deepEqual(p.alerts, [], `${tab}: no alert`); assert.equal(p.pill, 'Connected');
    t.diagnostic(`${tab} rows after ${Date.now() - began} ms`);
    await new Promise((r) => setTimeout(r, 2_000));
    assert.ok((await page()).rows > 0, `${tab}: rows stay`);
  }
  // No re-poll storm: a tab's reads while behind are a handful, not thousands.
  const behindReads = (await page()).api - behindFrom;
  assert.ok(behindReads < 100, `${behindReads} API requests in the behind phase`);

  git.slow(false);
  await until(async () => { const q = await page(); return q.line === null && q.alerts.length === 0 && q.pill === 'Connected'; }, 10_000, 'the line clears itself, no alert left');
  assert.ok((await page()).rows > 0);

  appending = false; await appends;
  await s.close(); open = false;
  await until(async () => (await page()).pill === 'Reconnecting', 10_000, 'Reconnecting');
  await until(async () => /^Reconnecting\. Showing the arc as of /.test((await page()).line ?? ''), 10_000, 'the reconnecting line');
});

test('T11: while events arrive every second, Timeline and Resources hold still: rows never blank, the list is fetched once, and updates are offered', { timeout: 180_000 }, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  t.after(() => s.close());
  const b = new ConsoleBrowser(tmpDir('console-lag-browser-still')); t.after(() => b.close()); await b.initialize();
  await b.call('browser_resize', { width: 1440, height: 900 });
  await b.call('browser_navigate', { url: `${s.url}/#/arcs/${f.arc}/graph` });
  await b.evaluate('()=>{performance.setResourceTimingBufferSize(100000);return true;}');
  await until(async () => await b.evaluate<string>(`()=>document.querySelector('.connection')?.textContent??''`) === 'Connected', 20_000, 'connected');
  for (const tab of ['timeline', 'resources']) {
    await b.evaluate(`()=>{window.__entered=performance.now();location.hash='#/arcs/${f.arc}/${tab}';return true;}`);
    await until(async () => b.evaluate<boolean>(`()=>document.querySelectorAll('#content tbody tr').length>0`), 10_000, `${tab} rows`);
    // From the first render on, the body never has zero rows (as $D/scripts/walk-current.ts watches it).
    await b.evaluate(`()=>{window.__still={blanks:0,from:performance.now()};new MutationObserver(()=>{if(document.querySelectorAll('#content tbody tr').length===0)window.__still.blanks++;}).observe(document.getElementById('content'),{childList:true,subtree:true});return true;}`);
    for (let n = 0; n < 15; n++) {
      const p = f.begin('u9', 'build');
      f.journal.fact({ kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false });
      f.journal.fact({ kind: 'stage-admitted', unit: unitId('u9'), stage: 'build', waited: { totalMs: 10, byReasonMs: { 'cpu-tokens': 10 } } });
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await until(async () => /Updates available\./.test(await b.evaluate<string>(`()=>document.getElementById('content').innerText`)), 10_000, `${tab}: updates are offered`);
    const seen = await b.evaluate<{ blanks: number; reads: string[] }>(`()=>({blanks:window.__still.blanks,reads:performance.getEntriesByType('resource').filter(e=>e.startTime>=window.__entered&&new URL(e.name).pathname.endsWith('/${tab}')&&!new URL(e.name).searchParams.has('pending')).map(e=>new URL(e.name).search)})`);
    assert.equal(seen.blanks, 0, `${tab}: the body never blanked`);
    // Resources also reads what holds resources now (section=now) when its list is behind; the list itself is read once.
    const list = seen.reads.filter((q) => !q.includes('section=now'));
    assert.equal(list.length, 1, `${tab}: the list was read ${list.length} times while events arrived: ${list.join(' ')}`);
  }
});
