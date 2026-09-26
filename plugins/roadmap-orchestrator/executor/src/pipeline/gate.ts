// The gate stage (plan "Pipeline", gate row; Authority and Gate inputs, R2; DESIGN-1.0.md §4 Independence).
//
// A fresh judgment session (never a resume) on the gate role's seat, which a pending risk promotion or a
// route-up moves to the escalation seat (judgmentDispatch). Its inputs, snapshotted at the integration tip
// T the gate judges against: the rendered spec, the spec's cited contracts and active C-nn rulings in full
// and an index of the rest (arc-1 feedback item 12), the architecture doc or its digest, the Direction, the
// approving plan-check's notes, the merge-base diff `diffBase(T, head)..head` (recomputed on every call, so
// after a merge-in the base is T), the lane ledger of the unit's latest spec series and its evidence dirs,
// the build's evidence (decisions.json), the pinned scope envelope and the diff's paths outside it, and on
// a later round the prior round's handoff: its directives, findings and premises, the paths the fix changed
// and the premise files whose blobs changed since (items 25, 29). The session reads the green verification
// checkout, read-only, and the rulings ledger's directory.
//
// Outcomes: approve (an `approval` fact binds it to the fingerprint, then the stage-outcome) · revise
// (a fix round with the directives, bounded by the table) · escalate (route up) · an empty diff is refused
// before any call (park) · refusal, malformed and faults as at plan-check.
//
// The approval fingerprint (R2) = {unitCommit, specRev, contractRevs, rulingRevs}: contractRevs are the
// blob ids at T of every cited contract, the architecture doc and its digest when the plan names one,
// rulingRevs the revision of every cited active C-nn. Before `integration.ff` it is recomputed at the tip
// being published onto; any difference re-gates.
import { matchesGlob } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import type { IntentOf } from '../core/events.ts';
import { type JudgmentSessionId, type Sha, type UnitId, invocationId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, repoPath } from '../core/values.ts';
import { git, refTarget, revParse } from '../git/git.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import type { PlanUnit } from '../input/plan.ts';
import { promptFor } from '../prompts/index.ts';
import type { GatePriorRound } from '../prompts/inputs.ts';
import { type GateOutput, validateGateOutput } from '../prompts/schemas.ts';
import { renderSpec } from '../spec/render.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, JUDGMENT_DEADLINE_MS, type StageContext, type StageParent, callBackend, dispatchOf, judgmentDispatch, unitBranch, verdictOf,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { latestSeries, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import {
  type StageDone, architecture, at, changedPremiseFiles, inMs, integrationTip, judgmentOutput, judgmentSpawns, ledger, ledgerDir, library, loadUnitSpec,
  planCheckNotes, record, start, verdictKind,
} from './stages.ts';

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
 * revision now, the blob ids at `tip` of the contracts the spec cites and of the architecture doc (and its
 * digest), and the cited active rulings' revisions. M1's C-nn ledger has no supersede beyond the withdrawn
 * fold (a ruling id listed twice is refused where the ledger is read), so every active ruling is at
 * revision 1; a cited ruling that is withdrawn leaves the set, which changes the fingerprint.
 */
export function fingerprintAt(ctx: StageContext, unit: PlanUnit, tip: Sha): ApprovalFingerprint {
  const { spec } = loadUnitSpec(ctx, unit);
  const digest = ctx.plan.architectureDigest;
  const paths = [...new Set<RepoPath>([...spec.cites.contracts, ctx.plan.architectureDoc, ...(digest === undefined ? [] : [digest])])].sort();
  const rulings = ledger(ctx).filter((r) => r.status === 'active' && spec.cites.rulings.includes(r.id)).map((r) => r.id);
  return {
    unitCommit: unitTip(ctx, unit.id),
    specRev: spec.rev,
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

const gateSpawns = (ctx: StageContext, unit: UnitId) => judgmentSpawns(ctx, unit, 'gate');

/** The directives of the gate attempt `parent`, which revised. */
export function gateDirectives(ctx: StageContext, parent: StageParent): readonly string[] {
  const spawn = gateSpawns(ctx, parent.unit).filter((i) => canonicalJson(i.parent) === canonicalJson(parent)).at(-1);
  const out = spawn === undefined ? null : judgmentOutput(ctx, spawn, validateGateOutput);
  if (out === null || out.decision !== 'revise') throw new Error(`gate ${parent.unit}#${parent.attempt} recorded revise without a revise answer`);
  return out.directives;
}

/** The diff head a gate spawn judged: the commit of the verification checkout it ran in. */
function judgedHead(ctx: StageContext, spawn: IntentOf<'proc.spawn'>): Sha {
  const inv = invocationId(spawn.op, spawn.ordinal);
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null) throw new Error(`${inv}: a gate spawn without launch.json`);
  const created = ctx.journal.view.opsOf('worktree.create').find((i) => i.expect.path === launch.cwd);
  if (created === undefined || created.expect.checkout.type !== 'detached') throw new Error(`${inv}: the gate ran in ${launch.cwd}, which is no verification checkout`);
  return created.expect.checkout.at;
}

/**
 * The round handoff of a gate after its own revise (arc-1 feedback item 29): the unit's latest gate answer,
 * when it revised, with its directives, findings and premises; the paths the fix changed between the head
 * that round judged and `head`; and the premise files whose blobs differ between the two.
 */
function priorRound(ctx: StageContext, unit: UnitId, head: Sha): GatePriorRound | null {
  const spawns = gateSpawns(ctx, unit);
  for (let i = spawns.length - 1; i >= 0; i--) {
    const spawn = spawns[i]!;
    const out = judgmentOutput(ctx, spawn, validateGateOutput);
    if (out === null) continue;
    if (out.decision !== 'revise') return null;
    const then = judgedHead(ctx, spawn);
    const fixPaths = git(ctx.repo, ['diff', '--name-only', '--no-renames', '-z', then, head]).split('\0').filter((p) => p !== '').map((p) => repoPath(p));
    return {
      directives: out.directives, findings: out.findings, premises: out.premises, fixPaths,
      changedPremiseFiles: changedPremiseFiles(ctx, out.premises, [[then, head]]),
    };
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
  const laneLedger = seriesLedger(ctx, series, spec.lanes, head, specSeriesRoot(ctx.runDir, series));
  const evidence = [...laneLedger.map((l) => l.evidenceDir), ...buildEvidence(ctx, unit.id)];
  const base = diffBase(ctx.repo, tip, head);
  const growth = paths.filter((p) => !pinned.scope.some((g) => matchesGlob(p, g)));

  const seated = judgmentDispatch(ctx, unit.id, 'gate');
  if (seated.kind !== 'pinned') return { ...record(ctx, parent, 'routing-changed', seated.needsUser), session: null, fingerprint: null };
  const seat = seated.dispatch;
  const prompt = promptFor('gate', seat.triple.model);
  const session = freshJudgmentSession();
  const rendered = prompt.render({
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, ...library(ctx, spec, tip), architecture: architecture(ctx, tip),
    direction: ctx.plan.direction, planCheckNotes: planCheckNotes(ctx, unit.id),
    diff: { base, head, text: git(ctx.repo, ['diff', '--no-color', '--no-renames', base, head]) },
    laneLedger, evidence, scope: { patterns: pinned.scope, growth }, priorRound: priorRound(ctx, unit.id, head),
  });
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session, evidenceDirs: [...evidence, ledgerDir(ctx)] },
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
