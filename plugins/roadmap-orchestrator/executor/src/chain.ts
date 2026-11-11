// The chain of arcs (M4a, OR-Q19/20, K10, H12, H20), derived read-only by this module alone. There is no mutable chain
// file:
//   arcs   each arc's verified snapshot ref `refs/roadmap/<arc>` (`readArcRef`): its events folded, the plan in force at
//          its high-water and the bytes it keeps; an arc's previous arc is its plan's `chain.previousArc`;
//   acks   the ack log, write-once files in `$(git-common-dir)/roadmap/acks/`: `<briefId>.pending.json` committed by rename
//          to `<briefId>.json` (`brief --ack` writes them; only committed ones count here). A pending marker a crash left
//          is finished here (`finishPendingAcks`) by `brief`, `brief --ack` and `start`;
//   K      `.roadmap/config.json` `chain.k` only.
// A start is acked when no chained start lies between it and the chainHead of the committed ack furthest along the
// chain; the bootstrap arc (no `chain`) counts as acked (R11). Consumers: `phase0Rows` (src/phase0/rows.ts), `roadmap
// pr`, and C4's `status`, `brief` and `chain status`.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Event, type Fact, parseEventLine, prevHash } from './core/events.ts';
import { type ArcId, type BriefId, type CommandId, type PhaseQuestionId, type Sha, type Sha256Hex, arcId } from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import { EVENTS_FILE, readJournal } from './core/log.ts';
import { type RevisionManifest } from './core/records.ts';
import { Fold } from './core/state.ts';
import { type AbsPath, type BranchName, absPath } from './core/values.ts';
import { git, gitCommonDir, refTarget } from './git/git.ts';
import { SNAPSHOT_MANIFEST, snapshotRef, verifySnapshot } from './git/snapshot.ts';
import { PHASE0_INPUT, PLAN_INPUT, REVISION_INPUT, planInForce } from './input/inforce.ts';
import { type PlanM1, parsePlan } from './input/plan.ts';
import { parseRevisionPayload } from './core/events.ts';
import { type AckMarker, type ChainProblem, type NextStart, type PhaseQuestion, parseAckMarker, parsePhase0Record } from './phase0/types.ts';
import { ackCommandId, enqueueCommand } from './commands/queue.ts';
import { crashPoint } from './core/crash.ts';
import { durableRename } from './core/fsx.ts';
import { SCHEMA_VERSION } from './core/version.ts';
import { runDir } from './input/cli.ts';
import { DEMO_REF } from './demo/records.ts';
import { objectOnce } from './observation/memo.ts';

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

let arcRefReads: Map<string, ArcRef> | null = null;
export function withArcRefReads<T>(read: () => T): T {
  if (arcRefReads !== null) return read();
  arcRefReads = new Map();
  try { return read(); } finally { arcRefReads = null; }
}

/** The arc's verified ref, or null when it has none. */
export function readArcRef(repo: AbsPath, arc: ArcId): ArcRef | null {
  const commit = refTarget(repo, snapshotRef(arc));
  return commit === null ? null : arcRefAt(repo, arc, commit);
}

/** The arc's ref at `commit`, verified. */
function arcRefAt(repo: AbsPath, arc: ArcId, commit: Sha): ArcRef {
  const key = commit;
  const cached = arcRefReads?.get(key);
  if (cached !== undefined) {
    if (cached.arc !== arc) throw new ArcRefError(arc, `at ${commit} is a snapshot of arc ${cached.arc}`);
    return cached;
  }
  const check = verifySnapshot(repo, commit);
  if (check.kind === 'mismatch') throw new ArcRefError(arc, `at ${commit} does not verify: ${check.detail}`);
  if (check.manifest.arc !== arc) throw new ArcRefError(arc, `at ${commit} is a snapshot of arc ${check.manifest.arc}`);
  const bytes = check.files.get(EVENTS_FILE)!;
  const fold = new Fold(arc);
  const events = check.events;
  let offset = 0;
  for (const e of events) {
    const end = bytes.indexOf(10, offset) + 1;
    fold.apply(e, prevHash(bytes.subarray(offset, end)));
    offset = end;
  }
  // Only the kept inputs outlive the verification, copied out of the batch read's one buffer: the ref's other files
  // (results, witnesses) are most of its bytes, and a chain holds every earlier arc's ref.
  const inputs = new Map([...check.files].filter(([path]) => path.startsWith('inputs/')).map(([path, bytes]) => [path, Buffer.from(bytes)] as const));
  const input = (sha: Sha256Hex, ext: string): Buffer => {
    const bytes = inputs.get(`inputs/${sha}.${ext}`);
    if (bytes === undefined) throw new ArcRefError(arc, `at ${commit} keeps no inputs/${sha}.${ext}`);
    return bytes;
  };
  const applied = fold.planApplied();
  if (applied === null) throw new ArcRefError(arc, `at ${commit} records no plan in force`);
  const plan = parsePlan(JSON.parse(input(applied.planSha256, PLAN_INPUT).toString('utf8')));
  const manifest = parseRevisionPayload(JSON.parse(input(applied.payloadSha256, REVISION_INPUT).toString('utf8'))).manifest;
  const result = { arc, commit, highWater: check.manifest.highWater, events, view: fold, plan, manifest, input };
  arcRefReads?.set(key, result);
  return result;
}

/** An arc of the chain: its integration branch and its previous arc. */
export type ChainLink = Readonly<{ arc: ArcId; branch: BranchName; previousArc: ArcId | null }>;

/** What a long-lived reader keeps of an arc's verified ref: its commit, its chain link and its completed head. */
export type ArcRefDigest = Readonly<{ arc: ArcId; commit: Sha; link: ChainLink; completed: CompletedHead | null }>;

/**
 * The digest of the arc's verified ref, or null when it has none. A snapshot commit is immutable, so an observer with a
 * memo (src/observation/memo.ts) verifies it once and keeps only the digest, never the ref's events, fold or files.
 */
export function arcRefDigest(repo: AbsPath, arc: ArcId): ArcRefDigest | null {
  const commit = refTarget(repo, snapshotRef(arc));
  if (commit === null) return null;
  return objectOnce(`arc-ref:${arc}:${commit}`, () => {
    const ref = arcRefAt(repo, arc, commit);
    return { arc, commit, link: { arc, branch: ref.plan.integrationBranch, previousArc: ref.plan.chain?.previousArc ?? null }, completed: completedHeadOf(ref) };
  });
}

// Schema-cut scaffolding (dev.36): an arc a schema-1 executor (dev.32 or earlier) wrote is not adopted, so the cross-arc
// scans pass over it. Only `v: 1` is passed over; any other mismatch stays loud in the readers. Delete once no repo
// carries a dev.32 run dir or snapshot.
const schema1 = (json: string): boolean => (JSON.parse(json) as { v?: unknown }).v === 1;

function schema1RunDir(dir: string): boolean {
  const line = readFileSync(join(dir, EVENTS_FILE), 'utf8').split('\n', 1)[0]!;
  try {
    return line.trim() !== '' && schema1(line);
  } catch (error) {
    // A torn or malformed first line is the journal reader's to report (log-corrupt, with its offset).
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

const schema1Ref = (repo: AbsPath, ref: string): boolean => schema1(git(repo, ['cat-file', 'blob', `${ref}:${SNAPSHOT_MANIFEST}`]));

/**
 * Every arc with a snapshot ref, ascending by id (`refs/roadmap/demo` is the demo's, dev.13: no arc's), except a schema-1
 * one.
 */
export function arcsWithRefs(repo: AbsPath): readonly ArcId[] {
  return git(repo, ['for-each-ref', '--format=%(refname)', 'refs/roadmap/']).split('\n').filter((l) => l !== '' && l !== DEMO_REF && !schema1Ref(repo, l))
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
  const { arcs, missing } = walkBack(arc, (at) => readArcRef(repo, at), (ref) => ref.plan.chain?.previousArc ?? null);
  return { arcs, missing };
}

/** `chainBack` as digests (`arcRefDigest`): the one walk, keeping only what a long-lived reader keeps. */
export function chainDigestsBack(repo: AbsPath, arc: ArcId): Readonly<{ arcs: readonly ArcRefDigest[]; missing: ArcId | null }> {
  return walkBack(arc, (at) => arcRefDigest(repo, at), (d) => d.link.previousArc);
}

function walkBack<T>(arc: ArcId, read: (arc: ArcId) => T | null, previous: (t: T) => ArcId | null): Readonly<{ arcs: readonly T[]; missing: ArcId | null }> {
  const out: T[] = [];
  const seen = new Set<ArcId>();
  for (let at: ArcId | null = arc; at !== null;) {
    if (seen.has(at)) throw new ArcRefError(arc, `its chain loops at ${at}`);
    seen.add(at);
    const ref = read(at);
    if (ref === null) return { arcs: out.reverse(), missing: at };
    out.push(ref);
    at = previous(ref);
  }
  return { arcs: out.reverse(), missing: null };
}

/**
 * The arc started on `arc`'s head (owner ruling 2026-10-16: `arc` is then reopened no more; its PR's fixes land in that
 * arc): one whose plan in force names `arc` as `chain.previousArc`, from its run dir's log (a started arc records its
 * plan first), else from its verified ref (a run dir `gc` pruned). Null when none has started.
 */
export function successorOf(repo: AbsPath, arc: ArcId): ArcId | null {
  // classify.ts's chain-immutable row fixes the chain at revision 1. Locate its seq cheaply,
  // then let readJournal verify and fold that prefix with its usual corruption handling.
  const firstPlanSeq = (dir: AbsPath): number | null => {
    const fd = openSync(join(dir, EVENTS_FILE), 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let carry = Buffer.alloc(0);
      let seq = 0;
      for (;;) {
        const n = readSync(fd, chunk);
        if (n === 0) return null;
        const bytes = Buffer.concat([carry, chunk.subarray(0, n)]);
        let start = 0;
        for (let nl = bytes.indexOf(10); nl !== -1; nl = bytes.indexOf(10, start)) {
          const line = bytes.subarray(start, nl);
          start = nl + 1;
          seq += 1;
          if (!line.includes('"plan-applied"')) continue;
          try {
            const e = JSON.parse(line.toString('utf8')) as Event;
            if (e.type === 'fact' && e.fact.kind === 'plan-applied') return seq;
          } catch {
            // The verifier below reports an invalid complete line, including its byte offset.
            return null;
          }
        }
        carry = Buffer.from(bytes.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  };
  const common = gitCommonDir(repo);
  const runtime = join(common, 'roadmap-runtime');
  const read = new Set<ArcId>([arc]);
  for (const name of existsSync(runtime) ? readdirSync(runtime).sort() : []) {
    const next = arcId(name, runtime);
    if (read.has(next) || !existsSync(join(runDir(common, next), EVENTS_FILE)) || schema1RunDir(runDir(common, next))) continue;
    read.add(next);
    const dir = runDir(common, next);
    if (planInForce(dir, readJournal(dir, next, firstPlanSeq(dir)).view)?.plan.chain?.previousArc === arc) return next;
  }
  for (const next of arcsWithRefs(repo)) {
    if (!read.has(next) && readArcRef(repo, next)?.plan.chain?.previousArc === arc) return next;
  }
  return null;
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

const PENDING = /^([0-9a-f]{16})\.pending\.json$/;
export const pendingAckPath = (repo: AbsPath, id: BriefId): string => join(acksDir(repo), `${id}.pending.json`);
export const committedAckPath = (repo: AbsPath, id: BriefId): string => join(acksDir(repo), `${id}.json`);
export const readAckMarker = (path: string): AckMarker => parseAckMarker(JSON.parse(readFileSync(path, 'utf8')));

/** The ack commands of `marker`, one per item, by ordinal (R26). */
export const ackCommandsOf = (marker: AckMarker): readonly CommandId[] => marker.items.map((_, i) => ackCommandId(marker.at, i));

/**
 * `brief --ack` steps 3–4 (src/commands/brief.ts) from the marker's bytes alone: enqueue each item's `ack` (idempotent),
 * then commit the marker by rename (crash label `brief.ack.after-enqueue`).
 */
export function commitAckMarker(repo: AbsPath, marker: AckMarker): readonly CommandId[] {
  const ids = ackCommandsOf(marker);
  const common = gitCommonDir(repo);
  marker.items.forEach((item, i) => {
    enqueueCommand(runDir(common, item.arc), { v: SCHEMA_VERSION, id: ids[i]!, arc: item.arc, at: marker.at, body: { type: 'ack', needsUser: item.id, choice: null } });
  });
  crashPoint('brief.ack.after-enqueue');
  durableRename(pendingAckPath(repo, marker.briefId), committedAckPath(repo, marker.briefId));
  return ids;
}

/** Finishes every pending marker a crash left (steps 3–4); returns them. `brief`, `brief --ack` and `start` call it first. */
export function finishPendingAcks(repo: AbsPath): readonly AckMarker[] {
  const dir = acksDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => PENDING.test(n)).sort().map((n) => {
    const marker = readAckMarker(join(dir, n));
    if (`${marker.briefId}.pending.json` !== n) throw new Error(`${join(dir, n)} holds the pending ack of brief ${marker.briefId}`);
    if (existsSync(committedAckPath(repo, marker.briefId))) throw new Error(`brief ${marker.briefId} is both pending and committed in ${dir}`);
    commitAckMarker(repo, marker);
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

// ---------------------------------------------------------------------------------------------------
// The start predicate (H12, R11): the chain rows that need no plan of the start. `chainRow` (src/phase0/rows.ts) applies
// them around its baseline rows; `nextStartOf` answers them for the start after the chain's head (`chain status`,
// `status`, the brief), so the root agent never computes K itself (paid M4a run 12).

/** The previous arc's row: its verified ref holds a done completion (`completed`: its completed head, null for no ref or none). */
export function previousIncomplete(previousArc: ArcId, completed: CompletedHead | null): Extract<ChainProblem, { type: 'previous-incomplete' }> | null {
  return completed === null || !completed.done ? { type: 'previous-incomplete', arc: previousArc } : null;
}

/** K's rows for a start chained on the last arc of `chain` (oldest first): K set, and the unacked starts with this one within K. */
export type Quota = Exclude<NextStart, Readonly<{ reason: 'previous-incomplete' }>>;
export function quotaOf(chain: readonly ArcId[], k: number | null, acks: readonly AckMarker[]): Quota {
  if (k === null) return { allowed: false, reason: 'k-unset' };
  const unacked = unackedStarts(chain, acks).length + 1;
  return unacked > k ? { allowed: false, reason: 'limit', k, unacked } : { allowed: true, reason: 'within-k', k, unacked };
}

/** The start after the last arc of `chain` (oldest first; `head`: its completed head, null for no ref or none): its previous-arc and K rows. */
export function nextStartOf(chain: readonly ArcId[], head: CompletedHead | null, k: number | null, acks: readonly AckMarker[]): NextStart {
  const last = chain.at(-1);
  if (last === undefined) throw new Error('the next start of an empty chain');
  const previous = previousIncomplete(last, head);
  return previous === null ? quotaOf(chain, k, acks) : { allowed: false, reason: 'previous-incomplete', arc: previous.arc };
}

/** The questions of the chain closure by id, with the texts seen (one text per id when the closure is consistent). */
export function questionClosure(arcs: readonly ArcRef[]): ReadonlyMap<PhaseQuestionId, ReadonlySet<string>> {
  const out = new Map<PhaseQuestionId, Set<string>>();
  for (const ref of arcs) for (const q of questionsOf(ref)) out.set(q.id, (out.get(q.id) ?? new Set()).add(q.text));
  return out;
}
