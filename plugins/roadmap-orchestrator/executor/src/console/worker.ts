// The serve worker: one ArcModel per maintained arc, fed by that arc's collector (src/console/collector.ts) over its own
// port. Every API read is answered from the model in memory; the only files read here are the journal prefix a collector
// verified (parsed into the model) and one selected invocation's evidence. No timers, no journal fold, no status derivation.
import type { MessagePort } from 'node:worker_threads';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { type ArcId, invocationDirName, invocationIdOf, parseInvocationId } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { RUNNER_FILE_READERS } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import type { Run } from '../cli/locate.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import type { CollectorMessage } from '../observation/collect.ts';
import { CONSOLE_PROTOCOL, ConsoleError, type Admission, type Envelope } from '../observation/protocol.ts';
import { project } from '../tui/projection.ts';
import { logPage, readEvidence } from './evidence.ts';
import { ConsoleHistories } from './history.ts';
import { ConsoleViews } from './views.ts';
import { ConsoleMetadata } from './metadata.ts';
import { ConsoleResources } from './resource-query.ts';
import { ConsoleEffort } from './effort-query.ts';
import { ConsoleAttention } from './attention-query.ts';
import { requestDetail } from './request-detail.ts';
import { ConsoleTemporal } from './temporal-query.ts';
import { ConsoleActivity } from './activity-query.ts';
import { activityPage } from './activity-page.ts';
import { activityDetail } from './activity-detail.ts';
import { CONSOLE_UI_SCHEMA } from './view-protocol.ts';
import { validateViewEnvelope } from './view-validation.ts';
import { contentShape, unitShape, unitSummaryShape, invocationShape, milestoneShape, activityShape, activityChangesShape, activityDetailShape, timelineShape, intervalsShape, holdsShape, holisticShape, attentionShape, requestShape, holisticFieldShape, effortShape, effortScopeShape, resourcesShape, resourceDetailShape, resourceReasonsShape } from './view-shapes.ts';
import { unitView, milestoneView, invocationView, detailParams } from './details.ts';
import { retainedRun, retainedRuns } from './runs.ts';
import { ArcModel, type ParkKind } from './model.ts';
import { MAINTAIN, type ConsoleRequest, type FromServe, type ToServe } from './messages.ts';

const args = workerData as { common: AbsPath; hostDir: AbsPath; instance: string; repoId: string };
const post = (m: FromServe) => parentPort!.postMessage(m);
const models = new Map<string, ArcModel>();
const ports = new Map<string, MessagePort>();
/** The arcs main runs a collector for, as this worker asked. */
const maintained = new Set<string>();
const runsOf = new Map<string, Run>();
/** When each arc was last read or subscribed: the maintained set keeps the most recent. */
const used = new Map<string, number>();
const subscribed = new Map<string, number>();
let selected: ArcId | null = null;
const views = new ConsoleViews();
const metadata = new ConsoleMetadata();
const activity = new ConsoleActivity();
const temporal = new ConsoleTemporal();
const effort = new ConsoleEffort(temporal.pages);
const resources = new ConsoleResources(temporal.pages);
const attention = new ConsoleAttention(temporal.pages);
const histories = new ConsoleHistories();
const historySubscriptions = new Map<string, { arc: string; invocation: string; state?: string }>();
type Asked = ConsoleRequest & { id: number; arrivedAt: number };
/** A read waiting for its arc: it uses no CPU while parked, and every applied message looks at it again. */
type Parked = { m: Asked; arc: string; park: ParkKind | null };
let parked: Parked[] = [];
const err = (error: unknown) => ({ code: error instanceof ConsoleError ? error.code : 'corruption' as const, message: error instanceof Error ? error.message : String(error) });

function notice(e: Envelope) { return metadata.read(e, views, selected); }
function result(e: Envelope, id: string) {
  const chosen = e.data.display.invocations.find((i) => i.id === id);
  if (!chosen) throw new ConsoleError('not-found', 'invocation is not recorded in this arc');
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
function admissionOf(params: Record<string, string>): Admission {
  return {
    ...(params['epoch'] !== undefined ? { epoch: params['epoch'] } : {}),
    ...(params['revision'] !== undefined ? { revision: integer(params['revision']) } : {}),
    ...(params['minHighWater'] !== undefined ? { minHighWater: integer(params['minHighWater']) } : {}),
    ...(params['fenceIdentity'] !== undefined && params['fenceSize'] !== undefined ? { fence: { identity: params['fenceIdentity'], size: integer(params['fenceSize']) } } : {}),
  };
}
/** The arc a read is about, after the checks that need no observation. */
function arcOf(path: string[], params: Record<string, string>): string {
  const [runs, arc, section] = path;
  if (runs !== 'arcs' || !arc) throw new ConsoleError('not-found', 'unknown console route');
  if (path.length === 3 && (section === 'shell' || section === 'graph' || section === 'metadata')) {
    for (const key of Object.keys(params)) if (!['epoch', 'revision', 'minHighWater'].includes(key)) throw new ConsoleError('invalid', 'unknown view query parameter');
  }
  if (section === 'snapshot' || section === 'activity-legacy') throw new ConsoleError('not-found', 'unknown console route');
  return arc;
}
function route(path: string[], params: Record<string, string>, e: Envelope) {
  const [, , section, id, file] = path;
  if (path.length === 3 && (section === 'shell' || section === 'graph')) {
    return validateViewEnvelope({...e, data: section === 'shell' ? views.shell(e) : views.graph(e)}, section, e);
  }
  if (path.length === 3 && section === 'metadata') return notice(e);
  if (section === 'resources' && path.length === 5 && id === 'details' && file?.startsWith('effort-')) {
    const data = effort.detail(e, file, params, notice(e).viewVersions.effort);
    if (!effortScopeShape(data)) throw new ConsoleError('protocol', 'malformed selected Effort scope');
    return {...e, data};
  }
  if (section === 'resources' && path.length === 4 && id === 'reasons') {
    const data = resources.reasons(e, params, notice(e).viewVersions.resources);
    if (!resourceReasonsShape(data)) throw new ConsoleError('protocol', 'malformed resource reason page');
    return {...e, data};
  }
  if (section === 'resources' && path.length === 3) {
    const data = resources.read(e, params, notice(e).viewVersions.resources);
    if (!resourcesShape(data)) throw new ConsoleError('protocol', 'malformed typed Resources view');
    return {...e, data};
  }
  if (section === 'resources' && path.length === 5 && id === 'details' && file) {
    const data = params['section']==='content'?resources.content(e,file,params):resources.detail(e, file, params, notice(e).viewVersions.resources);
    if (!(params['section']==='content'?contentShape:resourceDetailShape)(data)) throw new ConsoleError('protocol', 'malformed selected resource');
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

/** The arc a request is about, or null for API discovery and the unsubscriptions, which need no observation. */
function arcOfRequest(m: Asked): string | null {
  switch (m.kind) {
    case 'read': return m.path.length === 1 && m.path[0] === 'arcs' ? null : arcOf(m.path, m.params);
    case 'subscribe': {
      for (const key of Object.keys(m.params ?? {})) if (!['invocation', 'epoch', 'revision', 'minHighWater'].includes(key)) throw new ConsoleError('invalid', 'unknown events query parameter');
      return m.arc;
    }
    case 'history-subscribe': {
      const key = `${m.arc}:${m.invocation}`;
      if (!historySubscriptions.has(key) && historySubscriptions.size >= 16) throw new ConsoleError('unavailable', 'sixteen open histories already subscribed');
      return m.arc;
    }
    case 'unsubscribe': case 'history-unsubscribe': return null;
  }
}
/** Answers `m` from `e`, its arc's envelope. */
function answerFrom(m: Asked, e: Envelope): void {
  switch (m.kind) {
    case 'read': {
      const value = route(m.path, m.params, e) as { checkedAt?: string };
      post({ kind: 'reply', id: m.id, json: canonicalJson(value), checkedAt: value.checkedAt ?? null });
      return;
    }
    case 'subscribe': {
      // Registration and watermark capture are one synchronous worker operation. No journal
      // notification can be lost between an independent read and subscription installation.
      subscribed.set(m.arc, (subscribed.get(m.arc) ?? 0) + 1);
      post({ kind: 'value', id: m.id, value: notice(e) });
      return;
    }
    case 'history-subscribe': {
      histories.selected(e, m.invocation);
      historySubscriptions.set(`${m.arc}:${m.invocation}`, { arc: m.arc, invocation: m.invocation });
      post({ kind: 'value', id: m.id, value: null });
      return;
    }
    case 'unsubscribe': case 'history-unsubscribe': throw new Error(`${m.kind} needs no observation`);
  }
}
function fail(m: Asked, error: unknown, section?: string) {
  const code = (error as NodeJS.ErrnoException).code;
  const e = error instanceof ConsoleError && error.code === 'not-found' && section === 'status' ? new ConsoleError('unavailable', 'arc has no retained observation yet') : error;
  post({ kind: 'error', id: m.id, error: code === 'ENOENT' ? { code: 'not-found', message: 'evidence is absent or pruned' } : err(e) });
}
/** Answers `m`, or parks it until its arc's model can. */
function handle(m: Asked): void {
  let arc: string | null;
  try { arc = arcOfRequest(m); } catch (error) { fail(m, error); return; }
  if (arc === null) {
    if (m.kind === 'read') {
      // Discovery answers once the console can serve the arc it names: after the selected arc's first observation.
      reconcile();
      const p: Parked = { m, arc: selected ?? '', park: null };
      if (!discover(p)) parked.push(p);
    } else if (m.kind === 'unsubscribe') {
      const n = (subscribed.get(m.arc) ?? 1) - 1;
      if (n > 0) subscribed.set(m.arc, n); else subscribed.delete(m.arc);
      post({ kind: 'value', id: m.id, value: null });
    } else if (m.kind === 'history-unsubscribe') {
      historySubscriptions.delete(`${m.arc}:${m.invocation}`);
      post({ kind: 'value', id: m.id, value: null });
    }
    return;
  }
  used.set(arc, Date.now());
  if (!models.has(arc)) {
    try { retainedRun(args.common, args.hostDir, arc); } catch (error) { fail(m, error, m.kind === 'read' ? m.path[2] : undefined); return; }
    if (!maintained.has(arc)) reconcile();
  }
  const p: Parked = { m, arc, park: null };
  if (!attempt(p)) parked.push(p);
}
/** Tries a request against its arc's model: answers it (true), or says why it still waits. */
/** API discovery: the selected arc, once that arc has its first observation (or its capture failed). */
function discover(p: Parked): boolean {
  const model = models.get(p.arc);
  if (p.arc !== '' && model?.observed !== true && model?.failed == null) {
    if (p.park === null) post({ kind: 'cold', id: p.m.id });
    p.park = 'cold';
    return false;
  }
  post({ kind: 'reply', id: p.m.id, json: canonicalJson({ protocol: CONSOLE_PROTOCOL, uiSchema: CONSOLE_UI_SCHEMA, selected }), checkedAt: null });
  return true;
}
function attempt(p: Parked): boolean {
  if (p.m.kind === 'read' && p.m.path.length === 1) return discover(p);
  const { m, arc } = p, model = models.get(arc);
  const strict = m.kind === 'read' && m.patient !== true;
  try {
    const verdict = model === undefined ? { kind: 'park' as const, park: 'cold' as const } : model.admit(admissionOf(m.kind === 'read' ? m.params : m.kind === 'subscribe' ? m.params ?? {} : {}), m.arrivedAt, strict);
    if (verdict.kind === 'ready') { answerFrom(m, verdict.envelope); return true; }
    if (verdict.park !== p.park) {
      // A strict read's two seconds start once its arc has its first observation (the rule for the worker's first check).
      if (strict && verdict.park === 'cold') post({ kind: 'cold', id: m.id });
      else if (strict && p.park === 'cold') post({ kind: 'admitted', id: m.id });
      if (verdict.park !== 'cold') post({ kind: 'check-now', arc: arc as ArcId });
    }
    p.park = verdict.park;
    return false;
  } catch (error) { fail(m, error, m.kind === 'read' ? m.path[2] : undefined); return true; }
}
/** Looks at every request parked on `arc` again. */
function revisit(arc: string): void {
  if (parked.some((p) => p.arc === arc)) parked = parked.filter((p) => p.arc !== arc || !attempt(p));
}

/** The arcs kept current: the selected arc always, then subscribed and recently read arcs, the most recent two. */
function reconcile(): void {
  const runs = retainedRuns(args.common, args.hostDir);
  selected = runs.selected;
  const now = Date.now();
  for (const arc of subscribed.keys()) used.set(arc, now);
  const want = new Set<string>(selected === null ? [] : [selected]);
  const recent = [...used].filter(([arc, at]) => arc !== selected && (subscribed.has(arc) || now - at <= MAINTAIN.recentMs) && runs.arcs.some((r) => r.arc === arc))
    .sort((a, b) => b[1] - a[1]).slice(0, MAINTAIN.extra);
  for (const [arc] of recent) want.add(arc);
  for (const arc of maintained) if (!want.has(arc)) {
    maintained.delete(arc); models.delete(arc); ports.get(arc)?.close(); ports.delete(arc);
    post({ kind: 'release', arc: arc as ArcId });
    for (const p of parked) if (p.arc === arc) fail(p.m, new ConsoleError('unavailable', 'arc is no longer kept current; retry'));
    parked = parked.filter((p) => p.arc !== arc);
  }
  for (const arc of want) if (!maintained.has(arc)) {
    const run = runs.arcs.find((r) => r.arc === arc)!;
    maintained.add(arc); runsOf.set(arc, run);
    post({ kind: 'maintain', arc: arc as ArcId, run });
  }
  for (const [arc, at] of used) if (now - at > MAINTAIN.recentMs && !want.has(arc)) used.delete(arc);
}
function collector(arc: string, port: MessagePort): void {
  const run = runsOf.get(arc);
  if (run === undefined || !maintained.has(arc)) { port.close(); return; }
  ports.get(arc)?.close();
  ports.set(arc, port);
  const model = new ArcModel(run, args.instance, args.repoId, () => revisit(arc));
  models.set(arc, model);
  port.on('message', (m: CollectorMessage) => {
    if (models.get(arc) !== model) return;
    const applied = model.apply(m, Date.now());
    if (m.kind === 'failed') post({ kind: 'arc-error', arc: arc as ArcId, error: m.error });
    if (applied !== 'none') published(arc, model);
    revisit(arc);
  });
}
/** Tells main what changed (the stream's revision and heartbeat notices) and follows subscribed histories. */
function published(arc: string, model: ArcModel): void {
  const e = model.envelope();
  if (e === null || model.failed !== null) return;
  post({ kind: 'checked', ...notice(e), offset: model.journal.offset });
  for (const subscription of historySubscriptions.values()) if (subscription.arc === arc) {
    try {
      const delta = histories.poll(e, subscription.invocation);
      const state = `${delta.state}:${delta.endedAt}`;
      if (delta.reset || delta.events.length || subscription.state !== state) post({ kind: 'history', arc: arc as ArcId, invocation: subscription.invocation, data: delta });
      subscription.state = state;
    } catch (error) { post({ kind: 'history-error', arc: arc as ArcId, invocation: subscription.invocation, error: err(error) }); }
  }
}

parentPort!.on('message', (m: ToServe) => {
  switch (m.kind) {
    case 'cancel': parked = parked.filter((p) => p.m.id !== m.id); return;
    case 'tick': reconcile(); return;
    case 'collector': collector(m.arc, m.port); return;
    case 'collector-down': {
      const model = models.get(m.arc);
      if (model === undefined) return;
      model.failed = m.error; post({ kind: 'arc-error', arc: m.arc, error: m.error }); revisit(m.arc);
      return;
    }
    default: handle(m);
  }
});
reconcile();
post({ kind: 'ready' });
