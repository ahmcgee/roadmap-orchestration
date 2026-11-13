// Server-only row/aggregate foundations. Query modules page these collections into typed wire views.
// Each builder selects recorded fields explicitly and performs no evidence reads or report enrichment.
import { invocationDirName, invocationIdOf, parseInvocationId } from '../core/ids.ts';
import type { Event, Fact, Parent } from '../core/events.ts';
import { sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import { activityState } from '../tui/outcome.ts';
import { completedWaiting } from '../status/waiting.ts';
import { identityIndex, stageIndex, invocationIndex, type StageStep, type UnitIdentity } from './indexes.ts';
import type { Invocation } from '../tui/types.ts';
import { preview } from './views.ts';
import { cpuStageGroups, resourceQueue } from './resources.ts';
import { waitingBreakdown } from './waiting.ts';
import { waitWords, stageWords } from './vocabulary.ts';
import { milestoneReasons } from './milestones.ts';
export { bookingSummaries } from './bookings.ts';
import type { CpuStageGroup, EffortRow, HolisticRow, Interval, Money, RequestSummary, StageSummary, Subject, WaitMeasurement } from './view-protocol.ts';

const noMoney = (): Money => ({costUsd: null, recorded: 0, estimated: 0, unavailable: 0});
const sumMoney = (a: Money, b: Money): Money => ({costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0), recorded: a.recorded + b.recorded, estimated: a.estimated + b.estimated, unavailable: a.unavailable + b.unavailable});
const subjectKey = (s: Subject) => `${s.type}:${s.id}`;
type ChargeFact = Extract<Fact, {kind: 'meter' | 'usage-unavailable'}>;
/** D4: what one meter (or usage-unavailable) fact charges its invocation. */
export function chargeOf(f: ChargeFact): Money {
  const usage = f.kind === 'meter' ? f.usage : f.streamed, known = usage?.costUsd != null;
  return {costUsd: usage?.costUsd ?? null, recorded: known ? 1 : 0,
    estimated: usage?.costEstimated ? 1 : 0, unavailable: f.kind === 'usage-unavailable' || f.incomplete !== undefined || !known ? 1 : 0};
}
/** D4: the enclosing meter is the charge; delegated/session annotations are never added again. */
function chargeIndex(e: Envelope) {
  const byInvocation = new Map<string, Money>(), bySubject = new Map<string, Money>();
  for (const ev of e.data.events) {
    if (ev.type !== 'fact' || (ev.fact.kind !== 'meter' && ev.fact.kind !== 'usage-unavailable')) continue;
    const f = ev.fact, money = chargeOf(f);
    byInvocation.set(f.inv, money);
    const key = f.subject.type === 'seat' ? `unit:${f.subject.unit}` : f.subject.type === 'job' ? `job:${f.subject.job}` : `arc:${e.arc}`;
    bySubject.set(key, sumMoney(bySubject.get(key) ?? noMoney(), money));
  }
  return {byInvocation, bySubject};
}
/** The subject a parent names: its unit (by its title), its job, else `fallback`'s unit when that is a unit, else the arc. */
export function subjectOf(identities: ReadonlyMap<string, UnitIdentity>, arc: string, parent: Parent | undefined, fallback?: string): Subject {
  if (parent?.type === 'stage') return {type: 'unit', id: parent.unit, title: identities.get(parent.unit)?.title.slice(0, 96) ?? parent.unit};
  if (parent?.type === 'job') return {type: 'job', id: parent.job, title: parent.job};
  if (fallback && identities.has(fallback)) return {type: 'unit', id: fallback, title: identities.get(fallback)!.title.slice(0, 96)};
  return {type: 'arc', id: arc, title: 'Arc'};
}
export function projectionIndex(e: Envelope) {
  const identities = identityIndex(e), stages = stageIndex(e.data.events);
  const invocations = invocationIndex(e.data.display.invocations, stages), charges = chargeIndex(e);
  const subject = (parent: Parent | undefined, fallback?: string): Subject => subjectOf(identities, e.arc, parent, fallback);
  return {identities, stages, invocations, charges, subject};
}
type Index = ReturnType<typeof projectionIndex>;
export type SpawnOutcome = Extract<Event, {type: 'done'; kind: 'proc.spawn'}>['outcome'];
/**
 * D3: one invocation's interval, from its display row (`displayInvocation`), its parent and stage step, its spawn's terminal
 * outcome and its charge. Intervals use timestamps; measured wall time never changes an interval's end.
 */
export function intervalOf(i: Invocation, parent: Parent | undefined, step: StageStep | undefined, terminal: SpawnOutcome | undefined, charge: Money | undefined, subject: Subject): Interval {
  let outcome = activityState(i);
  if (outcome === 'result' && terminal?.kind === 'result') outcome = terminal.summary.type === 'command' ? terminal.summary.verdict : terminal.summary.outcome;
  const spend = charge ?? {...noMoney(), unavailable: i.execution === 'agent' ? 1 : 0};
  const id = invocationDirName(invocationIdOf(i.id));
  return {id, invocation: id, subject, stage: parent?.type === 'stage' ? parent.stage : i.role,
    attempt: step?.attempt ?? i.attempt, round: step?.round ?? null, actor: {role: i.role, backend: i.backend ?? null, model: i.model ?? null},
    outcome, startedAt: i.startedAt, endedAt: i.endedAt, wallMs: i.work?.measured?.wallMs ?? null, spend};
}
export function timelineIntervals(e: Envelope, index: Index = projectionIndex(e)): Interval[] {
  const terminals = new Map(e.data.events.flatMap(ev => ev.type === 'done' && ev.kind === 'proc.spawn' ? [[String(ev.op), ev.outcome] as const] : []));
  return index.invocations.rows.map(({invocation: i, parent, step}) =>
    intervalOf(i, parent, step, terminals.get(parseInvocationId(invocationIdOf(i.id)).op), index.charges.byInvocation.get(i.id), index.subject(parent, i.unit)));
}
/** D9: input is the observer's canonical open list, including file-only requests. */
export function attentionSummaries(e: Envelope): RequestSummary[] {
  const identities = identityIndex(e);
  return e.data.requests.map(r => ({id: String(r.id), raisedAt: r.raisedAt, blocking: r.blocking,
    subject: r.subject.type === 'unit' ? {type: 'unit' as const, id: r.subject.unit, title: identities.get(r.subject.unit)?.title.slice(0, 96) ?? r.subject.unit}
      : r.subject.type === 'findings' ? {type: 'findings' as const, count: r.subject.findings.length} : {type: r.subject.type},
    reason: r.reason, summary: preview(r.summary, {type: 'request', id: r.id}), recommendationPreview: preview(r.recommendation, {type: 'request', id: r.id}), evidenceCount: r.evidence.length,
  })).sort((a, b) => Number(b.blocking) - Number(a.blocking) || Date.parse(a.raisedAt) - Date.parse(b.raisedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** D5 totals are completed measurements, not reconstructed historical wait intervals. */
export function waitingMeasurements(e: Envelope, index: Index = projectionIndex(e)) {
  const waiting = completedWaiting(e.data.events);
  const rows: WaitMeasurement[] = waiting.measurements.map((m, n) => {
    const split = waitingBreakdown(m.waited, m.source);
    const subject: Subject = m.source === 'admission' ? {type: 'unit', id: m.unit, title: index.identities.get(m.unit)?.title.slice(0, 96) ?? m.unit} : index.subject(m.parent);
    return {id: `wait:${n}`, subject, stage: m.source === 'admission' ? m.stage : m.parent.type === 'stage' ? m.parent.stage : null,
      source: m.source, at: m.at, totalMs: m.waited.totalMs, heldMs: split.held, queuedMs: split.queued, unallocatedMs: split.unallocated,
      reasons: Object.entries(m.waited.byReasonMs).map(([reason, ms]) => ({reason, ms: ms!}))};
  });
  return {rows, unmeasuredReservations: waiting.unmeasuredReservations};
}
/** D3/D4/D5: lifetime foundation. Later window queries attribute whole measurements at completion. */
export function effortRows(e: Envelope, index: Index = projectionIndex(e)): EffortRow[] {
  const rows = new Map<string, EffortRow>();
  const row = (subject: Subject) => {
    const key = subjectKey(subject); let value = rows.get(key);
    if (!value) {
      value = {subject, state: null, stage: null, systems: [], currentBlockers: {preview: preview('', {type: 'event', id: `scope:${key}`}), count: 0},
        agentMs: null, commandMs: null, heldMs: null, queuedMs: null, unallocatedMs: null, spend: index.charges.bySubject.get(key) ?? noMoney(),
        lifetime: {startedAt: null, endedAt: null, rounds: 0, redChecks: 0}};
      rows.set(key, value);
    }
    return value;
  };
  const why = milestoneReasons(e);
  for (const u of e.data.display.status.units) {
    const identity = index.identities.get(u.unit)!, value = row({type: 'unit', id: u.unit, title: identity.title.slice(0, 96)});
    const steps = index.stages.byUnit.get(u.unit) ?? [], invs = index.invocations.byUnit.get(u.unit) ?? [];
    const reasons = waitWords(u.waitingFor, why);
    if (u.state === 'parked') reasons.push(`Parked at ${stageWords(u.stage)}${steps.at(-1) ? `: ${steps.at(-1)!.outcome}` : ''}`);
    const position = resourceQueue(e.data.display.status.host).filter(q => q.request.publication).findIndex(q => q.unit === u.unit);
    if (position >= 0) reasons.push(`Integration queue position ${position + 1}`);
    value.state = u.state; value.stage = u.stage; value.systems = identity.systems;
    value.currentBlockers = {preview: preview(reasons.join('; '), {type: 'unit', id: u.unit}), count: reasons.length};
    value.lifetime = {startedAt: steps[0]?.at ?? invs.at(-1)?.startedAt ?? null,
      endedAt: ['merged', 'cut', 'superseded', 'parked'].includes(u.state) ? steps.at(-1)?.endedAt ?? null : null,
      rounds: Math.max(0, ...steps.map(s => s.round)), redChecks: 0};
  }
  const intervals = new Map(timelineIntervals(e, index).map(i => [i.id, i]));
  for (const {invocation: i, parent} of index.invocations.rows) {
    const value = row(index.subject(parent, i.unit));
    const wall = i.endedAt ? i.work?.measured?.wallMs : undefined;
    if (wall !== undefined && i.execution !== undefined) {
      const key = i.execution === 'agent' ? 'agentMs' : 'commandMs'; value[key] = (value[key] ?? 0) + wall;
    }
    if (i.execution === 'agent' && !index.charges.byInvocation.has(i.id)) value.spend = {...value.spend, unavailable: value.spend.unavailable + 1};
    if (i.execution === 'command' && /fail/.test(intervals.get(invocationDirName(invocationIdOf(i.id)))!.outcome)) value.lifetime.redChecks++;
  }
  // Meter-only subjects and Arc startup smokes must reconcile without becoming unit links.
  for (const key of index.charges.bySubject.keys()) {
    if (rows.has(key)) continue;
    const [type, ...id] = key.split(':'); row({type: type as Subject['type'], id: id.join(':'), title: type === 'arc' ? 'Arc' : id.join(':')});
  }
  for (const m of waitingMeasurements(e, index).rows) {
    const value = row(m.subject);
    value.heldMs = (value.heldMs ?? 0) + m.heldMs; value.queuedMs = (value.queuedMs ?? 0) + m.queuedMs;
    value.unallocatedMs = (value.unallocatedMs ?? 0) + m.unallocatedMs;
  }
  return [...rows.values()];
}
/** D7 matched samples and coverage reuse the canonical pass-0 weighted aggregation. */
export function cpuSummaries(e: Envelope): CpuStageGroup[] {
  return cpuStageGroups([...e.data.display.status.host.work, ...e.data.display.status.units.flatMap(u => u.work)]).map(g => {
    const id = sha256Hex(g.id);
    return {id, parent: {type: g.parent.type === 'stage' ? 'unit' : g.parent.type === 'job' ? 'job' : 'arc',
      id: g.parent.type === 'stage' ? g.parent.unit : g.parent.type === 'job' ? g.parent.job : e.arc,
      stage: g.parent.type === 'stage' ? g.parent.stage : null, attempt: g.parent.type === 'stage' ? g.parent.attempt : null},
      measuredRunMs: g.runMs, measuredWallMs: g.wallMs, reservedCoreMs: g.reservedCoreMs,
      averageCores: g.averageCores, weightedReservedCores: g.reservedCores, reservationPercent: g.reservationPercent,
      measuredCalls: g.measuredCalls, excludedCalls: g.excludedCalls, unmeasuredCalls: g.unmeasuredCalls, zeroWallCalls: g.zeroWallCalls,
      unreservedCalls: g.unreservedCalls, unreservedAverageCores: g.unreservedAverageCores, detailKey: id};
  });
}
/** D3 base stage summaries; the Activity index adds typed event/park evidence. */
export function stageSummaries(e: Envelope): StageSummary[] {
  return [...stageIndex(e.data.events).steps.values()].map(s => ({id: s.id, unit: s.id.slice(0, s.id.lastIndexOf(':')), stage: s.stage,
    attempt: s.attempt, round: s.round, at: s.at, endedAt: s.endedAt, outcome: s.outcome, housekeeping: s.housekeeping,
    detail: {type: 'event', id: s.id}}));
}
/** D10 no checkpoint body, invented date or finding/request conflation. */
export function holisticSummaries(e: Envelope): HolisticRow[] {
  const s = e.data.display.status, dates = new Map(e.data.events.map(ev => [Number(ev.seq), ev.at]));
  const verdicts = new Map(e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'stage-outcome' && 'job' in ev.fact && ev.fact.stage === 'campaign-audit' ? [[String(ev.fact.job), ev.fact.verdict] as const] : []));
  return [
    ...e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'audit-ended' ? [{type: 'audit' as const, id: String(ev.seq), at: ev.at,
      job: ev.fact.job, outcome: ev.fact.outcome, verdict: verdicts.get(String(ev.fact.job)) ?? null, coverageCount: ev.fact.covered.length, findingCount: ev.fact.findings.length, detail: {type: 'event' as const, id: String(ev.seq)}}] : []),
    ...s.findings.active.map(f => ({type: 'finding' as const, id: String(f.id), claim: preview(f.claim, {type: 'event', id: String(f.id)}), state: f.state, detail: {type: 'event' as const, id: String(f.id)}})),
    ...s.decisionsSince.map(d => ({type: 'decision' as const, id: d.id, seq: Number(d.seq), at: dates.get(d.seq) ?? null, kind: d.kind,
      oneLine: preview(d.oneLine, {type: 'event', id: String(d.seq)}), ruledBy: d.ruledBy.type === 'architect' ? {type: 'architect' as const, command: d.ruledBy.command} : d.ruledBy.type === 'judgment' ? {type: 'judgment' as const, role: d.ruledBy.role} : {type: 'executor' as const}, detail: {type: 'event' as const, id: String(d.seq)}})),
  ];
}
/** D2/D6/D7 current owner-validated queue order and reservation tokens, never utilization. */
export function resourceNow(e: Envelope): import('./view-protocol.ts').ResourceNow {
  const host = e.data.display.status.host, cpu = host.pools['@cpu'];
  return {queueAvailable: e.data.display.status.run.owner.state !== 'alive' ? false : host.queue.length + host.jobQueue.length > 0 ? true : null,
    queues: resourceQueue(host).map((q, n) => ({id: `queue:${n}`, subject: q.label, unitId: q.unit ?? null,
      queuedAt: q.queuedAt === undefined ? null : new Date(q.queuedAt).toISOString(), publication: q.request.publication,
      named: [...q.request.named], pools: [...q.request.pools], cpu: q.request.cpu})),
    resources: host.resources.map(r => ({resource: r.resource, state: r.state, holder: r.holder === null ? null : holderLabel(r.holder), pending: r.pending})),
    pools: Object.entries(host.pools).map(([id, p]) => ({id, size: p.size, used: p.used, dirty: p.dirty})),
    cpuReservation: cpu ? {used: cpu.used, capacity: cpu.size} : null};
}
function holderLabel(h: import('../core/events.ts').Holder): string {
  return 'unit' in h ? h.unit : h.type === 'job' ? h.job : h.type === 'docs' ? h.pub : h.type === 'sweep' ? h.command : `${h.finding}:${h.attempt}`;
}
