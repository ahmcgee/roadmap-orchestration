import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { arcId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../../src/observation/protocol.ts';
import type { consoleModel } from '../../src/console/model.ts';
import type { ConsoleHistories } from '../../src/console/history.ts';

test('scale arc: real server serves the manifest, attempts and four active histories; repeat seed preserves journal bytes', {timeout:90_000}, async t => {
  const dir=tmpDir('console-scale'), m=await generateScaleArc(dir,{units:40,days:2,seed:'small-week'});
  const events=readFileSync(join(m.runDir,'events.jsonl'));
  const release=await ownScaleArc(m);
  const server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});
  let disposed=false;
  t.after(async()=>{if(!disposed){await server.close();release();}});
  const base=`${server.url}/api/${CONSOLE_PROTOCOL}/runs/${m.arc}`;
  async function get<T>(route:string):Promise<T> {const response=await fetch(`${base}/${route}`);assert.equal(response.status,200,`${route}: ${await response.clone().text().then(s=>s.slice(0,500))}`);return await response.json() as T;}
  const status=await get<{data:Envelope['data']['display']['status']}>('status');
  const snapshot=await get<Envelope & {data:{console:ReturnType<typeof consoleModel>}}>('snapshot');
  const units=status.data.units;
  assert.equal(units.length,m.units);
  assert.equal(snapshot.data.console.graph.units.length,m.units+m.milestones);
  assert.equal(snapshot.data.console.activities.length,m.invocations);
  assert.equal(snapshot.data.console.activities.filter(i=>i.kind==='agentic').length,m.agentInvocations);
  assert.equal(units.filter(u=>u.state==='merged').length,m.merged);
  assert.equal(units.filter(u=>u.state==='cut'||u.state==='superseded').length,m.withdrawn);
  assert.equal(snapshot.data.console.attention.length,m.openAttention);
  assert.equal(status.data.milestones.filter(m=>m.passed).length,m.passedMilestones);
  const active=snapshot.data.display.invocations.filter(i=>i.execution==='agent' && !i.endedAt);
  assert.equal(active.length,4); assert.equal(active.length,m.live.length);
  const attempts=units.reduce((n,u)=>n+new Set(snapshot.data.display.invocations.filter(i=>i.unit===u.unit).map(i=>i.attempt)).size,0);
  assert.equal(attempts,m.attempts);
  const detail=await get<{data:{attempts:number[];activities:unknown[]}}>('units/u7');
  assert.equal(detail.data.activities.length,snapshot.data.display.invocations.filter(i=>i.unit==='u7').length);
  assert.ok(detail.data.attempts.length>=2);
  for(const live of m.live) {
    const history=await get<{data:ReturnType<ConsoleHistories['page']>}>(`invocations/${live.routeId}/history`);
    assert.equal(history.data.state,'running'); assert.equal(history.data.endedAt,null); assert.ok(history.data.events.length>0);
    const prompt=await get<{data:{lines:string[]}}>(`invocations/${live.routeId}/prompt`);assert.match(prompt.data.lines.join('\n'),/contracts\//);
  }
  const finished=snapshot.data.console.activities.find(i=>i.kind==='agentic'&&i.status==='passed')!;
  const history=await get<{data:ReturnType<ConsoleHistories['page']>}>(`invocations/${finished.routeId}/history`);assert.equal(history.data.state,'success');
  assert.equal((await fetch(`${server.url}/#/runs/${m.arc}/overview`)).status,200);
  await server.close();release();disposed=true;
  rmSync(dir,{recursive:true});
  const repeat=await generateScaleArc(dir,{units:40,days:2,seed:'small-week'});
  const repeatedEvents=readFileSync(join(repeat.runDir,'events.jsonl'));
  if(!events.equals(repeatedEvents)) { const a=events.toString().split('\n'), b=repeatedEvents.toString().split('\n'), first=a.findIndex((line,i)=>line!==b[i]);t.diagnostic(`first journal difference at line ${first+1}: ${a[first]?.slice(0,500)} vs ${b[first]?.slice(0,500)}`); }
  assert.equal(sha256Hex(repeatedEvents),sha256Hex(events),'same output location and seed produce byte-identical authoritative journal');
  assert.deepEqual(repeat,m);
});

test('default 300-unit week is fast and covers scale hazards in the validated journal', {timeout:90_000}, async t=>{
  const start=performance.now(), m=await generateScaleArc(tmpDir('console-scale-large'));
  const elapsed=performance.now()-start; t.diagnostic(`${m.units} units; ${m.invocations} invocations; ${m.events} events; generated in ${elapsed.toFixed(0)}ms`);
  assert.ok(elapsed<60_000,`generation took ${elapsed}ms`);
  assert.equal(m.units,300);assert.equal(m.systems.length,8);assert.equal(m.milestones,10);assert.equal(m.live.length,4);
  assert.equal(m.merged,165);assert.ok(m.costUsd>=500&&m.costUsd<=1500);assert.ok(m.dependencies>300);assert.ok(m.contingentEdges>=3);
  assert.ok(Object.values(m.buildRounds).includes(6));
  const log=readJournal(absPath(m.runDir),arcId(m.arc));assert.equal(log.view.highWater(),m.events);
  assert.ok(Date.parse(m.now)-Date.parse(log.events[0]!.at)>7*86_400_000);
  for(let i=1;i<log.events.length;i++) assert.ok(log.events[i]!.at>=log.events[i-1]!.at,`event ${i+1} moved backward in time`);
  const facts=log.events.flatMap(e=>e.type==='fact'?[e.fact]:[]);
  assert.equal(facts.filter(f=>f.kind==='backend-park').length,6);
  assert.equal(facts.filter(f=>f.kind==='needs-user-acked').length,m.ackedAttention);
  assert.ok(facts.some(f=>f.kind==='stage-outcome'&&'outcome' in f&&f.outcome==='red'));
  assert.ok(facts.some(f=>f.kind==='stage-outcome'&&'outcome' in f&&f.outcome==='revise'));
  const server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>server.close());
  const response=await fetch(`${server.url}/api/${CONSOLE_PROTOCOL}/runs/${m.arc}/snapshot`);assert.equal(response.status,200);
  const snapshot=await response.json() as Envelope;assert.equal(snapshot.data.display.status.units.length,300);
});
