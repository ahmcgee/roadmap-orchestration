import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { BrowserPreparation, PREPARATION } from '../src/console/preparation.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL, ConsoleError } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';
import { preparedRead } from '../web-src/app/prepared-read.ts';
import { consoleGet } from './helpers/console-http.ts';

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

test('a read every reader left never reaches the worker, reads do not wait on each other, and cancelling twice is not an error', async t => {
  // dev.59 C6: clicking through stations cancels reads; a cancelled read must not still occupy the worker. The serve worker
  // parks a read it cannot answer yet without holding up another, so reads run side by side; a left one is aborted.
  const p = new BrowserPreparation(); t.after(() => p.close());
  const gate = deferred(), ran: string[] = [], aborted: string[] = [];
  // As src/console/http.ts sends a browser read: not at all once its signal aborted, and cancelled at the worker when it aborts.
  const run = (key: string, value: Promise<unknown> | unknown) => (abandoned: AbortSignal) => {
    if (abandoned.aborted) { aborted.push(key); return Promise.reject(new Error('cancelled')); }
    ran.push(key); abandoned.addEventListener('abort', () => aborted.push(key)); return Promise.resolve(value);
  };
  const first = await p.read('first', run('first', gate.promise), signal());
  assert.equal(first.state, 'preparing');
  const left = new AbortController(), leaving = p.read('left', run('left', 'never'), left.signal);
  left.abort();
  await assert.rejects(leaving, /browser read cancelled/);
  const kept = await p.read('kept', run('kept', 'wanted'), signal());
  assert.equal(kept.state, 'ready', 'a read does not wait behind one still preparing'); if (first.state !== 'preparing') return;
  assert.deepEqual(kept, {state: 'ready', value: 'wanted'});
  assert.deepEqual(ran, ['first', 'kept'], 'the read its reader left never reached the worker');
  assert.deepEqual(aborted, ['left']);
  gate.resolve('done');
  assert.deepEqual(await p.read('first', run('first', 'done'), signal(), first.pending, true), {state: 'ready', value: {state: 'cancelled'}});
  assert.deepEqual(await p.read('first', run('first', 'done'), signal(), first.pending, true), {state: 'ready', value: {state: 'cancelled'}}, 'a second cancel of the same lease');
});

test('preparation delivers an envelope as the worker admitted it, never relabels its clock, expires and does not cache ordinary reads', async t => {
  // dev.71: an envelope older than five seconds was re-admitted, which re-ran the read and answered from the same observation
  // again; the old age is what the page now reports, not a reason to refuse delivery.
  const p = new BrowserPreparation(); t.after(() => p.close());
  const gate = deferred(); let calls = 0;
  const run = () => { calls++; return gate.promise; };
  const a = await p.read('old',run,signal()); assert.equal(a.state,'preparing'); if (a.state !== 'preparing') return;
  const old = {checkedAt:new Date(Date.now()-6000).toISOString(),data:{admitted:'old'}};
  gate.resolve(old); await Promise.resolve(); await Promise.resolve();
  const delivered = await p.read('old',run,signal(),a.pending);
  assert.deepEqual(delivered,{state:'ready',value:old}); assert.equal(calls,1);
  if (delivered.state === 'ready') assert.equal((delivered.value as typeof old).checkedAt,old.checkedAt,'the clock is the worker\'s');
  let reads = 0;
  for (let i=0;i<3;i++) assert.deepEqual(await p.read('ordinary',async () => ++reads,signal()),{state:'ready',value:i+1});
  const now = Date.now(); t.mock.method(Date,'now',() => now + PREPARATION.graceMs + 1);
  await assert.rejects(p.read('old',run,signal(),a.pending), /expired or cancelled/);
});

test('T1: a read whose result is a minute old is delivered ready on the first call, its checkedAt unchanged, run once', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close());
  const checkedAt = new Date(Date.now()-60_000).toISOString(); let calls = 0;
  const result = await p.read('minute',async () => { calls++; return {checkedAt,data:{n:1}}; },signal());
  assert.equal(result.state,'ready'); if (result.state !== 'ready') return;
  assert.equal((result.value as {checkedAt:string}).checkedAt,checkedAt); assert.equal(calls,1);
});

test('T2: a poll is held until its read settles, for at most retryAfterMs; a client re-polling at once gets at most four answers in three seconds', {timeout:20_000}, async t => {
  const p = new BrowserPreparation(); t.after(() => p.close());
  // As web-src/app/prepared-read.ts: poll again at once with the token while the answer is "preparing".
  const client = async (key: string, run: () => Promise<unknown>) => {
    let answers = 0, token: string | undefined; const held: number[] = []; const until = performance.now() + 3000;
    while (performance.now() < until) {
      const began = performance.now(), r = await p.read(key,run,signal(),token); answers++;
      if (token !== undefined) held.push(performance.now() - began);
      if (r.state === 'ready') break;
      token = r.pending;
    }
    if (token !== undefined) await p.read(key,run,signal(),token,true);
    return {answers,held};
  };
  const old = {checkedAt:new Date(Date.now()-60_000).toISOString(),data:{}};
  const settled = await client('settled',async () => old);
  assert.ok(settled.answers <= 4,`${settled.answers} answers for a read whose result is old`);
  const running = deferred();
  const unsettled = await client('running',() => running.promise);
  assert.ok(unsettled.answers <= 4,`${unsettled.answers} answers for a read still running`);
  assert.ok(unsettled.held.length >= 2 && unsettled.held.every(ms => ms >= PREPARATION.retryAfterMs - 20),`polls held ${unsettled.held.map(Math.round)} ms`);
  // A read that settles while its poll is held is answered then, not at the end of the hold.
  const soon = deferred(), first = await p.read('soon',() => soon.promise,signal()); assert.equal(first.state,'preparing'); if (first.state !== 'preparing') return;
  setTimeout(() => soon.resolve(old), 200);
  const began = performance.now(), ready = await p.read('soon',() => soon.promise,signal(),first.pending);
  assert.equal(ready.state,'ready'); assert.ok(performance.now() - began < PREPARATION.retryAfterMs - 200,'answered when the read settled');
  running.resolve(null);
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

test('a poll carrying its token is held until the read completes, past the first response window', async t => {
  const p = new BrowserPreparation(); t.after(() => p.close()); const gate = deferred();
  const a = await p.read('held',() => gate.promise,signal()); assert.equal(a.state,'preparing'); if (a.state !== 'preparing') return;
  setTimeout(() => gate.resolve(23), PREPARATION.deadlineMs + 150);
  assert.deepEqual(await p.read('held',() => gate.promise,signal(),a.pending),{state:'ready',value:23});
  const slow = deferred(), b = await p.read('slow',() => slow.promise,signal()); assert.equal(b.state,'preparing'); if (b.state !== 'preparing') return;
  const c = new AbortController(), held = p.read('slow',() => slow.promise,c.signal,b.pending);
  setTimeout(() => c.abort(), 20); await assert.rejects(held,/cancelled/); slow.resolve(null);
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
  // The arc's collector publishes its first observation 2.3 s late (its channel reaches the serve worker then): every read waits on it.
  const f = consoleFixture(), original = Worker.prototype.postMessage; let browserCalls = 0;
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) {
    if (m.kind === 'collector') { setTimeout(() => original.call(this,m,...rest),2300); return; }
    if (m.kind === 'read' && m.path[2] === 'graph') browserCalls++;
    return original.call(this,m,...rest);
  });
  const started = performance.now(), s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const responses = await Promise.all([fetch(`${base}/graph`),fetch(`${base}/graph`),fetch(`${base}/graph`,{method:'HEAD'})]);
  for (const r of responses) {
    assert.equal(r.status,202); assert.equal(r.headers.get('retry-after'),'1'); assert.equal(r.headers.get('cache-control'),'no-store');
    assert.ok(r.headers.get('content-security-policy')); assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal(await responses[2]!.text(),'');
  const a = await responses[0]!.json() as {pending:string;state:string}, b = await responses[1]!.json() as typeof a;
  assert.equal(a.state,'preparing');
  // The reads reach the serve worker once it has loaded: three readers, one read.
  for (let n = 0; browserCalls === 0 && n < 100; n++) await new Promise(r => setTimeout(r, 50));
  assert.equal(browserCalls,1);
  assert.equal((await fetch(`${base}/shell?pending=${a.pending}`)).status,400);
  assert.equal((await fetch(`${base}/graph?minHighWater=999999&pending=${a.pending}`)).status,400);
  assert.equal((await fetch(`${base}/graph?pending=${a.pending}&cancel=1`)).status,200);
  assert.equal((await fetch(`${base}/graph?pending=${a.pending}`)).status,503);
  // The CLI's read never prepares: it waits for the first observation, then gets its two seconds from there.
  const cli = await fetch(`${base}/status`); assert.equal(cli.status,200); assert.ok(performance.now()-started >= 2300, 'answered after the first observation');
  const final = await fetch(`${base}/graph?pending=${b.pending}`); assert.equal(final.status,200);
  const envelope = await final.json() as {data:{units:unknown[]};checkedAt:string};
  assert.equal(envelope.data.units.length,3); assert.ok(Date.now()-Date.parse(envelope.checkedAt)<5000); assert.equal(browserCalls,1);
  for (const suffix of ['pending=bad','pending=x&pending=y','cancel=0','cancel=1','__proto__=1','__proto__=1&__proto__=2']) assert.equal((await fetch(`${base}/shell?${suffix}`)).status,400);
  assert.equal((await fetch(`${base}/status?pending=${b.pending}`)).status,400);
});

test('real browser transport retries the identical route/query and abort cancels its own pending lease', async t => {
  const urls:URL[] = []; const token = '12345678-1234-1234-1234-123456789abc';
  t.mock.method(globalThis,'fetch',async (url:URL,init?:RequestInit) => {
    urls.push(new URL(url));
    // The server holds a pending poll until its read completes; this one completes only by abort.
    if (url.pathname.endsWith('/graph') && url.searchParams.has('pending') && !url.searchParams.has('cancel')) return new Promise<Response>((_,reject) => init!.signal!.addEventListener('abort',() => reject(init!.signal!.reason)));
    return new Response(JSON.stringify(url.searchParams.has('pending') ? {protocol:'test',data:{real:1}} : {protocol:'test',arc:'a',state:'preparing',pending:token,retryAfterMs:1000}),{status:url.searchParams.has('pending')?200:202});
  });
  assert.deepEqual(await preparedRead('http://console/api/test','test','/arcs/a/shell?epoch=e&minHighWater=4'),{protocol:'test',data:{real:1}});
  assert.equal(urls.length,2); assert.equal(urls[1]!.searchParams.get('epoch'),'e'); assert.equal(urls[1]!.searchParams.get('minHighWater'),'4'); assert.equal(urls[1]!.searchParams.get('pending'),token);
  const c = new AbortController(); const read = preparedRead('http://console/api/test','test','/arcs/a/graph',c.signal);
  await new Promise(r => setTimeout(r,20)); c.abort(); await assert.rejects(read);
  assert.ok(urls.some(u => u.searchParams.get('cancel')==='1' && u.searchParams.get('pending')===token));
});

test('serve worker death ends preparation with an explicit unavailable response', async t => {
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

test('collector death makes its arc\'s reads unavailable with the reason, while the console stays up', async t => {
  const f = consoleFixture(), original = Worker.prototype.postMessage; let collector:Worker | undefined;
  t.mock.method(Worker.prototype,'postMessage',function(this:Worker,m:any,...rest:any[]) {
    if (m.kind==='check-now') collector=this;
    return original.call(this,m,...rest);
  });
  const s = await serveConsole({...f,host:'127.0.0.1',port:0}); t.after(()=>s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}`;
  assert.equal((await fetch(`${base}/arcs/${f.arc}/status`)).status,200);
  assert.equal((await fetch(`${base}/arcs/${f.arc}/status`)).status,200,'a strict read of an observed arc asks its collector to check now');
  assert.ok(collector); await collector.terminate();
  let answer: Response;
  for (;;) { answer = await consoleGet(`${base}/arcs/${f.arc}/graph`); if (answer.status !== 200) break; await new Promise(r=>setTimeout(r,50)); }
  assert.equal(answer.status,503);
  assert.match(await answer.text(),/collector for this arc exited/);
  assert.equal((await fetch(`${base}/arcs`)).status,200,'the console stays up');
});

test('client refuses mismatched or malformed preparation instead of treating it as data', async t => {
  for (const patch of [{protocol:'old'},{arc:'foreign'},{pending:'bad'},{retryAfterMs:1},{state:'ready'}]) {
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({protocol:'test',arc:'a',state:'preparing',pending:'12345678-1234-1234-1234-123456789abc',retryAfterMs:1000,...patch}),{status:202}));
    await assert.rejects(preparedRead('http://console/api/test','test','/arcs/a/shell'),/Reload required|Malformed preparation/);
  }
});
