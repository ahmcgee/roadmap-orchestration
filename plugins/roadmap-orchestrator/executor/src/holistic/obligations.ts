// Obligation edits (DESIGN-1.0.md §2.8 "Obligation edits"; plan "Obligations as a revisioned input"; M3 step A1).
// Pure: the classifier (A2) and a bundle's activation (B6) run `classifyObligations` over the obligations in force
// and the proposed file; re-derivation (rederive.ts) shares `weakeningsOf`.
//
// Per obligation id:
//   added      a new id: rev 1, state active, a fresh proof judgment that `proves`. (A must-hold one must show held
//              in the revision's docs candidate, G12: the publication's to check, so the change carries activation.)
//   split      (H14) active → split{children}: every child new, naming the parent, rev 1, active, with its own
//              witness and a fresh proof. Every sentence of the parent's statement must occur verbatim in a child;
//              the architect's children may drop none, a checkpoint split drops text only citing active clauses,
//              and the dropped sentences are returned for its `split-dropped` divergence. A split parent stays
//              split with the same children. A split may not weaken: under a must-hold parent (latched included), a
//              future child must name a delivering unit not yet published, else it could never latch and its
//              must-hold text would go ungraded (paid m3 run 7).
//   witness    a changed witness takes a fresh proof judgment that `proves`; a test id it no longer names is
//              weakening (amended)
//   disposed   weakening: removed (retired), statement or docRef changed or must-hold → future (amended),
//              waived / deferred / retired. Each needs a ruling in force naming the id with that disposition in
//              its `obligationDispositions` (a state's own ruling for a state change). Removing a retired
//              obligation is its retirement already.
//   restored   an exempt obligation active again (strengthening)
//   edited     serves, contracts, deliveredBy, or future → must-hold changed (no ruling needed)
// Everywhere: `rev` rises by one exactly when the statement, docRef or activation changes; a parent is never
// changed; a proof judgment bound to another obligation revision, lane revision or witness definition is stale; in an arc with a vision every
// non-exempt obligation serves a clause, and newly cited clauses are active.
import type { LaneId, ObligationId, RulingId, UnitId, VisionClauseId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type Activation, type ObligationDef, type ObligationDisposition, type Obligations, type RulingSidecar, type Vision, isExempt, laneRevOf,
} from './types.ts';
import { citeReasons } from './vision.ts';

/** Who proposes the revision: the architect's `apply`, or a checkpoint bundle op citing clauses. */
export type ObligationAuthor = Readonly<{ type: 'architect' }> | Readonly<{ type: 'checkpoint'; cites: readonly VisionClauseId[] }>;

export type ObligationChange =
  | Readonly<{ type: 'added'; id: ObligationId; activation: Activation }>
  | Readonly<{ type: 'split'; id: ObligationId; children: readonly ObligationId[]; dropped: readonly string[] }>
  | Readonly<{ type: 'witness'; id: ObligationId }>
  | Readonly<{ type: 'disposed'; id: ObligationId; disposition: ObligationDisposition; ruling: RulingId }>
  | Readonly<{ type: 'restored'; id: ObligationId }>
  | Readonly<{ type: 'edited'; id: ObligationId; fields: readonly string[] }>;

export type ObligationsVerdict = Readonly<{
  changes: readonly ObligationChange[];
  mapping: boolean;
  /** Arc lanes added, changed or removed, ascending (a changed lane stales the proofs bound to its revision). */
  lanes: readonly LaneId[];
  cutLine: boolean;
  reasons: readonly string[];
}>;

/** A weakening from `prev` to `next` (undefined: removed) and the disposition a ruling must name for it. */
export type Weakening = Readonly<{ disposition: ObligationDisposition; what: string; ruling: RulingId | null }>;

/** The weakenings between two versions of one obligation; `ruling` is a state change's own ruling. */
export function weakeningsOf(prev: ObligationDef, next: ObligationDef | undefined): readonly Weakening[] {
  if (next === undefined) return prev.state.type === 'retired' ? [] : [{ disposition: 'retired', what: 'removed', ruling: null }];
  const out: Weakening[] = [];
  const s = next.state;
  if ((s.type === 'waived' || s.type === 'deferred' || s.type === 'retired') && canonicalJson(s) !== canonicalJson(prev.state)) {
    out.push({ disposition: s.type, what: `${s.type} by ${s.ruling}`, ruling: s.ruling });
  }
  if (next.statement !== prev.statement) out.push({ disposition: 'amended', what: 'statement changed', ruling: null });
  if (canonicalJson(next.docRef) !== canonicalJson(prev.docRef)) out.push({ disposition: 'amended', what: 'docRef changed', ruling: null });
  if (prev.activation === 'must-hold' && next.activation === 'future') out.push({ disposition: 'amended', what: 'must-hold → future', ruling: null });
  if (prev.witness !== null && next.witness !== null) {
    const kept = new Set(next.witness.testIds.map((t) => `${next.witness!.lane}\u0000${t}`));
    const lost = prev.witness.testIds.filter((t) => !kept.has(`${prev.witness!.lane}\u0000${t}`));
    if (lost.length > 0) out.push({ disposition: 'amended', what: `witness no longer names ${lost.map((t) => JSON.stringify(t)).join(', ')}`, ruling: null });
  }
  return out;
}

/** The active ruling in force that names `id` with `disposition` (the given one when `ruling` is set), or null. */
export function dispositionRuling(rulings: readonly RulingSidecar[], id: ObligationId, w: Weakening): RulingId | null {
  const r = rulings.find((x) => x.status === 'active' && (w.ruling === null || x.id === w.ruling)
    && x.obligationDispositions.some((d) => d.id === id && d.disposition === w.disposition));
  return r?.id ?? null;
}

/** The sentences of a statement (split after `.`, `;`, `!` or `?` and white space). */
const sentences = (text: string): readonly string[] => text.split(/(?<=[.;!?])\s+/).map((t) => t.trim()).filter((t) => t !== '');

export type ClassifyContext = Readonly<{
  vision: Vision | null;
  /** The ruling sidecars in force, this revision's own included. */
  rulings: readonly RulingSidecar[];
  author: ObligationAuthor;
  /** Future obligations latched by a publication: must-hold from then on. */
  latched: ReadonlySet<ObligationId>;
  /** The units published so far. */
  published: ReadonlySet<UnitId>;
}>;

/** Classifies the obligations file `next` against the one in force (`prev`, null before any); every reason listed. */
export function classifyObligations(prev: Obligations | null, next: Obligations, ctx: ClassifyContext): ObligationsVerdict {
  const reasons: string[] = [];
  const changes: ObligationChange[] = [];
  const before = new Map((prev?.obligations ?? []).map((o) => [o.id, o]));
  const after = new Map(next.obligations.map((o) => [o.id, o]));
  const lanes = new Map(next.lanes.map((l) => [l.id, l]));

  const stale = (o: ObligationDef): void => {
    if (o.witness === null || o.proofJudgment === null) return;
    const rev = laneRevOf(lanes.get(o.witness.lane)!);
    const p = o.proofJudgment;
    if (p.obligationRev !== o.rev || p.laneRev !== rev) {
      reasons.push(`${o.id}'s proof judgment is stale (judged obligation rev ${p.obligationRev}, lane ${p.laneRev}; now rev ${o.rev}, lane ${rev})`);
    }
    if (canonicalJson(p.witness) !== canonicalJson(o.witness)) {
      reasons.push(`${o.id}'s proof judgment is stale (judged witness ${canonicalJson(p.witness)}; now ${canonicalJson(o.witness)})`);
    }
  };
  const proves = (o: ObligationDef): void => {
    if (o.proofJudgment !== null && o.proofJudgment.verdict !== 'proves') reasons.push(`${o.id}'s witness is judged ${o.proofJudgment.verdict} (a new witness must prove it)`);
  };
  const newCites = (o: ObligationDef, was: ObligationDef | undefined): void => {
    reasons.push(...citeReasons(ctx.vision, o.serves.filter((c) => !(was?.serves ?? []).includes(c)), o.id));
  };
  const isNew = (id: ObligationId): boolean => !before.has(id);

  for (const o of next.obligations) {
    stale(o);
    if (ctx.vision !== null && !isExempt(o) && o.serves.length === 0) reasons.push(`${o.id} serves no vision clause (the arc has a vision)`);
  }

  // Removed obligations.
  for (const p of before.values()) {
    if (after.has(p.id)) continue;
    for (const w of weakeningsOf(p, undefined)) disposed(p.id, w);
  }

  for (const o of next.obligations) {
    const p = before.get(o.id);
    if (p === undefined) {
      // A new child is checked with its parent's split (a parent already split keeps its children; a new parent starts active).
      if (o.parent !== undefined) continue;
      if (o.rev !== 1) reasons.push(`${o.id} is new and starts at rev 1, not ${o.rev}`);
      if (o.state.type !== 'active') reasons.push(`${o.id} is new and starts active, not ${o.state.type}`);
      proves(o);
      newCites(o, undefined);
      changes.push({ type: 'added', id: o.id, activation: o.activation });
      continue;
    }
    if (canonicalJson(o) === canonicalJson(p)) continue;
    if (o.parent !== p.parent) reasons.push(`${o.id}'s parent changed (a split family is fixed)`);
    newCites(o, p);

    const normative = o.statement !== p.statement || canonicalJson(o.docRef) !== canonicalJson(p.docRef) || o.activation !== p.activation;
    if (o.rev !== p.rev + (normative ? 1 : 0)) reasons.push(`${o.id} takes rev ${p.rev + (normative ? 1 : 0)}, not ${o.rev} (the rev rises exactly when its statement, docRef or activation changes)`);

    for (const w of weakeningsOf(p, o)) disposed(o.id, w);

    const ps = p.state;
    const os = o.state;
    if (ps.type === 'split' && canonicalJson(os) !== canonicalJson(ps)) reasons.push(`${o.id} is split and stays split into ${ps.children.join(', ')}`);
    if (ps.type === 'active' && os.type === 'split') split(p, o, os.children);
    if (isExempt(p) && os.type === 'active') changes.push({ type: 'restored', id: o.id });

    if (p.witness !== null && o.witness !== null && canonicalJson(p.witness) !== canonicalJson(o.witness)) {
      proves(o);
      changes.push({ type: 'witness', id: o.id });
    }
    const edited = [
      ...(canonicalJson(o.serves) !== canonicalJson(p.serves) ? ['serves'] : []),
      ...(canonicalJson(o.contracts) !== canonicalJson(p.contracts) ? ['contracts'] : []),
      ...(canonicalJson(o.deliveredBy) !== canonicalJson(p.deliveredBy) ? ['deliveredBy'] : []),
      ...(p.activation === 'future' && o.activation === 'must-hold' ? ['activation'] : []),
    ];
    if (edited.length > 0) changes.push({ type: 'edited', id: o.id, fields: edited });
  }

  const laneIds = [...new Set([...(prev?.lanes ?? []).map((l) => l.id), ...next.lanes.map((l) => l.id)])].sort();
  return {
    changes,
    mapping: canonicalJson(prev?.mapping ?? null) !== canonicalJson(next.mapping),
    lanes: laneIds.filter((id) => canonicalJson(prev?.lanes.find((l) => l.id === id) ?? null) !== canonicalJson(lanes.get(id) ?? null)),
    cutLine: prev?.cutLine !== next.cutLine,
    reasons,
  };

  function disposed(id: ObligationId, w: Weakening): void {
    const ruling = dispositionRuling(ctx.rulings, id, w);
    if (ruling === null) reasons.push(`${id} is weakened (${w.what}) without a ruling in force naming it ${w.disposition}${w.ruling === null ? '' : ` (${w.ruling})`}`);
    else changes.push({ type: 'disposed', id, disposition: w.disposition, ruling });
  }

  function split(p: ObligationDef, o: ObligationDef, children: readonly ObligationId[]): void {
    const kids: ObligationDef[] = [];
    const mustHold = p.activation === 'must-hold' || ctx.latched.has(p.id);
    for (const c of children) {
      const child = after.get(c)!;
      if (!isNew(c)) {
        reasons.push(`${o.id} splits into ${c}, which is not a new obligation`);
        continue;
      }
      if (child.rev !== 1) reasons.push(`${c} is new and starts at rev 1, not ${child.rev}`);
      if (child.state.type !== 'active') reasons.push(`${c} is new and starts active, not ${child.state.type}`);
      proves(child);
      newCites(child, undefined);
      if (mustHold && child.activation === 'future' && child.deliveredBy.every((u) => ctx.published.has(u))) {
        reasons.push(`${c} is future under must-hold ${o.id} and delivered by only published units (${child.deliveredBy.join(', ')}): it could never latch, a must-hold → future weakening that needs a ruling; keep it must-hold`);
      }
      kids.push(child);
    }
    const dropped = sentences(p.statement).filter((t) => !kids.some((k) => k.statement.includes(t)));
    if (dropped.length > 0) {
      if (ctx.author.type === 'architect') reasons.push(`${o.id}'s children drop parent text: ${dropped.map((t) => JSON.stringify(t)).join(', ')}`);
      else if (ctx.author.cites.length === 0) reasons.push(`${o.id}'s split drops parent text without citing a vision clause`);
      else reasons.push(...citeReasons(ctx.vision, ctx.author.cites, `${o.id}'s split`));
    }
    changes.push({ type: 'split', id: o.id, children, dropped });
  }
}
