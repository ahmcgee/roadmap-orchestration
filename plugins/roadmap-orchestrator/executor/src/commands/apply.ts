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
//            as a new, uncharged attempt). backend: that backend's smoke alone through the prober
//            (`resumeBackend`, one job per target), then `resumed{backend}`, which clears its park, whatever
//            its class; a failed smoke is rejected (`smoke-failed: …`). Mutation (scope: all →
//            the arc, a unit → that unit, a backend → none; src/input/classify.ts `commandScope`).
//            `resume <unit>` of a parked unit, per the park's class (A7):
//              retryable       probe now: the prober runs each outstanding target once, covering this park,
//                              and its `probe` facts recover the unit when every target has passed (the fold
//                              restores the parked stage); a target that fails keeps the park, rejected
//                              with the target, and probing goes on on its schedule.
//              operator env    re-run the parked stage: the park's open needs-user is acknowledged by this
//                              command, then an `unparked` fact. A unit parked `routing-changed` (`reroute`)
//                              first needs the routing in force to resolve its implementer seat to the pinned
//                              `implementerSeatRev` (or no build started): it is re-pinned under that routing
//                              (a `dispatch` fact, when the rev differs); otherwise it is rejected.
//              operator design re-open on an applied revision (`reopen`), only at a judgment stage (plan-check
//                              or gate): an `apply` holds the unit's recorded spec rev + 1 pending (SCHEMAS.md
//                              "Plan in force"); the park's needs-user is acknowledged, then a `reopened` fact
//                              sends the unit back to plan-check as a new attempt. Without a revision, or at
//                              any other stage, rejected: apply a revision, or re-enter the unit.
//            A stopped or merged unit is rejected with the reason. A unit both paused and parked: one resume
//            clears the pause and re-opens (or re-runs) it; when the park stays, the pause alone is cleared
//            and the receipt says why it stays parked.
//   sweep    re-drives resources an earlier sweep left reserved or cleaning, then, per undispositioned
//            host residue (in recorded order): take the resource under the sweep holder (reserve when it is
//            free here; reclaim when it is this arc's own cleanup-failed resource) → the recorded teardown →
//            release and the residue's `cleaned` disposition. A failed teardown leaves the resource
//            cleaning under the sweep and the residue undisposed (a sweep records no failure), and the
//            receipt says so. A resource another holder has is left alone. Mutation.
//   apply    the plan and specs the manifest hashes become the plan in force (`applyPlan`): the files are
//            re-read and must still hash to the manifest, `expectRev` must be the revision in force, every
//            change is classified (src/input/classify.ts), the startup rows re-run over the changed units,
//            and a backend the new routing needs that the old did not passes its smoke; after those
//            asynchronous parts the classification runs again, synchronously, just before the commit (A12),
//            and must find the same changes; then the bytes are kept and a `plan-applied` fact written, the
//            postcondition. All or nothing: a rejection lists every reason. `reenters` and `cut` are its edit
//            classes (D3). Mutation.
//   resolve-edge, run-only: facts about the graph (src/commands/graph.ts). Mutations with an empty scope.
//   rule, reverse, steer, merge-in, audit, close-admissions (M3): frozen in step 0a; until the step named in
//            `NOT_YET` implements each, it is rejected `not implemented (step X)` (BACKLOG "Scaffolding to delete").
//   `resume <unit>` while `pause --all` holds is rejected: only `resume` without a unit clears it.
//
// Control commands wait only for an open `integration.ff` (the publication critical section); mutations
// wait for their scope to drain (the scheduler, A12; src/schedule/scheduler.ts). A stop cancels a mutation's
// smoke: the run's stop signal ends the effect before its receipt, and the next start's recovery applies the
// command from its open op (src/recover/command.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntentOf, OpOutcome, Parent, PlanChange, StageOutcomeFact } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { canonicalJson } from '../core/json.ts';
import { exclusivePublish } from '../core/fsx.ts';
import { JUDGMENT_STAGES, probeTargetKey } from '../core/events.ts';
import {
  type CommandId, type NeedsUserId, type PlanRev, type ResourceInstance, type ResourceName, type UnitId, invocationId, opKey, parseResourceUnit,
  resourceInstance,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { CommandBody, CommandFile, NeedsUserAck, PlanManifest, ResidueKey, Stage } from '../core/records.ts';
import type { ParkState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { SpecFileError, parseSpec } from '../spec/spec.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type ResidueEntry, readResidues, recordDisposition, undispositioned } from '../host/residues.ts';
import { classify } from '../input/classify.ts';
import { type InputFiles, manifestOf, planInForce, readInputFiles, recordPlan, requirePlanInForce } from '../input/inforce.ts';
import type { PlanM1 } from '../input/plan.ts';
import { needsUserAckPath, raisedFor, readNeedsUser, readNeedsUserAck } from '../needsuser.ts';
import { dispatchOf, repin } from '../pipeline/dispatch.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { applyRows } from '../preflight/checks.ts';
import { type SmokeRouting, backendsOf, smokeBackends, smokeRejections } from '../preflight/smoke.ts';
import type { StartupContext, StartupRejection } from '../preflight/startup.ts';
import type { ResidueRecipe } from '../recover/residue.ts';
import {
  type CleanupResult, type Reservation, type ResourceContext, type SweepHolder, cleanup, entryOf, finishCleanup, reclaimForSweep,
  reserveForSweep, resourceTable,
} from '../resources/reserve.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import type { Backend, ProfileName } from '../routing/types.ts';
import type { ProberHandle } from '../park/probe.ts';
import { resolveEdge, runOnly } from './graph.ts';
import { isControl, readCommand, readReceipt, receiptSha256, writeReceipt } from './queue.ts';

/**
 * Everything an effect may touch: the reservation cycle's context, plus what a backend smoke and an apply
 * need. `plan()` and `routing()` are the plan in force and its routing, read at each call.
 */
export type CommandContext = ResourceContext & Readonly<{
  /** The backend workload environment (`backendEnv(process.env)`), for the smokes of `resume --backend` and `apply`. */
  hostEnv: Readonly<Record<string, string>>;
  /** The executor's own environment: an apply's lane rows resolve against it. */
  laneEnv: Readonly<Record<string, string | undefined>>;
  routing: () => SmokeRouting;
  /** The routing of a plan under the arc's profile and repo config. */
  resolve: (plan: PlanM1) => ResolvedRouting;
  /** The plan file `apply` re-reads, and its directory (unit spec paths are relative to it). */
  planFile: AbsPath;
  planDir: AbsPath;
  /**
   * The prober (src/park/probe.ts), through which `resume <unit>` of a retryable park probes and `resume
   * --backend` smokes, and the run's stop signal, which ends an effect cut short by a stop before its receipt.
   */
  probes: Readonly<{ prober: ProberHandle; signal: AbortSignal }>;
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
    case 'resolve-edge':
      return resolveEdge(ctx, command.id, body.edge, body.evidence);
    case 'run-only':
      return runOnly(ctx, command.id, body.units);
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
    case 'apply':
      return applyPlan(ctx, command.id, body);
    case 'rule':
    case 'reverse':
    case 'steer':
    case 'merge-in':
    case 'audit':
    case 'close-admissions':
      return { kind: 'rejected', reason: `${body.type}: not implemented (step ${NOT_YET[body.type]})` };
  }
}

/** Interim (M3 0a): the step that implements each M3 command's effect (src/commands/{rule,reverse,steer,mergein,audit,admissions}.ts). */
const NOT_YET = { rule: 'A4', reverse: 'A2', steer: 'A3', 'merge-in': 'A3', audit: 'B7', 'close-admissions': 'B7' } as const satisfies
  Readonly<Record<'rule' | 'reverse' | 'steer' | 'merge-in' | 'audit' | 'close-admissions', string>>;

function pause(ctx: CommandContext, id: CommandId, target: Extract<CommandBody, { type: 'pause' }>['target']): Effect {
  const view = ctx.journal.view;
  if (target.type === 'unit' && !ctx.plan().units.some((u) => u.id === target.unit)) return { kind: 'rejected', reason: `unknown unit ${target.unit}` };
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
    exclusivePublish(needsUserAckPath(ctx.runDir, item), canonicalJson(record));
  }
  if (ctx.journal.view.ackOf(item) === null) ctx.journal.fact({ kind: 'needs-user-acked', id: item, command: id, choice });
  return [`needs-user/${item}.ack.json written by ${id}`, `needs-user ${item} acknowledged in the log`];
}

/** The rev of the spec file at `path` as it is now, for a rejection's advice; null when it does not load. */
function fileRev(path: AbsPath): number | null {
  if (!existsSync(path)) return null;
  try {
    return parseSpec(readFileSync(path), path).rev;
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SpecFileError) return null;
    throw error;
  }
}

/** Why a parked unit parked: its park's needs-user reason, or the outcome. */
function parkReason(f: StageOutcomeFact): string {
  const decided = decidedBy(f);
  return decided.kind === 'park' ? decided.reason : f.outcome;
}

/** The park's open needs-user, acknowledged by this command (unless another already did). */
function acknowledgePark(ctx: CommandContext, id: CommandId, unitId: UnitId, f: StageOutcomeFact): readonly string[] {
  const item = raisedFor(ctx.journal.view, { type: 'stage', unit: unitId, stage: f.stage, attempt: f.attempt });
  if (item === null) return [];
  const by = ackedBy(ctx, item);
  return by === null || by === id ? acknowledge(ctx, id, item, null) : [];
}

/**
 * `resume <unit>` of a design park: re-opened when it parked at a judgment stage and the architect has
 * applied a revision of its spec (pending in the fold); otherwise rejected, saying what would work.
 */
function reopen(ctx: CommandContext, id: CommandId, unitId: UnitId, f: StageOutcomeFact): Effect {
  const u = ctx.journal.view.unit(unitId);
  const unit = ctx.plan().units.find((p) => p.id === unitId);
  if (unit === undefined) throw new Error(`reopen of ${unitId}: a parked unit the plan in force does not list`);
  const reason = parkReason(f);
  if (!(JUDGMENT_STAGES as readonly Stage[]).includes(f.stage)) {
    return {
      kind: 'rejected',
      reason: `unit ${unitId} is parked (${reason}) at ${f.stage}, a design park no revision re-opens there; re-enter it: a new unit with \`reenters: {unit: ${unitId}}\`, then \`roadmap apply\``,
    };
  }
  const known = u.spec;
  if (known === null) throw new Error(`reopen of ${unitId}: parked at ${f.stage} without a recorded spec (no dispatch fact)`);
  const revision = u.pendingRevision;
  if (revision === null) {
    const path = absPath(join(ctx.planDir, unit.spec));
    return {
      kind: 'rejected',
      reason: fileRev(path) === known.rev + 1
        ? `unit ${unitId} is parked (${reason}); its spec ${path} is at rev ${known.rev + 1} but not applied: run \`roadmap apply\`, then resume`
        : `unit ${unitId} is parked (${reason}); edit its spec ${path} (rev ${known.rev}), set rev ${known.rev + 1}, run \`roadmap apply\`, then resume`,
    };
  }
  const verified = [...acknowledgePark(ctx, id, unitId, f)];
  ctx.journal.fact({ kind: 'reopened', unit: unitId, command: id, specRev: revision.rev, specSha256: revision.sha256 });
  verified.push(`unit ${unitId} re-opened at plan-check on spec rev ${revision.rev}`);
  return { kind: 'applied', verified };
}

/**
 * `resume <unit>` of an env park: the parked stage re-runs (`unparked`). One parked `routing-changed` is first
 * re-pinned under the routing in force, which must leave its implementer seat as pinned (or no build started);
 * otherwise rejected, saying what would work.
 */
function unpark(ctx: CommandContext, id: CommandId, unitId: UnitId, f: StageOutcomeFact): Effect {
  const verified: string[] = [];
  if (f.outcome === 'routing-changed') {
    const pinned = dispatchOf(ctx.journal.view, unitId);
    const routing = ctx.routing().resolved;
    if (pinned.routingRev !== routing.rev) {
      if (repin(ctx.journal, routing, pinned) === null) {
        return {
          kind: 'rejected',
          reason: `unit ${unitId} is parked (routing-changed) at ${f.stage}: restore the routing of build.${pinned.riskFloor} or re-enter the unit under a new id`,
        };
      }
      verified.push(`unit ${unitId} re-pinned under routingRev ${routing.rev}`);
    }
  }
  verified.push(...acknowledgePark(ctx, id, unitId, f));
  ctx.journal.fact({ kind: 'unparked', unit: unitId, command: id });
  verified.push(`unit ${unitId} re-entered at ${f.stage}`);
  return { kind: 'applied', verified };
}

/**
 * `resume <unit>` of a retryable park: each outstanding target probed now, covering this park. The probes'
 * facts recover it when every target has passed; a failing target keeps it, and probing goes on.
 */
async function probeNow(ctx: CommandContext, unitId: UnitId, f: StageOutcomeFact, park: ParkState): Promise<Effect> {
  if (park.park.class !== 'retryable') throw new Error(`probeNow of unit ${unitId}, whose park is ${park.park.class}`);
  const { prober, signal } = ctx.probes;
  const passed = new Set(park.passed.map(probeTargetKey));
  const failed: string[] = [];
  for (const target of park.park.targets.filter((t) => !passed.has(probeTargetKey(t)))) {
    if (await prober.run({ target, covers: [park.seq] }, signal) === 'fail') failed.push(probeTargetKey(target));
  }
  const after = ctx.journal.view.unit(unitId);
  if (failed.length === 0) {
    if (after.status === 'park-pending') throw new Error(`unit ${unitId}: every target of its park at seq ${park.seq} passed, but the fold did not recover it`);
    return { kind: 'applied', verified: [`unit ${unitId} recovered: every target of its park passed; it re-runs ${f.stage}`] };
  }
  return { kind: 'rejected', reason: `unit ${unitId} is parked (${parkReason(f)}) at ${f.stage}, retryable: ${failed.join(', ')} still failing; probing goes on` };
}

/** `resume <unit>` of a parked unit, per its park's class (A7). */
async function resumeParked(ctx: CommandContext, id: CommandId, unitId: UnitId): Promise<Effect> {
  const u = ctx.journal.view.unit(unitId);
  const f = u.decided;
  if (f === null || u.park === null) throw new Error(`resume of ${unitId}: a parked unit without its decided outcome or its park`);
  if (u.park.park.class === 'retryable') return probeNow(ctx, unitId, f, u.park);
  return u.park.park.kind === 'env' ? unpark(ctx, id, unitId, f) : reopen(ctx, id, unitId, f);
}

async function resume(ctx: CommandContext, id: CommandId, target: Extract<CommandBody, { type: 'resume' }>['target']): Promise<Effect> {
  const view = ctx.journal.view;
  switch (target.type) {
    case 'unit': {
      if (!ctx.plan().units.some((u) => u.id === target.unit)) return { kind: 'rejected', reason: `unknown unit ${target.unit}` };
      if (view.control().pausedAll) return { kind: 'rejected', reason: 'the whole arc is paused; `resume` without a unit clears it' };
      const u = view.unit(target.unit);
      const paused = view.control().pausedUnits.includes(target.unit);
      // A unit both paused and parked: one resume re-opens (or re-runs) it and clears the pause. The park's
      // fact goes first; a re-run after a crash between the two finds it and clears the pause alone.
      const unpause = (): readonly string[] => {
        if (!paused) return [];
        ctx.journal.fact({ kind: 'resumed', command: id, target });
        return [`unit ${target.unit} unpaused`];
      };
      // Run again after a crash past the reopen: its fact is the postcondition.
      if (u.reopened?.command === id) {
        return { kind: 'applied', verified: [`unit ${target.unit} re-opened at plan-check on spec rev ${u.reopened.specRev}`, ...unpause()] };
      }
      if (u.status === 'park-pending') {
        const parked = await resumeParked(ctx, id, target.unit);
        if (parked.kind === 'applied') return { kind: 'applied', verified: [...parked.verified, ...unpause()] };
        if (!paused) return parked;
        // Paused and parked, not re-openable yet: the pause is cleared, the park stays.
        return { kind: 'applied', verified: [...unpause(), `unit ${target.unit} still parked: ${parked.reason}`] };
      }
      if (!paused && u.status === 'stop-pending') return { kind: 'rejected', reason: `unit ${target.unit} stopped the arc; resume does not undo a stop` };
      if (!paused && u.status === 'retired') return { kind: 'rejected', reason: `unit ${target.unit} is merged` };
      if (!paused && u.status === 'cut') return { kind: 'rejected', reason: `unit ${target.unit} is cut` };
      if (!paused && u.status === 'superseded') return { kind: 'rejected', reason: `unit ${target.unit} is superseded by ${u.supersededBy}; resume that unit` };
      if (paused || u.status === 'held') ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: [`unit ${target.unit} neither paused nor held`] };
    }
    case 'all': {
      const c = view.control();
      const done = !c.pausedAll && c.pausedUnits.length === 0 && ctx.plan().units.every((u) => view.unit(u.id).status !== 'held');
      if (!done) ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: ['no unit paused or held'] };
    }
    case 'backend': {
      const resumed = await ctx.probes.prober.resumeBackend(target.backend, id, ctx.probes.signal);
      switch (resumed.kind) {
        case 'smoke-failed':
          return { kind: 'rejected', reason: `smoke-failed: ${resumed.detail}` };
        case 'resumed':
          return { kind: 'applied', verified: [`backend ${target.backend} resumed: its smoke passed`] };
        case 'not-parked':
          return { kind: 'applied', verified: [`backend ${target.backend} not parked`] };
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// sweep

const keyText = (k: ResidueKey): string => `${k.arc}/${k.unit}/${k.inv}/${k.resource}`;
const recipeOf = (r: ResidueEntry): ResidueRecipe => ({ teardown: r.teardown, label: r.label });

/** The latest teardown invocation of `resource` (the one a cleanup just ran). */
function lastTeardown(ctx: CommandContext, resource: ResourceInstance) {
  const intent = [...ctx.journal.view.opsOf('proc.spawn')].reverse().find((i) => i.expect.subject.purpose === 'teardown' && i.expect.subject.resource === resource);
  if (intent === undefined) throw new Error(`no teardown invocation of ${resource} after a sweep cleanup`);
  return invocationId(intent.op, intent.ordinal);
}

/**
 * The residue a sweep-held resource was being swept for: the first undisposed one of that resource (a
 * sweep takes residues in recorded order and stops a resource at its first failure), or, when every one is
 * disposed of already, the last recorded one (its teardown still releases the resource).
 */
function residueFor(hostResidues: readonly ResidueEntry[], open: readonly ResidueKey[], resource: ResourceInstance): ResidueEntry {
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
  // `--resource <name>`: that named resource, or every instance of that pool.
  const wanted = (resource: ResourceInstance): boolean => {
    if (only === null || resource === only) return true;
    const p = parseResourceUnit(resource);
    return p.type === 'instance' && p.pool === only;
  };

  const settle = async (r: ResidueEntry, result: CleanupResult<SweepHolder>): Promise<void> => {
    if (result.kind === 'released') {
      recordDisposition(ctx.hostDir, { type: 'disposition', key: r.key, disposition: 'cleaned', by: { arc: ctx.journal.view.arc, inv: lastTeardown(ctx, r.key.resource) } });
      verified.push(`residue ${keyText(r.key)}: cleaned`);
    } else {
      verified.push(`residue ${keyText(r.key)}: teardown failed, left undisposed; ${r.key.resource} stays cleaning under the sweep`);
    }
  };

  // 1. Resources a sweep (this one after a crash, or an earlier one whose teardown failed) left behind.
  for (const [unit, entry] of resourceTable(ctx.journal.view)) {
    const { status } = entry;
    if (entry.pending !== null || status.state === 'free' || status.state === 'cleanup-failed' || status.holder.type !== 'sweep') continue;
    // A sweep holds only what a residue names: a named resource or a pool instance, never an `@cpu` token.
    const resource = resourceInstance(unit, `the unit ${unit} a sweep holds`);
    if (!wanted(resource)) continue;
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
    const resource = key.resource;
    if (!wanted(resource)) continue;
    const r = hostResidues().find((x) => canonicalJson(x.key) === canonicalJson(key));
    if (r === undefined) throw new Error(`undispositioned residue ${keyText(key)} has no residue record`);
    const recipes = new Map([[resource, recipeOf(r)]]);
    const { status } = entryOf(resourceTable(ctx.journal.view), resource);
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
// apply

/** What an apply needs to evaluate the files, in the executor or read-only (`apply --dry-run`). */
export type ApplyInput = Readonly<{
  runDir: AbsPath;
  view: JournalView;
  hostDir: AbsPath;
  repo: AbsPath;
  planFile: AbsPath;
  profile: ProfileName;
  resolve: (plan: PlanM1) => ResolvedRouting;
  laneEnv: Readonly<Record<string, string | undefined>>;
  /** The manifest the command carries (null for a dry run, which hashes the files itself), and its expectRev. */
  manifest: PlanManifest | null;
  expectRev: PlanRev | null;
}>;

export type ApplyVerdict =
  | Readonly<{ kind: 'rejected'; reasons: readonly string[] }>
  | Readonly<{ kind: 'unchanged'; rev: PlanRev }>
  /** `smoke`: backends the new routing seats that the routing in force did not; they must pass a smoke first. */
  | Readonly<{ kind: 'accepted'; rev: PlanRev; files: InputFiles; changes: readonly PlanChange[]; smoke: readonly Backend[]; routing: ResolvedRouting | null }>;

/** One rejection per line of text, for a receipt's reason and the dry run. */
const rowText = (r: StartupRejection): string => canonicalJson(r);

/**
 * Evaluates an apply without effect: the expected revision, the files against the manifest, the classifier,
 * then the startup rows over the changed units. Every reason found at a step is reported together.
 */
export async function evaluateApply(input: ApplyInput): Promise<ApplyVerdict> {
  const inForce = planInForce(input.runDir, input.view);
  if (inForce === null) {
    return { kind: 'rejected', reasons: [`arc ${input.view.arc} records no plan in force yet (started before plan revisions); its next start records plan.json as revision 1`] };
  }
  if (input.expectRev !== null && input.expectRev !== inForce.rev) {
    return { kind: 'rejected', reasons: [`stale: --expect-rev ${input.expectRev}, but the plan in force is rev ${inForce.rev}`] };
  }
  let files: InputFiles;
  try {
    files = readInputFiles(input.planFile);
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    return { kind: 'rejected', reasons: [`${input.planFile} does not load: ${error.message}`] };
  }
  const manifest = manifestOf(files);
  if ('missing' in manifest) return { kind: 'rejected', reasons: manifest.missing.map((u) => `unit ${u}: its spec ${files.specs.get(u)?.path} does not exist`) };
  if (input.manifest !== null && canonicalJson(input.manifest) !== canonicalJson(manifest)) {
    return { kind: 'rejected', reasons: [manifestMismatch(input.planFile, input.manifest, manifest, files)] };
  }
  const verdict = classify({ runDir: input.runDir, view: input.view, inForce, next: files, residues: undispositioned(input.hostDir), resolve: input.resolve });
  if (verdict.kind !== 'accepted') return verdict.kind === 'unchanged' ? { kind: 'unchanged', rev: inForce.rev } : verdict;
  const context: StartupContext = {
    repo: input.repo, planFile: input.planFile, plan: files.plan, specOf: (u) => files.specs.get(u.id)?.bytes ?? null, profile: input.profile,
    runDir: input.runDir, hostDir: input.hostDir,
  };
  const rows = await applyRows(context, verdict.scoped, verdict.routing !== null, input.laneEnv);
  if (rows.length > 0) return { kind: 'rejected', reasons: rows.map(rowText) };
  const before = backendsOf(input.resolve(inForce.plan));
  const smoke = verdict.routing === null ? [] : backendsOf(verdict.routing).filter((b) => !before.includes(b));
  return { kind: 'accepted', rev: inForce.rev, files, changes: verdict.changes, smoke, routing: verdict.routing };
}

/** Which files no longer hash to what the command's manifest recorded. */
function manifestMismatch(planFile: AbsPath, expected: PlanManifest, actual: PlanManifest, files: InputFiles): string {
  const differ: string[] = [];
  if (expected.planSha256 !== actual.planSha256) differ.push(planFile);
  const units = new Set([...Object.keys(expected.specs), ...Object.keys(actual.specs)] as UnitId[]);
  for (const u of [...units].sort()) {
    if (expected.specs[u] !== actual.specs[u]) differ.push(files.specs.get(u)?.path ?? `the spec of ${u} (no longer in the plan)`);
  }
  return `the files changed since \`roadmap apply\` hashed them: ${differ.join(', ')}; run it again`;
}

/** The manifest's plan and specs, verified, classified and smoked, then in force: `plan-applied` is the postcondition. */
async function applyPlan(ctx: CommandContext, id: CommandId, body: Extract<CommandBody, { type: 'apply' }>): Promise<Effect> {
  // Run again after a crash past the fact: it is the postcondition.
  const done = ctx.journal.view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: appliedText(done.rev, done.changes) };
  // Its content in force already, put there by another (a start after a crash that cut this apply short
  // between keeping the bytes and its fact reads the same files): applied, whatever revision it expected.
  const inForce = ctx.journal.view.planApplied();
  if (inForce !== null && canonicalJson({ planSha256: inForce.planSha256, specs: inForce.specs }) === canonicalJson(body.manifest)) {
    return { kind: 'applied', verified: [`the files are the plan in force already (rev ${inForce.rev}): nothing to apply`] };
  }
  const verdict = await evaluateApply({
    runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, repo: ctx.repo, planFile: ctx.planFile, profile: ctx.routing().profile,
    resolve: ctx.resolve, laneEnv: ctx.laneEnv, manifest: body.manifest, expectRev: body.expectRev,
  });
  switch (verdict.kind) {
    case 'rejected':
      return { kind: 'rejected', reason: rejectedText(verdict.reasons) };
    case 'unchanged':
      return { kind: 'applied', verified: [`the files are the plan in force (rev ${verdict.rev}): nothing to apply`] };
    case 'accepted': {
      if (verdict.smoke.length > 0 && verdict.routing !== null) {
        const report = await smokeBackends({ profile: ctx.routing().profile, resolved: verdict.routing }, { journal: ctx.journal, runDir: ctx.runDir, hostEnv: ctx.hostEnv }, verdict.smoke);
        // A stop killed the smoke: no verdict on the apply, whose op the next start's recovery finishes.
        ctx.probes.signal.throwIfAborted();
        const failures = smokeRejections(report);
        if (failures.length > 0) return { kind: 'rejected', reason: rejectedText(failures.map(rowText)) };
      }
      const moved = revalidate(ctx, verdict);
      if (moved !== null) return { kind: 'rejected', reason: rejectedText(moved) };
      const fact = recordPlan(ctx.journal, ctx.runDir, verdict.files, id, verdict.changes);
      return { kind: 'applied', verified: appliedText(fact.rev, fact.changes) };
    }
  }
}

/**
 * A12: the classification again, synchronously and with nothing awaited before the commit that follows, over
 * the same files against the log as it is now (the startup rows and the smoke awaited; other work went on).
 * Why the apply may no longer commit, or null when it classifies to the same changes.
 */
function revalidate(ctx: CommandContext, verdict: Extract<ApplyVerdict, { kind: 'accepted' }>): readonly string[] | null {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  if (inForce.rev !== verdict.rev) return [`stale: the plan in force moved to rev ${inForce.rev} while this apply was evaluated against rev ${verdict.rev}; run it again`];
  const again = classify({ runDir: ctx.runDir, view, inForce, next: verdict.files, residues: undispositioned(ctx.hostDir), resolve: ctx.resolve });
  if (again.kind === 'rejected') return again.reasons;
  if (again.kind === 'unchanged' || canonicalJson(again.changes) !== canonicalJson(verdict.changes)) {
    return ['the arc moved while this apply was evaluated: its changes classify differently now; run it again'];
  }
  return null;
}

/** A rejected apply's receipt reason: every reason, numbered. */
export const rejectedText = (reasons: readonly string[]): string =>
  `apply rejected (${reasons.length} ${reasons.length === 1 ? 'reason' : 'reasons'}): ${reasons.map((r, i) => `(${i + 1}) ${r}`).join('; ')}`;

const appliedText = (rev: PlanRev, changes: readonly PlanChange[]): readonly string[] =>
  [`plan rev ${rev} in force`, ...changes.map((c) => canonicalJson(c))];

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

/**
 * Mutations, in id order, only at a safe point: no open stage-level intent. The control-only phase applies
 * them so, before recovery has closed what a crashed executor left open; the scheduler applies each once its
 * scope has drained (A12).
 */
export function applyAtSafePoint(ctx: CommandContext, pending: readonly CommandFile[]): Promise<ControlResult> {
  const busy = ctx.journal.view.openIntents().find((i) => i.parent.type === 'stage');
  if (busy !== undefined) return Promise.resolve({ kind: 'deferred', reason: `${busy.kind} ${busy.op} of a stage is open` });
  return applyAll(ctx, pending.filter((c) => !isControl(c.body)));
}
