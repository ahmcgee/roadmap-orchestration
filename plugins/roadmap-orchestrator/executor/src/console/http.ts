import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { AbsPath } from '../core/values.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type ConsoleCode } from '../observation/protocol.ts';
import { consoleUrl, ConsoleBindError } from './settings.ts';
import { SseWriter, errorNotice } from './sse.ts';
import type { ConsoleRequest } from './messages.ts';
import { staticResponse } from './static.ts';
import { BrowserPreparation, PREPARATION } from './preparation.ts';
import type { Metadata } from './view-protocol.ts';

const statuses: Record<ConsoleCode, number> = { reset: 409, conflict: 409, unavailable: 503, corruption: 500, protocol: 409, 'not-found': 404, invalid: 400 };
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
type Notice = Partial<Metadata> & { kind: string; message?: string; invocation?: string; data?: unknown; arc?: string; epoch?: string; revision?: number; checkedAt?: string; error?: { code: ConsoleCode; message: string } };
export type ConsoleServerArgs = Readonly<{ repo: AbsPath; common: AbsPath; hostDir: AbsPath; host: string; port: number; instance?: string }>;
export async function serveConsole(args: ConsoleServerArgs) {
  const instance = args.instance ?? randomUUID();
  const repoId = sha256Hex(args.common);
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { ...args, instance, repoId } });
  // The worker says `ready` once it has loaded and made its first check. A read's budget (two seconds strict, thirty for a
  // browser) is for catching up with the arc, so it starts then: on a busy host, loading the worker (the executor's whole module
  // graph) can take longer than two seconds by itself. A worker that fails first releases the waiting reads as unavailable.
  let admitting = false, admit!: () => void;
  const ready = new Promise<void>(resolve => { admit = () => { admitting = true; resolve(); }; });
  let next = 0;
  let failed: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const coalesced = new Map<string, Promise<unknown>>();
  const preparation = new BrowserPreparation();
  const latest = new Map<string, Metadata>();
  const connections = new Map<ServerResponse, { arc: string; invocation?: string }>();
  const streams = new Map<ServerResponse, { arc: string; last: string; writer: SseWriter; invocation?: string }>();
  function send(res: ServerResponse, event: string, data: unknown, id?: string) { streams.get(res)?.writer.send(event,data,id); }
  const historyNotice = (data: unknown) => {
    const d=data as {invocation:string;identity:string;cursor:number;state:string;endedAt:string|null;reset?:boolean;events?:unknown[]};
    return {invocation:d.invocation,identity:d.identity,cursor:d.cursor,state:d.state,endedAt:d.endedAt,reset:d.reset??false,changed:d.events?.length??0};
  };
  worker.on('message', (m: Notice & { id?: number; value?: unknown }) => {
    if (m.kind === 'ready') { admit(); return; }
    // The worker says when it falls behind an arc, and when it catches up, once each: the console log is stderr.
    if (m.kind === 'log') { process.stderr.write(`${new Date().toISOString()} ${m.message}\n`); return; }
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(m.id);
      if (m.error) p.reject(new ConsoleError(m.error.code, m.error.message)); else p.resolve(m.value);
      return;
    }
    if (m.kind === 'checked' && m.arc) {
      latest.delete(m.arc); latest.set(m.arc, m as Metadata);
      while (latest.size > 24) latest.delete(latest.keys().next().value!);
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
  const fail = (e: Error) => { failed = e; admit(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new ConsoleError('unavailable', e.message)); } pending.clear(); };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`observation worker exited ${code}`)));
  function ask(message: ConsoleRequest, timeoutMs = 2_000): Promise<unknown> {
    // Asks made before then wait in order, so control messages keep theirs.
    if (!admitting) return ready.then(() => ask(message, timeoutMs));
    if (failed) return Promise.reject(new ConsoleError('unavailable', failed.message));
    // Coalesce reads only. Subscription mutations must preserve add/remove/add order.
    const key = message.kind === 'read' ? `${timeoutMs}:${canonicalJson(message)}` : `control:${next + 1}`;
    const known = coalesced.get(key); if (known) return known;
    const id = ++next;
    const task = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ConsoleError('unavailable', timeoutMs === 2_000 ? 'console catch-up exceeded two seconds' : 'browser preparation exceeded thirty seconds; retry')); }, timeoutMs);
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
        const params: Record<string, string> = Object.create(null);
        for (const [key, value] of url.searchParams) { if (Object.hasOwn(params, key)) throw new ConsoleError('invalid', 'duplicate query parameter'); params[key] = value; }
        if (path.length === 3 && path[0] === 'arcs' && path[2] === 'events') {
          const arc = path[1]!;
          const invocation = params['invocation'];
          connections.set(res, { arc, ...(invocation ? { invocation } : {}) });
          const cleanup = () => {
            streams.delete(res); connections.delete(res);
            if (invocation && ![...connections.values()].some(s => s.arc === arc && s.invocation === invocation)) void ask({ kind: 'history-unsubscribe', arc, invocation }).catch(() => {});
            if (![...connections.values()].some(s => s.arc === arc)) void ask({ kind: 'unsubscribe', arc }).catch(() => {});
          };
          const closed = () => req.destroyed || res.closed;
          // Catch disconnects even while the worker is still catching up. A completed await can have
          // installed a subscription after close, so every boundary checks and cleans up again.
          res.once('close', cleanup);
          let ready = false;
          try {
            const page = invocation ? await ask({ kind: 'read', path: ['arcs', arc, 'invocations', invocation, 'history'], params: {}, patient: true }, PREPARATION.lifetimeMs) as { data: object } : null;
            if (closed()) return;
            if (invocation && req.method !== 'HEAD') await ask({ kind: 'history-subscribe', arc, invocation }, PREPARATION.lifetimeMs);
            if (closed()) return;
            const registered = await ask({ kind: 'subscribe', arc, params }, PREPARATION.lifetimeMs) as Metadata;
            if (closed()) return;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
            if (req.method === 'HEAD') { res.end(); return; }
            // A newer checked notice may arrive between the worker reply and this continuation.
            const checked = latest.get(arc);
            const initial = checked && Date.parse(checked.checkedAt) >= Date.parse(registered.checkedAt) ? checked : registered;
            const id = `${initial.epoch}:${initial.revision}`;
            const previous = req.headers['last-event-id'];
            streams.set(res, { arc, last: id, writer: new SseWriter(res), ...(invocation ? { invocation } : {}) });
            ready = true;
            send(res, previous && previous !== id ? 'reset' : 'revision', initial, id);
            if (page) send(res, 'history', historyNotice({ ...page.data, reset: true }));
            return;
          } finally { if (!ready || closed()) cleanup(); }
        }
        // Status and API discovery keep strict two-second admission. Existing selected
        // unit/invocation API consumers may opt into browser preparation.
        // Typed view endpoints always use preparation. Browser reads have a
        // bounded delivery lease; pending/cancel are never forwarded as worker query filters.
        const selectedEvidence = ['units', 'invocations'].includes(path[2] ?? '');
        const browserDiscovery = path.length === 1 && path[0] === 'arcs' && req.headers['prefer'] === 'respond-async';
        const uiRead = browserDiscovery || path[0] === 'arcs' && path.length >= 3 && path[2] !== 'status'
          && (!selectedEvidence || req.headers['prefer'] === 'respond-async');
        if (uiRead) {
          const {pending: token, cancel, ...query} = params;
          if (cancel !== undefined && cancel !== '1') throw new ConsoleError('invalid', 'cancel is 1');
          const controller = new AbortController();
          const aborted = () => { if (!res.writableFinished) controller.abort(); };
          res.once('close', aborted);
          try {
            const result = await preparation.read({instance, path, params: query}, () => ask({kind: 'read', path, params: query, patient: true}, PREPARATION.lifetimeMs), controller.signal, token, cancel === '1');
            if (controller.signal.aborted) return;
            if (result.state === 'preparing') {
              res.setHeader('retry-after', '1');
              json(202, {protocol: CONSOLE_PROTOCOL, arc: path[1] ?? null, ...result});
            } else json(200, cancel === '1' ? {protocol: CONSOLE_PROTOCOL, arc: path[1] ?? null, state: 'cancelled'} : result.value);
          } finally { res.removeListener('close', aborted); }
        } else {
          if ('pending' in params || 'cancel' in params) throw new ConsoleError('invalid', 'preparation is only available for browser reads');
          json(200, await ask({ kind: 'read', path, params }));
        }
        return;
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
    preparation.close(); await worker.terminate();
    throw new ConsoleBindError(args.host, args.port, (error as Error).message);
  }
  const port = (server.address() as AddressInfo).port;
  const url = consoleUrl(args.host, port);
  return { server, port, url, instance, repoId, ask, async close() {
    preparation.close();
    for (const res of streams.keys()) res.end(); streams.clear();
    server.closeAllConnections();
    await Promise.all([new Promise<void>((r) => server.close(() => r())), worker.terminate()]);
  } };
}
