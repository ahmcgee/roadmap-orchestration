// Proportional review records (dev.17; SCHEMAS.md "dev.17 records"): the gate findings ledger and the approval's blob
// record. Types and readers only; the gate wires them.
import { type ReviewFindingId, type Sha, type SpecRev, type UnitId, reviewFindingId, sha, specRev, unitId } from './ids.ts';
import { type RepoPath, repoPath } from './values.ts';
import { type Read, nullable, object, oneOf, sortedBy } from './validate.ts';

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
