// The `command.apply` op (plan "File mutations", R10; DESIGN §2.3): one op per command, done only when its
// terminal receipt exists. `applied` names the op and the postconditions it verified; `accepted` (written
// at pickup, queue.ts) is never done.
//
//   intent{command, commandSha256} → effect → receipt → done{applied{receiptSha256} | rejected{reason}}
//
// Every effect checks its postcondition before acting, so running it again (recovery after a crash
// between the effect and the receipt) applies only what is missing:
//
//   pause    `paused{target}` fact: the durable marker the driver consults (it cancels the unit's live
//            invocation; step 13b). Applied immediately (control).
//   stop     `stop-requested` fact. Control.
//   ack      `needs-user/<id>.ack.json` (write-once, naming this command), then a `needs-user-acked` fact
//            the fold uses to tell open items from acknowledged ones. Rejected for an unknown id, an id
//            another command already acknowledged, or a choice the item does not offer. Control.
//   resume   unit | all: a `resumed` fact that clears the pause and the hold (the unit re-runs its stage
//            as a new, uncharged attempt). backend: that backend's smoke alone, then `resumed{backend}`,
//            which clears its arc-wide park; a failed smoke is rejected. Mutation (safe points only).
//            `resume <unit>` of a unit parked at a judgment stage (plan-check or gate) re-opens it once the
//            architect has edited its spec (`reopen`): the file must be at the unit's recorded spec rev + 1
//            (SCHEMAS.md "Architect spec edits"); the park's open needs-user is acknowledged by this
//            command, then a `reopened` fact sends the unit back to plan-check as a new attempt. A unit
//            parked `routing-changed` needs no spec edit (`reroute`): once the routing in force resolves
//            its implementer seat to the pinned `implementerSeatRev` (or no build has started), it is
//            re-pinned under that routing (a `dispatch` fact, when the rev differs), its needs-user is
//            acknowledged, and a `rerouted` fact re-enters it at the stage it parked at; otherwise it is
//            rejected. An unedited spec, or any other parked, stopped or merged unit, is rejected with the reason.
//   sweep    re-drives resources an earlier sweep left reserved or cleaning, then, per undispositioned
//            host residue (in recorded order): take the resource under the sweep holder (reserve when it is
//            free here; reclaim when it is this arc's own cleanup-failed resource) → the recorded teardown →
//            release and the residue's `cleaned` disposition. A failed teardown leaves the resource
//            cleaning under the sweep and the residue undisposed (a sweep records no failure), and the
//            receipt says so. A resource another holder has is left alone. Mutation.
//   `resume <unit>` while `pause --all` holds is rejected: only `resume` without a unit clears it.
//
// Control commands wait only for an open `integration.ff` (the publication critical section); mutations
// wait for a safe point: no open stage-level intent.
import type { IntentOf, OpOutcome, Parent, StageOutcomeFact } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { canonicalJson } from '../core/json.ts';
import { exclusiveCreate } from '../core/fsx.ts';
import { JUDGMENT_STAGES } from '../core/events.ts';
import { type CommandId, type NeedsUserId, type ResourceName, type UnitId, invocationId, opKey } from '../core/ids.ts';
import type { CommandBody, CommandFile, NeedsUserAck, ResidueKey, Stage } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type ResidueEntry, readResidues, recordDisposition, undispositioned } from '../host/residues.ts';
import { needsUserAckPath, raisedFor, readNeedsUser, readNeedsUserAck } from '../needsuser.ts';
import { dispatchOf, repin } from '../pipeline/dispatch.ts';
import { loadUnitSpec } from '../pipeline/stages.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { SpecFileError } from '../spec/spec.ts';
import { type SmokeRouting, smokeBackends, smokeRejections } from '../preflight/smoke.ts';
import type { ResidueRecipe } from '../recover/residue.ts';
import {
  type CleanupResult, type Reservation, type ResourceContext, type SweepHolder, cleanup, entryOf, finishCleanup, reclaimForSweep,
  reserveForSweep, resourceTable,
} from '../resources/reserve.ts';
import { isControl, readCommand, readReceipt, receiptSha256, writeReceipt } from './queue.ts';

/** Everything an effect may touch: the reservation cycle's context, plus what a backend smoke needs. */
export type CommandContext = ResourceContext & Readonly<{
  /** The backend workload environment (`backendEnv(process.env)`), for `resume --backend`'s smoke. */
  hostEnv: Readonly<Record<string, string>>;
  routing: SmokeRouting;
  /** The plan file's directory: unit spec paths are relative to it (a reopen reads the edited spec). */
  planDir: AbsPath;
}>;

export type CommandOutcome = OpOutcome['command.apply'];

/** What an effect established: the postconditions it verified, or why the command is refused. */
type Effect = Readonly<{ kind: 'applied'; verified: readonly string[] }> | Readonly<{ kind: 'rejected'; reason: string }>;

const keyOf = (id: CommandId) => opKey(`command:${id}`);
export const parentOf = (id: CommandId): Parent => ({ type: 'command', command: id });

/** The command's op, if one was begun. */
function opOf(ctx: CommandContext, id: CommandId): IntentOf<'command.apply'> | null {
  return ctx.journal.view.opsOf('command.apply').find((i) => i.expect.command === id) ?? null;
}

/**
 * Applies one command through its op. A command whose op is already done is a no-op returning the recorded
 * outcome (re-delivery is idempotent); an open one is recovery's (`commandReconciler`) and throws here.
 */
export async function applyCommand(ctx: CommandContext, command: CommandFile): Promise<CommandOutcome> {
  const existing = opOf(ctx, command.id);
  if (existing !== null) {
    const done = ctx.journal.view.doneOf(existing.op);
    if (done === null || done.kind !== 'command.apply') throw new Error(`command ${command.id}: its op ${existing.op} is still open; recovery applies it`);
    return done.outcome;
  }
  const { sha256 } = readCommand(ctx.runDir, command.id, ctx.journal.view.arc);
  const { op } = ctx.journal.begin({
    kind: 'command.apply',
    key: keyOf(command.id),
    parent: parentOf(command.id),
    deadlineAt: null,
    body: () => ({ expect: { command: command.id, commandSha256: sha256 }, post: null }),
  });
  crashPoint('command.apply.before-effect');
  const outcome = await finish(ctx, ctx.journal.view.latestIntent(op) as IntentOf<'command.apply'>, command);
  ctx.journal.done(op, 'command.apply', outcome, null);
  return outcome;
}

/**
 * Effect (only what is missing), then the terminal receipt; an existing terminal receipt decides alone.
 * The normal path and recovery (src/recover/command.ts) both end an op here.
 */
export async function finish(ctx: CommandContext, intent: IntentOf<'command.apply'>, command: CommandFile): Promise<CommandOutcome> {
  const id = command.id;
  const applied = readReceipt(ctx.runDir, id, 'applied');
  if (applied !== null) {
    if (applied.state !== 'applied' || applied.op !== intent.op) throw new Error(`command ${id}: its applied receipt names another op than ${intent.op}`);
    return { kind: 'applied', receiptSha256: receiptSha256(ctx.runDir, id, 'applied') };
  }
  const rejected = readReceipt(ctx.runDir, id, 'rejected');
  if (rejected !== null && rejected.state === 'rejected') return { kind: 'rejected', reason: rejected.reason };

  const effect = await effectOf(ctx, command);
  crashPoint('command.apply.after-effect');
  const at = isoTimeOf(new Date());
  if (effect.kind === 'rejected') {
    writeReceipt(ctx.runDir, { v: SCHEMA_VERSION, command: id, state: 'rejected', at, reason: effect.reason });
    return { kind: 'rejected', reason: effect.reason };
  }
  const sha = writeReceipt(ctx.runDir, { v: SCHEMA_VERSION, command: id, state: 'applied', at, op: intent.op, verified: effect.verified });
  crashPoint('command.apply.after-receipt');
  return { kind: 'applied', receiptSha256: sha };
}

async function effectOf(ctx: CommandContext, command: CommandFile): Promise<Effect> {
  const body: CommandBody = command.body;
  switch (body.type) {
    case 'pause':
      return pause(ctx, command.id, body.target);
    case 'stop': {
      if (ctx.journal.view.control().stop === null) ctx.journal.fact({ kind: 'stop-requested', command: command.id });
      return { kind: 'applied', verified: [`stop requested (by ${ctx.journal.view.control().stop})`] };
    }
    case 'ack':
      return ack(ctx, command.id, body);
    case 'resume':
      return resume(ctx, command.id, body.target);
    case 'sweep':
      return sweep(ctx, command.id, body.resource);
  }
}

function pause(ctx: CommandContext, id: CommandId, target: Extract<CommandBody, { type: 'pause' }>['target']): Effect {
  const view = ctx.journal.view;
  if (target.type === 'unit' && !ctx.plan.units.some((u) => u.id === target.unit)) return { kind: 'rejected', reason: `unknown unit ${target.unit}` };
  const c = view.control();
  const paused = c.pausedAll || (target.type === 'unit' && c.pausedUnits.includes(target.unit));
  if (!paused) ctx.journal.fact({ kind: 'paused', command: id, target });
  return { kind: 'applied', verified: [target.type === 'all' ? 'every unit paused' : `unit ${target.unit} paused`] };
}

function ack(ctx: CommandContext, id: CommandId, body: Extract<CommandBody, { type: 'ack' }>): Effect {
  const view = ctx.journal.view;
  const item = readNeedsUser(ctx.runDir, body.needsUser);
  if (item === null) return { kind: 'rejected', reason: `unknown needs-user ${body.needsUser}` };
  const by = ackedBy(ctx, body.needsUser);
  if (by !== null && by !== id) return { kind: 'rejected', reason: `needs-user ${body.needsUser} is already acknowledged by ${by}` };
  if (body.choice !== null && !item.options.some((o) => o.id === body.choice)) {
    return { kind: 'rejected', reason: `needs-user ${body.needsUser} offers no option ${body.choice} (options: ${item.options.map((o) => o.id).join(', ') || 'none'})` };
  }
  return { kind: 'applied', verified: acknowledge(ctx, id, body.needsUser, body.choice) };
}

/** The command that acknowledged `item` (its ack file or its fact), or null. */
function ackedBy(ctx: CommandContext, item: NeedsUserId): CommandId | null {
  return readNeedsUserAck(ctx.runDir, item)?.command ?? ctx.journal.view.ackOf(item)?.command ?? null;
}

/** The ack's effect, only what is missing: `<id>.ack.json` naming `id`, then the `needs-user-acked` fact. */
function acknowledge(ctx: CommandContext, id: CommandId, item: NeedsUserId, choice: string | null): readonly string[] {
  if (readNeedsUserAck(ctx.runDir, item) === null) {
    const record: NeedsUserAck = { v: SCHEMA_VERSION, id: item, command: id, choice, at: isoTimeOf(new Date()) };
    exclusiveCreate(needsUserAckPath(ctx.runDir, item), canonicalJson(record));
  }
  if (ctx.journal.view.ackOf(item) === null) ctx.journal.fact({ kind: 'needs-user-acked', id: item, command: id, choice });
  return [`needs-user/${item}.ack.json written by ${id}`, `needs-user ${item} acknowledged in the log`];
}

/**
 * `resume <unit>` of a parked unit: re-opened when it parked at a judgment stage and the architect has
 * edited its spec to the next revision; otherwise rejected, saying what would work.
 */
function reopen(ctx: CommandContext, id: CommandId, unitId: UnitId): Effect {
  const view = ctx.journal.view;
  const u = view.unit(unitId);
  const f = u.decided;
  const unit = ctx.plan.units.find((p) => p.id === unitId);
  if (f === null || unit === undefined) throw new Error(`reopen of ${unitId}: a parked unit without its decided outcome or plan unit`);
  const decided = decidedBy(f);
  const reason = decided.kind === 'park' ? decided.reason : f.outcome;
  const judgment = (JUDGMENT_STAGES as readonly Stage[]).includes(f.stage);
  if (!judgment) {
    return {
      kind: 'rejected',
      reason: `unit ${unitId} is parked (${reason}) at ${f.stage}, which is not re-openable in M1; re-enter it under a new unit id with a branch at the same tip`,
    };
  }
  let loaded;
  try {
    loaded = loadUnitSpec(ctx, unit);
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SpecFileError) return { kind: 'rejected', reason: `unit ${unitId}: its spec does not load: ${error.message}` };
    throw error;
  }
  const { spec, sha256, path } = loaded;
  const known = u.spec;
  if (known === null) throw new Error(`reopen of ${unitId}: parked at ${f.stage} without a recorded spec (no dispatch fact)`);
  if (spec.rev === known.rev && sha256 === known.sha256) {
    return { kind: 'rejected', reason: `unit ${unitId} is parked (${reason}); edit its spec ${path} (rev ${known.rev}), set rev ${known.rev + 1}, then resume` };
  }
  if (spec.rev === known.rev) {
    return {
      kind: 'rejected',
      reason: `unit ${unitId}: its spec ${path} changed but is still at rev ${known.rev}; an architect edit sets rev ${known.rev + 1} `
        + '(lane evidenceGlobs and evidenceExcludes may change in flight at the current rev, but do not revise the spec)',
    };
  }
  if (spec.rev !== known.rev + 1) {
    return { kind: 'rejected', reason: `unit ${unitId}: its spec ${path} is at rev ${spec.rev}, but the unit's recorded rev is ${known.rev}; an architect edit sets rev ${known.rev + 1}` };
  }
  const verified: string[] = [];
  const item = raisedFor(view, { type: 'stage', unit: unitId, stage: f.stage, attempt: f.attempt });
  if (item !== null) {
    const by = ackedBy(ctx, item);
    if (by === null || by === id) verified.push(...acknowledge(ctx, id, item, null));
  }
  ctx.journal.fact({ kind: 'reopened', unit: unitId, command: id, specRev: spec.rev, specSha256: sha256 });
  verified.push(`unit ${unitId} re-opened at plan-check on spec rev ${spec.rev}`);
  return { kind: 'applied', verified };
}

/**
 * `resume <unit>` of a unit parked `routing-changed`: re-pinned under the routing in force and re-entered at
 * the stage it parked at when that routing leaves its implementer seat as pinned (or no build has started);
 * otherwise rejected, saying what would work.
 */
function reroute(ctx: CommandContext, id: CommandId, unitId: UnitId, f: StageOutcomeFact): Effect {
  const pinned = dispatchOf(ctx.journal.view, unitId);
  const routing = ctx.routing.resolved;
  const verified: string[] = [];
  if (pinned.routingRev !== routing.rev) {
    if (repin(ctx.journal, routing, pinned) === null) {
      return {
        kind: 'rejected',
        reason: `unit ${unitId} is parked (routing-changed) at ${f.stage}: restore the routing of build.${pinned.riskFloor} or re-enter the unit under a new id`,
      };
    }
    verified.push(`unit ${unitId} re-pinned under routingRev ${routing.rev}`);
  }
  const item = raisedFor(ctx.journal.view, { type: 'stage', unit: unitId, stage: f.stage, attempt: f.attempt });
  if (item !== null) {
    const by = ackedBy(ctx, item);
    if (by === null || by === id) verified.push(...acknowledge(ctx, id, item, null));
  }
  ctx.journal.fact({ kind: 'rerouted', unit: unitId, command: id });
  verified.push(`unit ${unitId} re-entered at ${f.stage}`);
  return { kind: 'applied', verified };
}

async function resume(ctx: CommandContext, id: CommandId, target: Extract<CommandBody, { type: 'resume' }>['target']): Promise<Effect> {
  const view = ctx.journal.view;
  switch (target.type) {
    case 'unit': {
      if (!ctx.plan.units.some((u) => u.id === target.unit)) return { kind: 'rejected', reason: `unknown unit ${target.unit}` };
      if (view.control().pausedAll) return { kind: 'rejected', reason: 'the whole arc is paused; `resume` without a unit clears it' };
      const u = view.unit(target.unit);
      // Run again after a crash past the reopen: its fact is the postcondition.
      if (u.reopened?.command === id) return { kind: 'applied', verified: [`unit ${target.unit} re-opened at plan-check on spec rev ${u.reopened.specRev}`] };
      const paused = view.control().pausedUnits.includes(target.unit);
      if (!paused && u.status === 'park-pending') {
        return u.decided?.outcome === 'routing-changed' ? reroute(ctx, id, target.unit, u.decided) : reopen(ctx, id, target.unit);
      }
      if (!paused && u.status === 'stop-pending') return { kind: 'rejected', reason: `unit ${target.unit} stopped the arc; resume does not undo a stop` };
      if (!paused && u.status === 'retired') return { kind: 'rejected', reason: `unit ${target.unit} is merged` };
      if (paused || u.status === 'held') ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: [`unit ${target.unit} neither paused nor held`] };
    }
    case 'all': {
      const c = view.control();
      const done = !c.pausedAll && c.pausedUnits.length === 0 && ctx.plan.units.every((u) => view.unit(u.id).status !== 'held');
      if (!done) ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: ['no unit paused or held'] };
    }
    case 'backend': {
      if (view.parkedBackends().includes(target.backend)) {
        const report = await smokeBackends(ctx.routing, { journal: ctx.journal, runDir: ctx.runDir, hostEnv: ctx.hostEnv }, [target.backend]);
        const failures = smokeRejections(report);
        if (failures.length > 0) return { kind: 'rejected', reason: `smoke-failed: ${failures.map((f) => `${f.problem}: ${f.detail}`).join('; ')}` };
        ctx.journal.fact({ kind: 'resumed', command: id, target });
      }
      return { kind: 'applied', verified: [`backend ${target.backend} not parked`] };
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// sweep

const keyText = (k: ResidueKey): string => `${k.arc}/${k.unit}/${k.inv}/${k.resource}`;
const recipeOf = (r: ResidueEntry): ResidueRecipe => ({ teardown: r.teardown, label: r.label });

/** The latest teardown invocation of `resource` (the one a cleanup just ran). */
function lastTeardown(ctx: CommandContext, resource: ResourceName) {
  const intent = [...ctx.journal.view.opsOf('proc.spawn')].reverse().find((i) => i.expect.subject.purpose === 'teardown' && i.expect.subject.resource === resource);
  if (intent === undefined) throw new Error(`no teardown invocation of ${resource} after a sweep cleanup`);
  return invocationId(intent.op, intent.ordinal);
}

/**
 * The residue a sweep-held resource was being swept for: the first undisposed one of that resource (a
 * sweep takes residues in recorded order and stops a resource at its first failure), or, when every one is
 * disposed of already, the last recorded one (its teardown still releases the resource).
 */
function residueFor(hostResidues: readonly ResidueEntry[], open: readonly ResidueKey[], resource: ResourceName): ResidueEntry {
  const same = hostResidues.filter((r) => r.key.resource === resource);
  const pending = same.find((r) => open.some((k) => canonicalJson(k) === canonicalJson(r.key)));
  const chosen = pending ?? same[same.length - 1];
  if (chosen === undefined) throw new Error(`resource ${resource} is held by a sweep, but no host residue names it`);
  return chosen;
}

async function sweep(ctx: CommandContext, id: CommandId, only: ResourceName | null): Promise<Effect> {
  const parent = parentOf(id);
  const holder: SweepHolder = { type: 'sweep', command: id };
  const verified: string[] = [];
  const hostResidues = (): ResidueEntry[] => readResidues(ctx.hostDir).flatMap((l) => (l.type === 'residue' ? [l as ResidueEntry] : []));
  const wanted = (resource: ResourceName): boolean => only === null || resource === only;

  const settle = async (r: ResidueEntry, result: CleanupResult<SweepHolder>): Promise<void> => {
    if (result.kind === 'released') {
      recordDisposition(ctx.hostDir, { type: 'disposition', key: r.key, disposition: 'cleaned', by: { arc: ctx.journal.view.arc, inv: lastTeardown(ctx, r.key.resource) } });
      verified.push(`residue ${keyText(r.key)}: cleaned`);
    } else {
      verified.push(`residue ${keyText(r.key)}: teardown failed, left undisposed; ${r.key.resource} stays cleaning under the sweep`);
    }
  };

  // 1. Resources a sweep (this one after a crash, or an earlier one whose teardown failed) left behind.
  for (const [resource, entry] of resourceTable(ctx.journal.view)) {
    const { status } = entry;
    if (!wanted(resource) || entry.pending !== null || status.state === 'free' || status.state === 'cleanup-failed' || status.holder.type !== 'sweep') continue;
    if (status.state === 'running') throw new Error(`resource ${resource} is running under sweep ${status.holder.command}; a sweep never runs a workload`);
    const r = residueFor(hostResidues(), undispositioned(ctx.hostDir), resource);
    const recipes = new Map([[resource, recipeOf(r)]]);
    const held = { holder: status.holder, resources: [resource], recipes } as const;
    const result = status.state === 'reserved'
      ? await cleanup(ctx, { ...held, state: 'reserved' } as Reservation<'reserved', SweepHolder>, parent)
      : await finishCleanup(ctx, { ...held, state: 'cleaning' } as Reservation<'cleaning', SweepHolder>, parent);
    if (undispositioned(ctx.hostDir).some((k) => canonicalJson(k) === canonicalJson(r.key))) await settle(r, result);
    else if (result.kind === 'released') verified.push(`${resource} released by the sweep that held it`);
  }

  // 2. Every residue still undisposed, one at a time: at most one sweep reservation per resource name.
  for (const key of undispositioned(ctx.hostDir)) {
    if (!wanted(key.resource)) continue;
    const r = hostResidues().find((x) => canonicalJson(x.key) === canonicalJson(key));
    if (r === undefined) throw new Error(`undispositioned residue ${keyText(key)} has no residue record`);
    const recipes = new Map([[key.resource, recipeOf(r)]]);
    const { status } = entryOf(resourceTable(ctx.journal.view), key.resource);
    // A residue of this arc: its resource is cleanup-failed here, and only the sweep takes it back.
    if (key.arc === ctx.journal.view.arc && status.state === 'cleanup-failed') {
      await settle(r, await finishCleanup(ctx, reclaimForSweep(ctx, holder, recipes, parent), parent));
      continue;
    }
    const reserved = reserveForSweep(ctx, holder, recipes, parent);
    if (reserved.state === 'refused') {
      verified.push(`residue ${keyText(key)}: ${key.resource} is held, left undisposed`);
      continue;
    }
    await settle(r, await cleanup(ctx, reserved, parent));
  }
  if (verified.length === 0) verified.push(only === null ? 'no undispositioned residue' : `no undispositioned residue of ${only}`);
  return { kind: 'applied', verified };
}

// ---------------------------------------------------------------------------------------------------
// When commands apply

export type ControlResult = Readonly<{ kind: 'applied'; outcomes: readonly Readonly<{ command: CommandId; outcome: CommandOutcome }>[] }>
  | Readonly<{ kind: 'deferred'; reason: string }>;

async function applyAll(ctx: CommandContext, commands: readonly CommandFile[]): Promise<ControlResult> {
  const outcomes = [];
  for (const command of commands) outcomes.push({ command: command.id, outcome: await applyCommand(ctx, command) });
  return { kind: 'applied', outcomes };
}

/** Control commands, immediately, in id order; deferred only while an `integration.ff` is open. */
export function applyControl(ctx: CommandContext, pending: readonly CommandFile[]): Promise<ControlResult> {
  const ff = ctx.journal.view.openIntents().find((i) => i.kind === 'integration.ff');
  if (ff !== undefined) return Promise.resolve({ kind: 'deferred', reason: `integration.ff ${ff.op} is in its critical section` });
  return applyAll(ctx, pending.filter((c) => isControl(c.body)));
}

/** Mutations, in id order, only at a safe point: no open stage-level intent. The driver calls it between stages. */
export function applyAtSafePoint(ctx: CommandContext, pending: readonly CommandFile[]): Promise<ControlResult> {
  const busy = ctx.journal.view.openIntents().find((i) => i.parent.type === 'stage');
  if (busy !== undefined) return Promise.resolve({ kind: 'deferred', reason: `${busy.kind} ${busy.op} of a stage is open` });
  return applyAll(ctx, pending.filter((c) => !isControl(c.body)));
}
