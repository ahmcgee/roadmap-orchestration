// Mechanical review markers and the independent verifier's annotation/diagnosis calls.
import { freshJudgmentSession, resumedJudgmentSession } from '../backends/argv.ts';
import type { ReviewItem, SurfaceFact } from '../core/events.ts';
import type { UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { SpecM1 } from '../core/records.ts';
import { absPath } from '../core/values.ts';
import { appliedRevisions } from '../holistic/coverage.ts';
import { type PlanUnit, environmentOf } from '../input/plan.ts';
import { pathSystems, systemTraits } from '../input/systems.ts';
import { keepInput } from '../input/inforce.ts';
import { promptFor, renderPrompt } from '../prompts/index.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import type { MethodContext } from '../prompts/method/index.ts';
import { validateGateOutput } from '../prompts/schemas.ts';
import { BRIEF_INPUT } from './rounds.ts';
import { type StageContext, type StageParent, callBackend, judgmentDeadlineMs, dispatchOf, verifierDispatch } from './dispatch.ts';
import { holisticInForce, integrationTip, library, loadUnitSpec, judgedAnswer, inMs, recordedCall, unitMilestones } from './stages.ts';
import { mapInForce } from './lanes.ts';
import { renderSpec } from '../spec/render.ts';

export type Marker = Extract<SurfaceFact, {kind: 'review-triggered'}>['marker'];
/** P3b replaces this source with its calibrated attempt signal; all attempts count. */
export function diagnosisDue(view: JournalView, unit: UnitId): boolean {
  const u = view.unit(unit);
  const starts = view.opsOf('proc.spawn').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.expect.subject.purpose === 'backend');
  const builds = new Set(starts.filter((i) => i.parent.type === 'stage' && i.parent.stage === 'build').map((i) => i.parent.type === 'stage' ? i.parent.attempt : 0)).size;
  const judged = u.counters.attempts;
  const stages = typeof judged === 'number' ? judged : 0;
  // Count only judged stages, not quiesce/evidence/salvage/teardown bookkeeping.
  const attempts = new Set(view.opsOf('proc.spawn').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && ['plan-check', 'build', 'lanes', 'gate'].includes(i.parent.stage)).map((i) => i.parent.type === 'stage' ? `${i.parent.stage}:${i.parent.attempt}` : '')).size;
  void stages;
  return builds >= 8 || attempts >= 20;
}
export function proofNotLocal(ctx: StageContext, unit: PlanUnit): boolean {
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
export function markers(ctx: StageContext, unit: PlanUnit, spec: SpecM1): readonly Readonly<{marker: Marker; source: string}>[] {
  if (unit.review === 'never') return [];
  const out: {marker: Marker; source: string}[] = [];
  if ((mapInForce(ctx.journal.view) === null ? [] : systemTraits(mapInForce(ctx.journal.view)!, unit.systems)).length > 0) out.push({marker: 'M1', source: 'dispatch:system-traits'});
  if (proofNotLocal(ctx, unit)) out.push({marker: 'M2', source: 'dispatch:witnesses'});
  for (const r of appliedRevisions(ctx)) {
    const changes = r.payload.changes;
    if (changes.some((c) => c.type === 'obligation' && ['edited', 'disposed', 'split'].includes(c.edit) && (spec.obligations ?? []).includes(c.id))) out.push({marker: 'M3', source: `apply:${r.payload.rev}:obligations`});
    // Corpus changes are narrowed to the unit's cited rules below by comparing kept pins.
    if (changes.some((c) => c.type === 'corpus') && /\bT-\d+\b/.test(renderSpec(spec))) out.push({marker: 'M3', source: `apply:${r.payload.rev}:corpus`});
  }
  if (unit.review === 'always') out.push({marker: 'always', source: 'override'});
  return out;
}
export function methodContext(ctx: StageContext, unit: PlanUnit, spec: SpecM1, touched: readonly string[] = []): MethodContext {
  const map = mapInForce(ctx.journal.view);
  const systems = [...unit.systems, ...touched.flatMap((p) => map === null ? [] : [...pathSystems(map, p as import('../core/values.ts').RepoPath)])];
  const milestones = unitMilestones(ctx, unit.id, integrationTip(ctx));
  return { traits: map === null ? [] : systemTraits(map, systems), markers: markers(ctx, unit, spec).map((m) => m.marker), unitKind: milestones?.of.some((m) => m.as === 'design') ? 'design' : spec.design?.kind ?? 'module', expensiveLanes: [...spec.lanes, ...ctx.plan().suite.lanes].some((l) => (l as {cost?: string}).cost === 'expensive'), ui: milestones?.of.some((m) => m.dirs.length > 0) ?? false };
}
export function reviewItems(view: JournalView, unit: UnitId): readonly ReviewItem[] {
  return view.surfaceFacts().flatMap((f) => f.kind === 'review-completed' && f.unit === unit && f.mode === 'pre-build' ? f.items : []);
}
export const diagnosed = (view: JournalView, unit: UnitId): boolean => view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit && f.marker === 'M4');

/** An annotation never holds the unit, including a failed independent review. */
export async function runReview(ctx: StageContext, unit: PlanUnit, parent: StageParent, mode: 'pre-build' | 'diagnosis'): Promise<void> {
  const { spec } = loadUnitSpec(ctx, unit);
  const view = ctx.journal.view;
  if (unit.review === 'never') return;
  if (view.surfaceFacts().some((f) => f.kind === 'review-completed' && f.unit === unit.id && f.mode === mode && (mode === 'diagnosis' || f.specRev === spec.rev))) return;
  const triggers = mode === 'diagnosis' ? diagnosisDue(view, unit.id) ? [{marker: 'M4' as const, source: 'attempts:8-builds-or-20-judged'}] : [] : markers(ctx, unit, spec);
  if (triggers.length === 0) return;
  for (const t of triggers) if (!view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit.id && f.specRev === spec.rev && f.marker === t.marker && f.source === t.source)) ctx.journal.fact({kind: 'review-triggered', unit: unit.id, specRev: spec.rev, ...t});
  const seated = verifierDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') throw new Error('review routing could not re-pin');
  const dispatch = seated.dispatch;
  const prompt = promptFor('verifier', dispatch.triple.model);
  const measured = renderPrompt(prompt, { mode, brief: { spec: {unit: unit.id, rev: spec.rev, markdown: renderSpec(spec)}, intent: spec.intent, nonGoals: spec.nonGoals, contracts: library(ctx, spec, integrationTip(ctx)).contracts, systems: unit.systems, method: methodContext(ctx, unit, spec), history: mode === 'diagnosis' ? view.unit(unit.id).failures.map((f) => `${f.fact.stage}: ${f.fact.outcome}`) : [], standing: reviewItems(view, unit.id) } });
  const session = freshJudgmentSession();
  const call = (repair?: readonly string[]) => callBackend(ctx, {unit: unit.id, parent, request: {kind: 'judgment', dispatch, session: repair === undefined ? session : resumedJudgmentSession(session.id), evidenceDirs: []}, system: prompt.system, rendered: repair === undefined ? measured.rendered : judgmentRepairDirective(repair), prompt: repair === undefined ? measured.prompt : null, schema: prompt.schema, cwd: ctx.repo, deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(view, unit.id)))});
  let called = recordedCall(ctx, parent) ?? await call();
  let judged = judgedAnswer(called, validateGateOutput);
  if (judged.kind === 'refused') { called = await call(judged.reasons); judged = judgedAnswer(called, validateGateOutput); }
  const items = judged.kind === 'answered' ? judged.out.findings.map((f, n) => ({id: `${called.inv}:${n}`, text: f.text, evidence: [...f.experiments.map((e) => `${e.command}: ${e.output}`), ...(f.path === null ? [] : [f.path])]})) : [];
  const note = mode === 'diagnosis' ? keepInput(ctx.runDir, Buffer.from(judged.kind === 'answered' ? [...judged.out.reasons, ...items.map((f) => `${f.text} (${f.evidence.join('; ')})`)].join('\n') : 'Independent diagnosis returned no usable answer; inspect prior build and lane evidence.'), BRIEF_INPUT) : null;
  ctx.journal.fact({kind: 'review-completed', unit: unit.id, mode, specRev: spec.rev, inv: called.inv, items, note});
}
