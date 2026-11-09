import type { ConsoleRequest } from './messages.ts';
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
import { ConsoleViews } from './views.ts';
import { ConsoleMetadata } from './metadata.ts';
import { ConsoleEffort } from './effort-query.ts';
import { ConsoleAttention } from './attention-query.ts';
import { requestDetail } from './request-detail.ts';
import { ConsoleTemporal } from './temporal-query.ts';
import { ConsoleActivity } from './activity-query.ts';
import { activityPage } from './activity-page.ts';
import { activityDetail } from './activity-detail.ts';
import { CONSOLE_UI_SCHEMA } from './view-protocol.ts';
import { validateViewEnvelope } from './view-validation.ts';
import { contentShape, unitShape, unitSummaryShape, invocationShape, milestoneShape, activityShape, activityChangesShape, activityDetailShape, timelineShape, intervalsShape, holdsShape, holisticShape, attentionShape, requestShape, holisticFieldShape, effortShape, effortScopeShape } from './view-shapes.ts';
import { unitView, milestoneView, invocationView, detailParams } from './details.ts';
import { retainedRun, retainedRuns } from './runs.ts';

const args = workerData as { common: AbsPath; hostDir: AbsPath; instance: string; repoId: string };
const cache = new ObservationCache(args.hostDir, args.instance, args.repoId);
const subscribed = new Set<string>();
const maintained = new Set<string>();
const models = new ConsoleModels(); // Temporary legacy UI adapter until the tab cutover.
const views = new ConsoleViews();
const metadata = new ConsoleMetadata();
const activity = new ConsoleActivity();
const temporal = new ConsoleTemporal();
const effort = new ConsoleEffort(temporal.pages);
const attention = new ConsoleAttention(temporal.pages);
const histories = new ConsoleHistories();
const historySubscriptions = new Map<string, { arc: string; invocation: string; state?: string }>();
const err = (error: unknown) => ({ code: error instanceof ConsoleError ? error.code : 'corruption', message: error instanceof Error ? error.message : String(error) });
function read(arc: string, admission: Admission = {}) { return cache.read(retainedRun(args.common, args.hostDir, arc), admission); }
function notice(e: Envelope) { return metadata.read(e, views, retainedRuns(args.common, args.hostDir).selected); }
function result(e: Envelope, id: string) {
  const selected = e.data.display.invocations.find((i) => i.id === id);
  if (!selected) throw new ConsoleError('not-found', 'invocation is not recorded in this arc');
  const inv = invocationIdOf(id);
  const dir = invocationDir(e.data.display.run.runDir, inv);
  const bytes = readEvidence(e.data.display.run.runDir, join(dir, 'result.json'));
  const record = RUNNER_FILE_READERS['result.json'](JSON.parse(bytes.toString('utf8')), 'result.json');
  const { op } = parseInvocationId(inv);
  if (record.inv !== inv || record.op !== op || record.arc !== e.arc) throw new ConsoleError('corruption', 'result identity does not match its invocation');
  const terminal = e.data.events.find((event) => event.type === 'done' && event.kind === 'proc.spawn' && event.op === op);
  if (terminal?.type === 'done' && terminal.kind === 'proc.spawn' && terminal.outcome.kind === 'result' && sha256Hex(bytes) !== terminal.outcome.resultSha256) throw new ConsoleError('corruption', 'result bytes do not match recorded resultSha256');
  let report: unknown = null;
  if (record.type === 'backend') {
    const { kind, ...details } = record.outcome;
    report = record.outcome.kind === 'success' ? record.outcome.value : { outcome: kind, ...details };
  }
  return { record, report, raw: JSON.stringify(record, null, 2), lines: project(record, { fieldFirstEmpty: true }).map((r) => r.text) };
}
function admissionOf(params: Record<string, string>) {
  return {
    ...(params['epoch'] !== undefined ? { epoch: params['epoch'] } : {}),
    ...(params['revision'] !== undefined ? { revision: integer(params['revision']) } : {}),
    ...(params['minHighWater'] !== undefined ? { minHighWater: integer(params['minHighWater']) } : {}),
    ...(params['fenceIdentity'] !== undefined && params['fenceSize'] !== undefined ? { fence: { identity: params['fenceIdentity'], size: integer(params['fenceSize']) } } : {}),
  } satisfies Admission;
}
function route(path: string[], params: Record<string, string>) {
  if (path.length === 1 && path[0] === 'arcs') return { protocol: CONSOLE_PROTOCOL, uiSchema: CONSOLE_UI_SCHEMA, selected: retainedRuns(args.common, args.hostDir).selected };
  const [runs, arc, section, id, file] = path;
  if (runs !== 'arcs' || !arc) throw new ConsoleError('not-found', 'unknown console route');
  if (path.length === 3 && (section === 'shell' || section === 'graph' || section === 'metadata')) {
    for (const key of Object.keys(params)) if (!['epoch', 'revision', 'minHighWater'].includes(key)) throw new ConsoleError('invalid', 'unknown view query parameter');
  }
  const admission = admissionOf(params);
  let e: Envelope;
  try { e = read(arc, admission); }
  catch (error) {
    if (error instanceof ConsoleError && error.code === 'not-found' && (section === 'snapshot' || section === 'status')) throw new ConsoleError('unavailable', 'arc has no retained observation yet');
    throw error;
  }
  if (path.length === 3 && (section === 'shell' || section === 'graph')) {
    return validateViewEnvelope({...e, data: section === 'shell' ? views.shell(e) : views.graph(e)}, section, e);
  }
  if (path.length === 3 && section === 'metadata') return notice(e);
  if (path.length === 3 && section === 'snapshot') {
    const { events: _events, ...displayData } = e.data;
    return { ...e, data: { ...displayData, console: models.read(e) } };
  }
  if (section === 'resources' && path.length === 5 && id === 'details' && file?.startsWith('effort-')) {
    const data = effort.detail(e, file, params, notice(e).viewVersions.effort);
    if (!effortScopeShape(data)) throw new ConsoleError('protocol', 'malformed selected Effort scope');
    return {...e, data};
  }
  if (section === 'effort' && path.length === 3) {
    const data = effort.read(e, params, notice(e).viewVersions.effort);
    if (!effortShape(data)) throw new ConsoleError('protocol', 'malformed typed Effort view');
    return {...e, data};
  }
  if (section === 'attention' && path.length === 3) {
    const data = attention.read(e, params, notice(e).viewVersions.attention);
    if (!attentionShape(data)) throw new ConsoleError('protocol', 'malformed typed Attention view');
    return {...e, data};
  }
  if (section === 'requests' && path.length === 4 && id) {
    const data = requestDetail(e, id, params);
    if (!(params['section'] === 'content' ? contentShape : requestShape)(data)) throw new ConsoleError('protocol', 'malformed selected request');
    return {...e, data};
  }
  if (section === 'timeline' && (path.length === 3 || path.length === 4 && (id === 'intervals' || id === 'holds'))) {
    const kind = id === 'intervals' ? 'intervals' : id === 'holds' ? 'holds' : 'tracks';
    const data = temporal.timeline(e, params, kind, notice(e).viewVersions.timeline);
    const check = kind === 'tracks' ? timelineShape : kind === 'intervals' ? intervalsShape : holdsShape;
    if (!check(data)) throw new ConsoleError('protocol', 'malformed typed Timeline view');
    return {...e, data};
  }
  if (section === 'holistic' && path.length === 5 && id === 'fields' && file) {
    const data = temporal.field(e, file, params);
    if (!holisticFieldShape(data)) throw new ConsoleError('protocol', 'malformed Holistic field');
    return {...e, data};
  }
  if (section === 'holistic' && path.length === 3) {
    const data = temporal.holistic(e, params, notice(e).viewVersions.holistic);
    if (!holisticShape(data)) throw new ConsoleError('protocol', 'malformed typed Holistic view');
    return {...e, data};
  }
  if (section === 'activity' && (path.length === 3 || path.length === 4)) {
    const data = path.length === 3 ? activityPage(e, activity, params) : id === 'changes' ? activity.changes(e, params) : activityDetail(e, activity, id!, params);
    const check = path.length === 3 ? activityShape : id === 'changes' ? activityChangesShape : params['section'] === 'content' ? contentShape : activityDetailShape;
    if (!check(data)) throw new ConsoleError('protocol', 'malformed typed Activity view');
    return {...e, data};
  }
  if (path.length === 3 && section === 'status') {
    if (params['summary'] !== undefined && params['summary'] !== '0' && params['summary'] !== '1') throw new ConsoleError('invalid', 'summary is 0 or 1');
    return { ...e, data: params['summary'] === '1' ? e.data.summary : e.data.display.status };
  }
  if (path.length === 4 && id && (section === 'units' || section === 'milestones' || section === 'invocations')) {
    detailParams(params, ['content',...(section === 'units' ? ['summary','depends','usedBy','journey','invocations','acceptance','waiting','checks','requests','intent'] : section === 'milestones' ? ['members','intent'] : ['related'])]);
    if(section==='invocations'&&!/^[1-9][0-9]*-[1-9][0-9]*$/.test(id))throw new ConsoleError('invalid','invocation route ID is seq-ordinal');
    const data=section==='units'?unitView(e,id,params):section==='milestones'?milestoneView(e,id,params):invocationView(e,id,params);
    const check=params['section']==='content'?contentShape:section==='units'?(params['section']==='summary'?unitSummaryShape:unitShape):section==='milestones'?milestoneShape:invocationShape;
    if(!check(data))throw new ConsoleError('protocol','malformed selected detail');
    return {...e,data};
  }
  if (path.length === 5 && section === 'invocations' && id) {
    if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(id)) throw new ConsoleError('invalid', 'invocation route ID is seq-ordinal');
    const recorded = e.data.display.invocations.find((i) => invocationDirName(invocationIdOf(i.id)) === id);
    if (!recorded) throw new ConsoleError('not-found', 'invocation is not recorded in this arc');
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
function request(m: ConsoleRequest): unknown {
  switch (m.kind) {
    case 'read': return route(m.path, m.params);
    case 'subscribe': {
      // Registration and watermark capture are one synchronous worker operation. No journal
      // notification can be lost between an independent read and subscription installation.
      const params = m.params ?? {};
      for (const key of Object.keys(params)) if (!['invocation', 'epoch', 'revision', 'minHighWater'].includes(key)) throw new ConsoleError('invalid', 'unknown events query parameter');
      const e = read(m.arc, admissionOf(params));
      subscribed.add(m.arc); cache.pin(m.arc);
      return notice(e);
    }
    case 'unsubscribe': subscribed.delete(m.arc); if (!maintained.has(m.arc)) cache.unpin(m.arc); break;
    case 'history-unsubscribe': historySubscriptions.delete(`${m.arc}:${m.invocation}`); break;
    case 'history-subscribe': {
      const key = `${m.arc}:${m.invocation}`;
      if (!historySubscriptions.has(key) && historySubscriptions.size >= 16) throw new ConsoleError('unavailable', 'sixteen open histories already subscribed');
      histories.selected(read(m.arc), m.invocation);
      historySubscriptions.set(key, { arc: m.arc, invocation: m.invocation });
      break;
    }
  }
  return null;
}
parentPort!.on('message', (m: ConsoleRequest & { id: number }) => {
  try {
    parentPort!.postMessage({ id: m.id, value: request(m) });
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
    const defaults = new Set<string>([runs.selected].filter((a): a is ArcId => a !== null && a !== undefined));
    for (const arc of maintained) if (!defaults.has(arc) && !subscribed.has(arc)) cache.unpin(arc);
    maintained.clear();
    for (const arc of defaults) { maintained.add(arc); cache.pin(arc); }
    const arcs = new Set([...defaults, ...subscribed]);
    for (const arc of arcs) {
      try {
        const e = cache.maintain(retainedRun(args.common, args.hostDir, arc));
        parentPort!.postMessage({kind: 'checked', ...notice(e)});
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
parentPort!.postMessage({kind: 'ready'});
