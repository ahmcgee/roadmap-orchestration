import assert from 'node:assert/strict';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
/** Follow browser preparation without changing the final response or its byte assertions. */
export async function consoleGet(input: string): Promise<Response> {
  const url = new URL(input), deadline = Date.now()+30_000;
  let token: string | undefined;
  for (;;) {
    const r = await fetch(url);
    if (r.status !== 202) return r;
    assert.equal(r.headers.get('retry-after'),'1');
    const v = await r.json() as {protocol:string;arc:string;state:string;pending:string;retryAfterMs:number};
    assert.equal(v.protocol,CONSOLE_PROTOCOL); assert.equal(v.state,'preparing');
    assert.equal(v.arc,decodeURIComponent(url.pathname.split('/arcs/')[1]!.split('/')[0]!));
    assert.match(v.pending,/^[0-9a-f-]{36}$/); if (token) assert.equal(v.pending,token);
    token = v.pending; url.searchParams.set('pending',token);
    assert.equal(v.retryAfterMs,1000); assert.ok(Date.now()+1000<deadline,'preparation completes within its lifetime');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
