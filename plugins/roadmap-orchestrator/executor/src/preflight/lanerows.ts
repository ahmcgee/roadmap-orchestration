// The one lane validator: the row `spec-lane-unrunnable` (SCHEMAS.md "Startup rejection table"). Every path a spec
// enters runs it: a start (`specLaneCheck`, src/preflight/checks.ts, over every live unit) and the apply core
// (src/commands/apply.ts `evaluateRevision`, over the units a revision changes), which every revision passes through:
// an `apply` and its dry run, a checkpoint bundle, a flow proposal, `steer`, `rule` and `reverse` (paid M4b run 3,
// OP-3: a checkpoint bundle admitted a lane whose env did not pass PATH, so its argv[0] never resolved).
//
// It validates what the plan makes live, never what it retires: a cut unit and a unit another unit of the plan
// re-enters (superseded) run no lane again, so their lanes are not checked (OP-3: every apply cutting or re-entering
// the unrunnable unit was refused for that unit's own lanes).
import type { UnitId } from '../core/ids.ts';
import type { LaneDef, LaneEnv, SpecM1 } from '../core/records.ts';
import type { PlanM1, PlanUnit } from '../input/plan.ts';
import { checkLaneTiers } from '../resources/reserve.ts';
import { resolveArgv0 } from './argv0.ts';
import type { CommandProblem, StartupRejection } from './startup.ts';

export type LaneRow = Extract<StartupRejection, { kind: 'spec-lane-unrunnable' }>;
type Env = Readonly<Record<string, string | undefined>>;

/** A declared command: a lane, or a resource's probe or teardown. */
type Declared = Readonly<{ argv: readonly string[]; env: LaneEnv }>;

/** argv[0] and the declared host variables of one command. */
function commandProblems(command: Declared, env: Env): CommandProblem[] {
  const out: CommandProblem[] = [];
  if (resolveArgv0(command, env).kind === 'not-found') out.push({ type: 'argv0-unresolvable', argv0: command.argv[0] as string });
  for (const name of command.env.pass) if (env[name] === undefined) out.push({ type: 'env-missing', name });
  return out;
}

const laneProblems = (unit: UnitId | null, lane: LaneDef, env: Env): LaneRow[] =>
  commandProblems(lane, env).map((problem) => ({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem }));

/** Whether `unit` may run a lane under `plan`: neither cut nor re-entered by another unit of the plan. */
export const isLive = (plan: PlanM1, unit: PlanUnit): boolean => unit.cut === undefined && !plan.units.some((u) => u.reenters?.unit === unit.id);

/**
 * The suite lanes, the active lanes of each live unit of `units` (argv[0], declared host variables, the fast/estate
 * boundary), then every resource's probe and teardown command. `specOf` is the unit's spec under `plan`.
 */
export function laneRows(plan: PlanM1, units: readonly UnitId[], specOf: (unit: PlanUnit) => SpecM1, env: Env): readonly LaneRow[] {
  const out = plan.suite.lanes.flatMap((lane) => laneProblems(null, lane, env));
  for (const unit of plan.units) {
    if (!units.includes(unit.id) || !isLive(plan, unit)) continue;
    const spec = specOf(unit);
    for (const lane of spec.lanes) if (lane.state === 'active') out.push(...laneProblems(unit.id, lane, env));
    out.push(...checkLaneTiers(spec, unit));
  }
  for (const r of plan.resources) {
    for (const command of ['probe', 'teardown'] as const) {
      out.push(...commandProblems(r[command], env).map((problem): LaneRow => ({ kind: 'spec-lane-unrunnable', resource: r.name, command, problem })));
    }
  }
  return out;
}
