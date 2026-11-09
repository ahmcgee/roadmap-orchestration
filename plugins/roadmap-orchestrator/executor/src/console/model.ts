// Adapters contain only recorded quantities. Signal states supplement, never replace, executor labels.
import { type Event } from '../core/events.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { completedWaiting } from '../status/waiting.ts';
import { activityState } from '../tui/outcome.ts';
import type { Envelope } from '../observation/protocol.ts';
import { presentation } from './presentation.ts';
import { project } from '../tui/projection.ts';
import { bookingSummaries } from './bookings.ts';
import { cpuStageGroups, resourceQueue } from './resources.ts';

export { graphStatus, type GraphStatus } from './signals.ts';
import { graphStatus, type GraphStatus } from './signals.ts';
export { waitingCategory, waitingBreakdown } from './waiting.ts';
import { waitingBreakdown } from './waiting.ts';
type Booking = { id: string; resource: string; instance?: string; startedAt?: string; durationMs?: number; label: string; unitId?: string; from: number; to?: number; state: 'done' | 'holding' | 'waiting'; waitFrom?: number; waitedMs?: number };
// Temporary wire adapter preserves the existing UI's offsets and holder labels.
function bookings(events: readonly Event[], origin: number): Booking[] {
  return bookingSummaries(events).map(b => ({id: b.id, resource: b.resource, ...(b.instance === null ? {} : {instance: b.instance}),
    startedAt: b.startedAt, label: b.holder.unitId ?? b.holder.type, ...(b.holder.unitId ? {unitId: b.holder.unitId} : {}),
    from: (Date.parse(b.startedAt) - origin) / 1000, state: b.state,
    ...(b.endedAt === null ? {} : {to: (Date.parse(b.endedAt) - origin) / 1000, durationMs: Date.parse(b.endedAt) - Date.parse(b.startedAt)})}));
}
export function consoleModel(e: Envelope) {
  const { display, plan, events, requests } = e.data;
  const s = display.status;
  const units = s.units.map((u) => ({ id: String(u.unit), label: String(u.unit), status: graphStatus(u.state), meta: u.state === 'cut' || u.state === 'superseded' ? `withdrawn · ${u.state}` : u.state }));
  const gates = s.milestones.map((m) => ({ id: `milestone:${m.id}`, label: String(m.id), status: m.passed ? 'passed' as const : m.state === 'walking' ? 'active' as const : m.state === 'blocked' ? 'held' as const : 'pending' as const, meta: `milestone gate · ${m.state}` }));
  const edges: [string, string][] = s.edges.flatMap((edge) => edge.type === 'after' ? [[edge.effective, edge.unit] as [string, string]] : edge.type === 'milestone' ? [[`milestone:${edge.milestone}`, edge.unit] as [string, string]] : []);
  for (const m of plan?.milestones ?? []) for (const unit of m.units) edges.push([unit, `milestone:${m.id}`]);
  const activities = display.invocations.map((i) => {
    let state = activityState(i);
    const body = JSON.parse(i.body);
    // A pruned result still has its validated terminal verdict in the journal. Completion is never a queue.
    const terminal = body.settlement?.outcome;
    if (state === 'result' && terminal?.kind === 'result') state = terminal.summary.type === 'command' ? terminal.summary.verdict : terminal.summary.outcome;
    const kind = i.execution ?? (i.work ? i.work.kind === 'build' ? 'agent' : 'command' : null);
    const elapsedMs = i.endedAt ? i.work?.measured?.wallMs ?? Math.max(0, Date.parse(i.endedAt) - Date.parse(i.startedAt)) : undefined;
    const status: GraphStatus = !i.endedAt && state === 'running' ? 'active' : /^(success|pass|probe passed)$/.test(state) ? 'passed' : /fail|fault|lost|malformed|refusal|stall|timeout/.test(state) ? 'failed' : /held|abort|unowned|blocked/.test(state) ? 'held' : 'pending';
    return { id: i.id, routeId: invocationDirName(invocationIdOf(i.id)), unit: i.unit, stage: i.role, attempt: i.attempt,
      name: `${i.role} · attempt ${i.attempt} · ${state}`, kind: kind === 'agent' ? 'agentic' as const : 'deterministic' as const,
      execution: kind ?? 'unavailable', status, startedAt: i.startedAt, ...(elapsedMs === undefined ? {} : { elapsedMs }),
      detail: project(body).map((r) => r.text).join('\n'), ...(i.model ? { model: i.model } : {}) };
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
    measured: w.measured, average: w.measured && w.measured.wallMs > 0 ? w.measured.runMs / w.measured.wallMs : null,
    demand: w.cpuBasis?.value ?? null, basis: w.cpuBasis?.kind ?? 'unrecorded' }));
  const origin = Date.parse(events[0]?.at ?? e.observedAt);
  const endAt = [...events].reverse().find(event => event.type === 'fact' && ['arc-completed','stop-completed'].includes(event.fact.kind))?.at ?? null;
  const resourceRows = bookings(events, origin);
  const resources = new Map<string, { id: string; label: string; capacity: number }>();
  for (const [id, pool] of Object.entries(s.host.pools)) if (id !== '@cpu') resources.set(id, { id, label: id, capacity: pool.size });
  for (const b of resourceRows) if (!resources.has(b.resource)) resources.set(b.resource, { id: b.resource, label: b.resource, capacity: 1 });
  const queue = resourceQueue(s.host);
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
    presentation: presentation(e),
    graph: { units: [...units, ...gates], edges }, activities,
    holds: s.holds,
    time: { rows: [...timeRows.values()], total: [...timeRows.values()].reduce((t, r) => ({ agent: t.agent + r.agent, deterministic: t.deterministic + r.deterministic, held: t.held + r.held, queued: t.queued + r.queued }), { agent: 0, deterministic: 0, held: 0, queued: 0 }), unallocated, byReasonMs, unmeasuredReservations: waiting.unmeasuredReservations, caption: 'partial recorded effort · completed work and recorded waiting; not wall-time coverage' },
    cpu, cpuGroups: cpuStageGroups(work), tokenOccupancy: s.host.pools['@cpu']?.used ?? 0,
    resources: { resources: [...resources.values()], bookings: resourceRows, queue, origin, endAt, now: Math.max(0, (Date.parse(endAt ?? e.checkedAt) - origin) / 1000), unknownQueueStarts: queue.filter((q) => q.queuedAt === undefined).length },
    attention: requests.map((r) => ({ id: r.id, blocking: r.blocking, summary: r.summary, recommendation: r.recommendation, options: r.options, subject: r.subject, evidence: r.evidence, evidenceLinks: r.evidence.map((path) => { const key = /\/inv\/([1-9][0-9]*-[1-9][0-9]*)(?:\/|$)/.exec(path)?.[1]; return activities.some((a) => a.routeId === key) ? key! : null; }), reason: r.reason })),
  };
}

/** Stable adapters are keyed by the actual captured dependencies, independent of heartbeat/verification clocks. */
export class ConsoleModels {
  #models = new Map<string, ReturnType<typeof consoleModel>>();
  read(e: Envelope): ReturnType<typeof consoleModel> {
    const key = `${e.arc}:${e.epoch}:${e.data.capture.source}`;
    let model = this.#models.get(key);
    if (!model) model = consoleModel(e);
    this.#models.delete(key); this.#models.set(key, model);
    while (this.#models.size > 8) this.#models.delete(this.#models.keys().next().value!);
    const now = Math.max(0, (Date.parse(model.resources.endAt ?? e.checkedAt) - model.resources.origin) / 1000);
    return { ...model, resources: { ...model.resources, now, bookings: model.resources.bookings.map((b) => b.state === 'waiting' ? { ...b, to: now } : b) } };
  }
}
