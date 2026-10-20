// The convergence tail (dev.13; owner ruling 2026-10-20; SCHEMAS.md "dev.13: the convergence tail"; DESIGN-1.0.md §2.8).
// m5 run 5 passed both milestones and promoted its demo, then spent two more hours auditing the tests its own repair
// units had added: each accepted P2 became a unit whose tests were audited again, and 41 debt items were banked, most of
// them test nitpicks and status remarks. The ruling: "Debt is for useful, substantive issues in the code that drag down
// the delivery of future work ... If we do not fix a nitpick right away, it is released." Code owns these rules; the
// checkpoint and lens prompts are told them as facts.
//
// - **Released.** A terminal disposition (`released`): recorded, never debt, never reopened by its key
//   (src/holistic/findings.ts `admissionOf`).
// - **P3 is never debt.** `mintDebt` refuses a P3. When a checkpoint's decision is applied (or decided no-op), each P3
//   it was shown that it did not fix (no unit of its effective admits repairs it, and no unit owns it) is released by
//   code (`release{job, p3}`): ruled `deferred`, ruled `accepted` while nothing fixes it, or left without a disposition.
// - **The regress brake.** A lens finding about code that finding-origin units introduced may spawn a unit only at P1.
//   Finding-origin: a unit whose lineage root has origin `repair` or whose spec in force repairs a finding (a re-entry
//   inherits its root's). Introduced (`introducedByFindingOrigin`): the finding's attribution (R46,
//   src/holistic/admits.ts `findingAttribution`: the units whose merge lies in its lens's covered range of its audit and
//   whose first-parent diff touches one of its repo evidence paths) is non-empty and wholly finding-origin; when the
//   attribution names no unit (no repo evidence path, or none such a merge touched), the lens's covered range holds at
//   least one merge and only finding-origin merges.
// - **The settled brake.** Once every milestone of the plan in force has passed (`milestone-passed`) and every unit
//   that is not finding-origin is merged or cut (a plan without milestones: the second alone), a finding below P1
//   spawns no unit unless it bears on an active non-negotiable vision clause.
//   Neither brake touches a P1 or a finding with an obligation (correctness never banks and is never released).
// - **Below a brake.** An admit whose every repair is a finding below a brake is converted when the bundle is judged
//   (`regress-brake` / `settled-brake`, recorded in the decision record like a corpus conversion, src/holistic/bundle.ts);
//   one that mixes such a finding with other repairs makes the bundle invalid (the checkpoint's repair turn names it). When
//   the decision is applied, a P2 below a brake ruled `deferred` stays deferred and banks (a substantive issue: the
//   checkpoint's call); otherwise, while nothing fixes it, code releases it (`release{job, regress | settled}`). A P3 is
//   released by the P3 rule.
//
// What the brakes read is read again when a decision settles (a crash may cut a settlement short and the next one writes
// only what is missing): the settled point only moves forward unless a revision adds units, and a finding named by one of
// the job's brake conversions stays below that brake, so a re-settlement releases nothing a first one would have kept.
import type { FindingId, JobId, UnitId, VisionClauseId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { specRepairs } from '../core/records.ts';
import type { FindingState } from '../core/state.ts';
import { lineageMembers } from '../input/envelope.ts';
import { type PlanM1, milestonesOf } from '../input/plan.ts';
import { milestonePassed } from '../walk/node.ts';
import type { BundleOp } from '../prompts/schemas.ts';
import { type AdmitWorld, findingAttribution } from './admits.ts';
import { isActive } from './findings.ts';
import { type Conversion, type FindingDisposition, type FindingRuledBy, type ReleaseReason, LENS_KINDS } from './types.ts';

export type Brake = 'regress' | 'settled';

/** What the brakes read: the settled point, the finding-origin lineage roots, the integration history, the floors. */
export type TailWorld = Readonly<{
  settled: boolean;
  /** Lineage roots admitted for findings. */
  findingOrigin: ReadonlySet<UnitId>;
  rootOf: (unit: UnitId) => UnitId;
  history: Pick<AdmitWorld, 'audits' | 'merges'>;
  /** The active non-negotiable clauses of the vision in force. */
  floors: ReadonlySet<VisionClauseId>;
}>;

/** A plan unit as the brakes read it: its id, origin, cut, and its spec in force's repairs. */
export type TailUnit = Readonly<{ id: UnitId; origin: PlanM1['units'][number]['origin']; cut: boolean; repairs: readonly string[] }>;

/** The lineage roots of `units` admitted for findings: origin `repair`, or a spec repairing a finding. */
export function findingOriginRoots(units: readonly TailUnit[], rootOf: (u: UnitId) => UnitId): ReadonlySet<UnitId> {
  const byId = new Map(units.map((u) => [u.id, u]));
  return new Set(units.map((u) => rootOf(u.id)).filter((root) => {
    const u = byId.get(root);
    return u !== undefined && (u.origin === 'repair' || u.repairs.some((r) => r.startsWith('F-')));
  }));
}

/**
 * The settled point: every milestone of `plan` passed, and every unit not finding-origin merged or cut (each followed to
 * its lineage head).
 */
export function settledPoint(view: JournalView, plan: PlanM1, units: readonly TailUnit[], findingOrigin: ReadonlySet<UnitId>, rootOf: (u: UnitId) => UnitId): boolean {
  if (!milestonesOf(plan).every((m) => milestonePassed(view, m.id))) return false;
  return units.filter((u) => !findingOrigin.has(rootOf(u.id))).every((u) => {
    if (u.cut) return true;
    const head = view.unit(lineageMembers(view, u.id).at(-1)!).status;
    return head === 'retired' || head === 'cut';
  });
}

const LENSES: ReadonlySet<string> = new Set(LENS_KINDS);
const inRange = (p: number, r: Readonly<{ from: number; to: number }>): boolean => r.from < p && p <= r.to;

/** Whether finding-origin units introduced what lens finding `f` is about (see the header). */
export function introducedByFindingOrigin(w: TailWorld, f: Pick<FindingState, 'lens' | 'source' | 'evidence'>): boolean {
  if (!LENSES.has(f.lens) || f.source.type !== 'job') return false;
  const origin = (u: UnitId): boolean => w.findingOrigin.has(w.rootOf(u));
  const attributed = findingAttribution(w.history, { source: f.source, lens: f.lens, paths: f.evidence.map((e) => e.path) });
  if (attributed.length > 0) return attributed.every(origin);
  const ranges = (w.history.audits.get(f.source.job) ?? []).filter((r) => r.lens === f.lens);
  const merged = w.history.merges.filter((m) => ranges.some((r) => inRange(m.position, r)));
  return merged.length > 0 && merged.every((m) => origin(m.unit));
}

/** The brake finding `f` is below, or null: never a P1 or a finding with an obligation. */
export function brakeOf(w: TailWorld, f: Pick<FindingState, 'severity' | 'obligation' | 'visionClauses' | 'lens' | 'source' | 'evidence'>): Brake | null {
  if (f.severity === 'P1' || f.obligation !== null) return null;
  if (introducedByFindingOrigin(w, f)) return 'regress';
  if (w.settled && !f.visionClauses.some((c) => w.floors.has(c))) return 'settled';
  return null;
}

/** An op of an answer with its index. */
export type IndexedAdmit = Readonly<{ index: number; op: Extract<BundleOp, { op: 'admit' }>; repairs: readonly string[] }>;

/**
 * The brake conversions of a bundle's admits (judged once, persisted in the decision record): an admit whose every
 * repair is an active finding below a brake converts (`settled-brake` when each is below the settled brake, else
 * `regress-brake`); one that mixes such a finding with other repairs is a reason. `brakeOfId` is null for no brake.
 */
export function brakeConversions(admits: readonly IndexedAdmit[], brakeOfId: (id: FindingId) => Brake | null): Readonly<{ conversions: readonly Conversion[]; reasons: readonly string[] }> {
  const conversions: Conversion[] = [];
  const reasons: string[] = [];
  for (const a of admits) {
    const braked = a.repairs.flatMap((r) => {
      const b = r.startsWith('F-') ? brakeOfId(r as FindingId) : null;
      return b === null ? [] : [{ finding: r, brake: b }];
    });
    if (braked.length === 0) continue;
    if (braked.length === a.repairs.length) {
      conversions.push({ index: a.index, unit: a.op.unit.id, reason: braked.every((b) => b.brake === 'settled') ? 'settled-brake' : 'regress-brake', opportunity: null });
      continue;
    }
    reasons.push(`op ${a.index + 1} (admit ${a.op.unit.id}): its repairs name ${braked.map((b) => `${b.finding} (below the ${b.brake} brake)`).join(', ')} beside other repairs; `
      + 'a finding below a brake spawns no unit unless it is a P1: admit the other repairs alone, and defer such a P2 (a substantive issue) or release it');
  }
  return { conversions, reasons };
}

/** One finding ruling a settlement writes: the finding, its disposition, who ruled it. */
export type TailRuling = Readonly<{ finding: FindingId; disposition: FindingDisposition; by: FindingRuledBy }>;

/**
 * The rulings checkpoint `job`'s applied (or no-op) decision writes, in order: each disposition of an active finding
 * as the tail rules bind it, then a code release of each other active, open finding it was shown (`captured`) that
 * nothing fixes and that is a P3 or below a brake. `repaired`: the findings its effective admits repair; `brakeOfId`
 * as for `brakeConversions` (the caller adds the job's brake conversions). Pure.
 */
export function tailRulings(input: Readonly<{
  job: JobId;
  findings: readonly FindingState[];
  captured: readonly FindingId[];
  dispositions: readonly Readonly<{ finding: FindingId; disposition: FindingDisposition }>[];
  repaired: ReadonlySet<FindingId>;
  brakeOfId: (id: FindingId) => Brake | null;
}>): readonly TailRuling[] {
  const byId = new Map(input.findings.map((f) => [f.id, f]));
  const release = (finding: FindingId, reason: ReleaseReason): TailRuling => ({ finding, disposition: 'released', by: { type: 'release', job: input.job, reason } });
  /** Why code releases `f` while nothing fixes it, or null: a P3, or a P2 below a brake. */
  const releasable = (f: FindingState): ReleaseReason | null => (f.severity === 'P3' ? 'p3' : f.severity === 'P2' ? input.brakeOfId(f.id) : null);
  const fixed = (f: FindingState): boolean => input.repaired.has(f.id) || f.state !== 'open';
  const out: TailRuling[] = [];
  const disposed = new Set<FindingId>();
  for (const d of input.dispositions) {
    disposed.add(d.finding);
    const f = byId.get(d.finding);
    if (f === undefined || !isActive(f)) continue;
    const reason = releasable(f);
    const checkpoint = { finding: f.id, disposition: d.disposition, by: { type: 'checkpoint' as const, job: input.job } };
    if (reason === null || d.disposition === 'dismissed' || d.disposition === 'released') out.push(checkpoint);
    else if (d.disposition === 'deferred') out.push(reason === 'p3' ? release(f.id, 'p3') : checkpoint);
    else out.push(fixed(f) ? checkpoint : release(f.id, reason));
  }
  for (const id of input.captured) {
    const f = byId.get(id);
    if (f === undefined || disposed.has(id) || !isActive(f) || fixed(f)) continue;
    const reason = releasable(f);
    if (reason !== null) out.push(release(id, reason));
  }
  return out;
}

/** The repairs of each admit op of `ops` (its spec's), with its index: what the brakes and the settlement read. */
export function indexedAdmits(ops: readonly Readonly<{ index: number; op: BundleOp }>[], specOf: (op: Extract<BundleOp, { op: 'admit' }>) => Parameters<typeof specRepairs>[0]): readonly IndexedAdmit[] {
  return ops.flatMap(({ index, op }) => (op.op === 'admit' ? [{ index, op, repairs: specRepairs(specOf(op)) }] : []));
}
