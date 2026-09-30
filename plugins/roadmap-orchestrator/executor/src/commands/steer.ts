// `roadmap steer <u> --brief <f> --budget <min> [--class <c>] [--resume]` (M3 step A3; DESIGN-1.0.md §2.3, R11): the
// architect's alternate implementer entry for a parked unit, or a re-entry whose preparation decided where it enters
// and that has not started there (`preparing`). Mutation, scope {u}. The effect, each step only where missing (a run
// again after a crash finds what is done):
//
//   1. `--class`: the unit's routing layer seats that class at `build.<its build tier>`, a revision of the plan in
//      force (the `route` edit class, `routing{routingRev, unit}`, source the command) committed through the apply core
//      and the fence, after a smoke of any backend it newly seats; the steer record then names a new routingRev.
//   2. The brief, kept content-addressed (`inputs/<sha256>.brief.md`): the steer round reads it from there.
//   3. The pre-steer state saved: an `evidence.snapshot` of the unit worktree (what it holds beyond its commit; the
//      commit stays on the branch the round builds on).
//   4. A park's open needs-user acknowledged by this command.
//   5. `steered{unit, command, brief, budgetMin, resume}`, the postcondition: the fold invalidates the unit's approval,
//      clears its park and sets its steer round (src/core/state.ts). The driver then runs one uncharged steer round, a
//      fresh session with the brief and the budget as its window, then salvage → lanes → gate; the table's steer rows
//      park it `steered` unless the pass is green and `--resume` was given (src/pipeline/transitions.ts `steerExit`).
//
// Refused: an unknown unit; a unit never dispatched (nothing to steer: it plan-checks when it runs); one not parked or
// preparing; a brief that no longer hashes to what the CLI recorded. A steer session never becomes a judgment session:
// every judgment runs a fresh one (`freshJudgmentSession`). Widening the envelope is impossible by construction: the
// steer round runs under the pinned scope, and salvage enforces it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../core/json.ts';
import type { CommandId, UnitId } from '../core/ids.ts';
import type { CommandBody } from '../core/records.ts';
import { absPath } from '../core/values.ts';
import { capturedEvidence, pathPattern } from '../git/evidence.ts';
import { inForceFiles, keepInput, planRouting, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { unitWorktree } from '../pipeline/dispatch.ts';
import { dirtyPaths } from '../pipeline/lanes.ts';
import { BRIEF_INPUT } from '../pipeline/rounds.ts';
import { backendsOf, smokeBackends, smokeRejections } from '../preflight/smoke.ts';
import { evidenceSnapshotOp } from '../recover/ops.ts';
import type { RoutingLayer } from '../routing/types.ts';
import { bytesSha256 } from '../spec/spec.ts';
import { runOp } from '../pipeline/dispatch.ts';
import { type CommandContext, type Effect, acknowledgePark, commitUnderFence, evaluateRevision, parentOf, rejectedText } from './apply.ts';

type SteerBody = Extract<CommandBody, { type: 'steer' }>;

export async function steer(ctx: CommandContext, id: CommandId, body: SteerBody): Promise<Effect> {
  const view = ctx.journal.view;
  // Run again after a crash past the fact: it is the postcondition.
  if (view.holistic().steered.some((s) => s.command === id)) return { kind: 'applied', verified: [`unit ${body.unit} steered by ${id}`] };
  const unit = ctx.plan().units.find((u) => u.id === body.unit);
  if (unit === undefined) return { kind: 'rejected', reason: `unknown unit ${body.unit}` };
  if (view.dispatchOf(unit.id) === null) return { kind: 'rejected', reason: `unit ${unit.id} was never dispatched: there is nothing to steer yet; it plan-checks when it runs` };
  const u = view.unit(unit.id);
  const preparing = u.status === 'active' && u.decided?.stage === 'prepare';
  if (!(u.status === 'park-pending' || preparing) || u.open !== null || u.entry !== null) {
    return { kind: 'rejected', reason: `unit ${unit.id} is ${u.status}: only a parked unit, or a re-entry prepared and not yet started, can be steered` };
  }
  if (!existsSync(body.brief.path)) return { kind: 'rejected', reason: `the brief ${body.brief.path} does not exist` };
  const brief = readFileSync(body.brief.path);
  if (bytesSha256(brief) !== body.brief.sha256) return { kind: 'rejected', reason: `the brief ${body.brief.path} changed since the command hashed it` };

  const verified: string[] = [];
  if (body.class !== null) {
    const routed = await routeClass(ctx, id, unit.id, body.class);
    if (routed.kind === 'rejected') return routed;
    verified.push(...routed.verified);
  }
  keepInput(ctx.runDir, brief, BRIEF_INPUT);
  verified.push(`brief ${body.brief.sha256} kept`);
  verified.push(...await savePreSteer(ctx, id, unit.id));
  if (u.decided !== null && u.status === 'park-pending') verified.push(...acknowledgePark(ctx, id, unit.id, u.decided));
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
    ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit}`, parentOf(id), { source: worktree, globs: dirtyPaths(worktree).map(pathPattern), dest });
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
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce, ctx.planFile), ctx.planFile);
  const layer: RoutingLayer = inForce.plan.units.find((u) => u.id === unit)?.routing ?? {};
  if (layer.build?.[tier] === cls) return { kind: 'applied', verified: [`unit ${unit}'s routing layer seats ${cls} at build.${tier} already`] };
  // The plan's own JSON, with the unit's layer set, so every other byte of it stays as the architect wrote it.
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: { id: string; routing?: RoutingLayer }[] };
  const entry = raw.units.find((u) => u.id === unit);
  if (entry === undefined) throw new Error(`steer of ${unit}: not in the plan in force`);
  entry.routing = { ...layer, build: { ...layer.build, [tier]: cls } };
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const proposal = { ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes };
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase };
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
  return { kind: 'applied', verified: [`plan rev ${committed.fact.rev} in force: unit ${unit}'s implementer class ${cls}`, ...committed.fact.changes.map((c) => canonicalJson(c))] };
}
