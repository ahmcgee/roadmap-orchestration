// The chain of arcs (M4a, OR-Q19/20, K10, H12, H20), derived read-only by this module alone. There is no mutable chain
// file:
//   arcs   each arc's verified snapshot ref `refs/roadmap/<arc>` (`readArcRef`): its events folded, the plan in force at
//          its high-water and the bytes it keeps; an arc's previous arc is its plan's `chain.previousArc`;
//   acks   the ack log, write-once files in `$(git-common-dir)/roadmap/acks/`: `<briefId>.pending.json` committed by rename
//          to `<briefId>.json` (C4's `brief --ack` writes them; only committed ones count here);
//   K      `.roadmap/config.json` `chain.k` only.
// A start is acked when no chained start lies between it and the chainHead of the committed ack furthest along the
// chain; the bootstrap arc (no `chain`) counts as acked (R11). Consumers: `phase0Rows` (src/phase0/rows.ts), `roadmap
// pr`, and C4's `status`, `brief` and `chain status`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Event, type Fact, parseEventLine, prevHash } from './core/events.ts';
import { type AmendmentRef, type ArcId, type PhaseQuestionId, type Sha, type Sha256Hex, amendmentRefOf, arcId } from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import { EVENTS_FILE } from './core/log.ts';
import { type RevisionManifest } from './core/records.ts';
import { Fold } from './core/state.ts';
import { type AbsPath, absPath } from './core/values.ts';
import { git, gitCommonDir, gitRun, refTarget } from './git/git.ts';
import { snapshotRef, verifySnapshot } from './git/snapshot.ts';
import { PHASE0_INPUT, PLAN_INPUT, REVISION_INPUT } from './input/inforce.ts';
import { type PlanM1, parsePlan } from './input/plan.ts';
import { parseRevisionPayload } from './core/events.ts';
import { type AckMarker, type PhaseQuestion, parseAckMarker, parsePhase0Record } from './phase0/types.ts';

/** A snapshot ref that exists but does not verify, or holds another arc: loud, never a row. */
export class ArcRefError extends Error {
  constructor(arc: ArcId, detail: string) {
    super(`refs/roadmap/${arc}: ${detail}`);
    this.name = 'ArcRefError';
  }
}

/** An arc as its verified snapshot ref has it. */
export type ArcRef = Readonly<{
  arc: ArcId;
  /** The ref's commit and its manifest's high-water. */
  commit: Sha;
  highWater: number;
  events: readonly Event[];
  view: JournalView;
  /** The plan in force at the high-water, and the manifest of its revision. */
  plan: PlanM1;
  manifest: RevisionManifest;
  /** The bytes the ref keeps as `inputs/<sha>.<ext>`; a missing one throws `ArcRefError`. */
  input: (sha: Sha256Hex, ext: string) => Buffer;
}>;

/** The arc's verified ref, or null when it has none. */
export function readArcRef(repo: AbsPath, arc: ArcId): ArcRef | null {
  const ref = snapshotRef(arc);
  const commit = refTarget(repo, ref);
  if (commit === null) return null;
  const check = verifySnapshot(repo, commit);
  if (check.kind === 'mismatch') throw new ArcRefError(arc, `at ${commit} does not verify: ${check.detail}`);
  if (check.manifest.arc !== arc) throw new ArcRefError(arc, `at ${commit} is a snapshot of arc ${check.manifest.arc}`);
  const lines = git(repo, ['cat-file', 'blob', `${commit}:${EVENTS_FILE}`]).split('\n').filter((l) => l !== '');
  const fold = new Fold(arc);
  const events = lines.map((line) => {
    const e = parseEventLine(line);
    fold.apply(e, prevHash(Buffer.from(`${line}\n`, 'utf8')));
    return e;
  });
  const input = (sha: Sha256Hex, ext: string): Buffer => {
    const r = gitRun(repo, ['cat-file', 'blob', `${commit}:inputs/${sha}.${ext}`], { okCodes: [0, 128] });
    if (r.code !== 0) throw new ArcRefError(arc, `at ${commit} keeps no inputs/${sha}.${ext}`);
    return Buffer.from(r.stdout, 'utf8');
  };
  const applied = fold.planApplied();
  if (applied === null) throw new ArcRefError(arc, `at ${commit} records no plan in force`);
  const plan = parsePlan(JSON.parse(input(applied.planSha256, PLAN_INPUT).toString('utf8')));
  const manifest = parseRevisionPayload(JSON.parse(input(applied.payloadSha256, REVISION_INPUT).toString('utf8'))).manifest;
  return { arc, commit, highWater: check.manifest.highWater, events, view: fold, plan, manifest, input };
}

/** Every arc with a snapshot ref, ascending by id. */
export function arcsWithRefs(repo: AbsPath): readonly ArcId[] {
  return git(repo, ['for-each-ref', '--format=%(refname)', 'refs/roadmap/']).split('\n').filter((l) => l !== '')
    .map((r) => arcId(r.slice('refs/roadmap/'.length), r)).sort();
}

const factsOf = (ref: ArcRef): readonly Readonly<{ seq: number; fact: Fact }>[] =>
  ref.events.flatMap((e) => (e.type === 'fact' ? [{ seq: e.seq, fact: e.fact }] : []));

/**
 * The arc's completed head: the latest `arc-completed` after its latest plan revision (null when none), and whether that
 * completion is active (A20) or sealed (no work after it) in the ref.
 */
export type CompletedHead = Readonly<{ head: Sha; done: boolean }>;
export function completedHeadOf(ref: ArcRef): CompletedHead | null {
  const facts = factsOf(ref);
  const applied = facts.findLast((f) => f.fact.kind === 'plan-applied');
  const completed = facts.findLast((f) => f.fact.kind === 'arc-completed');
  if (completed === undefined || completed.fact.kind !== 'arc-completed' || applied === undefined || completed.seq < applied.seq) return null;
  const c = ref.view.holistic().completion;
  const done = c !== null && c.seq === completed.seq && (c.active || ref.view.lastWorkSeq() <= c.seq);
  return { head: completed.fact.head, done };
}

/** The `corpus-amendment` facts of the arc, as cited across arcs (`<arc>/M-n`). */
export function amendmentsOf(ref: ArcRef): readonly Readonly<{ id: AmendmentRef; fact: Extract<Fact, { kind: 'corpus-amendment' }> }>[] {
  return factsOf(ref).flatMap((f) => (f.fact.kind === 'corpus-amendment' ? [{ id: amendmentRefOf(ref.arc, f.fact.id), fact: f.fact }] : []));
}

/** Every Phase-0 question any revision of the arc kept (by id; a later revision's text wins only if equal, else both are seen). */
export function questionsOf(ref: ArcRef): readonly PhaseQuestion[] {
  const shas = new Set<Sha256Hex>();
  for (const f of factsOf(ref)) {
    if (f.fact.kind !== 'plan-applied') continue;
    const m = parseRevisionPayload(JSON.parse(ref.input(f.fact.payloadSha256, REVISION_INPUT).toString('utf8'))).manifest;
    if (m.phase0 !== undefined) shas.add(m.phase0);
  }
  return [...shas].flatMap((sha) => parsePhase0Record(JSON.parse(ref.input(sha, PHASE0_INPUT).toString('utf8'))).questions);
}

/**
 * The chain ending at `arc` (inclusive), oldest first, following each plan's `chain.previousArc`. An arc without a ref
 * ends the walk (the returned chain starts after it: `missing` names it); a loop is loud.
 */
export type ChainBack = Readonly<{ arcs: readonly ArcRef[]; missing: ArcId | null }>;
export function chainBack(repo: AbsPath, arc: ArcId): ChainBack {
  const out: ArcRef[] = [];
  const seen = new Set<ArcId>();
  for (let at: ArcId | null = arc; at !== null;) {
    if (seen.has(at)) throw new ArcRefError(arc, `its chain loops at ${at}`);
    seen.add(at);
    const ref = readArcRef(repo, at);
    if (ref === null) return { arcs: out.reverse(), missing: at };
    out.push(ref);
    at = ref.plan.chain?.previousArc ?? null;
  }
  return { arcs: out.reverse(), missing: null };
}

// ---------------------------------------------------------------------------------------------------
// The ack log

export const ACKS_DIR = 'acks';
export const acksDir = (repo: AbsPath): AbsPath => absPath(join(gitCommonDir(repo), 'roadmap', ACKS_DIR));
const COMMITTED = /^([0-9a-f]{16})\.json$/;

/** The committed acks (`<briefId>.json`), ascending by brief id. A pending marker is not an ack until renamed. */
export function committedAcks(repo: AbsPath): readonly AckMarker[] {
  const dir = acksDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => COMMITTED.test(n)).sort().map((n) => {
    const marker = parseAckMarker(JSON.parse(readFileSync(join(dir, n), 'utf8')));
    if (`${marker.briefId}.json` !== n) throw new Error(`${join(dir, n)} holds the ack of brief ${marker.briefId}`);
    return marker;
  });
}

/**
 * The starts of `chain` (oldest first) not yet acked: those after the chainHead of the committed ack furthest along the
 * chain, or after the bootstrap arc when no ack names an arc of it.
 */
export function unackedStarts(chain: readonly ArcId[], acks: readonly AckMarker[]): readonly ArcId[] {
  const at = Math.max(0, ...acks.map((a) => chain.indexOf(a.chainHead)));
  return chain.slice(at + 1);
}

/** The questions of the chain closure by id, with the texts seen (one text per id when the closure is consistent). */
export function questionClosure(arcs: readonly ArcRef[]): ReadonlyMap<PhaseQuestionId, ReadonlySet<string>> {
  const out = new Map<PhaseQuestionId, Set<string>>();
  for (const ref of arcs) for (const q of questionsOf(ref)) out.set(q.id, (out.get(q.id) ?? new Set()).add(q.text));
  return out;
}
