import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { assertGraphGeometry } from '../helpers/graph-geometry.ts';
import { tmpDir } from '../helpers/repo.ts';
import { serveConsole } from '../../src/console/http.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { arcId, invocationDirName, invocationIdOf } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../../src/observation/protocol.ts';
import { consoleGet } from '../helpers/console-http.ts';
import type { AttentionView, RequestView } from '../../src/console/attention-protocol.ts';
import type { UnitView } from '../../src/console/detail-protocol.ts';
import { Observations } from '../helpers/observations.ts';
import { invocationSummaries, unitView } from '../../src/console/details.ts';
import type { GraphView } from '../../src/console/view-protocol.ts';
import type { IntervalsView } from '../../src/console/temporal-protocol.ts';
import type { ConsoleHistories } from '../../src/console/history.ts';

const corpus = JSON.parse(readFileSync(new URL('../helpers/scale-corpus.json',import.meta.url),'utf8'));
const textFor = (i:number,systems:string[]) => corpus.systems[systems[(i-1)%8]!][Math.floor((i-1)/8)];

test('scale arc: real server serves the manifest, attempts and four active histories; repeat seed preserves journal bytes', {timeout:90_000}, async t => {
  const dir=tmpDir('console-scale'), m=await generateScaleArc(dir,{units:40,days:2,seed:'small-week'});
  const events=readFileSync(join(m.runDir,'events.jsonl'));
  const release=await ownScaleArc(m);
  const server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});
  let disposed=false;
  t.after(async()=>{if(!disposed){await server.close();release();}});
  const base=`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}`;
  async function get<T>(route:string):Promise<T> {const response=await consoleGet(`${base}/${route}`);assert.equal(response.status,200,`${route}: ${await response.clone().text().then(s=>s.slice(0,500))}`);return await response.json() as T;}
  const status=await get<{data:Envelope['data']['display']['status']}>('status');
  const capture=new Observations(absPath(m.hostDir),'scale-fixture','reader').read({runDir:absPath(m.runDir),arc:arcId(m.arc)});
  const graph=(await get<{data:GraphView}>('graph')).data;
  let intervals=(await get<{data:IntervalsView}>('timeline/intervals?window=arc')).data;const calls=[...intervals.rows];
  while(intervals.page.next){intervals=(await get<{data:IntervalsView}>(`timeline/intervals?window=arc&cursor=${encodeURIComponent(intervals.page.next)}`)).data;calls.push(...intervals.rows);}
  assert.equal(new Set(calls.map(i=>i.id)).size,calls.length);assert.equal(calls.length,intervals.page.matching);
  const canonicalInvocations=new Map(capture.data.display.invocations.map(i=>[invocationDirName(invocationIdOf(i.id)),i]));
  assert.equal(status.data.arc,m.arc);assert.equal(capture.arc,m.arc);
  assert.deepEqual(calls.map(i=>i.invocation).sort(),[...canonicalInvocations.keys()].sort());
  const units=status.data.units;
  assert.equal(units.length,m.units);
  assert.equal(graph.units.length+graph.milestones.length,m.units+m.milestones);
  assert.equal(calls.length,m.invocations);
  assert.equal(calls.filter(i=>canonicalInvocations.get(i.invocation)!.execution==='agent').length,m.agentInvocations);
  assert.equal(units.filter(u=>u.state==='merged').length,m.merged);
  assert.equal(units.filter(u=>u.state==='cut'||u.state==='superseded').length,m.withdrawn);
  const attention=await (await consoleGet(`${base}/attention`)).json() as {data:AttentionView};assert.equal(attention.data.counts.total,m.openAttention);assert.equal(attention.data.page.matching,m.openAttention);assert.equal(attention.data.rows.length,m.openAttention);
  assert.equal(status.data.milestones.filter(m=>m.passed).length,m.passedMilestones);
  const active=capture.data.display.invocations.filter(i=>i.execution==='agent' && !i.endedAt);
  assert.equal(active.length,4); assert.equal(active.length,m.live.length);
  const attempts=units.reduce((n,u)=>n+new Set(capture.data.display.invocations.filter(i=>i.unit===u.unit).map(i=>i.attempt)).size,0);
  assert.equal(attempts,m.attempts);
  const detail=await get<{data:UnitView}>('units/u7'),invocations=[...detail.data.invocations.rows];
  let cursor=detail.data.invocations.next;while(cursor){const next=await get<{data:UnitView}>(`units/u7?section=invocations&cursor=${encodeURIComponent(cursor)}`);invocations.push(...next.data.invocations.rows);cursor=next.data.invocations.next;}
  assert.equal(invocations.length,capture.data.display.invocations.filter(i=>i.unit==='u7').length);
  assert.deepEqual(invocations.map(i=>i.id).sort(),capture.data.display.invocations.filter(i=>i.unit==='u7').map(i=>i.id).sort());
  assert.ok(new Set(invocations.map(i=>i.attempt)).size>=2);
  for(const live of m.live) {
    const history=await get<{data:ReturnType<ConsoleHistories['page']>}>(`invocations/${live.routeId}/history`);
    assert.equal(history.data.state,'running'); assert.equal(history.data.endedAt,null); assert.ok(history.data.events.length>0);
    const prompt=await get<{data:{lines:string[]}}>(`invocations/${live.routeId}/prompt`);
    const text=textFor(Number(live.unit.slice(1)),m.systems), brief=prompt.data.lines.join('\n');
    for(const value of [text.title,text.intent,text.acceptance,...text.files]) assert.ok(brief.includes(value));
  }
  const finished=invocationSummaries(capture).find(i=>i.kind==='agentic'&&i.status==='passed')!;
  const history=await get<{data:ReturnType<ConsoleHistories['page']>}>(`invocations/${finished.routeId}/history`);assert.equal(history.data.state,'success');
  assert.equal((await fetch(`${server.url}/#/arcs/${m.arc}/graph`)).status,200);
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
  assert.equal(m.arc,'scale-67055f7443dc');
  assert.equal(m.invocations,1088);assert.equal(m.agentInvocations,622);assert.equal(m.events,7523);
  assert.equal(m.dependencies,663);assert.equal(m.contingentEdges,4);assert.equal(m.attempts,1068);assert.equal(m.stageAttempts,1412);
  assert.equal(m.withdrawn,13);assert.equal(m.parked,12);assert.equal(m.openAttention,11);assert.equal(m.ackedAttention,5);
  assert.deepEqual(m.live.map(({unit,stage,routeId})=>({unit,stage,routeId})),[
    {unit:'u226',stage:'build',routeId:'7459-1'},{unit:'u227',stage:'build',routeId:'7464-1'},
    {unit:'u228',stage:'build',routeId:'7469-1'},{unit:'u229',stage:'gate',routeId:'7474-1'},
  ]);
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
  const release=await ownScaleArc(m);t.after(release);
  const server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>server.close());
  const response=await consoleGet(`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/graph`);assert.equal(response.status,200,await response.clone().text());
  const graph=(await response.json() as {data:GraphView}).data;
  const capture=new Observations(absPath(m.hostDir),'scale-fixture','reader').read({runDir:absPath(m.runDir),arc:arcId(m.arc)});
  const geometry=assertGraphGeometry(capture);t.diagnostic(`300-unit layout + direct curves: ${geometry.elapsed.toFixed(1)}ms; ${geometry.curves} complete edges`);
  assert.equal(capture.data.display.status.units.length,300);
  for(let i=1;i<=300;i++) {
    const text=textFor(i,m.systems),unit=unitView(capture,`u${i}`) as UnitView;
    assert.equal(unit.unit.title,text.title);assert.equal(graph.units.find(u=>u.id===unit.unit.id)!.title,text.title);
    assert.equal(unit.intent.text,`# ${text.title}\n\n${text.intent}`);
    assert.deepEqual(unit.acceptance.rows,[text.acceptance]);
  }
  assert.deepEqual(capture.data.plan!.milestones!.map(m=>({text:m.text,journey:m.journeys[0]!.text})),
    corpus.milestones.map((m:{text:string;journey:string})=>({text:m.text,journey:m.journey})));
  for(const [route,stage,state] of [['7459-1','build','running'],['42-1','build','success'],['23-1','gate','success']]) {
    const invocation=capture.data.display.invocations.find(i=>invocationDirName(invocationIdOf(i.id))===route)!;
    assert.equal(invocation.state,state);
    assert.equal(JSON.parse(invocation.body).parent.stage,stage);
    const text=textFor(Number(invocation.unit!.slice(1)),m.systems);
    const rows=readFileSync(join(m.runDir,'inv',route!,'stdout'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const blocks=rows.flatMap(row=>row.message?.content??[]);
    assert.equal(blocks.find(b=>b.type==='thinking').thinking,text.thinking.join('\n\n'));
    const tools=blocks.filter(b=>b.type==='tool_use');
    assert.equal(tools.find(b=>b.name==='Read').input.file_path,text.files[0]);
    assert.deepEqual(tools.find(b=>b.name==='Edit').input,{file_path:text.edit.file,old_string:text.edit.old,new_string:text.edit.new});
    const write=tools.find(b=>b.name==='Write');
    assert.ok(write.input.file_path.startsWith('test/'));assert.ok(write.input.content.includes(text.acceptance));
    assert.ok(tools.some(b=>b.name==='Bash'&&b.input.command===text.shell.command&&b.input.description===text.shell.description));
    assert.ok(tools.some(b=>b.name==='Bash'&&b.input.command===`cat > ${write.input.file_path} <<'EOF'\n${write.input.content}EOF`));
    assert.ok(blocks.some(b=>b.type==='tool_result'&&b.content===text.testOutput.join('\n')+'\n'));
    if(stage==='gate') assert.deepEqual(rows.at(-1).structured_output,{decision:'approve',reasons:[text.approve],findings:[],directives:[]});
  }
  // Check retained revise reports independently of the projection's report summary shape.
  const gates=capture.data.display.invocations.filter(i=>i.execution==='agent'&&JSON.parse(i.body).parent.stage==='gate'&&i.endedAt);
  const reports=gates.map(i=>({i,result:JSON.parse(readFileSync(join(m.runDir,'inv',invocationDirName(invocationIdOf(i.id)),'result.json'),'utf8'))}));
  const revise=reports.find(({result})=>result.outcome.value.decision==='revise')!;
  const text=textFor(Number(revise.i.unit!.slice(1)),m.systems);
  assert.deepEqual(revise.result.outcome.value,{decision:'revise',reasons:[text.revise.reason],findings:[{title:text.revise.finding,path:text.edit.file,line:text.revise.line}],directives:[text.revise.directive]});
  const forge=JSON.parse(readFileSync(join(dirname(m.repo),'forge','gh-store.json'),'utf8'));
  for(const pr of forge.pulls) {const text=textFor(pr.number,m.systems);assert.equal(pr.title,text.title);assert.equal(pr.body,text.intent);}
  const affectedTitles=Array.from({length:12},(_,n)=>textFor(214+n,m.systems).title as string);
  let attention=await (await consoleGet(`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/attention`)).json() as {data:AttentionView};const requestRows=[...attention.data.rows];
  while(attention.data.page.next){attention=await (await consoleGet(`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/attention?cursor=${encodeURIComponent(attention.data.page.next)}`)).json() as {data:AttentionView};requestRows.push(...attention.data.rows);}
  assert.equal(requestRows.length,m.openAttention);assert.equal(new Set(requestRows.map(r=>r.id)).size,m.openAttention);
  for(const row of requestRows) {
    const response=await consoleGet(`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/requests/${row.id}`);assert.equal(response.status,200);const request=(await response.json() as {data:RequestView}).data;
    const title=affectedTitles.find(title=>request.fields.summary.endsWith(title));assert.ok(title);
    assert.equal(request.fields.recommendation,`Review ${title} and record whether to resume or defer it.`);
    if(request.recordPreview!.subject.type==='unit') assert.equal(title,textFor(Number(request.recordPreview!.subject.id.slice(1)),m.systems).title);
  }
});

test('design preset spans the corpus through rollout in five named milestones', {timeout:90_000}, async t => {
 const m=await generateScaleArc(tmpDir('console-design'),{preset:'design'});
 assert.equal(m.units,50);assert.equal(m.milestones,5);assert.equal(m.live.length,4);assert.equal(m.openAttention,3);
 const release=await ownScaleArc(m);t.after(release);
 const server=await serveConsole({repo:absPath(m.repo),common:gitCommonDir(absPath(m.repo)),hostDir:absPath(m.hostDir),host:'127.0.0.1',port:0});t.after(()=>server.close());
 const response=await consoleGet(`${server.url}/api/${CONSOLE_PROTOCOL}/arcs/${m.arc}/graph`);assert.equal(response.status,200);const graph=(await response.json() as {data:GraphView}).data;
 const s=new Observations(absPath(m.hostDir),'design-fixture','reader').read({runDir:absPath(m.runDir),arc:arcId(m.arc)});
 assert.deepEqual(s.data.plan!.milestones!.map(g=>g.name),[0,2,5,7,9].map(i=>corpus.milestones[i].name));
 for(let i=1;i<=50;i++) {
  const expected=corpus.systems[m.systems[(i-1)%8]!][Math.floor((i-1)*38/50)];
  assert.equal(graph.units.find(u=>u.id===`u${i}`)!.title,expected.title);
 }
 const geometry=assertGraphGeometry(s);t.diagnostic(`50-unit layout + direct curves: ${geometry.elapsed.toFixed(1)}ms; ${geometry.curves} complete edges`);
 const units=s.data.plan!.units,distribution=Object.fromEntries([0,1,2,3].map(n=>[n,units.filter(u=>u.after.length===n).length]));
 assert.equal(m.dependencies,60);assert.deepEqual(distribution,{0:8,1:28,2:10,3:4});
 assert.ok(units.every(u=>u.after.length<=3),'no integration fan-in above three');
 const milestone=new Map(s.data.plan!.milestones!.flatMap((g,i)=>g.units.map(id=>[id,i] as const)));
 const split={same:0,previous:0,older:0};
 for(const u of units)for(const id of u.after){const distance=milestone.get(u.id)!-milestone.get(id)!;split[distance===0?'same':distance===1?'previous':'older']++;}
 assert.deepEqual(split,{same:43,previous:16,older:1});
 for(const gate of s.data.plan!.milestones!)assert.ok(gate.units.some(id=>units.find(u=>u.id===id)!.after.length===0),'each milestone contains an independent root');
 assert.ok(graph.units.some(u=>u.signal==='held'));
 assert.ok(s.data.display.status.units.some(u=>u.state==='cut'||u.state==='superseded'));
 assert.ok(invocationSummaries(s).some(a=>a.status==='failed'));
});
