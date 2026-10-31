import { isActive } from './findings.ts';
import { lensCoverage } from './coverage.ts';
import { milestoneReached } from '../walk/milestones.ts';
// Audit cadence (M3 step B5; DESIGN-1.0.md §2.5 "Triggers", "Owed"; D3, R8, R15, H3, H9, OR-Q2): which triggers are
// owed, whether an audit is due, which lenses it runs and which generation it records. Derived from the log each time
// (nothing of it is persisted but the `audit-started` that consumes it).
//
// Triggers (each an event of the log after the last completed audit's start, or after the coverage base when no
// completed audit follows it):
//   cadence       N qualifying publications (D3: `holistic.audit.every`, default 5): unit and batch publications, and a
//                 revision's docs publication that carries contract ops (a rule's); a docs-only one is not counted
//   unwitnessed   R8: a unit or batch publication that selected an active future (not latched) obligation left
//                 unwitnessed on its tree (no observation there, or verdict `unwitnessed`). An exempt one (waived,
//                 deferred, retired: a ruling released it) is owed no witness and triggers nothing (field fix, 2026-10-24).
//                 Pending blocking units suppress this trigger until merged (status's canonical blockingUnits).
//   drift         a revision from a bundle, a rule (its ledger or sidecars changed), `reverse`, or an architect spec,
//                 obligation, mapping or vision edit (R15: a vision revision, and the arc turning holistic): runs
//                 L ∩ {drift, vision}, or all of L when that is empty. Change-sensitive (M4a rev 3, H2, R61): a bundle
//                 revision whose changes are only plan units and their specs (no obligation, mapping, vision, advances,
//                 ledger or contract op) records `drift{specsOnly: units}` and runs L ∩ {vision} alone (the full drift's
//                 lenses when L has no vision lens), its lens reading those units' specs (`specsOnlyOf`); the code
//                 lenses keep their watermarks
//   wall-clock    `wallClockMin` (default 360) since the latest audit started or unit published, while work remains
//                 (a plan unit not retired, cut or superseded), and a publication occurred since the latest audit started
//   requested     `audit [--lens]` (`audit-requested`): its lenses ∩ L, or L
//   final         H9: no work remains and some lens in L has an outstanding range (one an abandoned audit covered
//                 in part included: its rest is outstanding): those lenses only
// Everything else runs all of L. Triggers coalesce: an audit records every owed trigger.
//
// Due: one audit at a time, and some trigger is fresh: its event came after the latest audit started, the wall-clock
// trigger fired, or `final` holds after a completed audit (or before any). So an audit abandoned mid-run (a lens failed,
// its backend parked) is not retried at once for the same triggers: they stay owed until something new happens or the
// period (`wallClockMin`) has passed since it started. After trigger/lens selection, an ordinary audit needs an
// outstanding range in a selected lens; requested and semantic drift audits may inspect an unchanged head. Final
// audits select only outstanding lenses. This calculation serves both pending and fenced capture, so an empty
// ordinary audit writes nothing and does not spin the scheduler. A skipped audit (its lens backend parked, the arc paused:
// `skipReason`) writes nothing.
//
// Drift is throttled (field fix 2026-10-24, `DRIFT_THROTTLE_MIN`): within that period of the latest audit's start a drift
// trigger is owed but not fresh, so a burst of revisions (owner re-entries, cuts, rules) runs one audit per period, not
// one each. Every drift since the last completed audit's start stays owed, so the next audit records them all; any other
// fresh trigger runs it at once. A bundle's drift is never held (it opens the checkpoint's next generation right after
// the audit that led to it, one bundle per checkpoint), nor is any once no work remains (nothing is left to burst, and
// completion waits on it).
//
// Owed (OR-Q2/3): triggers owed for 2N qualifying publications, or for 2 × `wallClockMin` since the last completed
// audit started (or the base), raise one non-blocking `audit-owed` per episode (audit.ts `raiseAuditOwed`).
//
// Generation (§2.8): an audit a bundle's revision triggered is its checkpoint's generation + 1; any other is one more
// than the highest generation any audit or checkpoint recorded. A milestone steering checkpoint takes the latest
// recorded generation (minimum 1), like a walk or park; an audit checkpoint keeps its audit's generation.
//
// Time: `Clock(seq)` is the minutes since the fact at `seq` was written. `processClock` is the executor's: it times a
// fact from when this process first saw it (a fact older than the process from the process's start), so a restart
// delays a wall-clock trigger, never fires one early.
import { obligationBlockingUnits } from './blocking.ts';
import type { AuditTrigger } from './types.ts';
import { type LensKind, isMustHold } from './types.ts';
import type { Parent, PlanChange } from '../core/events.ts';
import { type ObligationId, type Sha, type UnitId, compareIds } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AuditState } from '../core/state.ts';
import { branchRef } from '../core/values.ts';
import { revParse } from '../git/git.ts';
import type { StageContext } from '../pipeline/dispatch.ts';
import { selected } from '../pipeline/gate.ts';
import { observedViews } from '../pipeline/lanes.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import { type AppliedRevision, type CoverageBase, type PublishedHead, coverageBase, revisionPublication } from './coverage.ts';

/**
 * Minutes after the latest audit's start during which a non-bundle revision's drift makes no audit due (see the header).
 * Field fix 2026-10-24: seven revisions in one stretch each ran a drift audit, five finding nothing.
 */
export const DRIFT_THROTTLE_MIN = 60;

/** Minutes since the fact at `seq` was written. */
export type Clock = (seq: number) => number;

/** The executor's clock: a fact is timed from when this process first asked about it, one older than the process from its start. */
export function processClock(view: JournalView, now: () => number = Date.now): Clock {
  const start = now();
  const known = view.highWater();
  const seen = new Map<number, number>();
  return (seq) => {
    let at = seq <= known ? start : seen.get(seq);
    if (at === undefined) {
      at = now();
      seen.set(seq, at);
    }
    return (now() - at) / 60_000;
  };
}

/** What an audit started now records: its coalesced triggers, the lenses they call for (ascending), its generation. */
export type AuditPlan = Readonly<{ triggers: readonly AuditTrigger[]; lenses: readonly LensKind[]; generation: number }>;

/** The cadence now: the base, the owed triggers (as an audit would record them), whether one is due, and whether owed long. */
export type Cadence = Readonly<{
  base: CoverageBase;
  /** The integration head now. */
  head: Sha;
  owed: readonly AuditTrigger[];
  due: boolean;
  plan: AuditPlan | null;
  /** OR-Q2: owed for 2N publications or 2 × wallClockMin: a non-blocking `audit-owed` is due for the episode. */
  owedLong: boolean;
  /** The owed episode's key: the last completed audit's job (its triggers are owed since it started), else the arc. */
  episode: Parent;
}>;

/** `held`: a drift event inside the throttle period (DRIFT_THROTTLE_MIN): owed, but not fresh. */
type Event<T> = Readonly<{ seq: number; trigger: T; held?: true }>;

/** The integration head now. */
export const integrationHeadNow = (ctx: Pick<StageContext, 'repo' | 'plan'>): Sha => revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));

const TERMINAL = ['retired', 'cut', 'superseded'];

/** Whether a unit of the plan in force can still publish. */
export const workRemains = (ctx: Pick<StageContext, 'journal' | 'plan'>): boolean => ctx.plan().units.some((u) => !TERMINAL.includes(ctx.journal.view.unit(u.id).status));

/** The lens run order: the vision first (its reading frames the others), then the rest ascending. */
export const runOrder = (lenses: readonly LensKind[]): readonly LensKind[] => [...lenses.filter((l) => l === 'vision'), ...lenses.filter((l) => l !== 'vision')];

/** The publications a cadence counts (D3): unit and batch ones, and a revision's docs publication carrying contract ops. */
function countedPublications(heads: readonly PublishedHead[], revisions: readonly AppliedRevision[]): readonly PublishedHead[] {
  const withOps = new Set(revisions.flatMap((r) => {
    if (r.payload.publication === null || r.payload.publication.contractOps.length === 0) return [];
    const pub = revisionPublication(heads, revisions, r);
    return pub === null ? [] : [pub.op];
  }));
  return heads.filter((h) => h.subject !== 'docs' || withOps.has(h.op));
}

/** How a revision drifts: not at all, fully, or (a bundle's) over these units' specs only. */
export type Drift = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'full' }> | Readonly<{ kind: 'specs-only'; units: readonly UnitId[] }>;

/** The unit a plan-unit or spec change names (`order` names none and is neutral), or null for any other change. */
function unitChanged(c: PlanChange): readonly UnitId[] | null {
  switch (c.type) {
    case 'unit-added': case 'unit-removed': case 'unit-changed': case 'spec': case 'unit-cut': case 'unit-priority':
      return [c.unit];
    case 'unit-reentered':
      return [c.unit, c.reenters];
    case 'routing':
      return c.unit === undefined ? null : [c.unit];
    case 'limits':
      return c.unit === null ? null : [c.unit];
    case 'order':
      return [];
    default:
      return null;
  }
}

/**
 * Whether and how a revision drifts (R15, R61). A bundle's drifts: fully when it changes the ledger, carries contract
 * ops or dispositions, or makes any change other than to plan units and their specs; else over those units' specs only.
 * A rule's or an architect's drifts fully when it changed the ledger, a spec, obligations, the mapping, the vision or the
 * arc's slice of it.
 */
export function driftOf(r: AppliedRevision, previous: AppliedRevision | null): Drift {
  const { source, manifest, changes } = r.payload;
  if (r.payload.base === 0 || source.type === 'executor') return { kind: 'none' };
  const ledger = previous !== null && canonicalJson(previous.payload.manifest.rulings) !== canonicalJson(manifest.rulings);
  if (source.type === 'bundle') {
    const units = changes.map(unitChanged);
    const contractOps = r.payload.publication !== null && r.payload.publication.contractOps.length > 0;
    if (ledger || contractOps || r.payload.dispositions.length > 0 || units.some((u) => u === null)) return { kind: 'full' };
    const named = [...new Set(units.flatMap((u) => u ?? []))].sort();
    return named.length === 0 ? { kind: 'full' } : { kind: 'specs-only', units: named };
  }
  const full = ledger || changes.some((c) => (c.type === 'spec' && c.edit !== 'evidence') || c.type === 'obligation' || c.type === 'mapping' || c.type === 'vision' || c.type === 'holistic' || c.type === 'advances');
  return full ? { kind: 'full' } : { kind: 'none' };
}

/**
 * The units a specs-only audit reads (H2): when every trigger it records is a specs-only drift, their units (ascending);
 * else null (a full audit).
 */
export function specsOnlyOf(triggers: readonly AuditTrigger[]): readonly UnitId[] | null {
  const units: UnitId[] = [];
  for (const t of triggers) {
    if (t.type !== 'drift' || t.specsOnly === undefined) return null;
    units.push(...t.specsOnly);
  }
  return units.length === 0 ? null : [...new Set(units)].sort();
}

// R8 reads the current selection, exemptions, latches and observations, not just the immutable publication.
// Reuse only at the same journal high-water mark; replace the entry so revisions do not grow the cache.
const unwitnessedMemo = new Map<string, Readonly<{ at: number; obligations: readonly ObligationId[] }>>();

/** R8: the active future (not latched) obligations a unit or batch publication selected and left unwitnessed on its tree. */
function unwitnessedBy(ctx: StageContext, h: PublishedHead): readonly ObligationId[] {
  const key = `${ctx.runDir}\0${h.op}`;
  const at = ctx.journal.view.highWater();
  const memo = unwitnessedMemo.get(key);
  if (memo?.at === at) return memo.obligations;
  const { obligations } = holisticInForce(ctx);
  const view = ctx.journal.view;
  let out: readonly ObligationId[] = [];
  if (obligations !== null) {
    const ff = view.latestIntent(h.op);
    const units = h.subject === 'batch'
      ? (view.opsOf('candidate.merge').filter((c) => c.expect.batch?.job === h.pub).at(-1)?.expect.batch?.members.map((m) => m.unit) ?? [])
      : ff.parent.type === 'stage' ? [ff.parent.unit] : [];
    if (units.length === 0) throw new Error(`publication ${h.op} names no unit`);
    const latched = new Set(view.holistic().latched.map((l) => l.obligation));
    const picked = new Map<ObligationId, (typeof obligations.obligations)[number]>();
    for (const id of units) {
      const unit = ctx.plan().units.find((u) => u.id === id);
      if (unit === undefined) throw new Error(`publication ${h.op} names unit ${id}, which the plan in force does not have`);
      for (const o of selected(ctx, unit, h.old, h.head)) {
        switch (o.state.type) {
          case 'active':
            if (o.witness !== null && !isMustHold(o, latched) && obligationBlockingUnits(view, o).length === 0) picked.set(o.id, o);
            break;
          // A split one is witnessed through its children; an exempt one was released by a ruling.
          case 'split': case 'waived': case 'deferred': case 'retired':
            break;
          default:
            throw new Error(`obligation ${o.id} is in state ${JSON.stringify(o.state satisfies never)}`);
        }
      }
    }
    out = observedViews(ctx, obligations, [...picked.values()], h.head)
      .filter((v) => v.observation === null || v.observation.verdict === 'unwitnessed').map((v) => v.obligation.id).sort(compareIds);
  }
  unwitnessedMemo.set(key, { at, obligations: out });
  return out;
}

/** The generation of an audit with `triggers` (see the header). */
function generationOf(ctx: StageContext, revisions: readonly AppliedRevision[], triggers: readonly AuditTrigger[]): number {
  const h = ctx.journal.view.holistic();
  return Math.max(0, ...h.audits.map((a) => a.started.generation)) + 1;
}

/** The latest audit whose outcome is `completed`, or null. */
const lastCompleted = (audits: readonly AuditState[]): AuditState | null => audits.filter((a) => a.ended?.outcome === 'completed').at(-1) ?? null;

/** The cadence now; null outside a holistic arc. */
export function cadence(ctx: StageContext, _clock: Clock): Cadence | null {
  const view = ctx.journal.view;
  if (!view.holistic().on || ctx.plan().holistic === undefined) return null;
  const base = coverageBase(ctx, integrationHeadNow(ctx));
  if (base === null) return null;
  const head = integrationHeadNow(ctx);
  const fold = view.holistic();
  const audited = new Set(fold.audits.filter((a) => a.ended?.outcome === 'completed').flatMap((a) => a.started.triggers.filter((t) => t.type === 'milestone').map((t) => t.type === 'milestone' ? t.milestone : '')));
  const milestone = (ctx.plan().milestones ?? []).find((m) => milestoneReached(view, m) && !audited.has(m.id));
  const latest = fold.audits.at(-1);
  const requested = fold.auditRequests.find((q) => q.seq > (lastCompleted(fold.audits)?.started.seq ?? 0));
  const final = !workRemains(ctx) && !fold.findings.some(f => f.severity === 'P1' && isActive(f)) && (!fold.audits.some((a) => a.ended?.outcome === 'completed' && a.started.visionSha256 === base.visionSha256) || lensCoverage(fold, base, 'invariants').watermark !== head);
  const owed: AuditTrigger[] = milestone !== undefined ? [{type: 'milestone', milestone: milestone.id}] : requested !== undefined ? [{type: 'requested', command: requested.command}] : final ? [{type: 'final'}] : [];
  const retryReady = latest?.ended?.outcome !== 'abandoned' || (requested?.seq ?? 0) > latest.started.seq || _clock(latest.started.seq) >= 360;
  const due = owed.length > 0 && retryReady && !fold.audits.some((a) => a.ended === null);
  return {base, head, owed, due, plan: due ? {triggers: owed, lenses: ['invariants'], generation: Math.max(0, ...fold.audits.map((a) => a.started.generation)) + 1} : null, owedLong: false, episode: {type: 'arc'}};
}
