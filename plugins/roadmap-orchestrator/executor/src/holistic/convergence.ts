// Status convergence counters derived from recorded revisions, and completed campaign-audit generations.
import { type FindingId,type JobId,type NeedsUserId,type ObligationId,type Sha256Hex,type UnitId,canonicalIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { NeedsUserReason } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { DEFAULT_CONVERGENCE_K,type PlanM1 } from '../input/plan.ts';
import { readNeedsUser } from '../needsuser.ts';
import type { BundleOp } from '../prompts/schemas.ts';

/** One causal identity: a finding or obligation, and the lineage root of the unit acted on (null: arc-level). */
export type Identity = Readonly<{ subject: FindingId | ObligationId; root: UnitId | null }>;
const identityText = (i: Identity): string => `${i.subject}@${i.root ?? 'arc'}`;

/** R10: a repair admit is not material; nor is a request, which applies nothing. */
export const isMaterial = (op: BundleOp): boolean => op.op !== 'request' && !(op.op === 'admit' && op.unit.origin === 'repair');

/** The unit an op acts on, or null for an arc-level op. */
function unitOf(op: BundleOp): UnitId | null {
  switch (op.op) {
    case 'admit':
      return op.unit.id;
    case 'patch-spec':
    case 'cut':
    case 'route':
    case 'invalidate-approval':
      return op.unit;
    case 'reenter':
      return op.reenters;
    case 'limits':
      return op.unit;
    default:
      return null;
  }
}

const SUBJECTS = /\b(?:F|I)-[1-9][0-9]*\b/g;

/**
 * The causal identities of a material op (none for a non-material one): its subjects (its own obligation, and each
 * known finding or obligation its evidence names) × the lineage root of its unit.
 */
export function identitiesOf(op: BundleOp, known: ReadonlySet<string>, rootOf: (unit: UnitId) => UnitId): readonly Identity[] {
  if (!isMaterial(op)) return [];
  const own = op.op === 'obligation-split' ? [op.obligation as string] : [];
  const named = op.evidence.flatMap((e) => e.match(SUBJECTS) ?? []).filter((s) => known.has(s));
  const unit = unitOf(op);
  const root = unit === null ? null : rootOf(unit);
  return canonicalIds([...own, ...named] as (FindingId | ObligationId)[]).map((subject) => ({ subject, root }));
}

/** An applied bundle: its job, the seq of its `plan-applied`, and its ops. */
export type AppliedBundle = Readonly<{ job: JobId; seq: number; ops: readonly BundleOp[] }>;

/** A raised brake item: its id, the seq of its raise, and whether it was acknowledged. */
type Item = Readonly<{ id: NeedsUserId; seq: number; acked: boolean }>;

/** The raised items of `reason`, in raise order. */
export function itemsOf(view: JournalView, runDir: AbsPath, reason: NeedsUserReason): readonly Item[] {
  return view.opsOf('needsuser.raise').filter((i) => view.doneOf(i.op) !== null && readNeedsUser(runDir, i.expect.id)?.reason === reason)
    .map((i) => ({ id: i.expect.id, seq: Number(i.op.slice(i.op.lastIndexOf('/') + 1)), acked: view.ackOf(i.expect.id) !== null }));
}

export type Brakes = Readonly<{
  /** Open brake items (raised, not acknowledged): while any is, every bundle becomes a request. */
  open: readonly NeedsUserId[];
  /** Applied bundles counted toward K, and K. */
  count: number;
  k: number;
  /** Identities an applied bundle changed since the latest acknowledged `convergence-identity`. */
  changed: ReadonlySet<string>;
  /** Where the arc counter starts (seq): a publication, a latch, or an acknowledged bound. */
  since: number;
}>;

/**
 * The brakes as the log has them now. `applied`: every applied bundle, in log order; `known`: the arc's finding and
 * obligation ids (what an op's evidence may name).
 */
export function brakesOf(
  view: JournalView, runDir: AbsPath, plan: PlanM1, applied: readonly AppliedBundle[], known: ReadonlySet<string>, rootOf: (unit: UnitId) => UnitId,
): Brakes {
  const bound = itemsOf(view, runDir, 'convergence-bound');
  const identity = itemsOf(view, runDir, 'convergence-identity');
  const fold = view.holistic();
  const since = Math.max(
    0,
    ...view.publications().map((p) => p.seq),
    ...fold.latched.map((l) => l.seq),
    ...bound.filter((b) => b.acked).map((b) => b.seq),
  );
  const identitySince = Math.max(0, ...identity.filter((i) => i.acked).map((i) => i.seq));
  const changed = new Set(applied.filter((a) => a.seq > identitySince).flatMap((a) => a.ops.flatMap((op) => identitiesOf(op, withObligations(known, a.ops), rootOf).map(identityText))));
  return {
    open: [...bound, ...identity].filter((i) => !i.acked).map((i) => i.id),
    count: applied.filter((a) => a.seq > since).length,
    k: plan.limits?.convergenceK ?? DEFAULT_CONVERGENCE_K,
    changed,
    since,
  };
}

/** The subjects an op may name: the arc's findings and obligations (an op's own obligation counts as known). */
const withObligations = (known: ReadonlySet<string>, ops: readonly BundleOp[]): ReadonlySet<string> =>
  new Set([...known, ...ops.flatMap((op) => (op.op === 'obligation-split' ? [op.obligation] : []))]);

/** Completed campaign-audit generations under the current vision. */
export function quiescentGenerations(view: JournalView, visionSha256: Sha256Hex): ReadonlySet<number> {
  return new Set(view.holistic().audits.filter((a) => a.started.visionSha256 === visionSha256 && a.ended?.outcome === 'completed').map((a) => a.started.generation));
}
