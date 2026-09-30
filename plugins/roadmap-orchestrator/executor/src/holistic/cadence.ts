// Audit cadence (M3 step B5; DESIGN-1.0.md §2.5 "Triggers", "Owed"; D3, R8, R15, H3, H9, OR-Q2): which triggers are
// owed, whether an audit is due, which lenses it runs and which generation it records. Derived from the log each time
// (nothing of it is persisted but the `audit-started` that consumes it).
//
// Triggers (each an event of the log after the last completed audit's start, or after the coverage base when no
// completed audit follows it):
//   cadence       N qualifying publications (D3: `holistic.audit.every`, default 5): unit and batch publications, and a
//                 revision's docs publication that carries contract ops (a rule's); a docs-only one is not counted
//   unwitnessed   R8: a unit or batch publication that selected a future (not latched) or exempt obligation left
//                 unwitnessed on its tree (no observation there, or verdict `unwitnessed`)
//   drift         a revision from a bundle, a rule (its ledger or sidecars changed), `reverse`, or an architect spec,
//                 obligation, mapping or vision edit (R15: a vision revision, and the arc turning holistic): runs
//                 L ∩ {drift, vision}, or all of L when that is empty
//   wall-clock    `wallClockMin` (default 360) since the latest audit started or unit published, while work remains
//                 (a plan unit not retired, cut or superseded)
//   requested     `audit [--lens]` (`audit-requested`): its lenses ∩ L, or L
//   final         H9: no work remains and some lens in L has an outstanding range: those lenses only
// Everything else runs all of L. Triggers coalesce: an audit records every owed trigger.
//
// Due: one audit at a time, and some trigger is fresh: its event came after the latest audit started, the wall-clock
// trigger fired, or `final` holds after a completed audit (or before any). So an audit abandoned mid-run (a lens failed,
// its backend parked) is not retried at once for the same triggers: they stay owed until something new happens or the
// period (`wallClockMin`) has passed since it started. A skipped audit (its lens backend parked, the arc paused:
// `skipReason`) writes nothing.
//
// Owed (OR-Q2/3): triggers owed for 2N qualifying publications, or for 2 × `wallClockMin` since the last completed
// audit started (or the base), raise one non-blocking `audit-owed` per episode (audit.ts `raiseAuditOwed`).
//
// Generation (§2.8): an audit a bundle's revision triggered is its checkpoint's generation + 1; any other is one more
// than the highest generation any audit or checkpoint recorded.
//
// Time: `Clock(seq)` is the minutes since the fact at `seq` was written. `processClock` is the executor's: it times a
// fact from when this process first saw it (a fact older than the process from the process's start), so a restart
// delays a wall-clock trigger, never fires one early.
import type { AuditTrigger } from './types.ts';
import { type LensKind, isExempt, LENS_KINDS } from './types.ts';
import type { Parent } from '../core/events.ts';
import type { ObligationId, Sha } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AuditState } from '../core/state.ts';
import { branchRef } from '../core/values.ts';
import { revParse } from '../git/git.ts';
import { DEFAULT_AUDIT, lensSetOf } from '../input/plan.ts';
import type { StageContext } from '../pipeline/dispatch.ts';
import { selected } from '../pipeline/gate.ts';
import { observedViews } from '../pipeline/lanes.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import { type AppliedRevision, type CoverageBase, type PublishedHead, appliedRevisions, coverageBase, coverageOf, publishedHeads, revisionPublication } from './coverage.ts';

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

type Event<T> = Readonly<{ seq: number; trigger: T }>;

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

/** Whether a revision drifts (R15): a bundle's; a rule's or an architect's that changed the ledger, a spec, obligations, the mapping or the vision. */
function drifts(r: AppliedRevision, previous: AppliedRevision | null): boolean {
  const { source, manifest, changes } = r.payload;
  if (r.payload.base === 0) return false;
  if (source.type === 'bundle') return true;
  if (source.type === 'executor') return false;
  const ledger = previous !== null && JSON.stringify(previous.payload.manifest.rulings) !== JSON.stringify(manifest.rulings);
  return ledger || changes.some((c) => (c.type === 'spec' && c.edit !== 'evidence') || c.type === 'obligation' || c.type === 'mapping' || c.type === 'vision' || c.type === 'holistic');
}

// R8 is a git diff and a spec read per publication: read each once per process.
const unwitnessedMemo = new Map<string, readonly ObligationId[]>();

/** R8: the future (not latched) or exempt obligations a unit or batch publication selected and left unwitnessed on its tree. */
function unwitnessedBy(ctx: StageContext, h: PublishedHead): readonly ObligationId[] {
  const key = `${ctx.runDir}\0${h.op}`;
  const memo = unwitnessedMemo.get(key);
  if (memo !== undefined) return memo;
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
        if (o.state.type === 'split' || o.witness === null) continue;
        if (isExempt(o) || (o.activation === 'future' && !latched.has(o.id))) picked.set(o.id, o);
      }
    }
    out = observedViews(ctx, obligations, [...picked.values()], h.head)
      .filter((v) => v.observation === null || v.observation.verdict === 'unwitnessed').map((v) => v.obligation.id).sort();
  }
  unwitnessedMemo.set(key, out);
  return out;
}

/** The generation of an audit with `triggers` (see the header). */
function generationOf(ctx: StageContext, revisions: readonly AppliedRevision[], triggers: readonly AuditTrigger[]): number {
  const h = ctx.journal.view.holistic();
  const byCheckpoint = new Map(h.checkpoints.map((c) => [c.inputs.job, c.inputs.generation]));
  const fromBundles = triggers.flatMap((t) => {
    if (t.type !== 'drift') return [];
    const source = revisions.find((r) => r.payload.rev === t.planRev)?.payload.source;
    if (source?.type !== 'bundle') return [];
    const g = byCheckpoint.get(source.job);
    if (g === undefined) throw new Error(`plan rev ${t.planRev} was applied by ${source.job}, which has no checkpoint inputs`);
    return [g + 1];
  });
  if (fromBundles.length > 0) return Math.max(...fromBundles);
  return Math.max(0, ...h.audits.map((a) => a.started.generation), ...h.checkpoints.map((c) => c.inputs.generation)) + 1;
}

/** The latest audit whose outcome is `completed`, or null. */
const lastCompleted = (audits: readonly AuditState[]): AuditState | null => audits.filter((a) => a.ended?.outcome === 'completed').at(-1) ?? null;

/** The cadence now; null outside a holistic arc. */
export function cadence(ctx: StageContext, clock: Clock): Cadence | null {
  const view = ctx.journal.view;
  const holistic = ctx.plan().holistic;
  if (!view.holistic().on || holistic === undefined) return null;
  const head = integrationHeadNow(ctx);
  const base = coverageBase(ctx, head);
  if (base === null) throw new Error('a holistic arc whose revisions name no vision');
  const L = lensSetOf(holistic);
  const every = holistic.audit?.every ?? DEFAULT_AUDIT.every;
  const wallClockMin = holistic.audit?.wallClockMin ?? DEFAULT_AUDIT.wallClockMin;
  const fold = view.holistic();
  const completed = lastCompleted(fold.audits);
  const latest = fold.audits.at(-1) ?? null;
  const since = completed !== null && completed.started.seq > base.seq ? completed.started.seq : base.seq;
  const fresh = (seq: number): boolean => latest === null || seq > latest.started.seq;

  const revisions = appliedRevisions(ctx);
  const heads = publishedHeads(view);
  const pubs = countedPublications(heads, revisions).filter((h) => h.seq > since);
  const events: Event<AuditTrigger>[] = [];
  if (pubs.length >= every) events.push({ seq: pubs.at(-1)!.seq, trigger: { type: 'cadence' } });
  const seen = new Set<ObligationId>();
  for (const h of pubs) {
    if (h.subject === 'docs') continue;
    for (const obligation of unwitnessedBy(ctx, h)) {
      if (seen.has(obligation)) continue;
      seen.add(obligation);
      events.push({ seq: h.seq, trigger: { type: 'unwitnessed', obligation } });
    }
  }
  revisions.forEach((r, i) => {
    if (r.seq >= since && drifts(r, i === 0 ? null : revisions[i - 1]!)) events.push({ seq: r.seq, trigger: { type: 'drift', planRev: r.payload.rev } });
  });
  const requested = fold.auditRequests.filter((q) => q.seq > since);
  for (const q of requested) events.push({ seq: q.seq, trigger: { type: 'requested', command: q.command } });

  const remains = workRemains(ctx);
  const outstanding = coverageOf(fold, base, L, head).filter((c) => c.outstanding).map((c) => c.lens);
  const anchor = Math.max(latest?.started.seq ?? 0, heads.filter((h) => h.subject !== 'docs').at(-1)?.seq ?? 0, base.seq);
  const elapsed = clock(anchor) >= wallClockMin;
  const wallClock = elapsed && remains;
  const final = !remains && outstanding.length > 0;
  const finalFresh = final && (latest === null || latest.ended?.outcome === 'completed');
  // Owed triggers an abandoned audit left are asked again once the period has passed (with no work left, no wall-clock
  // trigger joins them: the final one alone runs the lenses still outstanding).
  const retry = elapsed && (events.length > 0 || final);

  const owed: AuditTrigger[] = [
    ...events.filter((e) => e.trigger.type === 'cadence').map((e) => e.trigger),
    ...events.filter((e) => e.trigger.type === 'unwitnessed').map((e) => e.trigger),
    ...events.filter((e) => e.trigger.type === 'drift').map((e) => e.trigger),
    ...(wallClock ? [{ type: 'wall-clock' } as const] : []),
    ...events.filter((e) => e.trigger.type === 'requested').map((e) => e.trigger),
    ...(final ? [{ type: 'final' } as const] : []),
  ];
  const running = latest !== null && latest.ended === null;
  const due = !running && (events.some((e) => fresh(e.seq)) || wallClock || finalFresh || retry);

  const lenses = new Set<LensKind>();
  for (const t of owed) {
    switch (t.type) {
      case 'drift': {
        const narrowed = L.filter((l) => l === 'drift' || l === 'vision');
        for (const l of narrowed.length > 0 ? narrowed : L) lenses.add(l);
        break;
      }
      case 'requested': {
        const q = requested.find((x) => x.command === t.command)!;
        for (const l of L.filter((x) => q.lenses === null || q.lenses.includes(x))) lenses.add(l);
        break;
      }
      case 'final':
        for (const l of outstanding) lenses.add(l);
        break;
      default:
        for (const l of L) lenses.add(l);
    }
  }
  const sorted = LENS_KINDS.filter((l) => lenses.has(l)).sort();
  if (owed.length > 0 && sorted.length === 0) throw new Error(`the owed triggers ${JSON.stringify(owed)} call for no lens of L = ${L.join(', ')} (the audit command refuses a lens outside L)`);
  const plan = due && owed.length > 0 ? { triggers: owed, lenses: sorted, generation: generationOf(ctx, revisions, owed) } : null;
  const owedLong = owed.length > 0 && (pubs.length >= 2 * every || clock(since) >= 2 * wallClockMin);
  const episode: Parent = completed === null ? { type: 'arc' } : { type: 'job', job: completed.started.job };
  return { base, head, owed, due, plan, owedLong, episode };
}
