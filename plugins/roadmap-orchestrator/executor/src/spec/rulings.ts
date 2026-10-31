// The C-nn ledger (plan `rulings`, relative to the plan dir; DESIGN-1.0.md §2.6): one ruling per line,
// `C-<n> — <rule>`, rule text only (provenance lives in the in-tree constraints.md, rendered from the sidecars by
// src/docs/constraints.ts, because a judgment needs the rule and not who ruled it: arc-1 feedback item 13). A
// superseded or withdrawn ruling folds to one line, `C-<n> — withdrawn by C-<m>`, naming a ruling of the same
// ledger. Blank lines and `#` headings are skipped; anything else is refused, and so is an id listed twice.
//
// M3 (step A1): a new ruling arrives as a JSON sidecar (`roadmap/ruling-m3`, src/holistic/types.ts), from `rule` or
// a checkpoint bundle, and `validateRuling` checks it against the revisions in force before it lands (every reason
// listed, all or none):
//   identity        the next C-n of the ledger (editing an existing id is refused: supersede is the only change),
//                   status active, a one-line statement that is not a withdrawn fold
//   supersession    every target an active ruling of the ledger, each once, never itself
//   docRefs         each anchor names exactly one place of its document at the tip, and the quoted text is under it
//                   (M4a, step C1: a rule ref resolves to `{T-n, textSha256}` active in the corpus pin in force; a rule
//                   ref outside a corpus arc is refused)
//   contract ops    only on the plan's contracts and architecture docs, never on a corpus file (M4a, R32: the same-repo
//                   corpus file set, pinned files and include matches), each listed in `contractRefs`; anchor-exact,
//                   old text exactly once under the anchor, no two ops of one document with overlapping anchors
//                   (`deviates` without ops is refused by the reader)
//   obligations     named ids exist; every disposition's id is among `obligations`
//   vision          every cited clause active (`citeReasons`); appliesTo names planned units
//   consistency     (G21) the verdict `consistent`, judged by the checkpoint's own judgment for a checkpoint ruling,
//                   and `judgedRevs` equal to the revisions in force: the ledger, the obligations and the vision
//                   bytes, the corpus pin in a corpus arc (M4a), and the blob of every contract it names or edits
//                   (`consistencyRevs`). The judged head is
//                   provenance only: a merge that leaves those untouched keeps the judgment fresh (lead ruling,
//                   2026-09-30), and docRefs are re-checked at the tip regardless

// `ledgerAfter` and `sidecarsAfter` put a validated ruling in force: its line appended, every fully superseded
// ruling folded to `withdrawn by` (and its sidecar marked `superseded`), the ledger's other bytes kept.
import { readFileSync } from 'node:fs';
import { type RuleId, type RulingId, type Sha, type Sha256Hex, type UnitId, rulingId, compareIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { SchemaError } from '../core/validate.ts';
import type { RepoPath } from '../core/values.ts';
import { applyContractOps, quotedTextReason } from '../docs/contracts.ts';
import { type Consistency, type Obligations, type RulingSidecar, type Vision, rulingRefSource } from '../holistic/types.ts';
import { citeReasons } from '../holistic/vision.ts';

export type Ruling =
  | Readonly<{ id: RulingId; status: 'active'; text: string }>
  | Readonly<{ id: RulingId; status: 'withdrawn'; by: RulingId }>;

const RULING_LINE = /^(C-[0-9]+) — (.+)$/;
const WITHDRAWN = /^withdrawn by (C-[0-9]+)$/;

/** Parses ledger text; `file` only names the ledger in errors. */
export function parseRulings(text: string, file: string): readonly Ruling[] {
  const out = text.split('\n').flatMap((line, i): Ruling[] => {
    if (line.trim() === '' || line.startsWith('#')) return [];
    const m = RULING_LINE.exec(line);
    if (m === null) throw new SchemaError(`${file}:${i + 1}`, 'a ruling line "C-<n> — <rule>"', line);
    const id = rulingId(m[1], `${file}:${i + 1}`);
    const w = WITHDRAWN.exec(m[2]!);
    return [w === null ? { id, status: 'active', text: m[2]! } : { id, status: 'withdrawn', by: rulingId(w[1], `${file}:${i + 1}`) }];
  });
  const ids = out.map((r) => r.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined) throw new SchemaError(file, 'each ruling id once (supersede folds a ruling, never repeats it)', repeated);
  for (const r of out) {
    if (r.status === 'withdrawn' && !ids.includes(r.by)) throw new SchemaError(file, `a withdrawing ruling in the ledger (${r.id})`, r.by);
  }
  return out;
}

export function loadRulings(file: string): readonly Ruling[] {
  return parseRulings(readFileSync(file, 'utf8'), file);
}

const rulingNumber = (id: RulingId): number => Number(id.slice(2));

/** The id a new ruling takes: one more than the ledger's highest (C-1 for an empty ledger). */
export function nextRulingId(ledger: readonly Ruling[]): RulingId {
  return rulingId(`C-${Math.max(0, ...ledger.map((r) => rulingNumber(r.id))) + 1}`);
}

/** The revisions a ruling is checked against: those in force at its commit (G21). M4a: a corpus arc's pin (absent otherwise). */
export type InForceRevs = Readonly<{ head: Sha; ledgerSha256: Sha256Hex; obligationsSha256: Sha256Hex | null; visionSha256: Sha256Hex | null; corpusSha256?: Sha256Hex }>;

/**
 * M4a: the corpus pin in force (a corpus arc's), against which a rule ref resolves; `inFileSet` tells a product path in
 * the same-repo corpus file set (R32), which no contract op may edit (always false for another source kind).
 */
export type RulingCorpus = Readonly<{ rules: ReadonlyMap<RuleId, Sha256Hex>; inFileSet: (path: RepoPath) => boolean }>;

/** What `validateRuling` reads: the ledger and sidecars in force, the tip's documents, and the plan's records. */
export type RulingContext = Readonly<{
  ledger: readonly Ruling[];
  inForce: InForceRevs;
  /** A document's text at the head, null when absent. */
  docAt: (path: RepoPath) => string | null;
  /** A contract's blob at the head, null when absent. */
  blobAt: (path: RepoPath) => Sha | null;
  /** The plan's contracts and architecture docs: the only documents a contract op may edit. */
  documents: readonly RepoPath[];
  obligations: Obligations | null;
  vision: Vision | null;
  units: readonly UnitId[];
  /** M4a: the corpus in force; null outside a corpus arc. */
  corpus: RulingCorpus | null;
}>;

/**
 * The effective revision of every ruling a ruling in force partially supersedes, from the sidecars in force (absent:
 * 1; Checkpoint A): what an approval fingerprint's
 * `rulingRevs` binds, so it changes whenever a cited ruling's meaning does. 1, plus for each ruling that partially
 * supersedes it that ruling's own effective revision, plus 1 once that ruling is itself no longer active (its part
 * of the meaning went with it). It only rises as the ledger grows: a landing adds a term, a status only leaves
 * `active`. Full supersession needs no term (the ruling leaves the active set, which the fingerprint sees).
 */
export function effectiveRulingRevs(sidecars: readonly RulingSidecar[]): ReadonlyMap<RulingId, number> {
  const revs = new Map<RulingId, number>();
  const rev = (id: RulingId): number => revs.get(id) ?? 1;
  // A superseding ruling is always a later id (the ledger's next C-n): descending, its own revision is final first.
  for (const s of [...sidecars].sort((a, b) => compareIds(b.id, a.id))) {
    for (const t of s.supersedes) if (t.part !== null) revs.set(t.id, rev(t.id) + rev(s.id) + (s.status === 'active' ? 0 : 1));
  }
  return revs;
}

