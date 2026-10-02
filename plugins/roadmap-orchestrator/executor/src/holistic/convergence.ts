// Convergence brakes and generations (M3 step B6; DESIGN-1.0.md §2.8; plan "Generations and convergence", A9, OR-Q2/3,
// R10). Brakes act on the checkpoint only: they turn its bundles into `bundle-request`s and never halt a unit. Everything
// here is derived from the log, so a crash anywhere loses nothing (`raiseBound` raises what is due, once).
//
//   material op      any op but a `request` and an `admit` of a repair unit (R10: repairing is the arc converging)
//   causal identity  `(subject, lineage root)`: each finding or obligation an op is about (its own obligation, and every
//                    `F-n` / `I-n` of the arc its evidence names) with the lineage root of the unit it acts on (null for
//                    an arc-level op). An op about no finding or obligation has no identity: it counts toward K alone
//   identity bound   a bundle with a material op on an identity an earlier applied bundle already changed (since the
//                    latest acknowledged `convergence-identity`) is the second: it becomes a `bundle-request`, and a
//                    non-blocking `convergence-identity` item is raised with it
//   arc counter K    applied bundles since the latest unit publication, newly latched obligation or acknowledged
//                    `convergence-bound`; at K (`limits.convergenceK`, default 3) one durable non-blocking
//                    `convergence-bound` is raised (`raiseBound`)
//   open brake       a raised `convergence-bound` or `convergence-identity` item not yet acknowledged: while one is
//                    open, every bundle becomes a `bundle-request` (A9)
//   quiescence       a generation whose checkpoint decided `no-op` under the vision in force, or whose request the
//                    owner answered without `apply` (`quiescentGenerations`; a vision revision reopens it, H3)
import type { FindingId, JobId, NeedsUserId, ObligationId, Sha256Hex, UnitId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import type { NeedsUserReason } from '../core/records.ts';
import type { HolisticFold } from '../core/state.ts';
import type { AbsPath } from '../core/values.ts';
import { DEFAULT_CONVERGENCE_K, type PlanM1 } from '../input/plan.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
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
  const own = op.op === 'obligation-split' || op.op === 'obligation-dispose' ? [op.obligation as string] : [];
  const named = op.evidence.flatMap((e) => e.match(SUBJECTS) ?? []).filter((s) => known.has(s));
  const unit = unitOf(op);
  const root = unit === null ? null : rootOf(unit);
  return [...new Set([...own, ...named])].sort().map((subject) => ({ subject: subject as FindingId | ObligationId, root }));
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
  new Set([...known, ...ops.flatMap((op) => (op.op === 'obligation-split' || op.op === 'obligation-dispose' ? [op.obligation] : []))]);

/** The identities of `ops` another applied bundle already changed: a non-empty list is the identity bound hit. */
export function secondChanges(brakes: Brakes, ops: readonly BundleOp[], known: ReadonlySet<string>, rootOf: (unit: UnitId) => UnitId): readonly string[] {
  return [...new Set(ops.flatMap((op) => identitiesOf(op, withObligations(known, ops), rootOf).map(identityText)))].filter((t) => brakes.changed.has(t)).sort();
}

/**
 * At K: one durable non-blocking `convergence-bound`, raised once per counter episode (none raised since the counter's
 * start), parented by the job of the bundle that reached K. Null when not due.
 */
export function raiseBound(ctx: Readonly<{ journal: Journal; runDir: AbsPath }>, brakes: Brakes, applied: readonly AppliedBundle[]): NeedsUserId | null {
  if (brakes.count < brakes.k) return null;
  const raised = itemsOf(ctx.journal.view, ctx.runDir, 'convergence-bound').filter((b) => b.seq > brakes.since);
  if (raised.length > 0) return null;
  const counted = applied.filter((a) => a.seq > brakes.since);
  const at = counted[brakes.k - 1]!;
  return raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false,
    subject: { type: 'arc' },
    reason: 'convergence-bound',
    summary: `The checkpoint applied ${brakes.count} bundles (${counted.map((a) => a.job).join(', ')}) with no unit published and no obligation newly held since: the convergence bound K = ${brakes.k} is reached. Units keep running; the checkpoint's next bundles wait for the owner as bundle requests.`,
    recommendation: 'Review what the checkpoint changed (`roadmap status`: plan revisions and divergences). Acknowledge this item to let the checkpoint apply bundles again; raise `limits.convergenceK` by `roadmap apply` to allow more.',
    options: [],
    evidence: [],
  }, { type: 'job', job: at.job });
}

/**
 * The generations quiescent under the vision in force (`visionSha256`): each with a checkpoint, captured under that
 * vision, that decided `no-op`, or whose request (`bundle-request` or `owner-request`) the owner answered without
 * `apply`: a declined or acknowledged request ends that trigger's decision, nothing applied, the findings it concerned
 * as they are. An unanswered request waits on its open item; one answered `apply` is enacted by the trigger's next job.
 * A vision revision since reopens them all (H3).
 */
export function quiescentGenerations(view: JournalView, visionSha256: Sha256Hex): ReadonlySet<number> {
  const settled = (d: HolisticFold['checkpoints'][number]['decided']): boolean => {
    if (d?.kind === 'no-op') return true;
    if (d?.kind !== 'requested') return false;
    const ack = view.ackOf(d.needsUser as NeedsUserId);
    return ack !== null && ack.choice !== 'apply';
  };
  return new Set(view.holistic().checkpoints.filter((c) => c.inputs.visionSha256 === visionSha256 && settled(c.decided)).map((c) => c.inputs.generation));
}
