// Which witness test ids a unit must make pass, and which of them are missing (M4a rev 3, D1, R33; final in step N0).
// Pure: the caller hands in the journal view, the obligations in force, the unit's spec and the tree `at` with its
// ancestry predicate (git stays the caller's). The lanes stage (D1), `roadmap witness-check` (R56) and mutation smoke's
// targets (D2, Q16) all read these, so the three agree on one comparator.
import { type TestRef, testRefKey } from '../core/events.ts';
import { type LaneId, type ObligationId, type Sha, type UnitId, type WitnessItemId, compareIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type SpecM1, specObligations, specRepairs, specWitnesses } from '../core/records.ts';
import { type ObligationDef, type Obligations, type WitnessRecord, isExempt } from './types.ts';

/** Why a test id is required: a target the unit delivers or repairs, or a must-hold it declares and must keep (preservation). */
export type WitnessRole = 'target' | 'preservation';
/** What requires it: an obligation's witness, or one of the spec's witness items. */
export type WitnessSource = Readonly<{ type: 'obligation'; id: ObligationId }> | Readonly<{ type: 'witness-item'; id: WitnessItemId }>;
/** One required witness test: its arc lane and test id, its source and role. */
export type RequiredWitness = TestRef & Readonly<{ source: WitnessSource; role: WitnessRole }>;

/** The tree the requirement is computed for (a salvaged SHA), and whether a commit is its ancestor (the caller asks git). */
export type WitnessTree = Readonly<{ sha: Sha; isAncestor: (commit: Sha) => boolean }>;

const sourceKey = (s: WitnessSource): string => (s.type === 'obligation' ? `I\u0000${s.id}` : `W\u0000${s.id}`);
const rowKey = (r: RequiredWitness): string => `${testRefKey(r)}\u0000${sourceKey(r.source)}`;

/** The rows of one obligation's witness, each test id once. */
function obligationRows(o: ObligationDef, role: WitnessRole): readonly RequiredWitness[] {
  if (o.witness === null) return [];
  const lane = o.witness.lane;
  return o.witness.testIds.map((testId) => ({ lane, testId, source: { type: 'obligation', id: o.id }, role }));
}

/** An obligation that binds: active (not split) and not exempt. */
const binding = (o: ObligationDef): boolean => o.state.type === 'active' && !isExempt(o);

/**
 * The merge commit each unit published through `ff` (its own, or its repair batch's), as the log records it; a unit
 * that never published has none.
 */
function published(view: JournalView): ReadonlyMap<UnitId, Sha> {
  const out = new Map<UnitId, Sha>();
  const batches = new Map<string, readonly UnitId[]>();
  for (const i of view.opsOf('candidate.merge')) if (i.expect.batch !== undefined) batches.set(i.expect.batch.job, i.expect.batch.members.map((m) => m.unit));
  for (const i of view.opsOf('integration.ff')) {
    const done = view.doneOf(i.op);
    if (done?.kind !== 'integration.ff' || done.outcome.kind !== 'published') continue;
    const subject = i.expect.subject;
    if (subject === undefined && i.parent.type === 'stage') out.set(i.parent.unit, i.expect.new);
    if (subject?.type === 'batch') for (const u of batches.get(subject.job) ?? []) out.set(u, i.expect.new);
  }
  return out;
}

/**
 * The witness test ids unit `unit` must make pass on `at` (R33), ascending by lane, test id, then source:
 *   - targets: the witnesses of each binding obligation the unit completes (its `deliveredBy` names the unit, and every
 *     other deliverer's published merge is an ancestor of `at`); of each binding obligation its spec repairs; and the
 *     spec's active witness items;
 *   - preservation: the witnesses of each binding obligation its spec declares that is must-hold (by activation, or a
 *     future one latched by a publication) and is not already a target.
 */
export function requiredWitnesses(view: JournalView, obligations: Obligations, unit: UnitId, spec: SpecM1, at: WitnessTree): readonly RequiredWitness[] {
  const byId = new Map(obligations.obligations.map((o) => [o.id, o]));
  const merges = published(view);
  const completes = (o: ObligationDef): boolean => o.deliveredBy.includes(unit) && o.deliveredBy.every((d) => {
    if (d === unit) return true;
    const merge = merges.get(d);
    return merge !== undefined && at.isAncestor(merge);
  });
  const targets = new Set<ObligationId>();
  for (const o of obligations.obligations) if (binding(o) && completes(o)) targets.add(o.id);
  for (const ref of specRepairs(spec)) {
    if (ref.startsWith('F-')) continue;
    const o = byId.get(ref as ObligationId);
    if (o === undefined) throw new Error(`unit ${unit}: its spec repairs ${ref}, which the obligations in force do not hold`);
    if (binding(o)) targets.add(o.id);
  }
  const latched = new Set(view.holistic().latched.map((l) => l.obligation));
  const rows: RequiredWitness[] = [];
  for (const id of targets) rows.push(...obligationRows(byId.get(id) as ObligationDef, 'target'));
  for (const w of specWitnesses(spec)) {
    if (w.state === 'active') rows.push({ lane: w.lane, testId: w.testId, source: { type: 'witness-item', id: w.id }, role: 'target' });
  }
  for (const id of specObligations(spec)) {
    const o = byId.get(id);
    if (o === undefined) throw new Error(`unit ${unit}: its spec declares ${id}, which the obligations in force do not hold`);
    if (targets.has(id) || !binding(o) || !(o.activation === 'must-hold' || latched.has(id))) continue;
    rows.push(...obligationRows(o, 'preservation'));
  }
  return [...new Map(rows.map((r) => [rowKey(r), r])).values()].sort((a, b) => compareRows(a, b));
}

function compareRows(a: RequiredWitness, b: RequiredWitness): number {
  const ka = testRefKey(a);
  const kb = testRefKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.source.type !== b.source.type) return a.source.type === 'obligation' ? -1 : 1;
  return compareIds(a.source.id, b.source.id);
}

/** Mutation smoke's targets (Q16): the `target` rows; preservation must-holds are never smoked. */
export const smokeTargets = (required: readonly RequiredWitness[]): readonly RequiredWitness[] => required.filter((r) => r.role === 'target');

/**
 * Which required test ids a lane run's records fail to witness (the one comparator of the lanes stage and `witness-check`):
 * `missing` when its lane's record is absent or malformed, or the test is absent from it, zero-selected or skipped;
 * `failed` when it failed. Each test once, ascending by lane then test id. `malformed`: the lanes whose record did not
 * parse (their tests are among `missing`). At most one record per lane.
 */
export type MissingWitnesses = Readonly<{ missing: readonly TestRef[]; failed: readonly TestRef[]; malformed: readonly LaneId[] }>;
export function missingWitnesses(records: readonly WitnessRecord[], required: readonly TestRef[]): MissingWitnesses {
  const byLane = new Map<LaneId, WitnessRecord>();
  for (const r of records) {
    if (byLane.has(r.lane)) throw new Error(`missingWitnesses: two records of lane ${r.lane} (one aggregated record per lane)`);
    byLane.set(r.lane, r);
  }
  const missing = new Map<string, TestRef>();
  const failed = new Map<string, TestRef>();
  const malformed = new Set<LaneId>();
  for (const t of required) {
    const ref: TestRef = { lane: t.lane, testId: t.testId };
    const record = byLane.get(t.lane);
    if (record?.malformed === true) malformed.add(t.lane);
    const outcome = record === undefined || record.malformed ? null : record.records.find((x) => x.testId === t.testId) ?? null;
    if (outcome?.outcome === 'pass' && outcome.selected > 0) continue;
    if (outcome?.outcome === 'fail') failed.set(testRefKey(ref), ref);
    else missing.set(testRefKey(ref), ref);
  }
  const sorted = (m: ReadonlyMap<string, TestRef>): readonly TestRef[] => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);
  return { missing: sorted(missing), failed: sorted(failed), malformed: [...malformed].sort() };
}
