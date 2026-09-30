// Audit coverage (M3 step B5; DESIGN-1.0.md §2.5 "Coverage"; A17, H3, H8, H9): per lens, a contiguous watermark over
// the integration history, derived from the log and the kept revision payloads (pure: no git, no clock).
//
// - The base (H3, lead ruling 2026-09-30): the arc's base is the integration head at the revision that turned the arc
//   holistic (its own docs publication's head when it published, else the head its `revision.commit` found). The latest
//   vision revision (`seq`, `visionSha256`) clears every coverage recorded before it: audits started under an older
//   vision and docs edges recorded before it no longer count, so every lens's watermark restarts at the arc's base and
//   the next audit of each lens at X covers everything up to X, exactly as a first audit would. No merged range can
//   survive a vision change unaudited, and it costs no extra call.
// - A lens's watermark starts at the base and follows, from wherever it stands, each range an audit under the current
//   vision covered for that lens (`audit-ended.covered`: from the lens's watermark at the audit's capture to the audited
//   SHA, never beyond it) and each docs-only edge (`docs-covered{U→D}`, A17, H8). An edge extends the watermark only
//   once it reaches U; until then it is kept, and applies when the gap closes. Nothing else moves a watermark.
// - A lens has an outstanding range while its watermark is not the integration head.
//
// The integration history is read from the published `integration.ff`s: a docs publication's at its intent's seq (it
// publishes inside its revision, under the fence), a unit's or a batch's at its done's seq (`publications()`; the slot
// serialises them, so their done order is their op order).
import type { OpId, Sha, Sha256Hex, JobId } from '../core/ids.ts';
import { parseOpId } from '../core/ids.ts';
import type { IntentOf } from '../core/events.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { HolisticFold } from '../core/state.ts';
import type { AbsPath } from '../core/values.ts';
import { keptPayload } from '../input/inforce.ts';
import type { RevisionPayload } from '../core/events.ts';
import type { LensKind } from './types.ts';

/** One published `integration.ff`: where the integration head moved, and when (the seq it counts at). */
export type PublishedHead = Readonly<{ seq: number; op: OpId; old: Sha; head: Sha; subject: 'unit' | 'batch' | 'docs'; pub: JobId | null }>;

/** Every published `integration.ff` of the arc, ascending by the seq it counts at. */
export function publishedHeads(view: JournalView): readonly PublishedHead[] {
  const doneSeqs = [...new Set(view.publications().map((p) => p.seq))];
  let next = 0;
  const out: PublishedHead[] = [];
  for (const ff of view.opsOf('integration.ff')) {
    const done = view.doneOf(ff.op);
    if (done === null || done.kind !== 'integration.ff' || done.outcome.kind !== 'published') continue;
    const { subject } = ff.expect;
    if (subject?.type === 'docs') {
      out.push({ seq: parseOpId(ff.op).seq, op: ff.op, old: ff.expect.old, head: ff.expect.new, subject: 'docs', pub: subject.pub });
      continue;
    }
    // An ff under no stage and no batch publishes nothing the arc counts (the git primitives' own tests).
    if (subject === undefined && ff.parent.type !== 'stage') continue;
    const seq = doneSeqs[next];
    if (seq === undefined) throw new Error(`integration.ff ${ff.op} published, but the fold records no publication for it`);
    next += 1;
    out.push({ seq, op: ff.op, old: ff.expect.old, head: ff.expect.new, subject: subject?.type === 'batch' ? 'batch' : 'unit', pub: subject?.type === 'batch' ? subject.job : null });
  }
  if (next !== doneSeqs.length) throw new Error(`the fold records ${doneSeqs.length} publications, the log's published ffs ${next}`);
  return out.sort((a, b) => a.seq - b.seq);
}

/** The integration head just before `seq`: the latest head published before it, else the first publication's base, else `tip` (nothing published yet). */
export function headBefore(heads: readonly PublishedHead[], seq: number, tip: Sha): Sha {
  const before = heads.filter((h) => h.seq < seq).at(-1);
  return before?.head ?? heads[0]?.old ?? tip;
}

/** An applied revision: its `revision.commit` (seq, rev, source) and its kept payload. */
export type AppliedRevision = Readonly<{ seq: number; commit: IntentOf<'revision.commit'>; payload: RevisionPayload }>;

// Payloads are content-addressed and immutable: read each once per process.
const payloads = new Map<string, RevisionPayload>();

/** Every applied revision (1.0.0-dev.6 and later: a 1.0.0-dev.5 revision has no `revision.commit`), in log order. */
export function appliedRevisions(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>): readonly AppliedRevision[] {
  const view = ctx.journal.view;
  return view.opsOf('revision.commit').flatMap((commit) => {
    const done = view.doneOf(commit.op);
    if (done === null || done.kind !== 'revision.commit') return [];
    const key = `${ctx.runDir}\0${commit.expect.payloadSha256}`;
    let payload = payloads.get(key);
    if (payload === undefined) {
      payload = keptPayload(ctx.runDir, commit.expect.payloadSha256);
      payloads.set(key, payload);
    }
    return [{ seq: parseOpId(commit.op).seq, commit, payload }];
  });
}

/** The docs publication a revision carried: the published docs ff begun after its `revision.commit` and before the next one. */
export function revisionPublication(heads: readonly PublishedHead[], revisions: readonly AppliedRevision[], r: AppliedRevision): PublishedHead | null {
  const nextSeq = revisions.find((x) => x.seq > r.seq)?.seq ?? Number.POSITIVE_INFINITY;
  return heads.find((h) => h.subject === 'docs' && h.seq > r.seq && h.seq < nextSeq) ?? null;
}

/**
 * Where coverage starts (H3): `head` the arc's base (the head when it turned holistic); `seq` and `visionSha256` the
 * revision that set the vision in force, before which nothing recorded counts.
 */
export type CoverageBase = Readonly<{ seq: number; visionSha256: Sha256Hex; head: Sha }>;

/**
 * The coverage base as of `before` (default: now), or null when no revision before it names a vision (not holistic).
 * `tip` is the integration head to use when nothing was published before the base.
 */
export function coverageBase(
  ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, tip: Sha, before = Number.POSITIVE_INFINITY,
): CoverageBase | null {
  const revisions = appliedRevisions(ctx).filter((r) => r.seq < before);
  let previous: Sha256Hex | null = null;
  let on: AppliedRevision | null = null;
  let set: AppliedRevision | null = null;
  for (const r of revisions) {
    const vision = r.payload.manifest.vision;
    if (vision !== null && previous === null) on = r;
    if (vision !== null && vision !== previous) set = r;
    previous = vision;
  }
  if (set === null || on === null) return null;
  const heads = publishedHeads(ctx.journal.view);
  const head = revisionPublication(heads, revisions, on)?.head ?? headBefore(heads, on.seq, tip);
  const visionSha256 = set.payload.manifest.vision;
  if (visionSha256 === null) throw new Error('unreachable: the base revision names a vision');
  return { seq: set.seq, visionSha256, head };
}

/** A lens's coverage: its watermark, the ranges and edges it followed, and the docs edges kept for a gap still open. */
export type LensCoverage = Readonly<{
  lens: LensKind;
  watermark: Sha;
  followed: readonly Readonly<{ from: Sha; to: Sha; by: 'audit' | 'docs'; job: JobId }>[];
  pendingDocs: readonly Readonly<{ pub: JobId; from: Sha; to: Sha }>[];
}>;

/**
 * `lens`'s coverage from `base`, over the audits ended and the docs edges recorded before `before` (default: all): the
 * watermark an audit captured at its start is this with `before` its `audit-started` seq.
 */
export function lensCoverage(fold: HolisticFold, base: CoverageBase, lens: LensKind, before = Number.POSITIVE_INFINITY): LensCoverage {
  type Edge = Readonly<{ from: Sha; to: Sha; by: 'audit' | 'docs'; job: JobId }>;
  const edges: Edge[] = [
    ...fold.audits.flatMap((a) => (a.ended === null || a.ended.seq >= before || a.started.seq <= base.seq || a.started.visionSha256 !== base.visionSha256
      ? []
      : a.ended.covered.filter((c) => c.lens === lens).map((c): Edge => ({ from: c.from, to: c.to, by: 'audit', job: a.started.job })))),
    ...fold.docsCovered.filter((d) => d.seq > base.seq && d.seq < before).map((d): Edge => ({ from: d.from, to: d.to, by: 'docs', job: d.pub })),
  ];
  const used = new Set<number>();
  const followed: Edge[] = [];
  let watermark = base.head;
  for (;;) {
    const i = edges.findIndex((e, k) => !used.has(k) && e.from === watermark);
    if (i === -1) break;
    used.add(i);
    const e = edges[i]!;
    followed.push(e);
    watermark = e.to;
  }
  const pendingDocs = edges.flatMap((e, k) => (used.has(k) || e.by !== 'docs' ? [] : [{ pub: e.job, from: e.from, to: e.to }]));
  return { lens, watermark, followed, pendingDocs };
}

/** Each lens of `lenses` with its coverage and whether a range is outstanding at `head`. */
export function coverageOf(fold: HolisticFold, base: CoverageBase, lenses: readonly LensKind[], head: Sha): readonly (LensCoverage & Readonly<{ outstanding: boolean }>)[] {
  return lenses.map((lens) => {
    const c = lensCoverage(fold, base, lens);
    return { ...c, outstanding: c.watermark !== head };
  });
}
