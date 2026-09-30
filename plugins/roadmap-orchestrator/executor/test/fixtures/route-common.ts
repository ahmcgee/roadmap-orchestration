// Shared by the route and gate tests (M3 step A3): an arc whose StageContext follows the log as the executor's
// does (src/executor.ts `contexts`): `plan()` is the plan in force and `routing(unit)` resolves from the
// `routingProvenance` its revision recorded, per unit. unit-common's `contextFor` fixes both at the files, so a test
// whose applies change routing, limits or risk mid-run drives its units through `follow` instead. The commands go
// through the command path (`submitCommand` + `applyCommand`) under that context.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandContext, type CommandOutcome, applyCommand } from '../../src/commands/apply.ts';
import { submitCommand } from '../../src/commands/queue.ts';
import type { StageOutcomeFact } from '../../src/core/events.ts';
import { unitId } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import type { CommandBody } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { type RoutingBase, readInputFiles, recordPlan, requirePlanInForce } from '../../src/input/inforce.ts';
import type { PlanUnit } from '../../src/input/plan.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import { step } from '../../src/pipeline/unit.ts';
import { provenanceStack, resolveRouting } from '../../src/routing/layers.ts';
import { serialRuntime } from './stage-common.ts';
import { type ArcDescriptor, type ArcRun, applyBody, commandContextFor } from './unit-common.ts';

export type Json = Record<string, unknown>;
export const BASE: RoutingBase = { profile: 'default', config: null };

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
export const planDirOf = (d: ArcDescriptor): string => join(d.planPath, '..');
export const specPathOf = (d: ArcDescriptor, unit: string): string => join(planDirOf(d), `${unit}.json`);

export function editJson(path: string, edit: (v: Json) => void): void {
  const v = readJson(path);
  edit(v);
  writeFileSync(path, JSON.stringify(v));
}
export const editPlan = (d: ArcDescriptor, edit: (p: Json & { units: Json[] }) => void): void => editJson(d.planPath, edit as (v: Json) => void);
export const editSpec = (d: ArcDescriptor, unit: string, edit: (s: Json) => void): void => editJson(specPathOf(d, unit), edit);
/** Edits plan unit `id`'s entry. */
export const editUnit = (d: ArcDescriptor, id: string, edit: (u: Json) => void): void =>
  editPlan(d, (p) => edit(p.units.find((u) => u['id'] === id) ?? (() => { throw new Error(`no unit ${id}`); })()));

/** Records the files as revision 1, as an M3 first start does (payload, `revision.commit`, `plan-applied` with provenance). */
export function recordFirst(d: ArcDescriptor, base: RoutingBase = BASE): void {
  const j = openJournal(absPath(d.runDir), d.arc as never);
  recordPlan(j, absPath(d.runDir), readInputFiles(absPath(d.planPath)), [], base);
  j.close();
}

/** `r`'s stage context following the log: the plan in force and each unit's routing from its revision's provenance. */
export function followContext(r: ArcRun): StageContext {
  const inForce = () => requirePlanInForce(r.ctx.runDir, r.journal.view);
  const plan = () => inForce().plan;
  const routing: StageContext['routing'] = (unit) => {
    const { fact, plan: p } = inForce();
    if (fact.routingProvenance === undefined) throw new Error(`plan rev ${fact.rev} records no routing provenance`);
    return resolveRouting(provenanceStack(fact.routingProvenance, p.holistic !== undefined, unit));
  };
  const resources = { ...r.ctx, plan };
  return { ...resources, routing, ...serialRuntime(resources) };
}

/** The command context over `stage`, as the executor builds it: each unit's routing, the start's routing base. */
export function commandsOf(r: ArcRun, stage: StageContext, base: RoutingBase = BASE): CommandContext {
  return { ...commandContextFor(r, stage), routingBase: base, routing: (unit) => ({ profile: base.profile, resolved: stage.routing(unit) }) };
}

/** Submits one command and applies it, as the executor's loop does at a safe point. */
export async function command(r: ArcRun, stage: StageContext, body: CommandBody, base: RoutingBase = BASE): Promise<CommandOutcome> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return applyCommand(commandsOf(r, stage, base), file);
}

/** `roadmap apply` of the files as they are now. */
export const apply = (r: ArcRun, stage: StageContext, base: RoutingBase = BASE): Promise<CommandOutcome> => command(r, stage, applyBody(r.d), base);

/** Unit `id` in the plan in force of `ctx`. */
export function unitOf(ctx: StageContext, id: string): PlanUnit {
  const u = ctx.plan().units.find((x) => x.id === unitId(id));
  if (u === undefined) throw new Error(`no unit ${id} in the plan in force`);
  return u;
}

/** Steps unit `id` under `ctx` (its plan entry read in force at each step) until its latest decided outcome satisfies `until`. */
export async function stepTo(ctx: StageContext, id: string, until: (f: StageOutcomeFact) => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = await step(ctx, unitOf(ctx, id));
    const f = ctx.journal.view.unit(unitId(id)).decided;
    if (f !== null && until(f)) return;
    if (s.kind !== 'continue') throw new Error(`unit ${id} ended ${s.kind} (${JSON.stringify(s)}) before the condition held`);
  }
  throw new Error(`unit ${id}: the condition did not hold within 60 steps`);
}

/** The model a Claude call ran on (its `--model` argument). */
export function modelOf(argv: readonly string[]): string {
  const i = argv.indexOf('--model');
  if (i === -1) throw new Error(`no --model in ${argv.join(' ')}`);
  return argv[i + 1]!;
}
