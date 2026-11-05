// A compact owner view, derived from the same authoritative records as full status. Expectations never hold work.
import type { Event } from '../core/events.ts';
import type { ArcId } from '../core/ids.ts';
import { readJournal } from '../core/log.ts';
import type { AbsPath } from '../core/values.ts';
import { meterOf } from '../meter.ts';
import { laneRuns, wasteFindings } from '../flow/waste.ts';
import { PLAN_INPUT, keptInput } from '../input/inforce.ts';
import { type PlanM1, parsePlan } from '../input/plan.ts';
import { type Status, status } from '../status.ts';

export function caughtOf(events: readonly Event[]) {
  const laneReds = laneRuns(events).filter((r) => ['fail', 'stall', 'timeout'].includes(r.verdict)).length;
  let gateRevisions = 0; const findings = new Set<string>(); const byLens: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'stage-outcome' && 'unit' in f && f.stage === 'gate' && f.outcome === 'revise') gateRevisions++;
    if (f.kind === 'finding-opened' && !findings.has(f.key)) { findings.add(f.key); byLens[f.lens] = (byLens[f.lens] ?? 0) + 1; }
  }
  return { total: laneReds + gateRevisions + findings.size, laneReds, gateRevisions, uniqueFindings: findings.size, byLens };
}

export function summarize(s: Status, events: readonly Event[], plan: PlanM1 | null) {
  const totalUsd = s.spend.byRole.reduce((n, r) => n + r.costUsd, 0) + s.spend.bySmoke.reduce((n, r) => n + r.costUsd, 0);
  const expected = plan?.expectations;
  const meter = meterOf(events);
  const ms = s.milestones.map((m) => {
    const units = new Set(plan?.milestones?.find((x) => x.id === m.id)?.units ?? []);
    for (let changed = true; changed;) {
      changed = false;
      for (const u of plan?.units ?? []) if (!units.has(u.id) && (u.polish?.milestone === m.id || (u.reenters !== undefined && units.has(u.reenters.unit)))) { units.add(u.id); changed = true; }
    }
    const jobs = new Set(events.flatMap((e) => {
      if (e.type !== 'fact') return [];
      const f = e.fact;
      return (f.kind === 'walk-started' && f.milestone === m.id) || (f.kind === 'compare-started' && units.has(f.unit)) ? [f.job] : [];
    }));
    const costUsd = meter.byUnit.filter((u) => units.has(u.unit)).reduce((n, u) => n + u.costUsd, 0)
      + meter.byJob.filter((j) => jobs.has(j.job)).reduce((n, j) => n + j.costUsd, 0);
    return { id: m.id, state: m.state, round: m.round, findings: m.findings.length, costUsd, expectedUsd: expected?.perMilestoneUsd ?? null };
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
    milestones: ms, caught: caughtOf(events),
    verdicts: events.flatMap((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && !('unit' in e.fact) ? [e.fact] : []),
    captures: events.flatMap((e) => {
      if (e.type !== 'intent' || e.kind !== 'proc.spawn' || e.expect.subject.purpose !== 'lane') return [];
      const subject = e.expect.subject;
      return plan?.suite.lanes.some((l) => l.id === subject.lane && 'kind' in l && l.kind === 'capture') ? [{ lane: subject.lane, op: e.op }] : [];
    }),
    needsUser: s.needsUser, waste: plan === null ? [] : wasteFindings(events),
    demo: s.demo, completion: s.completion,
  };
}

export function statusSummary(runDir: AbsPath, arc: ArcId, hostDir: AbsPath) {
  // One read and fold, shared with status() (it accepts the snapshot), so the summary costs no more than status itself.
  const log = readJournal(runDir, arc);
  const s = status(runDir, arc, hostDir, log);
  const { view, events } = log;
  const applied = view.planApplied();
  const bytes = applied === null ? null : keptInput(runDir, applied.planSha256, PLAN_INPUT);
  if (applied !== null && bytes === null) throw new Error(`Missing plan ${applied.planSha256}`);
  return summarize(s, events, bytes === null ? null : parsePlan(JSON.parse(bytes.toString('utf8'))));
}
