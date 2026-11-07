import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { AbsPath } from '../core/values.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type ConsoleCode } from '../observation/protocol.ts';
import { consoleUrl, ConsoleBindError } from './settings.ts';
import { SseWriter, errorNotice } from './sse.ts';
import { staticResponse } from './static.ts';

const statuses: Record<ConsoleCode, number> = { reset: 409, conflict: 409, unavailable: 503, corruption: 500, protocol: 409, 'not-found': 404, invalid: 400 };
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
type Notice = { kind: string; invocation?: string; data?: unknown; arc?: string; epoch?: string; revision?: number; checkedAt?: string; error?: { code: ConsoleCode; message: string } };
export type ConsoleServerArgs = Readonly<{ repo: AbsPath; common: AbsPath; hostDir: AbsPath; host: string; port: number; instance?: string }>;
export async function serveConsole(args: ConsoleServerArgs) {
  const instance = args.instance ?? randomUUID();
  const repoId = sha256Hex(args.common);
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { ...args, instance, repoId } });
  let next = 0;
  let failed: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const coalesced = new Map<string, Promise<unknown>>();
  const connections = new Map<ServerResponse, { arc: string; invocation?: string }>();
  const streams = new Map<ServerResponse, { arc: string; last: string; writer: SseWriter; invocation?: string }>();
  function send(res: ServerResponse, event: string, data: unknown, id?: string) { streams.get(res)?.writer.send(event,data,id); }
  const historyNotice = (data: unknown) => {
    const d=data as {invocation:string;identity:string;cursor:number;state:string;endedAt:string|null;reset?:boolean;events?:unknown[]};
    return {invocation:d.invocation,identity:d.identity,cursor:d.cursor,state:d.state,endedAt:d.endedAt,reset:d.reset??false,changed:d.events?.length??0};
  };
  worker.on('message', (m: Notice & { id?: number; value?: unknown }) => {
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id);
      if (m.error) p.reject(new ConsoleError(m.error.code, m.error.message)); else p.resolve(m.value);
      return;
    }
    for (const [res, s] of streams) {
      if (m.arc && m.arc !== s.arc) continue;
      if (m.kind === 'history' || m.kind === 'history-error') { if (m.invocation === s.invocation) send(res, m.kind, m.kind === 'history' ? historyNotice(m.data) : errorNotice(m.error!)); }
      else if (m.kind === 'error') send(res, 'error', errorNotice(m.error!));
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
    // Coalesce reads only. Subscription mutations must preserve add/remove/add order.
    const key = 'path' in message ? canonicalJson(message) : `control:${next + 1}`;
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
          const invocation = params['invocation'];
          connections.set(res, { arc, ...(invocation ? { invocation } : {}) });
          const cleanup = () => {
            streams.delete(res); connections.delete(res);
            if (invocation && ![...connections.values()].some(s => s.arc === arc && s.invocation === invocation)) void ask({ history: { arc, invocation, remove: true } }).catch(() => {});
            if (![...connections.values()].some(s => s.arc === arc)) void ask({ unsubscribe: arc }).catch(() => {});
          };
          const closed = () => req.destroyed || res.closed;
          // Catch disconnects even while the worker is still catching up. A completed await can have
          // installed a subscription after close, so every boundary checks and cleans up again.
          res.once('close', cleanup);
          let ready = false;
          try {
            const initial = await ask({ path: ['runs', arc, 'snapshot'], params }) as { epoch: string; revision: number; checkedAt: string; highWater: number };
            if (closed()) return;
            const page = invocation ? await ask({ path: ['runs', arc, 'invocations', invocation, 'history'], params: {} }) as { data: object } : null;
            if (closed()) return;
            if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
            if (invocation) await ask({ history: { arc, invocation } });
            if (closed()) return;
            await ask({ subscribe: arc });
            if (closed()) return;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
            const id = `${initial.epoch}:${initial.revision}`;
            const previous = req.headers['last-event-id'];
            streams.set(res, { arc, last: id, writer: new SseWriter(res), ...(invocation ? { invocation } : {}) });
            ready = true;
            send(res, previous && previous !== id ? 'reset' : 'revision', {arc,epoch:initial.epoch,revision:initial.revision,checkedAt:initial.checkedAt,highWater:initial.highWater}, id);
            if (page) send(res, 'history', historyNotice({ ...page.data, reset: true }));
            return;
          } finally { if (!ready || closed()) cleanup(); }
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
    throw new ConsoleBindError(args.host, args.port, (error as Error).message);
  }
  const port = (server.address() as AddressInfo).port;
  const url = consoleUrl(args.host, port);
  return { server, port, url, instance, repoId, ask, async close() {
    for (const res of streams.keys()) res.end(); streams.clear();
    server.closeAllConnections();
    await Promise.all([new Promise<void>((r) => server.close(() => r())), worker.terminate()]);
  } };
}
