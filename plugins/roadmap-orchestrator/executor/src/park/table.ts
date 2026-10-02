// The park table's targets (M2, A7, F10, G6): what a retryable park's probe checks, per parked `(stage,
// outcome)`. The park classes themselves live in the transition table (src/pipeline/transitions.ts,
// `parkClassOf`); this module only says which targets each retryable row probes, and builds the parking
// `stage-outcome` fact with them, applying the repeat rule (a unit parking again on a target it recovered on
// within PARK_REPEAT_MS parks operator, `env-blocked`).
//
// | row                                                   | targets                                   |
// |-------------------------------------------------------|-------------------------------------------|
// | plan-check, build, gate `process-fault`; build `lost` | `backend{b}`: the stage's backend          |
// | lanes `blocked` (after its retry), candidate `blocked` | `host`                                    |
// | build, teardown, lanes, candidate `cleanup-failed`    | one `resource{i}` per failed instance     |
// | salvage `commit-failed`                               | `host`, plus the failed teardown's instances (G6) |
import type { OutcomeStage, ProbeTarget, StageOutcomeFact, StageOutcomeKind } from '../core/events.ts';
import { probeTargetKey } from '../core/events.ts';
import type { ResourceInstance } from '../core/ids.ts';
import type { UnitState } from '../core/state.ts';
import { type NeedsUserContent, type OutcomeContext, type StageOutcome, outcomeFact, parkClassOf } from '../pipeline/transitions.ts';
import type { Backend } from '../routing/types.ts';
import { PARK_REPEAT_MS } from '../schedule/types.ts';

/** How a retryable row names its targets from what the stage knows. */
export type TargetRule = 'backend' | 'host' | 'resources' | 'host+resources';

/** Every retryable park row and its targets; a row absent here decides no retryable park. */
export const PARK_TARGETS: { readonly [S in OutcomeStage]?: { readonly [K in StageOutcomeKind<S>]?: TargetRule } } = {
  'plan-check': { 'process-fault': 'backend' },
  build: { 'process-fault': 'backend', lost: 'backend', 'cleanup-failed': 'resources' },
  gate: { 'process-fault': 'backend' },
  salvage: { 'commit-failed': 'host+resources' },
  teardown: { 'cleanup-failed': 'resources' },
  lanes: { blocked: 'host', 'cleanup-failed': 'resources' },
  candidate: { blocked: 'host', 'cleanup-failed': 'resources' },
  // M3: a vacuity repair's mutant lane parks as a lane does.
  reproduce: { blocked: 'host', 'cleanup-failed': 'resources' },
};

/** What only the stage knows: the backend its call ran on, and the instances its cleanup failed (G6: a salvage passes its teardown's). */
export type ParkFacts = Readonly<{ backend: Backend | null; failed: readonly ResourceInstance[] }>;

export const NO_PARK_FACTS: ParkFacts = { backend: null, failed: [] };

/** The rule of a parked `(stage, outcome)`, or null when the row decides no retryable park. */
export function targetRule(outcome: StageOutcome): TargetRule | null {
  const row = PARK_TARGETS[outcome.stage] as Readonly<Record<string, TargetRule>> | undefined;
  return row?.[outcome.kind] ?? null;
}

/** The targets of a retryable park of `outcome`, sorted and unique. Throws when the stage did not state what its row needs. */
export function parkTargets(outcome: StageOutcome, facts: ParkFacts): readonly ProbeTarget[] {
  const rule = targetRule(outcome);
  if (rule === null) throw new Error(`parkTargets: ${outcome.stage} ${outcome.kind} decides no retryable park`);
  const resources = (): readonly ProbeTarget[] => facts.failed.map((instance) => ({ type: 'resource', instance }));
  let targets: readonly ProbeTarget[];
  switch (rule) {
    case 'backend':
      if (facts.backend === null) throw new Error(`parkTargets: a ${outcome.stage} ${outcome.kind} park needs its backend`);
      targets = [{ type: 'backend', backend: facts.backend }];
      break;
    case 'host':
      targets = [{ type: 'host' }];
      break;
    case 'resources':
      if (facts.failed.length === 0) throw new Error(`parkTargets: a ${outcome.stage} ${outcome.kind} park needs its failed instances`);
      targets = resources();
      break;
    case 'host+resources':
      targets = [{ type: 'host' }, ...resources()];
      break;
  }
  return [...new Map(targets.map((t) => [probeTargetKey(t), t])).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, t]) => t);
}

/**
 * The repeat rule: `u` recovered on one of `targets` less than PARK_REPEAT_MS before `now`. Such a park is
 * operator (`env-blocked`): probing it again would loop on a flapping environment.
 */
export function isRepeat(u: UnitState, targets: readonly ProbeTarget[], now: Date): boolean {
  const last = u.lastRecovery;
  if (last === null || now.getTime() - Date.parse(last.at) >= PARK_REPEAT_MS) return false;
  const recovered = new Set(last.targets.map(probeTargetKey));
  return targets.some((t) => recovered.has(probeTargetKey(t)));
}

/** A recorded outcome: its fact, and for a repeat park the needs-user reason that replaces the row's (`env-blocked`). */
export type ParkedOutcome = Readonly<{ fact: StageOutcomeFact; repeat: boolean }>;

/**
 * The `stage-outcome` fact of `outcome` at `attempt` (`outcomeFact`), with a retryable park's targets from
 * `facts`, and the repeat rule applied: a retryable park that repeats (`isRepeat`) is written operator `env`,
 * so `resume <unit>` re-runs it and no probe does. `cause` is a hold's (G5), passed through.
 */
export function stageOutcomeFact(
  u: UnitState, outcome: StageOutcome, attempt: number, facts: ParkFacts, now: Date, cause?: OutcomeContext['cause'],
): ParkedOutcome {
  const base: OutcomeContext = cause === undefined ? {} : { cause };
  if (parkClassOf(u, outcome) !== 'retryable') return { fact: outcomeFact(u, outcome, attempt, base), repeat: false };
  const targets = parkTargets(outcome, facts);
  const fact = outcomeFact(u, outcome, attempt, { ...base, targets });
  if (!isRepeat(u, targets, now)) return { fact, repeat: false };
  return { fact: { ...fact, park: { class: 'operator', kind: 'env' } }, repeat: true };
}

/** What a repeat park's needs-user says (the row's reason becomes `env-blocked`); the operator resumes it. */
export function repeatNeedsUser(u: UnitState, fact: StageOutcomeFact, row: NeedsUserContent): NeedsUserContent {
  return {
    reason: 'env-blocked',
    summary: `${row.summary} Unit ${u.unit} recovered on the same target at ${u.lastRecovery?.at ?? 'unknown'}, less than 6 h ago, and parked `
      + `on it again at ${fact.stage} (attempt ${fact.attempt}), so it is not probed again: fix the environment, then \`roadmap resume ${u.unit}\`.`,
  };
}
