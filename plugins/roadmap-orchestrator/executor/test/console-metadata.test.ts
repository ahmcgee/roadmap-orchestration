import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleFixture } from './fixtures/console.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { ConsoleViews } from '../src/console/views.ts';
import { metadataShape } from '../src/console/view-shapes.ts';
import { Observations } from './helpers/observations.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../src/observation/protocol.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_UI_SCHEMA, type Metadata } from '../src/console/view-protocol.ts';
import { preparedRead } from '../web-src/app/prepared-read.ts';

function firstNotice(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return (async () => { let body = ''; for (;;) { const {value,done} = await reader.read(); if (done) throw new Error('stream ended before metadata'); body += new TextDecoder().decode(value); const frame = body.split('\n\n')[0]!; if (body.includes('\n\n')) return {body:frame, value:JSON.parse(frame.split('\n').find(l=>l.startsWith('data: '))!.slice(6)) as Metadata}; } })();
}
test('metadata hashes exclude verification clocks and invalidate independent semantic dependencies', () => {
  const f = consoleFixture(), cache = new Observations(f.hostDir,'metadata','reader'), views = new ConsoleViews(), metadata = new ConsoleMetadata();
  const read = () => cache.read({runDir:f.runDir,arc:f.arc});
  const e = read(), a = metadata.read(e,views,f.arc);
  assert.equal(a.viewVersions.shell,views.shell(e).viewVersion); assert.equal(a.viewVersions.graph,views.graph(e).viewVersion);
  assert.equal('data' in a,false); assert.ok(Buffer.byteLength(JSON.stringify(a))<4096);
  const now = new Date().toISOString(); writeFileSync(join(f.runDir,'heartbeat.json'),JSON.stringify({v:2,generation:1,at:now}));
  const heartbeat = metadata.read(read(),views,f.arc); assert.deepEqual(heartbeat.viewVersions,a.viewVersions);
  let captures = e.data.capture.materializations;
  // A changed copy no model published: its versions are computed from it, not read from the capture (dev.75).
  const {viewVersions: _published, ...capture} = e.data.capture;
  const changed = (patch: Partial<Envelope['data']>): Envelope => ({...e,data:{...e.data,...patch,capture:{...capture,materializations:++captures}}});
  const request = e.data.requests[0]; assert.ok(request);
  const requests = metadata.read(changed({requests:[{...request,summary:request.summary+' updated'}]}),views,f.arc);
  assert.notEqual(requests.viewVersions.attention,a.viewVersions.attention);
  assert.notEqual(requests.viewVersions.activity,a.viewVersions.activity);
  assert.equal(requests.viewVersions.graph,a.viewVersions.graph);
  const units = e.data.display.status.units.map((u,i) => i===0 ? {...u,state:'parked' as const} : u);
  const state = metadata.read(changed({display:{...e.data.display,status:{...e.data.display.status,units}}}),views,f.arc);
  assert.notEqual(state.viewVersions.graph,a.viewVersions.graph); assert.notEqual(state.viewVersions.shell,a.viewVersions.shell);
  assert.notEqual(state.viewVersions.timeline,a.viewVersions.timeline); assert.notEqual(state.viewVersions.effort,a.viewVersions.effort);
  assert.notEqual(state.viewVersions.resources,a.viewVersions.resources); assert.equal(state.viewVersions.attention,a.viewVersions.attention);
  const selection = metadata.read(e,views,'different'); assert.equal(selection.selected,'different'); assert.deepEqual(selection.viewVersions,a.viewVersions);
});

test('SSE registers an atomic metadata watermark with no snapshot/model read and preserves admission/HEAD', {timeout:10_000}, async t => {
  const f = consoleFixture(), messages:any[] = [], original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) { messages.push(m); return original.call(this,m,...rest); });
  const s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const c = new AbortController(); t.after(() => c.abort());
  const r = await fetch(`${base}/events`,{signal:c.signal}); assert.equal(r.status,200);
  const {body,value} = await firstNotice(r.body!.getReader());
  assert.match(body,/event: revision/); assert.ok(Buffer.byteLength(body)<4096);
  assert.ok(metadataShape(value), 'a stream notice is exactly the metadata the browser validates');
  assert.equal(value.protocol,CONSOLE_PROTOCOL); assert.equal(value.instance,s.instance); assert.equal(value.repoId,s.repoId);
  assert.equal(value.arc,f.arc); assert.equal(value.selected,f.arc); assert.equal(value.uiSchema,CONSOLE_UI_SCHEMA); assert.ok(value.highWater>0);
  assert.equal('data' in value,false); assert.equal('events' in value,false);
  assert.deepEqual(Object.keys(value.viewVersions).sort(),['activity','attention','effort','graph','holistic','resources','shell','timeline']);
  assert.equal(messages.some(m => m.kind==='read' && m.path[2]==='snapshot'),false);
  assert.ok(messages.some(m=>m.kind==='subscribe'));
  const metadata = await preparedRead(`${s.url}/api/${CONSOLE_PROTOCOL}`,CONSOLE_PROTOCOL,`/arcs/${f.arc}/metadata`) as Metadata;
  assert.deepEqual(metadata.viewVersions,value.viewVersions);
  assert.equal((await fetch(`${base}/events?epoch=old`)).status,409);
  assert.equal((await fetch(`${base}/events?minHighWater=${value.highWater+1}`)).status,503);
  assert.equal((await fetch(`${base}/events?typo=1`)).status,400);
  const head = await fetch(`${base}/events`,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  assert.equal((await fetch(`${base}/events?epoch=old`,{method:'HEAD'})).status,409);
  c.abort();
});

test('view versions of a model extended across captures equal those built cold at the same position', async t => {
  const { investigationFixture } = await import('./fixtures/console-investigations.ts');
  const f = await investigationFixture(); t.after(() => f.close());
  const arc = new Observations(f.hostDir, 'incremental', 'reader').arc(f);
  const versions = (e: Envelope) => new ConsoleMetadata().read(e, new ConsoleViews(), f.arc).viewVersions;
  // The same data as no model published it (dev.75: without the versions the model kept): its versions are built from nothing.
  const cold = (e: Envelope): Envelope => { const { viewVersions: _kept, ...capture } = e.data.capture; return { ...e, data: { ...e.data, capture } }; };
  const first = arc.read();
  assert.deepEqual(versions(first), versions(cold(first)));
  // Appended events, a settled row and a terminal fact: each extends the model's tokens, as captures do on a live arc.
  for (let n = 0; n < 3; n++) { const p = f.begin('u7', 'build'); f.journal.fact({ kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false }); }
  const second = arc.read();
  f.finishLive(); f.complete();
  const third = arc.read();
  assert.ok(second.highWater > first.highWater && third.highWater > second.highWater);
  assert.equal(third.data.capture.materializations, 3, 'three captures extended one model');
  for (const e of [second, third]) assert.deepEqual(versions(e), versions(cold(e)), `at ${e.highWater}`);
  assert.notDeepEqual(versions(third), versions(first), 'the versions moved with what changed');
});

test('T12: an appended event moves the notice\'s lastEventAt and leaves the shell\'s version alone', async t => {
  const { investigationFixture } = await import('./fixtures/console-investigations.ts');
  const { unitId } = await import('../src/core/ids.ts');
  const f = await investigationFixture(); t.after(() => f.close());
  const arc = new Observations(f.hostDir, 'last-event', 'reader').arc(f), metadata = new ConsoleMetadata(), views = new ConsoleViews();
  const first = arc.read(), before = metadata.read(first, views, f.arc);
  assert.equal(before.lastEventAt, first.data.events.at(-1)!.at);
  await new Promise((r) => setTimeout(r, 5));
  f.journal.fact({ kind: 'stage-admitted', unit: unitId('u7'), stage: 'build', waited: { totalMs: 1, byReasonMs: { 'cpu-tokens': 1 } } });
  const second = arc.read(), after = metadata.read(second, views, f.arc);
  assert.ok(second.highWater > first.highWater);
  assert.ok(metadataShape(after));
  assert.equal(after.lastEventAt, second.data.events.at(-1)!.at); assert.notEqual(after.lastEventAt, before.lastEventAt);
  assert.equal(after.viewVersions.shell, before.viewVersions.shell, 'the shell does not change with every event');
  assert.equal(views.shell(second).availableRange.to, null, 'a running arc has no recorded end');
});
