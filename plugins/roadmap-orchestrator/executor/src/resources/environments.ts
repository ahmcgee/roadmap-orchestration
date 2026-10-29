// Plan environments (dev.17; SCHEMAS.md "dev.17: environments", DESIGN-1.0.md §2.2 Environments): a costed thing a lane runs
// against (a database, a cluster, a cloud stack), declared once in plan.json `environments` and named by a lane's
// `environment`, or inherited from a requested resource in its `resources` list. Use is serialised by the reservation cycle: the environment's name is a named resource unit the lane
// reserves with its resources (src/resources/pool.ts), so one lane at a time uses it. This module owns the rest:
//
//   lifecycle   down → starting → up → stopping → down, one transition at a time. The journal is the state machine:
//               `up` and `down` are `proc.spawn{purpose: environment}` ops keyed `env:<name>`, so at most one is open
//               (an open up is `starting`, an open down `stopping`), and the latest closed one says `up` or `down`
//               (`environmentState`). An up or down that failed or was lost leaves it `unsettled`: maybe partly up, so
//               the next transition is a down.
//   use         `useEnvironment`, after the lane's reservation and occupancy probe and before its run: bring it up when
//               it is not (lazily, at the first use), then its probe. A failed up or probe brings a managed environment
//               down (a fresh up next time) and answers `unavailable`: the lane's stage parks `env-unavailable`, a
//               retryable park on the environment (src/park/table.ts), never a red lane. `releaseEnvironment` after the
//               lane's cleanup starts its idle clock.
//   idle        kept alive by use: `idleEnvironments` names the managed environments up, unused, with no lane holding
//               or waiting for them (the caller's `busy`), whose last use is `idleMinutes` old; the scheduler brings
//               each down (`bringDown`). Under a pause of every unit or a stop the idle time is zero.
//   recovery    recovery closes an open up or down like any spawn (src/recover/spawn.ts). `settleEnvironments`, at the
//               scheduler's start, brings every `unsettled` environment down; one found up resumes its idle clock from
//               the start (its last use is not in the log, so it is never brought down sooner than `idleMinutes` after).
//   end         a stop, and every other end of the scheduler, brings every environment down (`downEnvironments`).
//
// A failed down raises one non-blocking `env-blocked` item: the environment may still be up, and costing.
//
// Transitions of one environment are serialised in process by a promise chain (`Slot.chain`): a start queued behind an
// in-flight stop waits for it. The chain, the users count and the last use are the only in-memory state, kept per
// journal (one executor process owns one journal). A plain environment (no `up`/`down`) has no lifecycle: only its
// probe runs, and nothing here ever starts or stops it.
import { join } from 'node:path';
import type { EnvironmentAction, IntentOf, Parent } from '../core/events.ts';
import { type InvocationId, type ResourceName, opKey, parseInvocationId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import { type EnvironmentDecl, type PlanM1, type ToolCommand, environmentOf, environmentsOf } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor } from '../needsuser.ts';
import { invocationDir, invoke } from '../pipeline/invoke.ts';
import type { ResourceContext } from './reserve.ts';
import { resolveCommand } from './teardown.ts';

/** An up or a down may take a while (a cloud stack); a probe is a health check. Declarations carry no timeouts. */
export const ENV_LIFECYCLE_TIMEOUT_MS = 30 * 60_000;
export const ENV_PROBE_TIMEOUT_MS = 2 * 60_000;
const GRACE_MS = 2_000;
const MINUTE_MS = 60_000;

/** The owner label an environment's commands carry (`RESOURCE_OWNER`): `<arc>/env/<name>`. */
export const environmentOwnerLabel = (arc: string, name: ResourceName): string => `${arc}/env/${name}`;

// ---------------------------------------------------------------------------------------------------
// The state, from the log

export type EnvironmentState = 'down' | 'starting' | 'up' | 'stopping' | 'unsettled';

type LifecycleIntent = IntentOf<'proc.spawn'> & Readonly<{ expect: Readonly<{ subject: Readonly<{ purpose: 'environment'; action: 'up' | 'down' }> }> }>;

function lifecycleIntents(view: JournalView, name: ResourceName): readonly LifecycleIntent[] {
  return view.opsOf('proc.spawn').filter((i): i is LifecycleIntent => {
    const s = i.expect.subject;
    return s.purpose === 'environment' && s.environment === name && s.action !== 'probe';
  });
}

/** Whether a closed spawn ran to exit 0. */
function passed(view: JournalView, intent: IntentOf<'proc.spawn'>): boolean {
  const done = view.doneOf(intent.op);
  return done !== null && done.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.outcome.summary.type === 'command' && done.outcome.summary.verdict === 'pass';
}

/** Environment `name`'s lifecycle state as the log records it (a plain environment is always `down` here: it has none). */
export function environmentState(view: JournalView, name: ResourceName): EnvironmentState {
  const last = lifecycleIntents(view, name).at(-1);
  if (last === undefined) return 'down';
  if (view.openIntents().some((i) => i.op === last.op)) return last.expect.subject.action === 'up' ? 'starting' : 'stopping';
  if (!passed(view, last)) return 'unsettled';
  return last.expect.subject.action === 'up' ? 'up' : 'down';
}

/**
 * Why environment `name` is unavailable to the arc, or null (item 10, the design pass's `clauseFaults`): its latest closed
 * up or probe in this arc failed, with none passing since. Never brought up nor probed: presumed available.
 */
export function environmentUnavailable(view: JournalView, name: ResourceName): string | null {
  const last = view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'environment' && s.environment === name && s.action !== 'down' && view.doneOf(i.op) !== null;
  }).at(-1);
  if (last === undefined || passed(view, last)) return null;
  const s = last.expect.subject;
  return `environment ${name}'s last ${s.purpose === 'environment' ? s.action : 'use'} in this arc failed`;
}

// ---------------------------------------------------------------------------------------------------
// In-process state

type Slot = { chain: Promise<unknown>; users: number; lastUse: number };
const slots = new WeakMap<Journal, Map<ResourceName, Slot>>();

function slotOf(journal: Journal, name: ResourceName): Slot {
  let byName = slots.get(journal);
  if (byName === undefined) {
    byName = new Map();
    slots.set(journal, byName);
  }
  let slot = byName.get(name);
  if (slot === undefined) {
    slot = { chain: Promise.resolve(), users: 0, lastUse: Date.now() };
    byName.set(name, slot);
  }
  return slot;
}

/** Runs `step` after every transition queued on `name` before it; a failing step does not poison the chain. */
function serialised<T>(journal: Journal, name: ResourceName, step: () => Promise<T>): Promise<T> {
  const slot = slotOf(journal, name);
  const run = slot.chain.then(step);
  slot.chain = run.catch(() => undefined);
  return run;
}

function declared(plan: PlanM1, name: ResourceName): EnvironmentDecl {
  const decl = environmentOf(plan, name);
  if (decl === null) throw new Error(`environment ${name} is not declared in the plan of arc ${plan.arc}`);
  return decl;
}

// ---------------------------------------------------------------------------------------------------
// Commands

type CommandRun = Readonly<{ inv: InvocationId; pass: boolean; detail: string; evidence: readonly AbsPath[] }>;

async function runCommand(ctx: ResourceContext, name: ResourceName, action: EnvironmentAction, command: ToolCommand, parent: Parent): Promise<CommandRun> {
  const recipe = resolveCommand(ctx.repo, command, environmentOwnerLabel(ctx.plan().arc, name), {});
  const timeout = action === 'probe' ? ENV_PROBE_TIMEOUT_MS : ENV_LIFECYCLE_TIMEOUT_MS;
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(action === 'probe' ? `env-probe:${name}` : `env:${name}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + timeout)) },
    subject: { purpose: 'environment', environment: name, action },
    launch: () => ({
      argv: recipe.argv, cwd: recipe.cwd, env: recipe.env, stdinPath: null, stallMs: null, graceMs: GRACE_MS,
      terminal: { type: 'command', purpose: 'environment', expectedExit: 0 },
    }),
  });
  const dir = invocationDir(ctx.runDir, outcome.inv);
  const evidence = [absPath(join(dir, 'stdout')), absPath(join(dir, 'stderr'))];
  const { inv } = outcome;
  if (outcome.kind === 'lost') return { inv, pass: false, detail: `${action} ${inv} was lost with its runner`, evidence };
  const { result } = outcome;
  if (result.type !== 'command') throw new Error(`${inv}: an environment ${action} produced a ${result.type} result`);
  return { inv, pass: result.verdict === 'pass', detail: `${action} ${inv} ${result.verdict === 'pass' ? 'passed' : `exited ${result.exitCode ?? 'without a code'}`}`, evidence };
}

/**
 * Inside the chain: brings a managed environment down unless the log says it is down. A failed down leaves it unsettled
 * and raises one non-blocking `env-blocked` item, parented by the down's op: it may still be up, and costing.
 */
async function down(ctx: ResourceContext, decl: EnvironmentDecl, parent: Parent): Promise<CommandRun | null> {
  if (decl.lifecycle === null) return null;
  const state = environmentState(ctx.journal.view, decl.name);
  if (state === 'down') return null;
  if (state === 'starting' || state === 'stopping') throw new Error(`environment ${decl.name} is ${state} with no transition of this process in flight`);
  const ran = await runCommand(ctx, decl.name, 'down', decl.lifecycle.down, parent);
  if (!ran.pass) {
    const at: Parent = { type: 'op', op: parseInvocationId(ran.inv).op };
    if (raisedFor(ctx.journal.view, at) === null) {
      raiseNeedsUser(ctx.journal, ctx.runDir, {
        blocking: false, subject: { type: 'arc' }, reason: 'env-blocked',
        summary: `Environment ${decl.name}'s down failed (${ran.detail}); it may still be up, and costing. Its next use or the executor's next start brings it down again.`,
        recommendation: `Read the down's output, bring ${decl.name} down by hand if it is still up, then acknowledge this item.`,
        options: [], evidence: ran.evidence,
      }, at);
    }
  }
  return ran;
}

// ---------------------------------------------------------------------------------------------------
// Use

export type EnvironmentUse =
  | Readonly<{ kind: 'ready' }>
  /** It did not come up, or its probe failed; `detail` and `evidence` name the command that failed. */
  | Readonly<{ kind: 'unavailable'; environment: ResourceName; detail: string; evidence: readonly AbsPath[] }>;

/** Inside the chain: up when it is not, then the probe; a failure brings a managed environment down again. */
async function ensure(ctx: ResourceContext, name: ResourceName, parent: Parent): Promise<EnvironmentUse> {
  const decl = declared(ctx.plan(), name);
  const unavailable = async (failed: CommandRun): Promise<EnvironmentUse> => {
    const after = await down(ctx, decl, parent);
    const downed = after === null ? '' : `; brought down again (${after.detail})`;
    return { kind: 'unavailable', environment: name, detail: `${failed.detail}${downed}`, evidence: failed.evidence };
  };
  if (decl.lifecycle !== null && environmentState(ctx.journal.view, name) !== 'up') {
    // Unsettled (a failed or lost transition): down first, so the up starts from nothing.
    const settled = await down(ctx, decl, parent);
    if (settled !== null && !settled.pass) return { kind: 'unavailable', environment: name, detail: `${settled.detail} before its up`, evidence: settled.evidence };
    const up = await runCommand(ctx, name, 'up', decl.lifecycle.up, parent);
    if (!up.pass) return unavailable(up);
  }
  const probe = await runCommand(ctx, name, 'probe', decl.probe, parent);
  if (!probe.pass) return unavailable(probe);
  slotOf(ctx.journal, name).lastUse = Date.now();
  return { kind: 'ready' };
}

/**
 * A lane's use of environment `name`, whose unit its holder has reserved: queued behind any transition in flight (a start
 * waits for an in-flight stop), then up if it is not, then its probe. `ready` counts the lane as a user until
 * `releaseEnvironment`; `unavailable` holds nothing.
 */
export async function useEnvironment(ctx: ResourceContext, name: ResourceName, parent: Parent): Promise<EnvironmentUse> {
  const use = await serialised(ctx.journal, name, () => ensure(ctx, name, parent));
  if (use.kind === 'ready') slotOf(ctx.journal, name).users += 1;
  return use;
}

/** The end of a lane's use (after its cleanup): its idle clock starts now. */
export function releaseEnvironment(journal: Journal, name: ResourceName): void {
  const slot = slotOf(journal, name);
  if (slot.users === 0) throw new Error(`environment ${name} released with no user`);
  slot.users -= 1;
  slot.lastUse = Date.now();
}

/**
 * A retryable park's probe of environment `name` (src/park/probe.ts): up if it is not, then its probe, as a lane's use
 * would, without becoming a user. A pass leaves it up with a fresh idle clock, for the parked lane's re-run.
 */
export async function probeEnvironment(ctx: ResourceContext, name: ResourceName, parent: Parent): Promise<boolean> {
  return (await serialised(ctx.journal, name, () => ensure(ctx, name, parent))).kind === 'ready';
}

// ---------------------------------------------------------------------------------------------------
// Idle, ends and recovery

/**
 * The managed environments to bring down now: up (or unsettled), no lane of this process using them, `busy` false (no
 * lane holds or waits for their unit), and last used `idleMinutes` ago (`immediate`: under a pause of every unit or a
 * stop, at once).
 */
export function idleEnvironments(ctx: ResourceContext, now: number, busy: (name: ResourceName) => boolean, immediate: boolean): readonly ResourceName[] {
  const view = ctx.journal.view;
  return environmentsOf(ctx.plan()).flatMap((e) => {
    if (e.lifecycle === null) return [];
    const state = environmentState(view, e.name);
    if (state !== 'up') return [];
    const slot = slotOf(ctx.journal, e.name);
    if (slot.users > 0 || busy(e.name)) return [];
    return immediate || now - slot.lastUse >= e.lifecycle.idleMinutes * MINUTE_MS ? [e.name] : [];
  });
}

/**
 * Brings environment `name` down, queued behind any transition in flight; a no-op when it is already down or a lane of
 * this process uses it by then. A failed down leaves it unsettled (the next use or start brings it down first) and
 * answers false.
 */
export async function bringDown(ctx: ResourceContext, name: ResourceName, parent: Parent): Promise<boolean> {
  return serialised(ctx.journal, name, async () => {
    if (slotOf(ctx.journal, name).users > 0) return true;
    const ran = await down(ctx, declared(ctx.plan(), name), parent);
    return ran === null || ran.pass;
  });
}

/** Every declared environment the log does not say is down, brought down (a stop, the scheduler's end); a failed down raises its item. */
export async function downEnvironments(ctx: ResourceContext): Promise<void> {
  for (const e of environmentsOf(ctx.plan())) {
    if (e.lifecycle !== null && environmentState(ctx.journal.view, e.name) !== 'down') await bringDown(ctx, e.name, { type: 'arc' });
  }
}

/**
 * At the scheduler's start, after recovery closed every open spawn: an environment an interrupted up or down left
 * unsettled is brought down; one up resumes its idle clock from now (its slot is created here). A down that fails again
 * leaves it unsettled, and its next use brings it down first.
 */
export async function settleEnvironments(ctx: ResourceContext): Promise<void> {
  for (const e of environmentsOf(ctx.plan())) {
    if (e.lifecycle === null) continue;
    slotOf(ctx.journal, e.name);
    if (environmentState(ctx.journal.view, e.name) === 'unsettled') await bringDown(ctx, e.name, { type: 'arc' });
  }
}
