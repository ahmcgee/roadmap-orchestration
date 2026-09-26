// Declared resource commands (occupancy probe and teardown) run through `invoke`, and the owner label
// that ties them to a unit (plan "Reservation cycle", R4).
//
// A declared ToolCommand is resolved once into a concrete recipe: argv as declared, cwd under the repo
// root, env = the declared `set` values, the `pass` names copied from the executor's environment, and the
// owner label in RESOURCE_OWNER. The same resolved teardown is what a failed cleanup records in the host
// residue index, so a later sweep can replay it without the plan. A probe reads the label to answer
// PROBE_EXIT.ownLabel (10) for objects this unit left behind; a teardown removes only what carries it.
import { join } from 'node:path';
import type { Parent } from '../core/events.ts';
import { type ArcId, type InvocationId, type ResourceName, type UnitId, INTEGRATION_SLOT, opKey } from '../core/ids.ts';
import type { CommandVerdict, TeardownRecipe } from '../core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import type { PlanM1, ResourceDecl, ToolCommand } from '../input/plan.ts';
import { type ProcContext, invocationDir, invoke } from '../pipeline/invoke.ts';
import type { ResidueRecipe } from '../recover/residue.ts';

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

export function resourceDecl(plan: PlanM1, resource: ResourceName): ResourceDecl {
  const decl = plan.resources.find((d) => d.name === resource);
  if (decl === undefined) throw new Error(`resource ${resource} is not declared in the plan of arc ${plan.arc}`);
  return decl;
}

/** A declared command resolved against the repo root and this process's environment, with the owner label. */
export function resolveCommand(repo: AbsPath, command: ToolCommand, label: string): TeardownRecipe {
  const env: Record<string, string> = { ...command.env.set };
  for (const name of command.env.pass) {
    const value = process.env[name];
    // Startup refuses a declared pass variable the host lacks (spec-lane-unrunnable), so this is a bug.
    if (value === undefined) throw new Error(`declared variable ${name} of ${JSON.stringify(command.argv)} is not set`);
    env[name] = value;
  }
  if (Object.hasOwn(env, OWNER_ENV)) throw new Error(`${JSON.stringify(command.argv)} declares ${OWNER_ENV}, which the executor sets`);
  env[OWNER_ENV] = label;
  return { argv: command.argv, cwd: absPath(join(repo, command.cwd)), env };
}

/**
 * The teardown recipe of each resource a unit's stage holds, keyed by resource. The built-in
 * integration-slot declares no teardown and has no entry: it is clean once its holder is quiescent.
 */
export function stageRecipes(
  plan: PlanM1,
  repo: AbsPath,
  unit: UnitId,
  resources: readonly ResourceName[],
): ReadonlyMap<ResourceName, ResidueRecipe> {
  const label = ownerLabel(plan.arc, unit);
  return new Map(resources.filter((r) => r !== INTEGRATION_SLOT).map((r) => [r, { teardown: resolveCommand(repo, resourceDecl(plan, r).teardown, label), label }]));
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
  resource: ResourceName,
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

export type TeardownRun = Readonly<{ resource: ResourceName; inv: InvocationId; clean: boolean }>;

/** One resource's teardown; it is clean only on exit 0. */
export async function teardown(
  ctx: ProcContext,
  unit: UnitId | null,
  resource: ResourceName,
  recipe: ResidueRecipe,
  parent: Parent,
): Promise<TeardownRun> {
  const run = await runResourceCommand(ctx, 'teardown', unit, resource, recipe.teardown, parent);
  return { resource, inv: run.inv, clean: run.verdict === 'pass' };
}
