import type { UnitStatusLine } from '../status.ts';
import type { Display } from './types.ts';

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
  const wait = unit.waitingFor;
  if (!wait) return undefined;
  const label = (id: string) => visible && !visible.has(id) ? `${id} [offscreen]` : id;
  const reasons = [
    ...wait.milestones.map((id) => `${label(id)} milestone gate`),
    ...wait.deps.map((id) => `${label(id)} to merge`),
    ...wait.edges.map((id) => `${label(id)} condition`),
    ...wait.admission.map((c) => c.type === 'blocking-item' ? `owner request ${c.id}: ${c.reason}`
      : c.type === 'backend-parked' ? `${c.backend} backend parked` : c.type.replaceAll('-', ' ')),
    ...(wait.resources ? [wait.envBlocked ? 'resources (environment blocked)' : 'resource capacity'] : []),
    ...wait.drainFor.map((id) => `command ${id} to drain`),
  ];
  return reasons.length ? `Waiting for: ${reasons.join('; ')}` : undefined;
}
