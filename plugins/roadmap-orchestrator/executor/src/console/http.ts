import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { AbsPath } from '../core/values.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type ConsoleCode } from '../observation/protocol.ts';
import { consoleUrl } from './settings.ts';
import { staticResponse } from './static.ts';

const statuses: Record<ConsoleCode, number> = { reset: 409, conflict: 409, unavailable: 503, corruption: 500, protocol: 409, 'not-found': 404, invalid: 400 };
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
type Notice = { kind: string; invocation?: string; data?: unknown; arc?: string; epoch?: string; revision?: number; checkedAt?: string; error?: { code: ConsoleCode; message: string } };
export type ConsoleServerArgs = Readonly<{ repo: AbsPath; common: AbsPath; hostDir: AbsPath; host: string; port: number; instance?: string; onObservation?: (at: string) => void }>;
export async function serveConsole(args: ConsoleServerArgs) {
  const instance = args.instance ?? randomUUID();
  const repoId = sha256Hex(args.common);
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { ...args, onObservation: undefined, instance, repoId } });
  let next = 0;
  let failed: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const coalesced = new Map<string, Promise<unknown>>();
  const streams = new Map<ServerResponse, { arc: string; last: string; blocked: boolean; invocation?: string }>();
  function send(res: ServerResponse, event: string, data: unknown, id?: string) {
    const stream = streams.get(res)!;
    if (stream.blocked) { res.end(`event: reset\ndata: {"reason":"slow consumer"}\n\n`); streams.delete(res); return; }
    stream.blocked = !res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${canonicalJson(data)}\n\n`);
    if (stream.blocked) res.once('drain', () => { stream.blocked = false; });
  }
  worker.on('message', (m: Notice & { id?: number; value?: unknown }) => {
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id);
      if (m.error) p.reject(new ConsoleError(m.error.code, m.error.message)); else p.resolve(m.value);
      return;
    }
    if (m.checkedAt) args.onObservation?.(m.checkedAt);
    for (const [res, s] of streams) {
      if (m.arc && m.arc !== s.arc) continue;
      if (m.kind === 'history' || m.kind === 'history-error') { if (m.invocation === s.invocation) send(res, m.kind, m.data ?? m.error); }
      else if (m.kind === 'error') send(res, 'error', m.error);
      else if (m.kind === 'checked') {
        const id = `${m.epoch}:${m.revision}`;
        send(res, s.last === id ? 'heartbeat' : s.last && !s.last.startsWith(`${m.epoch}:`) ? 'reset' : 'revision', m, id);
        s.last = id;
      }
    }
  });
  const fail = (e: Error) => { failed = e; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new ConsoleError('unavailable', e.message)); } pending.clear(); };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`observation worker exited ${code}`)));
  function ask(message: object): Promise<unknown> {
    if (failed) return Promise.reject(new ConsoleError('unavailable', failed.message));
    const key = canonicalJson(message);
    const known = coalesced.get(key); if (known) return known;
    const id = ++next;
    const task = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ConsoleError('unavailable', 'console catch-up exceeded two seconds')); }, 2_000);
      pending.set(id, { resolve, reject, timer }); worker.postMessage({ ...message, id });
    }).finally(() => { coalesced.delete(key); });
    coalesced.set(key, task); return task;
  }
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('cache-control', 'no-store');
    const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : canonicalJson(data) + '\n'); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); json(405, { error: { code: 'invalid', message: 'GET/HEAD only' } }); return; }
    try {
      const raw = (req.url ?? '/').split('?')[0]!;
      const decoded = decodeURIComponent(raw);
      if (!decoded.startsWith('/') || /%2f|%5c/i.test(raw) || /[%\\\u0000-\u001f]/.test(decoded) || (decoded !== '/' && decoded.slice(1).split('/').some((s) => s === '.' || s === '..' || s === ''))) throw new ConsoleError('invalid', 'invalid path or encoded separator');
      const url = new URL(req.url ?? '/', 'http://console');
      if (decoded.startsWith('/api/')) {
        const [, , version, ...path] = decoded.split('/');
        if (version !== CONSOLE_PROTOCOL) throw new ConsoleError('protocol', 'console protocol/version mismatch; reload required');
        const params: Record<string, string> = {};
        for (const [key, value] of url.searchParams) { if (Object.hasOwn(params, key)) throw new ConsoleError('invalid', 'duplicate query parameter'); params[key] = value; }
        if (path.length === 3 && path[0] === 'runs' && path[2] === 'events') {
          const arc = path[1]!;
          const initial = await ask({ path: ['runs', arc, 'snapshot'], params }) as { epoch: string; revision: number; checkedAt: string };
          const invocation = params['invocation'];
          const page = invocation ? await ask({ path: ['runs', arc, 'invocations', invocation, 'history'], params: {} }) as { data: object } : null;
          if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
          if (invocation) await ask({ history: { arc, invocation } });
          await ask({ subscribe: arc });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
          const id = `${initial.epoch}:${initial.revision}`;
          const previous = req.headers['last-event-id'];
          streams.set(res, { arc, last: id, blocked: false, ...(invocation ? { invocation } : {}) });
          req.once('close', () => {
            streams.delete(res);
            if (invocation && ![...streams.values()].some(s => s.arc === arc && s.invocation === invocation)) void ask({ history: { arc, invocation, remove: true } }).catch(() => {});
            if (![...streams.values()].some(s => s.arc === arc)) void ask({ unsubscribe: arc }).catch(() => {});
          });
          send(res, previous && previous !== id ? 'reset' : 'revision', initial, id);
          if (page) send(res, 'history', { ...page.data, reset: true });
          return;
        }
        json(200, await ask({ path, params })); return;
      }
      if (await staticResponse(decoded, req, res)) return;
      throw new ConsoleError('not-found', 'unknown console asset');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const error = e instanceof ConsoleError ? e : new ConsoleError(e instanceof URIError ? 'invalid' : 'corruption', e instanceof Error ? e.message : String(e));
      json(statuses[error.code], { error: { code: error.code, message: error.message } });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(args.port, args.host, resolve); });
  } catch (error) {
    await worker.terminate();
    throw new Error(`.roadmap/config.json webConsole.port: console bind ${args.host}:${args.port} failed: ${(error as Error).message}`);
  }
  const url = consoleUrl(args.host, (server.address() as AddressInfo).port);
  return { server, url, instance, repoId, ask, async close() {
    for (const res of streams.keys()) res.end(); streams.clear();
    server.closeAllConnections();
    await Promise.all([new Promise<void>((r) => server.close(() => r())), worker.terminate()]);
  } };
}
