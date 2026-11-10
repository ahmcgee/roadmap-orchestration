// Server-only indexes over one verified capture. D1 identity; D3 parent/stage-local attempt/round.
// No report, transcript, filesystem read or second execution-state fold belongs here.
import type { Event, Parent } from '../core/events.ts';
import { parseInvocationId, invocationIdOf } from '../core/ids.ts';
import type { Envelope } from '../observation/protocol.ts';
import type { Invocation } from '../tui/types.ts';
import { record } from '../tui/projection.ts';
import { outcomeWords, shortUnitTitle, stageWords } from './vocabulary.ts';

export const housekeepingStages = new Set(['quiesce', 'evidence', 'salvage', 'teardown']);
/** A unit's total time: unknown (null) without a recorded start, or when its recorded end equals its start. */
export const journeyMs = (startedAt: string | null, endedAt: string | null, end: string): number | null =>
  startedAt === null || endedAt === startedAt ? null : Math.max(0, Date.parse(endedAt ?? end) - Date.parse(startedAt));
/** The unit's current stage has finished: it waits after that stage, not in it. */
export const stageFinished = (steps: readonly StageStep[] | undefined, stage: string): boolean => {const last = steps?.at(-1); return last?.stage === stage && last.endedAt !== null;};
export type StageStep = {housekeeping: boolean; id: string; stage: string; label: string; attempt: number; sequence: number; round: number; at: string; endedAt: string | null; outcome: string; findingTitles: string[]; activities: string[]; notes: string[]};
export type UnitIdentity = { id: string; title: string; systems: string[]; order: number };
export function identityIndex(e: Envelope): Map<string, UnitIdentity> {
  const specifications = new Map(e.data.display.estate.filter(r => r.kind === 'specification').map(r => [r.id, r]));
  const plan = new Map(e.data.plan?.units.map((u, order) => [String(u.id), {systems: u.systems, order}]));
  const units = new Set(e.data.display.status.units.map(u => String(u.unit)));
  return new Map(e.data.display.status.units.map((u, order) => {
    const entry = specifications.get(u.unit), spec = entry ? record(JSON.parse(entry.body)) : {};
    const acceptance = Array.isArray(spec['acceptance']) ? spec['acceptance'].map(a => String(record(a)['clause'] ?? '')).filter(Boolean) : [];
    const intent = typeof spec['intent'] === 'string' ? spec['intent'] : acceptance.join('\n');
    const title = typeof spec['title'] === 'string' && spec['title'].trim() ? spec['title'] : shortUnitTitle(intent, String(u.unit), units);
    return [u.unit, {id: u.unit, title, systems: [...(plan.get(u.unit)?.systems ?? [])], order: plan.get(u.unit)?.order ?? order}];
  }));
}
export function stageIndex(events: readonly Event[]) {
  const steps = new Map<string, StageStep>(), counts = new Map<string, number>(), rounds = new Map<string, number>();
  const parents = new Map<string, Parent>();
  const intentsByStep = new Map<string, string[]>(), done = new Map<string, {seq: number; at: string}>();
  const step = (unit: string, stage: string, sequence: number, at: string) => {
    const id = `${unit}:${sequence}`, found = steps.get(id); if (found) return found;
    const key = `${unit}:${stage}`, attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
    let round = rounds.get(unit) ?? 1; if (stage === 'build' && attempt > 1) round++; rounds.set(unit, round);
    const row: StageStep = {housekeeping: false, id, stage, label: stageWords(stage), attempt, sequence, round, at, endedAt: null, outcome: 'In progress', findingTitles: [], activities: [], notes: []};
    steps.set(id, row); return row;
  };
  for (const ev of events) {
    if (ev.type === 'intent') {
      parents.set(ev.op, ev.parent);
      if (ev.parent.type === 'stage') {
        const row = step(ev.parent.unit, ev.parent.stage, ev.parent.attempt, ev.at);
        const ops = intentsByStep.get(row.id) ?? []; ops.push(ev.op); intentsByStep.set(row.id, ops);
      }
    }
    if (ev.type === 'done') done.set(ev.op, ev);
    if (ev.type === 'fact' && ev.fact.kind === 'stage-outcome' && 'unit' in ev.fact) {
      const f = ev.fact, row = step(f.unit, f.stage, f.attempt, ev.at);
      row.endedAt = ev.at; row.outcome = outcomeWords(f.outcome);
      row.housekeeping = housekeepingStages.has(f.stage) && f.class === 'advance';
      if (f.class === 'park') row.notes.push(`Parked: ${row.outcome}`);
      if (f.class === 'hold') row.notes.push(`On hold: ${row.outcome}`);
    }
  }
  // Retirement has no stage-outcome fact: all of its operations must have settled.
  for (const row of steps.values()) if (row.stage === 'retire') {
    const ops = intentsByStep.get(row.id) ?? [], settlements = ops.map(op => done.get(op));
    if (ops.length && settlements.every(s => s !== undefined)) {
      row.outcome = 'Done'; row.endedAt = settlements.reduce((a, b) => a!.seq > b!.seq ? a : b)!.at;
    }
  }
  const byUnit = new Map<string, StageStep[]>();
  for (const row of steps.values()) {
    const unit = row.id.slice(0, row.id.lastIndexOf(':')), rows = byUnit.get(unit) ?? [];
    rows.push(row); byUnit.set(unit, rows);
  }
  return {steps, byUnit, parents};
}
export function invocationIndex(invocations: readonly Invocation[], stages: ReturnType<typeof stageIndex>) {
  const byUnit = new Map<string, Invocation[]>();
  const rows = invocations.map(recorded => {
    // Retained calls may record execution kind only on WorkRun. This UI
    // classification never rewrites the canonical Invocation.
    const invocation: Invocation = recorded.execution === undefined && recorded.work
      ? {...recorded, execution: recorded.work.kind === 'build' ? 'agent' : 'command'} : recorded;
    const {op} = parseInvocationId(invocationIdOf(invocation.id)), parent = stages.parents.get(op);
    const step = parent?.type === 'stage' ? stages.steps.get(`${parent.unit}:${parent.attempt}`) : undefined;
    const unitRows = byUnit.get(invocation.unit) ?? []; unitRows.push(invocation); byUnit.set(invocation.unit, unitRows);
    return {invocation, parent, step};
  });
  return {rows, byUnit};
}
