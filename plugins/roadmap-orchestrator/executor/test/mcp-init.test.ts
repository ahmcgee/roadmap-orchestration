import assert from 'node:assert/strict';
import {appendFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {freshClaudeImplementerSession} from '../src/backends/argv.ts';
import {readClaudeMcp} from '../src/backends/claude.ts';
import {MalformedOutputError} from '../src/backends/errors.ts';
import {routingRev} from '../src/core/ids.ts';
import {openJournal} from '../src/core/log.ts';
import {absPath} from '../src/core/values.ts';
import {inspectMcpInit, mcpInitInspector} from '../src/pipeline/mcp-notices.ts';
import {prepareLaunch} from '../src/runner/launch.ts';
import {launchBase, newInvocation} from './helpers/invocation.ts';

const init = (servers?: unknown) => JSON.stringify({type:'system',subtype:'init',...(servers === undefined ? {} : {mcp_servers:servers})}) + '\n';

test('Claude MCP parsing stops at first init, including an init without a census', () => {
  const servers = [{name:'browser',status:'connected'}];
  assert.deepEqual(readClaudeMcp('{"type":"assistant"}\n' + init(servers) + 'malformed tail\n'),
    {servers:[{name:'browser',status:'connected',error:null}]});
  assert.deepEqual(readClaudeMcp(init() + init(servers)),{servers:null});
  assert.equal(readClaudeMcp(init(servers).trimEnd()),null,'torn init is not a complete event');
  assert.throws(() => readClaudeMcp('malformed prefix\n' + init(servers)),MalformedOutputError);
  assert.throws(() => readClaudeMcp(init([{name:'browser',status:'connected'},{name:'browser',status:'failed'}])),/invalid or repeated MCP/);
});

function setup() {
  const inv = newInvocation();
  const stdout = absPath(join(inv.root,'stdout'));
  const config = absPath(join(inv.root,'mcp.json'));
  writeFileSync(config,JSON.stringify({mcpServers:{browser:{command:'browser-mcp',args:[],env:{}}}}));
  const launch = prepareLaunch({...launchBase(inv,{argv:['claude','--mcp-config',config]}), terminal:{type:'backend',purpose:'backend',role:'build',
    session:freshClaudeImplementerSession(),routingRev:routingRev('0123456789abcdef'),schemaPath:absPath(join(inv.root,'schema.json')),outputPath:stdout}});
  const journal = openJournal(inv.root,inv.arc);
  const ctx = {journal,runDir:inv.root};
  return {stdout,launch,journal,ctx,inspect:mcpInitInspector(ctx,launch)};
}

test('MCP cursor retains partial lines and split UTF-8, then stops before the growing tail', () => {
  const r = setup();
  try {
    assert.equal(r.inspect(),false,'stdout does not exist yet');
    writeFileSync(r.stdout,'{"type":"assistant"}\n');
    assert.equal(r.inspect(),false);
    const error = '界'.repeat(3000);
    const bytes = Buffer.from(init([{name:'browser',status:'failed',error}]));
    for (let start = 0; start < bytes.length; start += 1024) {
      appendFileSync(r.stdout,bytes.subarray(start,Math.min(start + 1024,bytes.length)));
      assert.equal(r.inspect(),start + 1024 >= bytes.length);
    }
    assert.equal(r.journal.view.walkMcp().length,1);
    const connection = r.journal.view.walkMcp()[0]!.connection;
    assert.equal(connection.type,'unavailable');
    if (connection.type === 'unavailable') assert.equal(connection.error,error);
    appendFileSync(r.stdout,'malformed tail\n'.repeat(10_000));
    assert.equal(r.inspect(),true);
    assert.equal(inspectMcpInit(r.ctx,r.launch),true,'recovery reads only the prefix through init');
    assert.equal(r.journal.view.walkMcp().length,1,'recovery does not duplicate notices');
    assert.equal(r.journal.view.needsUser().length,1);
  } finally {r.journal.close();}
});

for (const stream of [init(), 'not json\n']) test(`MCP cursor stops after ${stream.startsWith('{') ? 'init without census' : 'malformed output'}`, () => {
  const r = setup();
  try {
    writeFileSync(r.stdout,stream);
    assert.equal(r.inspect(),true);
    appendFileSync(r.stdout,init([{name:'browser',status:'failed'}]));
    assert.equal(r.inspect(),true);
    assert.equal(r.journal.view.walkMcp().length,0);
    assert.equal(r.journal.view.needsUser().length,0);
  } finally {r.journal.close();}
});
