// The gate stage (plan "Pipeline", gate row; Authority and Gate inputs, R2; DESIGN-1.0.md §4 Independence).
//
// A fresh acting-judge session (resumed only for its repair turn; dev.13, `claude-acting-judge`) on the gate role's seat, which a pending risk promotion or a
// route-up moves to the escalation seat (judgmentDispatch), and a diff over the large-diff threshold to at least `high`
// (1.0.0-dev.12, "The large-diff gate" below). Its inputs, snapshotted at the integration tip
// T the gate judges against: the rendered spec, the spec's cited contracts and active C-nn rulings in full
// and an index of the rest (arc-1 feedback item 12), the architecture doc or its digest, the Direction, the
// approving plan-check's notes, the merge-base diff `diffBase(T, head)..head` (recomputed on every call, so
// after a merge-in the base is T; attached within `GATE_DIFF_BUDGET` by src/git/boundeddiff.ts, what it does not inline
// written beside the attempt's evidence and readable, and what it inlined recorded on `judgment-inputs`), the lane ledger of the unit's latest spec series and its evidence dirs,
// the build's evidence (decisions.json), the pinned scope envelope and the diff's paths outside it (and, scope growth
// 2026-10-15, the out-of-scope paths the unit's salvages reverted, which no diff shows), and on
// a later round the prior round's handoff: its directives, findings and premises, the paths the fix changed
// and the premise files whose blobs changed since (items 25, 29). The session runs in its own throwaway detached checkout
// of the unit's tip (the salvage SHA the green verification checkout holds; dev.13, owner 2026-10-18: `gateWorktree`), with a
// shell for ad hoc experiments and no MCP server, and reads the repository and the run dir besides (dispatch.ts
// `judgmentReadDirs`). Code makes the checkout after the attempt's `@cpu` entry and removes it (citing a snapshot of what
// the gate wrote there, its experiments) once the call is read, before the outcome is recorded; a leftover of an attempt a
// crash cut short goes before the next attempt makes its own (stages.ts `removeJudgmentCheckouts`).
//
// Outcomes: approve (an `approval` fact binds it to the fingerprint, then the stage-outcome) · revise
// (a fix round with the directives, bounded by the table) · escalate (route up) · an empty diff is refused
// before any call (park) · refusal, malformed and faults as at plan-check. An answer off its schema takes the one judgment
// repair turn first (dev.12, `repairTurnOf` in dispatch.ts): its own session resumed with why; refused again, `malformed`.
//
// The approval fingerprint (R2) = {unitCommit, specRev, contractRevs, rulingRevs, obligationRevs, corpus}: contractRevs
// are the blob ids at T of every cited contract, the architecture doc and its digest when the plan names one,
// rulingRevs the effective revision of every cited active C-nn (M3: bumped by each partial supersession of it,
// `effectiveRulingRevs`), obligationRevs (M3) the revision of every selected, non-exempt obligation in force (absent
// when none), corpus (M4a, R6) the sha256 of a corpus arc's whole pin in force (absent outside one), so a re-pin
// re-gates every approval. It is captured with the judgment's other inputs (Checkpoint A), and the approval records exactly that
// captured fingerprint: what the gate judged, never what moved while it ran. Before `integration.ff` it is recomputed
// at the tip being published onto; any difference re-gates, except that obligationRevs binds the obligations the gate
// judged (selected at the gated tip, DESIGN-1.0.md §2.8): each must still be selected, non-exempt and at its judged
// revision, while one a sibling's publication newly selects is witnessed by the candidate's lanes and grades its
// eligibility (`findingBlocking`, integrate.ts) without voiding the judgment (paid M4b run 6).
//
// M4a: a corpus arc's gate reads the rules index and the pinned corpus materialised read-only without the vision
// document (`gateTarget`, M3 R17), its directory added to the session's readable dirs.
//
// Debt (M4a R7, DEBT_BANK): an approval in a corpus arc banks each `pre-existing` finding (dev.12 round 2) of the
// approving answer, and each `note` whose `debt` names its drag on future work (dev.13, owner ruling 2026-10-20: a note
// without one is recorded in the gate record and never debt; a dev.12 answer's note, `debt` unrecorded, banks as dev.12
// banked it), as a `gate-note` debt item (`gateDebtNotes`), keyed by its source `(unit, attempt, index)` and deduped by
// `debtKey` against the baseline's ledger and the arc's banked items (`mintDebt`), right after the `approval` fact. A crash between the two is finished
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
import { writeFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { freshJudgmentSession, resumedJudgmentSession } from '../backends/argv.ts';
import { crashPoint } from '../core/crash.ts';
import { normalizeText } from '../corpus/rules.ts';
import { mintDebt } from '../debt/mint.ts';
import { baselineDebtAt } from '../phase0/rows.ts';
import type { GateLargeDiff, IntentOf } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JudgmentSessionId, type ObligationId, type Sha, type UnitId, invocationId, canonicalIds, compareIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type ApprovalFingerprint, type JudgmentSession, type ObligationRev, effectiveScope, obligationRevsOf, specObligations, specRemoves, specRepairs, specWitnesses } from '../core/records.ts';
import { selectObligations } from '../holistic/impact.ts';
import { effectiveRulingRevs } from '../spec/rulings.ts';
import { type ObligationDef, isExempt } from '../holistic/types.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { type BoundedDiff, boundedDiff, diffPaths } from '../git/boundeddiff.ts';
import { GATE_DEBT_UNRECORDED, gateLargeDiffOf } from '../core/upgrade.ts';
import { git, refTarget, revParse } from '../git/git.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import { regenerateLane } from '../input/derived.ts';
import { type PlanUnit, derivedOf, targetDocumentPaths } from '../input/plan.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { promptFor } from '../prompts/index.ts';
import type { GateChecks, GatePriorRound, RegeneratedCheck } from '../prompts/inputs.ts';
import { type GateOutput, clusterCoverage, validateGateOutput } from '../prompts/schemas.ts';
import { renderSpec } from '../spec/render.ts';
import { runnerFiles } from '../runner/files.ts';
import type { JsonValue } from '../core/json.ts';
import type { NeedsUserContent } from '../core/records.ts';
import {
  type BackendCallOutcome, type Cancelled, type JudgmentDispatch, type StageContext, type StageParent, callBackend, cancelledNow, dispatchOf, evidenceRoot, isCancelled, judgmentDeadlineMs,
  judgmentDispatch, runOp, unitBranch, verdictOf, verificationWorktree,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { laneRecordIn, latestSpecSeries, observedViews, seriesLedger, seriesTree, specSeriesRoot } from './lanes.ts';
import { gateSmokeChecks } from './smoke.ts';
import { gateWitnessChecks } from './witnesscheck.ts';
import {
  type PlanCheckDone, type StageDone, at, changedPremiseFiles, corpusInForce, enterJudgment, gateTarget, holisticInForce, inMs, integrationTip, type JudgmentReader, judgmentOutput,
  judgmentSpawns, ledger, ledgerDir, library, loadUnitSpec, planCheckNotes, planCheckRead, record, releaseJudgment, rulingSidecars, start, targetDirs, verdictKind,
  escalationOf, fastSuiteRoot, judgedAnswer, removeJudgmentCheckouts, salvageRejections, stillOutside, unitMilestones, writeJudgmentInputs,
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
    latched: new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation)),
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

/**
 * Whether an approval still holds when publishing onto `tip`: the fingerprint there equals the approved one, except that
 * its obligations may be a superset of the judged ones (each judged one at its judged revision). An obligation a
 * sibling's publication newly selects is not one the gate judged; the candidate's lanes witness it at its own tip.
 */
export function fingerprintHolds(ctx: StageContext, unit: PlanUnit, fingerprint: ApprovalFingerprint, tip: Sha): boolean {
  const now = fingerprintAt(ctx, unit, tip);
  const current = new Map(obligationRevsOf(now).map((r) => [r.id, r.rev]));
  const judgedHold = obligationRevsOf(fingerprint).every((r) => current.get(r.id) === r.rev);
  return judgedHold && sameFingerprint(withoutObligations(now), withoutObligations(fingerprint));
}

const withoutObligations = ({ obligationRevs: _, ...rest }: ApprovalFingerprint): ApprovalFingerprint => rest;

/** The re-check `integrationFfOp` and its reconciler take: the approval against the integration tip now. */
export function fingerprintValid(ctx: StageContext, unit: PlanUnit): (fingerprint: ApprovalFingerprint) => boolean {
  return (fingerprint) => fingerprintHolds(ctx, unit, fingerprint, integrationTip(ctx));
}

// ---------------------------------------------------------------------------------------------------
// Earlier gate rounds, read back from their results

const gateSpawns = (ctx: JudgmentReader, unit: UnitId) => judgmentSpawns(ctx, unit, 'gate');

/** A unit's latest gate answer as status shows it (dev.12 round 2): its attempt, decision, findings and `unreviewed`. */
export type GateAnswerView = Readonly<{ attempt: number; decision: GateOutput['decision']; findings: GateOutput['findings']; unreviewed: GateOutput['unreviewed'] }>;

/** The unit's latest gate spawn that gave a valid answer, read back from its result; null before any. */
export function latestGateAnswer(ctx: JudgmentReader, unit: UnitId): GateAnswerView | null {
  const spawns = gateSpawns(ctx, unit);
  for (let i = spawns.length - 1; i >= 0; i--) {
    const spawn = spawns[i]!;
    const out = judgmentOutput(ctx, spawn, validateGateOutput);
    if (out === null) continue;
    if (spawn.parent.type !== 'stage') throw new Error(`${unit}: a gate spawn outside a stage attempt`);
    return { attempt: spawn.parent.attempt, decision: out.decision, findings: out.findings, unreviewed: out.unreviewed };
  }
  return null;
}

/** The directives of the gate attempt `parent`, which revised. */
export function gateDirectives(ctx: StageContext, parent: StageParent): readonly string[] {
  const spawn = gateSpawns(ctx, parent.unit).filter((i) => canonicalJson(i.parent) === canonicalJson(parent)).at(-1);
  const out = spawn === undefined ? null : judgmentOutput(ctx, spawn, validateGateOutput);
  if (out === null || out.decision !== 'revise') throw new Error(`gate ${parent.unit}#${parent.attempt} recorded revise without a revise answer`);
  return out.directives;
}

/** The diff head a gate spawn judged: the commit of the checkout it ran in (its own since dev.13, a verification checkout before). */
function judgedHead(ctx: StageContext, spawn: IntentOf<'proc.spawn'>): Sha {
  const inv = invocationId(spawn.op, spawn.ordinal);
  const launch = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('launch.json');
  if (launch === null) throw new Error(`${inv}: a gate spawn without launch.json`);
  const created = ctx.journal.view.opsOf('worktree.create').find((i) => i.expect.path === launch.cwd);
  if (created === undefined || created.expect.checkout.type !== 'detached') throw new Error(`${inv}: the gate ran in ${launch.cwd}, which is no detached checkout`);
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
    // Read as its attempt read it: an answer its cluster map made invalid was no revise (it was recorded malformed).
    if (spawn.parent.type !== 'stage') throw new Error(`${unit}: a gate spawn outside a stage attempt`);
    const out = judgmentOutput(ctx, spawn, gateAnswerAt(ctx, unit, spawn.parent.attempt));
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

/**
 * The byte budget of the gate's attached diff (src/git/boundeddiff.ts), the lens's (`LENS_DIFF_BUDGET`, about 37K tokens):
 * the inlined diff is a fixed cost on every turn of the session, and the bounded diff spends it first on what the
 * mechanical pattern does not explain, so a larger budget buys more of the same substitution (dev.12 role eval: 329 KB of
 * a 384 KiB budget went to the alphabetically-first files of one rename). What does not fit is read from the
 * attachment's files.
 */
export const GATE_DIFF_BUDGET = 131_072;

// ---------------------------------------------------------------------------------------------------
// The large-diff gate (1.0.0-dev.12)
//
// A unit's diff too large to cover in one context is high risk whatever its tier. The threshold is the bounded diff's own
// overflow: any file with changed content it left out for size (`BoundedDiff.overflow`; derived outputs and deletions,
// never inlined at any budget, do not count). Over it the gate sits at least at `high` (transitions.ts `largeDiffSeat`;
// the escalation seat stays), its prompt carries the large-diff method (the gate module's <large_diff>), and its answer
// must carry a cluster map that covers every path of the diff (`diffPaths`: a renamed file by its new path, a deleted one
// by its old) exactly once; under it the answer's `clusters` is null. A map that misses or doubles a path is refused like
// any answer off its schema: the one repair turn names the paths, and refused again it is `malformed`. The threshold is
// recorded on the attempt's `judgment-inputs` (`largeDiff`), so the seat, the prompt and the check all follow from it on
// replay and recovery. Above the threshold a file in a cluster counts as reviewed at the cluster's depth; `unreviewed`
// names only the gaps the gate admits beyond that.

/** The file beside a large diff's attachment listing every path its cluster map covers, one per line. */
export const CHANGED_LIST = 'changed.txt';
/** How many uncovered and how many doubly covered paths a refused cluster map's reason names, each. */
export const CLUSTER_PATHS_SHOWN = 20;

/** The attachment's large-diff threshold: null when it left nothing out for size. */
export const largeDiffOf = (bounded: BoundedDiff): GateLargeDiff | null => (bounded.overflow === 0 ? null : { overflow: bounded.overflow });

const listed = <T>(xs: readonly T[], show: (x: T) => string): string =>
  `${xs.slice(0, CLUSTER_PATHS_SHOWN).map(show).join(', ')}${xs.length > CLUSTER_PATHS_SHOWN ? ` and ${xs.length - CLUSTER_PATHS_SHOWN} more` : ''}`;

/**
 * The gate answer's validator for a diff: the schema (`validateGateOutput`), then the cluster map against the threshold.
 * Under it (`largeDiff` null) the map is null; over it, every one of `paths` is in exactly one cluster (`clusterCoverage`).
 */
export function gateAnswerFor(largeDiff: GateLargeDiff | null, paths: readonly RepoPath[]): (value: unknown) => GateOutput {
  return (value) => {
    const out = validateGateOutput(value);
    if (largeDiff === null) {
      if (out.clusters !== null) throw new SchemaError('gate.clusters', 'null: the diff fit the gate\'s budget, so no cluster map', `${out.clusters.length} clusters`);
      return out;
    }
    if (out.clusters === null) throw new SchemaError('gate.clusters', `a cluster map covering each of the diff's ${paths.length} changed paths exactly once (the diff is over the large-diff threshold)`, null);
    const { uncovered, duplicated } = clusterCoverage(out.clusters, paths);
    if (uncovered.length === 0 && duplicated.length === 0) return out;
    const parts = [
      ...(uncovered.length === 0 ? [] : [`${uncovered.length} paths in no cluster: ${listed(uncovered, (p) => p)}`]),
      ...(duplicated.length === 0 ? [] : [`${duplicated.length} paths in more than one: ${listed(duplicated, (d) => `${d.path} (${d.clusters.join(', ')})`)}`]),
    ];
    throw new SchemaError('gate.clusters', `every changed path in exactly one cluster; ${parts.join('; ')}`, `${out.clusters.length} clusters`);
  };
}

/** The validator gate attempt `attempt` of `unit` read its answer with, from its recorded `judgment-inputs`. */
function gateAnswerAt(ctx: StageContext, unit: UnitId, attempt: number): (value: unknown) => GateOutput {
  const inputs = ctx.journal.view.judgmentInputs(unit, 'gate', attempt);
  if (inputs === null || inputs.head === null) throw new Error(`gate ${unit}#${attempt}: a gate answer without its judgment-inputs`);
  const largeDiff = gateLargeDiffOf(inputs);
  return gateAnswerFor(largeDiff, largeDiff === null ? [] : diffPaths(ctx.repo, diffBase(ctx.repo, inputs.tip, inputs.head), inputs.head));
}

/**
 * dev.13: a gate attempt's own detached checkout of the unit's tip, the session's cwd: a throwaway tree its experiments may
 * write in, never the verification checkout the lanes certified.
 */
export const gateWorktree = (ctx: StageContext, parent: StageParent): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${parent.unit}.gate-${parent.attempt}`));

/** Where a gate attempt's attached diff writes what it does not inline: beside the attempt's evidence, readable to the gate. */
const gateDiffDir = (ctx: StageContext, parent: StageParent): AbsPath => absPath(join(evidenceRoot(ctx.runDir, parent), 'diff'));

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
  | Readonly<{ kind: 'unverified' }>
  | Readonly<{ kind: 'routing-changed'; needsUser: NeedsUserContent }>
  | Readonly<{
    kind: 'captured'; fingerprint: ApprovalFingerprint; seat: JudgmentDispatch; rendered: string; system: string; schema: JsonValue; evidence: readonly AbsPath[];
    /** The unit's tip the gate judges (the verification checkout's commit): its own checkout is made there. */
    head: Sha;
    /** The answer's validator for this diff (`gateAnswerFor`). */
    validate: (value: unknown) => GateOutput;
    /** Beside the evidence: the target's readable dirs (a corpus arc's materialised pin). */
    dirs: readonly AbsPath[];
  }>;

/**
 * M4a rev 3 (D1, D2, R38): what the executable checks of lanes attempt `series` found at `head`: the witnesses it requires
 * (a gate follows only a green check, so none missing or failing) and its smoke's verdict, or why the smoke did not run;
 * both null outside a corpus arc.
 */
function gateChecks(ctx: StageContext, unit: PlanUnit, series: StageParent, head: Sha, paths: readonly RepoPath[]): GateChecks {
  const witnesses = gateWitnessChecks(ctx, unit, head);
  return { witnesses, smoke: witnesses === null ? null : gateSmokeChecks(ctx, unit, series, head, witnesses.required), regenerated: regeneratedChecks(ctx, series, head, paths) };
}

/**
 * dev.12: per plan `derived` entry whose outputs the diff's `paths` touch, in entry order, what its regenerate check found
 * in lanes attempt `series` at `head` (a fast suite lane at the salvage SHA, stages.ts `fastSuite`).
 */
export function regeneratedChecks(ctx: StageContext, series: StageParent, head: Sha, paths: readonly RepoPath[]): readonly RegeneratedCheck[] {
  const root = fastSuiteRoot(ctx.runDir, series, 'suite');
  return derivedOf(ctx.plan()).filter((d) => paths.some((p) => d.outputs.some((o) => matchesPattern(p, o)))).map((d): RegeneratedCheck => {
    const lane = regenerateLane(d);
    if (lane === null || d.regenerate === undefined) return { state: 'no-generator', outputs: d.outputs };
    const { argv } = d.regenerate;
    const run = laneRecordIn(ctx, series, lane, 'suite', head, root);
    if (run === null) return { state: 'not-run', outputs: d.outputs, argv };
    return run.verdict === 'pass' ? { state: 'verified', outputs: d.outputs, argv } : { state: 'differs', outputs: d.outputs, argv, evidenceDir: run.evidenceDir };
  });
}

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
    // The latest spec series' own checkout (Q3). Gone, or of another commit: nothing to judge in, so the lanes run again,
    // uncharged (paid M4a run 11: an older executor made none for a spec declaring no lanes).
    const series = latestSpecSeries(ctx, unit.id);
    const tree = series === null ? null : seriesTree(ctx.journal.view, series, verificationWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, series.attempt));
    if (series === null || tree === null || tree.at !== head) return { kind: 'unverified' };
    // The attached diff first: whether it is over the large-diff threshold decides the seat.
    const diffDir = gateDiffDir(ctx, parent);
    const base = diffBase(ctx.repo, tip, head);
    const bounded = boundedDiff(ctx.repo, base, head, {
      budget: GATE_DIFF_BUDGET, derived: [...new Set(derivedOf(ctx.plan()).flatMap((d) => d.outputs))].sort(), removes: specRemoves(spec), dir: diffDir,
    });
    const largeDiff = largeDiffOf(bounded);
    const seated = judgmentDispatch(ctx, unit.id, 'gate', largeDiff);
    if (seated.kind !== 'pinned') return { kind: 'routing-changed', needsUser: seated.needsUser };
    const pinned = dispatchOf(ctx.journal.view, unit.id);
    const laneLedger = seriesLedger(ctx, series, spec.lanes, 'spec', head, specSeriesRoot(ctx.runDir, series));
    // The attached diff's files (what it does not inline) are listed and readable as evidence.
    const evidence = [...laneLedger.map((l) => l.evidenceDir), ...buildEvidence(ctx, unit.id), diffDir];
    const scope = effectiveScope(pinned);
    const growth = paths.filter((p) => !scope.some((g) => matchesGlob(p, g)));
    const seat = seated.dispatch;
    const prompt = promptFor('gate', seat.triple.model);
    const target = gateTarget(ctx, tip);
    const chosen = selected(ctx, unit, tip, head);
    // Over the threshold, the paths the cluster map covers, listed beside the attachment for the session to read.
    const covered = largeDiff === null ? [] : diffPaths(ctx.repo, base, head);
    const list = absPath(join(diffDir, CHANGED_LIST));
    if (largeDiff !== null) writeFileSync(list, covered.map((p) => `${p}\n`).join(''));
    const rendered = prompt.render({
      spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, ...library(ctx, spec, tip), target,
      direction: ctx.plan().direction, planCheckNotes: planCheckNotes(ctx, unit.id),
      obligations: observedViews(ctx, holisticInForce(ctx).obligations, chosen, tip),
      diff: {
        bounded,
        claims: {
          acceptance: spec.acceptance.filter((a) => a.state === 'active').map((a) => a.id),
          witnesses: specWitnesses(spec).filter((w) => w.state === 'active').map((w) => w.id),
          obligations: chosen.map((o) => o.id),
        },
      },
      // Scope growth (2026-10-15): every out-of-scope path a salvage of the unit reverted (in no diff), still outside the scope.
      laneLedger, evidence, scope: { patterns: scope, growth, rejected: stillOutside(ctx, unit.id, salvageRejections(ctx, unit.id).flatMap((r) => r.paths)) },
      priorRound: priorRound(ctx, unit.id, head),
      // M4a rev 3 (D1, D2): the executable checks of the series it judges (corpus arcs; null elsewhere).
      checks: gateChecks(ctx, unit, series, head, paths),
      escalation: escalationOf(ctx, unit.id, 'gate', seat.tier, validateGateOutput),
      largeDiff: largeDiff === null ? null : { overflow: largeDiff.overflow, changed: covered.length, list },
      // dev.13: the milestones it takes part in, their references at the tip (a design unit's own are in its diff).
      milestones: unitMilestones(ctx, unit.id, tip),
    });
    const fingerprint = fingerprintAt(ctx, unit, tip);
    writeJudgmentInputs(ctx, parent, {
      tip, head, specRev: spec.rev, specSha256: sha256, routingRev: seat.routingRev, fingerprint,
      diffShown: { inlined: bounded.inlined.map((f) => f.path).sort(), notInlined: bounded.notInlined }, largeDiff,
    });
    return {
      kind: 'captured', fingerprint, seat, rendered, system: prompt.system, schema: prompt.schema, evidence, head, dirs: targetDirs(target),
      validate: gateAnswerFor(largeDiff, covered),
    };
  });
  if (captured.kind !== 'captured') {
    const done = captured.kind === 'routing-changed' ? record(ctx, parent, 'routing-changed', captured.needsUser) : record(ctx, parent, captured.kind);
    return { ...done, session: null, fingerprint: null };
  }
  const entered = await enterJudgment(ctx, parent);
  if (isCancelled(entered)) return entered;
  const { fingerprint, seat } = captured;
  // A checkout an earlier attempt left (a crash cut its stage short) goes first: this attempt makes its own at the captured head.
  await removeJudgmentCheckouts(ctx, unit.id, parent);
  const cwd = gateWorktree(ctx, parent);
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit.id}:gate`, parent, { path: cwd, checkout: { type: 'detached', at: captured.head } });
  const session = freshJudgmentSession();
  const call = (s: JudgmentSession, text: string): Promise<BackendCallOutcome> => callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session: s, evidenceDirs: [...captured.evidence, ledgerDir(ctx), ...captured.dirs] },
    system: captured.system, rendered: text, schema: captured.schema, cwd,
    deadlineAt: inMs(judgmentDeadlineMs(dispatchOf(ctx.journal.view, unit.id))),
  });
  const called = await call(session, captured.rendered);
  // A refused answer goes back once, in the same session, with every reason (the repair turn), before anything is recorded.
  return gateRead(ctx, unit, parent, called, session.id, fingerprint, captured.validate, (reasons) => call(resumedJudgmentSession(session.id), judgmentRepairDirective(reasons)));
}

/**
 * Records a gate attempt from its call: the live one, or one recovery closed after a crash (`consumeJudgment`,
 * never asked again). `fingerprint` is the one captured with the inputs it judged (its `unitCommit` the head it
 * read): an approval records exactly it, and ff re-checks it against the inputs then in force. An approval fact
 * this attempt already recorded is kept, not recorded twice.
 *
 * `repair` is the live attempt's repair turn (dev.12, as at plan-check): an answer off its schema goes back once, in the
 * same session, with every reason, before anything is recorded; the repair turn's answer is then read as the attempt's,
 * and refused again it is `malformed`. A call consumed after a crash gets none (`repair` null).
 */
export async function gateRead(
  ctx: StageContext, unit: PlanUnit, parent: StageParent & Readonly<{ stage: 'gate' }>, called: BackendCallOutcome, session: JudgmentSessionId,
  fingerprint: ApprovalFingerprint, validate: (value: unknown) => GateOutput, repair: ((reasons: readonly string[]) => Promise<BackendCallOutcome>) | null = null,
): Promise<GateDone> {
  if (repair !== null) {
    const first = judgedAnswer(called, validate);
    if (first.kind === 'refused') return gateRead(ctx, unit, parent, await repair(first.reasons), session, fingerprint, validate);
  }
  // The session has ended: its checkout and its @cpu go before anything is recorded.
  await removeJudgmentCheckouts(ctx, unit.id, parent);
  await releaseJudgment(ctx, parent);
  const done = (d: StageDone<'gate'>, fingerprint: ApprovalFingerprint | null = null): GateDone => ({ ...d, session, fingerprint });
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return done(verdictKind(ctx, parent, v, called));

  let out: GateOutput;
  try {
    out = validate(v.value);
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
 * The findings of an approving answer that are debt, each with its place in the answer and the text banked: a
 * pre-existing defect (its text); a note whose `debt.drag` is not blank (its text, then its drag); a dev.12 note
 * (`debt` unrecorded: its text, as dev.12 banked it). A blank text names no debt. Pure.
 */
export function gateDebtNotes(findings: GateOutput['findings']): readonly Readonly<{ index: number; what: string }>[] {
  return findings.flatMap((f, index) => {
    if (f.severity === 'blocking' || normalizeText(f.text) === '') return [];
    if (f.severity === 'pre-existing' || f.debt === GATE_DEBT_UNRECORDED) return [{ index, what: f.text }];
    const drag = f.debt === null ? '' : normalizeText(f.debt.drag);
    return drag === '' ? [] : [{ index, what: `${f.text} Drag: ${drag}` }];
  });
}

/**
 * Banks the approving answer's debt (`gateDebtNotes`) of a corpus arc as `gate-note` debt (R7), after its `approval`: each
 * keyed by `(unit, attempt, index)`, its index the finding's place in the answer, and minted against the baseline's
 * ledger and the arc's banked items (`mintDebt`: a source or a key already banked mints nothing). Only a corpus arc
 * banks: its Phase 0 dispositions the ledger it publishes.
 */
function bankGateNotes(ctx: StageContext, unit: UnitId, attempt: number, findings: GateOutput['findings']): void {
  if (ctx.plan().target !== 'corpus') return;
  const notes = gateDebtNotes(findings);
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
      return gateRead(ctx, unit, at(parent, 'gate'), called, result.session, fingerprint, gateAnswerAt(ctx, unit.id, parent.attempt));
    }
    default:
      throw new Error(`${unit.id} ${parent.stage}#${parent.attempt}: no judgment call to consume`);
  }
}
