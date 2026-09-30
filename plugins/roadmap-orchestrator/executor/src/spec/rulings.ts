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
//   contract ops    only on the plan's contracts and architecture docs, each listed in `contractRefs`; anchor-exact,
//                   old text exactly once under the anchor, no two ops of one document with overlapping anchors
//                   (`deviates` without ops is refused by the reader)
//   obligations     named ids exist; every disposition's id is among `obligations`
//   vision          every cited clause active (`citeReasons`); appliesTo names planned units
//   consistency     (G21) the verdict `consistent`, judged by the checkpoint's own judgment for a checkpoint ruling,
//                   and `judgedRevs` equal to the revisions in force: the ledger, the obligations and the vision
//                   bytes, and the blob of every contract it names or edits (`consistencyRevs`). The judged head is
//                   provenance only: a merge that leaves those untouched keeps the judgment fresh (lead ruling,
//                   2026-09-30), and docRefs are re-checked at the tip regardless

// `ledgerAfter` and `sidecarsAfter` put a validated ruling in force: its line appended, every fully superseded
// ruling folded to `withdrawn by` (and its sidecar marked `superseded`), the ledger's other bytes kept.
import { readFileSync } from 'node:fs';
import { type RulingId, type Sha, type Sha256Hex, type UnitId, rulingId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { SchemaError } from '../core/validate.ts';
import type { RepoPath } from '../core/values.ts';
import { applyContractOps, quotedTextReason } from '../docs/contracts.ts';
import type { Consistency, Obligations, RulingSidecar, Vision } from '../holistic/types.ts';
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

/** The revisions a ruling is checked against: those in force at its commit (G21). */
export type InForceRevs = Readonly<{ head: Sha; ledgerSha256: Sha256Hex; obligationsSha256: Sha256Hex | null; visionSha256: Sha256Hex | null }>;

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
}>;

/** The contracts a ruling names or edits, ascending: what its `consistency` must have judged. */
const judgedPaths = (s: RulingSidecar): readonly RepoPath[] => [...new Set([...s.contractRefs, ...s.contractOps.map((o) => o.path)])].sort();

/** The `judgedRevs` a fresh `consistency` of `s` records: the revisions in force and the head blob of each contract it names or edits. */
export function consistencyRevs(s: RulingSidecar, ctx: RulingContext): Readonly<{ revs: Consistency['judgedRevs'] }> | Readonly<{ reasons: readonly string[] }> {
  const missing = judgedPaths(s).filter((p) => ctx.blobAt(p) === null);
  if (missing.length > 0) return { reasons: missing.map((p) => `${s.id} names contract ${p}, which is not at the head`) };
  return { revs: { ...ctx.inForce, contracts: judgedPaths(s).map((path) => ({ path, blob: ctx.blobAt(path)! })) } };
}

/** Why `s` may not land on the revisions in force; empty when it may. */
export function validateRuling(s: RulingSidecar, ctx: RulingContext): readonly string[] {
  const out: string[] = [];
  const at = s.id;
  // Identity.
  const expected = nextRulingId(ctx.ledger);
  if (ctx.ledger.some((r) => r.id === s.id)) out.push(`${at} is already in the ledger (a ruling is never edited: supersede it)`);
  else if (s.id !== expected) out.push(`${at} is not the ledger's next id (${expected})`);
  if (s.status !== 'active') out.push(`${at} lands with status active, not ${s.status}`);
  if (s.statement.includes('\n') || s.statement.trim() !== s.statement) out.push(`${at}'s statement is one line without surrounding space (a ledger line)`);
  if (WITHDRAWN.test(s.statement)) out.push(`${at}'s statement reads as a withdrawn fold`);
  // Supersession.
  s.supersedes.forEach((t, i) => {
    const target = ctx.ledger.find((r) => r.id === t.id);
    if (t.id === s.id) out.push(`${at} supersedes itself`);
    else if (target === undefined) out.push(`${at} supersedes ${t.id}, which is not in the ledger`);
    else if (target.status !== 'active') out.push(`${at} supersedes ${t.id}, which is already withdrawn by ${target.by}`);
    if (s.supersedes.findIndex((u) => u.id === t.id) !== i) out.push(`${at} supersedes ${t.id} twice`);
  });
  // Document references.
  for (const d of s.docRefs) {
    const doc = ctx.docAt(d.path);
    const why = doc === null ? 'no such document at the head' : quotedTextReason(doc, d.anchor, d.quotedText);
    if (why !== null) out.push(`${at} docRef ${d.path}: ${why}`);
  }
  // Contract ops.
  for (const op of s.contractOps) {
    if (!ctx.documents.includes(op.path)) out.push(`${at} contract op on ${op.path}, which is not a plan contract or architecture doc`);
    if (!s.contractRefs.includes(op.path)) out.push(`${at} contract op on ${op.path}, which its contractRefs do not list`);
  }
  const applied = applyContractOps(s.contractOps, s.id, ctx.docAt);
  if ('reasons' in applied) out.push(...applied.reasons.map((r) => `${at} ${r}`));
  // Obligations.
  const known = new Set(ctx.obligations?.obligations.map((o) => o.id) ?? []);
  for (const id of s.obligations) if (!known.has(id)) out.push(`${at} names obligation ${id}, which is not in force`);
  for (const d of s.obligationDispositions) if (!s.obligations.includes(d.id)) out.push(`${at} dispositions ${d.id} without naming it in obligations`);
  // Vision and units.
  out.push(...citeReasons(ctx.vision, s.cites, at));
  if (s.appliesTo.type === 'units') for (const u of s.appliesTo.units) if (!ctx.units.includes(u)) out.push(`${at} applies to ${u}, which is not a planned unit`);
  // Consistency (G21).
  const c = s.consistency;
  if (c.verdict !== 'consistent') out.push(`${at}'s consistency judgment found it inconsistent`);
  if (s.ruledBy.type === 'checkpoint' && c.by.type !== 'judgment') out.push(`${at} is the checkpoint's: its consistency is a judgment's`);
  const fresh = consistencyRevs(s, ctx);
  if ('reasons' in fresh) out.push(...fresh.reasons);
  else if (staleParts(c.judgedRevs, fresh.revs).length > 0) out.push(`${at}'s consistency is stale: judged ${staleParts(c.judgedRevs, fresh.revs).join(', ')} at other revisions than those in force`);
  return out;
}

function staleParts(judged: Consistency['judgedRevs'], now: Consistency['judgedRevs']): readonly string[] {
  const keys = ['ledgerSha256', 'obligationsSha256', 'visionSha256', 'contracts'] as const;
  return keys.filter((k) => canonicalJson(judged[k]) !== canonicalJson(now[k]));
}

/** The ledger text with `s` in force: fully superseded rulings folded to `withdrawn by`, its line appended, every other byte kept. */
export function ledgerAfter(text: string, s: RulingSidecar): string {
  const folded = new Set<string>(s.supersedes.filter((t) => t.part === null).map((t) => t.id));
  const lines = text.split('\n').map((line) => {
    const m = RULING_LINE.exec(line);
    return m !== null && folded.has(m[1]!) ? `${m[1]} — withdrawn by ${s.id}` : line;
  });
  const body = lines.join('\n');
  return `${body === '' || body.endsWith('\n') ? body : `${body}\n`}${s.id} — ${s.statement}\n`;
}

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
  for (const s of [...sidecars].sort((a, b) => rulingNumber(b.id) - rulingNumber(a.id))) {
    for (const t of s.supersedes) if (t.part !== null) revs.set(t.id, rev(t.id) + rev(s.id) + (s.status === 'active' ? 0 : 1));
  }
  return revs;
}

/** The sidecars in force with `s` landed: each one it fully supersedes marked `superseded`, `s` added; ascending by id. */
export function sidecarsAfter(sidecars: readonly RulingSidecar[], s: RulingSidecar): readonly RulingSidecar[] {
  const folded = new Set<string>(s.supersedes.filter((t) => t.part === null).map((t) => t.id));
  return [...sidecars.map((x) => (folded.has(x.id) ? { ...x, status: 'superseded' as const } : x)), s].sort((a, b) => rulingNumber(a.id) - rulingNumber(b.id));
}
