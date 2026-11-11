import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MessageChannel, Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Run } from '../cli/locate.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { CaptureWork, CollectorPhase } from '../observation/collect.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type ConsoleCode } from '../observation/protocol.ts';
import { consoleUrl, ConsoleBindError } from './settings.ts';
import { SseWriter, errorNotice } from './sse.ts';
import type { CollectorReport } from './collector.ts';
import { MAINTAIN, type ConsoleRequest, type FromServe, type ToCollector, type ToServe } from './messages.ts';
import { staticResponse } from './static.ts';
import { BrowserPreparation, PREPARATION } from './preparation.ts';
import type { Metadata } from './view-protocol.ts';

const statuses: Record<ConsoleCode, number> = { reset: 409, conflict: 409, unavailable: 503, corruption: 500, protocol: 409, 'not-found': 404, invalid: 400 };
export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
/** The two read budgets and what a read that ran out of one answers. */
export const BUDGETS = {
  strictMs: 2_000, strict: 'console has not verified the arc since this request arrived',
  browserMs: PREPARATION.lifetimeMs, browser: 'browser preparation exceeded thirty seconds; retry',
} as const;
/** A worker that exits is started again after these delays, then the last one each time. */
export const RESTART_MS = [5_000, 30_000, 60_000] as const;
/** A read's reply: its response body as the serve worker serialized it. */
type Reply = Readonly<{ json: string; checkedAt: string | null }>;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null; timeoutMs: number; strict: boolean };
/** One arc's collector as main runs it, and what it last said. */
type Collector = { worker: Worker; run: Run; phase: CollectorPhase; phaseAt: number; done: number; of: number; captures: CaptureWork[]; seq: number; offset: number };
/** What the console did for one arc: each capture's work since its collector started (the last 200), and where it stands. */
export type ArcStats = Readonly<{ captures: readonly CaptureWork[]; phase: CollectorPhase; seq: number; offset: number }>;

export type ConsoleServerArgs = Readonly<{ repo: AbsPath; common: AbsPath; hostDir: AbsPath; host: string; port: number; instance?: string }>;
export async function serveConsole(args: ConsoleServerArgs) {
  const instance = args.instance ?? randomUUID();
  const repoId = sha256Hex(args.common);
  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  // The serve worker says `ready` once it has loaded. A strict read's two seconds are for catching up with the arc, so they
  // start then, or (for an arc not yet observed) at that arc's first observation: loading a worker (the executor's whole
  // module graph) can take longer than two seconds by itself on a busy host. A worker that fails first releases the reads.
  let admitting = false, admit!: () => void;
  const ready = new Promise<void>(resolve => { admit = () => { admitting = true; resolve(); }; });
  let next = 0;
  let failed: Error | null = null;
  let closing = false;
  const pending = new Map<number, Pending>();
  const coalesced = new Map<string, Promise<unknown>>();
  const preparation = new BrowserPreparation();
  const latest = new Map<string, Metadata>();
  const collectors = new Map<string, Collector>();
  const connections = new Map<ServerResponse, { arc: string; invocation?: string }>();
  const streams = new Map<ServerResponse, { arc: string; last: string; writer: SseWriter; invocation?: string }>();
  function send(res: ServerResponse, event: string, data: unknown, id?: string) { streams.get(res)?.writer.send(event,data,id); }
  const historyNotice = (data: unknown) => {
    const d=data as {invocation:string;identity:string;cursor:number;state:string;endedAt:string|null;reset?:boolean;events?:unknown[]};
    return {invocation:d.invocation,identity:d.identity,cursor:d.cursor,state:d.state,endedAt:d.endedAt,reset:d.reset??false,changed:d.events?.length??0};
  };
  const start = (p: Pending, id: number, timeoutMs = p.timeoutMs) => {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      pending.delete(id); serve.postMessage({ kind: 'cancel', id } satisfies ToServe);
      p.reject(new ConsoleError('unavailable', p.strict ? BUDGETS.strict : BUDGETS.browser));
    }, timeoutMs);
  };
  const onServe = (m: FromServe) => {
    switch (m.kind) {
      case 'ready': admit(); return;
      case 'reply': case 'value': case 'error': {
        const p = pending.get(m.id); if (!p) return;
        if (p.timer) clearTimeout(p.timer); pending.delete(m.id);
        if (m.kind === 'error') p.reject(new ConsoleError(m.error.code, m.error.message)); else p.resolve(m.kind === 'reply' ? { json: m.json, checkedAt: m.checkedAt } satisfies Reply : m.value);
        return;
      }
      // A strict read of an arc not yet observed waits for the first observation (the cold read of a long journal), bounded by
      // the browser budget; its own two seconds start once the arc is observed.
      case 'cold': { const p = pending.get(m.id); if (p) start(p, m.id, BUDGETS.browserMs); return; }
      case 'admitted': { const p = pending.get(m.id); if (p) start(p, m.id); return; }
      case 'maintain': startCollector(m.arc, m.run); return;
      case 'release': stopCollector(m.arc); return;
      case 'check-now': collectors.get(m.arc)?.worker.postMessage({ kind: 'check-now' } satisfies ToCollector); return;
      case 'checked': {
        latest.delete(m.arc); latest.set(m.arc, m);
        while (latest.size > 24) latest.delete(latest.keys().next().value!);
        const id = `${m.epoch}:${m.revision}`;
        for (const [res, s] of streams) if (s.arc === m.arc) {
          send(res, s.last === id ? 'heartbeat' : s.last && !s.last.startsWith(`${m.epoch}:`) ? 'reset' : 'revision', m, id);
          s.last = id;
        }
        return;
      }
      case 'history': case 'history-error':
        for (const [res, s] of streams) if (s.arc === m.arc && m.invocation === s.invocation) send(res, m.kind, m.kind === 'history' ? historyNotice(m.data) : errorNotice(m.error));
        return;
      case 'arc-error':
        for (const [res, s] of streams) if (s.arc === m.arc) send(res, 'error', errorNotice(m.error));
        return;
    }
  };
  const failAll = (e: Error) => { failed = e; admit(); for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new ConsoleError('unavailable', e.message)); } pending.clear(); };
  const serve = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { common: args.common, hostDir: args.hostDir, instance, repoId } });
  serve.on('message', onServe);
  serve.on('error', failAll);
  serve.on('exit', (code) => { if (!closing) { log(`console serve worker exited ${code}`); failAll(new Error(`console serve worker exited ${code}`)); } });

  function startCollector(arc: ArcId, run: Run): void {
    stopCollector(arc);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('./collector.ts', import.meta.url), { workerData: { run, hostDir: args.hostDir, common: args.common, port: port1 }, transferList: [port1] });
    const c: Collector = { worker, run, phase: 'load', phaseAt: Date.now(), done: 0, of: 0, captures: [], seq: 0, offset: 0 };
    collectors.set(arc, c);
    serve.postMessage({ kind: 'collector', arc, port: port2 } satisfies ToServe, [port2]);
    worker.on('message', (m: CollectorReport) => {
      if (m.kind === 'log') { log(m.message); return; }
      if (m.kind === 'progress') { if (m.phase !== c.phase) c.phaseAt = m.at; c.phase = m.phase; c.done = m.done; c.of = m.of; return; }
      c.captures.push(m.work); if (c.captures.length > 200) c.captures.shift();
      if (m.seq !== null) c.seq = m.seq;
      if (m.offset !== null) c.offset = m.offset;
    });
    const down = (reason: string) => {
      if (collectors.get(arc) !== c || closing) return;
      collectors.delete(arc);
      log(`console collector for arc ${arc} exited: ${reason}`);
      serve.postMessage({ kind: 'collector-down', arc, error: { code: 'unavailable', message: `console collector for this arc exited: ${reason}` } } satisfies ToServe);
    };
    worker.on('error', (e) => down(e.message));
    worker.on('exit', (code) => down(`exit code ${code}`));
  }
  function stopCollector(arc: string): void {
    const c = collectors.get(arc); if (!c) return;
    collectors.delete(arc); void c.worker.terminate();
  }
  const ticker = setInterval(() => serve.postMessage({ kind: 'tick' } satisfies ToServe), MAINTAIN.tickMs);

  /** Sends `message` to the serve worker. A read resolves to its serialized reply; a control request to its value. */
  function request(message: ConsoleRequest, timeoutMs: number): Promise<unknown> {
    // Requests made before then wait in order, so control messages keep theirs.
    if (!admitting) return ready.then(() => request(message, timeoutMs));
    if (failed) return Promise.reject(new ConsoleError('unavailable', failed.message));
    // Coalesce reads only. Subscription mutations must preserve add/remove/add order.
    const key = message.kind === 'read' ? `${timeoutMs}:${canonicalJson(message)}` : `control:${next + 1}`;
    const known = coalesced.get(key); if (known) return known;
    const id = ++next;
    const task = new Promise<unknown>((resolve, reject) => {
      const p: Pending = { resolve, reject, timer: null, timeoutMs, strict: message.kind === 'read' && message.patient !== true };
      pending.set(id, p); start(p, id);
      serve.postMessage({ ...message, id, arrivedAt: Date.now() } satisfies ToServe);
    }).finally(() => { coalesced.delete(key); });
    coalesced.set(key, task); return task;
  }
  /** The decoded answer to `message`: what a read's body says, or a control request's value. */
  async function ask(message: ConsoleRequest, timeoutMs: number = BUDGETS.strictMs): Promise<unknown> {
    const value = await request(message, timeoutMs);
    return message.kind === 'read' ? JSON.parse((value as Reply).json) : value;
  }
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('cache-control', 'no-store');
    const body = (code: number, json: string) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : json + '\n'); };
    const json = (code: number, data: unknown) => body(code, canonicalJson(data));
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
            if (invocation && ![...connections.values()].some(s => s.arc === arc && s.invocation === invocation)) void request({ kind: 'history-unsubscribe', arc, invocation }, BUDGETS.strictMs).catch(() => {});
            if (![...connections.values()].some(s => s.arc === arc)) void request({ kind: 'unsubscribe', arc }, BUDGETS.strictMs).catch(() => {});
          };
          const closed = () => req.destroyed || res.closed;
          // Catch disconnects even while the worker is still catching up. A completed await can have
          // installed a subscription after close, so every boundary checks and cleans up again.
          res.once('close', cleanup);
          let opened = false;
          try {
            const page = invocation ? JSON.parse((await request({ kind: 'read', path: ['arcs', arc, 'invocations', invocation, 'history'], params: {}, patient: true }, BUDGETS.browserMs) as Reply).json) as { data: object } : null;
            if (closed()) return;
            if (invocation && req.method !== 'HEAD') await request({ kind: 'history-subscribe', arc, invocation }, BUDGETS.browserMs);
            if (closed()) return;
            const registered = await request({ kind: 'subscribe', arc, params }, BUDGETS.browserMs) as Metadata;
            if (closed()) return;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
            if (req.method === 'HEAD') { res.end(); return; }
            // A newer checked notice may arrive between the worker reply and this continuation.
            const checked = latest.get(arc);
            const initial = checked && Date.parse(checked.checkedAt) >= Date.parse(registered.checkedAt) ? checked : registered;
            const id = `${initial.epoch}:${initial.revision}`;
            const previous = req.headers['last-event-id'];
            streams.set(res, { arc, last: id, writer: new SseWriter(res), ...(invocation ? { invocation } : {}) });
            opened = true;
            send(res, previous && previous !== id ? 'reset' : 'revision', initial, id);
            if (page) send(res, 'history', historyNotice({ ...page.data, reset: true }));
            return;
          } finally { if (!opened || closed()) cleanup(); }
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
            const result = await preparation.read({instance, path, params: query}, () => request({kind: 'read', path, params: query, patient: true}, BUDGETS.browserMs), controller.signal, token, cancel === '1');
            if (controller.signal.aborted) return;
            if (result.state === 'preparing') {
              res.setHeader('retry-after', '1');
              json(202, {protocol: CONSOLE_PROTOCOL, arc: path[1] ?? null, ...result});
            } else if (cancel === '1') json(200, {protocol: CONSOLE_PROTOCOL, arc: path[1] ?? null, state: 'cancelled'});
            else body(200, (result.value as Reply).json);
          } finally { res.removeListener('close', aborted); }
        } else {
          if ('pending' in params || 'cancel' in params) throw new ConsoleError('invalid', 'preparation is only available for browser reads');
          body(200, (await request({ kind: 'read', path, params }, BUDGETS.strictMs) as Reply).json);
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
  const shutdown = async () => {
    closing = true; clearInterval(ticker); preparation.close();
    await Promise.all([serve.terminate(), ...[...collectors.values()].map((c) => c.worker.terminate())]);
    collectors.clear();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(args.port, args.host, resolve); });
  } catch (error) {
    await shutdown();
    throw new ConsoleBindError(args.host, args.port, (error as Error).message);
  }
  const port = (server.address() as AddressInfo).port;
  const url = consoleUrl(args.host, port);
  /** What the console did for `arc`, or null when no collector runs for it. */
  const stats = (arc: string): ArcStats | null => {
    const c = collectors.get(arc);
    return c ? { captures: [...c.captures], phase: c.phase, seq: c.seq, offset: c.offset } : null;
  };
  return { server, port, url, instance, repoId, ask, stats, async close() {
    for (const res of streams.keys()) res.end(); streams.clear();
    server.closeAllConnections();
    await Promise.all([new Promise<void>((r) => server.close(() => r())), shutdown()]);
  } };
}
