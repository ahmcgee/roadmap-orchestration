// Adapters contain only recorded quantities. DS states supplement, never replace, executor labels.
import { type Event, type IntentOf } from '../core/events.ts';
import { invocationDirName, invocationIdOf, parseResourceUnit, type ResourceUnit } from '../core/ids.ts';
import type { Waited, WaitReason } from '../core/waiting.ts';
import { completedWaiting } from '../status/waiting.ts';
import type { UnitRunState } from '../status.ts';
import { activityState } from '../tui/outcome.ts';
import type { Envelope } from '../observation/protocol.ts';
import { project } from '../tui/projection.ts';

export type GraphStatus = 'passed' | 'active' | 'held' | 'pending' | 'failed';
export function graphStatus(state: UnitRunState): GraphStatus {
  switch (state) {
    case 'merged': return 'passed';
    case 'running': case 'preparing': return 'active';
    case 'held': case 'blocked': case 'parked': case 'awaiting-admission': return 'held';
    case 'waiting': case 'ready': case 'cut': case 'superseded': return 'pending';
  }
}
const QUEUED_ADMISSIONS = new Set(['dependency', 'contingent-edge', 'milestone', 'host-pressure', 'compare', 'deflake', 'repair-batch']);
export function waitingCategory(reason: WaitReason): 'held' | 'queued' {
  return reason.startsWith('admission-hold:') && !QUEUED_ADMISSIONS.has(reason.slice('admission-hold:'.length)) ? 'held' : 'queued';
}
export function waitingBreakdown(waited: Waited, source: 'admission' | 'reservation') {
  const categories = new Set(Object.keys(waited.byReasonMs).map((r) => source === 'reservation' ? 'queued' : waitingCategory(r as WaitReason)));
  const kind = categories.size === 1 ? [...categories][0] : null;
  return { held: kind === 'held' ? waited.totalMs : 0, queued: kind === 'queued' ? waited.totalMs : 0, unallocated: kind === null ? waited.totalMs : 0 };
}
const resourceId = (r: ResourceUnit): string | null => { const p = parseResourceUnit(r); return p.type === 'cpu' ? null : p.type === 'instance' ? p.pool : p.name; };
type Booking = { id: string; resource: string; label: string; unitId?: string; from: number; to?: number; state: 'done' | 'holding' | 'waiting'; waitFrom?: number; waitedMs?: number };
function bookings(events: readonly Event[], origin: number) {
  const intents = new Map<string, IntentOf<'resource.transition'>>();
  const active = new Map<string, Booking>();
  const rows: Booking[] = [];
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'resource.transition') intents.set(e.op, e);
    if (e.type !== 'done' || e.kind !== 'resource.transition') continue;
    const i = intents.get(e.op); if (!i) continue;
    const x = i.expect;
    for (const r of x.resources) {
      const resource = resourceId(r); if (!resource) continue;
      if (x.edge.type === 'reserve' || x.edge.type === 'reclaim') {
        const row: Booking = { id: `${e.op}:${r}`, resource, label: 'unit' in x.holder ? x.holder.unit : x.holder.type,
          ...('unit' in x.holder ? { unitId: x.holder.unit } : {}), from: (Date.parse(e.at) - origin) / 1000, state: 'holding' };
        active.set(r, row); rows.push(row);
      } else if (x.edge.type === 'release') {
        const row = active.get(r);
        if (row) { row.to = (Date.parse(e.at) - origin) / 1000; row.state = 'done'; active.delete(r); }
      }
    }
  }
  return rows;
}
export function consoleModel(e: Envelope) {
  const { display, plan, events, requests } = e.data;
  const s = display.status;
  const units = s.units.map((u) => ({ id: String(u.unit), label: String(u.unit), status: graphStatus(u.state), meta: u.state === 'cut' || u.state === 'superseded' ? `withdrawn · ${u.state}` : u.state }));
  const gates = s.milestones.map((m) => ({ id: `milestone:${m.id}`, label: String(m.id), status: m.passed ? 'passed' as const : m.state === 'walking' ? 'active' as const : m.state === 'blocked' ? 'held' as const : 'pending' as const, meta: `milestone gate · ${m.state}` }));
  const edges: [string, string][] = s.edges.flatMap((edge) => edge.type === 'after' ? [[edge.effective, edge.unit] as [string, string]] : edge.type === 'milestone' ? [[`milestone:${edge.milestone}`, edge.unit] as [string, string]] : []);
  for (const m of plan?.milestones ?? []) for (const unit of m.units) edges.push([unit, `milestone:${m.id}`]);
  const activities = display.invocations.map((i) => {
    const state = activityState(i);
    const kind = i.execution ?? (i.work ? i.work.kind === 'build' ? 'agent' : 'command' : null);
    const elapsedMs = i.endedAt ? i.work?.measured?.wallMs ?? Math.max(0, Date.parse(i.endedAt) - Date.parse(i.startedAt)) : undefined;
    const status: GraphStatus = !i.endedAt && state === 'running' ? 'active' : /^(success|pass|probe passed)$/.test(state) ? 'passed' : /fail|fault|lost|malformed|refusal|stall|timeout/.test(state) ? 'failed' : /held|abort|unowned|blocked/.test(state) ? 'held' : 'pending';
    return { id: i.id, routeId: invocationDirName(invocationIdOf(i.id)), unit: i.unit, stage: i.role, attempt: i.attempt,
      name: `${i.role} · attempt ${i.attempt} · ${state}`, kind: kind === 'agent' ? 'agentic' as const : 'deterministic' as const,
      execution: kind ?? 'unavailable', status, startedAt: i.startedAt, ...(elapsedMs === undefined ? {} : { elapsedMs }),
      detail: project(JSON.parse(i.body)).map((r) => r.text).join('\n'), ...(i.model ? { model: i.model } : {}) };
  });
  const timeRows = new Map<string, { id: string; label: string; agent: number; deterministic: number; held: number; queued: number }>();
  const timeRow = (id: string) => { let r = timeRows.get(id); if (!r) { r = { id, label: id, agent: 0, deterministic: 0, held: 0, queued: 0 }; timeRows.set(id, r); } return r; };
  for (const u of s.units) timeRow(u.unit);
  for (const a of activities) {
    if (a.elapsedMs === undefined || a.execution === 'unavailable') continue;
    timeRow(a.unit)[a.kind === 'agentic' ? 'agent' : 'deterministic'] += a.elapsedMs;
  }
  const waiting = completedWaiting(events);
  let unallocated = 0; const byReasonMs: Record<string, number> = {};
  for (const m of waiting.measurements) {
    const split = waitingBreakdown(m.waited, m.source);
    const id = m.source === 'admission' ? m.unit : m.parent.type === 'stage' ? m.parent.unit : m.parent.type === 'job' ? m.parent.job : 'arc';
    const row = timeRow(id); row.held += split.held; row.queued += split.queued; unallocated += split.unallocated;
    for (const [reason, ms] of Object.entries(m.waited.byReasonMs)) byReasonMs[reason] = (byReasonMs[reason] ?? 0) + ms!;
  }
  const work = [...s.host.work, ...s.units.flatMap((u) => u.work)];
  const cpu = work.filter((w) => w.reservedCpu !== null || w.measured !== null).map((w) => ({ id: w.inv, unit: w.parent.type === 'stage' ? w.parent.unit : 'arc', reserved: w.reservedCpu,
    average: w.measured && w.measured.wallMs > 0 ? w.measured.runMs / w.measured.wallMs : null,
    demand: w.cpuBasis?.value ?? null, basis: w.cpuBasis?.kind ?? 'unrecorded' }));
  const origin = Date.parse(events[0]?.at ?? e.observedAt);
  const resourceRows = bookings(events, origin);
  const resources = new Map<string, { id: string; label: string; capacity: number }>();
  for (const [id, pool] of Object.entries(s.host.pools)) if (id !== '@cpu') resources.set(id, { id, label: id, capacity: pool.size });
  for (const b of resourceRows) if (!resources.has(b.resource)) resources.set(b.resource, { id: b.resource, label: b.resource, capacity: 1 });
  const queue = [...s.host.queue.map((q) => ({ ...q, label: q.unit, unit: q.unit })), ...s.host.jobQueue.map((q) => ({ ...q, label: q.holder.type === 'job' ? q.holder.job : q.holder.type === 'docs' ? q.holder.pub : `batch:${q.holder.finding}:${q.holder.attempt}`, unit: undefined }))];
  for (const q of queue) {
    if (q.queuedAt === undefined) continue; // Missing historical starts remain unknown.
    const requested = [...q.request.named, ...q.request.pools, ...(q.request.publication ? ['integration-slot'] : [])];
    for (const resource of requested) {
      if (!resources.has(resource)) resources.set(resource, { id: resource, label: resource, capacity: 1 });
      resourceRows.push({ id: `queue:${q.label}:${resource}`, resource, label: q.label, ...(q.unit ? { unitId: q.unit } : {}), from: (q.queuedAt - origin) / 1000,
        waitFrom: (q.queuedAt - origin) / 1000, to: (Date.parse(e.checkedAt) - origin) / 1000, state: 'waiting' });
    }
  }
  return {
    graph: { units: [...units, ...gates], edges }, activities,
    holds: s.holds,
    time: { rows: [...timeRows.values()], total: [...timeRows.values()].reduce((t, r) => ({ agent: t.agent + r.agent, deterministic: t.deterministic + r.deterministic, held: t.held + r.held, queued: t.queued + r.queued }), { agent: 0, deterministic: 0, held: 0, queued: 0 }), unallocated, byReasonMs, unmeasuredReservations: waiting.unmeasuredReservations, caption: 'partial recorded effort · completed work and recorded waiting; not wall-time coverage' },
    cpu, tokenOccupancy: s.host.pools['@cpu']?.used ?? 0,
    resources: { resources: [...resources.values()], bookings: resourceRows, origin, now: Math.max(0, (Date.parse(e.checkedAt) - origin) / 1000), unknownQueueStarts: queue.filter((q) => q.queuedAt === undefined).length },
    attention: requests.map((r) => ({ id: r.id, blocking: r.blocking, summary: r.summary, recommendation: r.recommendation, options: r.options, subject: r.subject, evidence: r.evidence, evidenceLinks: r.evidence.map((path) => { const key = /\/inv\/([1-9][0-9]*-[1-9][0-9]*)(?:\/|$)/.exec(path)?.[1]; return activities.some((a) => a.routeId === key) ? key! : null; }), reason: r.reason })),
  };
}
