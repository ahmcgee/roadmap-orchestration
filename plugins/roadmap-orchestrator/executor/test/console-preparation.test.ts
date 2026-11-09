import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { BrowserPreparation, PREPARATION } from '../src/console/preparation.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL, ConsoleError } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';
import { preparedRead } from '../web-src/app/prepared-read.ts';

const signal = () => new AbortController().signal;
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return {promise, resolve}; };

test('browser preparation coalesces immutable delivery, binds queries and isolates cancellation', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close());
  const gate = deferred(); let calls = 0;
  const run = () => { calls++; return gate.promise; };
  const [a,b] = await Promise.all([p.read({arc:'a',route:'graph'},run,signal()), p.read({route:'graph',arc:'a'},run,signal())]);
  assert.equal(calls,1); assert.equal(a.state,'preparing'); assert.equal(b.state,'preparing');
  if (a.state !== 'preparing' || b.state !== 'preparing') return;
  assert.notEqual(a.pending,b.pending);
  for (const identity of [{arc:'b',route:'graph'}, {arc:'a',route:'shell'}, {arc:'a',route:'graph',minHighWater:1}]) {
    await assert.rejects(p.read(identity,run,signal(),a.pending), /does not match/);
  }
  await p.read({arc:'a',route:'graph'},run,signal(),a.pending,true);
  await assert.rejects(p.read({arc:'a',route:'graph'},run,signal(),a.pending), /expired or cancelled/);
  const value = {checkedAt:new Date().toISOString(),data:{actual:42}}; gate.resolve(value);
  const result = await p.read({arc:'a',route:'graph'},run,signal(),b.pending);
  assert.deepEqual(result,{state:'ready',value}); assert.equal(calls,1);
  assert.deepEqual(await p.read({arc:'a',route:'graph'},run,signal(),b.pending),result,'short delivery retries are exact');
});

test('preparation re-admits stale envelopes without relabelling clocks, expires and does not cache ordinary reads', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close());
  const gate = deferred(); let calls = 0;
  const fresh = {checkedAt:new Date().toISOString(),data:{admitted:'new'}};
  const run = () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(fresh); };
  const a = await p.read('stale',run,signal()); assert.equal(a.state,'preparing'); if (a.state !== 'preparing') return;
  const stale = {checkedAt:new Date(Date.now()-6000).toISOString(),data:{admitted:'old'}};
  gate.resolve(stale); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(await p.read('stale',run,signal(),a.pending),{state:'ready',value:fresh}); assert.equal(calls,2);
  assert.notEqual(stale.checkedAt,fresh.checkedAt);
  let reads = 0;
  for (let i=0;i<3;i++) assert.deepEqual(await p.read('ordinary',async () => ++reads,signal()),{state:'ready',value:i+1});
  const now = Date.now(); t.mock.method(Date,'now',() => now + PREPARATION.graceMs + 1);
  await assert.rejects(p.read('stale',run,signal(),a.pending), /expired or cancelled/);
});

test('pending work and leases are bounded through abandonment, expiry and worker errors', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close()); const gate = deferred();
  const reads = await Promise.all(Array.from({length:32},(_,id) => p.read(id,() => gate.promise,signal())));
  await assert.rejects(p.read(33,() => gate.promise,signal()), /too many browser reads/);
  for (const [id,r] of reads.entries()) if (r.state === 'preparing') await p.read(id,() => gate.promise,signal(),r.pending,true);
  await assert.rejects(p.read(33,() => gate.promise,signal()), /too many browser reads/,'abandonment cannot create unbounded worker tasks');
  gate.resolve(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(p.read('corrupt',async () => {throw new ConsoleError('corruption','invalid evidence');},signal()), /invalid evidence/);
  const expiry = deferred(), a = await p.read('expiry',() => expiry.promise,signal());
  assert.equal(a.state,'preparing'); if (a.state !== 'preparing') return;
  const now = Date.now(); t.mock.method(Date,'now',() => now + PREPARATION.lifetimeMs + 1);
  await assert.rejects(p.read('expiry',() => expiry.promise,signal(),a.pending), /expired or cancelled/);
  expiry.resolve(null);
});

test('abort releases a browser subscriber while equivalent readers retain their work', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close()); const gate = deferred(), c = new AbortController();
  const a = p.read('same',() => gate.promise,c.signal); c.abort();
  await assert.rejects(a,/cancelled/);
  const b = await p.read('same',() => gate.promise,signal()); assert.equal(b.state,'preparing');
  gate.resolve(17);
  if (b.state === 'preparing') assert.deepEqual(await p.read('same',() => gate.promise,signal(),b.pending),{state:'ready',value:17});
});

test('HTTP slow browser reads prepare past two seconds, coalesce and cancel; CLI stays strict', {timeout:15_000}, async t => {
  const f = consoleFixture(), s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(() => s.close());
  await s.ask({kind:'read',path:['arcs'],params:{}});
  const original = Worker.prototype.postMessage; let browserCalls = 0;
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) {
    if (m.kind === 'read' && ['graph','status'].includes(m.path[2])) {
      if (m.path[2] === 'graph') browserCalls++;
      setTimeout(() => original.call(this,m,...rest),2300); return;
    }
    return original.call(this,m,...rest);
  });
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const responses = await Promise.all([fetch(`${base}/graph`),fetch(`${base}/graph`),fetch(`${base}/graph`,{method:'HEAD'})]);
  for (const r of responses) {
    assert.equal(r.status,202); assert.equal(r.headers.get('retry-after'),'1'); assert.equal(r.headers.get('cache-control'),'no-store');
    assert.ok(r.headers.get('content-security-policy')); assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal(await responses[2]!.text(),'');
  const a = await responses[0]!.json() as {pending:string;state:string}, b = await responses[1]!.json() as typeof a;
  assert.equal(a.state,'preparing'); assert.equal(browserCalls,1);
  assert.equal((await fetch(`${base}/shell?pending=${a.pending}`)).status,400);
  assert.equal((await fetch(`${base}/graph?minHighWater=999999&pending=${a.pending}`)).status,400);
  assert.equal((await fetch(`${base}/graph?pending=${a.pending}&cancel=1`)).status,200);
  assert.equal((await fetch(`${base}/graph?pending=${a.pending}`)).status,503);
  const cli = await fetch(`${base}/status`); assert.equal(cli.status,503); assert.match(await cli.text(),/exceeded two seconds/);
  const final = await fetch(`${base}/graph?pending=${b.pending}`); assert.equal(final.status,200);
  const envelope = await final.json() as {data:{units:unknown[]};checkedAt:string};
  assert.equal(envelope.data.units.length,3); assert.ok(Date.now()-Date.parse(envelope.checkedAt)<5000); assert.equal(browserCalls,1);
  for (const suffix of ['pending=bad','pending=x&pending=y','cancel=0','cancel=1','__proto__=1','__proto__=1&__proto__=2']) assert.equal((await fetch(`${base}/shell?${suffix}`)).status,400);
  assert.equal((await fetch(`${base}/status?pending=${b.pending}`)).status,400);
});

test('real browser transport retries the identical route/query and abort cancels its own pending lease', async t => {
  const urls:URL[] = []; const token = '12345678-1234-1234-1234-123456789abc';
  t.mock.method(globalThis,'fetch',async (url:URL) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify(url.searchParams.has('pending') ? {protocol:'test',data:{real:1}} : {protocol:'test',arc:'a',state:'preparing',pending:token,retryAfterMs:1000}),{status:url.searchParams.has('pending')?200:202});
  });
  assert.deepEqual(await preparedRead('http://console/api/test','test','/arcs/a/shell?epoch=e&minHighWater=4'),{protocol:'test',data:{real:1}});
  assert.equal(urls.length,2); assert.equal(urls[1]!.searchParams.get('epoch'),'e'); assert.equal(urls[1]!.searchParams.get('minHighWater'),'4'); assert.equal(urls[1]!.searchParams.get('pending'),token);
  const c = new AbortController(); const read = preparedRead('http://console/api/test','test','/arcs/a/graph',c.signal);
  await new Promise(r => setTimeout(r,20)); c.abort(); await assert.rejects(read);
  assert.ok(urls.some(u => u.searchParams.get('cancel')==='1' && u.searchParams.get('pending')===token));
});

test('worker death ends preparation with an explicit unavailable response', async t => {
  const f = consoleFixture(), original = Worker.prototype.postMessage; let held:Worker | undefined;
  const s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(()=>s.close());
  await s.ask({kind:'read',path:['arcs'],params:{}});
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) {
    if (m.kind==='read'&&m.path[2]==='graph') { held=this; return; }
    return original.call(this,m,...rest);
  });
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/graph`;
  const first = await fetch(base); assert.equal(first.status,202); const v = await first.json() as {pending:string};
  assert.ok(held); await held.terminate();
  const final = await fetch(`${base}?pending=${v.pending}`); assert.equal(final.status,503);
  assert.match(await final.text(),/worker exited/);
});

test('client refuses mismatched or malformed preparation instead of treating it as data', async t => {
  for (const patch of [{protocol:'old'},{arc:'foreign'},{pending:'bad'},{retryAfterMs:1},{state:'ready'}]) {
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({protocol:'test',arc:'a',state:'preparing',pending:'12345678-1234-1234-1234-123456789abc',retryAfterMs:1000,...patch}),{status:202}));
    await assert.rejects(preparedRead('http://console/api/test','test','/arcs/a/shell'),/Reload required|Malformed preparation/);
  }
});
