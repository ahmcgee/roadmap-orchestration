import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { absPath } from '../src/core/values.ts';
import type { ConsoleHistories } from '../src/console/history.ts';
import type { consoleModel } from '../src/console/model.ts';
import type { Envelope } from '../src/observation/protocol.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleAgentFixture } from './fixtures/console-agent.ts';
import { until } from './fixtures/exec-common.ts';

test('active stage maps active; history SSE appends complete events, pairs tools, settles, resets and bounds expansion', { timeout: 30_000 }, async t => {
  const f = await consoleAgentFixture(); t.after(() => f.close());
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const snapshot = await (await fetch(`${base}/snapshot`)).json() as Envelope & { data: { console: ReturnType<typeof consoleModel> } };
  assert.equal(snapshot.data.display.status.units.find((u: { unit: string }) => u.unit === 'u3')!.state, 'running');
  assert.equal(snapshot.data.console.graph.units.find((u: { id: string }) => u.id === 'u3')!.status, 'active');
  assert.equal(snapshot.data.display.status.units.find((u: { unit: string }) => u.unit === 'u1')!.state, 'ready', 'completed lanes fixture is between stages');
  const promptResponse = await fetch(`${base}/invocations/${f.routeId}/prompt`); assert.equal(promptResponse.status, 200, 'retained brief route');
  const prompt = await promptResponse.json() as { data: ReturnType<ConsoleHistories['prompt']> }; assert.match(prompt.data.lines.join('\n'), /Implement the unit contract/);
  const invalid = await fetch(`${base}/invocations/${f.routeId}/history?before=not-a-cursor`); assert.equal(invalid.status, 400);
  const absent = await fetch(`${base}/events?invocation=999999-1`); assert.equal(absent.status, 404);
  const absentHead = await fetch(`${base}/events?invocation=999999-1`, { method: 'HEAD' }); assert.equal(absentHead.status, 404);
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${base}/events?invocation=${f.routeId}`, { signal: abort.signal });
  const reader = response.body!.getReader(); let carry = '';
  async function history() {
    for (;;) {
      const end = carry.indexOf('\n\n');
      if (end < 0) { const chunk = await reader.read(); assert.equal(chunk.done, false); carry += new TextDecoder().decode(chunk.value); continue; }
      const frame = carry.slice(0, end); carry = carry.slice(end + 2);
      assert.ok(Buffer.byteLength(frame) < 4096, 'SSE carries bounded notices');
      if (frame.includes('event: history\n')) {
        const notice = JSON.parse(/^data: (.+)$/m.exec(frame)![1]!); assert.equal(notice.events, undefined, 'history content travels over GET');
        const page = await (await fetch(`${base}/invocations/${f.routeId}/history`)).json() as { data: ReturnType<ConsoleHistories['page']> };
        return { ...notice, ...page.data, reset: notice.reset };
      }
    }
  }
  const first = await history(); assert.equal(first.pageSize, 50); assert.equal(first.reset, true); assert.equal(first.hasMore,false,'init-only records do not claim earlier visible history'); assert.equal(first.before,null); assert.equal(first.state, 'running');
  assert.equal(first.events.find((e: { toolId: string }) => e.toolId === 'tool_1').output, 'export const ready = true;');
  const partial = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Live appended reasoning' }] } });
  appendFileSync(f.transcript, partial.slice(0, -2));
  const page = await (await fetch(`${base}/invocations/${f.routeId}/history`)).json() as { data: ReturnType<ConsoleHistories['page']> }; assert.ok(!page.data.events.some((e) => e.text === 'Live appended reasoning'));
  appendFileSync(f.transcript, partial.slice(-2) + '\n');
  await until(async () => (await history()).events.some((e: { text: string }) => e.text === 'Live appended reasoning'), 5000, 'incremental history SSE append');
  f.append('large evidence '.repeat(1000));
  let long: ReturnType<ConsoleHistories['page']>['events'][number] | undefined; await until(async () => { const update = await history(); long = update.events.find((e: { truncated: string[] }) => e.truncated.includes('text')); return !!long; }, 5000, 'bounded long event');
  assert.ok(long); assert.ok(long.text!.length <= 4096);
  const field = await (await fetch(`${base}/invocations/${f.routeId}/history-field?identity=${first.identity}&ref=${long.id}&field=text&after=4096`)).json() as { data: ReturnType<ConsoleHistories['field']> };
  assert.equal(field.data.text.length, 4096); assert.ok(field.data.next < field.data.size);
  f.finish(); await until(async () => { const next = await history(); return next.state === 'success' && next.endedAt !== null; }, 5000, 'finished view without reload');
  writeFileSync(f.transcript, partial + '\n'); await until(async () => (await history()).reset === true, 5000, 'truncation resets browser history');
  const stale = await fetch(`${base}/invocations/${f.routeId}/history-field?identity=${first.identity}&ref=${long.id}&field=text&after=0`); assert.equal(stale.status, 409);
  abort.abort();
});

 test('earlier history has a verified cursor until exhausted, including an init-only prefix', {timeout:30_000}, async t => {
  const f=await consoleAgentFixture();t.after(()=>f.close());
  for(let n=0;n<125;n++)f.append(`Earlier history ${n}`);
  const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});t.after(()=>s.close());
  const base=`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/invocations/${f.routeId}/history`;
  const seen=new Set<string>();let before:string|null|undefined,identity:string|undefined,pages=0;
  do {
    const r=await fetch(base+(before?`?before=${before}&identity=${encodeURIComponent(identity!)}`:''));assert.equal(r.status,200);
    const {data}=await r.json() as {data:ReturnType<ConsoleHistories['page']>};
    assert.equal(data.hasMore,data.before!==null);
    for(const event of data.events){assert.ok(!seen.has(event.id),'pages do not repeat events');seen.add(event.id);}
    identity=data.identity;before=data.before;pages++;assert.ok(pages<10);
  }while(before);
  assert.ok(pages>=3);assert.ok(seen.size>=125);
 });
