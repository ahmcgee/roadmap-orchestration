// A root scope decision records its reason and builds the accepted growth on the plan in force.
import type { ScopeGrowthProposal } from '../core/events.ts';
import { type CommandId,type UnitId,specRev } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type CommandBody,type SpecM1 } from '../core/records.ts';
import { type ScopeHoldStage,scopeHoldStage } from '../core/state.ts';
import { type RepoPattern } from '../core/values.ts';
import { derivedGrowthReason } from '../input/derived.ts';
import {
type InputFiles,inForceFiles,
requirePlanInForce,revisionInForce
} from '../input/inforce.ts';
import { parsePlan } from '../input/plan.ts';
import { APPLY,phase0InputOf,phase0Rows } from '../phase0/rows.ts';
import { parseSpec,specBytes } from '../spec/spec.ts';
import { type CommandContext,type Effect,advisoryText,commitUnderFence,evaluateRevision,parentOf,rejectedText } from './apply.ts';

type ScopeBody = Extract<CommandBody, { type: 'scope-decide' }>;

const DECIDED = { accept: 'accepted', reject: 'rejected' } as const;

export async function decideScope(ctx: CommandContext, id: CommandId, body: ScopeBody): Promise<Effect> {
  const what = `scope ${body.decision} ${body.unit}`;
  if (!ctx.plan().units.some((u) => u.id === body.unit)) return { kind: 'rejected', reason: `${what}: unknown unit ${body.unit}` };
  const u = ctx.journal.view.unit(body.unit);
  // Run again after a crash past the fact: it is the postcondition.
  const decided = u.scopeDecisions.find((d) => d.command === id);
  if (decided !== undefined) return { kind: 'applied', verified: [decidedText(body.unit, decided.stage, decided.attempt, decided.decision)] };
  const held = u.interrupted;
  const stage = held === null ? null : scopeHoldStage(held.stage);
  if (u.status !== 'held' || held === null || stage === null || held.outcome !== 'scope-growth' || held.detail?.kind !== 'scope-growth') {
    return { kind: 'rejected', reason: `${what}: the unit is ${u.status}${held === null ? '' : ` (held at ${held.stage}#${held.attempt} ${held.outcome})`}, not held for a scope-growth proposal` };
  }
  const verified: string[] = [];
  if (body.decision === 'accept') {
    const landed = await landGrowth(ctx, id, body.unit, held.attempt, held.detail.proposals, body.reason);
    if (landed.kind === 'rejected') return landed;
    verified.push(...landed.verified);
  }
  ctx.journal.fact({ kind: 'scope-decided', unit: body.unit, attempt: held.attempt, command: id, decision: DECIDED[body.decision], reason: body.reason });
  verified.push(decidedText(body.unit, stage, held.attempt, DECIDED[body.decision]));
  return { kind: 'applied', verified };
}

const decidedText = (unit: UnitId, stage: ScopeHoldStage, attempt: number, decision: 'accepted' | 'rejected'): string => decision === 'accepted'
  ? `unit ${unit}: the scope growth of ${stage}#${attempt} accepted; the unit re-opens at plan-check on its grown spec`
  : `unit ${unit}: the scope growth of ${stage}#${attempt} rejected; ${stage === 'lanes' ? 'the lanes run' : 'the plan-check runs again'} within the scope`;

export function grownSpec(spec: SpecM1, added: readonly RepoPattern[]): SpecM1 {
  return { ...spec, rev: specRev(spec.rev + 1), scope: [...spec.scope, ...added.filter((p) => !spec.scope.includes(p))] };
}

/** The accepted growth as one ruled revision (step 1), or why it may not land. */
async function landGrowth(
  ctx: CommandContext, id: CommandId, unit: UnitId, attempt: number, proposals: readonly ScopeGrowthProposal[], reason: string,
): Promise<Effect> {
  const view = ctx.journal.view;
  const done = view.planAppliedBy(id);
  if (done !== null) return { kind: 'applied', verified: [`plan rev ${done.rev} in force: the scope growth of ${unit} landed`] };
  const u = view.unit(unit);
  if (u.pendingRevision !== null) {
    return { kind: 'rejected', reason: `scope accept ${unit}: its spec revision ${u.pendingRevision.rev} is pending (applied, not yet re-opened on); reject this growth, or withdraw that revision first` };
  }
  const inForce = requirePlanInForce(ctx.runDir, view);
  const revision = revisionInForce(ctx.runDir, inForce);
  const current = inForceFiles(ctx.runDir, view, inForce, revision, ctx.planFile, ctx.repo);
  const planUnit = inForce.plan.units.find((p) => p.id === unit);
  const specFile = current.specs.get(unit);
  if (planUnit === undefined || specFile === undefined || specFile.bytes === null) throw new Error(`scope accept ${unit}: a held unit the plan in force does not hold with its spec`);
  const patterns = [...new Set(proposals.flatMap((p) => p.patterns))].sort();
  const grownScope = [...planUnit.scope, ...patterns];
  const refused = patterns.flatMap((p) => {
    const reason = derivedGrowthReason(inForce.plan, grownScope, p);
    return reason === null ? [] : [`\`${p}\`: ${reason}`];
  });
  if (refused.length > 0) return { kind: 'rejected', reason: `scope accept ${unit}: ${refused.join('; ')}` };
  const added = patterns.filter((p) => !planUnit.scope.includes(p));
  if (added.length === 0) return { kind: 'applied', verified: [`unit ${unit}'s plan scope holds every proposed pattern already: nothing to land`] };

  const spec = parseSpec(specFile.bytes, specFile.path);
  // The plan's own JSON with the unit's scope widened, so every other byte stays as written; the spec at rev + 1.
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: { id: string; scope: string[] }[] };
  const entry = raw.units.find((x) => x.id === unit);
  if (entry === undefined) throw new Error(`scope accept ${unit}: not in the plan in force`);
  entry.scope = [...entry.scope, ...added];
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const base: InputFiles = {
    ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes,
    specs: new Map([...current.specs, [unit, { path: specFile.path, bytes: specBytes(grownSpec(spec, added)) }]]),
  };
  const proposal = base;
  const proposer = { type: 'apply', reason } as const;
  const rctx2 = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const evaluated = evaluateRevision(rctx2, proposal, proposer);
  if (evaluated.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(evaluated.reasons) };
  if (evaluated.kind === 'unchanged') throw new Error(`scope accept ${unit}: a new ruling and a wider scope left the plan in force unchanged`);
  // The Phase-0 rows an apply runs (a corpus arc's corpus overlap among them).
  const p0 = phase0Rows(phase0InputOf(proposal, ctx.routingBase.config, view), APPLY);
  const rows = p0.rows;
  if (rows.length > 0) return { kind: 'rejected', reason: rejectedText(rows.map((r) => canonicalJson(r))) };
  const committed = await commitUnderFence(ctx, evaluated, proposer, { type: 'command', command: id }, parentOf(id));
  if (committed.kind === 'rejected' && committed.reasons.some((r) => r.startsWith('stale:'))) return landGrowth(ctx, id, unit, attempt, proposals, reason);
  if (committed.kind === 'rejected') return { kind: 'rejected', reason: rejectedText(committed.reasons) };
  return {
    kind: 'applied',
    verified: [
      `plan rev ${committed.fact.rev} in force: unit ${unit}'s scope grows by ${added.join(', ')}: ${reason}`,
      ...committed.fact.changes.map((c) => canonicalJson(c)),
      ...p0.advisories.map(advisoryText),
    ],
  };
}
