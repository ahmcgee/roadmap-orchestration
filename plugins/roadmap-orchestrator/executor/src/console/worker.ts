import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { type ArcId, invocationDirName, invocationIdOf, parseInvocationId } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { RUNNER_FILE_READERS } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { ObservationCache } from '../observation/cache.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type Admission, type Envelope } from '../observation/protocol.ts';
import { project } from '../tui/projection.ts';
import { logPage, readEvidence } from './evidence.ts';
import { ConsoleHistories } from './history.ts';
import { ConsoleModels } from './model.ts';
import { retainedRun, retainedRuns } from './runs.ts';

const args = workerData as { common: AbsPath; hostDir: AbsPath; instance: string; repoId: string };
const cache = new ObservationCache(args.hostDir, args.instance, args.repoId);
const subscribed = new Set<string>();
const maintained = new Set<string>();
const models = new ConsoleModels();
const histories = new ConsoleHistories();
const historySubscriptions = new Map<string, { arc: string; invocation: string; state?: string }>();
const err = (error: unknown) => ({ code: error instanceof ConsoleError ? error.code : 'corruption', message: error instanceof Error ? error.message : String(error) });
function read(arc: string, admission: Admission = {}) { return cache.read(retainedRun(args.common, args.hostDir, arc), admission); }
function result(e: Envelope, id: string) {
  const selected = e.data.display.invocations.find((i) => i.id === id);
  if (!selected) throw new ConsoleError('not-found', 'invocation is not recorded in this run');
  const inv = invocationIdOf(id);
  const dir = invocationDir(e.data.display.run.runDir, inv);
  const bytes = readEvidence(e.data.display.run.runDir, join(dir, 'result.json'));
  const record = RUNNER_FILE_READERS['result.json'](JSON.parse(bytes.toString('utf8')), 'result.json');
  const { op } = parseInvocationId(inv);
  if (record.inv !== inv || record.op !== op || record.arc !== e.arc) throw new ConsoleError('corruption', 'result identity does not match its invocation');
  const terminal = e.data.events.find((event) => event.type === 'done' && event.kind === 'proc.spawn' && event.op === op);
  if (terminal?.type === 'done' && terminal.kind === 'proc.spawn' && terminal.outcome.kind === 'result' && sha256Hex(bytes) !== terminal.outcome.resultSha256) throw new ConsoleError('corruption', 'result bytes do not match recorded resultSha256');
  return { record, lines: project(record).map((r) => r.text) };
}
function route(path: string[], params: Record<string, string>) {
  if (path.length === 1 && path[0] === 'runs') return { protocol: CONSOLE_PROTOCOL, ...retainedRuns(args.common, args.hostDir) };
  const [runs, arc, section, id, file] = path;
  if (runs !== 'runs' || !arc) throw new ConsoleError('not-found', 'unknown console route');
  const admission: Admission = {
    ...(params['epoch'] !== undefined ? { epoch: params['epoch'] } : {}),
    ...(params['revision'] !== undefined ? { revision: integer(params['revision']) } : {}),
    ...(params['minHighWater'] !== undefined ? { minHighWater: integer(params['minHighWater']) } : {}),
    ...(params['fenceIdentity'] !== undefined && params['fenceSize'] !== undefined ? { fence: { identity: params['fenceIdentity'], size: integer(params['fenceSize']) } } : {}),
  };
  let e: Envelope;
  try { e = read(arc, admission); }
  catch (error) {
    if (error instanceof ConsoleError && error.code === 'not-found' && (section === 'snapshot' || section === 'status')) throw new ConsoleError('unavailable', 'run has no retained observation yet');
    throw error;
  }
  if (path.length === 3 && section === 'snapshot') {
    const { events: _events, ...displayData } = e.data;
    return { ...e, data: { ...displayData, console: models.read(e) } };
  }
  if (path.length === 3 && section === 'activity') { const offset=integer(params['offset']??'0');const rows=models.read(e).presentation.feed;return {...e,data:{rows:rows.slice(offset,offset+30),more:offset+30<rows.length}}; }
  if (path.length === 3 && section === 'status') {
    if (params['summary'] !== undefined && params['summary'] !== '0' && params['summary'] !== '1') throw new ConsoleError('invalid', 'summary is 0 or 1');
    return { ...e, data: params['summary'] === '1' ? e.data.summary : e.data.display.status };
  }
  if (path.length === 4 && section === 'units' && id) {
    const unit = e.data.display.status.units.find((u) => u.unit === id);
    if (!unit) throw new ConsoleError('not-found', 'unit is not in the applied plan');
    const activities = e.data.display.invocations.filter((i) => i.unit === id || i.relatedUnits?.includes(id));
    return { ...e, data: { unit, activities, attempts: [...new Set(activities.map((i) => i.attempt))],
      records: e.data.display.estate.filter((r) => r.id === id || r.parentId === id || r.id === `unit:${id}`),
      lines: project(unit).map((r) => r.text) } };
  }
  if (path.length === 5 && section === 'invocations' && id) {
    if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(id)) throw new ConsoleError('invalid', 'invocation route ID is seq-ordinal');
    const recorded = e.data.display.invocations.find((i) => invocationDirName(invocationIdOf(i.id)) === id);
    if (!recorded) throw new ConsoleError('not-found', 'invocation is not recorded in this run');
    if (file === 'history') return { ...e, data: histories.page(e, id, params['before'], params['identity']) };
    if (file === 'history-field') return { ...e, data: histories.field(e, id, params['ref'] ?? '', params['field'] ?? '', integer(params['after'] ?? '0'), params['identity']) };
    if (file === 'prompt') return { ...e, data: histories.prompt(e, id, integer(params['after'] ?? '0')) };
    if (file === 'result') return { ...e, data: result(e, recorded.id) };
    if (file === 'log') {
      const source = params['source'] ?? 'stdout';
      if (!['stdout', 'stderr', 'runner.log'].includes(source)) throw new ConsoleError('invalid', 'unknown log source');
      const path = join(invocationDir(e.data.display.run.runDir, invocationIdOf(recorded.id)), source);
      const page = logPage(e.data.display.run.runDir, path, integer(params['after'] ?? '0'));
      if (params['identity'] !== undefined && params['identity'] !== page.identity) throw new ConsoleError('reset', 'log evidence identity changed');
      return { ...e, data: page };
    }
  }
  throw new ConsoleError('not-found', 'unknown console route');
}
function integer(raw: string) {
  const n = Number(raw);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(n)) throw new ConsoleError('invalid', 'cursor must be a non-negative safe integer');
  return n;
}
parentPort!.on('message', (m: { id: number; path?: string[]; params?: Record<string, string>; subscribe?: string; unsubscribe?: string; history?: { arc: string; invocation: string; remove?: boolean } }) => {
  try {
    if (m.history) {
      const key = `${m.history.arc}:${m.history.invocation}`;
      if (m.history.remove) historySubscriptions.delete(key);
      else {
        if (!historySubscriptions.has(key) && historySubscriptions.size >= 16) throw new ConsoleError('unavailable', 'sixteen open histories already subscribed');
        histories.selected(read(m.history.arc), m.history.invocation);
        historySubscriptions.set(key, { arc: m.history.arc, invocation: m.history.invocation });
      }
    }
    if (m.subscribe) { subscribed.add(m.subscribe); cache.pin(m.subscribe); }
    if (m.unsubscribe) { subscribed.delete(m.unsubscribe); if (!maintained.has(m.unsubscribe)) cache.unpin(m.unsubscribe); }
    parentPort!.postMessage({ id: m.id, value: m.path ? route(m.path, m.params ?? {}) : null });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    parentPort!.postMessage({ id: m.id, error: code === 'ENOENT' ? { code: 'not-found', message: 'evidence is absent or pruned' } : err(error) });
  }
});
let timer: NodeJS.Timeout | null = null;
function tick() {
  timer = null;
  try {
    const runs = retainedRuns(args.common, args.hostDir);
    const defaults = new Set<string>([runs.selected, runs.runs[0]?.arc].filter((a): a is ArcId => a !== null && a !== undefined));
    for (const arc of maintained) if (!defaults.has(arc) && !subscribed.has(arc)) cache.unpin(arc);
    maintained.clear();
    for (const arc of defaults) { maintained.add(arc); cache.pin(arc); }
    const arcs = new Set([...defaults, ...subscribed]);
    for (const arc of arcs) {
      try {
        const e = read(arc); parentPort!.postMessage({ kind: 'checked', arc, epoch: e.epoch, highWater: e.highWater, revision: e.revision, checkedAt: e.checkedAt });
        for (const subscription of historySubscriptions.values()) if (subscription.arc === arc) {
          try {
            const delta = histories.poll(e, subscription.invocation);
            const state = `${delta.state}:${delta.endedAt}`;
            if (delta.reset || delta.events.length || subscription.state !== state) parentPort!.postMessage({ kind: 'history', arc, invocation: subscription.invocation, data: delta });
            subscription.state = state;
          } catch (error) { parentPort!.postMessage({ kind: 'history-error', arc, invocation: subscription.invocation, error: err(error) }); }
        }
      }
      catch (error) { parentPort!.postMessage({ kind: 'error', arc, error: err(error) }); }
    }
  } catch (error) { parentPort!.postMessage({ kind: 'error', error: err(error) }); }
}
setInterval(tick, 1_000);
for (const dir of ['roadmap-runtime', 'refs', 'roadmap']) {
  const path = join(args.common, dir);
  if (existsSync(path)) watch(path, { recursive: true }, () => { timer ??= setTimeout(tick, 100); }).on('error', (e) => parentPort!.postMessage({ kind: 'error', error: err(e) }));
}
tick();
