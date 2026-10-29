// The cadence audit job (M3 step B5; DESIGN-1.0.md §2.5; plan "Audits"): one durable job `audit-<n>` at a time, which
// reads the integrated tree through the lenses and records what they found. The lenses report; the steering
// checkpoint weighs them at milestone boundaries, with immediate P1 and final-audit triggers (B6; checkpoint.ts).
//
// A run (`runAudit`, one call per scheduler turn):
//   0. A running audit (started, not ended: a crash or a restart cut it short) resumes as the same job, from its
//      recorded inputs; otherwise the cadence (cadence.ts) says whether one is due. A due audit is skipped (nothing
//      written, its triggers stay owed) while the lens seat's backend is parked or the arc is paused or stopped. Cadence
//      suppresses an ordinary audit before capture when no selected lens has an outstanding range; explicit requests
//      and semantic drift may inspect unchanged code. The same cadence calculation serves scheduler and capture.
//   1. Immutable inputs (H2, A19): `audit-started{job, triggers, generation, lenses, integrationSha, planRev,
//      ledgerSha256, obligationsSha256, visionSha256, owners, priorFindings, highWater, diffBudget}` in one synchronous capture
//      under the revision fence (`captureUnderFence`), so no audit starts between a docs `ff` and its `plan-applied`.
//      Everything after reads the recorded inputs, never what is in force later: the audited SHA, and the vision,
//      obligations and ledger by their kept bytes.
//   2. Every arc lane on the audited SHA, a journey series under `job{audit-n}` in a detached checkout (reusing an
//      observation already on the tree). A lane that ends without a verdict leaves the job running (`incomplete`);
//      a failed cleanup leaves a job-owned residue its holder reclaims (G4), and the resumed job runs that lane again.
//   3. Code opens a P1 (`lens: witness`) for every must-hold obligation (a latched future one included) not held on
//      the audited tree. 3a (dev.17): in an arc without milestones, the batch point on the audited SHA
//      (src/pipeline/batchlanes.ts): each batch lane whose systems changed since its last green runs, and a red one opens
//      code's P1 (`lens: witness`, over no obligation, naming the lane). A lane without a verdict leaves the job running.
//   4. The lenses, serially (the vision first), each a fresh session on the lens seat (`callArcRole`: `arc-backend`,
//      metered to the job by role and routingRev) holding `@cpu`×1 under `job{audit-n}`, reading a detached checkout
//      of the audited SHA: the vision first, then the obligations with their observations there, the lens's range
//      (its watermark to the audited SHA) with its diff, the branch diffs of parked or in-flight owners of findings,
//      the prior findings with their states, the contracts and rulings in force, the target (a corpus arc's materialised
//      pin readable beside the checkout, `targetDirs`). The lens-range fix (2026-10-16, src/holistic/lensdiff.ts): a
//      range is reviewed in chunks, one call each, from the watermark to the furthest published head whose diff attaches
//      whole within `diffBudget` (at least one publication), until the audited SHA, all within this job, so one audit
//      always drains every range it runs; each chunk's diff and the owners' (sharing one budget) are attached bounded
//      (src/git/boundeddiff.ts), each file not shown written under the job's evidence dir (`diffs/lens-<attempt>/`),
//      which the call may read. An audit an earlier executor started (no `diffBudget`)
//      reviews each range in one call, as its recorded calls did. A resumed job consumes a call it already made
//      (`recordedArcCall`) and asks again only for one lost: a lens's first call is numbered by its place in the run
//      order. At most two new operations reissue a logical call lost across restarts (job, role, attempt), counted
//      from the journal: exhausted, the lens fails and the audit is abandoned as on a process fault. The existing
//      retry within an operation stays bounded by invoke. Every further call (a later chunk, a repair turn) after every lens's first, in order, and the chunks are
//      found again from git and the recorded inputs. Each report's findings are opened at once. A report off its schema,
//      or with a draft refused at admission (below), takes the one judgment repair turn (dev.12, `repairTurnOf` in
//      src/pipeline/dispatch.ts; M4b paid run 3 asked a fresh session again): its own session resumed with every reason
//      (each refused draft's claim, cause and why, its other findings already recorded); the chunk counts as reported only
//      when the repair turn's report is admitted whole. An audit an earlier release started keeps its recorded calls: its
//      fresh retry of a refused draft is consumed as the repair turn's answer, and a malformed report it asked nothing
//      after takes none (`isRepairTurnOf`), nor does a refused answer whose session it did not persist.
//   5. The lens checkout removed, citing an evidence snapshot of it; then `audit-ended{covered, findings, suppressed,
//      outcome, refused}`: `completed` when every lens reported every chunk, else `abandoned` (a lens failed, a draft was
//      refused again, or its backend parked: the rest are not asked). Coverage (coverage.ts) is each lens's range from
//      its watermark at the capture as far as its reported chunks reached, never beyond the audited SHA: a lens that
//      failed a later chunk keeps the earlier ones, and a merge that landed meanwhile stays outstanding.
//   6. The race (§2.5): when the integration head moved past the audited SHA, the P1s this audit cited are
//      re-witnessed on the current head (`rewitnessP1s`, their obligations' lanes under the same job), so the
//      checkpoint reads their observation there. The checkpoint (B6) calls it again before its own capture.
//
// Findings go through the one store (src/holistic/findings.ts `openFinding`: merge into an active key, suppress a
// dismissed one unless a cited blob changed); code's P1s are `witnessFindingDraft`s. A vacuity mutant is made a patch
// against the audited tree at admission and kept by `admitMutant` (H6; M4b: from the lens's exact edits, which git turns
// into the patch): one that cannot be made, or names no arc lane, refuses its draft, nothing opened, the reason recorded
// in `audit-ended.refused` (and written to the executor's stderr).
// Within one audit, a lens draft whose cross-lens key (`crossKey`: repo evidence paths, obligation, cause) names a finding
// another lens opened or merged in this audit corroborates it (`finding-corroborated`, H7, R62) instead of opening a
// second. The ids opened, merged or corroborated and the suppressed count become `audit-ended{findings, suppressed}`.
// A specs-only drift audit (every trigger `drift{specsOnly}`, H2) runs the vision lens alone with `LensInputs.specsOnly`.
// `gateHadPassed`: a unit had published before the audit started (the defect passed some gate).
import { freshJudgmentSession } from '../backends/argv.ts';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { AuditInputs, LensRefusal, Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { canonicalJson } from '../core/json.ts';
import { crashPoint } from '../core/crash.ts';
import { auditDiffBudgetOf } from '../core/upgrade.ts';
import { type FindingId, type JobId, type LaneId, type NeedsUserId, type ObligationId, type Sha, type Sha256Hex, type UnitId, type VisionClauseId, parseInvocationId, parseJobId, canonicalIds } from '../core/ids.ts';
import type { AuditState, FindingState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPattern, absPath } from '../core/values.ts';
import { capturedEvidence } from '../git/evidence.ts';
import { catFileType, refTarget, revParse } from '../git/git.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { diffBase } from '../git/transient.ts';
import { PLAN_INPUT, RULINGS_INPUT, OBLIGATIONS_INPUT, SPEC_INPUT, VISION_INPUT, keptInput, keptPayload, payloadAtRev } from '../input/inforce.ts';
import { advancesOf, derivedOf, hasMilestones, parsePlan } from '../input/plan.ts';
import { runBatchPoint } from '../pipeline/batchlanes.ts';
import { DEFAULT_BOUNDS } from '../core/records.ts';
import { raiseNeedsUser, raisedFor, readNeedsUser } from '../needsuser.ts';
import {
  type BackendCallOutcome, type JobParent, type RepairTurn, type StageContext, arcSeat, callArcRole, isRepairTurnOf, minutesMs, recordedArcCall, repairTurnOf, runOp, unitBranch, verdictOf,
} from '../pipeline/dispatch.ts';
import { type JourneyEnd, arcJourneyLane, dirtySnapshot, jobSeriesCheckout, observedViews, removeJobCheckouts, runJourneySeries } from '../pipeline/lanes.ts';
import { architecture, docAt, inMs, judgmentEntry, ledgerDir, ledgerPath, targetDirs } from '../pipeline/stages.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { renderPrompt, promptFor } from '../prompts/index.ts';
import { type FindingView, type LensInputs, type RenderedSpec, visionInputOf } from '../prompts/inputs.ts';
import { renderSpec } from '../spec/render.ts';
import { parseSpec } from '../spec/spec.ts';
import { type LensFinding, type LensOutput, validateLensOutput } from '../prompts/schemas.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';
import { probe } from '../resources/probe.ts';
import { type JobHolder, type Reservation, cleanup, heldReservation, run } from '../resources/reserve.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { parseRulings } from '../spec/rulings.ts';
import { type Cadence, type Clock, cadence, integrationHeadNow, runOrder, specsOnlyOf } from './cadence.ts';
import { coverageBase, lensCoverage, publishedHeads } from './coverage.ts';
import { LENS_DIFF_BUDGET, chunkEnd } from './lensdiff.ts';
import { boundedDiff } from '../git/boundeddiff.ts';
import { type FindingDraft, admitMutant, corroborateFinding, crossKey, openFinding, witnessFindingDraft } from './findings.ts';
import { verdictOf as witnessVerdict } from './observe.ts';
import {
  FINDING_MOVES, LENS_KINDS, type MutantRef, type FindingEvidence, type FindingLens, type LensKind, type ObservationVerdict, type Obligations, type Vision, type WitnessRecord, isExempt, isMustHold, parseObligations, parseVision,
} from './types.ts';

/** What an audit needs: a stage context (processes, resources, routing), the arbiter's first-served waits, a clock. */
export type AuditContext = StageContext & Readonly<{ acquireFirst: AcquireFirst; clock: Clock }>;

/** One re-witnessed P1: its obligation's verdict on the head it was re-witnessed at (null: its lane gave none). */
export type Rewitnessed = Readonly<{ finding: FindingId; obligation: ObligationId; head: Sha; verdict: ObservationVerdict | null }>;

export type AuditOutcome =
  /** Nothing is due. */
  | Readonly<{ kind: 'none' }>
  /** Due, but not started: the lens backend is parked, or the arc is paused or stopped. Its triggers stay owed. */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused'; owed: NeedsUserId | null }>
  /** A lane ended without a verdict: the job is still running and resumes at the next call. */
  | Readonly<{ kind: 'incomplete'; job: JobId; end: JourneyEnd }>
  | Readonly<{
    kind: 'ended'; job: JobId; outcome: 'completed' | 'abandoned'; covered: readonly LensKind[]; findings: readonly FindingId[]; suppressed: number;
    /** H6, M4b: the drafts refused at admission (a mutant that could not be made, or on no arc lane), as `audit-ended.refused` records them. */
    refused: readonly LensRefusal[];
    rewitnessed: readonly Rewitnessed[];
  }>;

type Started = AuditState['started'];

/** A job's waits are never cancelled: an audit runs to its end once begun. */
const NEVER = new AbortController().signal;
const jobParent = (job: JobId): JobParent => ({ type: 'job', job });

/**
 * Where an audit's lenses' checkout goes (its basename starts with the job id). Its journey series (the lanes', a
 * re-witness) each take their own (`jobSeriesCheckout`: `<job>.lanes-<k>`, `<job>.rewitness-<k>`).
 */
const lensesCheckout = (ctx: StageContext, job: JobId): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.lenses`));

/** The part of a lens's range one call reviews: `from` how far the lens reached, `to` the chunk's end. */
type Chunk = Readonly<{ from: Sha; to: Sha }>;

/** The audit's diff budget: the one it recorded, or (an audit started before the lens-range fix) today's. */
const budgetOf = (s: Started): number => auditDiffBudgetOf(s) ?? LENS_DIFF_BUDGET;

/**
 * The next chunk of a lens's range from `from` (src/holistic/lensdiff.ts `chunkEnd`, over the recorded budget and the
 * published heads); an audit started before the lens-range fix reviews the whole rest in one call, as its recorded
 * calls did.
 */
function nextChunk(ctx: StageContext, s: Started, r: Recorded, from: Sha, heads: ReadonlySet<Sha>): Chunk {
  const budget = auditDiffBudgetOf(s);
  return { from, to: budget === null ? s.integrationSha : chunkEnd(ctx.repo, from, s.integrationSha, budget, r.derived, heads) };
}

// ---------------------------------------------------------------------------------------------------
// Findings

/**
 * The findings an audit opened or merged, how many it suppressed (src/holistic/findings.ts `openFinding`), the drafts it
 * refused, and (H7, R62) the finding each cross-lens key names in this audit.
 */
type Tally = { ids: Set<FindingId>; suppressed: number; refused: LensRefusal[]; cross: Map<Sha256Hex, Readonly<{ id: FindingId; lens: FindingLens }>> };

const isLensKind = (l: FindingLens): l is LensKind => (LENS_KINDS as readonly FindingLens[]).includes(l);

/**
 * Admits one draft (the audit's one way in): a lens draft whose cross-lens key names a finding another lens opened or
 * merged in this audit corroborates it (`finding-corroborated`, keeping this lens's claim) and opens nothing; every other
 * draft goes through `openFinding`.
 */
function admit(ctx: StageContext, t: Tally, draft: FindingDraft): void {
  const key = crossKey(draft);
  const prior = t.cross.get(key);
  if (prior !== undefined && prior.lens !== draft.lens && isLensKind(draft.lens)) {
    corroborateFinding(ctx.journal, prior.id, draft.lens, draft.claim);
    t.ids.add(prior.id);
    return;
  }
  const o = openFinding(ctx.journal, draft);
  if (o.kind === 'suppressed') {
    t.suppressed += 1;
    return;
  }
  t.ids.add(o.id);
  if (!t.cross.has(key)) t.cross.set(key, { id: o.id, lens: draft.lens });
}

// ---------------------------------------------------------------------------------------------------
// The inputs, as recorded

type Recorded = Readonly<{
  vision: Vision; advances: readonly VisionClauseId[]; obligations: Obligations | null; ledgerText: string;
  /** The plan's derived outputs at the audit's rev: never inlined in a lens's diffs (src/holistic/lensdiff.ts). */
  derived: readonly RepoPattern[];
}>;

function kept(ctx: StageContext, sha: Sha256Hex, ext: string): string {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`the audit's inputs name ${ext} ${sha}, which is not kept`);
  return bytes.toString('utf8');
}

/**
 * The vision, the slice the plan at the audit's rev advances, the obligations and ledger the audit recorded, by their
 * kept bytes, and that plan's derived outputs.
 */
function recorded(ctx: StageContext, s: Started): Recorded {
  if (s.ledgerSha256 === null) throw new Error(`${s.job}: a holistic arc's revision in force keeps its ledger`);
  const plan = parsePlan(JSON.parse(kept(ctx, payloadAtRev(ctx.journal.view, ctx.runDir, s.planRev).manifest.planSha256, PLAN_INPUT)));
  return {
    vision: parseVision(JSON.parse(kept(ctx, s.visionSha256, VISION_INPUT))),
    advances: advancesOf(plan),
    obligations: s.obligationsSha256 === null ? null : parseObligations(JSON.parse(kept(ctx, s.obligationsSha256, OBLIGATIONS_INPUT))),
    ledgerText: kept(ctx, s.ledgerSha256, RULINGS_INPUT),
    derived: [...new Set(derivedOf(plan).flatMap((d) => d.outputs))].sort(),
  };
}

const TERMINAL = ['retired', 'cut', 'superseded'];

/** The branch heads of parked or in-flight owners of findings (owned or fixed on their branch), ascending by unit. */
function ownersOf(ctx: StageContext): readonly Readonly<{ unit: UnitId; head: Sha }>[] {
  const view = ctx.journal.view;
  const units = [...new Set(view.holistic().findings.flatMap((f) => (f.owner !== null && (f.state === 'owned' || f.state === 'fixed-on-branch') ? [f.owner] : [])))].sort();
  return units.flatMap((unit) => {
    if (TERMINAL.includes(view.unit(unit).status)) return [];
    const head = refTarget(ctx.repo, unitBranch(ctx.plan().arc, unit));
    return head === null ? [] : [{ unit, head }];
  });
}

/** The capture (H2): the cadence's plan and the revisions in force, written as `audit-started`; null when none is due. */
function capture(ctx: AuditContext): Started | null {
  const view = ctx.journal.view;
  const c = cadence(ctx, ctx.clock);
  if (c === null || c.plan === null) return null;
  const applied = view.planApplied();
  if (applied === null || applied.visionSha256 === undefined || applied.payloadSha256 === undefined) throw new Error('an audit outside a holistic revision in force');
  const payload = keptPayload(ctx.runDir, applied.payloadSha256);
  const inputs: AuditInputs = {
    job: view.nextJobId('audit'),
    triggers: c.plan.triggers,
    generation: c.plan.generation,
    lenses: c.plan.lenses,
    integrationSha: c.head,
    planRev: applied.rev,
    ledgerSha256: payload.manifest.rulings.ledgerSha256,
    obligationsSha256: applied.obligationsSha256 ?? null,
    visionSha256: applied.visionSha256,
    owners: ownersOf(ctx),
    priorFindings: canonicalIds(view.holistic().findings.map((f) => f.id)),
    highWater: view.highWater(),
    diffBudget: LENS_DIFF_BUDGET,
  };
  const seq = ctx.journal.fact({ kind: 'audit-started', ...inputs });
  return { ...inputs, seq };
}

/** Why a due audit does not start now, or null. */
export function skipReason(ctx: StageContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'lens').triple.backend) ? 'backend-parked' : null;
}

/**
 * OR-Q2/3: the non-blocking `audit-owed` of the owed episode (keyed by the last completed audit's job, or the arc before
 * one), raised once; null when the audit is not owed long.
 */
export function raiseAuditOwed(ctx: AuditContext, c: Cadence): NeedsUserId | null {
  if (!c.owedLong) return null;
  const view = ctx.journal.view;
  const key = canonicalJson(c.episode);
  const raised = view.opsOf('needsuser.raise').find((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null
    && readNeedsUser(ctx.runDir, i.expect.id)?.reason === 'audit-owed');
  if (raised !== undefined) return raised.expect.id;
  const parent = c.episode;
  const triggers = c.owed.map((t) => t.type).join(', ');
  return raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false,
    subject: { type: 'arc' },
    reason: 'audit-owed',
    summary: `An audit is owed (${triggers}) and has not run for 2 × the cadence or 2 × the wall-clock period: ${skipReason(ctx) ?? 'its runs did not complete'}. Units keep running; coverage stays outstanding.`,
    recommendation: 'Resume what keeps the audit from running (`roadmap resume --backend <b>` after a usage limit, or `roadmap resume`), or run `roadmap audit`; then acknowledge this item.',
    options: [],
    evidence: [],
  }, parent);
}

// ---------------------------------------------------------------------------------------------------
// The lens calls

/** The finding views of `ids`, as the fold has them now. */
function findingViews(findings: readonly FindingState[], ids: readonly FindingId[]): readonly FindingView[] {
  return ids.map((id) => {
    const f = findings.find((x) => x.id === id);
    if (f === undefined) throw new Error(`the audit names finding ${id}, which the fold does not have`);
    return { id: f.id, lens: f.lens, severity: f.severity, state: f.state, obligation: f.obligation, claim: f.claim, owner: f.owner };
  });
}

/** Where lens call `attempt` of an audit has its attached diffs' unshown files written (readable to the call). */
const lensDiffDir = (ctx: StageContext, job: JobId, attempt: number): AbsPath => absPath(join(jobEvidenceRoot(ctx.runDir, job), 'diffs', `lens-${attempt}`));

/**
 * A lens's inputs from the recorded ones: the vision first, then the tree at the audited SHA, the chunk of the range
 * this call covers and the owners' branch diffs, each attached within the budget (the owners sharing theirs), their
 * unshown files written under `diffDir`.
 */
function lensInputs(ctx: StageContext, s: Started, r: Recorded, lens: LensKind, chunk: Chunk, checkout: AbsPath, diffDir: AbsPath): LensInputs {
  const sha = s.integrationSha;
  const rulings = parseRulings(r.ledgerText, ledgerPath(ctx));
  const budget = budgetOf(s);
  const share = Math.floor(budget / Math.max(1, s.owners.length));
  const attach = (from: Sha, to: Sha, bytes: number, dir: string) => boundedDiff(ctx.repo, from, to, { budget: bytes, derived: r.derived, removes: null, dir: absPath(join(diffDir, dir)) });
  return {
    vision: visionInputOf(r.vision, r.advances),
    lens,
    obligations: r.obligations === null ? [] : observedViews(ctx, r.obligations, r.obligations.obligations, sha),
    range: { audited: sha, diff: attach(chunk.from, chunk.to, budget, 'range') },
    owners: s.owners.map((o) => ({ unit: o.unit, head: o.head, diff: attach(diffBase(ctx.repo, sha, o.head), o.head, share, `owner-${o.unit}`) })),
    priorFindings: findingViews(ctx.journal.view.holistic().findings, s.priorFindings),
    contracts: ctx.plan().contracts.map((c) => docAt(ctx, sha, c)),
    rulings: rulings.flatMap((x) => (x.status === 'active' ? [{ id: x.id, text: x.text }] : [])),
    index: { contracts: [], rulings: [], withdrawn: rulings.filter((x) => x.status === 'withdrawn').map((x) => x.id), ledger: ledgerPath(ctx) },
    target: architecture(ctx, sha),
    checkout,
    // M4a rev 3 (H2, R61): an audit every trigger of which is a specs-only drift reads those units' specs.
    specsOnly: changedSpecs(ctx, s),
  };
}

/** A specs-only audit's changed specs (H2), rendered from the kept spec bytes at the audited plan rev; null for a full audit. */
function changedSpecs(ctx: StageContext, s: Started): readonly RenderedSpec[] | null {
  const units = specsOnlyOf(s.triggers);
  if (units === null) return null;
  const manifest = payloadAtRev(ctx.journal.view, ctx.runDir, s.planRev).manifest;
  return units.map((unit) => {
    const sha = manifest.specs[unit];
    if (sha === undefined) throw new Error(`${s.job}: plan rev ${s.planRev} keeps no spec of ${unit}, which its drift names`);
    const spec = parseSpec(Buffer.from(kept(ctx, sha, SPEC_INPUT), 'utf8'), absPath(join(ctx.runDir, 'inputs', `${sha}.${SPEC_INPUT}`)));
    return { unit, rev: spec.rev, markdown: renderSpec(spec) };
  });
}

/** The blob `path` names at `sha` (a path under the checkout made relative), or null when it names no file there. */
function blobAt(ctx: StageContext, sha: Sha, checkout: AbsPath, path: string): FindingEvidence {
  const rel = isAbsolute(path) ? relative(checkout, path) : path;
  const blob = rel.startsWith('..') || catFileType(ctx.repo, `${sha}:${rel}`) !== 'blob' ? null : revParse(ctx.repo, `${sha}:${rel}`);
  return { path: blob === null ? path : rel, blob };
}

/**
 * A lens's finding as a draft: its obligation and clauses kept only when they exist; a vision finding at most P2; a
 * vacuity mutant made a patch against the audited tree and kept (H6, `admitMutant`), else the draft is refused with
 * why: a mutant on no arc lane, or one that cannot be made there. An edit's path under the checkout is made relative.
 */
function lensDraft(ctx: StageContext, s: Started, r: Recorded, lens: LensKind, f: LensFinding, checkout: AbsPath, gateHadPassed: boolean): FindingDraft | Readonly<{ refused: string }> {
  const obligationIds = new Set(r.obligations?.obligations.map((o) => o.id) ?? []);
  const clauseIds = new Set(r.vision.clauses.map((c) => c.id));
  const laneIds = new Set<LaneId>(r.obligations?.lanes.map((l) => l.id) ?? []);
  const evidence = [...new Map(f.evidence.map((e) => {
    const b = blobAt(ctx, s.integrationSha, checkout, e.path);
    return [b.path, b] as const;
  })).values()];
  let mutant: MutantRef | null = null;
  if (lens === 'vacuity' && f.mutant !== null) {
    if (!laneIds.has(f.mutant.lane)) return { refused: `its mutant's lane ${f.mutant.lane} is not an arc lane (${[...laneIds].join(', ') || 'none'})` };
    const m = f.mutant.kind === 'edits' ? { ...f.mutant, edits: f.mutant.edits.map((e) => ({ ...e, path: isAbsolute(e.path) ? relative(checkout, e.path) : e.path })) } : f.mutant;
    const admitted = admitMutant(ctx.repo, ctx.runDir, s.integrationSha, m);
    if (admitted.kind === 'refused') return { refused: `its mutant cannot be made: ${admitted.reason}` };
    mutant = admitted.mutant;
  }
  return {
    lens,
    severity: lens === 'vision' && f.severity === 'P1' ? 'P2' : f.severity,
    obligation: f.obligation !== null && obligationIds.has(f.obligation) ? f.obligation : null,
    visionClauses: canonicalIds(f.visionClauses.filter((c): c is VisionClauseId => clauseIds.has(c))),
    claim: f.claim,
    cause: f.cause,
    evidence,
    mutant,
    source: { type: 'job', job: s.job },
    gateHadPassed,
  };
}

type LensRead =
  | Readonly<{ kind: 'reported'; output: LensOutput }>
  /** No report; `refused`: the report was off its schema, so it may take its repair turn. */
  | Readonly<{ kind: 'failed'; detail: string; refused?: true }>
  /** Its backend parked (a usage limit or capacity): no further lens is asked. */
  | Readonly<{ kind: 'parked'; detail: string }>;

/** Reads a lens call: a report, a failure, or a park (its `backend-park` written; a usage limit's item raised once). */
function readLens(ctx: StageContext, job: JobId, called: BackendCallOutcome): LensRead {
  const v = verdictOf(ctx, jobParent(job), called);
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'reported', output: validateLensOutput(v.value) };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', detail: `malformed report: ${error.message}`, refused: true };
        throw error;
      }
    case 'malformed':
      return { kind: 'failed', detail: `malformed report: ${v.detail}`, refused: true };
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent: Parent = { type: 'op', op: parseInvocationId(called.inv).op };
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return v.cause === null ? { kind: 'failed', detail: `interrupted: ${v.reason}` } : { kind: 'parked', detail: `backend parked: ${v.reason}` };
    }
    default:
      return { kind: 'failed', detail: `${v.kind}: ${v.detail}` };
  }
}

/** Holds `@cpu`×1 under the job's holder around `body`. */
export async function withCpu<T>(ctx: AuditContext, job: JobId, body: () => Promise<T>): Promise<T> {
  const request = judgmentEntry();
  const holder: JobHolder = { type: 'job', job };
  const parent = jobParent(job);
  const grant = await ctx.acquireFirst(request, holder, NEVER);
  if (grant.kind === 'cancelled') throw new Error(`${job}: its @cpu wait was cancelled, and nothing cancels it`);
  const reserved = heldReservation(ctx, holder, 'reserved');
  if ((await probe(ctx, reserved, parent)).kind === 'parked') throw new Error(`${job}: an @cpu reservation has no probe, so it cannot be occupied`);
  const held: Reservation<'running', JobHolder> = run(ctx, reserved, parent);
  try {
    return await body();
  } finally {
    const cleaned = await cleanup(ctx, held, parent);
    if (cleaned.kind !== 'released') throw new Error(`${job}: its @cpu reservation was not released: ${cleaned.kind}`);
  }
}

/** Removes a checkout the job made, citing an evidence snapshot of whatever it holds beyond its commit. */
export async function removeCheckout(ctx: StageContext, job: JobId, path: AbsPath): Promise<void> {
  const parent = jobParent(job);
  const snap = await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${job}`, parent, {
    source: path, ...dirtySnapshot(path), dest: absPath(join(jobEvidenceRoot(ctx.runDir, job), basename(path))),
  });
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${job}`, parent, { path, evidence: capturedEvidence(ctx.journal.view, snap.op) });
}

// ---------------------------------------------------------------------------------------------------
// The job

/** The audit started and not ended, or null. */
const running = (ctx: StageContext): Started | null => ctx.journal.view.holistic().audits.find((a) => a.ended === null)?.started ?? null;

/** Every must-hold obligation (a latched future one included) not held on the audited tree: a P1 each (code). */
function witnessDrafts(ctx: StageContext, s: Started, r: Recorded, records: ReadonlyMap<LaneId, WitnessRecord>, gateHadPassed: boolean): readonly FindingDraft[] {
  if (r.obligations === null) return [];
  // Latched as of the audit's capture: a latch landing while the audit runs belongs to a later head.
  const latched = new Set(ctx.journal.view.holistic().latched.filter((l) => l.seq <= s.highWater).map((l) => l.obligation));
  return r.obligations.obligations.flatMap((o): FindingDraft[] => {
    if (isExempt(o) || o.state.type === 'split' || o.witness === null) return [];
    if (!isMustHold(o, latched)) return [];
    const record = records.get(o.witness.lane);
    if (record === undefined) throw new Error(`${s.job}: obligation ${o.id}'s lane ${o.witness.lane} has no record on ${s.integrationSha}`);
    if (witnessVerdict(record, o.witness) !== 'not-held') return [];
    return [witnessFindingDraft({
      obligation: o.id, serves: o.serves, job: s.job, gateHadPassed,
      claim: `${o.id} is not held on ${s.integrationSha}: its witness ${o.witness.lane} (${o.witness.testIds.join(', ')}) fails there.`,
      evidence: [{ path: jobEvidenceRoot(ctx.runDir, s.job), blob: null }],
    })];
  });
}

/** New operations reissuing a lost logical lens call, counted across every restart. */
const LOST_CALL_REISSUES = 2;

/**
 * Runs (or resumes) the audit due now: see the header. `none` when nothing is due; `skipped` (writing nothing but an owed
 * item) while the lens backend is parked or the arc paused.
 */
export async function runAudit(ctx: AuditContext): Promise<AuditOutcome> {
  let s = running(ctx);
  if (s === null) {
    const c = cadence(ctx, ctx.clock);
    if (c === null || c.plan === null) return { kind: 'none' };
    const skip = skipReason(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip, owed: raiseAuditOwed(ctx, c) };
    s = await captureUnderFence(ctx.journal, () => capture(ctx));
    if (s === null) return { kind: 'none' };
    crashPoint('audit.after-started');
  }
  const { job } = s;
  const parent = jobParent(job);
  await removeJobCheckouts(ctx, job);
  const r = recorded(ctx, s);
  const gateHadPassed = ctx.journal.view.publications().some((p) => p.seq < s.seq);
  const t: Tally = { ids: new Set(), suppressed: 0, refused: [], cross: new Map() };

  // 2–3: the arc lanes on the audited SHA, then code's P1s.
  if (r.obligations !== null && r.obligations.lanes.length > 0) {
    const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, r.obligations.lanes.map(arcJourneyLane), {
      path: jobSeriesCheckout(ctx, job, 'lanes'), checkout: { type: 'detached', at: s.integrationSha },
    }, { reuse: true, stop: () => false });
    if (series.end.kind !== 'ran') return { kind: 'incomplete', job, end: series.end };
    const records = new Map(series.runs.flatMap((x) => (x.record === null ? [] : [[x.lane, x.record] as const])));
    for (const d of witnessDrafts(ctx, s, r, records, gateHadPassed)) admit(ctx, t, d);
  }
  // 3a (dev.17): an arc without milestones has its batch point here (src/pipeline/batchlanes.ts); a red lane is code's P1.
  if (!hasMilestones(ctx.plan())) {
    const batch = await runBatchPoint(ctx, job, s.integrationSha, null, (d) => admit(ctx, t, d));
    if (batch.kind === 'no-verdict') return { kind: 'incomplete', job, end: batch.end };
  }

  // 4: the lenses, serially, the vision first.
  const base = coverageBase(ctx, s.integrationSha, s.seq);
  if (base === null) throw new Error(`${job}: no vision revision before its start`);
  const checkout = lensesCheckout(ctx, job);
  const { triple } = arcSeat(ctx, 'lens');
  const prompt = promptFor('lens', triple.model);
  let made = false;
  const covered: LensKind[] = [];
  let outcome: 'completed' | 'abandoned' = 'completed';
  const order = runOrder(s.lenses);
  /**
   * One call of `lens` as `attempt` over `chunk`: the recorded one consumed, else asked (lazily making the checkout): fresh,
   * or the repair turn `repair` (its refused call's session resumed, told every reason).
   */
  const ask = async (lens: LensKind, attempt: number, chunk: Chunk, repair: Readonly<{ turn: RepairTurn; reasons: readonly string[] }> | null): Promise<Readonly<{ read: LensRead; called: BackendCallOutcome }>> => {
    let called = recordedArcCall(ctx, job, 'lens', attempt);
    // A restart reissues a lost logical call as a new operation; count those operations across every restart.
    const operations = ctx.journal.view.opsOf('proc.spawn').filter((i) => {
      const subject = i.expect.subject;
      return subject.purpose === 'arc-backend' && subject.job === job && subject.role === 'lens' && subject.attempt === attempt;
    }).length;
    if (called === null || (called.kind === 'lost' && operations <= LOST_CALL_REISSUES)) {
      if (!made) {
        await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, parent, { path: checkout, checkout: { type: 'detached', at: s.integrationSha } });
        made = true;
      }
      if (repair !== null && repair.turn.cwd !== checkout) throw new Error(`${job}: a refused lens call ran in ${repair.turn.cwd}, not the audit's checkout ${checkout}`);
      const diffDir = lensDiffDir(ctx, job, attempt);
      const inputs = lensInputs(ctx, s, r, lens, chunk, checkout, diffDir);
      called = await withCpu(ctx, job, () => callArcRole(ctx, {
        job, role: 'lens', attempt, system: prompt.system, cwd: checkout, evidenceDirs: [ledgerDir(ctx), diffDir, ...targetDirs(inputs.target)],
        deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)),
        ...(repair === null
          ? { ...renderPrompt(prompt, inputs), schema: prompt.schema, session: freshJudgmentSession() }
          : { prompt: null, rendered: judgmentRepairDirective(repair.reasons), schema: repair.turn.schema, session: repair.turn.session }),
      }));
    }
    return { read: readLens(ctx, job, called), called };
  };
  /** Admits a report's drafts (each finding opened at once); returns the refused ones, recorded in the tally. */
  const admitReport = (lens: LensKind, attempt: number, output: LensOutput): readonly LensRefusal[] => {
    const refused: LensRefusal[] = [];
    for (const f of output.findings) {
      const d = lensDraft(ctx, s, r, lens, f, checkout, gateHadPassed);
      if ('refused' in d) {
        refused.push({ lens, attempt, claim: f.claim, cause: f.cause, reason: d.refused });
        process.stderr.write(`roadmap: ${job}: a ${lens} finding (call ${attempt}) was refused, ${d.refused}\n`);
      } else {
        admit(ctx, t, d);
      }
    }
    t.refused.push(...refused);
    return refused;
  };
  // A lens reviews its range chunk by chunk (`nextChunk`), each a call. A lens's first call is numbered by its place in the
  // run order, every further call (a repair turn, a later chunk) after every lens's first, in order, so a resumed audit
  // finds each recorded call again (an audit started before chunking numbers its retries the same way).
  const heads = new Set(publishedHeads(ctx.journal.view).map((h) => h.head));
  /** How far each lens's reported chunks reach. */
  const reached = new Map<LensKind, Sha>();
  let further = 0;
  for (const [i, lens] of order.entries()) {
    let from = lensCoverage(ctx.journal.view.holistic(), base, lens, s.seq).watermark;
    let attempt = i + 1;
    let read: LensRead;
    for (;;) {
      const chunk = nextChunk(ctx, s, r, from, heads);
      const first = await ask(lens, attempt, chunk, null);
      read = first.read;
      // The repair turn's reasons: the schema violation, or each draft admission refused (the report's others recorded).
      let reasons: readonly string[] = [];
      if (read.kind === 'failed' && read.refused === true) reasons = [read.detail];
      if (read.kind === 'reported') {
        const refused = admitReport(lens, attempt, read.output);
        if (refused.length > 0) {
          reasons = [
            ...refused.map((x) => `finding "${x.claim}" (cause: ${x.cause}) could not be admitted: ${x.reason}`),
            'the report\'s other findings are recorded, so report only the refused ones again, corrected (leave out one you cannot support)',
          ];
          read = { kind: 'failed', detail: 'a draft was refused' };
        }
      }
      if (reasons.length > 0) {
        const again = order.length + further + 1;
        const recordedAgain = recordedArcCall(ctx, job, 'lens', again);
        // An earlier release's fresh retry of a refused draft is this repair turn's answer; after a malformed report it
        // asked nothing, so a call recorded at the next number is another's (adoption).
        const drafts = first.read.kind === 'reported';
        const taken = recordedAgain === null || drafts || isRepairTurnOf(ctx.runDir, recordedAgain.inv, first.called.inv);
        // A repair turn recorded with its result is consumed; one not made, or lost with its runner, is asked.
        const turn = taken && recordedAgain?.kind !== 'result' ? repairTurnOf(ctx.runDir, first.called.inv) : null;
        if (taken && (recordedAgain?.kind === 'result' || turn !== null)) {
          further++;
          const repaired = await ask(lens, again, chunk, turn === null ? null : { turn, reasons });
          // A chunk is covered only once a report is admitted whole: a draft refused again leaves it outstanding.
          read = repaired.read.kind === 'reported' && admitReport(lens, again, repaired.read.output).length > 0 ? { kind: 'failed', detail: 'a draft was refused again' } : repaired.read;
        }
      }
      if (read.kind !== 'reported') break;
      from = chunk.to;
      reached.set(lens, from);
      if (from === s.integrationSha) break;
      attempt = order.length + ++further;
    }
    if (read.kind !== 'reported') {
      outcome = 'abandoned';
      if (read.kind === 'parked') break;
      continue;
    }
    covered.push(lens);
    crashPoint('audit.after-lens');
  }

  // 5: the checkout removed, then the end: coverage as far as each lens's reported chunks reach, at most the audited SHA.
  if (made) await removeCheckout(ctx, job, checkout);
  crashPoint('audit.before-ended');
  const ranges = order.flatMap((lens) => {
    const from = lensCoverage(ctx.journal.view.holistic(), base, lens, s.seq).watermark;
    const to = reached.get(lens);
    return to === undefined || to === from ? [] : [{ lens, from, to }];
  }).sort((a, b) => (a.lens < b.lens ? -1 : 1));
  const findings = canonicalIds(t.ids);
  ctx.journal.fact({ kind: 'audit-ended', job, covered: ranges, findings, suppressed: t.suppressed, outcome, refused: t.refused });
  crashPoint('audit.after-ended');
  if (outcome === 'abandoned') {
    const c = cadence(ctx, ctx.clock);
    if (c !== null) raiseAuditOwed(ctx, c);
  }

  // 6: the race: the cited P1s re-witnessed on the head that moved meanwhile.
  const rewitnessed = await rewitnessP1s(ctx, job);
  return { kind: 'ended', job, outcome, covered: covered.sort(), findings, suppressed: t.suppressed, refused: t.refused, rewitnessed };
}

/**
 * The race (§2.5): the active P1s over an obligation that audit `job` named, re-witnessed on the integration head now
 * when it moved past the audited SHA: their obligations' lanes as a series under the job, reusing an observation
 * already on the head. Empty when the head has not moved or the audit named no such P1.
 */
export async function rewitnessP1s(ctx: AuditContext, job: JobId): Promise<readonly Rewitnessed[]> {
  if (parseJobId(job).kind !== 'audit') throw new Error(`${job} is no audit`);
  const audit = ctx.journal.view.holistic().audits.find((a) => a.started.job === job);
  if (audit === undefined || audit.ended === null) throw new Error(`${job} has not ended`);
  const head = integrationHeadNow(ctx);
  if (head === audit.started.integrationSha) return [];
  const r = recorded(ctx, audit.started);
  if (r.obligations === null) return [];
  const obligations = r.obligations;
  const cited = ctx.journal.view.holistic().findings.filter((f) =>
    audit.ended!.findings.includes(f.id) && f.severity === 'P1' && f.obligation !== null && FINDING_MOVES[f.state].length > 0);
  const defs = cited.flatMap((f) => {
    const o = obligations.obligations.find((x) => x.id === f.obligation);
    return o === undefined || o.witness === null ? [] : [{ finding: f.id, o }];
  });
  if (defs.length === 0) return [];
  const laneIds = new Set(defs.map((d) => d.o.witness!.lane));
  await removeJobCheckouts(ctx, job);
  const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, obligations.lanes.filter((l) => laneIds.has(l.id)).map(arcJourneyLane), {
    path: jobSeriesCheckout(ctx, job, 'rewitness'), checkout: { type: 'detached', at: head },
  }, { reuse: true, stop: () => false });
  const records = new Map(series.runs.flatMap((x) => (x.record === null ? [] : [[x.lane, x.record] as const])));
  return defs.map(({ finding, o }) => {
    const record = records.get(o.witness!.lane);
    return { finding, obligation: o.id, head, verdict: record === undefined ? null : witnessVerdict(record, o.witness!) };
  });
}

/** Whether an audit is due or running now (the scheduler's question before it calls `runAudit`). */
export function auditPending(ctx: AuditContext): boolean {
  if (running(ctx) !== null) return true;
  const c = cadence(ctx, ctx.clock);
  return c !== null && c.plan !== null;
}

