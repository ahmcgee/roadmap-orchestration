// D7: compare only measured execution with the reservation held for that same call.
import type { WorkRun } from '../status-work.ts';
import { canonicalJson } from '../core/json.ts';

export function cpuStageGroups(work: readonly WorkRun[]) {
  const groups = new Map<string, { id: string; parent: WorkRun['parent']; calls: WorkRun[] }>();
  for (const call of work) {
    const id = canonicalJson(call.parent);
    let group = groups.get(id);
    if (!group) { group = { id, parent: call.parent, calls: [] }; groups.set(id, group); }
    group.calls.push(call);
  }
  return [...groups.values()].map(group => {
    const measured = group.calls.filter(c => c.measured !== null && c.measured.wallMs > 0);
    const matched = measured.filter(c => c.reservedCpu !== null && c.reservedCpu > 0);
    const sum = (calls: WorkRun[], value: (c: WorkRun) => number) => calls.reduce((n, c) => n + value(c), 0);
    const wallMs = sum(matched, c => c.measured!.wallMs);
    const runMs = sum(matched, c => c.measured!.runMs);
    const reservedCoreMs = sum(matched, c => c.reservedCpu! * c.measured!.wallMs);
    const unreserved = measured.filter(c => c.reservedCpu === null || c.reservedCpu <= 0);
    const unreservedWallMs = sum(unreserved, c => c.measured!.wallMs);
    return {
      id: group.id, parent: group.parent, invocations: group.calls.map(c => c.inv),
      contributions: group.calls.map(c => ({inv: c.inv, reservedCpu: c.reservedCpu, basis: c.cpuBasis, measured: c.measured})),
      wallMs, runMs, reservedCoreMs,
      averageCores: wallMs > 0 ? runMs / wallMs : null,
      reservedCores: wallMs > 0 ? reservedCoreMs / wallMs : null,
      reservationPercent: reservedCoreMs > 0 ? 100 * runMs / reservedCoreMs : null,
      measuredCalls: matched.length, excludedCalls: group.calls.length - matched.length,
      unmeasuredCalls: group.calls.filter(c=>c.measured===null).length,
      zeroWallCalls: group.calls.filter(c=>c.measured!==null&&c.measured.wallMs===0).length, unreservedCalls: unreserved.length,
      unreservedAverageCores: unreservedWallMs > 0 ? sum(unreserved, c => c.measured!.runMs) / unreservedWallMs : null,
    };
  });
}

// D2/D6: scheduler job waiters are served before unit waiters; age never defines priority.
export function resourceQueue(host: Pick<import('../status.ts').HostView, 'queue' | 'jobQueue'>) {
  return [
    ...host.jobQueue.map(q => ({ ...q, label: q.holder.type === 'job' ? q.holder.job : q.holder.type === 'docs' ? q.holder.pub : `batch:${q.holder.finding}:${q.holder.attempt}`, unit: undefined })),
    ...host.queue.map(q => ({ ...q, label: q.unit, unit: q.unit })),
  ];
}
