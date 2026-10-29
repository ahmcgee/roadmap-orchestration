import type { UnitStatusLine } from '../status.ts';
import { pretty, type Display, type Entry } from './types.ts';
import type { WorkRun } from '../status-work.ts';

/** Executor ownership is separate from work in flight, including arc-wide jobs. */
export function executionSummary(display: Display) {
  const { status, invocations } = display;
  const active = invocations.filter((inv) => inv.endedAt === null && inv.state === 'running');
  const agents = active.filter((inv) => inv.execution === 'agent').length;
  const commands = active.filter((inv) => inv.execution === 'command').length;
  const unknown = active.length - agents - commands;
  const counts = `${agents} agent${agents === 1 ? '' : 's'} · ${commands} command${commands === 1 ? '' : 's'}${unknown ? ` · ${unknown} other runs` : ''}`;
  if (active.length) return { state: 'running', counts, detail: `Active: ${active.map((inv) => `${inv.unit} / ${inv.role}`).join(', ')}` };
  if (status.run.state === 'complete') return { state: 'complete', counts, detail: 'Run complete · no active work · retained history' };
  if (status.run.owner.state !== 'alive') return { state: status.run.state === 'no-owner' ? 'stopped' : status.run.state, counts, detail: 'Executor stopped · no work will advance' };
  const requests = status.needsUser.filter((n) => n.blocking);
  if (requests.length) return { state: 'waiting', counts, detail: `No active work · waiting for owner: ${[...new Set(requests.map((n) => n.reason))].join(', ')} · 4 Exceptions` };
  if (status.parkedBackends.length || status.holds.length) return { state: 'waiting', counts, detail: `No active work · ${[...status.holds, ...status.parkedBackends.map((b) => `${b} parked`)].join(', ')} · 4 Exceptions` };
  const tasks = status.units.filter((u) => ['running', 'preparing'].includes(u.state));
  if (tasks.length) return { state: 'preparing', counts, detail: `Executor work: ${tasks.map((u) => `${u.unit} / ${u.stage}`).join(', ')}` };
  return { state: status.run.state, counts, detail: 'No active agents or commands · executor is between tasks or waiting on dependencies' };
}

/** Explain only outstanding constraints; a satisfied dependency is not a waiting reason. */
export function unitWaitReason(unit: UnitStatusLine, visible?: ReadonlySet<string>): string | undefined {
  if (unit.park?.ordering) return `Ordering park: waiting for ${unit.park.ordering.outstanding.join(', ') || 'blocker merge to settle'}; wakes after all blockers merge`;
  const wait = unit.waitingFor;
  if (!wait) return undefined;
  const label = (id: string) => visible && !visible.has(id) ? `${id} [offscreen]` : id;
  const reasons = [
    ...wait.milestones.map((id) => `${label(id)} milestone gate`),
    ...wait.deps.map((id) => `${label(id)} to merge`),
    ...wait.edges.map((id) => `${label(id)} condition`),
    ...wait.admission.map((c) => c.type === 'blocking-item' ? `owner request ${c.id}: ${c.reason}`
      : c.type === 'backend-parked' ? `${c.backend} backend parked` : c.type.replaceAll('-', ' ')),
    ...(wait.resources ? [wait.pressureBlocked ? 'pressure brake: host CPU saturated while other work holds tokens' : wait.envBlocked ? 'resources (environment blocked)' : 'resource capacity', `token wait ${wait.tokenWaitMs == null ? 'unavailable' : (wait.tokenWaitMs / 1000).toFixed(1) + 's'}`] : []),
    ...wait.drainFor.map((id) => `command ${id} to drain`),
  ];
  return reasons.length ? `Waiting for: ${reasons.join('; ')}` : undefined;
}

export function certificationSummary(unit: UnitStatusLine): string {
  const c = unit.certification;
  return c === null ? '' : `Certification: red ${c.used} of ${c.allowance} uncharged · ${c.left} left before next charge`;
}

export function cpuSummary(work: WorkRun): string {
  const basis = work.cpuBasis;
  const reserved = work.reservedCpu === null ? 'unavailable' : `${work.reservedCpu} (${basis?.kind ?? 'legacy basis unavailable'}${basis && basis.kind !== 'explicit' ? `, ${basis.samples} samples` : ''})`;
  const m = work.measured;
  const measured = m === null ? 'pending/unavailable' : m.wallMs === 0 ? 'no wall time' : `${(m.runMs / m.wallMs).toFixed(2)} cores used, ${((m.runMs + m.waitMs) / m.wallMs).toFixed(2)} demanded`;
  return `CPU ${reserved} reserved / ${measured} · token wait ${work.tokenWaitMs === null ? 'unavailable' : (work.tokenWaitMs / 1000).toFixed(1) + 's'}`;
}

/** Ordered lane rows are status projections, including lanes which have not spawned an invocation yet. */
export function certificationEntries(display: Display, unit?: string): Entry[] {
  return display.status.units.filter((u) => (!unit || u.unit === unit) && (u.stage === 'lanes' || u.waitingFor?.resources) && u.certification?.attempt !== null)
    .flatMap((u) => (u.certification?.lanes ?? []).map((lane, index) => {
      const work = u.work.find((w) => w.inv === lane.inv);
      const held = lane.holds.length ? ` · holds ${lane.holds.join(', ')}` : '';
      const state = lane.verdict === 'timeout' ? 'red:timeout' : work?.cause === 'deadline' ? 'blocked:deadline' : lane.flaky ? 'red:flaky' : lane.state;
      return { id: `certification:${u.unit}:${lane.set}:${lane.id}`, kind: 'lane-status' as const,
        label: `${u.unit} · ${index + 1}. ${lane.set}/${lane.id}${lane.redFirst ? ' · red-first' : ''}`, state,
        description: `${certificationSummary(u)}${held}${work ? ' · ' + cpuSummary(work) : ''}`,
        body: pretty({ certification: certificationSummary(u), ...lane, ...(work ? { work } : {}), ...(u.waitingFor ? { waitingFor: unitWaitReason(u) } : {}) }),
        links: [], provenance: `certification attempt ${u.certification!.attempt}` };
    }));
}
