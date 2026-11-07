import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { serveConsole } from '../../src/console/http.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { documentsXml } from '../../src/prompts/inputs.ts';
import { consoleAgentFixture } from '../fixtures/console-agent.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

test('native history has a safe structured brief, compact tools, closed unforeseen payloads and one verdict', { timeout: 120_000 }, async t => {
  const prompt = `<mode>pre-build</mode>\n${documentsXml([{ source: 'architecture doc ARCHITECTURE.md', content: '# Architecture\n\n- First item\n- Second item\n\n```js\nconst ready = true;\n```\n\n<script>window.agentlogExecuted=true</script>\n' + 'Long paragraph. '.repeat(180) }, { source: 'spec.json u3 rev 1', content: '## Acceptance\n\nInspect **the change** and `src/main.ts:12`.' }])}\n<intent>Review the implementation.</intent>\nReturn the report.`;
  const evidence = tmpDir('console-agentlog-browser');
  const f = await consoleAgentFixture(undefined, prompt), b = new ConsoleBrowser(evidence);
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  t.after(async () => { await b.close(); await s.close(); f.close(); });
  const emit = (value: unknown) => appendFileSync(f.transcript, JSON.stringify(value) + '\n');
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 });
  emit({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', decision_reason: 'Outside allowed working directories' });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'src/main.ts', old_string: 'return false;', new_string: 'return true;' } }] } });
  await b.initialize(); await b.call('browser_navigate', { url: `${s.url}/#/arcs/${f.arc}/graph/invocations/${f.routeId}` });
  const text = () => b.evaluate<string>('() => document.body.innerText');
  const wait = (pattern: RegExp) => until(async () => pattern.test(await text()), 12_000, pattern.source);
  await wait(/Agent is working/); await wait(/Outside allowed working directories/);
  const shots = '/tmp/claude-1000/-workspaces-roadmap-orchestration/3acd3311-8eb9-44be-8704-d39a10a293c6/scratchpad/webui/agentlog2';
  mkdirSync(shots, { recursive: true });
  await b.call('browser_take_screenshot', { type: 'png', filename: evidence + '/live.png', fullPage: false });
  copyFileSync(evidence + '/live.png', shots + '/live-tail.png');
  assert.doesNotMatch(await text(), /Unknown|estimated_tokens|"file_path"|<script>/);
  assert.equal(await b.evaluate('() => document.querySelector(".history-unforeseen details").open'), false);
  assert.match(await b.evaluate<string>('() => document.querySelector(".history-diff").textContent'), /- return false;\n\+ return true;/);
  assert.match(await text(), /Read\s+src\/main.ts/); assert.match(await text(), /Exit code 1/);
  await b.evaluate('() => { document.querySelector(".history-brief").open=true; return true; }');
  await wait(/Mode: Pre build/);
  assert.equal(await b.evaluate('() => document.querySelector(".history-document").open'), false);
  await b.evaluate('() => { document.querySelector(".history-document").open=true; return true; }');
  await wait(/First item/);
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-document li").length'), 2);
  assert.equal(await b.evaluate('() => document.querySelector(".history-document pre code").textContent'), 'const ready = true;');
  assert.equal(await b.evaluate('() => Boolean(window.agentlogExecuted || document.querySelector(".history-brief script"))'), false);
  assert.doesNotMatch(await b.evaluate<string>('() => document.querySelector(".history-seat-brief").textContent'), /<documents>|<document_content>|<intent>/);
  await b.evaluate('() => { document.querySelector(".history-brief").open=false; return true; }');
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'long-command', input: { command: 'printf recorded-evidence; '.repeat(200) } }] } });
  await wait(/Expand full input/);
  await until(async()=>await b.evaluate('() => !document.querySelector(".history-scroll").innerText.includes("Reading recorded tool input")'),12000,'native long command input');
  assert.equal(await b.evaluate('() => { const caret=document.querySelector(".history-live").getBoundingClientRect(); const scroller=document.querySelector(".history-scroll").getBoundingClientRect(); return caret.bottom<=scroller.bottom && caret.top>=scroller.top; }'),true,'async native input keeps the live caret in view');
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', id: 'invalid-report', input: { decision: 'approve' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'invalid-report', is_error: true, content: 'Missing required reasons.' }] } });
  await wait(/Report rejected/); await wait(/Missing required reasons/);
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-verdict").length'), 0);
  const report = { decision: 'approve', reasons: ['A single canonical reason with **readable emphasis**.'], findings: [{ severity: 'note', path: 'src/main.ts', text: 'A concrete finding.', evidence: ['src/main.ts:12'], experiments: [] }], premises: [{ claim: 'The source implements the contract.', evidence: [{ path: 'src/main.ts', line: 12 }] }], rulings: [], standing: [], directives: [], ordering: null, clusters: null };
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', id: 'report', input: report }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'report', content: 'Successfully returned structured output.' }] } });
  await wait(/A single canonical reason/);
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-verdict").length'), 1);
  f.finish(report); await wait(/Finished/);
  await until(async () => await b.evaluate('() => document.querySelector(".history-status")?.textContent === "Approve"'), 12_000, 'verified verdict');
  assert.equal(await b.evaluate('() => { const card=document.querySelector(".history-verdict").getBoundingClientRect(); const scroller=document.querySelector(".history-scroll").getBoundingClientRect(); return card.top>=scroller.top-1 && card.top<scroller.top+30; }'),true,'finished report opens at its verdict and reasons');
  const log = await b.evaluate<string>('() => document.querySelector(".history-scroll").innerText');
  assert.equal(log.split('A single canonical reason').length - 1, 1);
  assert.equal(await b.evaluate('() => [...document.querySelectorAll(".history-verdict-section")].find(s=>s.querySelector("h4")?.textContent==="Findings").querySelector("dt").textContent'), 'Text', 'finding prose precedes schema metadata');
  assert.match(log, /src\/main.ts:12/); assert.doesNotMatch(log, /none recorded|Decision: approve|Successfully returned|Verified the change/);
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-empty").length'), 1);
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-live").length'), 0);
  assert.equal(await b.evaluate('() => [...document.querySelectorAll("details")].find(d=>d.querySelector("summary")?.textContent==="Raw result.json").open'), false);
  await b.evaluate('() => { [...document.querySelectorAll("summary")].find(s=>s.textContent==="Raw result.json").parentElement.open=true;return true; }');
  const raw = await b.evaluate<string>('() => [...document.querySelectorAll("details")].find(d=>d.querySelector("summary")?.textContent==="Raw result.json").querySelector("pre").textContent');
  assert.ok(raw.includes('\n  "')); assert.deepEqual(JSON.parse(raw).outcome.value, report);
});

test('all surveyed report families render as lists and evidence with empty fields omitted', { timeout: 120_000 }, async t => {
  const b = new ConsoleBrowser(tmpDir('console-agentlog-schemas')); await b.initialize(); t.after(() => b.close());
  const reports = [
    { name: 'build', value: { summary: 'Implemented the requested change.', grounding: { specWrong: null, touches: ['src/main.ts'] }, experiments: [{ name: 'targeted check', argv: ['node', '--test', 'test/main.test.ts'], exit: 0 }], blockers: [], notes: [], tooBig: null, final: true }, status: 'Report complete', phrase: 'Implemented the requested change.' },
    { name: 'campaign audit', value: { findings: [], premises: [{ claim: 'The audit covers the changed code.', evidence: [{ path: 'src/main.ts', line: 12 }] }], reasons: ['All obligations have witnesses.'], requests: [] }, status: 'Report recorded', phrase: 'All obligations have witnesses.' },
    { name: 'pack review', value: { findings: [{ severity: 'note', target: { type: 'unit', id: 'u3' }, claim: 'Add another concrete witness.', evidence: [{ path: 'spec.json', line: 8 }] }], dispositions: [], reasons: ['The pack can run as written.'], premises: [] }, status: 'Report recorded', phrase: 'Add another concrete witness.' },
    { name: 'experience polish', value: { final: true, mode: 'polish', verdict: { final: true, decision: 'keep', evidence: ['screens/page.png'], reasons: ['The control is readable.'], premises: [] } }, status: 'Keep', phrase: 'The control is readable.' },
    { name: 'experience walkthrough', value: { final: true, mode: 'walkthrough', verdict: { final: true, premises: [], reasons: [], journeys: [{ journey: 'J-1', outcome: 'completed', evidence: ['screens/page.png'], note: 'The journey reaches its goal.' }], findings: [], polish: [] } }, status: 'Report complete', phrase: 'The journey reaches its goal.' },
  ];
  for (const row of reports) await t.test(row.name, async () => {
    const f = await consoleAgentFixture(); f.finish(row.value);
    const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
    try {
      await b.call('browser_navigate', { url: `${s.url}/#/arcs/${f.arc}/graph/invocations/${f.routeId}` });
      await until(async () => (await b.evaluate<string>('() => document.querySelector(".history-verdict")?.innerText||""')).includes(row.phrase), 12_000, row.name);
      assert.equal(await b.evaluate('() => document.querySelector(".history-status").textContent'), row.status);
      const report = await b.evaluate<string>('() => document.querySelector(".history-verdict").innerText');
      assert.doesNotMatch(report, /none recorded|Spec wrong|Too big\s*\n/);
      assert.equal(await b.evaluate('() => document.querySelectorAll(".history-verdict").length'), 1);
      assert.ok(await b.evaluate('() => document.querySelectorAll(".history-verdict li").length > 0'));
    } finally { await s.close(); f.close(); }
  });
});
