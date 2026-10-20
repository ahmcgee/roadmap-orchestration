// The M5 check's reflow oracle: renders the shelf's page `/` of a product tree at one SHA in the devcontainer's headless
// Chromium (Playwright's) at a phone's width and reads how wide the document lays out. WCAG 2.x 1.4.10 Reflow: at 320
// CSS px the page must not scroll horizontally, so `document.documentElement.scrollWidth` must not exceed the viewport.
//
// The tree is exported with `git archive` into a temp dir (the product repo is only read), served by its own
// `node src/server.js` on PORT=0 (it prints `swapshelf listening on http://127.0.0.1:<port>/`), and driven over the
// DevTools protocol through Node's global WebSocket. Every step has a deadline; the browser, the server and the temp dirs
// are always cleaned up. A tree whose server does not come up or whose page does not answer 200 is `unknown` (the lead
// adjudicates); a missing or misbehaving browser throws.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type Reflow =
  | Readonly<{ kind: 'measured'; scrollWidth: number; viewport: number; html: string }>
  | Readonly<{ kind: 'unknown'; detail: string }>;

const VIEWPORT = { width: 320, height: 640 } as const;
const STEP_MS = 30_000;

/** Playwright's Chromium in the devcontainer: exactly one `~/.cache/ms-playwright/chromium-<rev>/chrome-linux*\/chrome`. */
export function chromiumPath(): string {
  const root = join(homedir(), '.cache', 'ms-playwright');
  const found = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).flatMap((d) =>
    readdirSync(join(root, d)).filter((p) => p.startsWith('chrome-linux')).map((p) => join(root, d, p, 'chrome')).filter((p) => existsSync(p)));
  if (found.length !== 1) throw new Error(`expected one Playwright Chromium under ${root}, found ${JSON.stringify(found)}`);
  return found[0]!;
}

function within<T>(label: string, p: Promise<T>, ms = STEP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Spawns `cmd` in its own process group and resolves with the first match of `pattern` on stdout or stderr. */
function start(cmd: string, args: readonly string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }, pattern: RegExp): { child: ChildProcess; output: () => string; matched: Promise<string> } {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const matched = new Promise<string>((resolve, reject) => {
    const on = (d: Buffer) => {
      out += d.toString('utf8');
      const m = pattern.exec(out);
      if (m !== null) resolve(m[1]!);
    };
    child.stdout!.on('data', on);
    child.stderr!.on('data', on);
    child.on('error', reject);
    child.on('exit', (code, signal) => reject(new Error(`${cmd} exited ${code ?? signal} before it was ready`)));
  });
  return { child, output: () => out, matched };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGKILL');
  await within(`stopping pid ${child.pid}`, exited, 10_000);
}

/** A DevTools-protocol connection: `send` answers by id; `once` waits for the next event of a method on a session. */
class Cdp {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners: { method: string; sessionId: string | undefined; resolve: () => void }[] = [];
  private readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await within('the DevTools socket', new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    }));
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (e) => cdp.receive(JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; sessionId?: string }));
    return cdp;
  }

  private receive(m: { id?: number; result?: unknown; error?: { message: string }; method?: string; sessionId?: string }): void {
    if (m.id !== undefined) {
      const w = this.waiting.get(m.id);
      if (w === undefined) throw new Error(`DevTools answered unknown id ${m.id}`);
      this.waiting.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(`DevTools: ${m.error.message}`));
      else w.resolve(m.result);
      return;
    }
    for (const [i, l] of this.listeners.entries()) {
      if (l.method === m.method && l.sessionId === m.sessionId) {
        this.listeners.splice(i, 1);
        l.resolve();
        return;
      }
    }
  }

  send<R>(method: string, params: object = {}, sessionId?: string): Promise<R> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return within(method, new Promise<R>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (r: unknown) => void, reject })));
  }

  once(method: string, sessionId: string): Promise<void> {
    return new Promise((resolve) => this.listeners.push({ method, sessionId, resolve }));
  }

  close(): void {
    this.ws.close();
  }
}

/** Renders `/` of `product` at `sha` at 320 CSS px and measures its layout width. */
export async function reflowAt(product: string, sha: string): Promise<Reflow> {
  const tree = mkdtempSync(join(tmpdir(), 'm5-reflow-tree-'));
  const profile = mkdtempSync(join(tmpdir(), 'm5-reflow-profile-'));
  const children: ChildProcess[] = [];
  let cdp: Cdp | null = null;
  try {
    const archive = spawnSync('git', ['-C', product, 'archive', '--format=tar', sha], { maxBuffer: 1 << 30, timeout: STEP_MS });
    if (archive.status !== 0) throw new Error(`git archive ${sha} in ${product}: ${archive.error?.message ?? archive.stderr.toString('utf8')}`);
    const untar = spawnSync('tar', ['-x', '-C', tree], { input: archive.stdout, timeout: STEP_MS });
    if (untar.status !== 0) throw new Error(`tar -x into ${tree}: ${untar.error?.message ?? untar.stderr.toString('utf8')}`);

    const server = start(process.execPath, ['src/server.js'], { cwd: tree, env: { PATH: process.env['PATH'], HOME: process.env['HOME'], PORT: '0' } }, /swapshelf listening on (http:\/\/\S+)/);
    children.push(server.child);
    let base: string;
    try {
      base = await within('the product server', server.matched);
    } catch (error) {
      return { kind: 'unknown', detail: `the server at ${sha} did not come up (${(error as Error).message}): ${server.output().slice(-2000)}` };
    }
    const res = await within(`GET ${base}`, fetch(base));
    if (res.status !== 200) return { kind: 'unknown', detail: `GET / at ${sha} answered ${res.status}: ${(await res.text()).slice(0, 500)}` };

    const browser = start(chromiumPath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
      { env: process.env }, /DevTools listening on (ws:\/\/\S+)/);
    children.push(browser.child);
    cdp = await Cdp.open(await within('Chromium', browser.matched));
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: true }, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url: base }, sessionId);
    if (nav.errorText !== undefined) throw new Error(`navigating to ${base}: ${nav.errorText}`);
    await within(`the load of ${base}`, loaded);
    const expression = 'document.fonts.ready.then(() => JSON.stringify({ w: document.documentElement.scrollWidth, html: document.documentElement.outerHTML }))';
    const r = await cdp.send<{ result: { value: string }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails !== undefined) throw new Error(`measuring ${base}: ${r.exceptionDetails.text}`);
    const { w, html } = JSON.parse(r.result.value) as { w: number; html: string };
    return { kind: 'measured', scrollWidth: w, viewport: VIEWPORT.width, html };
  } finally {
    cdp?.close();
    for (const c of children.reverse()) await stop(c);
    rmSync(tree, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [product, sha] = process.argv.slice(2);
  if (product === undefined || sha === undefined) throw new Error('usage: node evals/m5/reflow.ts <product> <sha>');
  const r = await reflowAt(product, sha);
  process.stdout.write(`${JSON.stringify(r.kind === 'measured' ? { kind: r.kind, scrollWidth: r.scrollWidth, viewport: r.viewport } : r)}\n`);
}
