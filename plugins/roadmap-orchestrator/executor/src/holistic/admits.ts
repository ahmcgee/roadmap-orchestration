// Checkpoint admit classes (M4a rev 3, OR-A1, LR-k; B "Checkpoint admits"): `classifyAdmits` gives each `admit` op of a
// bundle its class (repair, oversight, opportunity) by R45's nine-row table, or converts it (unrelated, over-budget,
// follow-up-overrun), and lists the invalid repair refs and dishonest citations as reasons. Pure: it reads an
// `AdmitWorld` the caller built from the log, the revision in force and git (src/holistic/bundle.ts `admitWorldOf`), and
// writes nothing. It runs once inside `decide`, under the fence, and its result is persisted in the decision record (Q4):
// recovery never classifies again. Corpus arcs only (LR-h).
//
// Sets, per bundle:
//   - W: the active world clauses of the vision in force; A: `holistic.advances` in force.
//   - OC(O): the clauses of opportunity O (the arc's recorded `opportunity` admits, then earlier ones of this bundle);
//     OC = ∪ OC(O). S, the owner-selected slice = A \ OC (R44): an opportunity's clauses stay its own for the arc.
//   - units(O): O's admitted unit, every unit admitted `repair{followUp: O}`, transitively, and the re-entries of each
//     (same lineage root). followUps(O): the recorded `repair{followUp: O}` admits.
// Touched clauses (R47) of admit i (unit u): T = W ∩ (cites ∪ serves(D) ∪ serves(Rₒ) ∪ clauses(R_f) ∪ serves(obl(R_f))),
// D = the non-exempt obligations delivered by u (after this bundle's ops), Rₒ the repaired obligations, R_f the repaired
// findings with every vision clause they carry (a mixed finding keeps its out-of-slice clauses, Q1), obl(R_f) their
// non-exempt obligations. The obligations a spec declares by impact mapping ("may affect") never count. Out = T \ S,
// In = T ∩ S.
//
// Attribution (R46) L(i) = ∪ attr(ref) over the valid refs; an empty attr makes L(i) ambiguous:
//   - a finding from an audit lens: the units whose ff merge lies in that lens's covered range of the audit and whose
//     first-parent diff touches one of the finding's repo-relative evidence paths (absolute paths ignored);
//   - lens `witness`: the same over the union of the audit's ranges;
//   - lens `issue`, or a stage finding (plan-check, build): empty;
//   - an obligation: the units merged after the latest head it was observed held and at or before the first head after
//     it observed not held; never observed held: empty.
// Lineage O: L(i) non-empty, unambiguous and inside units(O) for exactly one O. Ambiguity never grants a follow-up.
//
// The table (first matching row, total):
//   1 a ref invalid → reason; 2 lineage O, Out ⊆ OC(O), followUps(O) = 0 → repair{followUp: O};
//   3 lineage O, Out ⊆ OC(O), followUps(O) ≥ 1 → convert follow-up-overrun (LR-k); 4 refs, Out = ∅ → repair{null};
//   5 Out ≠ ∅ with a clause not cited → dishonest-citation reason; 6 Out ≠ ∅, budget left → opportunity{next O-n, Out};
//   7 Out ≠ ∅ → convert over-budget; 8 no refs, In ≠ ∅ → oversight{In}; 9 no refs, T = ∅ → convert unrelated.
// Budgets count the arc's recorded admits plus the earlier ones of this bundle; ops classify in index order.
import {
  type FindingId, type JobId, type ObligationId, type OpportunityId, type UnitId, type VisionClauseId, canonicalIds, opportunityId,
} from '../core/ids.ts';
import type { LensKindName, RepairRef } from '../core/records.ts';
import type { BundleOp, CheckpointOutput } from '../prompts/schemas.ts';
import {
  type AdmitClass, type ClassifiedAdmit, type Conversion, type FindingLens, type FindingSource, type ObligationDef, LENS_KINDS, OPPORTUNITY_BUDGET,
  OPPORTUNITY_FOLLOW_UPS, isExempt,
} from './types.ts';

/** A finding as classification reads it. `paths`: its evidence paths as recorded. */
export type AdmitFinding = Readonly<{
  id: FindingId;
  active: boolean;
  /** In the checkpoint's captured inputs. */
  captured: boolean;
  visionClauses: readonly VisionClauseId[];
  obligation: ObligationId | null;
  lens: FindingLens;
  source: FindingSource;
  paths: readonly string[];
}>;

/**
 * An obligation as classification reads it (after the bundle's ops): `holding` on the head (false: a `must-hold` not
 * held, or a latched `future` not held), and its observed verdicts at the integration heads, by position.
 */
export type AdmitObligation = Readonly<{ def: ObligationDef; holding: boolean; history: readonly Readonly<{ position: number; held: boolean }>[] }>;

/**
 * A unit's published ff: its new head's position in the integration history (the base is 0, each published head the
 * next) and the paths its first-parent diff touches.
 */
export type UnitMerge = Readonly<{ unit: UnitId; position: number; paths: readonly string[] }>;

/** An audit's covered ranges, by position: a head at position p is in the range when from < p ≤ to. */
export type AuditRange = Readonly<{ lens: LensKindName; from: number; to: number }>;

/** An admit of an earlier bundle of the arc, as its decision record keeps it. */
export type RecordedAdmit = Readonly<{ job: JobId }> & ClassifiedAdmit;

export type AdmitWorld = Readonly<{
  /** The active world clauses of the vision in force. */
  world: readonly VisionClauseId[];
  /** `holistic.advances` in force. */
  advances: readonly VisionClauseId[];
  /** The arc's classified admits so far, in log order. */
  recorded: readonly RecordedAdmit[];
  /** A unit's lineage root (itself when it re-enters none). */
  rootOf: (unit: UnitId) => UnitId;
  obligations: ReadonlyMap<ObligationId, AdmitObligation>;
  findings: ReadonlyMap<FindingId, AdmitFinding>;
  audits: ReadonlyMap<JobId, readonly AuditRange[]>;
  merges: readonly UnitMerge[];
}>;

/** An admit op of the bundle: its index in the answer, its unit, its cites and its spec's repairs. */
export type AdmitOp = Readonly<{ index: number; unit: UnitId; cites: readonly VisionClauseId[]; repairs: readonly RepairRef[] }>;

export type AdmitClassification = Readonly<{ classes: readonly ClassifiedAdmit[]; conversions: readonly Conversion[]; reasons: readonly string[] }>;

/** The clauses the opportunities among `classes` add to `holistic.advances`, ascending. */
export const opportunityClauses = (classes: readonly ClassifiedAdmit[]): readonly VisionClauseId[] =>
  canonicalIds(classes.flatMap((c) => (c.class.type === 'opportunity' ? c.class.clauses : [])));

const minus = <T>(a: readonly T[], b: ReadonlySet<T>): T[] => a.filter((x) => !b.has(x));
const inRange = (p: number, r: Readonly<{ from: number; to: number }>): boolean => r.from < p && p <= r.to;
const AUDIT_LENSES: ReadonlySet<string> = new Set(LENS_KINDS);

/** A repo-relative evidence path (an absolute or parent-relative path names no repo file). */
const repoPath = (p: string): boolean => !p.startsWith('/') && !p.startsWith('../') && p !== '..';

/** The units a finding's attribution names (R46); empty: unattributable. */
export function findingAttribution(w: AdmitWorld, f: AdmitFinding): readonly UnitId[] {
  if (f.source.type !== 'job' || f.lens === 'issue' || f.lens === 'plan-check') return [];
  const ranges = w.audits.get(f.source.job) ?? [];
  const covered = f.lens === 'witness' ? ranges : AUDIT_LENSES.has(f.lens) ? ranges.filter((r) => r.lens === f.lens) : [];
  const paths = new Set(f.paths.filter(repoPath));
  const out = w.merges.filter((m) => covered.some((r) => inRange(m.position, r)) && m.paths.some((p) => paths.has(p))).map((m) => m.unit);
  return [...new Set(out)].sort();
}

/** The units an obligation's attribution names (R46): merged after its latest held head, up to its first not-held head after that. */
export function obligationAttribution(w: AdmitWorld, o: AdmitObligation): readonly UnitId[] {
  const history = [...o.history].sort((a, b) => a.position - b.position);
  const held = history.filter((h) => h.held).at(-1);
  if (held === undefined) return [];
  const broke = history.find((h) => h.position > held.position && !h.held)?.position ?? Number.POSITIVE_INFINITY;
  return [...new Set(w.merges.filter((m) => inRange(m.position, { from: held.position, to: broke })).map((m) => m.unit))].sort();
}

/** Why a repair ref is invalid (R45 row 1), or null when it is valid. */
function refReason(w: AdmitWorld, ref: RepairRef): string | null {
  if (ref.startsWith('F-')) {
    const f = w.findings.get(ref as FindingId);
    return f !== undefined && f.active && f.captured ? null : `repair-ref-resolved: ${ref} is no active finding of the checkpoint's inputs`;
  }
  const o = w.obligations.get(ref as ObligationId);
  if (o === undefined) return `repair-ref-resolved: ${ref} is no obligation in force`;
  if (isExempt(o.def)) return `repair-ref-exempt: ${ref} is ${o.def.state.type}`;
  return o.holding ? `repair-ref-holds: ${ref} holds on the head (nothing to repair)` : null;
}

/** Classifies `admits` (ascending by index) against `w`: see the header. */
export function classifyAdmits(w: AdmitWorld, admits: readonly AdmitOp[]): AdmitClassification {
  const world = new Set(w.world);
  const all: ClassifiedAdmit[] = [...w.recorded];
  const classes: ClassifiedAdmit[] = [];
  const conversions: Conversion[] = [];
  const reasons: string[] = [];

  const opportunities = () => all.flatMap((a) => (a.class.type === 'opportunity' ? [{ id: a.class.id, unit: a.unit, clauses: a.class.clauses }] : []));
  const followUps = (o: OpportunityId) => all.filter((a) => a.class.type === 'repair' && a.class.followUp === o);
  /** units(O) as lineage roots: O's unit and its follow-ups' units, transitively (follow-ups name O directly). */
  const rootsOf = (o: OpportunityId, unit: UnitId): ReadonlySet<UnitId> => new Set([unit, ...followUps(o).map((a) => a.unit)].map(w.rootOf));

  for (const op of admits) {
    const at = `op ${op.index + 1} (admit ${op.unit})`;
    const invalid = op.repairs.flatMap((r) => {
      const why = refReason(w, r);
      return why === null ? [] : [why];
    });
    if (invalid.length > 0) {
      reasons.push(...invalid.map((x) => `${at}: ${x}`));
      continue;
    }
    const opps = opportunities();
    const oc = new Set(opps.flatMap((o) => o.clauses));
    const slice = new Set(minus(w.advances, oc));

    // Touched clauses (R47).
    const findings = op.repairs.flatMap((r) => (r.startsWith('F-') ? [w.findings.get(r as FindingId)!] : []));
    const repairedObligations = op.repairs.flatMap((r) => (r.startsWith('F-') ? [] : [w.obligations.get(r as ObligationId)!.def]));
    const delivered = [...w.obligations.values()].filter((o) => !isExempt(o.def) && o.def.deliveredBy.includes(op.unit)).map((o) => o.def);
    const findingObligations = findings.flatMap((f) => {
      const o = f.obligation === null ? undefined : w.obligations.get(f.obligation);
      return o === undefined || isExempt(o.def) ? [] : [o.def];
    });
    const touched = canonicalIds([
      ...op.cites, ...delivered.flatMap((o) => o.serves), ...repairedObligations.flatMap((o) => o.serves),
      ...findings.flatMap((f) => f.visionClauses), ...findingObligations.flatMap((o) => o.serves),
    ].filter((c) => world.has(c)));
    const out = touched.filter((c) => !slice.has(c));
    const inSlice = touched.filter((c) => slice.has(c));

    // Attribution and lineage (R46).
    const attrs = op.repairs.map((r) => (r.startsWith('F-')
      ? findingAttribution(w, w.findings.get(r as FindingId)!)
      : obligationAttribution(w, w.obligations.get(r as ObligationId)!)));
    const ambiguous = attrs.some((a) => a.length === 0);
    const attributed = new Set(attrs.flat().map(w.rootOf));
    const lineage = op.repairs.length === 0 || ambiguous ? [] : opps.filter((o) => {
      const roots = rootsOf(o.id, o.unit);
      return [...attributed].every((u) => roots.has(u));
    });
    const owner = lineage.length === 1 ? lineage[0]! : null;

    const classify = (cls: AdmitClass): void => {
      const c: ClassifiedAdmit = { index: op.index, unit: op.unit, class: cls };
      classes.push(c);
      all.push(c);
    };
    const convert = (reason: Conversion['reason'], opportunity: OpportunityId | null): void => {
      conversions.push({ index: op.index, unit: op.unit, reason, opportunity });
    };

    if (owner !== null && out.every((c) => owner.clauses.includes(c))) {
      if (followUps(owner.id).length < OPPORTUNITY_FOLLOW_UPS) classify({ type: 'repair', refs: op.repairs, followUp: owner.id }); // row 2
      else convert('follow-up-overrun', owner.id); // row 3 (LR-k)
      continue;
    }
    if (op.repairs.length > 0 && out.length === 0) { // row 4
      classify({ type: 'repair', refs: op.repairs, followUp: null });
      continue;
    }
    if (out.length > 0) {
      const uncited = out.filter((c) => !op.cites.includes(c));
      if (uncited.length > 0) { // row 5
        reasons.push(...uncited.map((c) => `${at}: dishonest-citation: ${c} — the admit touches ${c}, outside the owner-selected slice, without citing it; cite every clause it advances`));
        continue;
      }
      if (opps.length < OPPORTUNITY_BUDGET) classify({ type: 'opportunity', id: opportunityId(`O-${opps.length + 1}`), clauses: out }); // row 6
      else convert('over-budget', null); // row 7
      continue;
    }
    if (inSlice.length > 0) classify({ type: 'oversight', clauses: inSlice }); // row 8
    else convert('unrelated', null); // row 9
  }
  return { classes, conversions, reasons };
}

/** The units an op names as its subject or dependency: what a busy check and a conversion's reference check read. */
export function namedUnits(op: BundleOp): readonly UnitId[] {
  switch (op.op) {
    case 'admit':
      return op.unit.after;
    case 'patch-spec':
    case 'cut':
    case 'route':
    case 'invalidate-approval':
      return [op.unit];
    case 'limits':
      return op.unit === null ? [] : [op.unit];
    case 'reenter':
      return [op.reenters];
    case 'obligation-split':
      return op.children.flatMap((c) => c.deliveredBy);
    default:
      return [];
  }
}

/** R35: a conversion another op or an `acted` intake names makes the bundle invalid instead of dropping the op. */
export function conversionReasons(output: CheckpointOutput, conversions: readonly Conversion[]): readonly string[] {
  const byUnit = new Map(conversions.map((c) => [c.unit as string, c]));
  const dropped = new Set(conversions.map((c) => c.index));
  const out: string[] = [];
  output.ops.forEach((op, i) => {
    if (dropped.has(i)) return;
    for (const u of namedUnits(op)) {
      const c = byUnit.get(u);
      if (c !== undefined) out.push(`op ${i + 1} (${op.op}) names ${u}, whose admit (op ${c.index + 1}) code converts (${c.reason}): nothing may depend on an admit that converts`);
    }
  });
  for (const { issue, outcome } of output.issueIntake) {
    if (outcome.type !== 'acted' || outcome.on.type !== 'ops') continue;
    for (const i of outcome.on.indexes) if (dropped.has(i)) out.push(`issueIntake acts on ${issue} through op ${i + 1}, an admit code converts`);
  }
  return out;
}
