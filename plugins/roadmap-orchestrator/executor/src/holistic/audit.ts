// The cadence audit job (M3 step B5; DESIGN-1.0.md §2.5; plan "Audits"): one durable job `audit-<n>` at a time, which
// reads the integrated tree through the lenses and records what they found. The lenses report; the checkpoint that
// follows acts (B6).
//
// A run (`runAudit`, one call per scheduler turn):
//   0. A running audit (started, not ended: a crash or a restart cut it short) resumes as the same job, from its
//      recorded inputs; otherwise the cadence (cadence.ts) says whether one is due. A due audit is skipped (nothing
//      written, its triggers stay owed) while the lens seat's backend is parked or the arc is paused or stopped.
//   1. Immutable inputs (H2, A19): `audit-started{job, triggers, generation, lenses, integrationSha, planRev,
//      ledgerSha256, obligationsSha256, visionSha256, owners, priorFindings, highWater}` in one synchronous capture
//      under the revision fence (`captureUnderFence`), so no audit starts between a docs `ff` and its `plan-applied`.
//      Everything after reads the recorded inputs, never what is in force later: the audited SHA, and the vision,
//      obligations and ledger by their kept bytes.
//   2. Every arc lane on the audited SHA, a journey series under `job{audit-n}` in a detached checkout (reusing an
//      observation already on the tree). A lane that ends without a verdict leaves the job running (`incomplete`);
//      a failed cleanup leaves a job-owned residue its holder reclaims (G4), and the resumed job runs that lane again.
//   3. Code opens a P1 (`lens: witness`) for every must-hold obligation (a latched future one included) not held on
//      the audited tree.
//   4. The lenses, serially (the vision first), each a fresh session on the lens seat (`callArcRole`: `arc-backend`,
//      metered to the job by role and routingRev) holding `@cpu`×1 under `job{audit-n}`, reading a detached checkout
//      of the audited SHA: the vision first, then the obligations with their observations there, the lens's range
//      (its watermark to the audited SHA) with its diff, the branch diffs of parked or in-flight owners of findings,
//      the prior findings with their states, the contracts and rulings in force. A resumed job consumes a call it
//      already made (`recordedArcCall`) and asks again only for one lost. Each report's findings are opened at once.
//   5. The lens checkout removed, citing an evidence snapshot of it; then `audit-ended{covered, findings, suppressed,
//      outcome}`: `completed` when every lens reported, else `abandoned` (a lens failed, or its backend parked:
//      the rest are not asked). Coverage (coverage.ts) is only the lenses that reported, each from its watermark at
//      the capture to the audited SHA, never beyond it: a merge that landed meanwhile stays outstanding.
//   6. The race (§2.5): when the integration head moved past the audited SHA, the P1s this audit cited are
//      re-witnessed on the current head (`rewitnessP1s`, their obligations' lanes under the same job), so the
//      checkpoint reads their observation there. The checkpoint (B6) calls it again before its own capture.
//
// Findings (`openFinding`): `key = findingKey(lens, obligation, cause)`. A key matching an open, owned or
// fixed-on-branch finding merges into it (no fact; the audit names it); one matching a dismissed finding is suppressed
// unless a cited evidence blob changed (dismissals have arc lifetime); otherwise a `finding-opened` with the next id.
// `gateHadPassed`: a unit had published before the audit started (the defect passed some gate).
import { basename, isAbsolute, join, relative } from 'node:path';
import type { AuditInputs, HolisticFact, Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { canonicalJson } from '../core/json.ts';
import { crashPoint } from '../core/crash.ts';
import { type FindingId, type JobId, type LaneId, type NeedsUserId, type ObligationId, type Sha, type Sha256Hex, type UnitId, type VisionClauseId, parseInvocationId, parseJobId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import type { AuditState, FindingState } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { capturedEvidence, pathPattern } from '../git/evidence.ts';
import { catFileType, git, refTarget, revParse } from '../git/git.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { diffBase } from '../git/transient.ts';
import { RULINGS_INPUT, OBLIGATIONS_INPUT, VISION_INPUT, keepInput, keptInput, keptPayload } from '../input/inforce.ts';
import { DEFAULT_BOUNDS } from '../core/records.ts';
import { raiseNeedsUser, raisedFor, readNeedsUser } from '../needsuser.ts';
import {
  type BackendCallOutcome, type JobParent, type StageContext, arcSeat, callArcRole, minutesMs, recordedArcCall, runOp, unitBranch, verdictOf,
} from '../pipeline/dispatch.ts';
import { type JourneyEnd, arcJourneyLane, dirtyPaths, observedViews, removeJobCheckouts, runJourneySeries } from '../pipeline/lanes.ts';
import { architecture, docAt, inMs, judgmentEntry, ledgerDir, ledgerPath } from '../pipeline/stages.ts';
import { promptFor } from '../prompts/index.ts';
import type { FindingView, LensInputs } from '../prompts/inputs.ts';
import { type LensFinding, type LensOutput, validateLensOutput } from '../prompts/schemas.ts';
import { evidenceSnapshotOp, worktreeCreateOp, worktreeRemoveOp } from '../recover/ops.ts';
import { probe } from '../resources/probe.ts';
import { type JobHolder, type Reservation, cleanup, heldReservation, run } from '../resources/reserve.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { parseRulings } from '../spec/rulings.ts';
import { type Cadence, type Clock, cadence, integrationHeadNow, runOrder } from './cadence.ts';
import { coverageBase, lensCoverage } from './coverage.ts';
import { verdictOf as witnessVerdict } from './observe.ts';
import {
  FINDING_MOVES, type FindingEvidence, type LensKind, type ObservationVerdict, type Obligations, type Vision, type WitnessRecord, findingKey, isExempt, parseObligations, parseVision,
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
    rewitnessed: readonly Rewitnessed[];
  }>;

type Started = AuditState['started'];

/** A job's waits are never cancelled: an audit runs to its end once begun. */
const NEVER = new AbortController().signal;
const jobParent = (job: JobId): JobParent => ({ type: 'job', job });

/** Where an audit's checkouts go: the lanes' series, the lenses', a re-witness series (each basename starts with the job id). */
const checkoutOf = (ctx: StageContext, job: JobId, what: 'lanes' | 'lenses' | 'rewitness'): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.${what}`));

// ---------------------------------------------------------------------------------------------------
// Findings

/** A finding before its id and key: what a lens or code opens. `cause` feeds the key and is not recorded. */
export type FindingDraft = Omit<Extract<HolisticFact, { kind: 'finding-opened' }>, 'kind' | 'id' | 'key'> & Readonly<{ cause: string }>;
export type FindingOpen = Readonly<{ kind: 'opened' | 'merged'; id: FindingId }> | Readonly<{ kind: 'suppressed'; by: FindingId }>;

/** Whether a path the dismissed finding cited is cited now at another blob. */
function evidenceChanged(dismissed: readonly FindingEvidence[], now: readonly FindingEvidence[]): boolean {
  return now.some((e) => dismissed.some((d) => d.path === e.path && d.blob !== e.blob));
}

/** Opens `draft` as a finding, or merges or suppresses it (see the header). */
export function openFinding(journal: Journal, draft: FindingDraft): FindingOpen {
  const key = findingKey(draft.lens, draft.obligation, draft.cause);
  const same = journal.view.holistic().findings.filter((f) => f.key === key);
  const active = same.find((f) => FINDING_MOVES[f.state].length > 0);
  if (active !== undefined) return { kind: 'merged', id: active.id };
  const dismissed = same.filter((f) => f.last?.state === 'ruled' && f.last.disposition === 'dismissed').at(-1);
  if (dismissed !== undefined && !evidenceChanged(dismissed.evidence, draft.evidence)) return { kind: 'suppressed', by: dismissed.id };
  const id = journal.view.nextFindingId();
  const { cause: _cause, ...fields } = draft;
  journal.fact({ kind: 'finding-opened', id, key, ...fields });
  return { kind: 'opened', id };
}

/** The findings an audit opened or merged, and how many it suppressed. */
type Tally = { ids: Set<FindingId>; suppressed: number };
const tally = (t: Tally, o: FindingOpen): void => {
  if (o.kind === 'suppressed') t.suppressed += 1;
  else t.ids.add(o.id);
};

// ---------------------------------------------------------------------------------------------------
// The inputs, as recorded

type Recorded = Readonly<{ vision: Vision; obligations: Obligations | null; ledgerText: string }>;

function kept(ctx: StageContext, sha: Sha256Hex, ext: string): string {
  const bytes = keptInput(ctx.runDir, sha, ext);
  if (bytes === null) throw new Error(`the audit's inputs name ${ext} ${sha}, which is not kept`);
  return bytes.toString('utf8');
}

/** The vision, obligations and ledger the audit recorded, by their kept bytes. */
function recorded(ctx: StageContext, s: Started): Recorded {
  if (s.ledgerSha256 === null) throw new Error(`${s.job}: a holistic arc's revision in force keeps its ledger`);
  return {
    vision: parseVision(JSON.parse(kept(ctx, s.visionSha256, VISION_INPUT))),
    obligations: s.obligationsSha256 === null ? null : parseObligations(JSON.parse(kept(ctx, s.obligationsSha256, OBLIGATIONS_INPUT))),
    ledgerText: kept(ctx, s.ledgerSha256, RULINGS_INPUT),
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
    priorFindings: view.holistic().findings.map((f) => f.id).sort(),
    highWater: view.highWater(),
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

/** A lens's inputs from the recorded ones: the vision first, then the tree at the audited SHA and the range it covers. */
function lensInputs(ctx: StageContext, s: Started, r: Recorded, lens: LensKind, from: Sha, checkout: AbsPath): LensInputs {
  const sha = s.integrationSha;
  const rulings = parseRulings(r.ledgerText, ledgerPath(ctx));
  const diff = (a: Sha, b: Sha): string => (a === b ? '' : git(ctx.repo, ['diff', '--no-color', '--no-renames', a, b]));
  return {
    vision: { rev: r.vision.rev, clauses: r.vision.clauses },
    lens,
    obligations: r.obligations === null ? [] : observedViews(ctx, r.obligations, r.obligations.obligations, sha),
    range: { from, to: sha, diff: diff(from, sha) },
    owners: s.owners.map((o) => ({ unit: o.unit, head: o.head, diff: diff(diffBase(ctx.repo, sha, o.head), o.head) })),
    priorFindings: findingViews(ctx.journal.view.holistic().findings, s.priorFindings),
    contracts: ctx.plan().contracts.map((c) => docAt(ctx, sha, c)),
    rulings: rulings.flatMap((x) => (x.status === 'active' ? [{ id: x.id, text: x.text }] : [])),
    index: { contracts: [], rulings: rulings.flatMap((x) => (x.status === 'withdrawn' ? [{ id: x.id, line: `withdrawn by ${x.by}` }] : [])), ledger: ledgerPath(ctx) },
    architecture: architecture(ctx, sha),
    checkout,
  };
}

/** The blob `path` names at `sha` (a path under the checkout made relative), or null when it names no file there. */
function blobAt(ctx: StageContext, sha: Sha, checkout: AbsPath, path: string): FindingEvidence {
  const rel = isAbsolute(path) ? relative(checkout, path) : path;
  const blob = rel.startsWith('..') || catFileType(ctx.repo, `${sha}:${rel}`) !== 'blob' ? null : revParse(ctx.repo, `${sha}:${rel}`);
  return { path: blob === null ? path : rel, blob };
}

/** A lens's finding as a draft: its obligation and clauses kept only when they exist; a vision finding at most P2. */
function lensDraft(ctx: StageContext, s: Started, r: Recorded, lens: LensKind, f: LensFinding, checkout: AbsPath, gateHadPassed: boolean): FindingDraft {
  const obligationIds = new Set(r.obligations?.obligations.map((o) => o.id) ?? []);
  const clauseIds = new Set(r.vision.clauses.map((c) => c.id));
  const laneIds = new Set<LaneId>(r.obligations?.lanes.map((l) => l.id) ?? []);
  const evidence = [...new Map(f.evidence.map((e) => {
    const b = blobAt(ctx, s.integrationSha, checkout, e.path);
    return [b.path, b] as const;
  })).values()];
  const mutant = lens === 'vacuity' && f.mutant !== null && laneIds.has(f.mutant.lane)
    ? { patchSha256: keepInput(ctx.runDir, Buffer.from(f.mutant.patch, 'utf8'), 'patch'), lane: f.mutant.lane }
    : null;
  return {
    lens,
    severity: lens === 'vision' && f.severity === 'P1' ? 'P2' : f.severity,
    obligation: f.obligation !== null && obligationIds.has(f.obligation) ? f.obligation : null,
    visionClauses: [...new Set(f.visionClauses.filter((c): c is VisionClauseId => clauseIds.has(c)))].sort(),
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
  | Readonly<{ kind: 'failed'; detail: string }>
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
        if (error instanceof SchemaError) return { kind: 'failed', detail: `malformed report: ${error.message}` };
        throw error;
      }
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

/** Holds `@cpu`×1 under the job's holder around `body` (none on a legacy arc). */
export async function withCpu<T>(ctx: AuditContext, job: JobId, body: () => Promise<T>): Promise<T> {
  const request = judgmentEntry(ctx);
  if (request === null) return body();
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
  const dirty = dirtyPaths(path);
  const snap = await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${job}`, parent, {
    source: path, globs: dirty.map(pathPattern), dest: absPath(join(jobEvidenceRoot(ctx.runDir, job), basename(path))),
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
  const latched = new Set(ctx.journal.view.holistic().latched.map((l) => l.obligation));
  return r.obligations.obligations.flatMap((o): FindingDraft[] => {
    if (isExempt(o) || o.state.type === 'split' || o.witness === null) return [];
    if (o.activation !== 'must-hold' && !latched.has(o.id)) return [];
    const record = records.get(o.witness.lane);
    if (record === undefined) throw new Error(`${s.job}: obligation ${o.id}'s lane ${o.witness.lane} has no record on ${s.integrationSha}`);
    if (witnessVerdict(record, o.witness) !== 'not-held') return [];
    return [{
      lens: 'witness', severity: 'P1', obligation: o.id, visionClauses: [...o.serves].sort(),
      claim: `${o.id} is not held on ${s.integrationSha}: its witness ${o.witness.lane} (${o.witness.testIds.join(', ')}) fails there.`,
      cause: 'witness not held', evidence: [{ path: jobEvidenceRoot(ctx.runDir, s.job), blob: null }], mutant: null, source: { type: 'job', job: s.job }, gateHadPassed,
    }];
  });
}

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
  const t: Tally = { ids: new Set(), suppressed: 0 };

  // 2–3: the arc lanes on the audited SHA, then code's P1s.
  if (r.obligations !== null && r.obligations.lanes.length > 0) {
    const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, r.obligations.lanes.map(arcJourneyLane), {
      path: checkoutOf(ctx, job, 'lanes'), checkout: { type: 'detached', at: s.integrationSha },
    }, { reuse: true, stop: () => false });
    if (series.end.kind !== 'ran') return { kind: 'incomplete', job, end: series.end };
    const records = new Map(series.runs.flatMap((x) => (x.record === null ? [] : [[x.lane, x.record] as const])));
    for (const d of witnessDrafts(ctx, s, r, records, gateHadPassed)) tally(t, openFinding(ctx.journal, d));
  }

  // 4: the lenses, serially, the vision first.
  const base = coverageBase(ctx, s.integrationSha, s.seq);
  if (base === null) throw new Error(`${job}: no vision revision before its start`);
  const checkout = checkoutOf(ctx, job, 'lenses');
  const { triple } = arcSeat(ctx, 'lens');
  const prompt = promptFor('lens', triple.model);
  let made = false;
  const covered: LensKind[] = [];
  let outcome: 'completed' | 'abandoned' = 'completed';
  const order = runOrder(s.lenses);
  for (const [i, lens] of order.entries()) {
    const attempt = i + 1;
    const from = lensCoverage(ctx.journal.view.holistic(), base, lens, s.seq).watermark;
    let called = recordedArcCall(ctx, job, 'lens', attempt);
    if (called === null || called.kind === 'lost') {
      if (!made) {
        await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, parent, { path: checkout, checkout: { type: 'detached', at: s.integrationSha } });
        made = true;
      }
      const rendered = prompt.render(lensInputs(ctx, s, r, lens, from, checkout));
      called = await withCpu(ctx, job, () => callArcRole(ctx, {
        job, role: 'lens', attempt, system: prompt.system, rendered, schema: prompt.schema, cwd: checkout, evidenceDirs: [ledgerDir(ctx)],
        deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)),
      }));
    }
    const read = readLens(ctx, job, called);
    if (read.kind !== 'reported') {
      outcome = 'abandoned';
      if (read.kind === 'parked') break;
      continue;
    }
    for (const f of read.output.findings) tally(t, openFinding(ctx.journal, lensDraft(ctx, s, r, lens, f, checkout, gateHadPassed)));
    covered.push(lens);
    crashPoint('audit.after-lens');
  }

  // 5: the checkout removed, then the end: coverage only for the lenses that reported, up to the audited SHA.
  if (made) await removeCheckout(ctx, job, checkout);
  crashPoint('audit.before-ended');
  const ranges = covered.flatMap((lens) => {
    const from = lensCoverage(ctx.journal.view.holistic(), base, lens, s.seq).watermark;
    return from === s.integrationSha ? [] : [{ lens, from, to: s.integrationSha }];
  }).sort((a, b) => (a.lens < b.lens ? -1 : 1));
  const findings = [...t.ids].sort();
  ctx.journal.fact({ kind: 'audit-ended', job, covered: ranges, findings, suppressed: t.suppressed, outcome });
  crashPoint('audit.after-ended');
  if (outcome === 'abandoned') {
    const c = cadence(ctx, ctx.clock);
    if (c !== null) raiseAuditOwed(ctx, c);
  }

  // 6: the race: the cited P1s re-witnessed on the head that moved meanwhile.
  const rewitnessed = await rewitnessP1s(ctx, job);
  return { kind: 'ended', job, outcome, covered: covered.sort(), findings, suppressed: t.suppressed, rewitnessed };
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
    path: checkoutOf(ctx, job, 'rewitness'), checkout: { type: 'detached', at: head },
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

