// The findings store (DESIGN-1.0.md §2.8 "Findings and repair"; plan "Findings and repair"; M3 step B3). The log is the
// store: `finding-opened` and `finding-transition` facts, folded into `HolisticFold.findings` (src/core/state.ts). This
// module decides what is written and derives everything else from the fold.
//
// - **Opening and dedupe.** Openers: an audit's lenses, code's witness P1s, plan-check (R17) and a checkpoint's issue
//   intake (M4a, lens `issue`). `key = findingKey(lens, obligation, cause)`. A key matching an active finding (open, owned,
//   fixed-on-branch) merges into it: nothing is written. A key matching a finding ruled `dismissed` is suppressed unless
//   a cited evidence blob changed (a path both cite, with a different blob): a dismissal lasts the arc's lifetime (the
//   growth control is its scope: the arc's own log, never carried into the next arc). A vacuity finding's mutant patch
//   is checked at admission and kept content-addressed first (`admitMutant`: `checkPatch`, then `keepMutantPatch`,
//   `inputs/<sha256>.patch`), so its fact names kept bytes; a patch git cannot parse refuses the draft (H6). Within one
//   audit, a second lens's draft with an equal `crossKey` corroborates the first (`corroborateFinding`, H7).
// - **States (R5).** `open → owned → fixed-on-branch → resolved`, or `ruled`. Ownership follows the units that repair a
//   finding (`ownershipMoves`, driven by src/pipeline/reproduce.ts `syncRepairs`): the first live unit whose spec
//   repairs it owns it; its gate's approval standing makes it `fixed-on-branch`; its publication resolves it. A
//   `witness` P1 is also resolved by any unit repairing its obligation that publishes after it opened (the brake proved
//   the obligation held with integrated evidence). Ruling a finding is `ruleFinding`: P1s never bank (a checkpoint may
//   only dismiss one; deferring or accepting it takes a disposition ruling).
// - **Blocking (G10).** An active P1 over an obligation a candidate selects blocks it, unless the unit's spec repairs
//   that obligation (`p1Blocking`): at admission (src/schedule/ready.ts), before green and before the ff
//   (src/pipeline/integrate.ts `findingBlocking`).
// - **Needs-user items (durable, derived).** A parked owner's P1 escalates at the park deadline (`finding-p1-escalated`,
//   blocking); a P1 or P2 opened while draining raises `new-finding-draining` (blocking) once its audit ended. Both are
//   derived from the log (`findingItemsDue`) and raised once each (`raiseFindingItems`), so a crash between the finding
//   and its item loses nothing.
// - **Instrumentation.** `findingMetrics`: per finding `{lens, severity, gateHadPassed, disposition, merged,
//   timeToResolveMs}`, over the log's events (their times).
import { isAbsolute } from 'node:path';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { Event, HolisticFact, Parent } from '../core/events.ts';
import {
  type FindingId, type IssueId, type JobId, type LaneId, type NeedsUserId, type ObligationId, type Sha256Hex, type UnitId, type VisionClauseId, canonicalIds, sha256,
} from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { NeedsUserContent, NeedsUserReason, RepairRef } from '../core/records.ts';
import type { FindingState } from '../core/state.ts';
import type { AbsPath } from '../core/values.ts';
import { MUTANT_PATCH_INPUT } from '../git/mutant.ts';
import { checkPatch } from '../git/patchcheck.ts';
import { keepInput } from '../input/inforce.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import { PARK_ESCALATE_MS } from '../schedule/types.ts';
import {
  type FindingDisposition, type FindingEvidence, type FindingLens, type FindingRuledBy, type FindingSeverity, type FindingSource, type FindingStateName,
  type FindingTo, type LensKind, FINDING_MOVES, findingKey,
} from './types.ts';

// ---------------------------------------------------------------------------------------------------
// Opening and dedupe

/**
 * A finding before its id and key: what a lens, code over a witness, or plan-check (R17) reports. `cause` feeds the key
 * and is not recorded. A vacuity finding's mutant patch is already kept (`keepMutantPatch`).
 */
export type FindingDraft = Omit<Extract<HolisticFact, { kind: 'finding-opened' }>, 'kind' | 'id' | 'key'> & Readonly<{ cause: string }>;

/** Keeps a mutant's patch (a unified diff against the repo root) as `inputs/<sha256>.patch`; its sha names it. */
export const keepMutantPatch = (runDir: AbsPath, patch: string): Sha256Hex => keepInput(runDir, Buffer.from(patch, 'utf8'), MUTANT_PATCH_INPUT);

/** A vacuity draft's mutant at admission: kept, or refused because git cannot parse its patch (git's stderr). */
export type MutantAdmission =
  | Readonly<{ kind: 'kept'; mutant: Readonly<{ patchSha256: Sha256Hex; lane: LaneId }> }>
  | Readonly<{ kind: 'corrupt'; stderr: string }>;

/**
 * H6 (F14): a vacuity finding's mutant patch checked before anything rests on it (`checkPatch`, read-only in `repo`),
 * then kept. A corrupt patch is never kept: its draft is refused (nothing opened) with git's stderr.
 */
export function admitMutant(repo: AbsPath, runDir: AbsPath, patch: string, lane: LaneId): MutantAdmission {
  const check = checkPatch(repo, patch);
  if (check.kind === 'corrupt') return check;
  return { kind: 'kept', mutant: { patchSha256: keepMutantPatch(runDir, patch), lane } };
}

const ACTIVE: ReadonlySet<FindingStateName> = new Set(['open', 'owned', 'fixed-on-branch']);
/** Open, owned or fixed-on-branch: not yet resolved or ruled. */
export const isActive = (f: FindingState): boolean => ACTIVE.has(f.state);

/** How a draft enters the store (pure): a new finding, merged into the active one with its key, or suppressed by a dismissal. */
type FindingAdmission =
  | Readonly<{ kind: 'open'; key: Sha256Hex }>
  | Readonly<{ kind: 'merged'; id: FindingId }>
  | Readonly<{ kind: 'suppressed'; by: FindingId }>;

/** Whether `after` cites a path `before` cited, naming a different blob: new evidence that lifts a dismissal. */
export function evidenceChanged(before: readonly FindingEvidence[], after: readonly FindingEvidence[]): boolean {
  const was = new Map(before.flatMap((e) => (e.blob === null ? [] : [[e.path, e.blob] as const])));
  return after.some((e) => e.blob !== null && was.has(e.path) && was.get(e.path) !== e.blob);
}

const dismissed = (f: FindingState): boolean => f.state === 'ruled' && f.last?.state === 'ruled' && f.last.disposition === 'dismissed';

/** The dedupe decision for a draft with `key` and `evidence` against the arc's findings. Pure. */
export function admissionOf(findings: readonly FindingState[], key: Sha256Hex, evidence: readonly FindingEvidence[]): FindingAdmission {
  const active = findings.find((f) => f.key === key && isActive(f));
  if (active !== undefined) return { kind: 'merged', id: active.id };
  const dismissal = findings.filter((f) => f.key === key && dismissed(f)).at(-1);
  if (dismissal !== undefined && !evidenceChanged(dismissal.evidence, evidence)) return { kind: 'suppressed', by: dismissal.id };
  return { kind: 'open', key };
}

/** What `openFinding` did: a new finding, merged into the active one (nothing written), or suppressed by a dismissal. */
export type FindingOpen = Readonly<{ kind: 'opened' | 'merged'; id: FindingId }> | Readonly<{ kind: 'suppressed'; by: FindingId }>;

/**
 * Opens a finding from `draft` (a `finding-opened` fact with the next id), or merges or suppresses it (nothing written).
 * The one store every opener uses (audits, code's witness P1s, plan-check, the checkpoint).
 */
export function openFinding(journal: Journal, draft: FindingDraft): FindingOpen {
  const key = findingKey(draft.lens, draft.obligation, draft.cause);
  const admission = admissionOf(journal.view.holistic().findings, key, draft.evidence);
  if (admission.kind !== 'open') return admission;
  const id = journal.view.nextFindingId();
  const { cause: _cause, ...fields } = draft;
  journal.fact({ kind: 'finding-opened', id, key, ...fields, visionClauses: canonicalIds(draft.visionClauses) });
  return { kind: 'opened', id };
}

/**
 * The cross-lens key of a draft (H7, R62): its repo evidence paths (relative ones; absolute and evidence-dir paths are
 * not the product's), sorted and once each, its obligation and its cause; the lens is left out. Within one audit, a
 * second lens's draft with an equal key is the same defect (src/holistic/audit.ts); across audits `findingKey` dedupes.
 */
export function crossKey(draft: FindingDraft): Sha256Hex {
  const paths = [...new Set(draft.evidence.map((e) => e.path).filter((p) => !isAbsolute(p)))].sort();
  return sha256(sha256Hex(canonicalJson({ paths, obligation: draft.obligation, cause: draft.cause })));
}

/**
 * Records that `lens` saw finding `id` too (`finding-corroborated`, keeping its claim as the rationale), once: a resumed
 * audit asking the same lens again writes nothing new.
 */
export function corroborateFinding(journal: Journal, id: FindingId, lens: LensKind, claim: string): void {
  if (journal.view.holistic().corroborations.some((c) => c.id === id && c.lens === lens && c.claim === claim)) return;
  journal.fact({ kind: 'finding-corroborated', id, lens, claim });
}

/**
 * Code's P1 over a must-hold (or latched) obligation not held on an audit snapshot (`lens: witness`): one stable cause
 * per obligation, citing the clauses it serves.
 */
export function witnessFindingDraft(input: Readonly<{
  obligation: ObligationId; serves: readonly VisionClauseId[]; job: JobId; claim: string; evidence: readonly FindingEvidence[]; gateHadPassed: boolean;
}>): FindingDraft {
  return {
    lens: 'witness', severity: 'P1', obligation: input.obligation, visionClauses: canonicalIds(input.serves), claim: input.claim,
    cause: 'witness not held', evidence: input.evidence, mutant: null, source: { type: 'job', job: input.job }, gateHadPassed: input.gateHadPassed,
  };
}

/** Plan-check's vision conflict (R17): a P3 for the checkpoint, never a redirect by itself. */
export function visionConflictDraft(input: Readonly<{
  unit: UnitId; attempt: number; clauses: readonly VisionClauseId[]; note: string;
}>): FindingDraft {
  return {
    lens: 'plan-check', severity: 'P3', obligation: null, visionClauses: input.clauses, claim: input.note, cause: `${input.unit}: ${input.note}`,
    evidence: [], mutant: null, source: { type: 'stage', unit: input.unit, stage: 'plan-check', attempt: input.attempt }, gateHadPassed: false,
  };
}

/**
 * A captured issue's finding (M4a: a checkpoint's intake outcome `finding`, lens `issue`, P2 or P3): one stable cause per
 * issue and cause, opened by the checkpoint whose capture held the issue.
 */
export function issueFindingDraft(input: Readonly<{ issue: IssueId; job: JobId; severity: 'P2' | 'P3'; claim: string; cause: string }>): FindingDraft {
  return {
    lens: 'issue', severity: input.severity, obligation: null, visionClauses: [], claim: input.claim, cause: `${input.issue}: ${input.cause}`,
    evidence: [], mutant: null, source: { type: 'job', job: input.job }, gateHadPassed: false,
  };
}

// ---------------------------------------------------------------------------------------------------
// Ruling

/**
 * Why `disposition` by `by` may not rule `finding`, or null when it may. Only an active finding is ruled; P1s never bank:
 * deferring or accepting one takes a disposition ruling (a checkpoint or code may only dismiss it).
 */
export function rulingRefusal(finding: FindingState, disposition: FindingDisposition, by: FindingRuledBy): string | null {
  if (!isActive(finding)) return `finding ${finding.id} is ${finding.state}`;
  if (finding.severity === 'P1' && disposition !== 'dismissed' && by.type !== 'ruling') return `finding ${finding.id} is a P1: P1s never bank (only a disposition ruling ${disposition === 'deferred' ? 'defers' : 'accepts'} one)`;
  return null;
}

/** Rules a finding; refuses loudly what `rulingRefusal` refuses (a caller validates a checkpoint's dispositions first). */
export function ruleFinding(journal: Journal, id: FindingId, disposition: FindingDisposition, by: FindingRuledBy): void {
  const finding = journal.view.holistic().findings.find((f) => f.id === id);
  if (finding === undefined) throw new Error(`finding ${id} was never opened`);
  const refusal = rulingRefusal(finding, disposition, by);
  if (refusal !== null) throw new Error(`ruling ${id} ${disposition}: ${refusal}`);
  journal.fact({ kind: 'finding-transition', id, to: { state: 'ruled', disposition, by } });
}

// ---------------------------------------------------------------------------------------------------
// Blocking (G10)

/** The obligations `repairs` names: its `I-n`, and the obligation of each finding it names (one over none names nothing). */
export function repairedObligations(findings: readonly FindingState[], repairs: readonly RepairRef[]): ReadonlySet<ObligationId> {
  return new Set(repairs.flatMap((r): ObligationId[] => {
    if (!r.startsWith('F-')) return [r as ObligationId];
    const o = findings.find((f) => f.id === r)?.obligation ?? null;
    return o === null ? [] : [o];
  }));
}

/** An active P1 finding that blocks a publication, and the selected obligation it is over. */
export type FindingBlock = Readonly<{ finding: FindingId; obligation: ObligationId }>;

/**
 * The first active P1 (by id) over an obligation in `selected` that `repaired` does not name, or null. The declared
 * repair publishes only when its candidate shows the obligation held (the brake, src/pipeline/integrate.ts).
 */
export function p1Blocking(findings: readonly FindingState[], selected: ReadonlySet<ObligationId>, repaired: ReadonlySet<ObligationId>): FindingBlock | null {
  for (const f of findings) {
    if (f.severity !== 'P1' || !isActive(f) || f.obligation === null) continue;
    if (selected.has(f.obligation) && !repaired.has(f.obligation)) return { finding: f.id, obligation: f.obligation };
  }
  return null;
}

/** The obligations active P1s are over: what the known-regression rule reads (R4, G11). */
export const p1Obligations = (findings: readonly FindingState[]): ReadonlySet<ObligationId> =>
  new Set(findings.flatMap((f) => (f.severity === 'P1' && isActive(f) && f.obligation !== null ? [f.obligation] : [])));

// ---------------------------------------------------------------------------------------------------
// Ownership (R5)

/** Where a repairing unit is: working (no standing approval), approved (its gate's approval stands), published, or gone. */
export type RepairProgress =
  | Readonly<{ kind: 'working' }>
  | Readonly<{ kind: 'approved' }>
  | Readonly<{ kind: 'published'; seq: number }>
  | Readonly<{ kind: 'gone' }>;

/** A unit whose spec repairs something, in plan order (src/pipeline/reproduce.ts `repairUnits`). */
export type RepairUnit = Readonly<{ unit: UnitId; repairs: readonly RepairRef[]; progress: RepairProgress }>;

type Target = Readonly<{ state: 'open' }> | Readonly<{ state: 'owned' | 'fixed-on-branch' | 'resolved'; unit: UnitId }>;

/** The state a finding should be in given the repairing units, or null for one that is not active (never touched). */
function targetOf(f: FindingState, all: readonly FindingState[], units: readonly RepairUnit[]): Target | null {
  if (!isActive(f)) return null;
  const direct = (u: RepairUnit): boolean => u.repairs.includes(f.id);
  const byObligation = (u: RepairUnit): boolean => f.lens === 'witness' && f.obligation !== null && repairedObligations(all, u.repairs).has(f.obligation);
  const publisher = units.find((u) => u.progress.kind === 'published' && u.progress.seq > f.openedSeq && (direct(u) || byObligation(u)));
  if (publisher !== undefined) return { state: 'resolved', unit: publisher.unit };
  const owner = units.find((u) => direct(u) && (u.progress.kind === 'working' || u.progress.kind === 'approved'));
  if (owner !== undefined) return { state: owner.progress.kind === 'approved' ? 'fixed-on-branch' : 'owned', unit: owner.unit };
  return { state: 'open' };
}

/** The legal moves (FINDING_MOVES) from `f` to `target`, each a `finding-transition` target. */
function movesTo(f: FindingState, target: Target): readonly FindingTo[] {
  const at = f.state;
  const owner = f.owner;
  if (target.state === 'open') return at === 'open' ? [] : [{ state: 'open' }];
  const u = target.unit;
  const own: FindingTo = { state: 'owned', unit: u };
  const fixed: FindingTo = { state: 'fixed-on-branch', unit: u };
  switch (target.state) {
    case 'owned':
      if (at === 'owned') return owner === u ? [] : [{ state: 'open' }, own];
      return [own];
    case 'fixed-on-branch':
      if (at === 'fixed-on-branch') return owner === u ? [] : [own, fixed];
      return at === 'open' ? [own, fixed] : [fixed];
    case 'resolved':
      if (at === 'fixed-on-branch' && owner === u) return [{ state: 'resolved' }];
      if (at === 'fixed-on-branch') return [own, fixed, { state: 'resolved' }];
      return at === 'open' ? [own, fixed, { state: 'resolved' }] : [fixed, { state: 'resolved' }];
  }
}

/** Every transition the repairing units call for, per finding in id order. Pure; each list follows FINDING_MOVES. */
export function ownershipMoves(findings: readonly FindingState[], units: readonly RepairUnit[]): readonly Readonly<{ id: FindingId; to: readonly FindingTo[] }>[] {
  return findings.flatMap((f) => {
    const target = targetOf(f, findings, units);
    if (target === null) return [];
    const to = movesTo(f, target);
    for (let i = 0, state = f.state; i < to.length; state = to[i]!.state, i++) {
      if (!FINDING_MOVES[state].includes(to[i]!.state)) throw new Error(`finding ${f.id}: the move ${state} → ${to[i]!.state} is not legal`);
    }
    return to.length === 0 ? [] : [{ id: f.id, to }];
  });
}

/** Writes what `ownershipMoves` calls for; re-runnable (a restart writes only what is still missing). */
export function syncFindings(journal: Journal, units: readonly RepairUnit[]): void {
  for (const m of ownershipMoves(journal.view.holistic().findings, units)) {
    for (const to of m.to) journal.fact({ kind: 'finding-transition', id: m.id, to });
  }
}

/** The active findings two or more approved units repair directly: what a repair batch publishes (R7; the scheduler decides, B7). */
export function batchable(findings: readonly FindingState[], units: readonly RepairUnit[]): readonly Readonly<{ finding: FindingId; units: readonly UnitId[] }>[] {
  return findings.flatMap((f) => {
    if (!isActive(f)) return [];
    const approved = units.filter((u) => u.repairs.includes(f.id) && u.progress.kind === 'approved').map((u) => u.unit);
    return approved.length >= 2 ? [{ finding: f.id, units: approved }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------
// Needs-user items (durable: derived from the log, raised once each)

export type FindingItem = Readonly<{ parent: Parent; reason: Extract<NeedsUserReason, 'finding-p1-escalated' | 'new-finding-draining'>; content: NeedsUserContent }>;

/**
 * The items due at `now`: a `finding-p1-escalated` per park of an owner holding an active P1, once the park is
 * PARK_ESCALATE_MS old (parented by the park's stage attempt); a `new-finding-draining` per job that opened a P1 or P2
 * while draining, once an audit job ended (parented by the job).
 */
export function findingItemsDue(view: JournalView, now: Date): readonly FindingItem[] {
  const fold = view.holistic();
  const out: FindingItem[] = [];
  const escalating = new Map<UnitId, FindingId[]>();
  for (const f of fold.findings) {
    if (f.severity !== 'P1' || !isActive(f) || f.owner === null || f.state === 'open') continue;
    escalating.set(f.owner, [...(escalating.get(f.owner) ?? []), f.id]);
  }
  for (const [unit, ids] of escalating) {
    const u = view.unit(unit);
    const d = u.decided;
    if (u.park === null || d === null || d.class !== 'park' || Date.parse(u.park.at) + PARK_ESCALATE_MS > now.getTime()) continue;
    out.push({
      parent: { type: 'stage', unit, stage: d.stage, attempt: d.attempt },
      reason: 'finding-p1-escalated',
      content: {
        blocking: true, subject: { type: 'arc' }, reason: 'finding-p1-escalated',
        summary: `P1 finding${ids.length > 1 ? 's' : ''} ${ids.join(', ')} ${ids.length > 1 ? 'are' : 'is'} owned by unit ${unit}, parked at ${d.stage} since ${u.park.at}, more than 6 h. `
          + 'A P1 blocks every merge that selects its obligation until its repair publishes.',
        recommendation: `Unblock ${unit} (read its park item and \`roadmap status\`), or re-plan the repair; the finding stays open until a repair publishes or it is ruled.`,
        options: [], evidence: [],
      },
    });
  }
  const draining = fold.draining;
  if (draining !== null) {
    const byJob = new Map<JobId, FindingId[]>();
    for (const f of fold.findings) {
      if ((f.severity !== 'P1' && f.severity !== 'P2') || !isActive(f) || f.openedSeq <= draining.seq || f.source.type !== 'job') continue;
      byJob.set(f.source.job, [...(byJob.get(f.source.job) ?? []), f.id]);
    }
    for (const [job, ids] of byJob) {
      const audit = fold.audits.find((a) => a.started.job === job);
      if (audit !== undefined && audit.ended === null) continue;
      out.push({
        parent: { type: 'job', job },
        reason: 'new-finding-draining',
        content: {
          blocking: true, subject: { type: 'arc' }, reason: 'new-finding-draining',
          summary: `${job} opened ${ids.join(', ')} (P1 or P2) while the arc is draining (close-admissions ${draining.command}): no new unit is admitted to repair ${ids.length > 1 ? 'them' : 'it'}.`,
          recommendation: 'Decide: admit a repair with `roadmap apply` (an architect admit reopens admissions), or rule the finding, then acknowledge this item.',
          options: [], evidence: [],
        },
      });
    }
  }
  return out;
}

/** Whether a done raise parented by `parent` recorded an item with `reason`. */
function raisedWith(view: JournalView, runDir: AbsPath, parent: Parent, reason: NeedsUserReason): boolean {
  const key = canonicalJson(parent);
  return view.opsOf('needsuser.raise').some((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null && readNeedsUser(runDir, i.expect.id)?.reason === reason);
}

/** Raises every due item not raised yet (the scheduler's tick calls it, B7). Returns the ids raised. */
export function raiseFindingItems(journal: Journal, runDir: AbsPath, now: Date): readonly NeedsUserId[] {
  const raised: NeedsUserId[] = [];
  for (const item of findingItemsDue(journal.view, now)) {
    if (raisedWith(journal.view, runDir, item.parent, item.reason)) continue;
    raised.push(raiseNeedsUser(journal, runDir, item.content, item.parent));
  }
  return raised;
}

// ---------------------------------------------------------------------------------------------------
// Instrumentation (§2.8: arc 2 measures whether the checkpoint works)

export type FindingMetric = Readonly<{
  id: FindingId;
  lens: FindingLens;
  severity: FindingSeverity;
  gateHadPassed: boolean;
  /** The ruling's disposition; null while active or once resolved. */
  disposition: FindingDisposition | null;
  /** Resolved by a repair's publication. */
  merged: boolean;
  /** From its opening to its resolution or ruling; null while active. */
  timeToResolveMs: number | null;
}>;

/** Per finding, over the log's events (their times) and the fold's states. */
export function findingMetrics(events: readonly Event[], findings: readonly FindingState[]): readonly FindingMetric[] {
  const opened = new Map<FindingId, number>();
  const closed = new Map<FindingId, number>();
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'finding-opened') opened.set(f.id, Date.parse(e.at));
    if (f.kind === 'finding-transition' && (f.to.state === 'resolved' || f.to.state === 'ruled')) closed.set(f.id, Date.parse(e.at));
  }
  return findings.map((f) => {
    const from = opened.get(f.id);
    const to = closed.get(f.id);
    if (from === undefined) throw new Error(`finding ${f.id} has no finding-opened event`);
    return {
      id: f.id, lens: f.lens, severity: f.severity, gateHadPassed: f.gateHadPassed,
      disposition: f.last?.state === 'ruled' ? f.last.disposition : null,
      merged: f.state === 'resolved',
      timeToResolveMs: isActive(f) || to === undefined ? null : to - from,
    };
  });
}
