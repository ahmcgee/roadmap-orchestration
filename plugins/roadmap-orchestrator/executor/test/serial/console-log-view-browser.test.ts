import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { consoleAgentFixture } from '../fixtures/console-agent.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

// The first transcript event still visible at the scroller's top edge, and the share of it above that edge: the reader's position at any width.
const POSITION = `()=>{const sc=document.querySelector(".history-scroll"),top=sc.getBoundingClientRect().top;const el=[...sc.querySelectorAll("[data-event-id]")].find(n=>!n.closest("details:not([open])")&&n.getBoundingClientRect().height>0&&n.getBoundingClientRect().bottom>top);const box=el.getBoundingClientRect();return {id:el.dataset.eventId,share:(top-box.top)/box.height,scrollTop:Math.round(sc.scrollTop)};}`;
const AT_BOTTOM = '()=>{const sc=document.querySelector(".history-scroll");return sc.scrollHeight-sc.scrollTop-sc.clientHeight<48;}';
const FOCUSED = (cls: string) => `()=>document.activeElement?.classList.contains("${cls}")===true`;
type Position = { id: string; share: number; scrollTop: number };

test('agent and check logs open at full page width on their own route and return to the drawer where the reader was', { timeout: 150_000 }, async t => {
  const f = await consoleAgentFixture();
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  const evidence = tmpDir('console-log-view'), b = new ConsoleBrowser(evidence);
  t.after(async () => { await b.close(); await s.close(); f.close(); });
  await b.initialize(); await b.call('browser_resize', { width: 1440, height: 900 });
  for (let n = 0; n < 40; n++) f.append(`Recorded paragraph ${n}: ${'the agent explains what it read and why it matters '.repeat(10)}`);
  const drawerHash = `#/arcs/${f.arc}/graph/invocations/${f.routeId}`, drawerUrl = `${s.url}/${drawerHash}`;
  const text = () => b.evaluate<string>('() => document.body.innerText');
  const isFull = () => b.evaluate<boolean>('()=>!!document.querySelector(".drawer.drawer-full")');
  const click = (selector: string) => b.evaluate(`()=>{document.querySelector(${JSON.stringify(selector)}).click();return true;}`);
  const controlText = () => b.evaluate<string>('()=>document.querySelector(".history-controls").innerText');

  await t.test('Expand from a live agent history keeps the reading position, gives code the width, and Escape returns to the drawer', async () => {
    await b.call('browser_navigate', { url: drawerUrl });
    await until(async () => /Agent is working/.test(await text()) && /Recorded paragraph 39/.test(await text()), 12_000, 'live history');
    assert.equal(await b.evaluate('()=>!!document.querySelector(".thinking-disclosure button")&&!!document.querySelector(".history-unforeseen details")'), true, 'fixture has a thinking event and a closed payload');
    await b.evaluate('()=>{document.querySelector(".history-unforeseen details").open=true;document.querySelector(".thinking-disclosure button").click();document.querySelector(".session-details").open=true;return true;}');
    await until(async () => b.evaluate('()=>document.querySelector(".thinking-disclosure button").getAttribute("aria-expanded")==="true"'), 5000, 'thinking open');
    await b.evaluate('()=>{const sc=document.querySelector(".history-scroll");sc.scrollTop=Math.round(sc.scrollHeight/3);return true;}');
    await until(async () => /Follow live tail/.test(await controlText()), 5000, 'reader stopped following');
    const before = await b.evaluate<Position>(POSITION);
    await click('.drawer-expand');
    await until(isFull, 5000, 'full view');
    assert.equal(await b.evaluate('()=>location.hash'), `${drawerHash}/log`);
    assert.deepEqual(await b.evaluate('()=>{const r=document.querySelector(".drawer").getBoundingClientRect();return [Math.round(r.left),Math.round(r.width)===innerWidth];}'), [0, true]);
    assert.equal(await b.evaluate('()=>[[8,450],[innerWidth/3,450],[innerWidth-8,450]].every(([x,y])=>document.elementFromPoint(x,y)?.closest(".drawer"))'), true, 'nothing of the Graph shows beside the full log');
    const inFull = await b.evaluate<Position>(POSITION);
    assert.equal(inFull.id, before.id, JSON.stringify([before, inFull])); assert.ok(Math.abs(inFull.share - before.share) < 0.02, `same part of the same event at the top edge: ${JSON.stringify([before, inFull])}`);
    assert.equal(await b.evaluate(FOCUSED('drawer-back')), true);
    const widths = await b.evaluate<{ prose: number; code: number; scroller: number; ch: number }>('()=>{const sc=document.querySelector(".history-scroll"),p=sc.querySelector(".history-markdown p"),pre=sc.querySelector(".history-tool-error pre"),probe=document.createElement("span");probe.textContent="0".repeat(80);p.append(probe);const ch=probe.getBoundingClientRect().width;probe.remove();return {prose:p.getBoundingClientRect().width,code:pre.getBoundingClientRect().width,scroller:sc.clientWidth,ch};}');
    assert.ok(widths.prose <= widths.ch * 1.02 && widths.prose < widths.scroller * 0.6, `prose keeps a readable measure: ${JSON.stringify(widths)}`);
    assert.ok(widths.code > widths.scroller * 0.85, `tool output uses the width: ${JSON.stringify(widths)}`);
    await b.call('browser_take_screenshot', { type: 'png', filename: `${evidence}/full-agent.png`, fullPage: false });
    await b.call('browser_press_key', { key: 'Escape' });
    await until(async () => !await isFull(), 5000, 'drawer after Escape');
    assert.equal(await b.evaluate('()=>location.hash'), drawerHash);
    const after = await b.evaluate<Position>(POSITION);
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 1, `drawer scroll restored: ${JSON.stringify([before, after])}`);
    assert.equal(after.id, before.id);
    assert.equal(await b.evaluate('()=>document.querySelector(".history-unforeseen details").open&&document.querySelector(".session-details").open&&document.querySelector(".thinking-disclosure button").getAttribute("aria-expanded")==="true"'), true, 'expanded items stay expanded');
    assert.equal(await b.evaluate(FOCUSED('drawer-expand')), true);
    assert.ok(await b.evaluate<number>('()=>document.querySelector(".drawer").getBoundingClientRect().width') < 1000, 'back at drawer width');
  });

  await t.test('a live log keeps following in the full view, holds still once the reader scrolls up, and Back returns to the live tail', async () => {
    await b.evaluate('()=>{[...document.querySelectorAll(".history-controls button")].find(e=>/Follow live tail/.test(e.textContent)).click();return true;}');
    await until(async () => /Following live/.test(await controlText()) && await b.evaluate<boolean>(AT_BOTTOM), 5000, 'following in the drawer');
    await click('.drawer-expand'); await until(isFull, 5000, 'full view');
    await until(() => b.evaluate<boolean>(AT_BOTTOM), 5000, 'full view opens at the live tail');
    f.append('Arrived while the full view was open.');
    await until(async () => /Arrived while the full view was open/.test(await text()), 10_000, 'live append in the full view');
    assert.equal(await b.evaluate(AT_BOTTOM), true, 'still at the live tail');
    assert.equal(await b.evaluate('()=>{const sc=document.querySelector(".history-scroll").getBoundingClientRect(),caret=document.querySelector(".history-live").getBoundingClientRect();return caret.top>=sc.top&&caret.bottom<=sc.bottom;}'), true);
    await b.evaluate('()=>{document.querySelector(".history-scroll").scrollTop=200;return true;}');
    await until(async () => /Follow live tail/.test(await controlText()), 5000, 'stopped following in the full view');
    f.append('Arrived while reading earlier output.');
    await until(async () => /Follow live tail \(1 update\)/.test(await controlText()), 10_000, 'update counted, not scrolled to');
    assert.equal(await b.evaluate('()=>Math.round(document.querySelector(".history-scroll").scrollTop)'), 200);
    await click('.drawer-back');
    await until(async () => !await isFull(), 5000, 'drawer after Back');
    assert.equal(await b.evaluate('()=>location.hash'), drawerHash);
    await until(async () => /Arrived while reading earlier output/.test(await text()) && /Following live/.test(await controlText()) && await b.evaluate<boolean>(AT_BOTTOM), 10_000, 'drawer back at the live tail it was following');
    assert.equal(await b.evaluate(FOCUSED('drawer-expand')), true);
  });

  await t.test('the full view has its own link that survives reload, and its Back opens the drawer in place', async () => {
    await b.call('browser_navigate', { url: `${drawerUrl}/log` });
    await until(async () => await isFull() && /Recorded paragraph 39/.test(await text()), 12_000, 'deep-linked full view');
    await b.evaluate('()=>{location.reload();return true;}');
    await until(async () => await isFull() && /Recorded paragraph 39/.test(await text()) && /Agent is working/.test(await text()), 12_000, 'full view after reload');
    assert.equal(await b.evaluate(FOCUSED('drawer-back')), true);
    const depth = await b.evaluate<number>('()=>history.length');
    await click('.drawer-back');
    await until(async () => !await isFull(), 5000, 'drawer');
    assert.equal(await b.evaluate('()=>location.hash'), drawerHash);
    assert.equal(await b.evaluate('()=>history.length'), depth, 'a deep-linked full view replaces itself rather than adding a step');
    assert.equal(await b.evaluate(FOCUSED('drawer-expand')), true);
  });

  await t.test('Expand from a check log, and browser Back returns to the drawer at its scroll position', async () => {
    const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    const e = await (await fetch(`${s.url}/api/${version}/arcs/${f.arc}/units/u1?section=invocations`)).json() as { data: { invocations: { rows: { kind: string; unit: string; routeId: string }[] } } };
    const command = e.data.invocations.rows.find(a => a.kind === 'deterministic' && a.unit === 'u1')!;
    writeFileSync(`${f.runDir}/inv/${command.routeId}/stdout`, Array.from({ length: 200 }, (_, n) => `check line ${n}: ${'recorded check output that runs well past the drawer width '.repeat(4)}`).join('\n') + '\n');
    const hash = `#/arcs/${f.arc}/graph/invocations/${command.routeId}`;
    await b.call('browser_navigate', { url: `${s.url}/${hash}` });
    await until(async () => /First output on this page/.test(await text()) && /check line 199/.test(await text()), 10_000, 'check log');
    await b.evaluate('()=>{document.querySelector(".drawer-body").scrollTop=900;return true;}');
    await until(() => b.evaluate<boolean>('()=>Math.round(document.querySelector(".drawer-body").scrollTop)===900'), 5000, 'scrolled check log');
    await click('.drawer-expand'); await until(isFull, 5000, 'full check log');
    assert.equal(await b.evaluate('()=>location.hash'), `${hash}/log`);
    assert.ok(await b.evaluate<boolean>('()=>document.querySelector(".drawer-full .record").getBoundingClientRect().width>innerWidth*0.9'), 'the log uses the page width');
    assert.match(await text(), /check line 199/);
    await b.call('browser_take_screenshot', { type: 'png', filename: `${evidence}/full-check.png`, fullPage: false });
    await b.call('browser_navigate_back', {});
    await until(async () => !await isFull(), 5000, 'drawer after browser Back');
    assert.equal(await b.evaluate('()=>location.hash'), hash);
    assert.equal(await b.evaluate('()=>Math.round(document.querySelector(".drawer-body").scrollTop)'), 900);
    assert.equal(await b.evaluate(FOCUSED('drawer-expand')), true);
  });
});
