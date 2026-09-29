// The serial arc (M1): the plan's units in plan order, one at a time, each through the unit driver. The plan
// is the plan in force, read again for each next unit, so a unit an apply adds runs in its turn.
//
// Terminal predicate (plan "Salvage", DESIGN-1.0.md §2.10): every unit merged, or parked with an open
// blocking needs-user. M1 has no DAG, so a parked unit does not stop the ones after it, unless one names it
// in `after` (plan.json): that unit waits until the parked one's needs-user is acknowledged. A held unit (an
// interrupted stage, a backend parked on a usage limit, or a pause between stages) ends the run without
// ending the arc: the next run continues it from the journal. So does a unit the arc may not start
// (`dispatchBlock`: paused, or waiting on `after`): the arc waits at it, with no dispatch fact and no
// invocation, and every unit after it waits too (M1 is serial). A stop (a foreign ref move) ends the run at
// once. The needs-user content of every park and stop is returned for the writer (the executor); a park's
// is also handed to `onParked` the moment the unit parks, so its item is raised while later units run
// rather than when the arc returns.
import type { UnitId } from '../core/ids.ts';
import type { StageContext } from './dispatch.ts';
import { type AtBoundary, type UnitResult, noBoundary, runUnit } from './unit.ts';
import type { NeedsUserContent } from '../core/records.ts';

export type Settled = Readonly<{ unit: UnitId; result: Extract<UnitResult, Readonly<{ kind: 'merged' | 'parked' }>> }>;

export type ArcResult =
  /** Every unit merged or parked; each parked unit carries the blocking needs-user it waits on. */
  | Readonly<{ kind: 'terminal'; units: readonly Settled[] }>
  /** `unit` waits for a resume; the units before it are settled. */
  | Readonly<{ kind: 'held'; unit: UnitId; needsUser: NeedsUserContent | null; settled: readonly Settled[] }>
  | Readonly<{ kind: 'stopped'; unit: UnitId; needsUser: NeedsUserContent; settled: readonly Settled[] }>;

/** Called for each unit the arc finds parked, before the next unit runs; the writer raises each item once. */
export type OnParked = (unit: UnitId, needsUser: NeedsUserContent) => void;

/**
 * `atBoundary` runs at every stage boundary of every unit (the executor applies pending mutations there).
 * The next unit is the first in the plan in force this pass has not run to a result yet.
 */
export async function runArc(ctx: StageContext, signal: AbortSignal, onParked: OnParked, atBoundary: AtBoundary = noBoundary): Promise<ArcResult> {
  const settled: Settled[] = [];
  const ran = new Set<UnitId>();
  for (;;) {
    const unit = ctx.plan().units.find((u) => !ran.has(u.id));
    if (unit === undefined) return { kind: 'terminal', units: settled };
    ran.add(unit.id);
    const result = await runUnit(ctx, unit, signal, atBoundary);
    switch (result.kind) {
      case 'held':
        return { kind: 'held', unit: unit.id, needsUser: result.needsUser, settled };
      case 'stopped':
        return { kind: 'stopped', unit: unit.id, needsUser: result.needsUser, settled };
      case 'parked':
        onParked(unit.id, result.needsUser);
        settled.push({ unit: unit.id, result });
        break;
      case 'merged':
        settled.push({ unit: unit.id, result });
    }
  }
}
