// A compact owner view, derived from the same authoritative records as full status. Expectations never hold work.
import type { Event } from '../core/events.ts';
import type { ArcId, UnitId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { meterOf } from '../meter.ts';
import { laneRuns, wasteFindings } from '../flow/waste.ts';
import { type PlanM1, milestoneMembers } from '../input/plan.ts';
import { type StatusCore, statusCore } from '../status.ts';

export function caughtOf(events: readonly Event[], runs = laneRuns(events)) {
  const laneReds = runs.filter((r) => ['fail', 'stall', 'timeout'].includes(r.verdict)).length;
  let gateRevisions = 0; const findings = new Set<string>(); const byLens: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'stage-outcome' && 'unit' in f && f.stage === 'gate' && f.outcome === 'revise') gateRevisions++;
    if (f.kind === 'finding-opened' && !findings.has(f.key)) { findings.add(f.key); byLens[f.lens] = (byLens[f.lens] ?? 0) + 1; }
  }
  return { total: laneReds + gateRevisions + findings.size, laneReds, gateRevisions, uniqueFindings: findings.size, byLens };
}

export function summarize(s: StatusCore, events: readonly Event[], plan: PlanM1 | null, meter = meterOf(events), runs = laneRuns(events)) {
  const totalUsd = s.spend.byRole.reduce((n, r) => n + r.costUsd, 0) + s.spend.bySmoke.reduce((n, r) => n + r.costUsd, 0);
  const expected = plan?.expectations;
  const jobsByMilestone = new Map<string, string[]>();
  const jobsByUnit = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    const add = (map: Map<string, string[]>, key: string, job: string) => { const jobs = map.get(key) ?? []; jobs.push(job); map.set(key, jobs); };
    if (f.kind === 'walk-started') add(jobsByMilestone, f.milestone, f.job);
    if (f.kind === 'compare-started') add(jobsByUnit, f.unit, f.job);
  }
  // A milestone's spend: its members (status, `milestoneMembers`: its units, their re-entries and carriers) and its polish
  // units with their own re-entries.
  const ms = s.milestones.map((m) => {
    const polish = (plan?.units ?? []).filter((u) => u.polish?.milestone === m.id).map((u) => u.id);
    const units = new Set<UnitId>([...m.members, ...(plan === null ? [] : milestoneMembers(plan, { units: polish }))]);
    const jobs = new Set([...(jobsByMilestone.get(m.id) ?? []), ...[...units].flatMap((u) => jobsByUnit.get(u) ?? [])]);
    const costUsd = meter.byUnit.filter((u) => units.has(u.unit)).reduce((n, u) => n + u.costUsd, 0)
      + meter.byJob.filter((j) => jobs.has(j.job)).reduce((n, j) => n + j.costUsd, 0);
    return { id: m.id, state: m.state, round: m.round, live: m.live, merged: m.merged, findings: m.findings.length, costUsd, expectedUsd: expected?.perMilestoneUsd ?? null };
  });
  const states: Record<string, number> = {};
  for (const u of s.units) states[u.state] = (states[u.state] ?? 0) + 1;
  return {
    arc: s.arc, state: s.run.state, stop: s.run.stop, supervision: s.supervision, planRev: s.plan?.rev ?? null,
    progress: { total: s.units.length, merged: s.units.filter((u) => u.state === 'merged').length, states,
      held: s.nowTrue.length, remaining: s.notYetTrue.length },
    spend: { costUsd: totalUsd, expectedUsd: expected?.arcUsd ?? null,
      differenceUsd: expected?.arcUsd === undefined ? null : totalUsd - expected.arcUsd,
      estimatedCalls: events.filter((e) => e.type === 'fact' && e.fact.kind === 'meter' && e.fact.usage.costEstimated === true).length,
      unavailableCalls: s.spend.byRole.reduce((n, r) => n + r.unavailable, 0) + s.spend.bySmoke.reduce((n, r) => n + r.unavailable, 0) },
    milestones: ms, caught: caughtOf(events, runs),
    verdicts: events.flatMap((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && !('unit' in e.fact) ? [e.fact] : []),
    captures: events.flatMap((e) => {
      if (e.type !== 'intent' || e.kind !== 'proc.spawn' || e.expect.subject.purpose !== 'lane') return [];
      const subject = e.expect.subject;
      return plan?.suite.lanes.some((l) => l.id === subject.lane && 'kind' in l && l.kind === 'capture') ? [{ lane: subject.lane, op: e.op }] : [];
    }),
    needsUser: s.needsUser, waste: plan === null ? [] : wasteFindings(events, runs),
    demo: s.demo, completion: s.completion,
    waiting: s.waiting,
  };
}

export function statusSummary(runDir: AbsPath, arc: ArcId, hostDir: AbsPath) {
  const { core, events, plan, meter } = statusCore(runDir, arc, hostDir);
  return summarize(core, events, plan, meter);
}
