// Real vendored UI, Chromium and MCP stdio, exactly as walk-browser.test.ts. Serial tier: one real browser.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { invocationIdOf } from '../../src/core/ids.ts';
import { enrichedParityArc } from '../fixtures/status-parity.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

const SHOTS = '/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/shots';
const FORBIDDEN = /atlas|AtlasGlyph|AutonomousOrbit|Starfield|TransitMoment/i;
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('console browser: vendored overview/detail, accessible names, keyboard, inert evidence, narrow screen, stale/reconnect', { timeout: 120_000 }, async (t) => {
  const f = await enrichedParityArc();
  const args = { repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 };
  let server = await serveConsole(args);
  const evidence = tmpDir('console-browser');
  const browser = new ConsoleBrowser(evidence);
  t.after(async () => { await browser.close(); await server.close(); });
  mkdirSync(SHOTS, { recursive: true });
  await browser.initialize();
  const tools = await browser.request('tools/list', {}) as { tools: { name: string }[] };
  assert.ok(tools.tools.some((v) => v.name === 'browser_evaluate'));
  await browser.call('browser_navigate', { url: server.url });
  const text = () => browser.evaluate<string>('() => document.body.innerText');
  await until(async () => /Connected/.test(await text()), 20_000, 'verified console overview');

  async function brandAudit(name: string) {
    const dom = await browser.evaluate<{ title: string; text: string; names: string[]; brands: number }>(`() => ({ title: document.title, text: document.body.textContent,
      names: [...document.querySelectorAll('[aria-label], [alt], [title]')].flatMap(e => ['aria-label','alt','title'].map(k => e.getAttribute(k) || '')),
      brands: document.querySelectorAll('.atlas-mark,.atlas-glyph,.atlas-orbit,.atlas-starfield,.atlas-transit,[data-atlas-glyph]').length })`);
    assert.equal(dom.title, 'Roadmap'); assert.doesNotMatch(dom.text, FORBIDDEN); assert.doesNotMatch(dom.names.join('\n'), FORBIDDEN); assert.equal(dom.brands, 0);
    const accessible = await browser.accessibleSnapshot(join(evidence, `${name}.yml`));
    assert.doesNotMatch(accessible, FORBIDDEN, 'real accessible names exclude all supplied branding');
    return dom;
  }
  await brandAudit('overview');
  assert.match(await text(), /Applied work/); assert.match(await text(), /milestone gate/i);
  await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'overview.png'), fullPage: true });
  copyFileSync(join(evidence, 'overview.png'), join(SHOTS, 'overview.png'));

  // Use actual keyboard activation. Escape must close and restore the invoking control.
  await browser.evaluate('() => { const b = document.querySelector("[aria-label=\\"Open u1 details\\"]"); b.focus(); return document.activeElement.getAttribute("aria-label"); }');
  await browser.call('browser_press_key', { key: 'Enter' });
  await until(async () => /Lane certification/.test(await text()), 10_000, 'deep-linked unit detail');
  await until(async () => /Readable records/.test(await text()) && !/Reading unit records/.test(await text()), 10_000, 'unit detail records');
  const dialog = await browser.evaluate<{ title: string; role: string; focus: string; url: string }>('() => ({ title: document.querySelector("#detail-title").textContent, role: document.activeElement.closest("[role=dialog]").getAttribute("role"), focus: document.activeElement.getAttribute("aria-label"), url: location.hash })');
  assert.equal(dialog.title, 'Unit u1'); assert.equal(dialog.role, 'dialog'); assert.equal(dialog.focus, 'Close details'); assert.match(dialog.url, /units\/u1/);
  await brandAudit('unit-detail');
  await browser.call('browser_take_screenshot', { type: 'png', filename: join(evidence, 'unit-detail.png'), fullPage: false });
  copyFileSync(join(evidence, 'unit-detail.png'), join(SHOTS, 'unit-detail.png'));
  await browser.call('browser_press_key', { key: 'Shift+Tab' });
  assert.equal(await browser.evaluate<boolean>('() => Boolean(document.activeElement.closest("[role=dialog]"))'), true);
  await browser.call('browser_press_key', { key: 'Escape' });
  assert.equal(await browser.evaluate<string>('() => document.activeElement.getAttribute("aria-label")'), 'Open u1 details');

  // Open a retained invocation's real stdout. HTML-like evidence remains plain text, with no invented line timestamps.
  const inv = (await browser.evaluate<{ invocations: { id: string; unit: string }[] }>(`async () => { const r = await fetch('/api/${JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}/runs/${f.d.arc}/snapshot'); return (await r.json()).data.display; }`)).invocations.find((v) => v.unit === 'u1')!;
  const dir = invocationDir(f.runDir, invocationIdOf(inv.id)); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout'), '<img src=x onerror="window.consoleEvidenceExecuted=true">\nRecorded lane output\n');
  const routeId = inv.id.split('/')[1]!.replace('#', '-');
  await browser.evaluate(`() => { location.hash = '#/runs/${f.d.arc}/overview/invocations/${routeId}'; return true; }`);
  await until(async () => Boolean(await browser.evaluate('() => document.querySelector("[role=dialog] section[aria-label] button[aria-expanded]") !== null')), 10_000, 'recorded log phase');
  await browser.evaluate('() => { document.querySelector("[role=dialog] section[aria-label] button[aria-expanded]").click(); return true; }');
  await until(async () => /Recorded lane output/.test(await text()), 10_000, 'recorded log content');
  assert.equal(await browser.evaluate<boolean>('() => Boolean(window.consoleEvidenceExecuted || document.querySelector("[role=dialog] img"))'), false);
  assert.match(await text(), /timestamps and levels are not inferred/);
  await brandAudit('log');
  await browser.call('browser_press_key', { key: 'Escape' });

  await browser.evaluate(`() => { location.hash = '#/runs/${f.d.arc}/attention'; return true; }`);
  await until(async () => /Nonblocking/.test(await text()), 10_000, 'nonblocking attention');
  assert.match(await text(), /Review the plan/);
  await brandAudit('attention');
  await browser.evaluate(`() => { location.hash = '#/runs/${f.d.arc}/resources'; return true; }`);
  await until(async () => /Measured cores/i.test(await text()), 10_000, 'CPU and time evidence');
  await brandAudit('resources');
  assert.doesNotMatch(await text(), /peak 0|0% utilization/i);
  await browser.call('browser_resize', { width: 390, height: 844 });
  await browser.evaluate(`() => { location.hash = '#/runs/${f.d.arc}/overview'; return true; }`);
  await until(async () => /Applied work/.test(await text()), 10_000, 'narrow overview');
  assert.equal(await browser.evaluate<boolean>('() => document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
  assert.equal(await browser.evaluate<boolean>('() => [...document.querySelectorAll(".unit-list a")].some(e => e.getClientRects().length)'), true, 'narrow graph has keyboard-accessible record alternatives');
  await brandAudit('narrow');

  const port = (server.server.address() as AddressInfo).port;
  await server.close();
  await until(async () => /Disconnected\/stale/.test(await text()), 15_000, 'unverified connection becomes stale');
  const stale = await browser.evaluate<string>('() => document.querySelector("main").textContent');
  assert.match(await text(), /Observed 20/);
  await new Promise((r) => setTimeout(r, 1_100));
  assert.equal(await browser.evaluate<string>('() => document.querySelector("main").textContent'), stale, 'stale content and counters remain frozen');
  server = await serveConsole({ ...args, port });
  await until(async () => /Connected/.test(await text()) && !/Disconnected\/stale/.test(await text()), 20_000, 'SSE reconnect and fresh journal epoch');
  await brandAudit('reconnected');
  for (const name of ['overview.png', 'unit-detail.png']) assert.deepEqual(readFileSync(join(SHOTS, name)).subarray(0, 8), MAGIC);
});
