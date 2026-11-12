import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { investigationFixture } from '../fixtures/console-investigations.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

// A finished build with a long history and a report whose prose carries Markdown and whose experiments are commands.
const report = {
  summary: 'Fixed the boundary case.\n\n**Cause:** the parser read `--limit` as a *flag* rather than a value.\n\n**Fix:** read the next argument.',
  experiments: [
    { name: 'confirm the parser reads the limit', argv: ['node', 'test/parse.test.ts', '--limit', '3'], exit: 0 },
    { name: 'run the whole suite against the base', argv: ['npm', 'test', '--', '--reporter', 'dot', ...Array.from({ length: 30 }, (_, n) => `test/case-${n}.test.ts`)], exit: 1 },
  ],
  notes: Array.from({ length: 12 }, (_, n) => `Note ${n}: **checked** the recorded output and the retained evidence.`),
};

test('full-page log: the log fills the page, the report has no floating heading, and agent Markdown renders', { timeout: 120_000 }, async t => {
  const f = await investigationFixture(14);
  for (let n = 0; n < 40; n++) f.live.append(`Recorded paragraph ${n}: **Cause:** the agent explains what it read and why it matters. `.repeat(4));
  f.live.finish(report);
  appendFileSync(f.live.transcript, JSON.stringify({ type: 'result', duration_ms: 1234, usage: { input_tokens: 1, output_tokens: 0 }, structured_output: report }) + '\n');
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  const b = new ConsoleBrowser(tmpDir('console-log-view-layout'));
  t.after(async () => { await b.close(); await s.close(); f.close(); });
  await b.initialize();
  const full = `${s.url}/#/arcs/${f.arc}/graph/invocations/${f.live.routeId}/log`;
  const open = async (theme: string) => {
    await b.call('browser_navigate', { url: 'about:blank' }); await b.call('browser_navigate', { url: full });
    await until(() => b.evaluate<boolean>('()=>!!document.querySelector(".drawer-full .history-verdict")&&!!document.querySelector(".drawer-full .history-scroll [data-event-id]")'), 12_000, 'finished history in the full view');
    await b.evaluate(`()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};return true;}`);
  };

  await t.test('the log starts near the top of the window and fills the rest of it', async () => {
    for (const [width, height] of [[1440, 1080], [1920, 1080]] as const) {
      await b.call('browser_resize', { width, height });
      await open('light');
      const box = await b.evaluate<{ top: number; bottom: number; first: number }>('()=>{const sc=document.querySelector(".history-scroll").getBoundingClientRect(),first=document.querySelector(".history-scroll [data-event-id]").getBoundingClientRect();return {top:sc.top,bottom:sc.bottom,first:first.top};}');
      assert.ok(box.top <= 120 && box.first <= 140, `log starts near the top at ${width}: ${JSON.stringify(box)}`);
      assert.ok(box.bottom >= height - 2, `log reaches the bottom at ${width}: ${JSON.stringify(box)}`);
      // Status stays on the compact line; the summary and the rest are one click away, not removed.
      assert.match(await b.evaluate<string>('()=>document.querySelector(".log-bar").innerText'), /Status\s+Finished/);
      assert.equal(await b.evaluate('()=>document.querySelector(".invocation-facts").getClientRects().length'), 0, 'details wait behind the disclosure');
      await b.evaluate('()=>{document.querySelector(".log-overview-toggle").click();return true;}');
      await until(() => b.evaluate<boolean>('()=>document.querySelector(".invocation-facts").getClientRects().length>0&&document.querySelector(".session-details").getClientRects().length>0'), 5000, 'summary and details shown');
      assert.match(await b.evaluate<string>('()=>document.querySelector(".invocation-summary").innerText'), /Fixed the boundary case/);
    }
  });

  await t.test('no heading in the history floats over the log, and the report heading never covers text, in either theme', async () => {
    await b.call('browser_resize', { width: 1440, height: 900 });
    for (const theme of ['light', 'dark']) {
      await open(theme);
      assert.deepEqual(await b.evaluate<string[]>('()=>[...document.querySelectorAll(".history-scroll *")].filter(e=>["sticky","fixed","absolute"].includes(getComputedStyle(e).position)).map(e=>e.className)'), [], 'nothing in the history is taken out of the flow');
      for (const frac of [0, 0.3, 0.6, 0.9, 1]) {
        await b.evaluate(`()=>{const sc=document.querySelector(".history-scroll");sc.scrollTop=(sc.scrollHeight-sc.clientHeight)*${frac};return true;}`);
        // Every text line under the report heading's box must be the heading itself: nothing else is painted beneath or beside it.
        const overlap = await b.evaluate<string[]>(`()=>{const head=document.querySelector(".history-verdict-head").getBoundingClientRect(),sc=document.querySelector(".history-scroll").getBoundingClientRect();
          if(head.bottom<sc.top||head.top>sc.bottom)return [];const out=[];const walk=document.createTreeWalker(document.querySelector(".history-scroll"),NodeFilter.SHOW_TEXT);
          for(let n=walk.nextNode();n;n=walk.nextNode()){if(!n.textContent.trim()||n.parentElement.closest(".history-verdict-head"))continue;const r=document.createRange();r.selectNodeContents(n);for(const box of r.getClientRects())if(box.bottom>head.top+1&&box.top<head.bottom-1&&box.bottom>sc.top&&box.top<sc.bottom)out.push(n.textContent.slice(0,40));}return out;}`);
        assert.deepEqual(overlap, [], `${theme} at ${frac}: text shares the report heading's band`);
      }
    }
  });

  await t.test('agent Markdown renders as formatting with no literal markers, in the log, the report and the summary', async () => {
    await open('light');
    await b.evaluate('()=>{document.querySelector(".log-overview-toggle").click();return true;}');
    const prose = await b.evaluate<{ stars: string[]; bold: string[]; weight: number; em: string[] }>('()=>{const md=[...document.querySelectorAll(".drawer .history-markdown")];const strong=document.querySelector(".history-verdict .history-markdown strong");return {stars:md.map(e=>e.innerText).filter(t=>t.includes("**")).map(t=>t.slice(0,60)),bold:[...document.querySelectorAll(".invocation-summary-text strong, .history-verdict strong")].map(e=>e.textContent),weight:Number(getComputedStyle(strong).fontWeight),em:[...document.querySelectorAll(".history-verdict em")].map(e=>e.textContent)};}');
    assert.deepEqual(prose.stars, [], 'no literal ** in rendered prose');
    assert.ok(prose.bold.includes('Cause:') && prose.bold.includes('Fix:') && prose.bold.includes('checked'), JSON.stringify(prose.bold));
    assert.ok(prose.weight >= 600, `bold renders bold: ${prose.weight}`);
    assert.deepEqual(prose.em, ['flag']);
    // Each command reads as one entry: its name and exit share a line, and every argument stays visible.
    const runs = await b.evaluate<{ head: string; command: string; sameLine: boolean }[]>('()=>[...document.querySelectorAll(".history-run")].map(r=>{const head=r.querySelector(".history-run-head"),spans=head.querySelectorAll("span");return {head:head.innerText.replace(/\\s+/g," "),command:r.querySelector("pre").innerText,sameLine:Math.abs(spans[0].getBoundingClientRect().top-spans[1].getBoundingClientRect().top)<4};})');
    assert.deepEqual(runs.map(r => r.head), ['confirm the parser reads the limit Exit 0', 'run the whole suite against the base Exit 1']);
    assert.ok(runs.every(r => r.sameLine));
    assert.equal(runs[1]!.command, report.experiments[1]!.argv.join(' '));
    assert.equal(await b.evaluate('()=>document.documentElement.scrollWidth<=innerWidth'), true);
  });
});
