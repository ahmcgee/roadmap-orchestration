// Typed summaries and source references over a verified prefix. No report sweep,
// transcript parsing, canonical blobs or alternate execution-state fold.
import type { Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf, invocationId, parseInvocationId, needsUserId } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { needsUserRecord, type NeedsUserRecord } from '../core/records.ts';
import { needsUserPath } from '../needsuser.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { projectionIndex, timelineIntervals } from './tab-projections.ts';
import { readEvidence } from './evidence.ts';
import { preview } from './views.ts';
import { activityKey, backendHolds } from './backend-holds.ts';
import { stageWords } from './vocabulary.ts';
import type { ActivityRow, ActivityKind, Actor, BackendHold } from './activity-protocol.ts';
import type { Subject, Money, Interval } from './view-protocol.ts';

export type RequestRef = {id: string; sha256: string};
export type ActivityEntry = {row: ActivityRow; actors: Actor[]; invocations: string[]; request: RequestRef | null; search: string};
export type ActivityIndex = {
  version: string; entries: ActivityEntry[]; holds: BackendHold[];
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
  const arc: Subject = {type: 'arc', id: e.arc, title: 'Arc'};
  const unit = (id: string): Subject => ({type: 'unit', id, title: index.identities.get(id)?.title.slice(0, 96) ?? id});
  const add = (ev: Event, kind: ActivityKind, text: string, fields: Partial<ActivityRow> = {}, refs: string[] = [], request: RequestRef | null = null, subkey = '') => {
    const id = activityKey(e.epoch, ev.seq, kind) + (subkey ? `-${sha256Hex(subkey).slice(0, 24)}` : ''), detail = {type: 'event' as const, id};
    const joined = refs.map(id => byRoute.get(id)!).filter(Boolean), completed = joined.filter(i => i.endedAt !== null);
    const measured = completed.filter(i => i.wallMs !== null), actors = new Map<string, Actor>();
    for (const i of joined) actors.set(canonicalJson(i.actor), i.actor);
    if (fields.actor) actors.set(canonicalJson(fields.actor), fields.actor);
    const row: ActivityRow = {id, seq: ev.seq, at: ev.at, kind, subject: arc, stage: null, attempt: null, round: null,
      actor: actors.size === 1 ? [...actors.values()][0]! : null, actorCount: actors.size,
      outcome: null, summary: preview(text, detail), workMs: measured.length ? measured.reduce((n, i) => n + i.wallMs!, 0) : null,
      spend: aggregateMoney(joined.filter(i => agents.has(i.id))), coverage: {measured: measured.length, unmeasured: joined.length - measured.length},
      detail, housekeeping: false, ...fields};
    const search = [row.summary.text, row.subject.id, row.subject.title, row.stage, row.outcome, request?.id,
      ...[...actors.values()].flatMap(a => [a.role, a.backend, a.model])].filter(v => v != null).join(' ').toLowerCase();
    entries.push({row, actors: [...actors.values()], invocations: refs, request, search});
  };
  const findings = new Map(e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened' ? [[String(ev.fact.id), ev.fact] as const] : []));
  const raises = new Map(e.data.events.flatMap(ev => ev.type === 'intent' && ev.kind === 'needsuser.raise' ? [[String(ev.expect.id), {id: String(ev.expect.id), sha256: ev.post.sha256}] as const] : []));
  for (const ev of e.data.events) {
    if (ev.type === 'intent' && ev.kind === 'needsuser.raise') {
      const ref = raises.get(ev.expect.id)!, request = activityRequest(e, ref);
      add(ev, 'request-raised', `Question raised: ${request?.summary ?? `Human request ${ref.id}; evidence pruned`}`,
        {subject: !request ? {type: 'request', id: ref.id, title: 'Human request'} : request.subject.type === 'unit' ? unit(request.subject.unit)
          : request.subject.type === 'arc' ? arc : {type: request.subject.type, id: null, title: request.subject.type === 'host' ? 'Host' : 'Findings'}, outcome: 'raised'}, [], ref);
    } else if (ev.type === 'intent' && ev.kind === 'proc.spawn') {
      const i = byRoute.get(invocationDirName(invocationId(ev.op, ev.ordinal)));
      if (i) add(ev, 'invocation-started', `${stageWords(i.stage)} invocation started`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: 'started', workMs: null, spend: null}, [i.id]);
    } else if (ev.type === 'done' && ev.kind === 'proc.spawn') {
      const refs = byOp.get(ev.op) ?? [], i = refs.length === 1 ? byRoute.get(refs[0]!) : null;
      if (i) add(ev, 'invocation-ended', `${stageWords(i.stage)} invocation: ${i.outcome}`, {subject: i.subject, stage: i.stage, attempt: i.attempt, round: i.round, outcome: i.outcome}, [i.id]);
      else if (refs.length) add(ev, 'invocation-ended', 'Invocation operation completed; multiple recorded attempts', {outcome: ev.outcome.kind}, refs);
    } else if (ev.type === 'fact') {
      const f = ev.fact;
      if (f.kind === 'stage-outcome' && 'unit' in f) {
        const step = index.stages.steps.get(`${f.unit}:${f.attempt}`), refs = byStep.get(`${f.unit}:${f.stage}:${f.attempt}`) ?? [];
        add(ev, 'stage-outcome', `${f.unit}: ${stageWords(f.stage)} — ${step?.outcome ?? f.outcome}`,
          {subject: unit(f.unit), stage: f.stage, attempt: step?.attempt ?? null, round: step?.round ?? null,
            outcome: f.outcome, housekeeping: step?.housekeeping ?? false}, refs);
      } else if (f.kind === 'stage-outcome') {
        add(ev, 'stage-outcome', `${stageWords(f.stage)}: ${f.verdict}`, {subject: {type: 'job', id: f.job, title: f.job}, stage: f.stage, outcome: f.verdict}, byJob.get(f.job) ?? []);
      } else if (f.kind === 'plan-applied') add(ev, f.kind, `Plan revision ${f.rev} applied`, {outcome: 'applied'});
      else if (f.kind === 'arc-completed' || f.kind === 'stop-completed') add(ev, f.kind, f.kind === 'arc-completed' ? 'Arc completed' : 'Arc stopped', {outcome: f.kind === 'arc-completed' ? 'completed' : 'stopped'});
      else if (f.kind === 'needs-user-acked') add(ev, 'request-acknowledged', `Human request ${f.id} acknowledged`, {outcome: 'acknowledged'}, [], raises.get(f.id) ?? null);
      else if (f.kind === 'audit-started' || f.kind === 'audit-ended') {
        add(ev, f.kind, f.kind === 'audit-started' ? 'Holistic audit started' : `Holistic audit ${f.outcome}: ${f.findings.length} ${f.findings.length === 1 ? 'finding' : 'findings'}`,
          {subject: {type: 'job', id: f.job, title: f.job}, outcome: f.kind === 'audit-started' ? 'started' : f.outcome}, f.kind === 'audit-ended' ? byJob.get(f.job) ?? [] : []);
      } else if (f.kind === 'finding-opened' || f.kind === 'finding-transition') {
        const finding = findings.get(f.id), source = finding?.source, subject = source?.type === 'stage' ? unit(source.unit) : source?.type === 'job' ? {type: 'job' as const, id: source.job, title: source.job} : arc;
        add(ev, f.kind, `${f.id}: ${finding?.claim ?? 'Finding'} — ${f.kind === 'finding-opened' ? 'open' : f.to.state}`,
          {subject, outcome: f.kind === 'finding-opened' ? 'open' : f.to.state});
      } else if (f.kind === 'backend-park') {
        const h = holds.find(h => h.startSeq === ev.seq)!;
        add(ev, 'backend-park', `${f.backend}: backend unavailable to new calls (${h.effectiveClass})`,
          {actor: {role: null, backend: f.backend, model: null}, actorCount: 1, outcome: h.effectiveClass});
      }
      const closed = holds.find(h => h.closure?.seq === ev.seq && h.closure.kind !== 'park-updated');
      if (closed) add(ev, 'backend-closure', `${closed.backend}: backend availability restored by ${closed.closure!.kind}`,
        {actor: {role: null, backend: closed.backend, model: null}, actorCount: 1, outcome: 'available'});
    }
  }
  // D10 root decisions can share a source event; subkind is part of their stable identity.
  for (const d of e.data.display.status.decisionsSince) {
    const ev = e.data.events.find(ev => ev.seq === d.seq); if (!ev) continue;
    add(ev, 'decision', `${d.id}: ${d.oneLine}`, {outcome: d.kind}, [], null, d.id);
  }
  entries.sort((a, b) => a.row.seq - b.row.seq || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const units = [...index.identities.keys()], milestones = (e.data.plan?.milestones ?? []).map(m => ({id: String(m.id), units: [...m.units]}));
  return {version: sha256Hex(canonicalJson({entries, units, milestones})), entries, holds, units, milestones};
}
