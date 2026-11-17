// dev.82: where the arc is (`Status.phase`) and what the endgame recorded (`Status.endgame`), read through the scheduler's
// read-only contexts, so status and the executor read one rule (src/endgame/open.ts `endgameNow`, `reviewDue`,
// src/schedule/scheduler.ts `obligationsOn`).
//
//   phase     `body` (the planned units still open and the milestones still awaiting their checkpoint: what holds the
//             endgame off), `endgame` (its step, its episode, the worklist's counts and the handover once opened) or
//             `closed-out` (an active `arc-completed`). An arc without the holistic layer stays in the body until it
//             completes.
//   endgame   null before an arc's first episode. Otherwise: the endgame branch, its worktree and tip; the open
//             episode's worklist and its exit conditions (each of the four fixed ones, null unless an opened episode
//             is open); the audited range; the units an episode took over (held now, released by `resume`, or closed
//             by a fix); and every episode in order, each with its fixes, landings, reviews, jobs and how it was left.
import { existsSync, readFileSync } from 'node:fs';
import type { EndgameJobOutcome } from '../core/events.ts';
import type { CommandId, FindingId, JobId, MilestoneId, NeedsUserId, PlanRev, Sha, Sha256Hex, UnitId } from '../core/ids.ts';
import { parseOpId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { EndgameEpisode } from '../core/state.ts';
import type { AbsPath, RefName } from '../core/values.ts';
import type { EndgameStep } from '../endgame/phase.ts';
import { endgameHeld, openEpisode } from '../endgame/phase.ts';
import { ENDGAME_BY_HAND, endgameBranch, endgameNow, endgameWorktree, handoverPath, repairsReader, reviewDue } from '../endgame/open.ts';
import type { Worklist } from '../endgame/worklist.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget } from '../git/git.ts';
import { cadence, integrationHeadNow } from '../holistic/cadence.ts';
import { coverageBase, coverageOf } from '../holistic/coverage.ts';
import { readNeedsUser } from '../needsuser.ts';
import { batchWitnessDue } from '../pipeline/batchlanes.ts';
import { type HolisticContexts, obligationsOn } from '../schedule/scheduler.ts';
import { bytesSha256 } from '../spec/spec.ts';

export type PhaseView =
  | Readonly<{ kind: 'body'; planned: readonly UnitId[]; milestones: readonly MilestoneId[] }>
  | Readonly<{ kind: 'endgame'; step: EndgameStep; episode: number; required: number; optional: number; handover: AbsPath | null }>
  | Readonly<{ kind: 'closed-out' }>;

/** The four fixed exit conditions of an opened episode now. */
export type EndgameExit = Readonly<{
  /** No required worklist entry remains. */
  worklist: boolean;
  /** No independent review is owed (`reviewDue`): one covers the endgame branch's commits and every episode's landings, or there are none. */
  review: boolean;
  /** The endgame branch landed and the final audit's invariants coverage reached the integration head. */
  audit: boolean;
  /** dev.82: the final audit is owed but waits for the `closing` step (src/holistic/cadence.ts `deferred`). */
  auditAtClosing: boolean;
  /** The endgame branch landed, every obligation holds on the head, and no closing batch witness is owed. */
  obligations: boolean;
}>;

/** A unit an episode took over: held at admission now (`handed-over`), sent back in by `resume`, or closed by a fix. */
export type EndgameUnit = Readonly<{ unit: UnitId; relation: 'handed-over' | 'released' | 'closed'; command: CommandId | null; commit: Sha | null }>;

export type EpisodeView = Readonly<{
  episode: number;
  planRev: PlanRev;
  enteredSeq: number;
  /** Null until it opened (an episode with an empty required worklist opens only for an unreviewed earlier landing). */
  opened: Readonly<{
    seq: number; base: Sha; handover: AbsPath; handoverSha256: Sha256Hex;
    /** The `endgame` item and its recommendation (null if it was not raised yet); `sizeGuard`: the handover's required entries were more than ENDGAME_BY_HAND. */
    item: Readonly<{ id: NeedsUserId; recommendation: string }> | null;
    sizeGuard: boolean;
  }> | null;
  fixes: readonly Readonly<{ seq: number; command: CommandId; closes: readonly string[]; commit: Sha; note: string; landed: boolean }>[];
  landings: readonly Readonly<{ seq: number; job: JobId; old: Sha; head: Sha }>[];
  reviews: readonly Readonly<{ seq: number; job: JobId; from: Sha; to: Sha; findings: readonly FindingId[] }>[];
  jobs: readonly Readonly<{ job: JobId; command: CommandId | null; request: 'land' | 'review' | 'run'; startSeq: number; outcome: EndgameJobOutcome | null; detail: string | null; endSeq: number | null }>[];
  released: readonly Readonly<{ seq: number; unit: UnitId; command: CommandId }>[];
  left: EndgameEpisode['left'];
}>;

export type EndgameView = Readonly<{
  branch: RefName;
  worktree: AbsPath;
  /** The endgame branch's tip (null before the first episode opened). */
  tip: Sha | null;
  /** The tip is an ancestor of the integration head (false without a tip). */
  landed: boolean;
  /** The open episode's worklist (empty without one). */
  worklist: Worklist;
  exit: EndgameExit | null;
  /** The invariants lens's audited range: the coverage base and its watermark (null before a coverage base). */
  audited: Readonly<{ from: Sha; to: Sha }> | null;
  units: readonly EndgameUnit[];
  episodes: readonly EpisodeView[];
}>;

const isUnitRef = (ref: string): boolean => !/^[FI]-\d+$/.test(ref);

/** The required entries the handover listed (src/endgame/handover.ts: the `- ` lines under `## Required`). */
function handoverRequired(text: string): number {
  const lines = text.split('\n');
  const start = lines.indexOf('## Required');
  if (start < 0) throw new Error('an endgame handover without its required section');
  let n = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) n++;
  }
  return n;
}

function episodeView(h: HolisticContexts, e: EndgameEpisode): EpisodeView {
  const ctx = h.audit;
  const view = ctx.journal.view;
  let opened: EpisodeView['opened'] = null;
  if (e.opened !== null) {
    const path = handoverPath(ctx.runDir, e.episode);
    const text = existsSync(path) ? readFileSync(path) : null;
    const raise = view.opsOf('needsuser.raise').find((i) => parseOpId(i.op).seq > e.opened!.seq && view.doneOf(i.op) !== null && readNeedsUser(ctx.runDir, i.expect.id)?.reason === 'endgame'
      && (e.left === null || parseOpId(i.op).seq < e.left.seq));
    const item = raise === undefined ? null : readNeedsUser(ctx.runDir, raise.expect.id);
    opened = {
      seq: e.opened.seq, base: e.opened.base, handover: path, handoverSha256: e.opened.handoverSha256,
      item: item === null ? null : { id: item.id, recommendation: item.recommendation },
      sizeGuard: text !== null && bytesSha256(text) === e.opened.handoverSha256 && handoverRequired(text.toString('utf8')) > ENDGAME_BY_HAND,
    };
  }
  const landing = e.landings.map((l) => l.head);
  return {
    episode: e.episode, planRev: e.planRev, enteredSeq: e.seq, opened,
    fixes: e.fixes.map((f) => ({ seq: f.seq, command: f.command, closes: [...f.closes], commit: f.commit, note: f.note, landed: landing.some((head) => isAncestor(ctx.repo, f.commit, head)) })),
    landings: e.landings.map((l) => ({ seq: l.seq, job: l.job, old: l.old, head: l.head })),
    reviews: e.reviews.map((r) => ({ seq: r.seq, job: r.job, from: r.from, to: r.to, findings: [...r.findings] })),
    jobs: e.jobs.map((j) => ({ job: j.started.job, command: j.started.command, request: j.started.request.type, startSeq: j.started.seq, outcome: j.ended?.outcome ?? null, detail: j.ended?.detail ?? null, endSeq: j.ended?.seq ?? null })),
    released: e.released.map((r) => ({ seq: r.seq, unit: r.unit, command: r.command })),
    left: e.left,
  };
}

/** The phase now (see the header); `h` null before a start recorded a plan in force. */
export function phaseOf(h: HolisticContexts | null, view: JournalView): PhaseView {
  if (view.holistic().completion?.active === true) return { kind: 'closed-out' };
  if (h === null) return { kind: 'body', planned: [], milestones: [] };
  const now = endgameNow(h.audit, h.laneEnv);
  if (now.phase.kind === 'body') return now.phase;
  const opened = now.episode?.opened ?? null;
  return {
    kind: 'endgame', step: now.phase.step, episode: now.phase.episode, required: now.worklist.required.length, optional: now.worklist.optional.length,
    handover: opened === null ? null : handoverPath(h.audit.runDir, now.phase.episode),
  };
}

/** The endgame's record now (see the header), or null before the arc's first episode. */
export function endgameOf(h: HolisticContexts): EndgameView | null {
  const ctx = h.audit;
  const view = ctx.journal.view;
  const episodes = view.holistic().endgame;
  if (episodes.length === 0) return null;
  const plan = ctx.plan();
  const now = endgameNow(ctx, h.laneEnv);
  const open = openEpisode(view);
  const tip = refTarget(ctx.repo, endgameBranch(plan.arc));
  const head = integrationHeadNow(ctx);
  const landed = tip !== null && isAncestor(ctx.repo, tip, head);
  const base = coverageBase(ctx, head);
  const invariants = base === null ? null : coverageOf(view.holistic(), base, ['invariants'], head)[0]!;
  const exit: EndgameExit | null = open === null || open.opened === null ? null : {
    worklist: now.worklist.required.length === 0,
    review: !reviewDue(ctx, open),
    audit: landed && invariants !== null && !invariants.outstanding,
    auditAtClosing: cadence(ctx, ctx.clock, h.laneEnv)?.deferred ?? false,
    obligations: landed && obligationsOn(ctx, head, h.laneEnv) === 'discharged' && batchWitnessDue(ctx, 'closing') === null,
  };
  const units: EndgameUnit[] = [];
  for (const unit of endgameHeld(view, plan, repairsReader(ctx))) units.push({ unit, relation: 'handed-over', command: null, commit: null });
  for (const e of episodes) {
    for (const r of e.released) if (!units.some((u) => u.unit === r.unit)) units.push({ unit: r.unit, relation: 'released', command: r.command, commit: null });
    for (const f of e.fixes) {
      for (const ref of f.closes) {
        if (!isUnitRef(ref)) continue;
        const at = units.findIndex((u) => u.unit === ref);
        const closed: EndgameUnit = { unit: ref as UnitId, relation: 'closed', command: f.command, commit: f.commit };
        if (at < 0) units.push(closed); else units[at] = closed;
      }
    }
  }
  return {
    branch: endgameBranch(plan.arc), worktree: endgameWorktree(plan.worktreeRoot, plan.arc), tip, landed,
    worklist: now.worklist, exit,
    audited: base === null || invariants === null ? null : { from: base.head, to: invariants.watermark },
    units, episodes: episodes.map((e) => episodeView(h, e)),
  };
}
