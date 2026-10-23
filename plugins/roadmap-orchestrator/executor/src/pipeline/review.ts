// Proportional review at the gate (dev.17; DESIGN-1.0.md §4 "Proportional review", SCHEMAS.md "Proportional review").
//
// Code owns the invariants that keep review proportional; the gate seat owns its method.
//
// 1. Blocking needs a defect. A dev.17 gate's blocking finding names its `defect` (`DEFECT_CATEGORIES`); one without is
//    refused through the repair turn. Comments and docs are `ride-along`, which never blocks: on an approval, debt when it
//    names its drag (gate.ts `gateDebtNotes`), else released.
// 2. The findings ledger. Each finding with a path that exists at the judged head enters the arc's ledger (`review-ledger`):
//    a blocking one open, any other settled at once (banked when the approval banked it, else released). The next gate of
//    the unit settles the open ones: a dispute (decisions.json `disputes`) it rules on once, final (`disputed-upheld` or
//    `disputed-overruled`); an open finding whose file changed and that it does not raise again, `fixed`; on an approval, the
//    rest `released`. A blocking finding that raises a settled one again (`reraises`) is refused unless that finding's anchor
//    blob changed.
// 3. The delta re-gate. An approval records the blobs it approved (`ApprovalBlobs`). A later gate of the same spec revision (or
//    one later by design records alone, `designRevisionsOnly`)
//    reviews only the files whose blob moved and those that name a target the approval bound that moved since (a contract,
//    a ruling, a requirement: `movedTargets`, the pins hook; a target a stale set recorded after the approval changed, or a
//    design interface whose blob moved: `staleSinceApproval`, `movedInterfaces`; an unpinned link is moved exactly when its
//    target changed since the approval); the rest are listed, readable and not under review. A blocking
//    finding on one of those is demoted to a note unless it cites a changed hunk (`hunk`) or a moved target (`contractRef`);
//    a revise left with no blocking finding is read as an approval. An empty delta skips the gate (`delta-empty`).
//
// What a gate attempt was given is recorded on its `judgment-inputs` (`GateReview`), so the rules its answer is held to
// follow from the log on replay and recovery; an attempt a dev.16 executor captured has none and is read without them.
import { join } from 'node:path';
import { type ReviewFindingId, type Sha, type SpecRev, type UnitId, reviewFindingIdOf } from '../core/ids.ts';
import { type ReviewFact, parentUnit } from '../core/events.ts';
import type { ApprovalFingerprint, SpecM1 } from '../core/records.ts';
import type { JournalView } from '../core/interfaces.ts';
import { isUnitLink } from '../core/stale.ts';
import { specLinksOf } from '../holistic/staleset.ts';
import {
  type ApprovalBlobs, type FindingsLedgerEntry, type GateDelta, type GateReview, type LedgerOutcome, type ReviewDispute, isSettled, movedTargets,
} from '../core/review.ts';
import { approvalBlobsOf } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, repoPath } from '../core/values.ts';
import { git, gitRun } from '../git/git.ts';
import { unitDiffPaths } from '../git/transient.ts';
import { reviewDisputeDirective } from '../prompts/directives.ts';
import type { GateReviewInput } from '../prompts/inputs.ts';
import { DECISIONS_FILE, DEFECT_CATEGORIES, type GateFinding, type GateOutput, validateGateOutput } from '../prompts/schemas.ts';
import type { PlanUnit } from '../input/plan.ts';
import { type StageContext, type StageParent, workDir } from './dispatch.ts';
import { type JudgmentReader, judgmentOutput, judgmentSpawns, loadUnitSpec, readDecisions } from './stages.ts';

/** The blob of `path` at `commit`, or null when the commit has no such file. */
export function blobAt(repo: AbsPath, commit: Sha, path: string): Sha | null {
  const r = gitRun(repo, ['rev-parse', '--verify', '-q', `${commit}:${path}`], { okCodes: [0, 1, 128] });
  return r.code === 0 ? (r.stdout.trim() as Sha) : null;
}

/** `path` as a repository path, or null when a finding names something else (an absolute path, a pattern). */
function asRepoPath(path: string): RepoPath | null {
  try {
    return repoPath(path);
  } catch (error) {
    if (error instanceof SchemaError) return null;
    throw error;
  }
}

/** The unit's ledger findings, in id order, at their current outcome. */
export const unitLedger = (ctx: JudgmentReader, unit: UnitId): readonly FindingsLedgerEntry[] => ctx.journal.view.review().ledger.filter((e) => e.unit === unit);

/** What an approval approved: each path the unit's diff `diffBase(tip, head)..head` touches, at its blob at `head` (null: deleted). */
export function approvalBlobs(repo: AbsPath, unit: UnitId, specRev: SpecRev, tip: Sha, head: Sha): ApprovalBlobs {
  return { unit, specRev, files: unitDiffPaths(repo, tip, head).map((path) => ({ path, blob: blobAt(repo, head, path) })) };
}

// ---------------------------------------------------------------------------------------------------
// Disputes

/**
 * The disputes the unit's latest build wrote (decisions.json `disputes`) of its open ledger findings: the ones the next gate
 * rules on. A dispute of a settled or unknown finding is dropped: a ruling is final, and the ledger is the gate's.
 */
export function openDisputes(ctx: StageContext, unit: PlanUnit, ledger: readonly FindingsLedgerEntry[]): readonly ReviewDispute[] {
  const build = ctx.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build' && i.expect.subject.unit === unit.id).at(-1);
  if (build === undefined || build.parent.type !== 'stage') return [];
  // A report-less build (lost with tree effects) may leave one that does not validate: none is read then, as its decisions
  // are not appended (stages.ts `appendDecisions`, which names it on stderr).
  const decisions = readDecisions(absPath(join(workDir(ctx.runDir, build.parent as StageParent), DECISIONS_FILE)), loadUnitSpec(ctx, unit).spec);
  if (decisions === null || typeof decisions === 'string') return [];
  const open = new Set(ledger.filter((e) => !isSettled(e)).map((e) => e.id as string));
  return decisions.disputes.filter((d) => open.has(d.finding));
}

// ---------------------------------------------------------------------------------------------------
// The delta re-gate

/**
 * A gate's delta from the unit's latest approval, given its spec in force, its fingerprint `now` at the tip it reads and
 * the head it judges: null for a full review (no approval, a dev.16 approval without blobs, or a spec revision since that
 * is not the design pass's alone: `designRevisionsOnly`), `empty` when no file changed and nothing the approval bound moved,
 * else the delta.
 */
export function gateDelta(ctx: StageContext, unit: UnitId, spec: SpecM1, tip: Sha, head: Sha, now: ApprovalFingerprint): GateDelta | 'empty' | null {
  const approval = ctx.journal.view.review().approval(unit);
  if (approval === null) return null;
  const blobs = approvalBlobsOf({ unit, blobs: approval.blobs });
  if (blobs === null || !designRevisionsOnly(ctx.journal.view, unit, blobs.specRev, now.specRev)) return null;
  const was = new Map<string, Sha | null>(blobs.files.map((f) => [f.path, f.blob]));
  const paths = unitDiffPaths(ctx.repo, tip, head);
  const is = new Map<string, Sha | null>(paths.map((p) => [p, blobAt(ctx.repo, head, p)]));
  const all = [...new Set([...was.keys(), ...is.keys()])].sort();
  const unchanged = all.filter((p) => was.has(p) && is.has(p) && was.get(p) === is.get(p));
  const moved = [...new Set([
    ...movedTargets(approval.fingerprint, now),
    ...staleSinceApproval(ctx.journal.view, unit, spec, approval.seq),
    ...movedInterfaces(ctx.repo, spec, approval.fingerprint.unitCommit, head),
  ])].sort();
  // An unchanged file that names a moved target is under review again ("anything citing a moved contract or requirement").
  const citing = moved.length === 0 ? [] : unchanged.filter((p) => {
    const blob = is.get(p);
    if (blob === null || blob === undefined) return false;
    const text = git(ctx.repo, ['cat-file', 'blob', blob]);
    return moved.some((m) => text.includes(m));
  });
  const kept = unchanged.filter((p) => !citing.includes(p));
  const review = all.filter((p) => !kept.includes(p)).map((p) => repoPath(p));
  if (review.length === 0 && moved.length === 0) return 'empty';
  return { approved: { attempt: approval.attempt, head: approval.fingerprint.unitCommit }, review, unchanged: kept.map((p) => repoPath(p)), moved };
}

/**
 * Whether the unit's spec went from rev `from` to rev `to` by design records alone (dev.17, the design pass): every revision
 * between is an executor patch whose every op is `design`, the record a plan-check's approve or scaffold lands on the
 * spec's next revision. That revises the unit's own plan, not a requirement or contract the approval bound (those are
 * `movedTargets`, `staleSinceApproval` and `movedInterfaces`), so it keeps the delta.
 */
function designRevisionsOnly(view: JournalView, unit: UnitId, from: SpecRev, to: SpecRev): boolean {
  if (to < from) return false;
  const design = new Set(view.opsOf('spec.patch').filter((i) =>
    parentUnit(i.parent) === unit && view.doneOf(i.op) !== null && i.expect.patch.ops.every((o) => o.op === 'design')).map((i) => i.expect.expectRev as number));
  for (let rev = from as number; rev < to; rev++) if (!design.has(rev)) return false;
  return true;
}

/**
 * The targets the unit's spec links (its requirements, failure modes' requirements, cited and interface contracts:
 * `specLinksOf`) that a stale set recorded after the approval (seq `since`) changed, and the targets of the unit's own stale
 * links in those sets (src/core/stale.ts): requirement ids and contract or interface paths, `movedTargets`' keys. This
 * reads the change, not the spec's pins: a link with no pin (`UNPINNED`, a dev.16 spec or one no plan-check revised) is
 * moved exactly when its target changed since the approval, never assumed unchanged for want of a pin.
 */
function staleSinceApproval(view: JournalView, unit: UnitId, spec: SpecM1, since: number): readonly string[] {
  const links = specLinksOf(spec);
  return view.propagationFacts().flatMap((x) => {
    const set = x.fact;
    if (x.seq <= since || set.kind !== 'stale-set') return [];
    const targets = set.targets.flatMap((t): string[] =>
      t.type === 'requirement' && links.requirements.has(t.id) ? [t.id] : t.type === 'contract' && links.contracts.has(t.path) ? [t.path] : []);
    const own = set.links.filter(isUnitLink).filter((l) => l.unit === unit).map((l): string =>
      l.type === 'spec' ? (l.target.type === 'contract' ? l.target.path : l.target.id) : l.type === 'failure-mode' ? l.requirement : l.path);
    return [...targets, ...own];
  });
}

/** The design record's interfaces (contract or file pins) whose blob differs between the approved head and `head`. */
const movedInterfaces = (repo: AbsPath, spec: SpecM1, approved: Sha, head: Sha): readonly string[] =>
  (spec.design?.interfaces ?? []).filter((i) => blobAt(repo, approved, i.path) !== blobAt(repo, head, i.path)).map((i) => i.path as string);

/** The changed line ranges of `path` between `from` and `to` on the `to` side (a deletion is the line it follows). */
function changedRanges(repo: AbsPath, from: Sha, to: Sha, path: string): readonly (readonly [number, number])[] {
  const out = git(repo, ['diff', '--no-renames', '-U0', from, to, '--', path]);
  return [...out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    return [Math.max(1, start), Math.max(start, start + count - 1)] as const;
  });
}

// ---------------------------------------------------------------------------------------------------
// The rules an answer is held to

/** The key of a `contractRef` a moved target matches: a contract path without its anchor, a ruling or requirement id. */
const refKey = (ref: string): string => ref.split('#')[0]!.trim();

/**
 * The answer validator's dev.17 half for a gate attempt given `review` at `head` (gate.ts `gateAnswerFor`): refuses (a
 * `SchemaError`, so the repair turn names why) a blocking finding without a defect, a blocking re-raise of a settled finding
 * whose file has not changed, a re-raise of no finding of the unit's ledger, and rulings that are not exactly one per
 * dispute; then demotes, on a delta, each blocking finding on an unchanged file that cites neither a changed hunk nor a moved
 * target (a revise left with no blocking finding reads as an approval). Deterministic in the log and the repository.
 */
export function reviewRules(repo: AbsPath, head: Sha, review: GateReview): (out: GateOutput) => GateOutput {
  return (out) => {
    const faults: string[] = [];
    const ledger = new Map(review.ledger.map((e) => [e.id as string, e]));
    out.findings.forEach((f, i) => {
      if (f.severity === 'blocking' && f.defect === null) faults.push(`findings[${i}] is blocking and names no defect (one of ${DEFECT_CATEGORIES.join(', ')})`);
      if (f.reraises === null) return;
      const e = ledger.get(f.reraises);
      if (e === undefined) faults.push(`findings[${i}].reraises names ${f.reraises}, which is no finding of this unit's ledger`);
      else if (f.severity === 'blocking' && isSettled(e) && blobAt(repo, head, e.path) === e.anchor) {
        faults.push(`findings[${i}] raises ${e.id} again, which is settled (${e.outcome}), and ${e.path} has not changed since it was raised`);
      }
    });
    const disputed = new Set(review.disputes.map((d) => d.finding as string));
    const ruled = new Set(out.rulings.map((r) => r.finding as string));
    const missing = [...disputed].filter((id) => !ruled.has(id));
    const extra = [...ruled].filter((id) => !disputed.has(id));
    if (missing.length > 0) faults.push(`rulings misses the disputes of ${missing.join(', ')}`);
    if (extra.length > 0) faults.push(`rulings names ${extra.join(', ')}, which no dispute put to you`);
    if (faults.length > 0) throw new SchemaError('gate', faults.join('; '), `${out.findings.length} findings, ${out.rulings.length} rulings`);
    return review.delta === null ? out : demoted(repo, head, review.delta, out);
  };
}

/** `out` with each blocking finding on an unchanged file that cites no changed hunk and no moved target made a note. */
function demoted(repo: AbsPath, head: Sha, delta: GateDelta, out: GateOutput): GateOutput {
  const unchanged = new Set<string>(delta.unchanged);
  const underReview = new Set<string>(delta.review);
  const moved = new Set(delta.moved);
  const citesHunk = (f: GateFinding): boolean =>
    f.hunk !== null && underReview.has(f.hunk.path) && changedRanges(repo, delta.approved.head, head, f.hunk.path).some(([a, b]) => f.hunk!.line >= a && f.hunk!.line <= b);
  let count = 0;
  const findings = out.findings.map((f): GateFinding => {
    if (f.severity !== 'blocking' || f.path === null || !unchanged.has(f.path)) return f;
    if ((f.contractRef !== null && moved.has(refKey(f.contractRef))) || citesHunk(f)) return f;
    count++;
    return { ...f, severity: 'note', debt: null };
  });
  if (count === 0) return out;
  const { directives: _d, ...rest } = out;
  if (out.decision === 'revise' && !findings.some((f) => f.severity === 'blocking')) return { ...rest, findings, decision: 'approve', directives: [] };
  return { ...out, findings } as GateOutput;
}

// ---------------------------------------------------------------------------------------------------
// The ledger fact

/**
 * The `review-ledger` fact for gate attempt `attempt` of `unit`, from its answer `out` judged at `head`: the findings it
 * mints (`banked`: the indexes of the answer's findings an approval banked as debt) and the open entries of the unit it
 * settles. Null when the attempt already has one (a crash after it: kept, not written twice) or would mint and settle nothing.
 */
export function ledgerFact(ctx: StageContext, unit: UnitId, attempt: number, head: Sha, out: GateOutput, banked: ReadonlySet<number>): ReviewFact | null {
  const view = ctx.journal.view.review();
  if (view.ledgered(unit, attempt) !== null) return null;
  const reraised = new Set(out.findings.flatMap((f) => (f.reraises === null ? [] : [f.reraises as string])));
  const rulings = new Map(out.rulings.map((r) => [r.finding as string, r.ruling]));
  const settled = unitLedger(ctx, unit).filter((e) => !isSettled(e)).flatMap((e): { id: ReviewFindingId; outcome: LedgerOutcome }[] => {
    const ruling = rulings.get(e.id);
    if (ruling !== undefined) return [{ id: e.id, outcome: ruling === 'upheld' ? 'disputed-upheld' : 'disputed-overruled' }];
    if (reraised.has(e.id)) return [];
    if (blobAt(ctx.repo, head, e.path) !== e.anchor) return [{ id: e.id, outcome: 'fixed' }];
    return out.decision === 'approve' ? [{ id: e.id, outcome: 'released' }] : [];
  });
  let next = view.ledger.length + 1;
  const minted = out.findings.flatMap((f, index) => {
    const path = f.path === null ? null : asRepoPath(f.path);
    const anchor = path === null ? null : blobAt(ctx.repo, head, path);
    if (path === null || anchor === null) return [];
    const outcome: LedgerOutcome | null = f.severity === 'blocking' ? null : banked.has(index) ? 'banked' : 'released';
    return [{ index, entry: { id: reviewFindingIdOf(next++), unit, path, anchor, outcome } }];
  });
  return minted.length === 0 && settled.length === 0 ? null : { kind: 'review-ledger', unit, attempt, minted, settled };
}

// ---------------------------------------------------------------------------------------------------
// What the gate and the builder are told

/** The text of each ledger finding of `unit`, from the gate answers that minted them. */
function ledgerTexts(ctx: JudgmentReader, unit: UnitId): ReadonlyMap<string, GateFinding> {
  const out = new Map<string, GateFinding>();
  for (const spawn of judgmentSpawns(ctx, unit, 'gate')) {
    if (spawn.parent.type !== 'stage') continue;
    const minted = ctx.journal.view.review().ledgered(unit, spawn.parent.attempt);
    if (minted === null) continue;
    const answer = judgmentOutput(ctx, spawn, validateGateOutput);
    if (answer === null) continue;
    for (const m of minted) {
      const f = answer.findings[m.index];
      if (f !== undefined) out.set(m.id, f);
    }
  }
  return out;
}

/** The review as the gate prompt renders it: each ledger finding with its text and whether its file changed since it was raised. */
export function reviewInput(ctx: StageContext, unit: UnitId, head: Sha, review: GateReview): GateReviewInput {
  const texts = ledgerTexts(ctx, unit);
  return {
    ledger: review.ledger.map((e) => ({
      id: e.id, path: e.path, outcome: e.outcome, anchorChanged: blobAt(ctx.repo, head, e.path) !== e.anchor, text: texts.get(e.id)?.text ?? '(text not recorded)',
    })),
    disputes: review.disputes.map((d) => ({ finding: d.finding, reason: d.reason, text: texts.get(d.finding)?.text ?? '(text not recorded)' })),
    delta: review.delta,
  };
}

/**
 * The directive a gate revise's fix round adds (`gateReviseRound`): the open ledger findings that gate attempt minted, by id,
 * and how to dispute one instead of fixing it; null when it minted none open.
 */
export function disputeDirective(ctx: StageContext, unit: UnitId, attempt: number): string | null {
  const minted = ctx.journal.view.review().ledgered(unit, attempt);
  if (minted === null) return null;
  const ledger = new Map(unitLedger(ctx, unit).map((e) => [e.id as string, e]));
  const texts = ledgerTexts(ctx, unit);
  const open = minted.filter((m) => ledger.get(m.id)?.outcome === null).map((m) => ({ id: m.id, path: ledger.get(m.id)!.path, text: texts.get(m.id)?.text ?? '' }));
  return open.length === 0 ? null : reviewDisputeDirective(open);
}
