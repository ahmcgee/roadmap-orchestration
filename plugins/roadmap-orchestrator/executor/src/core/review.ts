// Proportional review records (dev.17; SCHEMAS.md "dev.17 records", "Proportional review"): the gate findings ledger, the
// approval's blob record, and the review a gate attempt was given (src/pipeline/review.ts wires them).
import { type ReviewFindingId, type Sha, type SpecRev, type UnitId, reviewFindingId, sha, specRev, unitId } from './ids.ts';
import { type Pin, movedPins } from './pins.ts';
import type { ApprovalFingerprint } from './records.ts';
import { type RepoPath, repoPath } from './values.ts';
import { type Read, arrayOf, nullable, object, oneOf, positive, sortedBy, str } from './validate.ts';

/**
 * How a ledger finding settled: `fixed`; a builder dispute the next gate `disputed-upheld` (the finding stands) or
 * `disputed-overruled` (it falls); `released` (not fixed, not debt); `banked` (debt). A settled finding is never raised
 * again unless its anchor blob changed.
 */
export const LEDGER_OUTCOMES = ['fixed', 'disputed-upheld', 'disputed-overruled', 'released', 'banked'] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/** One gate finding in the arc's findings ledger: where it was raised, the blob it was raised against, how it settled (null: not yet). */
export type FindingsLedgerEntry = Readonly<{ id: ReviewFindingId; unit: UnitId; path: RepoPath; anchor: Sha; outcome: LedgerOutcome | null }>;

export const findingsLedgerEntry: Read<FindingsLedgerEntry> = object((f) => ({
  id: f.get('id', (v, p) => reviewFindingId(v, p)),
  unit: f.get('unit', (v, p) => unitId(v, p)),
  path: f.get('path', (v, p) => repoPath(v, p)),
  anchor: f.get('anchor', (v, p) => sha(v, p)),
  outcome: f.get('outcome', nullable(oneOf(LEDGER_OUTCOMES))),
}));

/**
 * What an approval approved, by blob (the delta re-gate): each file the unit changed, at its blob in the approved tree
 * (null: the unit deleted it), ascending by path. A later round reviews only the files whose blob moved.
 */
export type ApprovalBlobs = Readonly<{ unit: UnitId; specRev: SpecRev; files: readonly Readonly<{ path: RepoPath; blob: Sha | null }>[] }>;

export const approvalBlobs: Read<ApprovalBlobs> = object((f) => ({
  unit: f.get('unit', (v, p) => unitId(v, p)),
  specRev: f.get('specRev', (v, p) => specRev(v, p)),
  files: f.get('files', sortedBy(object((g) => ({ path: g.get('path', (v, p) => repoPath(v, p)), blob: g.get('blob', nullable((v, p) => sha(v, p))) })), (e) => e.path)),
}));

// ---------------------------------------------------------------------------------------------------
// The review a gate attempt was given (dev.17 wiring; DESIGN-1.0.md §4 "Proportional review"), recorded on its
// `judgment-inputs` so the rules its answer is held to follow from the log alone on replay and recovery.

/** A builder's dispute of an open ledger finding (decisions.json `disputes`), put to the next gate, which rules once. */
export type ReviewDispute = Readonly<{ finding: ReviewFindingId; reason: string }>;

export const reviewDispute: Read<ReviewDispute> = object((f) => ({ finding: f.get('finding', (v, p) => reviewFindingId(v, p)), reason: f.get('reason', str) }));

/**
 * A later round's delta from the unit's approval: the files under review (each changed path whose blob moved since the
 * approval, and each unchanged one that names a moved target), the approved files that are unchanged (listed, readable, not
 * under review), and the targets the approval bound that moved since (`movedTargets`). Each list ascending.
 */
export type GateDelta = Readonly<{
  approved: Readonly<{ attempt: number; head: Sha }>;
  review: readonly RepoPath[];
  unchanged: readonly RepoPath[];
  moved: readonly string[];
}>;

/**
 * What a dev.17 gate attempt was given beside its prompt: the unit's findings ledger at its capture, the disputes it rules
 * on, and its delta from the unit's approval (null: a full review, before any approval or after a spec revision).
 */
export type GateReview = Readonly<{ ledger: readonly FindingsLedgerEntry[]; disputes: readonly ReviewDispute[]; delta: GateDelta | null }>;

const ascending = <T>(read: Read<T>): Read<readonly T[]> => sortedBy(read, (x) => String(x));

export const gateReview: Read<GateReview> = object((f) => ({
  ledger: f.get('ledger', arrayOf(findingsLedgerEntry)),
  disputes: f.get('disputes', arrayOf(reviewDispute)),
  delta: f.get('delta', nullable(object((g): GateDelta => ({
    approved: g.get('approved', object((h) => ({ attempt: h.get('attempt', positive), head: h.get('head', (v, p) => sha(v, p)) }))),
    review: g.get('review', ascending((v, p) => repoPath(v, p))),
    unchanged: g.get('unchanged', ascending((v, p) => repoPath(v, p))),
    moved: g.get('moved', ascending(str)),
  })))),
}));

/** A ledger finding is settled once it has an outcome: fixed, released, banked or a ruled dispute. */
export const isSettled = (e: FindingsLedgerEntry): boolean => e.outcome !== null;

/**
 * The targets an approval bound that moved by `now` (keys a finding's `contractRef` names): each cited contract by path and
 * each selected requirement by id whose pin differs (`movedPins`), each cited ruling by id whose revision differs, and
 * `corpus` when the pin in force did. Ascending.
 */
export function movedTargets(approved: ApprovalFingerprint, now: ApprovalFingerprint): readonly string[] {
  const pins = (fp: ApprovalFingerprint): readonly Pin[] => [
    ...fp.contractRevs.map((c): Pin => ({ type: 'contract', path: c.path, blob: c.blob })),
    ...(fp.obligationRevs ?? []).map((o): Pin => ({ type: 'requirement', id: o.id, rev: o.rev })),
  ];
  const rulings = (fp: ApprovalFingerprint): ReadonlyMap<string, number> => new Map(fp.rulingRevs.map((r) => [r.id as string, r.rev]));
  const before = rulings(approved);
  const after = rulings(now);
  const movedRulings = [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
  return [...new Set([
    ...movedPins(pins(approved), pins(now)).map((p) => (p.type === 'contract' || p.type === 'file' ? p.path : p.id) as string),
    ...movedRulings,
    ...(approved.corpus === now.corpus ? [] : ['corpus']),
  ])].sort();
}
