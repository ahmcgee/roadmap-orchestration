// Shared by the M3 scheduler tests (test/scheduler-m3.test.ts) and their crash child (sched-m3-child.ts): the scheduler
// over a holistic arc, wired as the executor wires it (one arbiter, the real prober, the docs publisher over that
// arbiter, a stop controller), its plan the plan in force read from the log at each call; the holistic contexts over the
// same wiring; and the arc every completion test starts from.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../src/commands/apply.ts';
import { absPath } from '../../src/core/values.ts';
import { readHostSample } from '../../src/host/sample.ts';
import { requirePlanInForce } from '../../src/input/inforce.ts';
import { createProber } from '../../src/park/probe.ts';
import type { StageContext } from '../../src/pipeline/dispatch.ts';
import { docsPublisher } from '../../src/pipeline/publish.ts';
import { type Arbiter, createArbiter } from '../../src/schedule/arbiter.ts';
import { type HolisticContexts, type SchedulerEnd, holisticContexts, schedule } from '../../src/schedule/scheduler.ts';
import { checkpointAnswer, checkpointStep, lensStep } from '../helpers/holistic.ts';
import type { Step } from '../helpers/scenario.ts';
import { moduleFiles, unitSteps } from './audit-common.ts';
import { checkpointArc } from './checkpoint-common.ts';
import { type ArcDescriptor, type ArcRun, commandContextFor } from './unit-common.ts';

type Json = Record<string, unknown>;

export type HolisticScheduled = Readonly<{
  end: Promise<SchedulerEnd>; stage: StageContext; commands: CommandContext; arbiter: Arbiter; h: HolisticContexts;
}>;

/** The run's wiring without a scheduler: what `completionBlockers` and the jobs read (the plan in force at each call). */
export function wired(r: ArcRun): Readonly<{ stage: StageContext; commands: CommandContext; arbiter: Arbiter; stop: AbortController }> {
  const plan = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
  const resources = { ...r.ctx, plan };
  const arbiter = createArbiter(resources);
  const stage: StageContext = { ...resources, acquire: arbiter.acquire };
  const prober = createProber({ ...stage, profile: 'default', sample: readHostSample });
  const stop = new AbortController();
  const commands: CommandContext = {
    ...commandContextFor(r, stage), plan,
    docs: docsPublisher({ ...resources, hostEnv: r.ctx.hostEnv, planFile: absPath(r.d.planPath), arbiter }),
    probes: { prober, signal: stop.signal },
  };
  return { stage, commands, arbiter, stop };
}

/** Starts the scheduler over `r`'s holistic arc, as the executor does after recovery. */
export function startHolistic(r: ArcRun): HolisticScheduled {
  const w = wired(r);
  const prober = w.commands.probes.prober;
  return { end: schedule({ stage: w.stage, commands: w.commands, arbiter: w.arbiter, prober, stop: w.stop }), ...w, h: holisticContexts(w) };
}

/** The holistic contexts over `r` (no scheduler running). */
export function contextsOf(r: ArcRun): HolisticContexts {
  return holisticContexts(wired(r));
}

export const NOOP = checkpointAnswer({ decision: 'no-op' });

/**
 * The arc of the completion tests: u1 (mul, merged through its pipeline), I-1 must-hold and held on every tree, L =
 * {vision}; the final audit `audit-1` (its vision lens) and its checkpoint `ckpt-1` (a no-op); `more` steps after.
 */
export function completingArc(more: readonly Step[] = []): ArcDescriptor {
  return checkpointArc([...unitSteps('u1', moduleFiles('mul', '*')), lensStep('audit-1', 'vision'), checkpointStep('ckpt-1', NOOP), ...more]);
}

/** Adds unit `id` to the plan file (u1's spec renamed, a module of its own): what an architect admit edits before `apply`. */
export function addUnit(d: ArcDescriptor, id: string): void {
  const planDir = join(d.planPath, '..');
  const spec = JSON.parse(readFileSync(join(planDir, 'u1.json'), 'utf8')) as Json;
  writeFileSync(join(planDir, `${id}.json`), JSON.stringify({ ...spec, unit: id, rev: 1 }));
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
  const u1 = plan.units.find((u) => u['id'] === 'u1')!;
  writeFileSync(d.planPath, JSON.stringify({ ...plan, units: [...plan.units, { ...u1, id, spec: `${id}.json` }] }));
}
