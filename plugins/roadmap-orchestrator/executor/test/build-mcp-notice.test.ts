import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from '../src/pipeline/stages.ts';
import {openNeedsUser, readNeedsUser} from '../src/needsuser.ts';
import {parseRepoConfig} from '../src/routing/layers.ts';
import {contextFor, setupArc} from './fixtures/unit-common.ts';
import {BUILD_REPORT, SCENARIO_TIMEOUT_MS, started} from './fixtures/stage-common.ts';

for (const configured of [true, false]) test(`build MCP init ${configured ? 'raises once and connected settles' : 'without walkthrough config raises nothing'}`, {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const d = setupArc({units:[{id:'u1'},{id:'u2'},{id:'u3'},{id:'u4'}], steps:['failed','failed','failed','connected'].map((status, n) => ({
    as:'claude', expect:{}, unit:`u${n + 1}`, acts:[
      {type:'stream',events:[{type:'system',subtype:'init', mcp_servers:[{name:'browser',status,error:n < 2 ? 'dependency missing' : 'command exited 7'}]}]},
      {type:'emit',value:BUILD_REPORT},
    ],
  }))});
  const config = parseRepoConfig({...d.config, routing:{seats:{build:{med:'frontier'}}},
    ...(configured ? {walkthrough:{mcp:{browser:{command:'pnpm',args:['exec','playwright-mcp']}}}} : {})});
  const r = contextFor({...d,config});
  const notices = () => r.journal.view.needsUser().flatMap((n) => {
    const item = readNeedsUser(r.ctx.runDir,n.id);
    return item?.reason === 'walkthrough-mcp' ? [item] : [];
  });
  try {
    for (const unit of ['u1','u2']) assert.equal(started(await build(r.ctx,r.unit(unit),{kind:'fresh'})).outcome.kind,'success');
    assert.equal(notices().length,configured ? 1 : 0);
    if (configured) {
      assert.equal(notices()[0]!.blocking,false);
      assert.deepEqual(notices()[0]!.subject,{type:'arc'});
      assert.match(notices()[0]!.summary,/browser.*failed.*pnpm.*exec.*playwright-mcp/s);
      assert.match(notices()[0]!.recommendation,/walkthrough.mcp/);
      assert.ok(openNeedsUser(r.journal.view).some((n) => n.id === notices()[0]!.id));
    }
    assert.equal(started(await build(r.ctx,r.unit('u3'),{kind:'fresh'})).outcome.kind,'success');
    assert.equal(notices().length,configured ? 2 : 0, 'a different error signature gets its own notice');
    assert.equal(started(await build(r.ctx,r.unit('u4'),{kind:'fresh'})).outcome.kind,'success');
    assert.ok(!openNeedsUser(r.journal.view).some((n) => notices().some((item) => item.id === n.id)), 'connected later explicitly settles the failed-init notice');
  } finally {r.journal.close();}
});

test('acting walk MCP init uses the same notice and settlement path', {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const {callActingJudge} = await import('../src/pipeline/dispatch.ts');
  const {freshJudgmentSession} = await import('../src/backends/argv.ts');
  const {walkMcpConfig} = await import('../src/backends/mcp.ts');
  const {jobId} = await import('../src/core/ids.ts');
  const {absPath, isoTimeOf} = await import('../src/core/values.ts');
  const d = setupArc({steps:['failed','connected'].map((status) => ({as:'claude',expect:{},acts:[
    {type:'stream',events:[{type:'system',subtype:'init',mcp_servers:[{name:'browser',status}]}]}, {type:'emit',value:{ok:true}},
  ]}))});
  const r = contextFor(d);
  try {
    for (const [n, status] of ['failed','connected'].entries()) {
      const result = await callActingJudge(r.ctx,{job:jobId('walk',n + 1),role:'experienceVerdict',attempt:1,
        system:'Run the fixture.',rendered:'Read the product.',prompt:null,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},
        cwd:absPath(d.repo),evidenceDirs:[],mcpConfig:walkMcpConfig({browser:{command:'pnpm',args:['exec','playwright-mcp'],env:{}}},absPath(d.runDir)),
        session:freshJudgmentSession(),deadlineAt:isoTimeOf(new Date(Date.now() + 30_000))});
      assert.equal(result.kind,'result');
      if (result.kind !== 'result') throw new Error(JSON.stringify(result));
      assert.equal(result.result.outcome.kind,'success');
      assert.equal(openNeedsUser(r.journal.view).length,status === 'failed' ? 1 : 0);
    }
    assert.equal(r.journal.view.needsUser().length,1);
  } finally {r.journal.close();}
});

test('a failed MCP init raises its notice while the Claude build is still running', {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const {dirname} = await import('node:path');
  const {reached, release} = await import('./helpers/barrier.ts');
  const {setTimeout: sleep} = await import('node:timers/promises');
  const d = setupArc({steps:[{as:'claude',expect:{},acts:[
    {type:'stream',events:[{type:'system',subtype:'init',mcp_servers:[{name:'browser',status:'failed'}]}]},
    {type:'barrier',name:'init-wait',timeoutMs:30_000}, {type:'emit',value:BUILD_REPORT},
  ]}]});
  const config = parseRepoConfig({...d.config,routing:{seats:{build:{med:'frontier'}}},walkthrough:{mcp:{browser:{command:'pnpm',args:['exec','playwright-mcp']}}}});
  const r = contextFor({...d,config});
  const pending = build(r.ctx,r.unit('u1'),{kind:'fresh'});
  try {
    await reached(dirname(d.scenarioPath),'init-wait',10_000);
    const deadline = Date.now() + 10_000;
    while (r.journal.view.needsUser().length === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(r.journal.view.needsUser().length,1,'init notice precedes the final report');
    assert.equal(r.journal.view.unit(r.unit('u1').id).decided,null);
  } finally {release(dirname(d.scenarioPath),'init-wait'); await pending; r.journal.close();}
});
