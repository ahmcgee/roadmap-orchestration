// Same real Chromium / Playwright MCP stdio setup as serial/walk-browser.test.ts.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { walkMcpConfig } from '../../src/backends/mcp.ts';
import { absPath } from '../../src/core/values.ts';
import { parseRepoConfig } from '../../src/routing/layers.ts';
const CONFIG = parseRepoConfig({ walkthrough: { mcp: { playwright: { command: 'playwright-mcp', args: ['--headless', '--isolated', '--browser', 'chromium', '--output-dir', '{evidence}', '--viewport-size', '{viewport}'] } } } });
export class ConsoleBrowser {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[] = [];
  #next = 0;
  #buf = '';
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(evidence: string, options: { settleMs?: number } = {}) {
    const config = JSON.parse(walkMcpConfig(CONFIG.walkthrough!.mcp, absPath(evidence))) as { mcpServers: { playwright: { command: string; args: string[]; env: Record<string, string> } } };
    const s = config.mcpServers.playwright;
    const args = options.settleMs === undefined ? s.args : [...s.args, '--timeout-settle', String(options.settleMs)];
    this.child = spawn(s.command, args, { env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.stderr.setEncoding('utf8').on('data', (d: string) => this.stderr.push(d));
    this.child.stdout.setEncoding('utf8').on('data', (d: string) => {
      this.#buf += d;
      let nl;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(this.#buf.slice(0, nl)) as { id?: number; result?: unknown; error?: unknown }; this.#buf = this.#buf.slice(nl + 1);
        if (m.id === undefined) continue;
        const p = this.#pending.get(m.id); if (!p) continue; this.#pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  request(method: string, params: object): Promise<unknown> {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} ${JSON.stringify(params).slice(0,600)} timed out: ${this.stderr.join('')}`)); }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'roadmap-console-browser-test', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async call(name: string, args: object) {
    const r = await this.request('tools/call', { name, arguments: args }) as { isError?: boolean; content: { text?: string }[] };
    if (r.isError) throw new Error(JSON.stringify(r));
    return r.content.map((c) => c.text ?? '').join('\n');
  }
  async evaluate<T>(code: string): Promise<T> {
    const result = await this.call('browser_evaluate', { function: code });
    const body = result.split('### Result\n')[1]?.split('\n### ')[0];
    if (!body) throw new Error(`no evaluation result: ${result}`);
    return JSON.parse(body) as T;
  }
  async accessibleSnapshot(path: string): Promise<string> {
    await this.call('browser_snapshot', { filename: path });
    return readFileSync(path, 'utf8');
  }
  /** Use the public graph search and keyboard selection to open a record. */
  async openUnit(id: string): Promise<void> {
    await this.evaluate(`() => { document.querySelector('[aria-label="Close details"]')?.click(); return true; }`);
    await this.call('browser_press_key', { key: '/' });
    const snapshot = await this.call('browser_snapshot', {});
    const row = snapshot.split('\n').find(line => line.includes('textbox "Search units"'));
    if (!row) throw new Error('Graph search is not available');
    const ref = /\[ref=(\w+)\]/.exec(row)![1];
    await this.call('browser_type', { element: 'Search units', target: ref, text: id });
    await this.call('browser_press_key', { key: 'Enter' });
    if (!await this.evaluate('()=>!!document.querySelector(".drawer")')) await this.call('browser_press_key', { key: 'Enter' });
  }
  async close() {
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error('browser closed')); } this.#pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.stdin.end();
    try { process.kill(-this.child.pid!, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await exited;
  }
}
