// Declared resource commands (occupancy probe and teardown) run through `invoke`, and the owner label
// that ties them to a unit (plan "Reservation cycle", R4).
//
// A declared ToolCommand is resolved once into a concrete recipe: argv as declared, cwd under the repo
// root, env = the declared `set` values, the `pass` names copied from the executor's environment, the
// owner label in RESOURCE_OWNER, and the holder's instance binding (`RESOURCE_INSTANCE_<POOL>=<n>` per pool
// instance it holds, F7; `instanceEnv` in pool.ts). A pool instance runs its pool's declared commands. The same resolved teardown is what a failed cleanup records in the host
// residue index, so a later sweep can replay it without the plan. A probe reads the label to answer
// PROBE_EXIT.ownLabel (10) for objects this unit left behind; a teardown removes only what carries it.
import { join } from 'node:path';
import type { Parent } from '../core/events.ts';
import {
  type ArcId, type InvocationId, type ResourceInstance, type ResourceUnit, type UnitId, INTEGRATION_SLOT, opKey, parseResourceUnit,
} from '../core/ids.ts';
import type { CommandVerdict, TeardownRecipe } from '../core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import type { PlanM1, ResourceDecl, ToolCommand } from '../input/plan.ts';
import { type ProcContext, invocationDir, invoke } from '../pipeline/invoke.ts';
import type { ResidueRecipe } from '../recover/residue.ts';
import { declOf, instanceEnv } from './pool.ts';

/** The variable a probe or teardown reads its owner label from. Not ROADMAP_*: those are the runner's. */
export const OWNER_ENV = 'RESOURCE_OWNER';

/** Plan declarations carry no timeouts; a probe or teardown that outlives these is a failed command. */
export const PROBE_TIMEOUT_MS = 2 * 60_000;
export const TEARDOWN_TIMEOUT_MS = 10 * 60_000;
const GRACE_MS = 2_000;

/** Every object a unit's lanes and backends create is labelled with this; probes and teardowns match it. */
export function ownerLabel(arc: ArcId, unit: UnitId): string {
  return `${arc}/${unit}`;
}

/** The declaration whose probe and teardown a resource instance runs: a pool instance's is its pool's. */
export function resourceDecl(plan: PlanM1, resource: ResourceInstance): ResourceDecl {
  const p = parseResourceUnit(resource);
  if (p.type === 'cpu') throw new Error(`${resource} is an @cpu token: it has no probe or teardown`);
  return declOf(plan, p.type === 'instance' ? p.pool : p.name);
}

/**
 * A declared command resolved against the repo root and this process's environment, with the owner label
 * and the holder's instance binding `instances` (`instanceEnv` of its whole set).
 */
export function resolveCommand(repo: AbsPath, command: ToolCommand, label: string, instances: Readonly<Record<string, string>>): TeardownRecipe {
  const env: Record<string, string> = { ...command.env.set };
  for (const name of command.env.pass) {
    const value = process.env[name];
    // Startup refuses a declared pass variable the host lacks (spec-lane-unrunnable), so this is a bug.
    if (value === undefined) throw new Error(`declared variable ${name} of ${JSON.stringify(command.argv)} is not set`);
    env[name] = value;
  }
  for (const name of [OWNER_ENV, ...Object.keys(instances)]) {
    if (Object.hasOwn(env, name)) throw new Error(`${JSON.stringify(command.argv)} declares ${name}, which the executor sets`);
  }
  env[OWNER_ENV] = label;
  Object.assign(env, instances);
  return { argv: command.argv, cwd: absPath(join(repo, command.cwd)), env };
}

/** The units that declare a probe and a teardown: named resources and pool instances (not `@cpu`, not the slot). */
export function instancesOf(resources: readonly ResourceUnit[]): readonly ResourceInstance[] {
  return resources.flatMap((r) => {
    const p = parseResourceUnit(r);
    return p.type === 'cpu' || r === INTEGRATION_SLOT ? [] : [r as ResourceInstance];
  });
}

/**
 * The teardown recipe of each resource instance among `resources` that a unit's holder holds, keyed by
 * instance, bound to `instances` (default: the binding of `resources` itself; recovery passes the holder's
 * whole set). `@cpu` tokens and the built-in integration-slot declare no teardown and have no entry: they are
 * clean once their holder is quiescent.
 */
export function stageRecipes(
  plan: PlanM1,
  repo: AbsPath,
  unit: UnitId,
  resources: readonly ResourceUnit[],
  instances: Readonly<Record<string, string>> = instanceEnv(resources),
): ReadonlyMap<ResourceInstance, ResidueRecipe> {
  const label = ownerLabel(plan.arc, unit);
  return new Map(instancesOf(resources).map((r) => [r, { teardown: resolveCommand(repo, resourceDecl(plan, r).teardown, label, instances), label }]));
}

/** How a declared command ended: its exit code and verdict against exit 0, or lost with its runner. */
export type CommandRun = Readonly<{
  inv: InvocationId;
  exitCode: number | null;
  verdict: CommandVerdict | 'lost';
  /** stdout and stderr of the invocation, the evidence a needs-user cites. */
  evidence: readonly AbsPath[];
}>;

/**
 * Runs one declared command as a new `proc.spawn{purpose}` op keyed per resource, so at most one probe
 * and one teardown of a resource are open at a time.
 */
export async function runResourceCommand(
  ctx: ProcContext,
  purpose: 'probe' | 'teardown',
  unit: UnitId | null,
  resource: ResourceInstance,
  recipe: TeardownRecipe,
  parent: Parent,
): Promise<CommandRun> {
  const timeout = purpose === 'probe' ? PROBE_TIMEOUT_MS : TEARDOWN_TIMEOUT_MS;
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`${purpose}:${resource}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + timeout)) },
    subject: { purpose, unit, resource },
    launch: () => ({
      argv: recipe.argv, cwd: recipe.cwd, env: recipe.env, stdinPath: null, stallMs: null, graceMs: GRACE_MS,
      terminal: { type: 'command', purpose, expectedExit: 0 },
    }),
  });
  const dir = invocationDir(ctx.runDir, outcome.inv);
  const evidence = [absPath(join(dir, 'stdout')), absPath(join(dir, 'stderr'))];
  if (outcome.kind === 'lost') return { inv: outcome.inv, exitCode: null, verdict: 'lost', evidence };
  const { result } = outcome;
  if (result.type !== 'command') throw new Error(`${outcome.inv}: a ${purpose} produced a ${result.type} result`);
  return { inv: outcome.inv, exitCode: result.exitCode, verdict: result.verdict, evidence };
}

export type TeardownRun = Readonly<{ resource: ResourceInstance; inv: InvocationId; clean: boolean }>;

/** One resource's teardown; it is clean only on exit 0. */
export async function teardown(
  ctx: ProcContext,
  unit: UnitId | null,
  resource: ResourceInstance,
  recipe: ResidueRecipe,
  parent: Parent,
): Promise<TeardownRun> {
  const run = await runResourceCommand(ctx, 'teardown', unit, resource, recipe.teardown, parent);
  return { resource, inv: run.inv, clean: run.verdict === 'pass' };
}
