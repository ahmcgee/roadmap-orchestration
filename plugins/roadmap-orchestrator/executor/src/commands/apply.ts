// Durable command effects, receipts and subject closure. Apply uses file CAS against an exported revision.
// The frozen contract classifier and revision fence are shared with executor-built revisions.
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf,OpOutcome,Parent,PlanAppliedFact,PlanChange,RevisionPayload,RevisionSource,StageOutcomeFact } from '../core/events.ts';
import { JUDGMENT_STAGES,probeTargetKey } from '../core/events.ts';
import { holdFence } from '../core/fence.ts';
import { exclusivePublish } from '../core/fsx.ts';
import {
type CommandId,type NeedsUserId,type PlanRev,type ResourceInstance,type ResourceName,
type UnitId,
canonicalIds,
invocationId,opKey,parseResourceUnit,
planRev,resourceInstance
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { CommandBody,CommandFile,NeedsUserAck,NeedsUserContent,ResidueKey,RevisionManifest,SpecM1,Stage } from '../core/records.ts';
import type { ParkState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath,type RepoPath,absPath,isoTimeOf,repoPath } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { registryOf } from '../corpus/registry.ts';
import type { SourceFile } from '../corpus/source.ts';
import type { RulesRegistry } from '../corpus/types.ts';
import { actOnDemo } from '../demo/promote.ts';
import { CONSTRAINTS_DOC,renderConstraints } from '../docs/constraints.ts';
import { INVARIANTS_DOC,renderInvariants } from '../docs/invariants.ts';
import { gitRun } from '../git/git.ts';
import { staleSetOf } from '../holistic/staleset.ts';
import type { BusyAttempt,ContractOp,DivergenceDraft,Preimage } from '../holistic/types.ts';
import { type ResidueEntry,readResidues,recordDisposition,undispositioned } from '../host/residues.ts';
import { type ApplyProposal,type NextInputs,type Proposer,applyProposal,busyText,classify } from '../input/classify.ts';
import {
type InForce,type InputFiles,RENDER_INPUT,type RevisionInForce,type RoutingBase,
inForceFiles,
keepCorpusFiles,keepInput,keepRevisionFiles,planInForce,planRouting,
readInputFiles,requirePlanInForce,revisionInForce,
revisionManifestOf,routingProvenanceOf,
} from '../input/inforce.ts';
import { type PlanM1,type PlanUnit,boundsOf,visionFile } from '../input/plan.ts';
import { needsUserAckPath,openNeedsUser,raiseNeedsUser,raisedWithReason,readNeedsUser,readNeedsUserAck } from '../needsuser.ts';
import type { ProberHandle } from '../park/probe.ts';
import { APPLY,type Phase0Advisory,phase0InputOf,phase0Rows,planDefects,underRoot } from '../phase0/rows.ts';
import { dispatchOf,repin } from '../pipeline/dispatch.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { applyRows } from '../preflight/checks.ts';
import { laneRows } from '../preflight/lanerows.ts';
import { type SmokeRouting,backendsOf,smokeBackends,smokeRejections } from '../preflight/smoke.ts';
import type { StartupContext,StartupRejection } from '../preflight/startup.ts';
import type { ResidueRecipe } from '../recover/residue.ts';
import { type DocsPublisher,commitRevision } from '../recover/revision.ts';
import {
type CleanupResult,type Reservation,type ResourceContext,type SweepHolder,cleanup,entryOf,finishCleanup,reclaimForSweep,
reserveForSweep,resourceTable,
} from '../resources/reserve.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import type { Backend } from '../routing/types.ts';
import { parseRulings } from '../spec/rulings.ts';
import { bytesSha256,parseSpec } from '../spec/spec.ts';
import { closeAdmissions } from './admissions.ts';
import { requestAudit } from './audit.ts';
import { decideFlow,requestFlow } from './flow.ts';
import { resolveEdge,runOnly } from './graph.ts';
import { mergeIn } from './mergein.ts';
import { note } from './note.ts';
import { isControl,readCommand,readReceipt,receiptPath,receiptSha256,writeReceipt } from './queue.ts';
import { reverse } from './reverse.ts';
import { steer } from './steer.ts';

/**
 * Everything an effect may touch: the reservation cycle's context, plus what a backend smoke and an apply
 * need. `plan()` and `routing(unit)` are the plan in force and its routing, read at each call.
 */
export type CommandContext = ResourceContext & Readonly<{
  /** The backend workload environment (`backendEnv(process.env)`), for the smokes of `resume --backend` and `apply`. */
  hostEnv: Readonly<Record<string, string>>;
  /** The executor's own environment: an apply's lane rows resolve against it. */
  laneEnv: Readonly<Record<string, string | undefined>>;
  /** The routing in force: a unit's (its layer on the arc's stack), or the arc's for null. */
  routing: (unit: UnitId | null) => SmokeRouting;
  /** The arc's profile and the repo config it read at start: every revision's routings and provenance resolve under them. */
  routingBase: RoutingBase;
  /** The plan file `apply` re-reads, and its directory (unit spec paths are relative to it). */
  planFile: AbsPath;
  planDir: AbsPath;
  /**
   * The prober (src/park/probe.ts), through which `resume <unit>` of a retryable park probes and `resume
   * --backend` smokes, and the run's stop signal, which ends an effect cut short by a stop before its receipt.
   */
  probes: Readonly<{ prober: ProberHandle; signal: AbortSignal }>;
  /** M3 (A4): a revision's docs publication (src/pipeline/publish.ts). */
  docs: DocsPublisher;
}>;

export type CommandOutcome = OpOutcome['command.apply'];

/** What an effect established: the postconditions it verified, or why the command is refused. */
export type Effect = Readonly<{ kind: 'applied'; verified: readonly string[] }> | Readonly<{ kind: 'rejected'; reason: string }>;

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
  if (rejected !== null && rejected.state === 'rejected') {
    raiseDropped(ctx, id, rejected.reason);
    return { kind: 'rejected', reason: rejected.reason };
  }

  const effect = await effectOf(ctx, command);
  crashPoint('command.apply.after-effect');
  const at = isoTimeOf(new Date());
  if (effect.kind === 'rejected') {
    writeReceipt(ctx.runDir, { v: SCHEMA_VERSION, command: id, state: 'rejected', at, reason: effect.reason });
    crashPoint('command.apply.after-rejected-receipt');
    raiseDropped(ctx, id, effect.reason);
    return { kind: 'rejected', reason: effect.reason };
  }
  const verified = [...effect.verified];
  if (command.body.type === 'apply') {
    const queued = ctx.journal.view.applyQueued(id);
    if (queued !== null) verified.push(`queued behind the stage boundary of ${queued.waitsFor.join(', ')} (seq ${queued.seq}); applied there`);
  }
  if (command.body.type !== 'ack') {
    const b = command.body;
    const subjects: NeedsUserContent['subject'][] = 'unit' in b ? [{type: 'unit', unit: b.unit}]
      : 'target' in b && b.target.type === 'unit' ? [{type: 'unit', unit: b.target.unit}] : [{type: 'arc'}];
    if (b.type === 'apply') {
      const fact = ctx.journal.view.planAppliedBy(id);
      for (const change of fact?.changes ?? []) {
        if ('unit' in change && change.unit !== null) subjects.push({type: 'unit', unit: change.unit});
        if (change.type === 'unit-reentered') subjects.push({type: 'unit', unit: change.reenters});
      }
    }
    if ('target' in b && b.target.type === 'all') subjects.push(...ctx.plan().units.map((u) => ({type: 'unit' as const, unit: u.id})));
    if (b.type === 'sweep' || (b.type === 'resume' && b.target.type === 'backend')) subjects.push({type: 'host'});
    for (const subject of subjects) verified.push(...closeItemsFor(ctx, subject, id));
  }
  const sha = writeReceipt(ctx.runDir, { v: SCHEMA_VERSION, command: id, state: 'applied', at, op: intent.op, verified });
  crashPoint('command.apply.after-receipt');
  return { kind: 'applied', receiptSha256: sha };
}

/**
 * dev.17 (arc feedback 2026-10-23, item 7): an apply queued behind a running stage (`apply-queued`) and refused when it landed
 * raises one `apply-dropped` item naming the dropped edit, once (after its rejected receipt, so recovery raises it too). Its
 * operator was told it would land; nothing drops it silently.
 */
function raiseDropped(ctx: CommandContext, id: CommandId, reason: string): void {
  const view = ctx.journal.view;
  const queued = view.applyQueued(id);
  if (queued === null || raisedWithReason(view, ctx.runDir, parentOf(id), 'apply-dropped') !== null) return;
  raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false, subject: { type: 'arc' }, reason: 'apply-dropped',
    summary: `apply ${id}, queued behind the stage boundary of ${queued.waitsFor.join(', ')}, was refused when it landed there; none of its edits is in force: ${reason}`,
    recommendation: 'Fix what the reasons name and run `roadmap apply` again (`roadmap apply --dry-run` shows the verdict now); '
      + 'the edit of a unit that passed its gate since goes to a new unit that re-enters it.',
    options: [], evidence: [receiptPath(ctx.runDir, id, 'rejected')],
  }, parentOf(id));
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
    case 'reverse':
      return reverse(ctx, command.id, body.divergence);
    case 'note':
      return note(ctx, command.id, body);
    case 'steer':
      return steer(ctx, command.id, body);
    case 'merge-in':
      return mergeIn(ctx, command.id, body.unit);
    case 'audit':
      return requestAudit(ctx, command.id, body.lenses);
    case 'close-admissions':
      return closeAdmissions(ctx, command.id);
    case 'flow-decide':
      return decideFlow(ctx, command.id, body);
    case 'flow-request':
      return requestFlow(ctx, command.id, body.reason);
    case 'demo':
      return actOnDemo(ctx, command.id, body.act);
  }
}

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
  if (item.options.length === 0) return { kind: 'rejected', reason: `needs-user ${body.needsUser} has no options; act on its subject to close it` };
  const closed = view.ackOf(body.needsUser);
  if (closed !== null && closed.command === null) return { kind: 'rejected', reason: `needs-user ${body.needsUser} was declined by the executor at the close-out (nobody answered it)` };
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
export function acknowledge(ctx: Pick<CommandContext, 'journal' | 'runDir'>, id: CommandId, item: NeedsUserId, choice: string | null): readonly string[] {
  if (readNeedsUserAck(ctx.runDir, item) === null) {
    const record: NeedsUserAck = { v: SCHEMA_VERSION, id: item, command: id, choice, at: isoTimeOf(new Date()) };
    exclusivePublish(needsUserAckPath(ctx.runDir, item), canonicalJson(record));
  }
  if (ctx.journal.view.ackOf(item) === null) ctx.journal.fact({ kind: 'needs-user-acked', id: item, command: id, choice });
  return [`needs-user/${item}.ack.json written by ${id}`, `needs-user ${item} acknowledged in the log`];
}

/** Every successful command acting on a subject closes all of its open items. */
export function closeItemsFor(ctx: Pick<CommandContext, 'journal' | 'runDir'>, subject: NeedsUserContent['subject'], command: CommandId): readonly string[] {
  return openNeedsUser(ctx.journal.view).flatMap((n) => {
    const item = readNeedsUser(ctx.runDir, n.id);
    return item !== null && canonicalJson(item.subject) === canonicalJson(subject) ? acknowledge(ctx, command, n.id, null) : [];
  });
}

/** Why a parked unit parked: its park's needs-user reason, or the outcome. */
function parkReason(f: StageOutcomeFact): string {
  const decided = decidedBy(f);
  return decided.kind === 'park' ? decided.reason : f.outcome;
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
      reason: `unit ${unitId} is parked (${reason}) at ${f.stage}, a design park no revision re-opens there; re-enter it: a new unit with \`reenters: {unit: ${unitId}, fixes: ${unitId}/${f.stage}#${f.attempt}}\` that changes what that park ran under, then \`roadmap apply\``,
    };
  }
  const known = u.spec;
  if (known === null) throw new Error(`reopen of ${unitId}: parked at ${f.stage} without a recorded spec (no dispatch fact)`);
  const revision = u.pendingRevision;
  if (revision === null) {
    const path = absPath(join(ctx.planDir, unit.spec));
    return {
      kind: 'rejected',
      reason: `unit ${unitId} is parked (${reason}); revise its spec ${path} (in force at rev ${known.rev}; \`roadmap inputs export\` shows it): `
        + 'the revision takes your file\'s rev + 1; run `roadmap apply`, then resume',
    };
  }
  const verified: string[] = [];
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
    // The unit's own routing (its layer on the arc's stack), which its implementer seat was pinned under.
    const routing = ctx.routing(unitId).resolved;
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
      const verified: string[] = [];
      if (paused || u.status === 'held') ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: [...verified, `unit ${target.unit} neither paused nor held`] };
    }
    case 'all': {
      const c = view.control();
      const verified: string[] = [];
      const done = !c.pausedAll && c.pausedUnits.length === 0 && ctx.plan().units.every((u) => view.unit(u.id).status !== 'held');
      if (!done) ctx.journal.fact({ kind: 'resumed', command: id, target });
      return { kind: 'applied', verified: [...verified, 'no unit paused or held'] };
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
// apply, and the apply core every revision shares (G1)

/** What a revision is evaluated against: the log and run dir, the host's residues, the plan file, the arc's routing base. */
/** `laneEnv`: the executor's own environment, which the lane row resolves every revision's lanes against. */
export type RevisionContext = Readonly<{
  runDir: AbsPath; view: JournalView; hostDir: AbsPath; planFile: AbsPath; routingBase: RoutingBase; laneEnv: Readonly<Record<string, string | undefined>>;
}>;

/** A payload before its source: what a dry run shows and a commit completes (`payloadOf`). */
export type RevisionDraft = Omit<RevisionPayload, 'source'>;
/**
 * A file of a revision's docs publication, with its bytes (kept at commit as `inputs/<sha>.render`): a document code renders
 * (`constraints.md`, `invariants.md`), or a vision file the revision publishes as the owner committed it (`visionRenders`).
 */
export type Render = Readonly<{ path: RepoPath; bytes: Buffer }>;

export type RevisionVerdict =
  /** `busy` (dev.17): refused only because these units run a stage attempt; an apply lands at their boundary (`classify` `busy`). */
  | Readonly<{ kind: 'rejected'; reasons: readonly string[]; busy?: readonly BusyAttempt[] }>
  | Readonly<{ kind: 'unchanged'; rev: PlanRev }>
  | Readonly<{
    kind: 'accepted'; draft: RevisionDraft; next: InputFiles; scoped: readonly UnitId[]; routings: readonly ResolvedRouting[]; renders: readonly Render[];
  }>;

type Publication = Readonly<{ renders: readonly Render[]; contractOps: readonly ContractOp[] }>;

/**
 * The docs publication a revision needs (A2): `constraints.md` when its rulings change, `invariants.md` when its obligations
 * do (§2.9), each only when its rendering changes; the vision files it changes (`visionRenders`); and the contract ops of
 * the sidecars it lands. Empty when there is nothing to publish; the reasons when a vision file cannot be published.
 */
function publicationOf(
  view: JournalView, revision: RevisionInForce, inputs: NextInputs, proposal: InputFiles,
): Publication | Readonly<{ reasons: readonly string[] }> {
  const vision = visionRenders(revision, inputs, proposal);
  if ('reasons' in vision) return vision;
  const renders: Render[] = [...vision.renders];
  const latched = view.holistic().latched.map((l) => l.obligation);
  if (inputs.changed.rulings) {
    const before = renderConstraints(parseRulings(revision.ledger.bytes.toString('utf8'), 'the ledger in force'), 'living');
    const after = renderConstraints(inputs.ledger, 'living');
    if (after !== before) renders.push({ path: CONSTRAINTS_DOC, bytes: Buffer.from(after, 'utf8') });
  }
  // M4a (R3): a corpus arc's `invariants.md` carries the rules registry of its pin, so a re-pin re-renders it too.
  if ((inputs.changed.obligations || inputs.changed.corpus) && inputs.obligations !== null) {
    const before = revision.obligations === null ? null : renderInvariants(revision.obligations.value, latched, revision.corpus === null ? undefined : registryOf(revision.corpus.pin.value));
    const after = renderInvariants(inputs.obligations, latched, nextRegistry(inputs));
    if (after !== before) renders.push({ path: INVARIANTS_DOC, bytes: Buffer.from(after, 'utf8') });
  }
  return { renders, contractOps: [] };
}

/**
 * The vision files a revision publishes (vision edits publish, dev.16): the arc branch carries the vision in force, so
 * nobody moves it by hand to land one (the dev.13 field incident). A corpus arc's vision record (`.roadmap/vision.json`,
 * in the product repo, R1) whenever its bytes change, as the owner's files hold them; and for a `same-repo` corpus the
 * pinned vision document when the re-pin changes it (its path or bytes), read at the pin's commit, where the pin hashed
 * it. An `architecture-doc` arc's vision lives beside its plan, and an other-repo or checkout corpus outside the product
 * repo: nothing of theirs is published. The reason when the pinned vision document is not at its commit as the pin says
 * (a pin that does not re-derive, which the Phase-0 rows refuse too).
 */
function visionRenders(revision: RevisionInForce, inputs: NextInputs, proposal: InputFiles): Readonly<{ renders: readonly Render[] }> | Readonly<{ reasons: readonly string[] }> {
  const renders: Render[] = [];
  const record = visionFile(proposal.plan);
  const recordBytes = proposal.vision?.bytes ?? null;
  if (inputs.changed.vision && record?.base === 'repo' && recordBytes !== null) renders.push({ path: record.path, bytes: recordBytes });
  const pin = inputs.corpus?.pin ?? null;
  if (inputs.changed.corpus && pin !== null && pin.source.kind === 'same-repo' && canonicalJson(pin.vision) !== canonicalJson(revision.corpus?.pin.value.vision ?? null)) {
    const path = repoPath(underRoot(pin.source.root, pin.vision.path));
    const blob = gitRun(proposal.repo, ['cat-file', 'blob', `${pin.source.commit}:${path}`], { okCodes: [0, 128] });
    const bytes = blob.code === 0 ? Buffer.from(blob.stdout, 'utf8') : null;
    if (bytes === null || bytesSha256(bytes) !== pin.vision.sha256) {
      return { reasons: [`the pinned vision document ${path} at ${pin.source.commit} is not the pin's ${pin.vision.sha256}: the pin does not re-derive (re-pin it)`] };
    }
    renders.push({ path, bytes });
  }
  return { renders };
}

/** The rules registry the proposal's pin publishes; undefined for an `architecture-doc` arc. An accepted corpus proposal loads its pin. */
function nextRegistry(inputs: NextInputs): RulesRegistry | undefined {
  if (inputs.corpus === null) return undefined;
  if (inputs.corpus.pin === null) throw new Error('an accepted corpus revision whose pin does not load (the Phase-0 rows refuse it)');
  return registryOf(inputs.corpus.pin);
}

/**
 * The preimage of what a revision touches in the obligations (H13): the plan rev it is based on and the obligations'
 * bytes before it; nothing else is touched by an obligation edit.
 */
const obligationsPreimage = (inForce: InForce, revision: RevisionInForce): Preimage =>
  ({ planRev: inForce.rev, specs: {}, obligationsSha256: revision.obligations?.sha256 ?? null, ledgerSha256: null, contracts: [] });

/**
 * The apply core (G1, A2): evaluates a proposal (the files an `apply` or a start read; the plan in force plus a
 * bundle's ops; the ledger plus a `rule`'s sidecar; a divergence's preimage for `reverse`) against the plan in force,
 * synchronously and without effect: the classifier (src/input/classify.ts) and shared startup rows, then the payload's
 * publication plan and divergences. A caller evaluates once, runs what it must await (the startup rows, a smoke), then takes the fence
 * (src/core/fence.ts) and evaluates again: a draft that differs is stale. `proposer` is who proposes it; a
 * bundle's cites and evidence back the `split-dropped` divergences its splits record (H14).
 */
export function evaluateRevision(
  ctx: RevisionContext, proposal: InputFiles, proposer: Proposer,
): RevisionVerdict {
  const inForce = requirePlanInForce(ctx.runDir, ctx.view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const verdict = classify({
    runDir: ctx.runDir, view: ctx.view, inForce, revision, next: proposal, residues: undispositioned(ctx.hostDir), routing: ctx.routingBase, proposer,
  });
  if (verdict.kind === 'rejected') return verdict;
  if (verdict.kind === 'busy') return { kind: 'rejected', reasons: verdict.busy.map(busyText), busy: verdict.busy };
  if (verdict.kind === 'unchanged') return { kind: 'unchanged', rev: inForce.rev };
  // The lane row (src/preflight/lanerows.ts) over the units the revision changes, on every path a revision takes.
  const specOf = (unit: PlanUnit): SpecM1 => {
    const file = proposal.specs.get(unit.id);
    if (file?.bytes === null || file === undefined) throw new Error(`an accepted revision without the spec of ${unit.id} (the classifier refuses it)`);
    return parseSpec(file.bytes, file.path);
  };
  const lanes = laneRows(proposal.plan, verdict.scoped, specOf, ctx.laneEnv);
  if (lanes.length > 0) return { kind: 'rejected', reasons: lanes.map(rowText) };
  // The corpus overlap rule (R32) over the units the revision changes, on every path a revision takes: what an apply's
  // Phase-0 rows would refuse is never committed by the executor's own revisions (a pin or guide that does not load or is
  // absent: those rows refuse it).
  // Every revision refuses only the plan defects it adds (2026-10-27; 1.0.0-dev.26), including executor revisions.
  const before = inForceFiles(ctx.runDir, ctx.view, inForce, revision, ctx.planFile, proposal.repo);
  const known = new Set(planDefects(phase0InputOf(before, ctx.routingBase.config, ctx.view), APPLY).map(canonicalJson));
  const added = planDefects(phase0InputOf(proposal, ctx.routingBase.config, ctx.view), APPLY).filter((d) => !known.has(canonicalJson(d)));
  if (added.length > 0) return { kind: 'rejected', reasons: [rowText({ kind: 'plan-defect', defects: added })] };
  const manifest = revisionManifestOf(proposal);
  if ('missing' in manifest) return { kind: 'rejected', reasons: manifest.missing };
  const publication = publicationOf(ctx.view, revision, verdict.inputs, proposal);
  if ('reasons' in publication) return { kind: 'rejected', reasons: publication.reasons };
  const divergences: DivergenceDraft[] = verdict.dropped.map((d) => {
    if (proposer.type !== 'bundle') throw new Error(`a split dropping text proposed by ${proposer.type}: the classifier refuses it`);
    return {
      job: proposer.job, type: 'split-dropped', from: `${d.obligation} (plan rev ${inForce.rev})`, what: `the split of ${d.obligation} drops ${d.sentences.map((t) => JSON.stringify(t)).join(', ')}`,
      cites: canonicalIds(proposer.cites), evidence: proposer.evidence, preimage: obligationsPreimage(inForce, revision),
      compensation: { hint: `\`roadmap reverse\` restores the obligations before the split of ${d.obligation}`, kind: 'restore-revision' },
    };
  });
  // dev.17 (propagation): what the revision leaves stale, by code (src/holistic/staleset.ts), over the units still to land.
  const stale = staleSetOf({
    obligations: { before: revision.obligations?.value ?? null, after: verdict.inputs.obligations },
    vision: { before: revision.vision?.value ?? null, after: verdict.inputs.vision },
    contracts: publication.contractOps.map((o) => o.path),
    units: () => proposal.plan.units.filter((u) => u.cut === undefined && !['retired', 'cut', 'superseded'].includes(ctx.view.unit(u.id).status)).map((u) => ({ id: u.id, spec: specOf(u) })),
  });
  const draft: RevisionDraft = {
    v: SCHEMA_VERSION, base: inForce.rev, rev: planRev(inForce.rev + 1), manifest, changes: verdict.changes, dispositions: verdict.dispositions, divergences,
    publication: publication.renders.length === 0 && publication.contractOps.length === 0
      ? null
      : { renders: publication.renders.map((r) => ({ path: r.path, sha256: bytesSha256(r.bytes) })).sort((a, b) => (a.path < b.path ? -1 : 1)), contractOps: publication.contractOps },
    routingProvenance: routingProvenanceOf(ctx.routingBase, proposal.plan),
    systemsMap: ctx.routingBase.config?.systemsMap ?? null,
    ...(stale === null ? {} : { stale }),
  };
  return { kind: 'accepted', draft, next: proposal, scoped: verdict.scoped, routings: verdict.routings, renders: publication.renders };
}

/** A draft committed from `source`; `owner`: the owner's files a start or apply was rebased from (src/input/rebase.ts `ownerField`). */
export const payloadOf = (draft: RevisionDraft, source: RevisionSource): RevisionPayload => ({ ...draft, source });

/** Keeps every byte an accepted revision's payload names: its inputs and its renders. */
export function keepRevision(runDir: AbsPath, verdict: Extract<RevisionVerdict, { kind: 'accepted' }>): void {
  const manifest = keepRevisionFiles(runDir, verdict.next);
  if (canonicalJson(manifest) !== canonicalJson(verdict.draft.manifest)) throw new Error('the kept revision inputs do not hash to its evaluated manifest');
  for (const r of verdict.renders) keepInput(runDir, r.bytes, RENDER_INPUT);
}

/** What an apply needs to evaluate the files, in the executor or read-only (`apply --dry-run`). */
export type ApplyInput = RevisionContext & Readonly<{
  repo: AbsPath;
  manifest: RevisionManifest | null;
  base: RevisionManifest;
  rev: number;
  reason: string;
}>;

export type ApplyVerdict =
  | Readonly<{ kind: 'rejected'; reasons: readonly string[]; busy?: readonly BusyAttempt[] }>
  | Readonly<{ kind: 'unchanged'; rev: PlanRev }>
  /** `smoke`: backends the new routings seat that the routing in force did not; they must pass a smoke first. */
  /** `corpusFiles`: a corpus arc's corpus files as its pin re-derived them (kept before the commit, M4a). */
  /** `rulings`: the ids its `--ruling` records land (I2), for the commit's proposer; `numbered`: each `C-?` record's assigned id. */
  /** `advisories` (scope growth, 2026-10-15): Phase-0 rows 10's, 13's and 14's, which never refuse (the receipt and the dry run list them). */
  /** `rebuild`: the proposal built again under the fence. */
  /** `warnings` (dev.17, arc feedback 2026-10-23 items 8 and 9): what the revision costs that it does not refuse (`applyWarnings`). */
  | Readonly<{
    kind: 'accepted'; rev: PlanRev; evaluated: Extract<RevisionVerdict, { kind: 'accepted' }>; smoke: readonly Backend[]; corpusFiles: readonly SourceFile[];
    advisories: readonly Phase0Advisory[]; warnings: readonly string[];
  }>;

/** One rejection per line of text, for a receipt's reason and the dry run. */
const rowText = (r: StartupRejection): string => canonicalJson(r);

/**
 * The owner's files read now and rebased (`applyProposal`, src/input/rebase.ts) onto the files in force per `view`, its
 * rulings read and numbered; every reason it does not hold.
 */
function applyProposalNow(input: Pick<ApplyInput, 'runDir' | 'repo' | 'planFile' | 'manifest' | 'base' | 'rev' | 'reason'>, view: JournalView): ApplyProposal | Readonly<{ reasons: readonly string[] }> {
  if (input.rev > (view.planApplied()?.rev ?? 0)) return { reasons: [`unknown base revision ${input.rev}`] };
  let files: InputFiles;
  try { files = readInputFiles(input.planFile, input.repo, true); }
  catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    return { reasons: [`${input.planFile} does not load: ${error.message}`] };
  }
  const inForce = requirePlanInForce(input.runDir, view);
  const result = applyProposal({ runDir: input.runDir, view, inForce, revision: revisionInForce(input.runDir, inForce) }, files, input.manifest, input.base);
  if ('reasons' in result || result.next.obligations?.bytes === null || result.next.obligations === null) return result;
  const revision = revisionInForce(input.runDir, inForce);
  const raw = JSON.parse(result.next.obligations.bytes.toString('utf8')) as {obligations: {id: string; state: {type: string; reason?: string; rev?: number}}[]};
  let stamped = false;
  for (const o of raw.obligations) {
    const previous = revision.obligations?.value.obligations.find((x) => x.id === o.id);
    if (['waived', 'deferred', 'retired'].includes(o.state.type) && canonicalJson(previous?.state ?? null) !== canonicalJson(o.state)) {
      o.state = {type: o.state.type, reason: input.reason, rev: inForce.rev + 1}; stamped = true;
    }
  }
  return stamped ? {next: {...result.next, obligations: {...result.next.obligations, bytes: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`)}}} : result;
}

/**
 * Evaluates an apply without effect: the files against the manifest (G15), rebased from the base onto the files in force
 * (a conflict refuses), its rulings numbered and validated, the apply core, then the startup rows over the changed units.
 * Every reason found at a step is reported together.
 */
export async function evaluateApply(input: ApplyInput): Promise<ApplyVerdict> {
  const inForce = planInForce(input.runDir, input.view);
  if (inForce === null) {
    return { kind: 'rejected', reasons: [`arc ${input.view.arc} records no plan in force yet (its first start records plan.json as revision 1`] };
  }
  const built = applyProposalNow(input, input.view);
  if ('reasons' in built) return { kind: 'rejected', reasons: built.reasons };
  const proposal = built.next;
  const proposer: Proposer = { type: 'apply', reason: input.reason };
  const verdict = evaluateRevision(input, proposal, proposer);
  if (verdict.kind !== 'accepted') return verdict;
  const context: StartupContext = {
    repo: input.repo, planFile: input.planFile, plan: proposal.plan, specOf: (u) => proposal.specs.get(u.id)?.bytes ?? null, profile: input.routingBase.profile,
    arcRoles: input.routingBase.arcRoles, runDir: input.runDir, hostDir: input.hostDir, ...(proposal.ledger.bytes === null ? {} : { ledger: proposal.ledger.bytes }),
  };
  const routingChanged = verdict.routings.length > 0 || verdict.draft.changes.some((c) => c.type === 'holistic');
  // M4a: the shared Phase-0 rows (src/phase0/rows.ts) over the proposal: the tree, and for a corpus arc the pin
  // re-derived, corpus overlap, census, debt, questions, amendments, intake and the vision confirmed.
  const p0 = phase0Rows(phase0InputOf(proposal, input.routingBase.config, input.view), APPLY);
  const rows = [...(await applyRows(context, verdict.scoped, routingChanged)), ...p0.rows];
  if (rows.length > 0) return { kind: 'rejected', reasons: rows.map(rowText) };
  const before = new Set(backendsOf(planRouting(input.routingBase, inForce.plan)));
  const smoke = [...new Set(verdict.routings.flatMap((r) => backendsOf(r)))].filter((b) => !before.has(b)).sort();
  return {
    kind: 'accepted', rev: inForce.rev, evaluated: verdict, smoke, corpusFiles: p0.opened?.files ?? [],
    advisories: p0.advisories, warnings: applyWarnings(input.view, proposal.plan, verdict.draft.changes),
  };
}

/**
 * What an accepted apply costs that it never refuses (dev.17, arc feedback 2026-10-23), one receipt line each:
 * - item 8: a checkpoint running now read the plan before this revision, so a bundle of it that touches what the revision
 *   changes is rejected stale at activation, its spend wasted;
 * - item 9: a re-entry without `reset` carries its predecessor's chargeable failures; at its bound less one, the next charged
 *   failure (a red series, a gate revise) parks it for the operator instead of a fix round, so a gate's directives reach the
 *   builder only through the operator.
 */
export function applyWarnings(view: JournalView, plan: PlanM1, changes: readonly PlanChange[]): readonly string[] {
  const out: string[] = [];
  for (const c of view.holistic().checkpoints) {
    if (c.decided !== null) continue;
    out.push(`warning: checkpoint ${c.inputs.job} is running on plan rev ${c.inputs.vector.plan}; a bundle of it that touches what this revision changes `
      + 'is rejected stale when it lands, and its spend is wasted (apply after it decides unless the edit cannot wait)');
  }
  for (const c of changes) {
    if (c.type !== 'unit-reentered' || c.reset) continue;
    const unit = plan.units.find((u) => u.id === c.unit);
    if (unit === undefined) throw new Error(`a re-entry of ${c.reenters} as ${c.unit}, which the plan does not list`);
    const failures = view.unit(c.reenters).counters.chargeableFailures;
    const bound = boundsOf(plan, unit).chargeable;
    if (failures + 1 < bound) continue;
    out.push(`warning: ${c.unit} re-enters ${c.reenters} with ${failures} chargeable failures of its bound ${bound} and no reset: its next charged failure `
      + '(a red lane series, a gate revise) parks it for you instead of a fix round, so a gate\'s directives reach the builder only through you; '
      + 'when the re-entry answers a known cause, cite a ruling as `reenters.reset` to start it at 0');
  }
  return out;
}

/** The apply's manifest is the revision in force already. */
function alreadyInForce(ctx: CommandContext, manifest: RevisionManifest): PlanRev | null {
  const inForce = planInForce(ctx.runDir, ctx.journal.view);
  if (inForce === null) return null;
  const m = revisionInForce(ctx.runDir, inForce).manifest;
  return canonicalJson(m) === canonicalJson(manifest) ? inForce.rev : null;
}

/** The command's CAS is checked under the fence through its final evaluation and commit. */
async function applyPlan(ctx: CommandContext, id: CommandId, body: Extract<CommandBody, { type: 'apply' }>): Promise<Effect> {
  const done = ctx.journal.view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: appliedText(done.rev, done.changes) };
  const hold = await holdFence(ctx.journal);
  try {
    const verdict = await evaluateApply({
      runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, repo: ctx.repo, planFile: body.planFile, routingBase: ctx.routingBase,
      laneEnv: ctx.laneEnv, manifest: body.manifest, base: body.base, rev: body.rev, reason: body.reason,
    });
    if (verdict.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(verdict.reasons) };
    if (verdict.kind === 'unchanged') return { kind: 'applied', verified: [`plan rev ${verdict.rev} is unchanged`] };
    const smoked = new Set<Backend>();
    for (const resolved of verdict.evaluated.routings) {
      const need = backendsOf(resolved).filter((b) => verdict.smoke.includes(b) && !smoked.has(b));
      if (need.length === 0) continue;
      const report = await smokeBackends({ profile: ctx.routingBase.profile, resolved }, { journal: ctx.journal, runDir: ctx.runDir, hostEnv: ctx.hostEnv }, need);
      ctx.probes.signal.throwIfAborted();
      const failures = smokeRejections(report);
      if (failures.length > 0) return { kind: 'rejected', reason: rejectedText(failures.map(rowText)) };
      for (const b of need) smoked.add(b);
    }
    const final = applyProposalNow({ ...body, runDir: ctx.runDir, repo: ctx.repo }, ctx.journal.view);
    if ('reasons' in final) return { kind: 'rejected', reason: rejectedText(final.reasons) };
    const evaluated = evaluateRevision({ ...ctx, view: ctx.journal.view, planFile: body.planFile }, final.next, { type: 'apply', reason: body.reason });
    if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons) };
    if (evaluated.kind === 'unchanged') return { kind: 'applied', verified: [`plan rev ${evaluated.rev} is unchanged`] };
    keepCorpusFiles(ctx.runDir, verdict.corpusFiles);
    keepRevision(ctx.runDir, evaluated);
    const committed = await commitRevision(ctx, payloadOf(evaluated.draft, { type: 'command', command: id }), parentOf(id));
    if (committed.kind !== 'applied') return { kind: 'rejected', reason: committed.reason };
    return { kind: 'applied', verified: [...appliedText(committed.fact.rev, committed.fact.changes), ...verdict.advisories.map(advisoryText), ...verdict.warnings] };
  } finally { hold.release(); }
}

/** What a commit under the fence touches: the log and run dir, the revision context's inputs, and the docs publisher. */
export type FencedCommitContext = Pick<CommandContext, 'journal' | 'runDir' | 'hostDir' | 'planFile' | 'routingBase' | 'laneEnv' | 'docs'>;
type Committed = Readonly<{ kind: 'applied'; fact: PlanAppliedFact }> | Readonly<{ kind: 'rejected'; reasons: readonly string[] }>;

/**
 * A12, A19: under the fence, the proposal evaluated again, synchronously and with nothing awaited before the commit
 * begins, against the log as it is now (the startup rows and the smoke awaited; other work went on); then the commit
 * (src/recover/revision.ts). Why it may no longer commit, or the fact it wrote.
 */
export async function commitUnderFence(
  ctx: FencedCommitContext, evaluated: Extract<RevisionVerdict, { kind: 'accepted' }>, proposer: Proposer, source: RevisionSource, parent: Parent,
): Promise<Committed> {
  const hold = await holdFence(ctx.journal);
  try {
    const current = requirePlanInForce(ctx.runDir, ctx.journal.view);
    if (current.rev !== evaluated.draft.base) return { kind: 'rejected', reasons: ['stale: revision changed during evaluation'] };
    const again = evaluateRevision({ ...ctx, view: ctx.journal.view }, evaluated.next, proposer);
    if (again.kind === 'rejected') return again;
    if (again.kind === 'unchanged' || canonicalJson(again.draft) !== canonicalJson(evaluated.draft)) return { kind: 'rejected', reasons: ['stale: revision inputs changed during evaluation'] };
    keepRevision(ctx.runDir, again);
    const committed = await commitRevision(ctx, payloadOf(again.draft, source), parent);
    return committed.kind === 'applied' ? committed : { kind: 'rejected', reasons: [committed.reason] };
  } finally { hold.release(); }
}

/** A rejected revision's receipt reason (an `apply`'s, a `reverse`'s): every reason, numbered. */
export const rejectedText = (reasons: readonly string[], what: 'apply' | 'reverse' = 'apply'): string =>
  `${what} rejected (${reasons.length} ${reasons.length === 1 ? 'reason' : 'reasons'}): ${reasons.map((r, i) => `(${i + 1}) ${r}`).join('; ')}`;

/** A Phase-0 advisory as a receipt line (scope growth, 2026-10-15): never a refusal. */
export const advisoryText = (a: Phase0Advisory): string => `advisory: ${canonicalJson(a)}`;

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
