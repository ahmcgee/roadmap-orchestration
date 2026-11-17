// The endgame's steps over the arc as it stands (dev.82; src/endgame/phase.ts has the predicate): the phase with its step and
// worklist now (`endgameNow`, what completion and status read), the open step (`openDue`, `openEndgame`) and its item.
//
// - **Open** (the scheduler's holistic job, once the episode settled: no unit running, no walk or audit due or running, and
//   a required worklist): the branch `roadmap/<arc>/endgame` and its worktree `<worktreeRoot>/<arc>/endgame` at the
//   integration tip (journaled `worktree.create`; an earlier episode's branch and worktree are kept), the handover
//   (src/endgame/handover.ts) kept at `<runDir>/endgame/handover-<episode>.md` by hash, then `endgame-opened{episode,
//   base, handoverSha256}`. With an empty required worklist the episode never opens: the close-out settlement and the
//   completion predicate finish the arc as before.
// - **The item**: one non-blocking `endgame` item per opened episode (subject the arc), raised after the fact and again
//   on a later tick if a crash fell between (`raiseEndgameItem`). Its recommendation carries the size guard: more than
//   ENDGAME_BY_HAND required entries names the remaining units and suggests `resume <unit>` or a repair unit by apply (advisory).
// - **Closing** (`stepOf`): the required worklist empty and the endgame branch landed (its tip an ancestor of the integration head). What the closing
//   step runs before the arc completes (the review job over `base..head`, the batch witness at the head) is
//   `closingSettled`'s; the scheduler runs them as the endgame's jobs (src/endgame/jobs.ts).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArcId, EnvId, ObligationId, Sha, Sha256Hex } from '../core/ids.ts';
import { parseOpId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { specRepairs } from '../core/records.ts';
import type { EndgameEpisode } from '../core/state.ts';
import { type AbsPath, type RefName, absPath, refName } from '../core/values.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget } from '../git/git.ts';
import { auditPending } from '../holistic/audit.ts';
import { batchWitnessDue } from '../pipeline/batchlanes.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import type { ArcLaneDef } from '../holistic/types.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import type { StageContext } from '../pipeline/dispatch.ts';
import { runOp } from '../pipeline/dispatch.ts';
import { loadUnitSpec } from '../pipeline/stages.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { obligationVerdicts } from '../schedule/scheduler.ts';
import { bytesSha256 } from '../spec/spec.ts';
import { walkPending } from '../walk/walk.ts';
import { renderHandover } from './handover.ts';
import { type Phase, type RepairsOf, openEpisode, phaseKind, runningUnits, stepOf } from './phase.ts';
import { EMPTY_WORKLIST, type Worklist, type WorklistEntry, worklist } from './worklist.ts';

/** The size guard: more required entries than this, and the item suggests taking the largest back into the pipeline. */
export const ENDGAME_BY_HAND = 10;

/** The endgame branch, `roadmap/<arc>/endgame`. */
export const endgameBranch = (arc: ArcId): RefName => refName(`refs/heads/roadmap/${arc}/endgame`);
/** The endgame worktree, `<worktreeRoot>/<arc>/endgame`. */
export const endgameWorktree = (root: AbsPath, arc: ArcId): AbsPath => absPath(join(root, arc, 'endgame'));
/** Episode `episode`'s handover, `<runDir>/endgame/handover-<episode>.md`. */
export const handoverPath = (runDir: AbsPath, episode: number): AbsPath => absPath(join(runDir, 'endgame', `handover-${episode}.md`));

type Ctx = Pick<StageContext, 'journal' | 'runDir' | 'repo' | 'plan' | 'planDir'>;

/** What each unit's spec in force repairs, read on demand. */
export const repairsReader = (ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planDir: AbsPath }>): RepairsOf =>
  (unit) => specRepairs(loadUnitSpec(ctx, unit).spec);

export type EndgameNow = Readonly<{ phase: Phase; worklist: Worklist; episode: EndgameEpisode | null }>;

/** The phase with its step, the worklist and the open episode now (in the body: the empty worklist, no episode). */
export function endgameNow(ctx: Ctx, laneEnv: (lane: ArcLaneDef) => EnvId | null): EndgameNow {
  const view = ctx.journal.view;
  const plan = ctx.plan();
  const repairsOf = repairsReader(ctx);
  const kind = phaseKind(view, plan, repairsOf);
  if (kind.kind === 'body') return { phase: kind, worklist: EMPTY_WORKLIST, episode: null };
  const episode = openEpisode(view);
  const head = integrationHeadNow(ctx);
  const notHeld: ObligationId[] = [];
  for (const v of obligationVerdicts(ctx, head, laneEnv)) if (v.verdict === 'not-held') notHeld.push(v.obligation);
  const list = worklist(view, plan, repairsOf, notHeld, episode);
  const tip = episode !== null && episode.opened !== null ? refTarget(ctx.repo, endgameBranch(plan.arc)) : null;
  const landed = tip !== null && isAncestor(ctx.repo, tip, head);
  return {
    phase: { kind: 'endgame', step: stepOf(episode, list.required.length, landed), episode: episode?.episode ?? view.holistic().endgame.length + 1 },
    worklist: list, episode,
  };
}

/**
 * WS-5: whether `episode` owes an independent review: the endgame branch holds commits of its own (its tip is not the
 * episode's base), or one of its landings published some, and none of its reviews reached a head holding that tip or that
 * landing (each review covers `base..head`, so one that holds a commit covers every endgame commit before it; the
 * executor's own later publications, a close-out say, owe none). A landed episode owes one even when its branch was reset
 * to its base afterwards. An episode whose worklist emptied without a commit (a dismissal, a re-entered unit merging) owes
 * none.
 */
export function reviewDue(ctx: Pick<StageContext, 'repo' | 'plan'>, episode: EndgameEpisode): boolean {
  const tip = refTarget(ctx.repo, endgameBranch(ctx.plan().arc));
  if (tip === null) throw new Error(`endgame episode ${episode.episode} opened, but ${endgameBranch(ctx.plan().arc)} does not exist`);
  const reviewed = (commit: Sha): boolean => episode.reviews.some((r) => isAncestor(ctx.repo, commit, r.to));
  return (tip !== episode.opened?.base && !reviewed(tip)) || episode.landings.some((l) => !reviewed(l.head));
}

/**
 * Whether the closing step has run everything it owes before the arc may complete (WS-5): no endgame job running, the
 * independent review over the endgame's range (`reviewDue`) and the batch witness at the head (`batchWitnessDue(ctx,
 * 'closing')`: the batch arc lanes' obligations witnessed on the final tip). The final audit's coverage of the head and the
 * obligations held there are completion clauses of their own (src/schedule/scheduler.ts), and a P1 the review or the audit
 * opens is a required worklist entry, which returns the step to `open`.
 */
export function closingSettled(ctx: StageContext, episode: EndgameEpisode): boolean {
  return episode.jobs.every((j) => j.ended !== null) && !reviewDue(ctx, episode) && batchWitnessDue(ctx, 'closing') === null;
}

/**
 * The `endgame-open` completion clause: an episode not yet settled. One not opened holds completion while its required
 * worklist is non-empty (the open step is then due, and no other clause reads an active P1 over no obligation); an
 * opened one while its step is `open`, or `closing` with `closingSettled` false.
 */
export function endgameOpen(ctx: StageContext, laneEnv: (lane: ArcLaneDef) => EnvId | null): boolean {
  const now = endgameNow(ctx, laneEnv);
  if (now.phase.kind !== 'endgame' || now.episode === null) return false;
  if (now.episode.opened === null) return now.worklist.required.length > 0;
  return now.phase.step === 'open' || !closingSettled(ctx, now.episode);
}

/**
 * Whether the open step is due: an open episode not opened, nothing running, no walk or audit due or running (the settling
 * step's order: walks, then the final audit), and a required worklist.
 */
export function openDue(ctx: StageContext & Parameters<typeof auditPending>[0], laneEnv: (lane: ArcLaneDef) => EnvId | null): boolean {
  const view = ctx.journal.view;
  const episode = openEpisode(view);
  if (episode === null || episode.opened !== null) return false;
  if (runningUnits(view, ctx.plan()).length > 0 || walkPending(ctx) || auditPending(ctx)) return false;
  return endgameNow(ctx, laneEnv).worklist.required.length > 0;
}

/** The open step (see the header): branch and worktree, the handover, `endgame-opened`, then the item. */
export async function openEndgame(ctx: StageContext, laneEnv: (lane: ArcLaneDef) => EnvId | null): Promise<void> {
  const view = ctx.journal.view;
  const plan = ctx.plan();
  const episode = openEpisode(view);
  if (episode === null || episode.opened !== null) throw new Error('the endgame opens an open episode, once');
  const branch = endgameBranch(plan.arc);
  const worktree = endgameWorktree(plan.worktreeRoot, plan.arc);
  if (!existsSync(worktree)) {
    const existing = refTarget(ctx.repo, branch);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), 'worktree:endgame', { type: 'arc' }, {
      path: worktree, checkout: { type: 'branch', branch, at: existing ?? integrationHeadNow(ctx), createBranch: existing === null },
    });
  }
  const base = refTarget(ctx.repo, branch);
  if (base === null) throw new Error(`the endgame worktree ${worktree} stands, but its branch ${branch} does not`);
  const now = endgameNow(ctx, laneEnv);
  const text = renderHandover(ctx, { episode: episode.episode, base, branch, worktree, worklist: now.worklist });
  const path = handoverPath(ctx.runDir, episode.episode);
  durableMkdir(dirname(path));
  durableWrite(path, text);
  const handoverSha256: Sha256Hex = bytesSha256(Buffer.from(text, 'utf8'));
  ctx.journal.fact({ kind: 'endgame-opened', episode: episode.episode, base, handoverSha256 });
  raiseEndgameItem(ctx, laneEnv);
}

/** Whether an `endgame` item was raised after the open episode opened. */
function itemRaised(view: JournalView, runDir: AbsPath, openedSeq: number): boolean {
  return view.opsOf('needsuser.raise').some((i) => parseOpId(i.op).seq > openedSeq && view.doneOf(i.op) !== null && readNeedsUser(runDir, i.expect.id)?.reason === 'endgame');
}

const describe = (e: WorklistEntry): string => {
  switch (e.type) {
    case 'finding':
      return `${e.finding} (${e.severity}${e.obligation === null ? '' : ` over ${e.obligation}`})`;
    case 'obligation':
      return `${e.obligation} not held on the integration head`;
    case 'unit':
      return `unit ${e.unit}`;
    case 'polish-refused':
      return `polish proposal ${e.proposal} (refused)`;
  }
};

/** The open episode's item, once it opened and none was raised since (each tick; see the header). */
export function raiseEndgameItem(ctx: Pick<StageContext, 'journal' | 'runDir' | 'repo' | 'plan' | 'planDir'>, laneEnv: (lane: ArcLaneDef) => EnvId | null): void {
  const view = ctx.journal.view;
  const episode = openEpisode(view);
  if (episode === null || episode.opened === null || itemRaised(view, ctx.runDir, episode.opened.seq)) return;
  const plan = ctx.plan();
  const { required, optional } = endgameNow(ctx, laneEnv).worklist;
  const units = required.flatMap((e) => (e.type === 'unit' ? [e.unit] : []));
  const guard = required.length <= ENDGAME_BY_HAND ? '' : ` ${required.length} required entries are more than ${ENDGAME_BY_HAND} to finish by hand: take the largest back into the pipeline${units.length > 0 ? ` (\`roadmap resume <unit>\` for a held unit: ${units.join(', ')})` : ''}, or admit a repair unit with \`roadmap apply\`.`;
  raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false, subject: { type: 'arc' }, reason: 'endgame',
    summary: `The endgame opened (episode ${episode.episode}): ${required.length} required (${required.map(describe).join(', ')}) and ${optional.length} optional entries to finish by hand on ${endgameBranch(plan.arc)} from ${episode.opened.base}.`,
    recommendation: `Read the handover (${handoverPath(ctx.runDir, episode.episode)}) and work in ${endgameWorktree(plan.worktreeRoot, plan.arc)}.${guard}`,
    options: [], evidence: [handoverPath(ctx.runDir, episode.episode)],
  }, { type: 'arc' });
}
