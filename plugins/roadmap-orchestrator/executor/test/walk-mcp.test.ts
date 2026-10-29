// dev.13 (agent A): the walkthrough MCP servers without a browser. The `--mcp-config` text and its substitutions
// (src/backends/mcp.ts), the acting-judge call's kept config and read surface (src/pipeline/dispatch.ts `actingJudgeCall`),
// the model-free MCP handshake against fake stdio servers (real processes), and the `walk-tools-missing` row's halves
// (src/preflight/walktools.ts). The real Playwright server is test/serial/walk-browser.test.ts's.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { freshJudgmentSession } from '../src/backends/argv.ts';
import { mcpHandshake, substituteWalkServer, walkMcpConfig } from '../src/backends/mcp.ts';
import { jobId, journeyId, milestoneId, serveName, unitId } from '../src/core/ids.ts';
import { absPath, isoTime, repoPath } from '../src/core/values.ts';
import type { Milestone } from '../src/input/plan.ts';
import { type ActingJudgeCallSpec, MCP_CONFIG_INPUT, actingJudgeCall, judgeSystem } from '../src/pipeline/dispatch.ts';
import { walkToolsRows } from '../src/preflight/walktools.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { tmpDir } from './helpers/repo.ts';

const EVIDENCE = absPath('/run/evidence/jobs/walk-1');

/** A fake stdio MCP server: `ok` (a notification, then the answer; with `child`, it first starts a sleeper and records its pid), `error`, `exit`, `silent`, `junk`. */
const FAKE_SERVER = `
const [mode, pidFile] = process.argv.slice(2);
if (mode === 'exit') { process.stderr.write('boom\\n'); process.exit(3); }
if (pidFile) { const c = require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); require('node:fs').writeFileSync(pidFile, String(c.pid)); }
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  if (req.method !== 'initialize' || req.params.protocolVersion === undefined) process.exit(9);
  if (mode === 'silent') return;
  if (mode === 'junk') { process.stdout.write('listening on stdio\\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} }) + '\\n');
  process.stdout.write(JSON.stringify(mode === 'error'
    ? { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unsupported' } }
    : { jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '0' } } }) + '\\n');
});
setInterval(() => {}, 1000);
`;

function fakeServer(): string {
  const dir = tmpDir('walk-mcp-fake');
  const script = join(dir, 'server.cjs');
  writeFileSync(script, FAKE_SERVER);
  return script;
}

const server = (script: string, ...args: string[]) => ({ command: process.execPath, args: [script, ...args], env: {} });

function milestone(id: number, bringUp: Partial<Milestone['bringUp']>, via: 'browser' | 'shell'): Milestone {
  return {
    id: milestoneId(`MS-${id}`), text: 'a flow', units: [unitId('u1')], design: { supplied: true }, references: [repoPath('design/ui')],
    bringUp: { setup: [], serve: [], env: {}, seed: [], ...bringUp }, journeys: [{ id: journeyId(`J-${id}`), text: 'signs in', via, entry: '/', budget: null }],
    resources: [],
  };
}

describe('walkthrough MCP config', () => {
  it('substitutes {evidence} and {viewport} in args and env values only, every occurrence', () => {
    const s = { command: '{evidence}/bin', args: ['--output-dir', '{evidence}', '--size={viewport}', '{evidence}:{evidence}', '{other}'], env: { OUT: '{evidence}/shots', V: '{viewport}' } };
    assert.deepEqual(substituteWalkServer(s, EVIDENCE), {
      command: '{evidence}/bin',
      args: ['--output-dir', EVIDENCE, '--size=1280x800', `${EVIDENCE}:${EVIDENCE}`, '{other}'],
      env: { OUT: `${EVIDENCE}/shots`, V: '1280x800' },
    });
  });

  it('writes every server as stdio, substituted, from the repo config', () => {
    const config = parseRepoConfig({
      walkthrough: { mcp: { playwright: { command: 'playwright-mcp', args: ['--headless', '--output-dir', '{evidence}', '--viewport-size', '{viewport}'] }, other: { command: 'x', env: { A: '{evidence}' } } } },
    });
    const text = walkMcpConfig(config.walkthrough!.mcp, EVIDENCE);
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(JSON.parse(text), {
      mcpServers: {
        playwright: { type: 'stdio', command: 'playwright-mcp', args: ['--headless', '--output-dir', EVIDENCE, '--viewport-size', '1280x800'], env: {} },
        other: { type: 'stdio', command: 'x', args: [], env: { A: EVIDENCE } },
      },
    });
  });

  it('an acting-judge call keeps its config under the run dir inputs and reads as a judgment does', () => {
    const runDir = absPath(tmpDir('walk-mcp-run'));
    const repo = absPath('/repo');
    const spec: ActingJudgeCallSpec = {
      job: jobId('walk', 1), role: 'walkthrough', attempt: 1, system: 'SYS', prompt: null, rendered: 'R', schema: { type: 'object' }, cwd: absPath('/wt/walk-1.walk'),
      evidenceDirs: [absPath(`${runDir}/evidence/jobs/walk-1`), absPath('/elsewhere')], mcpConfig: '{"mcpServers":{}}\n', deadlineAt: isoTime('2026-10-18T00:00:00.000Z'),
      session: freshJudgmentSession(),
    };
    const triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' } as const;
    const c = actingJudgeCall({ repo, runDir }, spec, triple);
    assert.ok(c.mcpConfig !== null && c.mcpConfig.startsWith(`${runDir}/inputs/`) && c.mcpConfig.endsWith(`.${MCP_CONFIG_INPUT}`), String(c.mcpConfig));
    assert.equal(readFileSync(c.mcpConfig, 'utf8'), '{"mcpServers":{}}\n');
    assert.deepEqual(c.evidenceDirs, [repo, runDir, '/elsewhere'], 'the repository, the run dir, then what neither covers');
    assert.equal(c.system, judgeSystem('SYS'), 'appended to the default prompt, which lists the dirs');
    assert.equal(actingJudgeCall({ repo, runDir }, { ...spec, mcpConfig: null }, triple).mcpConfig, null);
  });
});

describe('MCP handshake (no model call)', () => {
  const cwd = absPath(process.cwd());
  it('connects on a result, skipping notifications, and stops the server with what it started', async () => {
    const script = fakeServer();
    const pidFile = join(tmpDir('walk-mcp-pid'), 'pid');
    assert.deepEqual(await mcpHandshake(server(script, 'ok', pidFile), cwd, process.env), { ok: true });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH', 'the server process group is gone');
  });

  it('names why a server did not connect', async () => {
    const script = fakeServer();
    const err = await mcpHandshake(server(script, 'error'), cwd, process.env);
    assert.ok(!err.ok && /error: .*unsupported/.test(err.detail), JSON.stringify(err));
    const exit = await mcpHandshake(server(script, 'exit'), cwd, process.env);
    assert.ok(!exit.ok && /exited 3 before answering initialize; stderr: boom/.test(exit.detail), JSON.stringify(exit));
    const junk = await mcpHandshake(server(script, 'junk'), cwd, process.env);
    assert.ok(!junk.ok && /not JSON-RPC: listening on stdio/.test(junk.detail), JSON.stringify(junk));
    const silent = await mcpHandshake(server(script, 'silent'), cwd, process.env, 500);
    assert.ok(!silent.ok && /no answer to initialize within 500 ms/.test(silent.detail), JSON.stringify(silent));
    const missing = await mcpHandshake({ command: 'roadmap-no-such-mcp-server', args: [], env: {} }, cwd, process.env);
    assert.ok(!missing.ok && /did not start: .*ENOENT/.test(missing.detail), JSON.stringify(missing));
  });
});

describe('walk-tools-missing', () => {
  const repo = absPath(process.cwd());
  it('names every bring-up program that does not resolve, by step; a checkout file is not checked', async () => {
    const m = milestone(1, {
      setup: [['node', '--version'], ['roadmap-no-such-setup']], serve: [{ name: serveName('web'), argv: ['roadmap-no-such-server'], ready: { http: 'http://127.0.0.1:{port:web}/' } }],
      seed: [['./scripts/seed.sh'], ['roadmap-no-such-seed', 'x']],
    }, 'shell');
    assert.deepEqual(await walkToolsRows({ milestones: [m] }, null, repo, process.env), [
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'program', step: 'setup[1]', argv0: 'roadmap-no-such-setup' } },
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'program', step: 'serve.web', argv0: 'roadmap-no-such-server' } },
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'program', step: 'seed[1]', argv0: 'roadmap-no-such-seed' } },
    ]);
    // The bring-up's own PATH is where its programs resolve.
    const pathed = milestone(2, { setup: [['node']], env: { PATH: '/nonexistent' } }, 'shell');
    assert.deepEqual((await walkToolsRows({ milestones: [pathed] }, null, repo, process.env)).map((r) => r.problem), [{ type: 'program', step: 'setup[0]', argv0: 'node' }]);
  });

  it('a browser journey needs configured servers that connect; a shell-only milestone needs none', async () => {
    const script = fakeServer();
    const browser = milestone(1, {}, 'browser');
    const shell = milestone(2, {}, 'shell');
    assert.deepEqual(await walkToolsRows({ milestones: [browser, shell] }, null, repo, process.env), [
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'mcp-unconfigured' } },
    ]);
    const good = parseRepoConfig({ walkthrough: { mcp: { fake: server(script, 'ok') } } });
    assert.deepEqual(await walkToolsRows({ milestones: [browser, shell] }, good, repo, process.env), []);
    const bad = parseRepoConfig({ walkthrough: { mcp: { fake: server(script, 'ok'), broken: server(script, 'exit') } } });
    const rows = await walkToolsRows({ milestones: [browser, shell] }, bad, repo, process.env);
    assert.equal(rows.length, 1);
    const p = rows[0]!.problem;
    assert.ok(rows[0]!.milestone === 'MS-1' && p.type === 'mcp-unconnected' && p.server === 'broken' && /exited 3/.test(p.detail), JSON.stringify(rows));
  });
});
