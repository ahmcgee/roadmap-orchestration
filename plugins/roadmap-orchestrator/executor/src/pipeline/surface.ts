import { absPath } from '../core/values.ts';
import { join } from 'node:path';
import { raiseNeedsUser, raisedWithReason } from '../needsuser.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { ruleMentions } from '../holistic/rederive.ts';
import { parseCorpusPin } from '../corpus/types.ts';
import { CORPUS_INPUT, keptInput } from '../input/inforce.ts';
// Mechanical review markers and the independent verifier's annotation/diagnosis calls.
import { freshJudgmentSession } from '../backends/argv.ts';
import type { ReviewItem, SurfaceFact } from '../core/events.ts';
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { SpecM1 } from '../core/records.ts';
import { appliedRevisions } from '../holistic/coverage.ts';
import { type PlanUnit, environmentOf } from '../input/plan.ts';
import { pathSystems, systemTraits } from '../input/systems.ts';
import { keepInput } from '../input/inforce.ts';
import { promptFor, renderPrompt } from '../prompts/index.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import type { MethodContext } from '../prompts/method/index.ts';
import { validateGateOutput, validateBuildOutput } from '../prompts/schemas.ts';
import { BRIEF_INPUT } from './rounds.ts';
import { type StageContext, type StageParent, callBackend, judgmentDeadlineMs, dispatchOf, verifierDispatch, runOp, repairTurnOf, verdictOf } from './dispatch.ts';
import { holisticInForce, integrationTip, library, visionInput, loadUnitSpec, judgedAnswer, judgmentOutput, inMs, recordedCall, unitMilestones,  removeJudgmentCheckouts, unitTarget, targetDirs } from './stages.ts';
import { mapInForce } from './lanes.ts';
import { renderSpec } from '../spec/render.ts';

export type Marker = Extract<SurfaceFact, {kind: 'review-triggered'}>['marker'];
/** All attempts count, including interrupted and uncharged work. */
export function diagnosisDue(view: JournalView, unit: UnitId): boolean {
  const counts = view.attemptCounts(unit);
  return counts.builds >= 8 || counts.judged >= 20;
}
type MarkerContext = Readonly<{plan: StageContext['plan']; journal: Readonly<{view: JournalView}>; runDir: import('../core/values.ts').AbsPath}>;
export function proofNotLocal(ctx: MarkerContext, unit: PlanUnit): boolean {
  const obligations = holisticInForce(ctx).obligations;
  if (obligations === null) return false;
  return obligations.obligations.some((o) => {
    if (o.state.type !== 'active' || !o.deliveredBy.includes(unit.id)) return false;
    if (o.witness === null || o.witness.testIds.length === 0) return true;
    const lane = obligations.lanes.find((l) => l.id === o.witness!.lane);
    if (lane === undefined) return true;
    return !['build', 'unit'].includes(lane.cadence) || lane.environment !== undefined || lane.resources.some((r) => environmentOf(ctx.plan(), r) !== null);
  });
}
export function markers(ctx: MarkerContext, unit: PlanUnit, spec: SpecM1): readonly Readonly<{marker: Marker; source: string}>[] {
  if (unit.review === 'never') return [];
  const out: {marker: Marker; source: string}[] = [];
  if ((mapInForce(ctx.journal.view) === null ? [] : systemTraits(mapInForce(ctx.journal.view)!, unit.systems)).length > 0) out.push({marker: 'M1', source: 'dispatch:system-traits'});
  if (proofNotLocal(ctx, unit)) out.push({marker: 'M2', source: 'dispatch:witnesses'});
  const revisions = appliedRevisions(ctx);
  const reviewedAt = ctx.journal.view.surfaceFacts().filter((f) => f.kind === 'review-completed' && f.unit === unit.id && f.mode === 'pre-build').at(-1);
  for (const [i, r] of revisions.entries()) {
    if (reviewedAt?.kind === 'review-completed' && r.payload.rev <= reviewedAt.planRev) continue;
    const changes = r.payload.changes;
    if (changes.some((c) => c.type === 'obligation' && ['edited', 'disposed', 'split'].includes(c.edit) && (spec.obligations ?? []).includes(c.id))) out.push({marker: 'M3', source: `apply:${r.payload.rev}:obligations`});
    if (!changes.some((c) => c.type === 'corpus') || i === 0) continue;
    const before = revisions[i - 1]!.payload.manifest.corpus;
    const after = r.payload.manifest.corpus;
    if (before === undefined || after === undefined) continue;
    const pin = (sha: typeof before) => { const bytes = keptInput(ctx.runDir, sha, CORPUS_INPUT); if (bytes === null) throw new Error('missing kept corpus pin'); return parseCorpusPin(JSON.parse(bytes.toString('utf8'))); };
    const old = pin(before), next = new Map(pin(after).rules.map((x) => [x.id, x.textSha256]));
    const mentions = new Set(renderSpec(spec).match(/\bT-\d+\b/g) ?? []);
    if (old.rules.some((rule) => mentions.has(rule.id) && next.get(rule.id) !== rule.textSha256)) out.push({marker: 'M3', source: `apply:${r.payload.rev}:corpus`});
  }
  if (unit.review === 'always') out.push({marker: 'always', source: 'override'});
  return out;
}
export function methodContext(ctx: StageContext, unit: PlanUnit, spec: SpecM1, touched: readonly string[] = []): MethodContext {
  const map = mapInForce(ctx.journal.view);
  const systems = [...unit.systems, ...touched.filter((t) => map !== null && Object.hasOwn(map.systems, t)) as import('../core/ids.ts').SystemName[], ...touched.flatMap((p) => map === null ? [] : [...pathSystems(map, p as import('../core/values.ts').RepoPath)])];
  const milestones = unitMilestones(ctx, unit.id, integrationTip(ctx));
  return { traits: map === null ? [] : systemTraits(map, systems), markers: [...new Set([...markers(ctx, unit, spec).map((m) => m.marker), ...(proofNotLocal(ctx, unit) ? ['M2'] : [])])], unitKind: milestones?.of.some((m) => m.as === 'design') ? 'design' : spec.design?.kind ?? 'module', expensiveLanes: [...spec.lanes, ...ctx.plan().suite.lanes].some((l) => (l as {cost?: string}).cost === 'expensive'), ui: milestones?.of.some((m) => m.dirs.length > 0) ?? false };
}
export function reviewItems(view: JournalView, unit: UnitId): readonly ReviewItem[] {
  return view.surfaceFacts().flatMap((f) => f.kind === 'review-completed' && f.unit === unit && f.mode === 'pre-build' ? f.items : []);
}
export const diagnosed = (view: JournalView, unit: UnitId): boolean => view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit && f.marker === 'M4');

/** An annotation never holds the unit, including a failed independent review. */
export async function runReview(ctx: StageContext, unit: PlanUnit, parent: StageParent, mode: 'pre-build' | 'diagnosis'): Promise<void> {
  const { spec } = loadUnitSpec(ctx, unit);
  const view = ctx.journal.view;
  const capturedPlanRev = view.planApplied()!.rev;
  if (unit.review === 'never') return;
  const prior = view.surfaceFacts().findLast((f) => f.kind === 'review-completed' && f.unit === unit.id && f.mode === mode);
  const triggers = mode === 'diagnosis' ? diagnosisDue(view, unit.id) ? [{marker: 'M4' as const, source: 'attempts:8-builds-or-20-judged'}] : [] : markers(ctx, unit, spec);
  if (prior?.kind === 'review-completed' && (mode === 'diagnosis' || prior.specRev === spec.rev && !triggers.some((t) => t.marker === 'M3'))) return;
  if (triggers.length === 0) return;
  for (const t of triggers) if (!view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit.id && f.specRev === spec.rev && f.marker === t.marker && f.source === t.source)) ctx.journal.fact({kind: 'review-triggered', unit: unit.id, specRev: spec.rev, ...t});
  const seated = verifierDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') throw new Error('review routing could not re-pin');
  const dispatch = seated.dispatch;
  const prompt = promptFor('verifier', dispatch.triple.model);
  const checkout = absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${unit.id}.review-${parent.attempt}`));
  const recorded = recordedCall(ctx, parent);
  if (recorded === null) {
    await removeJudgmentCheckouts(ctx, unit.id, parent);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit.id}:review`, parent, {path: checkout, checkout: {type: 'detached', at: integrationTip(ctx)}});
  }
  const measured = renderPrompt(prompt, { mode, brief: {target: unitTarget(ctx, integrationTip(ctx), 'full', holisticInForce(ctx).obligations?.obligations.filter((o) => (spec.obligations ?? []).includes(o.id) || o.deliveredBy.includes(unit.id)) ?? [], ruleMentions(renderSpec(spec))), vision: visionInput(ctx), spec: {unit: unit.id, rev: spec.rev, markdown: renderSpec(spec)}, intent: spec.intent, nonGoals: spec.nonGoals, contracts: library(ctx, spec, integrationTip(ctx)).contracts, systems: unit.systems, method: methodContext(ctx, unit, spec), history: mode === 'diagnosis' ? view.unit(unit.id).failures.slice(-20).map((f) => JSON.stringify({ref: `${unit.id}/${f.fact.stage}#${f.fact.attempt}`, outcome: f.fact.outcome, detail: f.fact.detail ?? null, evidence: join(ctx.runDir, 'evidence', unit.id, `${f.fact.attempt}-${f.fact.stage}`)})) : [], standing: reviewItems(view, unit.id) } });
  const session = freshJudgmentSession();
  const call = (repair?: {reasons: readonly string[]; turn: NonNullable<ReturnType<typeof repairTurnOf>>}) => callBackend(ctx, {unit: unit.id, parent, request: {kind: 'judgment', dispatch, session: repair === undefined ? session : repair.turn.session, evidenceDirs: targetDirs(unitTarget(ctx, integrationTip(ctx), 'full', [], ruleMentions(renderSpec(spec))))}, system: prompt.system, rendered: repair === undefined ? measured.rendered : judgmentRepairDirective(repair.reasons), prompt: repair === undefined ? measured.prompt : null, schema: prompt.schema, cwd: checkout, deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(view, unit.id)))});
  let called = recorded ?? await call();
  const judge = (answer: typeof called) => {
    const verdict = verdictOf(ctx, parent, answer);
    if (verdict.kind === 'interrupted' && verdict.needsUser !== null && raisedWithReason(view, ctx.runDir, parent, verdict.needsUser.reason) === null) raiseNeedsUser(ctx.journal, ctx.runDir, {...verdict.needsUser, summary: `The verifier's ${mode} call ${answer.inv} hit a usage limit. Its backend is parked; the review remains an annotation and available backends may continue.`}, parent);
    return judgedAnswer(answer, validateGateOutput);
  };
  let judged = judge(called);
  if (judged.kind === 'refused') { const turn = repairTurnOf(ctx.runDir, called.inv); if (turn !== null) { called = await call({reasons: judged.reasons, turn}); judged = judge(called); } }
  if (ctx.signal.aborted) { await removeJudgmentCheckouts(ctx, unit.id, parent); return; }
  const items = judged.kind === 'answered' ? judged.out.findings.map((f, n) => ({id: `${called.inv}:${n}`, text: f.text, evidence: [...f.evidence, ...f.experiments.map((e) => `${e.command}: ${e.output}`), ...(f.path === null ? [] : [f.path])]})) : [];
  const note = mode === 'diagnosis' || judged.kind !== 'answered' ? keepInput(ctx.runDir, Buffer.from(judged.kind === 'answered' ? [...judged.out.reasons, ...items.map((f) => `${f.text} (${f.evidence.join('; ')})`)].join('\n') : 'Independent review returned no usable answer; inspect prior build and lane evidence.'), BRIEF_INPUT) : null;
  await removeJudgmentCheckouts(ctx, unit.id, parent);
  ctx.journal.fact({kind: 'review-completed', unit: unit.id, mode, specRev: spec.rev, planRev: capturedPlanRev, inv: called.inv, items, note});
}

export function builderTouches(ctx: StageContext, unit: UnitId): readonly string[] {
  const spawn = ctx.journal.view.spawnsOfUnit(unit, 'build').at(-1);
  return spawn === undefined ? [] : judgmentOutput(ctx, spawn, validateBuildOutput)?.grounding.touches ?? [];
}
export function reachBackstop(ctx: StageContext, unit: PlanUnit, spec: SpecM1, paths: readonly string[], touches: readonly string[]): readonly import('../input/systems.ts').SystemTrait[] {
  const map = mapInForce(ctx.journal.view);
  if (map === null) return [];
  const named = touches.filter((t) => Object.hasOwn(map.systems, t)) as import('../core/ids.ts').SystemName[];
  const traits = systemTraits(map, [...named, ...[...paths, ...touches].flatMap((p) => [...pathSystems(map, p as import('../core/values.ts').RepoPath)])]);
  if (traits.length > 0 && !ctx.journal.view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit.id && f.marker === 'M1' && f.specRev === spec.rev)) ctx.journal.fact({kind: 'review-triggered', unit: unit.id, marker: 'M1', source: 'gate:reachTraits/touches', specRev: spec.rev});
  return traits;
}
