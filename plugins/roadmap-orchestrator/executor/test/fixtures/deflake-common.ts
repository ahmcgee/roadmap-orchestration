// Shared by the flaky-ledger tests (test/deflake.test.ts) and their crash child (deflake-child.ts): an arc whose units
// run a flaky spec lane (red on its first run, green after, its state a marker file outside the repo), wired as the
// executor wires it (the plan in force read from the log at each call), and the deflake job's context over that wiring.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type UnitId, unitId } from '../../src/core/ids.ts';
import { rankOf } from '../../src/schedule/ready.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import type { PlanUnit } from '../../src/input/plan.ts';
import type { DeflakeContext } from '../../src/pipeline/deflakemint.ts';
import { holisticContexts } from '../../src/schedule/scheduler.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { LaneJson } from './stage-common.ts';
import type { ArcDescriptor, ArcRun } from './unit-common.ts';
import { wired } from './sched-m3-common.ts';

const RED_GREEN = fileURLToPath(new URL('../fakes/red-green.ts', import.meta.url));

/** A flaky lane `id`: red on its first run while `marker` is absent (it creates it), green on every run after. */
export const flakyLane = (marker: string, id = 'flaky'): LaneJson => ({ id, argv: [process.execPath, RED_GREEN, marker, 'expected 3, got 4'] });

/** A fresh marker path (absent: the lane's next run is red). */
export const freshMarker = (): string => join(tmpDir('flaky-marker'), 'flaky.marker');

/** Makes the lane flake again: its next run is red, the one after green. */
export const reflake = (marker: string): void => rmSync(marker, { force: true });

/** Unit `id` of the plan in force (a deflake unit the ledger minted included). */
export function unitInForce(r: ArcRun, id: string): PlanUnit {
  const u = requirePlanInForce(r.ctx.runDir, r.journal.view).plan.units.find((x) => x.id === unitId(id));
  if (u === undefined) throw new Error(`no unit ${id} in the plan in force`);
  return u;
}

/** The deflake job's context (the fenced commit's and the repository) over the run's wiring. */
export function deflakeContext(r: ArcRun): Readonly<{ ctx: DeflakeContext; w: ReturnType<typeof wired> }> {
  const base = wired(r);
  // The rank over the plan in force too (a deflake unit the job added waits in the arbiter's queue).
  const w = { ...base, stage: { ...base.stage, rank: (u: UnitId) => rankOf(r.journal.view, base.stage.plan(), u) } };
  return { ctx: holisticContexts(w).checkpoint, w };
}

export type { ArcDescriptor };
