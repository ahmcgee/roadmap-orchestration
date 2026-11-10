import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleFixture } from './fixtures/console.ts';
import { serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { validateViewEnvelope } from '../src/console/view-validation.ts';
import { CONSOLE_UI_SCHEMA } from '../src/console/view-protocol.ts';

test('typed shell/graph HTTP routes keep admission, security, schema, canonical parity and refuse the retired adapter', async t => {
  const f = consoleFixture(), server = await serveConsole({...f, host:'127.0.0.1', port:0, instance:'views-api'}); t.after(() => server.close());
  const api = `${server.url}/api/${CONSOLE_PROTOCOL}`, base = `${api}/arcs/${f.arc}`;
  const discovery = await fetch(`${api}/arcs`);
  assert.ok(Buffer.byteLength(await discovery.clone().text()) <= 1024);
  assert.equal((await discovery.json() as {uiSchema:number}).uiSchema, CONSOLE_UI_SCHEMA);
  const expected = {instance:server.instance, repoId:server.repoId, arc:f.arc};
  for (const kind of ['shell','graph'] as const) {
    const response = await fetch(`${base}/${kind}`), raw: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(raw));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.ok(response.headers.get('content-security-policy')!.includes("default-src 'self'"));
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    const e = validateViewEnvelope(raw,kind,expected);
    assert.ok(e.highWater > 0); assert.ok(e.revision >= 1); assert.ok(e.checkedAt); assert.ok(e.observedAt);
    assert.ok(Buffer.byteLength(JSON.stringify(e)) <= (kind === 'shell' ? 8 : 256) * 1024);
    assert.equal((await fetch(`${base}/${kind}?epoch=old`)).status,409);
    assert.equal((await fetch(`${base}/${kind}?minHighWater=${e.highWater+1}`)).status,503);
    for (const query of ['typo=1','window=24h','minHighWater=-1','revision=x','epoch=x&epoch=x','fenceSize=0']) assert.equal((await fetch(`${base}/${kind}?${query}`)).status,400,query);
    const head = await fetch(`${base}/${kind}`,{method:'HEAD'});
    assert.equal(head.status,200); assert.equal(await head.text(),'');
    assert.equal(head.headers.get('content-type'),response.headers.get('content-type'));
    assert.equal((await fetch(`${base}/${kind}`,{method:'POST'})).status,405);
    assert.throws(() => validateViewEnvelope({...e,protocol:'old'},kind,expected), /protocol/);
    assert.throws(() => validateViewEnvelope({...e,instance:'prior'},kind,expected), /identity/);
    assert.throws(() => validateViewEnvelope({...e,data:{...e.data,uiSchema:999}},kind,expected), /schema/);
    assert.throws(() => validateViewEnvelope({...e,data:{...e.data,raw:{secret:'not allowed'}}},kind,expected), /malformed/);
    assert.throws(() => validateViewEnvelope({...e,data:{...e.data,toString:'not allowed'}},kind,expected), /malformed/);
    assert.throws(() => validateViewEnvelope({...e,highWater:-1},kind,expected), /malformed/);
    assert.throws(() => validateViewEnvelope({...e,checkedAt:null},kind,expected), /malformed/);
  }
  assert.equal((await fetch(`${server.url}/api/old/arcs/${f.arc}/shell`)).status,409);
  assert.equal((await fetch(`${api}/arcs/a%2fb/graph`)).status,400);
  for (const summary of [false,true]) {
    const response = await fetch(`${base}/status?summary=${summary ? 1 : 0}`), e = await response.json() as {data: unknown};
    const {canonicalJson} = await import('../src/core/json.ts');
    // Compare the same worker capture, preserving its measured foldMs (not a second local fold).
    const captured = await server.ask({kind:'read',path:['arcs',f.arc,'status'],params:{summary:summary?'1':'0'}}) as {data:unknown};
    assert.equal(canonicalJson(e.data)+'\n',canonicalJson(captured.data)+'\n');
  }
  const graph = await (await fetch(`${base}/graph`)).json() as {data:{units:unknown[]}};
  assert.equal(graph.data.units.length,3);
  assert.equal((await fetch(`${base}/snapshot`)).status,404,'retired adapter cannot restore a monolithic load');
});
