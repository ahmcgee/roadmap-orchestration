// Steer any unfinished unit. The scheduler drains a running invocation before this fresh steer round.
import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandId,UnitId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { CommandBody } from '../core/records.ts';
import { absPath } from '../core/values.ts';
import { capturedEvidence } from '../git/evidence.ts';
import { inForceFiles,keepInput,planRouting,requirePlanInForce,revisionInForce,specBytesOf,specShaInForce } from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { firstPin,runOp,unitWorktree } from '../pipeline/dispatch.ts';
import { dirtySnapshot } from '../pipeline/lanes.ts';
import { BRIEF_INPUT } from '../pipeline/rounds.ts';
import { backendsOf,smokeBackends,smokeRejections } from '../preflight/smoke.ts';
import { evidenceSnapshotOp } from '../recover/ops.ts';
import type { RoutingLayer } from '../routing/types.ts';
import { bytesSha256,parseSpec } from '../spec/spec.ts';
import { type CommandContext,type Effect,commitUnderFence,evaluateRevision,parentOf,rejectedText } from './apply.ts';

type SteerBody = Extract<CommandBody, { type: 'steer' }>;

export async function steer(ctx: CommandContext, id: CommandId, body: SteerBody): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition.
  if (view.holistic().steered.some((s) => s.command === id)) return { kind: 'applied', verified: [`unit ${body.unit} steered by ${id}`] };
  const unit = ctx.plan().units.find((u) => u.id === body.unit);
  if (unit === undefined) return { kind: 'rejected', reason: `unknown unit ${body.unit}` };
  const u = view.unit(unit.id);
  if (unit.cut !== undefined || ['retired', 'cut', 'superseded', 'stop-pending'].includes(u.status)) return { kind: 'rejected', reason: `unit ${unit.id} is finished (${u.status})` };
  if (u.open !== null) return { kind: 'rejected', reason: `unit ${unit.id} still has a running attempt; steer waits for its cancellation and cleanup` };
  if (!existsSync(body.brief.path)) return { kind: 'rejected', reason: `the brief ${body.brief.path} does not exist` };
  const brief = readFileSync(body.brief.path);
  if (bytesSha256(brief) !== body.brief.sha256) return { kind: 'rejected', reason: `the brief ${body.brief.path} changed since the command hashed it` };

  if (view.dispatchOf(unit.id) === null) {
    const sha256 = specShaInForce(view, unit.id);
    const spec = parseSpec(specBytesOf(ctx.runDir, sha256), absPath(join(ctx.planDir, unit.spec)));
    const record = firstPin({ plan: ctx.plan, routing: (id) => ctx.routing(id).resolved }, unit, { rev: spec.rev, sha256 }, unit.risk);
    ctx.journal.fact({ kind: 'dispatch', record });
  }
  const verified: string[] = [];
  if (body.class !== null) {
    const routed = await routeClass(ctx, id, unit.id, body.class);
    if (routed.kind === 'rejected') return routed;
    verified.push(...routed.verified);
  }
  keepInput(ctx.runDir, brief, BRIEF_INPUT);
  verified.push(`brief ${body.brief.sha256} kept`);
  verified.push(...await savePreSteer(ctx, id, unit.id));
  ctx.journal.fact({ kind: 'steered', unit: unit.id, command: id, brief: body.brief.sha256, budgetMin: body.budgetMin, resume: body.resume });
  verified.push(`unit ${unit.id} steered: one steer round of ${body.budgetMin} min, then lanes and gate; ${body.resume ? 'a green pass goes on' : 'it parks for review'}`);
  return { kind: 'applied', verified };
}

/** The pre-steer state: a snapshot of what the unit worktree holds beyond its commit (none when it has no worktree). */
async function savePreSteer(ctx: CommandContext, id: CommandId, unit: UnitId): Promise<readonly string[]> {
  const worktree = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit);
  if (!existsSync(worktree)) return [`unit ${unit} has no worktree yet: nothing to save`];
  const dest = absPath(join(ctx.runDir, 'evidence', unit, `steer-${id}`));
  const view = ctx.journal.view;
  const done = view.opsOf('evidence.snapshot').find((i) => i.expect.dest === dest && view.doneOf(i.op) !== null)
    ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit}`, parentOf(id), { source: worktree, ...dirtySnapshot(worktree), dest });
  return [`pre-steer state of ${unit} saved: ${done.expect.dest} (manifest ${capturedEvidence(ctx.journal.view, done.op).manifestSha256})`];
}

/**
 * `--class`: a revision of the plan in force whose only change is the unit's layer seating `cls` at `build.<its build
 * tier>` (the `route` edit class). Nothing to commit when its layer names that class there already.
 */
async function routeClass(ctx: CommandContext, id: CommandId, unit: UnitId, cls: NonNullable<SteerBody['class']>): Promise<Effect> {
  const view = ctx.journal.view;
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: unit ${unit}'s implementer class ${cls}`] };
  const tier = view.unit(unit).buildTier;
  if (tier === null) throw new Error(`steer of ${unit}: dispatched without a build tier`);
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const layer: RoutingLayer = inForce.plan.units.find((u) => u.id === unit)?.routing ?? {};
  if (layer.build?.[tier] === cls) return { kind: 'applied', verified: [`unit ${unit}'s routing layer seats ${cls} at build.${tier} already`] };
  // The plan's own JSON, with the unit's layer set, so every other byte of it stays as the architect wrote it.
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: { id: string; routing?: RoutingLayer }[] };
  const entry = raw.units.find((u) => u.id === unit);
  if (entry === undefined) throw new Error(`steer of ${unit}: not in the plan in force`);
  entry.routing = { ...layer, build: { ...layer.build, [tier]: cls } };
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const proposal = { ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes };
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const evaluated = evaluateRevision(rctx, proposal, { type: 'apply' });
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons) };
  if (evaluated.kind === 'unchanged') return { kind: 'applied', verified: [`unit ${unit}'s routing is in force already`] };
  // A backend the new routing seats that the arc's did not passes its smoke first, as an apply's does.
  const before = new Set(backendsOf(planRouting(ctx.routingBase, inForce.plan)));
  for (const resolved of evaluated.routings) {
    const need = backendsOf(resolved).filter((b) => !before.has(b));
    if (need.length === 0) continue;
    const report = await smokeBackends({ profile: ctx.routingBase.profile, resolved }, { journal: ctx.journal, runDir: ctx.runDir, hostEnv: ctx.hostEnv }, need);
    ctx.probes.signal.throwIfAborted();
    const failures = smokeRejections(report);
    if (failures.length > 0) return { kind: 'rejected', reason: rejectedText(failures.map((r) => canonicalJson(r))) };
    for (const b of need) before.add(b);
  }
  const committed = await commitUnderFence(ctx, evaluated, { type: 'apply' }, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons) };
  return {
    kind: 'applied',
    verified: [`plan rev ${committed.fact.rev} in force: unit ${unit}'s implementer class ${cls}`, ...committed.fact.changes.map((c) => canonicalJson(c))],
  };
}
