// Typed summaries and source references over a verified prefix. No report sweep,
// transcript parsing, canonical blobs or alternate execution-state fold.
import type { Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf, invocationId, parseInvocationId, needsUserId } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { needsUserRecord, type NeedsUserRecord } from '../core/records.ts';
import { needsUserPath } from '../needsuser.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { projectionIndex, timelineIntervals } from './tab-projections.ts';
import { readEvidence } from './evidence.ts';
import { preview } from './views.ts';
import { activityKey, backendHolds } from './backend-holds.ts';
import { backendWords, holdClassWords, outcomeWords, plainWords, runOutcomeWords, stageWords } from './vocabulary.ts';
import type { ActivityRow, ActivityKind, Actor, BackendHold } from './activity-protocol.ts';
import type { Subject, Money, Interval } from './view-protocol.ts';

export type RequestRef = {id: string; sha256: string};
export type ActivityEntry = {row: ActivityRow; actors: Actor[]; invocations: string[]; request: RequestRef | null; search: string};
export type ActivityIndex = {
  version: string; bytes: number; entries: ActivityEntry[]; holds: BackendHold[];
  units: string[]; milestones: {id: string; units: string[]}[];
};
/** D9: never trust a query path or cached/open record in place of its recorded digest. */
export function activityRequest(e: Envelope, ref: RequestRef): NeedsUserRecord | null {
  let bytes: Buffer;
  try { bytes = readEvidence(e.data.display.run.runDir, needsUserPath(e.data.display.run.runDir, needsUserId(ref.id))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (sha256Hex(bytes) !== ref.sha256) throw new ConsoleError('invalid', 'retained request does not match its recorded digest');
  const r = needsUserRecord(JSON.parse(bytes.toString('utf8')), 'Activity request');
  if (r.id !== ref.id || r.arc !== e.arc) throw new ConsoleError('corruption', 'request identity does not match this Arc');
  return r;
}
const aggregateMoney = (rows: Interval[]): Money | null => {
  if (!rows.length) return null;
  const sum: Money = {costUsd: null, recorded: 0, estimated: 0, unavailable: 0};
  for (const i of rows) {
    if (i.spend.costUsd !== null) sum.costUsd = (sum.costUsd ?? 0) + i.spend.costUsd;
    sum.recorded += i.spend.recorded; sum.estimated += i.spend.estimated; sum.unavailable += i.spend.unavailable;
  }
  return sum;
};
export function buildActivityIndex(e: Envelope): ActivityIndex {
  const steps = activityIndexSteps(e);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** The index, built in steps a caller may run one per turn of its event loop (the console's serve worker does). */
export function* activityIndexSteps(e: Envelope): Generator<undefined, ActivityIndex, undefined> {
  const index = projectionIndex(e), intervals = timelineIntervals(e, index), byRoute = new Map(intervals.map(i => [i.id, i]));
  const byStep = new Map<string, string[]>(), byOp = new Map<string, string[]>(), byJob = new Map<string, string[]>();
  const agents = new Set(index.invocations.rows.filter(i => i.invocation.execution === 'agent').map(i => invocationDirName(invocationIdOf(i.invocation.id))));
  for (const {invocation, parent} of index.invocations.rows) {
    const route = invocationDirName(invocationIdOf(invocation.id)), {op} = parseInvocationId(invocationIdOf(invocation.id));
    byOp.set(op, [...(byOp.get(op) ?? []), route]);
    if (parent?.type === 'job') byJob.set(parent.job, [...(byJob.get(parent.job) ?? []), route]);
    if (parent?.type === 'stage') {
      const key = `${parent.unit}:${parent.stage}:${parent.attempt}`, rows = byStep.get(key) ?? [];
      rows.push(route); byStep.set(key, rows);
    }
  }
  const entries: ActivityEntry[] = [], holds = backendHolds(e.data.events, e.epoch);
  const holdStarts = new Map<number, BackendHold>(), holdClosures = new Map<number, BackendHold>();
  for (const h of holds) {
    if (!holdStarts.has(h.startSeq)) holdStarts.set(h.startSeq, h);
    if (h.closure && h.closure.kind !== 'park-updated' && !holdClosures.has(h.closure.seq)) holdClosures.set(h.closure.seq, h);
  }
  const arc: Subject = {type: 'arc', id: e.arc, title: 'Arc'};
  const unit = (id: string): Subject => ({type: 'unit', id, title: index.identities.get(id)?.title.slice(0, 96) ?? id});
  const add = (ev: Event, kind: ActivityKind, text: string, fields: Partial<Omit<ActivityRow, 'result'>> & {result?: string} = {}, refs: string[] = [], request: RequestRef | null = null, subkey = '') => {
    const id = activityKey(e.epoch, ev.seq, kind) + (subkey ? `-${sha256Hex(subkey).slice(0, 24)}` : ''), detail = {type: 'event' as const, id};
    const joined = refs.map(id => byRoute.get(id)!).filter(Boolean), completed = joined.filter(i => i.endedAt !== null);
    const measured = completed.filter(i => i.wallMs !== null), actors = new Map<string, Actor>();
    // Actors and entries are built here in a fixed key order, so their JSON is already canonical for identity and hashing.
    for (const i of joined) actors.set(JSON.stringify(i.actor), i.actor);
    if (fields.actor) actors.set(JSON.stringify(fields.actor), fields.actor);
    const row: ActivityRow = {id, seq: ev.seq, at: ev.at, kind, subject: arc, stage: null, attempt: null, round: null,
      actor: actors.size === 1 ? [...actors.values()][0]! : null, actorCount: actors.size,
      outcome: null, summary: preview(text, detail), workMs: measured.length ? measured.reduce((n, i) => n + i.wallMs!, 0) : null,
      spend: aggregateMoney(joined.filter(i => agents.has(i.id))), coverage: {measured: measured.length, unmeasured: joined.length - measured.length},
      detail, housekeeping: false, ...fields, result: fields.result === undefined ? null : preview(fields.result, detail)};
    const search = [row.summary.text, row.subject.id, row.subject.title, row.stage, row.stage ? stageWords(row.stage) : null, row.outcome, request?.id,
      ...[...actors.values()].flatMap(a => [a.role, a.backend, a.model])].filter(v => v != null).join(' ').toLowerCase();
    entries.push({row, actors: [...actors.values()], invocations: refs, request, search});
  };
  yield;
  const findings = new Map(e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened' ? [[String(ev.fact.id), ev.fact] as const] : []));
  const raises = new Map(e.data.events.flatMap(ev => ev.type === 'intent' && ev.kind === 'needsuser.raise' ? [[String(ev.expect.id), {id: String(ev.expect.id), sha256: ev.post.sha256}] as const] : []));
  let n = 0;
  for (const ev of e.data.events) {
    if (++n % 2_000 === 0) yield;
    if (ev.type === 'intent' && ev.kind === 'needsuser.raise') {
      const ref = raises.get(ev.expect.id)!, request = activityRequest(e, ref);
      add(ev, 'request-raised', `Decision requested: ${request?.summary ?? `Request ${ref.id}; evidence pruned`}`,
        {subject: !request ? {type: 'request', id: ref.id, title: 'Decision request'} : request.subject.type === 'unit' ? unit(request.subject.unit)
          : request.subject.type === 'arc' ? arc : {type: request.subject.type, id: null, title: request.subject.type === 'host' ? 'Host' : 'Findings'}, outcome: 'raised', ...(request ? {result: request.summary} : {})}, [], ref);
    } else if (ev.type === 'intent' && ev.kind === 'proc.spawn') {
      const i = byRoute.get(invocationDirName(invocationId(ev.op, ev.ordinal)));
      if (i) add(ev, 'invocation-started', `${stageWords(i.stage)} run started`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: 'started', workMs: null, spend: null}, [i.id]);
    } else if (ev.type === 'done' && ev.kind === 'proc.spawn') {
      const refs = byOp.get(ev.op) ?? [], i = refs.length === 1 ? byRoute.get(refs[0]!) : null;
      if (i) add(ev, 'invocation-ended', `${stageWords(i.stage)} run: ${runOutcomeWords(i.outcome)}`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: i.outcome}, [i.id]);
      else if (refs.length) add(ev, 'invocation-ended', 'Runs finished; several attempts recorded', {outcome: ev.outcome.kind}, refs);
    } else if (ev.type === 'fact') {
      const f = ev.fact;
      if (f.kind === 'stage-outcome' && 'unit' in f) {
        const step = index.stages.steps.get(`${f.unit}:${f.attempt}`), refs = byStep.get(`${f.unit}:${f.stage}:${f.attempt}`) ?? [];
        add(ev, 'stage-outcome', `${f.unit}: ${stageWords(f.stage)} — ${step?.outcome ?? f.outcome}`,
          {subject: unit(f.unit), stage: f.stage, attempt: step?.attempt ?? null, round: step?.round ?? null,
            outcome: f.outcome, result: step?.outcome ?? outcomeWords(f.outcome), housekeeping: step?.housekeeping ?? false}, refs);
      } else if (f.kind === 'stage-outcome') {
        add(ev, 'stage-outcome', `${stageWords(f.stage)}: ${f.verdict}`, {subject: {type: 'job', id: f.job, title: f.job}, stage: f.stage, outcome: f.verdict}, byJob.get(f.job) ?? []);
      } else if (f.kind === 'plan-applied') add(ev, f.kind, `Plan revision ${f.rev} applied`, {outcome: 'applied'});
      else if (f.kind === 'arc-completed' || f.kind === 'stop-completed') add(ev, f.kind, f.kind === 'arc-completed' ? 'Arc completed' : 'Arc stopped', {outcome: f.kind === 'arc-completed' ? 'completed' : 'stopped'});
      else if (f.kind === 'needs-user-acked') add(ev, 'request-acknowledged', `Decision request ${f.id} answered`, {outcome: 'acknowledged'}, [], raises.get(f.id) ?? null);
      else if (f.kind === 'audit-started' || f.kind === 'audit-ended') {
        add(ev, f.kind, f.kind === 'audit-started' ? 'Holistic audit started' : `Holistic audit ${f.outcome}: ${f.findings.length} ${f.findings.length === 1 ? 'finding' : 'findings'}`,
          {subject: {type: 'job', id: f.job, title: f.job}, outcome: f.kind === 'audit-started' ? 'started' : f.outcome, ...(f.kind === 'audit-ended' ? {result: `${plainWords(f.outcome)}, ${f.findings.length} new ${f.findings.length === 1 ? 'finding' : 'findings'}`} : {})}, f.kind === 'audit-ended' ? byJob.get(f.job) ?? [] : []);
      } else if (f.kind === 'finding-opened' || f.kind === 'finding-transition') {
        const finding = findings.get(f.id), source = finding?.source, subject = source?.type === 'stage' ? unit(source.unit) : source?.type === 'job' ? {type: 'job' as const, id: source.job, title: source.job} : arc;
        add(ev, f.kind, `${f.id}: ${finding?.claim ?? 'Finding'} — ${f.kind === 'finding-opened' ? 'open' : f.to.state}`,
          {subject, outcome: f.kind === 'finding-opened' ? 'open' : f.to.state, result: `${f.id}: ${finding?.claim ?? 'Finding'} (${plainWords(f.kind === 'finding-opened' ? 'open' : f.to.state)})`});
      } else if (f.kind === 'backend-park') {
        const h = holdStarts.get(ev.seq)!;
        add(ev, 'backend-park', `${backendWords(f.backend)} unavailable to new calls: ${holdClassWords(h.effectiveClass).toLowerCase()}`,
          {actor: {role: null, backend: f.backend, model: null}, actorCount: 1, outcome: h.effectiveClass});
      }
      const closed = holdClosures.get(ev.seq);
      if (closed) add(ev, 'backend-closure', `${backendWords(closed.backend)} available again (${closed.closure!.kind === 'probe' ? 'a check passed' : 'resumed'})`,
        {actor: {role: null, backend: closed.backend, model: null}, actorCount: 1, outcome: 'available'});
    }
  }
  // D10 root decisions can share a source event; subkind is part of their stable identity.
  const bySeq = new Map(e.data.display.status.decisionsSince.length ? e.data.events.map(ev => [ev.seq, ev]) : []);
  for (const d of e.data.display.status.decisionsSince) {
    const ev = bySeq.get(d.seq); if (!ev) continue;
    add(ev, 'decision', `${d.id}: ${d.oneLine}`, {outcome: d.kind}, [], null, d.id);
  }
  yield;
  entries.sort((a, b) => a.row.seq - b.row.seq || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  yield;
  const units = [...index.identities.keys()], milestones = e.data.display.status.milestones.map(m => ({id: String(m.id), units: m.members.map(String)}));
  // One serialization gives the index's identity and its retained size.
  const json = JSON.stringify({entries, units, milestones});
  return {version: sha256Hex(json), bytes: Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(holds)), entries, holds, units, milestones};
}
