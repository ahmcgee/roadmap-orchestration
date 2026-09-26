// The gate stage (plan "Pipeline", gate row; Authority and Gate inputs, R2; DESIGN-1.0.md §4 Independence).
//
// A fresh judgment session (never a resume) on the gate role's seat, which a pending risk promotion or a
// route-up moves to the high seat (judgmentDispatch). Its inputs, snapshotted at the integration tip T the
// gate judges against: the rendered spec, the cited contracts and C-nn rulings, the architecture doc, the
// Direction, the merge-base diff `diffBase(T, head)..head` (recomputed on every call, so after a merge-in
// the base is T), the lane ledger of the unit's latest spec series and its evidence dirs, the build's
// evidence (decisions.json), the pinned scope envelope and the diff's paths outside it, and on a later round
// the prior revise directives. The session reads the green verification checkout, read-only.
//
// Outcomes: approve (an `approval` fact binds it to the fingerprint, then the stage-outcome) · revise
// (a fix round with the directives, bounded by the table) · escalate (route up) · an empty diff is refused
// before any call (park) · refusal, malformed and faults as at plan-check.
//
// The approval fingerprint (R2) = {unitCommit, specRev, contractRevs, rulingRevs}: contractRevs are the
// blob ids at T of every cited contract and the architecture doc, rulingRevs the revision of every cited
// C-nn. Before `integration.ff` it is recomputed at the tip being published onto; any difference re-gates.
import { matchesGlob } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import type { IntentOf } from '../core/events.ts';
import { type JudgmentSessionId, type Sha, type UnitId, invocationId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath, RepoPath } from '../core/values.ts';
import { git, refTarget, revParse } from '../git/git.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import type { PlanUnit } from '../input/plan.ts';
import { promptFor } from '../prompts/index.ts';
import { type GateOutput, validateGateOutput } from '../prompts/schemas.ts';
import { renderSpec } from '../spec/render.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, JUDGMENT_DEADLINE_MS, type StageContext, type StageParent, callBackend, dispatchOf, judgmentDispatch, unitBranch, verdictOf,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { latestSeries, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import { type StageDone, at, documents, inMs, integrationTip, loadRulings, loadUnitSpec, record, start, verdictKind } from './stages.ts';

/** The unit's approved-or-not commit: its branch tip, which every build round and merge-in moves. */
export function unitTip(ctx: StageContext, unit: UnitId): Sha {
  const tip = refTarget(ctx.repo, unitBranch(ctx.plan.arc, unit));
  if (tip === null) throw new Error(`unit ${unit} has no branch ${unitBranch(ctx.plan.arc, unit)}`);
  return tip;
}

// ---------------------------------------------------------------------------------------------------
// The approval fingerprint

/**
 * The fingerprint an approval of `unit` at integration tip `tip` binds to: the unit's commit now, its spec
 * revision now, the blob ids at `tip` of the cited contracts and the architecture doc, and the cited
 * rulings' revisions. M1's C-nn ledger has one line per ruling and no supersede mechanism (M3), so every
 * cited ruling is at revision 1; a ruling id listed twice is refused.
 */
export function fingerprintAt(ctx: StageContext, unit: PlanUnit, tip: Sha): ApprovalFingerprint {
  const paths = [...new Set<RepoPath>([...ctx.plan.contracts, ctx.plan.architectureDoc])].sort();
  const rulings = loadRulings(ctx).map((r) => r.id);
  const repeated = rulings.find((id, i) => rulings.indexOf(id) !== i);
  if (repeated !== undefined) throw new Error(`the rulings ledger lists ${repeated} twice; M1 has no supersede`);
  return {
    unitCommit: unitTip(ctx, unit.id),
    specRev: loadUnitSpec(ctx, unit).spec.rev,
    contractRevs: paths.map((path) => ({ path, blob: revParse(ctx.repo, `${tip}:${path}`) })),
    rulingRevs: [...rulings].sort().map((id) => ({ id, rev: 1 })),
  };
}

const sameFingerprint = (a: ApprovalFingerprint, b: ApprovalFingerprint): boolean => canonicalJson(a) === canonicalJson(b);

/** Whether an approval still holds when publishing onto `tip`. */
export function fingerprintHolds(ctx: StageContext, unit: PlanUnit, fingerprint: ApprovalFingerprint, tip: Sha): boolean {
  return sameFingerprint(fingerprintAt(ctx, unit, tip), fingerprint);
}

/** The re-check `integrationFfOp` and its reconciler take: the approval against the integration tip now. */
export function fingerprintValid(ctx: StageContext, unit: PlanUnit): (fingerprint: ApprovalFingerprint) => boolean {
  return (fingerprint) => fingerprintHolds(ctx, unit, fingerprint, integrationTip(ctx));
}

// ---------------------------------------------------------------------------------------------------
// Earlier gate rounds, read back from their results

/** The validated output of a gate spawn, or null when it has none (a fault, a refusal, a malformed answer). */
function gateOutputOf(ctx: StageContext, intent: IntentOf<'proc.spawn'>): GateOutput | null {
  if (ctx.journal.view.doneOf(intent.op)?.outcome.kind !== 'result') return null;
  const inv = invocationId(intent.op, intent.ordinal);
  const result = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('result.json');
  if (result === null || result.type !== 'backend') throw new Error(`${inv}: a done gate spawn without its backend result`);
  if (result.outcome.kind !== 'success') return null;
  try {
    return validateGateOutput(result.outcome.value);
  } catch (error) {
    if (error instanceof SchemaError) return null;
    throw error;
  }
}

const gateSpawns = (ctx: StageContext, unit: UnitId): readonly IntentOf<'proc.spawn'>[] =>
  ctx.journal.view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'backend' && s.role === 'gate' && s.unit === unit;
  });

/** The directives of the gate attempt `parent`, which revised. */
export function gateDirectives(ctx: StageContext, parent: StageParent): readonly string[] {
  const spawn = gateSpawns(ctx, parent.unit).filter((i) => canonicalJson(i.parent) === canonicalJson(parent)).at(-1);
  const out = spawn === undefined ? null : gateOutputOf(ctx, spawn);
  if (out === null || out.decision !== 'revise') throw new Error(`gate ${parent.unit}#${parent.attempt} recorded revise without a revise answer`);
  return out.directives;
}

/** The latest gate answer of the unit, when it revised: its directives are what a later round re-checks. */
function priorRound(ctx: StageContext, unit: UnitId): Readonly<{ directives: readonly string[] }> | null {
  const spawns = gateSpawns(ctx, unit);
  for (let i = spawns.length - 1; i >= 0; i--) {
    const out = gateOutputOf(ctx, spawns[i]!);
    if (out !== null) return out.decision === 'revise' ? { directives: out.directives } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The stage

export type GateDone = StageDone<'gate'> & Readonly<{ session: JudgmentSessionId | null; fingerprint: ApprovalFingerprint | null }>;

/** The build evidence dirs of the unit's latest evidence stage (stdout, stderr, decisions.json, lane outputs). */
function buildEvidence(ctx: StageContext, unit: UnitId): readonly AbsPath[] {
  const snaps = ctx.journal.view.opsOf('evidence.snapshot').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'evidence');
  const last = snaps.at(-1);
  if (last === undefined || last.parent.type !== 'stage') return [];
  const attempt = last.parent.attempt;
  return snaps.filter((i) => i.parent.type === 'stage' && i.parent.attempt === attempt).map((i) => i.expect.dest);
}

export async function gate(ctx: StageContext, unit: PlanUnit): Promise<GateDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const parent = at(start(ctx, unit.id, 'gate'), 'gate');

  const tip = integrationTip(ctx);
  const head = unitTip(ctx, unit.id);
  const paths = unitDiffPaths(ctx.repo, tip, head);
  // An approved empty diff is refused at the gate (DESIGN §3 "Merge"); with nothing to judge, no call is made.
  if (paths.length === 0) return { ...record(ctx, parent, 'empty-diff'), session: null, fingerprint: null };

  const series = latestSeries(ctx.journal.view, unit.id, 'spec');
  const tree = series === null ? null : seriesTree(ctx.journal.view, series);
  if (series === null || tree === null || tree.at !== head) throw new Error(`gate of ${unit.id}: no green verification checkout at ${head}`);
  const ledger = seriesLedger(ctx, series, spec.lanes, head, specSeriesRoot(ctx.runDir, series));
  const evidence = [...ledger.map((l) => l.evidenceDir), ...buildEvidence(ctx, unit.id)];
  const base = diffBase(ctx.repo, tip, head);
  const growth = paths.filter((p) => !pinned.scope.some((g) => matchesGlob(p, g)));

  const seat = judgmentDispatch(ctx, unit.id, 'gate');
  const prompt = promptFor('gate', seat.triple.model);
  const session = freshJudgmentSession();
  const { contracts, architectureDoc } = documents(ctx, tip);
  const rendered = prompt.render({
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, contracts, rulings: loadRulings(ctx), architectureDoc,
    direction: ctx.plan.direction,
    diff: { base, head, text: git(ctx.repo, ['diff', '--no-color', '--no-renames', base, head]) },
    laneLedger: ledger, evidence, scope: { patterns: pinned.scope, growth }, priorRound: priorRound(ctx, unit.id),
  });
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session, evidenceDirs: evidence },
    system: prompt.system, rendered, schema: prompt.schema, cwd: tree.path, deadlineAt: inMs(JUDGMENT_DEADLINE_MS),
  });
  return gateRead(ctx, unit, parent, called, session.id, tip, head);
}

/**
 * Records a gate attempt from its call: the live one, or one recovery closed after a crash (consumed by
 * the driver, never asked again). `tip` and `head` are the integration tip and unit commit it judged. An
 * approval fact this attempt already recorded is kept, not recorded twice.
 */
export function gateRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'gate' }>, called: BackendCallOutcome, session: JudgmentSessionId,
  tip: Sha, head: Sha,
): GateDone {
  const done = (d: StageDone<'gate'>, fingerprint: ApprovalFingerprint | null = null): GateDone => ({ ...d, session, fingerprint });
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return done(verdictKind(ctx, parent, v));

  let out: GateOutput;
  try {
    out = validateGateOutput(v.value);
  } catch (error) {
    if (error instanceof SchemaError) return done(record(ctx, parent, 'malformed'));
    throw error;
  }
  if (out.decision !== 'approve') return done(record(ctx, parent, out.decision));
  const approved = ctx.journal.view.unit(unit.id).approval;
  if (approved !== null && approved.attempt === parent.attempt) return done(record(ctx, parent, 'approve'), approved.fingerprint);
  const fingerprint = fingerprintAt(ctx, unit, tip);
  if (fingerprint.unitCommit !== head) throw new Error(`gate of ${unit.id}: the unit branch moved from ${head} during the gate`);
  ctx.journal.fact({ kind: 'approval', unit: unit.id, attempt: parent.attempt, fingerprint });
  return done(record(ctx, parent, 'approve'), fingerprint);
}
