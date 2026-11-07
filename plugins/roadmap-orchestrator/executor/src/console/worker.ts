import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { invocationDirName, invocationIdOf, parseInvocationId } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { RUNNER_FILE_READERS } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { ObservationCache } from '../observation/cache.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type Admission, type Envelope } from '../observation/protocol.ts';
import { project } from '../tui/projection.ts';
import { logPage, readEvidence } from './evidence.ts';
import { retainedRun, retainedRuns } from './runs.ts';

const args = workerData as { common: AbsPath; hostDir: AbsPath; instance: string; repoId: string };
const cache = new ObservationCache(args.hostDir, args.instance, args.repoId);
const subscribed = new Set<string>();
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
  if (path.length === 3 && section === 'snapshot') return e;
  if (path.length === 3 && section === 'status') {
    if (params['summary'] !== undefined && params['summary'] !== '0' && params['summary'] !== '1') throw new ConsoleError('invalid', 'summary is 0 or 1');
    return { ...e, data: params['summary'] === '1' ? e.data.summary : e.data.display.status };
  }
  if (path.length === 4 && section === 'units' && id) {
    const unit = e.data.display.status.units.find((u) => u.unit === id);
    if (!unit) throw new ConsoleError('not-found', 'unit is not in the applied plan');
    const activities = e.data.display.invocations.filter((i) => i.unit === id || i.relatedUnits?.includes(id));
    return { ...e, data: { unit, activities, attempts: [...new Set(activities.map((i) => i.attempt))],
      records: e.data.display.estate.filter((r) => r.id === id || r.parentId === `unit:${id}` || r.id === `unit:${id}`),
      lines: project(unit).map((r) => r.text) } };
  }
  if (path.length === 5 && section === 'invocations' && id) {
    if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(id)) throw new ConsoleError('invalid', 'invocation route ID is seq-ordinal');
    const recorded = e.data.display.invocations.find((i) => invocationDirName(invocationIdOf(i.id)) === id);
    if (!recorded) throw new ConsoleError('not-found', 'invocation is not recorded in this run');
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
parentPort!.on('message', (m: { id: number; path?: string[]; params?: Record<string, string>; subscribe?: string; unsubscribe?: string }) => {
  try {
    if (m.subscribe) { subscribed.add(m.subscribe); cache.pin(m.subscribe); }
    if (m.unsubscribe) { subscribed.delete(m.unsubscribe); cache.unpin(m.unsubscribe); }
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
    const arcs = new Set([runs.selected, runs.runs[0]?.arc, ...subscribed].filter((a): a is string => Boolean(a)));
    for (const arc of arcs) {
      try { const e = read(arc); parentPort!.postMessage({ kind: 'checked', arc, epoch: e.epoch, highWater: e.highWater, revision: e.revision, checkedAt: e.checkedAt }); }
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
