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
// The approval fingerprint (R2) = {unitCommit, specRev, contractRevs, rulingRevs, obligationRevs, corpus}: contractRevs
// are the blob ids at T of every cited contract, the architecture doc and its digest when the plan names one,
// rulingRevs the effective revision of every cited active C-nn (M3: bumped by each partial supersession of it,
// `effectiveRulingRevs`), obligationRevs (M3) the revision of every selected, non-exempt obligation in force (absent
// when none), corpus (M4a, R6) the sha256 of a corpus arc's whole pin in force (absent outside one), so a re-pin
// re-gates every approval. It is captured with the judgment's other inputs (Checkpoint A), and the approval records exactly that
// captured fingerprint: what the gate judged, never what moved while it ran. Before `integration.ff` it is recomputed
// at the tip being published onto; any difference re-gates.
//
// M4a: a corpus arc's gate reads the rules index and the pinned corpus materialised read-only without the vision
// document (`gateTarget`, M3 R17), its directory added to the session's readable dirs.
//
// Debt (M4a R7, DEBT_BANK): an approval in a corpus arc banks each `note` finding of the approving answer as a
// `gate-note` debt item, keyed by its source `(unit, attempt, index)` and deduped by `debtKey` against the baseline's
// ledger and the arc's banked items (`mintDebt`), right after the `approval` fact. A crash between the two is finished
// from the consumed answer at recovery: `gateRead` re-reads it, keeps the approval, and banks only what is missing.
//
// M3: the gate grades against the obligations its diff selects (`selectObligations`, src/holistic/impact.ts: the
// spec's declared ones and repairs, its dependency closure's declared ones, what the diff's paths touch, the future
// ones it delivers, every must-hold one for an unmapped path), never the vision (R17).
//
// Entry and inputs (A1, F1, H2; Checkpoint A): the gate reads its inputs and writes `judgment-inputs{tip: T, head,
// fingerprint}` in one synchronous capture under the revision fence (`captureUnderFence`), then takes `@cpu`×1
// (stages.ts `enterJudgment`), then spawns: it never holds `@cpu` while waiting for the fence. A call recovery closed
// after a crash is consumed against those inputs (`consumeJudgment`): its approval records the captured fingerprint;
// ff then finds a contract another unit's publication changed, or a ruling a docs publication superseded
// (`fingerprint-invalid`, a re-gate).
import { matchesGlob } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import { crashPoint } from '../core/crash.ts';
import { normalizeText } from '../corpus/rules.ts';
import { mintDebt } from '../debt/mint.ts';
import { baselineDebtAt } from '../phase0/rows.ts';
import type { IntentOf } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JudgmentSessionId, type ObligationId, type Sha, type UnitId, invocationId, canonicalIds, compareIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type ApprovalFingerprint, type ObligationRev, specObligations, specRepairs } from '../core/records.ts';
import { selectObligations } from '../holistic/impact.ts';
import { effectiveRulingRevs } from '../spec/rulings.ts';
import { type ObligationDef, isExempt } from '../holistic/types.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, repoPath } from '../core/values.ts';
import { git, refTarget, revParse } from '../git/git.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import { type PlanUnit, targetDocumentPaths } from '../input/plan.ts';
import { promptFor } from '../prompts/index.ts';
import type { GatePriorRound } from '../prompts/inputs.ts';
import { type GateOutput, validateGateOutput } from '../prompts/schemas.ts';
import { renderSpec } from '../spec/render.ts';
import { runnerFiles } from '../runner/files.ts';
import type { JsonValue } from '../core/json.ts';
import type { NeedsUserContent } from '../core/records.ts';
import {
  type BackendCallOutcome, type Cancelled, type JudgmentDispatch, type StageContext, type StageParent, callBackend, cancelledNow, dispatchOf, isCancelled, judgmentDeadlineMs,
  judgmentDispatch, unitBranch, verdictOf,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { latestSeries, observedViews, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import {
  type PlanCheckDone, type StageDone, at, changedPremiseFiles, corpusInForce, enterJudgment, gateTarget, holisticInForce, inMs, integrationTip, judgmentOutput,
  judgmentSpawns, ledger, ledgerDir, library, loadUnitSpec, planCheckNotes, planCheckRead, record, releaseJudgment, rulingSidecars, start, targetDirs, verdictKind,
  writeJudgmentInputs,
} from './stages.ts';

/** The unit's approved-or-not commit: its branch tip, which every build round and merge-in moves. */
export function unitTip(ctx: StageContext, unit: UnitId): Sha {
  const tip = refTarget(ctx.repo, unitBranch(ctx.plan().arc, unit));
  if (tip === null) throw new Error(`unit ${unit} has no branch ${unitBranch(ctx.plan().arc, unit)}`);
  return tip;
}

// ---------------------------------------------------------------------------------------------------
// The approval fingerprint

/**
 * The fingerprint an approval of `unit` at integration tip `tip` binds to: the unit's commit now, its spec
 * revision now, the blob ids at `tip` of the contracts the spec cites and of the architecture doc (and its
 * digest), and the cited active rulings' effective revisions: 1, raised by each partial supersession of it
 * (`effectiveRulingRevs` over the sidecars in force). A cited
 * ruling that is withdrawn (fully superseded) leaves the set; both change the fingerprint. In a corpus arc, the pin in
 * force (R6).
 */
export function fingerprintAt(ctx: StageContext, unit: PlanUnit, tip: Sha): ApprovalFingerprint {
  const { spec } = loadUnitSpec(ctx, unit);
  const paths = [...new Set<RepoPath>([...spec.cites.contracts, ...targetDocumentPaths(ctx.plan())])].sort();
  const rulings = ledger(ctx).filter((r) => r.status === 'active' && spec.cites.rulings.includes(r.id)).map((r) => r.id);
  const revs = effectiveRulingRevs(rulingSidecars(ctx));
  const head = unitTip(ctx, unit.id);
  // Choice 1 of M3 0a: absent exactly when no obligation is selected.
  const obligationRevs: readonly ObligationRev[] = selected(ctx, unit, tip, head).filter((o) => !isExempt(o)).map((o) => ({ id: o.id, rev: o.rev }));
  return {
    unitCommit: head,
    specRev: spec.rev,
    contractRevs: paths.map((path) => ({ path, blob: revParse(ctx.repo, `${tip}:${path}`) })),
    rulingRevs: canonicalIds(rulings).map((id) => ({ id, rev: revs.get(id) ?? 1 })),
    ...(obligationRevs.length === 0 ? {} : { obligationRevs }),
    ...(ctx.plan().target === 'corpus' ? { corpus: corpusInForce(ctx).pin.sha256 } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// The obligations a unit's diff selects (M3)

/** The unit's dependency closure in the plan in force: every unit it runs `after`, transitively. */
function dependencyClosure(ctx: StageContext, unit: PlanUnit): readonly PlanUnit[] {
  const byId = new Map(ctx.plan().units.map((u) => [u.id, u]));
  const seen = new Set<UnitId>();
  const walk = (u: PlanUnit): void => {
    for (const d of u.after) {
      const dep = byId.get(d);
      if (dep === undefined || seen.has(d)) continue;
      seen.add(d);
      walk(dep);
    }
  };
  walk(unit);
  return [...seen].sort().map((id) => byId.get(id)!);
}

/**
 * The obligations in force the unit's candidate diff `tip..head` (its merge base with `tip`) selects, ascending by id
 * (`selectObligations`); none outside a holistic arc with obligations. A repair of a finding repairs its obligation.
 */
export function selected(ctx: StageContext, unit: PlanUnit, tip: Sha, head: Sha): readonly ObligationDef[] {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return [];
  const { spec } = loadUnitSpec(ctx, unit);
  const findings = ctx.journal.view.holistic().findings;
  const repairs = specRepairs(spec).flatMap((r): ObligationId[] => {
    if (r.startsWith('I-')) return [r as ObligationId];
    const o = findings.find((f) => f.id === r)?.obligation ?? null;
    return o === null ? [] : [o];
  });
  const ids = selectObligations({
    obligations,
    units: [{ unit: unit.id, declared: specObligations(spec), repairs }],
    closure: dependencyClosure(ctx, unit).flatMap((u) => specObligations(loadUnitSpec(ctx, u).spec)),
    changedPaths: unitDiffPaths(ctx.repo, tip, head),
    revised: [],
  });
  return ids.map((id) => obligations.obligations.find((o) => o.id === id)!);
}

/**
 * A fingerprint with its revision lists in canonical id order. They are sets: a fingerprint recorded before 1.0.0-dev.7
 * lists them in string order (`C-10` before `C-9`, SCHEMAS.md "Record evolution"), and still holds against the same set.
 */
const canonicalFingerprint = (fp: ApprovalFingerprint): ApprovalFingerprint => ({
  ...fp,
  rulingRevs: [...fp.rulingRevs].sort((x, y) => compareIds(x.id, y.id)),
  ...(fp.obligationRevs === undefined ? {} : { obligationRevs: [...fp.obligationRevs].sort((x, y) => compareIds(x.id, y.id)) }),
});
const sameFingerprint = (a: ApprovalFingerprint, b: ApprovalFingerprint): boolean => canonicalJson(canonicalFingerprint(a)) === canonicalJson(canonicalFingerprint(b));

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

/** What a gate attempt's capture found: nothing to judge, a routing change, or its inputs (their fact written). */
type GateCapture =
  | Readonly<{ kind: 'empty-diff' }>
  | Readonly<{ kind: 'routing-changed'; needsUser: NeedsUserContent }>
  | Readonly<{
    kind: 'captured'; fingerprint: ApprovalFingerprint; seat: JudgmentDispatch; rendered: string; system: string; schema: JsonValue; evidence: readonly AbsPath[]; cwd: AbsPath;
    /** Beside the evidence: the target's readable dirs (a corpus arc's materialised pin). */
    dirs: readonly AbsPath[];
  }>;

export async function gate(ctx: StageContext, unit: PlanUnit): Promise<GateDone | Cancelled> {
  const parent = at(start(ctx, unit.id, 'gate'), 'gate');
  // A cancelled task captures nothing (its `@cpu` wait, after the capture, would be cancelled at once).
  const cancelled = cancelledNow(ctx);
  if (cancelled !== null) return cancelled;

  // H2: every input read, the approval fingerprint among them, and `judgment-inputs` written in one synchronous
  // capture under the revision fence, BEFORE the `@cpu` entry (Checkpoint A: never hold `@cpu` waiting for the fence).
  const captured = await captureUnderFence(ctx.journal, (): GateCapture => {
    const { spec, sha256 } = loadUnitSpec(ctx, unit);
    const tip = integrationTip(ctx);
    const head = unitTip(ctx, unit.id);
    const paths = unitDiffPaths(ctx.repo, tip, head);
    // An approved empty diff is refused at the gate (DESIGN §3 "Merge"); with nothing to judge, no call is made.
    if (paths.length === 0) return { kind: 'empty-diff' };
    const series = latestSeries(ctx.journal.view, unit.id, 'spec');
    const tree = series === null ? null : seriesTree(ctx.journal.view, series);
    if (series === null || tree === null || tree.at !== head) throw new Error(`gate of ${unit.id}: no green verification checkout at ${head}`);
    const seated = judgmentDispatch(ctx, unit.id, 'gate');
    if (seated.kind !== 'pinned') return { kind: 'routing-changed', needsUser: seated.needsUser };
    const pinned = dispatchOf(ctx.journal.view, unit.id);
    const laneLedger = seriesLedger(ctx, series, spec.lanes, head, specSeriesRoot(ctx.runDir, series));
    const evidence = [...laneLedger.map((l) => l.evidenceDir), ...buildEvidence(ctx, unit.id)];
    const base = diffBase(ctx.repo, tip, head);
    const growth = paths.filter((p) => !pinned.scope.some((g) => matchesGlob(p, g)));
    const seat = seated.dispatch;
    const prompt = promptFor('gate', seat.triple.model);
    const target = gateTarget(ctx, tip);
    const rendered = prompt.render({
      spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, ...library(ctx, spec, tip), target,
      direction: ctx.plan().direction, planCheckNotes: planCheckNotes(ctx, unit.id),
      obligations: observedViews(ctx, holisticInForce(ctx).obligations, selected(ctx, unit, tip, head), tip),
      diff: { base, head, text: git(ctx.repo, ['diff', '--no-color', '--no-renames', base, head]) },
      laneLedger, evidence, scope: { patterns: pinned.scope, growth }, priorRound: priorRound(ctx, unit.id, head),
    });
    const fingerprint = fingerprintAt(ctx, unit, tip);
    writeJudgmentInputs(ctx, parent, { tip, head, specRev: spec.rev, specSha256: sha256, routingRev: seat.routingRev, fingerprint });
    return { kind: 'captured', fingerprint, seat, rendered, system: prompt.system, schema: prompt.schema, evidence, cwd: tree.path, dirs: targetDirs(target) };
  });
  if (captured.kind !== 'captured') {
    const done = captured.kind === 'empty-diff' ? record(ctx, parent, 'empty-diff') : record(ctx, parent, 'routing-changed', captured.needsUser);
    return { ...done, session: null, fingerprint: null };
  }
  const entered = await enterJudgment(ctx, parent);
  if (isCancelled(entered)) return entered;
  const { fingerprint, seat } = captured;
  const session = freshJudgmentSession();
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session, evidenceDirs: [...captured.evidence, ledgerDir(ctx), ...captured.dirs] },
    system: captured.system, rendered: captured.rendered, schema: captured.schema, cwd: captured.cwd,
    deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(ctx.journal.view, unit.id))),
  });
  return gateRead(ctx, unit, parent, called, session.id, fingerprint);
}

/**
 * Records a gate attempt from its call: the live one, or one recovery closed after a crash (`consumeJudgment`,
 * never asked again). `fingerprint` is the one captured with the inputs it judged (its `unitCommit` the head it
 * read): an approval records exactly it, and ff re-checks it against the inputs then in force. An approval fact
 * this attempt already recorded is kept, not recorded twice.
 */
export async function gateRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'gate' }>, called: BackendCallOutcome, session: JudgmentSessionId,
  fingerprint: ApprovalFingerprint,
): Promise<GateDone> {
  // The session has ended: its @cpu goes before anything is recorded.
  await releaseJudgment(ctx, parent);
  const done = (d: StageDone<'gate'>, fingerprint: ApprovalFingerprint | null = null): GateDone => ({ ...d, session, fingerprint });
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return done(verdictKind(ctx, parent, v, called));

  let out: GateOutput;
  try {
    out = validateGateOutput(v.value);
  } catch (error) {
    if (error instanceof SchemaError) return done(record(ctx, parent, 'malformed'));
    throw error;
  }
  if (out.decision !== 'approve') return done(record(ctx, parent, out.decision));
  const approved = ctx.journal.view.unit(unit.id).approval;
  if (approved !== null && approved.attempt === parent.attempt) {
    bankGateNotes(ctx, unit.id, parent.attempt, out.findings);
    return done(record(ctx, parent, 'approve'), approved.fingerprint);
  }
  const head = unitTip(ctx, unit.id);
  if (head !== fingerprint.unitCommit) throw new Error(`gate of ${unit.id}: the unit branch moved from ${fingerprint.unitCommit} to ${head} during the gate`);
  ctx.journal.fact({ kind: 'approval', unit: unit.id, attempt: parent.attempt, fingerprint });
  bankGateNotes(ctx, unit.id, parent.attempt, out.findings);
  return done(record(ctx, parent, 'approve'), fingerprint);
}

/**
 * Banks the approving answer's `note` findings of a corpus arc as `gate-note` debt (R7), after its `approval`: each
 * keyed by `(unit, attempt, index)`, its index the finding's place in the answer, and minted against the baseline's
 * ledger and the arc's banked items (`mintDebt`: a source or a key already banked mints nothing). A note whose text is
 * blank names no debt and is not banked. Only a corpus arc banks: its Phase 0 dispositions the ledger it publishes.
 */
function bankGateNotes(ctx: StageContext, unit: UnitId, attempt: number, findings: GateOutput['findings']): void {
  if (ctx.plan().target !== 'corpus') return;
  const notes = findings.flatMap((f, index) => (f.severity === 'note' && normalizeText(f.text) !== '' ? [{ index, what: f.text }] : []));
  if (notes.length === 0) return;
  crashPoint('debt.after-approval', unit);
  const baseline = baselineDebtAt(ctx.repo, ctx.plan().baseline);
  for (const n of notes) {
    const fact = mintDebt(baseline, ctx.journal.view.holistic().debt, { type: 'gate-note', unit, attempt, index: n.index, what: n.what });
    if (fact !== null) ctx.journal.fact(fact);
  }
}

// ---------------------------------------------------------------------------------------------------
// A judgment call a crash left unrecorded (F1)

/**
 * Records a plan-check or gate attempt from the call recovery closed after a crash, against the attempt's
 * durable `judgment-inputs`: a gate's approval records the fingerprint captured with them (`gateRead`), so it
 * binds what it reviewed, whatever moved since. The unit driver calls it in place of a read at the current tip.
 */
export async function consumeJudgment(
  ctx: StageContext, unit: PlanUnit, parent: StageParent, called: BackendCallOutcome,
): Promise<PlanCheckDone | GateDone> {
  if (called.kind === 'lost') throw new Error(`${called.inv}: a lost judgment call is never consumed`);
  const { result } = called;
  if (result.role === 'build') throw new Error(`${called.inv}: an implementer result at ${parent.stage}`);
  switch (parent.stage) {
    case 'plan-check':
      return planCheckRead(ctx, unit, at(parent, 'plan-check'), called, result.session);
    case 'gate': {
      const inputs = ctx.journal.view.judgmentInputs(unit.id, 'gate', parent.attempt);
      if (inputs === null) throw new Error(`gate ${unit.id}#${parent.attempt}: a judgment call without judgment-inputs`);
      const fingerprint = inputs.fingerprint;
      if (fingerprint === undefined) throw new Error(`gate ${unit.id}#${parent.attempt}: judgment-inputs without a fingerprint`);
      if (fingerprint.unitCommit !== inputs.head) throw new Error(`gate ${unit.id}#${parent.attempt}: the unit branch moved from ${inputs.head} since its judgment-inputs`);
      return gateRead(ctx, unit, at(parent, 'gate'), called, result.session, fingerprint);
    }
    default:
      throw new Error(`${unit.id} ${parent.stage}#${parent.attempt}: no judgment call to consume`);
  }
}
