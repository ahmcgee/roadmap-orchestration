// A compact owner view, derived from the same authoritative records as full status. Expectations never hold work.
import type { Event } from '../core/events.ts';
import type { ArcId, UnitId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { type PlanM1, milestoneMembers } from '../input/plan.ts';
import { type StatusCore, statusCore } from '../status.ts';
import { StatusPasses } from './passes.ts';

/** What the arc caught: lane reds, gate revisions and distinct findings. */
function caughtOf(passes: StatusPasses) {
  const laneReds = passes.laneRuns.filter((r) => ['fail', 'stall', 'timeout'].includes(r.verdict)).length;
  const { gateRevisions, uniqueFindings, byLens } = passes.summary.caught;
  return { total: laneReds + gateRevisions + uniqueFindings, laneReds, gateRevisions, uniqueFindings, byLens };
}

/** The summary of `s`; `passes`: the passes over `events` (without: folded from nothing). */
export function summarize(s: StatusCore, events: readonly Event[], plan: PlanM1 | null, passes = StatusPasses.of(events)) {
  if (passes.folded !== events.length) throw new Error(`summarize: the passes folded ${passes.folded} of ${events.length} events`);
  const meter = passes.meter;
  const totalUsd = s.spend.byRole.reduce((n, r) => n + r.costUsd, 0) + s.spend.bySmoke.reduce((n, r) => n + r.costUsd, 0);
  const expected = plan?.expectations;
  // A milestone's spend: its members (status, `milestoneMembers`: its units, their re-entries and carriers) and its polish
  // units with their own re-entries.
  const ms = s.milestones.map((m) => {
    const polish = (plan?.units ?? []).filter((u) => u.polish?.milestone === m.id).map((u) => u.id);
    const units = new Set<UnitId>([...m.members, ...(plan === null ? [] : milestoneMembers(plan, { units: polish }))]);
    const jobs = new Set([...passes.summary.jobs('milestone', m.id), ...[...units].flatMap((u) => passes.summary.jobs('unit', u))]);
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
      estimatedCalls: passes.summary.estimatedCalls,
      unavailableCalls: s.spend.byRole.reduce((n, r) => n + r.unavailable, 0) + s.spend.bySmoke.reduce((n, r) => n + r.unavailable, 0) },
    milestones: ms, caught: caughtOf(passes),
    verdicts: passes.summary.verdicts,
    captures: passes.summary.laneSpawns.filter((spawn) => plan?.suite.lanes.some((l) => l.id === spawn.lane && 'kind' in l && l.kind === 'capture') === true),
    needsUser: s.needsUser, waste: plan === null ? [] : passes.waste,
    demo: s.demo, completion: s.completion,
    waiting: s.waiting,
  };
}

export function statusSummary(runDir: AbsPath, arc: ArcId, hostDir: AbsPath) {
  const { core, events, plan, passes } = statusCore(runDir, arc, hostDir);
  return summarize(core, events, plan, passes);
}
