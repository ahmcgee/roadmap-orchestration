// Real vendored UI, Chromium and MCP stdio, exactly as walk-browser.test.ts. Serial tier: one real browser.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { invocationIdOf } from '../../src/core/ids.ts';
import { enrichedParityArc } from '../fixtures/status-parity.ts';
import { consoleAgentFixture } from '../fixtures/console-agent.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

const SHOTS = '/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots';
const FORBIDDEN = /atlas|AtlasGlyph|AutonomousOrbit|Starfield|TransitMoment/i;
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// These sections deliberately share one browser/document and run in order. Fixture setup is
// charged to the first section; the three deadlines retain the original 120-second total.
describe('console browser', { concurrency: false }, () => {
  let f: Awaited<ReturnType<typeof enrichedParityArc>>;
  let args: Parameters<typeof serveConsole>[0];
  let server: Awaited<ReturnType<typeof serveConsole>>;
  let evidence: string;
  let browser: ConsoleBrowser;
  let agent: Awaited<ReturnType<typeof consoleAgentFixture>> | undefined;
  const text = () => browser.evaluate<string>('() => document.body.innerText');
  after(async () => { await browser?.close(); await server?.close(); agent?.close(); });

  async function brandAudit(name: string) {
    const dom = await browser.evaluate<{ title: string; text: string; names: string[]; brands: number }>(`() => ({ title: document.title, text: document.body.innerText,
      names: [...document.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.name+'='+a.value)),
      brands: document.querySelectorAll('.atlas-mark,.atlas-glyph,.atlas-orbit,.atlas-starfield,.atlas-transit,[data-atlas-glyph]').length })`);
    assert.equal(dom.title, 'Roadmap'); assert.doesNotMatch(dom.text, FORBIDDEN); assert.doesNotMatch(dom.names.join('\n'), FORBIDDEN); assert.equal(dom.brands, 0);
    const accessible = await browser.accessibleSnapshot(join(evidence, `${name}.yml`));
    assert.doesNotMatch(accessible, FORBIDDEN, 'real accessible names exclude all supplied branding');
    return dom;
  }

  test('vendored overview/detail, accessible names, keyboard, inert evidence, narrow screen', { timeout: 45_000 }, async () => {
    f = await enrichedParityArc();
    args = { repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 };
    server = await serveConsole(args);
    evidence = tmpDir('console-browser');
    // Explicit DOM polls below own readiness; MCP's default 500 ms delay on every read
    // otherwise consumes nearly all of the walk's budget, and doubles when a poll fetch overlaps.
    browser = new ConsoleBrowser(evidence, { settleMs: 100 });
    mkdirSync(SHOTS, { recursive: true });
    await browser.initialize();
    const tools = await browser.request('tools/list', {}) as { tools: { name: string }[] };
    assert.ok(tools.tools.some((v) => v.name === 'browser_evaluate'));
    await browser.call('browser_navigate', { url: server.url });
    await until(async () => /Connected/.test(await text()), 20_000, 'verified console overview');

    for(const tab of ['graph','timeline','activity','effort','resources','attention']){
      await browser.evaluate(`()=>{location.hash='#/arcs/${f.d.arc}/${tab}';return true;}`);
      await until(async()=>await browser.evaluate(`()=>document.querySelector('.tabs [aria-current]')?.textContent.startsWith('${tab[0]!.toUpperCase()+tab.slice(1)}')`),5000,`${tab} visible`);
      await brandAudit(tab);
    }
    await browser.evaluate(`()=>{location.hash='#/arcs/${f.d.arc}/graph';return true;}`);
    await until(async()=>await browser.evaluate('()=>!!document.querySelector(".dag-canvas canvas")'),5000,'return to graph');
    await brandAudit('overview');
    assert.equal(await browser.evaluate('()=>typeof window.React'), 'undefined');
    assert.ok(await browser.evaluate<number>('() => document.querySelectorAll(".progress-strip > span").length') > 0);
    assert.equal(await browser.evaluate('() => document.querySelectorAll(".dag-canvas canvas").length > 0'), true); assert.match(await browser.evaluate<string>('() => document.querySelector(".line-map").getAttribute("aria-label")'), /Milestone/);
    await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'overview.png'), fullPage: true });
    copyFileSync(join(evidence, 'overview.png'), join(SHOTS, 'overview.png'));

    // Use actual keyboard activation. Escape must close and restore the invoking control.
    await browser.openUnit('u1');
    await until(async () => /Journey/.test(await text()), 10_000, 'deep-linked unit detail');
    await until(async () => /Acceptance/.test(await text()) && !/Reading unit records/.test(await text()), 10_000, 'unit detail records');
    const dialog = await browser.evaluate<{ title: string; role: string; focus: string; url: string }>('() => ({ title: document.querySelector("#detail-title").textContent, role: document.activeElement.closest("[role=dialog]").getAttribute("role"), focus: document.activeElement.getAttribute("aria-label"), url: location.hash })');
    assert.equal(dialog.title, 'Implement the stated acceptance'); assert.equal(await browser.evaluate<string>('() => document.querySelector(".unit-meta > span").textContent'), 'u1'); assert.equal(dialog.role, 'dialog'); assert.equal(dialog.focus, 'Close details'); assert.match(dialog.url, /units\/u1/);
    await brandAudit('unit-detail');
    await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'unit-detail.png'), fullPage: false });
    copyFileSync(join(evidence, 'unit-detail.png'), join(SHOTS, 'unit-detail.png'));
    await browser.call('browser_press_key', { key: 'Shift+Tab' });
    assert.equal(await browser.evaluate<boolean>('() => document.querySelector("main").inert'), false, 'non-modal drawer keeps the graph interactive');
    await browser.call('browser_press_key', { key: 'Escape' });
    await until(async () => await browser.evaluate('() => !document.querySelector(".drawer") && document.activeElement.getAttribute("aria-label")?.includes("Unit dependency graph")'), 5000, 'drawer closes and restores graph focus');
    assert.match(await browser.evaluate<string>('() => document.activeElement.getAttribute("aria-label")'), /Unit dependency graph/);

    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/graph/units/u3'; return true; }`);
    await until(async () => await browser.evaluate('() => document.querySelector(".unit-meta > span")?.textContent === "u3"'), 10_000, 'empty unit detail');
    assert.match(await browser.evaluate<string>('() => document.querySelector("[role=dialog]").textContent'), /No stage attempts recorded yet/);
    assert.equal(await browser.evaluate<number>('() => document.querySelectorAll("[role=dialog] .recorded-effort").length'), 0);
    await browser.call('browser_press_key', { key: 'Escape' });

    // Open a retained invocation's real stdout. HTML-like evidence remains plain text, with no invented line timestamps.
    const inv = (await browser.evaluate<{ id: string; unit: string }[]>(`async () => { const r = await fetch('/api/${JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}/arcs/${f.d.arc}/units/u1?section=invocations'); return (await r.json()).data.invocations.rows; }`)).find(v => v.unit === 'u1')!;
    const dir = invocationDir(f.runDir, invocationIdOf(inv.id)); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stdout'), '<img src=x onerror="window.consoleEvidenceExecuted=true">\nRecorded lane output\n');
    const routeId = inv.id.split('/')[1]!.replace('#', '-');
    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/graph/invocations/${routeId}'; return true; }`);
    await until(async () => Boolean(await browser.evaluate('() => document.querySelector("[role=dialog] .record") !== null')), 10_000, 'recorded log phase');
    await browser.evaluate('() => { document.querySelector("[role=dialog] .record").focus(); return true; }');
    await until(async () => /Recorded lane output/.test(await text()), 10_000, 'recorded log content');
    assert.equal(await browser.evaluate<boolean>('() => Boolean(window.consoleEvidenceExecuted || document.querySelector("[role=dialog] img"))'), false);
    assert.match(await text(), /timestamps and levels are not inferred/);
    await brandAudit('log');
    await browser.call('browser_press_key', { key: 'Escape' });

    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/attention'; return true; }`);
    await until(async () => /For your information/.test(await text()), 10_000, 'nonblocking attention');
    assert.match(await text(), /Review the plan/);
    await browser.evaluate('() => { document.querySelector(".request-link").click(); return true; }');
    await until(async () => /After reviewing/.test(await text()), 10_000, 'selected request recommendation');
    assert.equal(await browser.evaluate<boolean>('() => [...document.querySelectorAll(".owner-notice > p")].some(p => p.textContent.startsWith("After reviewing"))'), true, 'automatic follow-up is its own paragraph');
    await brandAudit('attention');
    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/resources'; return true; }`);
    await until(async () => /CPU evidence/i.test(await text()), 10_000, 'CPU and time evidence');
    await brandAudit('resources');
    assert.doesNotMatch(await text(), /peak 0|0% utilization/i);
    await browser.call('browser_resize', { width: 390, height: 844 });
    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/graph'; return true; }`);
    await until(async () => await browser.evaluate('() => document.querySelector(".dag-canvas").getBoundingClientRect().height > 100'), 10_000, 'narrow graph');
    assert.equal(await browser.evaluate<boolean>('() => document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
    assert.equal(await browser.evaluate<boolean>('() => document.querySelector(".dag-canvas").tabIndex === 0 && Boolean(document.querySelector(".search-toggle").getClientRects().length)'), true, 'narrow graph has an expandable keyboard-accessible search');
    await browser.call('browser_press_key',{key:'/'});
    await until(async()=>await browser.evaluate('()=>document.activeElement.getAttribute("aria-label")=="Search units"'),5000,'expanded phone search takes focus');
    assert.equal(await browser.evaluate('()=>document.activeElement.getAttribute("aria-label")'), 'Search units');
    assert.equal(await browser.evaluate('()=>document.querySelector(".graph-search input").getClientRects().length>0'),true);
    await browser.call('browser_press_key',{key:'Escape'});
    await brandAudit('narrow');
  });

  test('live AgentHistory, paging, finished history', { timeout: 55_000 }, async () => {
    // Real owner/launch records and scripted stream bytes: no external backend is run.
    agent = await consoleAgentFixture(f);
    await browser.call('browser_resize', { width: 1280, height: 1000 });
    await browser.evaluate(`() => { location.hash = '#/arcs/${f.d.arc}/graph/units/u3'; return true; }`);
    await until(async () => /Build/.test(await text()) && await browser.evaluate<boolean>('() => [...document.querySelectorAll("[role=dialog] a")].some(b => /history/i.test(b.textContent))'), 10_000, 'active agentic activity');
    await browser.evaluate('() => { [...document.querySelectorAll("[role=dialog] a")].find(b => /history/i.test(b.textContent)).click(); return true; }');
    await until(async () => /Build, attempt 1/.test(await text()) && /Agent is working/.test(await text()), 10_000, 'live AgentHistory');
    assert.match(await browser.evaluate<string>('() => location.hash'), new RegExp(`invocations/${agent.routeId}`));
    assert.equal(await browser.evaluate<boolean>('() => document.querySelector(".history-brief").open'), false, 'brief is collapsed by default');
    assert.doesNotMatch(await browser.evaluate<string>('() => document.querySelector(".history-scroll").textContent'), /\"tool_use\"/);
    assert.equal(await browser.evaluate<number>('() => document.querySelectorAll(".history-scroll script, .history-scroll img").length'), 0);
    assert.match(await browser.evaluate<string>('()=>document.querySelector(".history-boundary").textContent'),/events loaded/);
    assert.doesNotMatch(await browser.evaluate<string>('()=>document.querySelector(".history-boundary").textContent'),/of [0-9]/,'unknown session totals are not invented');
    assert.equal(await browser.evaluate(`()=>{const d=document.querySelector('.thinking-disclosure');return d.querySelector('button').getAttribute('aria-expanded')==='false'&&getComputedStyle(d.querySelector('.thinking-preview')).webkitLineClamp==='3';}`),true,'Thinking starts with a three-line disclosure');
    await browser.evaluate(`()=>{document.querySelector('.thinking-disclosure button').click();return true;}`);
    assert.equal(await browser.evaluate(`()=>document.querySelector('.thinking-disclosure button').getAttribute('aria-expanded')`),'true');
    assert.match(await browser.evaluate<string>(`()=>document.querySelector('.thinking-disclosure').textContent`),/I’ll inspect the implementation before changing it/);
    await browser.evaluate(`()=>{document.querySelector('.thinking-disclosure button').click();return true;}`);
    assert.match(await text(), /Show output/); assert.match(await text(), /Exit code 1/); assert.match(await text(), /Subagent of agent_1/);
    await browser.evaluate('() => { document.querySelector(".session-details").open = true; return true; }');
    assert.match(await text(), /claude-sonnet-4-5/); assert.match(await text(), /52 recorded tokens/);
    await browser.evaluate('() => { document.querySelector(".history-brief").open = true; return true; }');
    assert.match(await text(), /Implement the unit contract/);
    await browser.evaluate('() => { document.querySelector(".history-brief").open = false; document.querySelector(".session-details").open = false; window.historyDocumentSentinel = "same document"; return true; }');
    agent.append('Live streamed message arrived without a reload.');
    await until(async () => /Live streamed message arrived without a reload/.test(await text()), 10_000, 'SSE appends a visible agent event');
    assert.equal(await browser.evaluate<string>('() => window.historyDocumentSentinel'), 'same document');
    await brandAudit('live-history');
    await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'agent-history-live.png'), fullPage: false });
    copyFileSync(join(evidence, 'agent-history-live.png'), join(SHOTS, 'agent-history-live.png'));
    for (let n = 0; n < 60; n++) agent.append(`Paged agent event ${n}`);
    await until(async () => /Paged agent event 59/.test(await text()), 10_000, 'more than one history page');
    await browser.evaluate('() => { [...document.querySelectorAll("button")].find(b => b.textContent === "Following live").click(); return true; }');
    await until(async () => /Load 50 earlier events/.test(await text()), 10_000, 'bounded latest history page');
    await browser.evaluate('() => { const s=document.querySelector(".history-scroll"),top=s.getBoundingClientRect().top,n=[...s.querySelectorAll("[data-event-id]")].find(n=>!n.closest("details:not([open])")&&n.getBoundingClientRect().height>0&&n.getBoundingClientRect().bottom>top); window.pagingAnchor={id:n.dataset.eventId,offset:n.getBoundingClientRect().top-top}; [...document.querySelectorAll("button")].find(b => b.textContent === "Load 50 earlier events").click(); return true; }');
    await until(async () => /I’ll inspect the implementation/.test(await text()), 10_000, 'earlier history page');
    assert.equal(await browser.evaluate('()=>{const s=document.querySelector(".history-scroll"),a=window.pagingAnchor,n=[...s.querySelectorAll("[data-event-id]")].find(n=>n.dataset.eventId===a.id);return Math.abs(n.getBoundingClientRect().top-s.getBoundingClientRect().top-a.offset)<1;}'),true,"loading earlier history preserves the visible event position");
    await browser.evaluate('() => { [...document.querySelectorAll("button")].find(b => b.textContent.startsWith("Follow live tail")).click(); return true; }');
    agent.append('Long evidence with explicit expansion. '.repeat(500));
    await until(async () => /Expand full text/.test(await text()), 10_000, 'explicit truncation control');
    await browser.evaluate('() => { document.querySelector(".history-expansion").open = true; return true; }');
    await until(async () => /Next text page/.test(await text()), 10_000, 'bounded expansion page');
    await browser.evaluate('() => { document.querySelector(".history-scroll").scrollTop = 0; return true; }');
    await until(async () => /Follow live tail/.test(await text()), 5000, 'reader pauses following');
    agent.append('Queued while the reader is scrolled up.');
    await until(async () => /Follow live tail \(1 update\)/.test(await text()), 10_000, 'paused reader receives update count');
    assert.doesNotMatch(await browser.evaluate<string>('() => document.querySelector(".history-scroll").textContent'), /Queued while the reader/);
    assert.equal(await browser.evaluate('()=>document.querySelector(".history-scroll").scrollTop'),0,'live updates preserve the paused reading position');
    await browser.evaluate('() => { [...document.querySelectorAll("button")].find(b => b.textContent.startsWith("Follow live tail")).click(); return true; }');
    await until(async () => /Queued while the reader/.test(await text()), 10_000, 'resume tail');
    await browser.evaluate('() => { document.querySelectorAll(".history-expansion").forEach(el => el.open = false); return true; }');
    agent.finish();
    await until(async () => /Finished/.test(await text()) && /Verified the change/.test(await text()) && !/Agent is working/.test(await text()), 10_000, 'history settles without reload');
    assert.equal(await browser.evaluate<string>('() => window.historyDocumentSentinel'), 'same document');
    await browser.evaluate('() => { document.querySelector(".history-scroll").scrollTop = document.querySelector(".history-scroll").scrollHeight; return true; }');
    await brandAudit('finished-history');
    await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'agent-history-finished.png'), fullPage: false });
    copyFileSync(join(evidence, 'agent-history-finished.png'), join(SHOTS, 'agent-history-finished.png'));
    assert.equal(await browser.evaluate('() => document.querySelectorAll(".history-verdict").length'), 1, 'one canonical report');
    await browser.evaluate('() => { document.querySelector(".session-details").open = true; [...document.querySelectorAll("summary")].find(s => s.textContent === "Raw result.json").parentElement.open = true; return true; }');
    await until(async () => /Verified the change/.test(await browser.evaluate<string>('() => [...document.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Raw result.json")?.querySelector("pre")?.textContent || ""')), 10_000, 'pretty printed raw result disclosure');
    assert.equal(await browser.evaluate('() => { const p=[...document.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Raw result.json").querySelector("pre"); return JSON.parse(p.textContent).outcome.value.summary; }'), 'Verified the change.');
    await browser.evaluate('() => { document.querySelector(".back-to-unit").click(); return true; }');
    await until(async () => await browser.evaluate('() => document.querySelector(".unit-meta > span")?.textContent === "u3"'), 10_000, 'back to unit activity');
    await browser.call('browser_press_key', { key: 'Escape' });
  });

  test('stale content, reconnect, screenshot evidence', { timeout: 20_000 }, async () => {
    const port = (server.server.address() as AddressInfo).port;
    await server.close();
    await until(async () => /Reconnecting/.test(await text()), 15_000, 'a lost connection is reconnecting');
    const stale = await browser.evaluate<string>('() => document.querySelector("main").textContent');
    assert.match(await text(), /Reconnecting\. Showing the arc as of \d+s ago\./);
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(await browser.evaluate<string>('() => document.querySelector("main").textContent'), stale, 'stale content and counters remain frozen');
    server = await serveConsole({ ...args, port });
    await until(async () => /Connected/.test(await text()) && !/Reconnecting/.test(await text()), 20_000, 'SSE reconnect and fresh journal epoch');
    await brandAudit('reconnected');
    for (const name of ['overview.png', 'unit-detail.png', 'agent-history-live.png', 'agent-history-finished.png']) assert.deepEqual(readFileSync(join(SHOTS, name)).subarray(0, 8), MAGIC);
  });
});
