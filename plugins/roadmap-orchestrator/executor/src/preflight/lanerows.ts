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
import { type PlanM1, type PlanUnit, derivedOf, environmentOf, environmentsOf, regenerateLaneId } from '../input/plan.ts';
import { checkBuildLanes } from '../resources/reserve.ts';
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

/** argv[0], the declared host variables, and (dev.17) the environment the lane names, which the plan must declare. */
function laneProblems(plan: PlanM1, unit: UnitId | null, lane: LaneDef, env: Env): LaneRow[] {
  const out: LaneRow[] = commandProblems(lane, env).map((problem) => ({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem }));
  if (lane.environment !== undefined && environmentOf(plan, lane.environment) === null) {
    out.push({ kind: 'spec-lane-unrunnable', unit, lane: lane.id, problem: { type: 'unknown-environment', environment: lane.environment } });
  }
  return out;
}

/** Whether `unit` may run a lane under `plan`: neither cut nor re-entered by another unit of the plan. */
export const isLive = (plan: PlanM1, unit: PlanUnit): boolean => unit.cut === undefined && !plan.units.some((u) => u.reenters?.unit === unit.id);

/**
 * The suite lanes and the derived entries' regenerate commands (each under its regenerate lane's id), the active lanes of
 * each live unit of `units` (argv[0], declared host variables, a declared environment, the build-cadence boundary), then every
 * resource's probe and teardown command and every environment's probe, up and down (dev.17). `specOf` is the unit's spec under `plan`.
 */
export function laneRows(plan: PlanM1, units: readonly UnitId[], specOf: (unit: PlanUnit) => SpecM1, env: Env): readonly LaneRow[] {
  const out = plan.suite.lanes.flatMap((lane) => laneProblems(plan, null, lane, env));
  // dev.17: a build-cadence suite lane runs in the implementer's build too, which never brings an environment up.
  for (const lane of plan.suite.lanes) {
    if (lane.cadence === 'build' && lane.environment !== undefined) out.push({ kind: 'spec-lane-unrunnable', unit: null, lane: lane.id, problem: { type: 'estate-lane-for-implementer' } });
  }
  // dev.12: a derived entry's generator, as the suite lane its regenerate check runs under (`regenerateLaneId`).
  for (const d of derivedOf(plan)) {
    if (d.regenerate !== undefined) out.push(...commandProblems(d.regenerate, env).map((problem): LaneRow => ({ kind: 'spec-lane-unrunnable', unit: null, lane: regenerateLaneId(d), problem })));
  }
  for (const unit of plan.units) {
    if (!units.includes(unit.id) || !isLive(plan, unit)) continue;
    const spec = specOf(unit);
    for (const lane of spec.lanes) if (lane.state === 'active') out.push(...laneProblems(plan, unit.id, lane, env));
    out.push(...checkBuildLanes(spec, unit));
  }
  for (const r of plan.resources) {
    for (const command of ['probe', 'teardown'] as const) {
      out.push(...commandProblems(r[command], env).map((problem): LaneRow => ({ kind: 'spec-lane-unrunnable', resource: r.name, command, problem })));
    }
  }
  // dev.17: each environment's probe, and its up and down when it has a lifecycle.
  for (const e of environmentsOf(plan)) {
    const commands: readonly (readonly ['probe' | 'up' | 'down', Declared])[] = e.lifecycle === null
      ? [['probe', e.probe]]
      : [['probe', e.probe], ['up', e.lifecycle.up], ['down', e.lifecycle.down]];
    for (const [command, declared] of commands) {
      out.push(...commandProblems(declared, env).map((problem): LaneRow => ({ kind: 'spec-lane-unrunnable', resource: e.name, command, problem })));
    }
  }
  return out;
}
