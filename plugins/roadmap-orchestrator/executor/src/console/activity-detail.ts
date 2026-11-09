// Selected Activity evidence, resolved only through this Arc's typed event index.
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { record } from '../tui/projection.ts';
import { boundDetail, contentDetail } from './detail-content.ts';
import { activityRequest, type ActivityEntry } from './activity-index.ts';
import type { ConsoleActivity } from './activity-query.ts';
import type { ActivityDetail } from './activity-protocol.ts';
import { retainedReport } from './reports.ts';
import { detailAvailability } from './detail-metadata.ts';
import { projectionIndex, timelineIntervals } from './tab-projections.ts';
import { versioned } from './views.ts';

function selected(e: Envelope, activity: ConsoleActivity, id: string) {
  const entry = activity.index(e).entries.find(entry => entry.row.id === id);
  if (!entry) throw new ConsoleError('not-found', 'Activity event is not recorded in this Arc and epoch');
  return entry;
}
function rawDetail(e: Envelope, activity: ConsoleActivity, entry: ActivityEntry): ActivityDetail {
  const ev = e.data.events.find(ev => ev.seq === entry.row.seq);
  if (!ev) throw new ConsoleError('reset', 'Activity source event changed; reload this view');
  const context: ActivityDetail['context'] = [], add = (label: string, value: string | number | boolean) => {context.push({label, value: String(value)});};
  const index = projectionIndex(e), routes = new Set(entry.invocations), intervals = timelineIntervals(e, index).filter(i => routes.has(i.id));
  const invocations = intervals.map(i => ({id: i.id, subject: i.subject, stage: i.stage, attempt: i.attempt, actor: i.actor,
    startedAt: i.startedAt, endedAt: i.endedAt, wallMs: i.wallMs, spend: i.spend}));
  let evidenceAvailability: ActivityDetail['evidenceAvailability'] = 'not-applicable';
  if (entry.request) {
    const r = activityRequest(e, entry.request); evidenceAvailability = r ? 'available' : 'pruned';
    if (r) {
      add('Request', r.id); add('Summary', r.summary); add('Blocking', r.blocking); add('Reason', r.reason); add('Raised at', r.raisedAt);
      add('Subject', r.subject.type === 'unit' ? `Unit ${r.subject.unit}` : r.subject.type);
      if (r.subject.type === 'findings') for (const finding of r.subject.findings) add('Related finding', finding);
      add('Recommendation', r.recommendation);
      for (const option of r.options) add(`Option ${option.id}`, option.label);
      for (const path of r.evidence) add('Recorded evidence path', path);
      // Open-list membership says only what it proves. Resolution is stated only from a recorded ack.
      add('Currently in open list', e.data.requests.some(open => open.id === r.id));
    }
  }
  if (ev.type === 'fact') {
    const f = ev.fact;
    if (f.kind === 'stage-outcome' && 'unit' in f) {
      add('Outcome', f.outcome); add('Outcome class', f.class); add('Parent stage sequence', f.attempt); add('Chargeable', f.chargeable);
      if (f.detail && 'summary' in f.detail) add('Recorded detail', String(f.detail.summary));
    } else if (f.kind === 'plan-applied') {add('Plan revision', f.rev); if (f.command) add('Command', f.command);}
    else if (f.kind === 'arc-completed') {add('Plan revision', f.planRev); add('Integration head', f.head); add('Completed units', f.units.length);}
    else if (f.kind === 'needs-user-acked') {add('Request', f.id); add('Command', f.command); if (f.choice !== null) add('Choice', f.choice); add('Resolution', 'Acknowledged by a recorded journal fact');}
    else if (f.kind === 'audit-started') {add('Audit job', f.job); for (const lens of f.lenses) add('Lens', lens);}
    else if (f.kind === 'audit-ended') {
      add('Audit job', f.job); add('Outcome', f.outcome); add('Suppressed findings', f.suppressed);
      for (const range of f.covered) add('Recorded coverage', `${range.lens}: ${range.from} to ${range.to}`);
      for (const finding of f.findings) add('Finding', finding);
      for (const refusal of f.refused) add('Refused lens', `${refusal.lens}: ${refusal.claim}; ${refusal.reason}`);
      add('Detail limitation', 'Checkpoint job detail is not included in this console yet.');
    } else if (f.kind === 'finding-opened') {
      add('Finding', f.id); add('Claim', f.claim); add('State at this event', 'open'); add('Severity', f.severity);
      for (const evidence of f.evidence) add('Recorded evidence path', evidence.path);
    } else if (f.kind === 'finding-transition') {add('Finding', f.id); add('State at this event', f.to.state);}
  }
  if (entry.row.kind === 'decision') {
    for (const d of e.data.display.status.decisionsSince.filter(d => d.seq === ev.seq)) {
      add('Decision', d.id); add('Decision summary', d.oneLine); add('Kind', d.kind); add('Ruled by', d.ruledBy.type);
      if (d.ruledBy.type === 'architect' && d.ruledBy.command) add('Command', d.ruledBy.command);
      else if (d.ruledBy.type === 'judgment') add('Recorded role', d.ruledBy.role);
    }
  }
  for (const i of e.data.display.invocations.filter(i => routes.has(invocationDirName(invocationIdOf(i.id))) && i.execution === 'agent' && i.endedAt)) {
    const available = detailAvailability(e, i).result;
    const report = retainedReport(e, i.id);
    if (available === 'pruned') {evidenceAvailability = 'pruned'; continue;}
    if (!report) continue;
    if (evidenceAvailability !== 'pruned') evidenceAvailability = 'available';
    if (typeof report['decision'] === 'string') add('Recorded decision', report['decision']);
    if (Array.isArray(report['findings'])) for (const finding of report['findings']) {
      const r = record(finding), title = r['title'] ?? r['what'] ?? r['summary'] ?? r['description'];
      if (typeof title === 'string') add('Review finding', title);
    }
  }
  const holds = activity.index(e).holds;
  const backendHold = holds.find(h => h.id === entry.row.id) ?? holds.find(h => h.closure?.kind !== 'park-updated' && h.closure?.detail.id === entry.row.id) ?? null;
  return versioned({row: entry.row, context, invocations, evidenceAvailability, backendHold}, {basis: 'recorded-arc', from: null, to: null});
}
export function activityDetail(e: Envelope, activity: ConsoleActivity, id: string, params: Record<string, string>) {
  for (const key of Object.keys(params)) if (!['epoch', 'revision', 'minHighWater', 'section', 'cursor'].includes(key)) throw new ConsoleError('invalid', 'unknown Activity detail query parameter');
  if (params['section'] !== undefined && params['section'] !== 'content' || params['cursor'] !== undefined && params['section'] !== 'content' || params['section'] === 'content' && !params['cursor']) throw new ConsoleError('invalid', 'Activity field expansion requires section=content and its cursor');
  const entry = selected(e, activity, id), data = rawDetail(e, activity, entry), entity = `activity:${id}`;
  if (params['section'] === 'content') {
    // Revalidate selected request/report evidence on every continuation, including cache hits.
    if (data.evidenceAvailability === 'pruned') throw new ConsoleError('reset', 'Selected Activity evidence was pruned; reopen this detail');
    return contentDetail(e, entity, params['cursor']!, 64 * 1024);
  }
  return boundDetail(e, entity, data, 32 * 1024, current => rawDetail(current, activity, selected(current, activity, id)));
}
