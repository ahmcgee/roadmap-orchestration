// dev.59 console QA from a real long arc (atlas2's m6, stopped), in the real app on the field fixture: re-entries
// outside milestones, replaced and withdrawn members, rulings in titles, revise audits, coloured check logs, a stop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { generateScaleArc } from '../helpers/scale-arc.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

// Records every fetch and its status, and each distinct connection label in order, from the first paint.
const RECORDER = `async(page)=>{await page.addInitScript(()=>{window.__reads=[];window.__labels=[];const original=window.fetch;window.fetch=async(...args)=>{const url=String(args[0]?.url??args[0]);try{const r=await original(...args);window.__reads.push({url,status:r.status});return r;}catch(e){window.__reads.push({url,status:'aborted'});throw e;}};new MutationObserver(()=>{const label=document.querySelector('.connection')?.textContent;if(label&&window.__labels.at(-1)!==label)window.__labels.push(label);}).observe(document,{subtree:true,childList:true,characterData:true});});return true;}`;
type Box = { x1: number; x2: number; y1: number; y2: number; what: string };

test('a stopped field arc reads honestly in the console', { timeout: 300_000 }, async t => {
  const m = await generateScaleArc(tmpDir('console-field-browser'), { preset: 'design', field: true });
  const repo = absPath(m.repo), common = gitCommonDir(repo);
  let s = await serveConsole({ repo, common, hostDir: absPath(m.hostDir), host: '127.0.0.1', port: 0 }), open = true;
  const b = new ConsoleBrowser(tmpDir('console-field-evidence'));
  t.after(async () => { await b.close(); if (open) await s.close(); });
  await b.initialize(); await b.call('browser_run_code_unsafe', { code: RECORDER });
  const base = () => `${s.url}/#/arcs/${m.arc}`;
  const text = (selector = 'body') => b.evaluate<string>(`()=>document.querySelector(${JSON.stringify(selector)})?.innerText??''`);
  const go = async (route: string, width = 1440, height = 900) => {
    await b.call('browser_resize', { width, height }); await b.call('browser_navigate', { url: `${base()}/${route}` });
    await until(async () => b.evaluate<boolean>('()=>document.querySelectorAll(".station").length>0||!!document.querySelector(".tab-content section")'), 20_000, `${route} loaded`);
  };
  const drawer = async (id: string, expect: RegExp) => { await go(`graph/units/${encodeURIComponent(id)}`); await until(async () => expect.test(await text('.drawer')), 15_000, `${id} drawer`); return text('.drawer'); };
  const stations = () => b.evaluate<string[]>('()=>[...document.querySelectorAll(".station")].map(s=>s.innerText.replace(/\\n/g," | "))');

  await t.test('C1: No milestone counts its own units once and reads no unit called "unbound"', async () => {
    await go('graph');
    assert.equal((await stations()).at(-1), '○ | No milestone | 2/3 | – 1 withdrawn');
    await b.evaluate('()=>{document.querySelector(".station-unbound").click();return true;}');
    await until(async () => /No milestone/.test(await text('.station-health')), 5000, 'No milestone popover');
    assert.match(await text('.station-health'), /^No milestone\n+Units that belong to no milestone in the plan\.[\s\S]*Show 2 passed units[\s\S]*Show 1 withdrawn unit$/);
    await new Promise(r => setTimeout(r, 1000));
    const reads = await b.evaluate<{ url: string; status: number | string }[]>('()=>window.__reads');
    assert.deepEqual(reads.filter(r => /unbound/.test(r.url)), [], 'no read for the station');
    assert.deepEqual(reads.filter(r => typeof r.status === 'number' && r.status >= 400), [], 'no failed read');
  });

  await t.test('C2: withdrawn members are counted apart, and the drawer names what holds the milestone', async () => {
    const lines = await stations();
    assert.equal(lines[2], '○ | MS-3 Concurrency and retries | 9/10 | – 1 withdrawn | Next to clear');
    assert.equal(lines[3], '○ | MS-4 Observability | 0/10 | – 2 withdrawn | Ⅱ 2 on hold');
    const ms3 = await drawer('milestone:MS-3', /Outstanding units/);
    assert.match(ms3, /9 of 10 units merged\n.*1 withdrawn/);
    assert.match(ms3, /Not passed\. Its walkthrough has not run, and the arc is stopped\./);
    assert.match(ms3, /Outstanding units \(0\)\n+None\n+Withdrawn units \(1\)\nu29\n.*\nReplaced\nReplaced by u30,\s+merged/);
    assert.match(await drawer('u31', /Current blocker/), /Current blocker\nMilestone MS-3 has not passed: its walkthrough has not run, and the arc is stopped/);
    // A re-entry's id is long: rows in one list share an id column wide enough for every id, on one line.
    await drawer('u33-rollup-export-r2', /Depends on/);
    await b.evaluate('()=>{document.querySelectorAll(".unit-dependencies details").forEach(d=>d.open=true);return true;}');
    const ids = await b.evaluate<{ id: string; lines: number; clipped: boolean }[]>('()=>[...document.querySelectorAll(".dependency-row>span:first-child")].map(e=>{const r=document.createRange();r.selectNodeContents(e);return {id:e.textContent,lines:new Set([...r.getClientRects()].map(b=>Math.round(b.top))).size,clipped:e.scrollWidth>e.clientWidth+1};})');
    assert.ok(ids.some(r => r.id === 'u32-flush-retry-r3'), JSON.stringify(ids));
    for (const r of ids) assert.deepEqual([r.id, r.lines, r.clipped], [r.id, 1, false]);
  });

  await t.test('C3: re-entry titles keep unit ids and their ruling', async () => {
    assert.match(await drawer('u32-flush-retry-r2', /u32-flush-retry-r2/), /^C-356: Continue u32's flush retry work from its last green tip\n/);
    assert.match(await drawer('u32-flush-retry-r3', /u32-flush-retry-r3/), /^Continues u32-flush-retry-r2's work on bounded flush retries\n/);
    assert.match(await drawer('u33-rollup-export-r2', /u33-rollup-export-r2/), /^Moved from u32-flush-retry-r2 by C-351\n/);
  });

  await t.test('C5: a stopped arc reads as stopped, at every width and on Resources', async () => {
    await go('graph', 400, 844);
    assert.equal(await b.evaluate('()=>{const e=document.querySelector(".arc-state");return e&&e.getBoundingClientRect().width>0?e.textContent:null;}'), 'Stopped');
    assert.equal(await b.evaluate('()=>document.querySelectorAll(".station")[2].querySelector(".gate-glyph").getAttribute("aria-label")'), 'pending', 'MS-3 is not running');
    const geometry = await b.evaluate<{ tabs: [string, number, number][]; zoom: [number, number][]; width: number }>('()=>({tabs:[...document.querySelectorAll(".tabs a")].map(a=>{const r=a.getBoundingClientRect();return [a.textContent,r.left,r.right];}),zoom:[...document.querySelectorAll(".zoom-step")].map(z=>{const r=z.getBoundingClientRect();return [r.width,r.right];}),width:innerWidth})');
    for (const [tab, left, right] of geometry.tabs) assert.ok(left >= 0 && right <= geometry.width, `${tab} is within the screen: ${left}-${right}`);
    assert.equal(geometry.zoom.length, 2);
    for (const [w, right] of geometry.zoom) assert.ok(w > 0 && right <= geometry.width, `zoom control visible: ${w} wide, right edge ${right}`);
    await go('resources');
    await until(async () => /When the arc/.test(await text('main')), 15_000, 'Resources now');
    assert.match(await text('main'), /When the arc stopped\n+Stopped arc, after 7d 0h\. Nothing runs until it is resumed\./);
    assert.doesNotMatch(await text('main'), /finished/i);
  });

  await t.test('C7: check logs show text, not terminal escapes', async () => {
    await drawer('u1', /Check log/);
    const href = await b.evaluate<string>('()=>[...document.querySelectorAll("a.invocation-row")].find(a=>/check log/.test(a.getAttribute("aria-label"))).getAttribute("href")');
    await b.call('browser_navigate', { url: `${s.url}/${href}` });
    await until(async () => /Bytes/.test(await text('.drawer')), 15_000, 'check log');
    const log = await b.evaluate<string>('()=>document.querySelector(".drawer pre.record").textContent+document.querySelector(".log-summary").textContent');
    assert.match(log, /pass 1/);
    assert.doesNotMatch(log, /\u001b|\[3\dm|\[39m|\[1m/);
  });

  await t.test('C8: audits show their verdict, and both finding counts say what they count', async () => {
    await go('activity');
    await b.evaluate('()=>{[...document.querySelectorAll("button")].find(b=>b.textContent==="Holistic review").click();return true;}');
    await until(async () => /Latest audit/.test(await text('main')), 15_000, 'Holistic review');
    const main = await text('main');
    assert.match(main, /Latest audit, audit-7: Revise \(found problems\)/);
    assert.match(main, /8 active findings, open or being fixed\n+15 findings raised over the arc, including resolved and dismissed/);
    assert.equal(await b.evaluate('()=>[...document.querySelectorAll("table[aria-label=\\"Holistic audits\\"] tbody tr")].every(r=>r.cells[2].textContent==="Revise (found problems)")'), true);
  });

  await t.test('C10 and labels: spend per milestone, one name per band, labelled token counts', async () => {
    await go('graph');
    await b.evaluate('()=>{document.querySelectorAll(".station")[0].click();return true;}');
    await until(async () => /Recorded spend/.test(await text('.station-health')), 5000, 'MS-1 popover');
    const summary = await (await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/status?summary=1`)).json() as { data: { milestones: { id: string; costUsd: number }[] } };
    const cost = summary.data.milestones.find(g => g.id === 'MS-1')!.costUsd;
    assert.ok(cost > 0);
    assert.match(await text('.station-health'), new RegExp(`Recorded spend \\$${cost.toFixed(2)}: its units, their re-entries and its walkthroughs\\.`));
    await b.evaluate('()=>{document.querySelector("button[aria-label=\\"All focus\\"]").click();return true;}');
    await until(async () => b.evaluate<boolean>('()=>document.querySelectorAll(".band-headings strong").length===6'), 5000, 'All headings');
    assert.deepEqual(await b.evaluate('()=>[...document.querySelectorAll(".band-headings strong")].map(s=>s.textContent)'), ['MS-1 Tenant foundations', 'MS-2 Write path', 'MS-3 Concurrency and retries', 'MS-4 Observability', 'MS-5', 'No milestone']);
    const agent = await drawer('u1', /Agent history/);
    assert.ok(agent);
    const href = await b.evaluate<string>('()=>[...document.querySelectorAll("a.invocation-row")].find(a=>/agent history/.test(a.getAttribute("aria-label"))).getAttribute("href")');
    await b.call('browser_navigate', { url: `${s.url}/${href}` });
    await until(async () => b.evaluate<boolean>('()=>document.querySelectorAll(".history-event-meta").length>0'), 15_000, 'agent history with usage');
    for (const meta of await b.evaluate<string[]>('()=>[...document.querySelectorAll(".history-event-meta")].map(e=>e.textContent)')) assert.match(meta, /^Context [\d,]+ tokens?\b|^\d/, meta);
  });

  await t.test('band headings never sit under a wait label or the minimap, at any station', async () => {
    await go('graph');
    for (let n = 0; n < 6; n++) {
      await b.evaluate(`()=>{document.querySelectorAll(".station")[${n}].click();return true;}`);
      await new Promise(r => setTimeout(r, 400));
      const boxes = await b.evaluate<Box[]>('()=>[...document.querySelectorAll(".band-headings>div,.wait-bus-label>summary,.graph-minimap")].filter(e=>getComputedStyle(e.closest(".wait-bus-label")??e).display!=="none").map(e=>{const r=e.getBoundingClientRect();return {x1:r.left,x2:r.right,y1:r.top,y2:r.bottom,what:(e.closest(".band-headings")?"heading ":"")+e.textContent.slice(0,40)};})');
      const headings = boxes.filter(x => x.what.startsWith('heading ')), others = boxes.filter(x => !x.what.startsWith('heading '));
      for (const h of headings) for (const o of others) assert.ok(h.x2 <= o.x1 || o.x2 <= h.x1 || h.y2 <= o.y1 || o.y2 <= h.y1, `station ${n}: "${h.what}" overlaps "${o.what}"`);
    }
  });

  await t.test('C6: reads that race a busy repository wait it out, and cancelled reads leave a stopped arc connected and current', async () => {
    await go('graph');
    const errors: string[] = [], stream = new AbortController();
    const listening = (async () => {
      const r = await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/events`, { signal: stream.signal });
      const decoder = new TextDecoder(); let buffer = '';
      try { for await (const chunk of r.body!) { buffer += decoder.decode(chunk); for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) if (/^event: error$/m.test(buffer.slice(0, i))) errors.push(buffer.slice(0, i)); } }
      catch (e) { if (!stream.signal.aborted) throw e; }
    })();
    await new Promise(r => setTimeout(r, 1500));
    // The architect's git activity: refs move for five seconds while the arc itself cannot change.
    const head = git(repo, 'rev-parse', 'HEAD'), ref = join(common, 'refs', 'heads', 'scratch'), until5 = Date.now() + 5000;
    let n = 0;
    const churning = (async () => { while (Date.now() < until5) { writeFileSync(ref, `${head}\n`); n++; await new Promise(r => setTimeout(r, 2)); } })();
    for (let round = 0; round < 3; round++) for (let i = 0; i < 6; i++) await b.evaluate(`()=>{document.querySelectorAll(".station")[${i}].click();return true;}`);
    for (const id of ['u31', 'milestone%3AMS-3', 'u29', 'u34']) await b.call('browser_navigate', { url: `${base()}/graph/units/${id}` });
    await churning;
    await until(async () => /\nu34\n/.test(await text('.drawer')), 20_000, 'the last drawer opens once the refs settle');
    await new Promise(r => setTimeout(r, 2000));
    stream.abort(); await listening;
    assert.ok(n > 500, `refs moved ${n} times`);
    assert.deepEqual(errors, [], 'no error notice for a capture that raced a writer');
    assert.deepEqual(await b.evaluate('()=>[...document.querySelectorAll("[role=alert]")].map(a=>a.textContent)'), []);
    assert.equal(await text('.connection'), 'Connected');
    const reads = await b.evaluate<{ url: string; status: number | string }[]>('()=>window.__reads');
    assert.deepEqual(reads.filter(r => typeof r.status === 'number' && r.status >= 400), [], 'no read failed, cancelled or raced');
  });

  await t.test('C9: the first connection is never called a reconnection, and a stale notice gives its real age', async () => {
    await go('graph');
    await until(async () => (await text('.connection')) === 'Connected', 15_000, 'connected');
    const labels = await b.evaluate<string[]>('()=>window.__labels');
    assert.equal(labels.at(-1), 'Connected');
    assert.ok(!labels.slice(0, labels.indexOf('Connected')).includes('Reconnecting'), labels.join(' → '));
    await s.close(); open = false;
    await until(async () => /Last updated/.test(await text('.stale-notice')), 15_000, 'stale notice');
    await new Promise(r => setTimeout(r, 3000));
    assert.match(await text('.stale-notice'), /^Last updated \d+s ago\. Live counters paused\.$/);
    s = await serveConsole({ repo, common, hostDir: absPath(m.hostDir), host: '127.0.0.1', port: 0 }); open = true;
  });
});
