// dev.13 (agent A), the browser-real test: no model. The environment's Playwright MCP server (`playwright-mcp`, installed
// globally in the devcontainer with Playwright's Chromium) is spawned exactly as the repo config names it, with code's
// substitutions (src/backends/mcp.ts), and driven over MCP stdio as a walk session would drive it: navigate to a page
// served over HTTP from a temp dir (the server refuses file: URLs), take a screenshot, and the PNG lands in the evidence
// dir. Then the `walk-tools-missing` row both ways against the real server: through `walkToolsRows` and through `phase0
// check --plan` on a corpus arc. Serial tier: it starts a real browser.
import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { substituteWalkServer, walkMcpConfig } from '../../src/backends/mcp.ts';
import { journeyId, milestoneId, unitId } from '../../src/core/ids.ts';
import { absPath, repoPath } from '../../src/core/values.ts';
import type { PlanM1 } from '../../src/input/plan.ts';
import { walkToolsRows } from '../../src/preflight/walktools.ts';
import { parseRepoConfig } from '../../src/routing/layers.ts';
import { check, corpusArc } from '../helpers/corpusarc.ts';
import { tmpDir } from '../helpers/repo.ts';

const T = { timeout: 120_000 };
/** This repo's server, as `.roadmap/config.json` names it (SCHEMAS.md "dev.13", reference.md). */
const PLAYWRIGHT = { command: 'playwright-mcp', args: ['--headless', '--isolated', '--browser', 'chromium', '--output-dir', '{evidence}', '--viewport-size', '{viewport}'] };
const CONFIG = parseRepoConfig({ walkthrough: { mcp: { playwright: PLAYWRIGHT } } });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A minimal MCP client over a spawned server's stdio: newline-delimited JSON-RPC requests, answers by id. */
class McpClient {
  private next = 1;
  private buf = '';
  private readonly waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  readonly stderr: string[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(this.buf.slice(0, nl)) as { id?: number; result?: unknown; error?: unknown };
        this.buf = this.buf.slice(nl + 1);
        if (typeof m.id === 'number') this.waiting.get(m.id)?.(m);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => this.stderr.push(d));
  }
  request(method: string, params: object): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error === undefined ? resolve(m.result) : reject(new Error(`${method}: ${JSON.stringify(m.error)}`))));
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end();
    try {
      process.kill(-this.child.pid!, 'SIGTERM');
    } catch { /* already gone */ }
    await exited;
  }
}

function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : (req.url ?? '').slice(1);
    try {
      const body = readFileSync(join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A milestone of the corpus arc's one unit, walked in a browser, its bring-up `setup` as given. */
function browserMilestone(setup: readonly (readonly string[])[]) {
  return {
    id: 'MS-1', text: 'Book a berth end to end', units: ['u1'], design: { supplied: true }, references: ['design/booking'],
    bringUp: { setup, serve: [], env: {}, seed: [] }, journeys: [{ id: 'J-1', text: 'books a berth', via: 'browser', entry: '/', budget: null }], resources: [],
  };
}

describe('the browser drive (real Playwright MCP, no model)', () => {
  const servers: Server[] = [];
  const clients: McpClient[] = [];
  after(async () => {
    for (const c of clients) await c.close();
    for (const s of servers) s.close();
  });

  it('walk.browser-real: the configured server, substituted, navigates an HTTP page and screenshots into the evidence dir', T, async () => {
    const site = tmpDir('walk-site');
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>Berths</title><h1>Book a berth</h1><button>Book</button>\n');
    const http = await serve(site);
    servers.push(http);
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    const evidence = absPath(tmpDir('walk-evidence'));
    // What the session's --mcp-config holds is what this test spawns.
    const config = JSON.parse(walkMcpConfig(CONFIG.walkthrough!.mcp, evidence)) as { mcpServers: { playwright: { type: string; command: string; args: string[]; env: Record<string, string> } } };
    const s = config.mcpServers.playwright;
    assert.deepEqual(s, { type: 'stdio', ...substituteWalkServer({ ...PLAYWRIGHT, env: {} }, evidence) });
    assert.ok(s.args.includes(evidence) && s.args.includes('1280x800'));
    const client = new McpClient(spawn(s.command, s.args, { cwd: site, env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
    clients.push(client);
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'walk-browser-test', version: '1' } }) as { capabilities: object };
    assert.ok('tools' in init.capabilities, JSON.stringify(init));
    client.notify('notifications/initialized');
    const tools = await client.request('tools/list', {}) as { tools: { name: string }[] };
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('browser_navigate') && names.includes('browser_take_screenshot'), names.join(' '));
    const nav = await client.request('tools/call', { name: 'browser_navigate', arguments: { url } }) as { content: { text?: string }[]; isError?: boolean };
    assert.ok(nav.isError !== true && JSON.stringify(nav.content).includes('Page Title: Berths'), `${JSON.stringify(nav)}\n${client.stderr.join('')}`);
    // Without a filename the screenshot goes to --output-dir, the evidence dir; a relative filename would resolve against
    // the server's cwd (the checkout), so a named one is passed absolute (reference.md's gotcha).
    const unnamed = await client.request('tools/call', { name: 'browser_take_screenshot', arguments: { type: 'png' } }) as { isError?: boolean };
    assert.ok(unnamed.isError !== true, JSON.stringify(unnamed));
    const named = join(evidence, 'home.png');
    const shot = await client.request('tools/call', { name: 'browser_take_screenshot', arguments: { type: 'png', filename: named } }) as { isError?: boolean };
    assert.ok(shot.isError !== true, JSON.stringify(shot));
    const pngs = readdirSync(evidence).filter((f) => f.endsWith('.png'));
    assert.equal(pngs.length, 2, `evidence dir holds ${pngs.join(', ')}`);
    assert.ok(pngs.includes('home.png'));
    for (const f of pngs) assert.deepEqual(readFileSync(join(evidence, f)).subarray(0, 8), PNG_MAGIC, f);
    assert.deepEqual(readdirSync(site), ['index.html'], 'nothing written into the served tree');
    await client.close();
  });

  it('walk-tools-missing both ways against the real server', T, async () => {
    const repo = absPath(process.cwd());
    const plan = (setup: readonly (readonly string[])[]): Pick<PlanM1, 'milestones'> => ({
      milestones: [{
        id: milestoneId('MS-1'), text: 't', units: [unitId('u1')], design: { supplied: true }, references: [repoPath('design/ui')], resources: [],
        bringUp: { setup, serve: [], env: {}, seed: [] }, journeys: [{ id: journeyId('J-1'), text: 'x', via: 'browser', entry: '/', budget: null }],
      }],
    });
    assert.deepEqual(await walkToolsRows(plan([['node', '--version']]), CONFIG, repo, process.env), [], 'the real server connects');
    const missing = parseRepoConfig({ walkthrough: { mcp: { playwright: { ...PLAYWRIGHT, command: 'roadmap-no-such-playwright-mcp' } } } });
    const rows = await walkToolsRows(plan([['roadmap-no-such-tool']]), missing, repo, process.env);
    assert.deepEqual(rows.map((r) => r.problem.type), ['program', 'mcp-unconnected']);
    assert.deepEqual(rows[0]!.problem, { type: 'program', step: 'setup[0]', argv0: 'roadmap-no-such-tool' });
    const p = rows[1]!.problem;
    assert.ok(p.type === 'mcp-unconnected' && p.server === 'playwright' && /ENOENT/.test(p.detail), JSON.stringify(p));
  });

  it('phase0 check --plan reports walk-tools-missing for a browser milestone, and passes it once the environment provides the drive', T, async () => {
    const green = await corpusArc({ config: { chain: { k: 1 }, walkthrough: { mcp: { playwright: PLAYWRIGHT } } }, plan: { milestones: [browserMilestone([['node', '--version']])] } });
    const ok = await check(green);
    assert.deepEqual(ok.rows.filter((r) => r.kind === 'walk-tools-missing'), [], JSON.stringify(ok.rows));
    const bare = await corpusArc({ plan: { milestones: [browserMilestone([['roadmap-no-such-tool', 'x']])] } });
    const refused = await check(bare);
    assert.deepEqual(refused.rows.filter((r) => r.kind === 'walk-tools-missing'), [
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'program', step: 'setup[0]', argv0: 'roadmap-no-such-tool' } },
      { kind: 'walk-tools-missing', milestone: 'MS-1', problem: { type: 'mcp-unconfigured' } },
    ]);
  });
});
