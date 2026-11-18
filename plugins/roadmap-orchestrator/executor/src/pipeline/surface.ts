import { absPath } from '../core/values.ts';
import { join } from 'node:path';
import { raiseNeedsUser, raisedWithReason } from '../needsuser.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { ruleMentions } from '../holistic/rederive.ts';
import { parseCorpusPin } from '../corpus/types.ts';
import { CORPUS_INPUT, keptInput } from '../input/inforce.ts';
// Mechanical review markers and the independent verifier's annotation/diagnosis calls.
import { freshJudgmentSession } from '../backends/argv.ts';
import { type ReviewItem, type SurfaceFact, externalCause, probeTargetKey } from '../core/events.ts';
import type { LaneId, Sha256Hex, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { SpecM1 } from '../core/records.ts';
import { appliedRevisions } from '../holistic/coverage.ts';
import { type PlanUnit, environmentOf, knownDefectsOf } from '../input/plan.ts';
import { delivers } from '../input/lineage.ts';
import { pathSystems, systemTraits } from '../input/systems.ts';
import { keepInput } from '../input/inforce.ts';
import { retryableParks, trippedTargets } from '../park/schedule.ts';
import { promptFor, renderPrompt } from '../prompts/index.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import type { DiagnosisEvidence, ReviewBrief } from '../prompts/inputs.ts';
import type { MethodContext } from '../prompts/method/index.ts';
import { DIAGNOSIS_SCHEMA, validateDiagnosisOutput, validateGateOutput, validateBuildOutput } from '../prompts/schemas.ts';
import { flakyLedger, keyLabel } from './deflake.ts';
import { BRIEF_INPUT, laneFailures } from './rounds.ts';
import { type StageContext, type StageParent, callBackend, judgmentDeadlineMs, dispatchOf, verifierDispatch, runOp, repairTurnOf, verdictOf } from './dispatch.ts';
import { holisticInForce, integrationTip, library, visionInput, loadUnitSpec, judgedAnswer, judgmentOutput, inMs, recordedCall, unitMilestones, latestLaneReds, removeJudgmentCheckouts, unitTarget, targetDirs } from './stages.ts';
import { mapInForce } from './lanes.ts';
import { renderSpec } from '../spec/render.ts';

export type Marker = Extract<SurfaceFact, {kind: 'review-triggered'}>['marker'];
/** All attempts count, including interrupted and uncharged work. */
export function diagnosisDue(view: JournalView, unit: UnitId): boolean {
  const counts = view.attemptCounts(unit);
  return counts.builds >= 8 || counts.judged >= 20;
}
/** The diagnosis source of the attempt counts (`diagnosisDue`); every diagnosis before dev.83 has it. */
export const ATTEMPTS_SOURCE = 'attempts:8-builds-or-20-judged';
/** dev.83 (E2): the latest completed lanes outcomes a repeated red makes a diagnosis due after. */
const REPEAT_RED_OUTCOMES: readonly string[] = ['red', 'regression', 'witnesses-missing'];
/** dev.83 (E2): the source a repeated red of `lane` with failure signature `failure` triggers a diagnosis from. */
export const repeatRedSource = (lane: LaneId, failure: Sha256Hex): string => `repeat-red:${lane}:${failure}`;

/**
 * dev.83 (E2): the sources a diagnosis of the unit is due from now: the attempt counts (`diagnosisDue`), and each red lane of
 * its latest completed lanes attempt that repeated the unit's earlier red with the same signature (`LaneRecord.repeat`, a spec
 * lane's or a lanes-stage suite lane's) when that attempt ended red, regression or witnesses-missing.
 */
export function diagnosisSources(ctx: StageContext, unit: PlanUnit, spec: SpecM1): readonly string[] {
  const view = ctx.journal.view;
  const latest = view.completedLanesOutcome(unit.id);
  const repeats = latest !== null && REPEAT_RED_OUTCOMES.includes(latest.outcome)
    ? latestLaneReds(ctx, unit, spec).reds.flatMap((l) => (l.repeat !== null && l.failure !== null ? [repeatRedSource(l.lane, l.failure)] : []))
    : [];
  return [...(diagnosisDue(view, unit.id) ? [ATTEMPTS_SOURCE] : []), ...new Set(repeats)];
}

/** The sources of the unit's M4 triggers, every one and those after its latest diagnosis (not yet answered), in log order. */
function triggered(view: JournalView, unit: UnitId): Readonly<{ all: ReadonlySet<string>; open: readonly string[] }> {
  const all = new Set<string>();
  let open: string[] = [];
  for (const f of view.surfaceFacts()) {
    if (f.unit !== unit) continue;
    if (f.kind === 'review-triggered' && f.marker === 'M4') { all.add(f.source); open.push(f.source); }
    if (f.kind === 'review-completed' && f.mode === 'diagnosis') open = [];
  }
  return { all, open };
}

/** dev.83 (E2): the due sources no diagnosis was triggered from yet: a diagnosis runs once per source. */
export function diagnosisPending(ctx: StageContext, unit: PlanUnit, spec: SpecM1): readonly string[] {
  if (unit.review === 'never') return [];
  const done = triggered(ctx.journal.view, unit.id).all;
  return diagnosisSources(ctx, unit, spec).filter((s) => !done.has(s));
}
type MarkerContext = Readonly<{plan: StageContext['plan']; journal: Readonly<{view: JournalView}>; runDir: import('../core/values.ts').AbsPath}>;
export function proofNotLocal(ctx: MarkerContext, unit: PlanUnit): boolean {
  const obligations = holisticInForce(ctx).obligations;
  if (obligations === null) return false;
  return obligations.obligations.some((o) => {
    if (o.state.type !== 'active' || !delivers(ctx.journal.view, o, unit.id)) return false;
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
/** The diagnosis that moves the unit's remaining default builds to Claude: the attempt counts' (dev.83: never a repeated red's). */
export const diagnosed = (view: JournalView, unit: UnitId): boolean => view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit && f.marker === 'M4' && f.source === ATTEMPTS_SOURCE);

/**
 * dev.83 (E2): how a build's diagnosis attempt closes: `diagnosed-external` when the unit's latest diagnosis put the cause
 * outside the unit (base or environment) and no entry runs the build (a steer is the root's own direction, which the
 * diagnosis note informs), else `diagnosed`.
 */
export function diagnosisOutcome(view: JournalView, unit: UnitId): 'diagnosed' | 'diagnosed-external' {
  const latest = view.surfaceFacts().findLast((f) => f.kind === 'review-completed' && f.unit === unit && f.mode === 'diagnosis');
  const cause = latest?.kind === 'review-completed' ? latest.cause : undefined;
  return cause !== undefined && externalCause(cause) && view.unit(unit).entry === null ? 'diagnosed-external' : 'diagnosed';
}

/**
 * dev.83 (E2): what the executor already knows about the failures a diagnosis of `trigger` explains (inputs.ts
 * `DiagnosisEvidence`), from the unit's latest completed lanes attempt, the arc's park schedule, the plan and the flaky ledger.
 */
export function diagnosisEvidence(ctx: StageContext, unit: PlanUnit, spec: SpecM1, trigger: readonly string[]): DiagnosisEvidence {
  const view = ctx.journal.view;
  const { attempt, reds } = latestLaneReds(ctx, unit, spec);
  const lanes = new Set<string>(reds.map((l) => l.lane));
  return {
    trigger,
    failures: laneFailures(reds),
    baseComparison: view.ciFacts().flatMap((f) => (f.kind === 'lane-base-compared' && f.unit === unit.id && f.attempt === attempt ? [{ lane: f.lane, base: f.base, result: f.result, evidence: f.evidence }] : [])),
    environment: {
      tripped: trippedTargets(view).map(probeTargetKey),
      retryableParks: retryableParks(view).map((p) => `${p.unit.unit}: ${p.outstanding.map(probeTargetKey).join(', ')}`),
      hostSuspected: reds.flatMap((l) => (l.hostSuspected === null ? [] : [`${l.lane}: ${l.hostSuspected.signatures.join(', ')}${l.hostSuspected.busy ? ' (on a busy host)' : ''}`])),
    },
    knownDefects: knownDefectsOf(ctx.plan()).map((d) => `${d.id} (fixed by ${d.fixUnit}): ${canonicalJson(d.match)}`),
    flaky: flakyLedger(view, ctx.plan()).filter((e) => lanes.has(e.key.lane)).map((e) => keyLabel(e.key)),
  };
}

/** What a diagnosis keeps as its note when the verifier gave no usable answer. */
const NO_DIAGNOSIS = 'Independent review returned no usable answer; inspect prior build and lane evidence.';

/**
 * An annotation never holds the unit, including a failed independent review. dev.83 (E2): a diagnosis runs once per source
 * (`diagnosisPending`) and answers its own schema (`DIAGNOSIS_SCHEMA`): its brief is the note the next build receives, and its
 * cause is recorded for the attempt's outcome (`diagnosisOutcome`).
 */
export async function runReview(ctx: StageContext, unit: PlanUnit, parent: StageParent, mode: 'pre-build' | 'diagnosis'): Promise<void> {
  const { spec } = loadUnitSpec(ctx, unit);
  const view = ctx.journal.view;
  const capturedPlanRev = view.planApplied()!.rev;
  if (unit.review === 'never') return;
  if (mode === 'diagnosis') {
    for (const source of diagnosisPending(ctx, unit, spec)) ctx.journal.fact({kind: 'review-triggered', unit: unit.id, specRev: spec.rev, marker: 'M4', source});
    // Nothing open: the latest trigger already has its review (a crash after recording it, before the attempt's outcome).
    if (triggered(view, unit.id).open.length === 0) return;
  } else {
    const prior = view.surfaceFacts().findLast((f) => f.kind === 'review-completed' && f.unit === unit.id && f.mode === mode);
    const triggers = markers(ctx, unit, spec);
    if (prior?.kind === 'review-completed' && prior.specRev === spec.rev && !triggers.some((t) => t.marker === 'M3')) return;
    if (triggers.length === 0) return;
    for (const t of triggers) if (!view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.unit === unit.id && f.specRev === spec.rev && f.marker === t.marker && f.source === t.source)) ctx.journal.fact({kind: 'review-triggered', unit: unit.id, specRev: spec.rev, ...t});
  }
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
  const brief: ReviewBrief = {target: unitTarget(ctx, integrationTip(ctx), 'full', holisticInForce(ctx).obligations?.obligations.filter((o) => (spec.obligations ?? []).includes(o.id) || delivers(view, o, unit.id)) ?? [], ruleMentions(renderSpec(spec))), vision: visionInput(ctx), spec: {unit: unit.id, rev: spec.rev, markdown: renderSpec(spec)}, intent: spec.intent, nonGoals: spec.nonGoals, contracts: library(ctx, spec, integrationTip(ctx)).contracts, systems: unit.systems, method: methodContext(ctx, unit, spec), history: mode === 'diagnosis' ? view.unit(unit.id).failures.slice(-20).map((f) => JSON.stringify({ref: `${unit.id}/${f.fact.stage}#${f.fact.attempt}`, outcome: f.fact.outcome, detail: f.fact.detail ?? null, evidence: join(ctx.runDir, 'evidence', unit.id, `${f.fact.attempt}-${f.fact.stage}`)})) : [], standing: reviewItems(view, unit.id) };
  const measured = renderPrompt(prompt, mode === 'diagnosis' ? { mode, brief: {...brief, evidence: diagnosisEvidence(ctx, unit, spec, triggered(view, unit.id).open)} } : { mode, brief });
  const schema = mode === 'diagnosis' ? DIAGNOSIS_SCHEMA : prompt.schema;
  const session = freshJudgmentSession();
  const call = (repair?: {reasons: readonly string[]; turn: NonNullable<ReturnType<typeof repairTurnOf>>}) => callBackend(ctx, {unit: unit.id, parent, request: {kind: 'judgment', dispatch, session: repair === undefined ? session : repair.turn.session, evidenceDirs: targetDirs(unitTarget(ctx, integrationTip(ctx), 'full', [], ruleMentions(renderSpec(spec))))}, system: prompt.system, rendered: repair === undefined ? measured.rendered : judgmentRepairDirective(repair.reasons), prompt: repair === undefined ? measured.prompt : null, schema, cwd: checkout, deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(view, unit.id)))});
  /** The call (or the one a crash left recorded), judged by `validate`, with one repair turn for a refused answer. */
  const ask = async <T>(validate: (value: unknown) => T) => {
    let called = recorded ?? await call();
    const judge = (answer: typeof called) => {
      const verdict = verdictOf(ctx, parent, answer);
      if (verdict.kind === 'interrupted' && verdict.needsUser !== null && raisedWithReason(view, ctx.runDir, parent, verdict.needsUser.reason) === null) raiseNeedsUser(ctx.journal, ctx.runDir, {...verdict.needsUser, summary: `The verifier's ${mode} call ${answer.inv} hit a usage limit. Its backend is parked; the review remains an annotation and available backends may continue.`}, parent);
      return judgedAnswer(answer, validate);
    };
    let judged = judge(called);
    if (judged.kind === 'refused') { const turn = repairTurnOf(ctx.runDir, called.inv); if (turn !== null) { called = await call({reasons: judged.reasons, turn}); judged = judge(called); } }
    return { inv: called.inv, judged };
  };
  if (mode === 'diagnosis') {
    const { inv, judged } = await ask(validateDiagnosisOutput);
    if (ctx.signal.aborted) { await removeJudgmentCheckouts(ctx, unit.id, parent); return; }
    const out = judged.kind === 'answered' ? judged.out : null;
    const note = keepInput(ctx.runDir, Buffer.from(out === null ? NO_DIAGNOSIS : out.brief), BRIEF_INPUT);
    const items = out === null ? [] : [{id: `${inv}:cause`, text: `Diagnosed cause: ${out.cause}. ${out.reasons.join(' ')}`, evidence: out.evidence}];
    await removeJudgmentCheckouts(ctx, unit.id, parent);
    ctx.journal.fact({kind: 'review-completed', unit: unit.id, mode, specRev: spec.rev, planRev: capturedPlanRev, inv, items, note, ...(out === null ? {} : {cause: out.cause})});
    return;
  }
  const { inv, judged } = await ask(validateGateOutput);
  if (ctx.signal.aborted) { await removeJudgmentCheckouts(ctx, unit.id, parent); return; }
  const items = judged.kind === 'answered' ? judged.out.findings.map((f, n) => ({id: `${inv}:${n}`, text: f.text, evidence: [...f.evidence, ...f.experiments.map((e) => `${e.command}: ${e.output}`), ...(f.path === null ? [] : [f.path])]})) : [];
  const note = judged.kind !== 'answered' ? keepInput(ctx.runDir, Buffer.from(NO_DIAGNOSIS), BRIEF_INPUT) : null;
  await removeJudgmentCheckouts(ctx, unit.id, parent);
  ctx.journal.fact({kind: 'review-completed', unit: unit.id, mode, specRev: spec.rev, planRev: capturedPlanRev, inv, items, note});
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
