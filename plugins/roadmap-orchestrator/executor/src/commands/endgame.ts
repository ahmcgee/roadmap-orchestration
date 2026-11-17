// The endgame commands (dev.82, WS-5; DESIGN-1.0.md §2.10): what the architect uses to finish an opened endgame episode's
// worklist by hand on the endgame branch (src/endgame/open.ts), and `resume <unit>`'s release of a unit the endgame holds.
//
// - `roadmap endgame fix --closes <id>[,<id>...] [--commit <sha>] --note "<line>"`: the one way to record a fix. The commit
//   (the CLI resolves the branch's head without `--commit`) must be on the endgame branch after the episode's base; each id
//   an active finding (`F-<n>`), an obligation in force (`I-<n>`) or a unit of the plan neither retired, cut nor superseded.
//   It writes `endgame-fix`; a named finding is then fixed on the endgame branch, owner the fix (src/holistic/findings.ts),
//   and resolves once a landing holds the commit. A named unit is cut by a code-applied revision, proposer and source
//   `endgame{command}` (classify.ts: it only cuts them), evaluated before the fact so a unit that may not be cut (one in a
//   task) refuses the command. A re-run after a crash finds its fact and commits what is missing.
// - `roadmap endgame land | review | run <lane>[,<lane>...] | checkpoint <milestone>`: a request (`endgame-requested`),
//   served by the scheduler (src/endgame/jobs.ts; a checkpoint by one more walk round, src/walk/milestones.ts). `land` is
//   refused unless the endgame branch's head strictly descends from the integration head (merge the tip in first); `run`
//   names suite lanes or arc lanes in force; `checkpoint` a milestone of the plan a round of which was walked.
// - Every act needs an opened episode.
import type { CommandId, MilestoneId, UnitId } from '../core/ids.ts';
import { type EndgameAct, type EndgameRequest, endgameUnits } from '../core/records.ts';
import type { EndgameEpisode } from '../core/state.ts';
import { endgameFixes } from '../endgame/fixes.ts';
import { endgameBranch } from '../endgame/open.ts';
import { endgameHeld, openEpisode } from '../endgame/phase.ts';
import { repairsReader } from '../endgame/open.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget } from '../git/git.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { isActive, syncFindings } from '../holistic/findings.ts';
import { inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { milestonesOf, parsePlan } from '../input/plan.ts';
import { repairUnits } from '../pipeline/reproduce.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import { walksOf } from '../walk/milestones.ts';
import { type CommandContext, type Effect, commitUnderFence, evaluateRevision } from './apply.ts';

const TERMINAL: readonly string[] = ['retired', 'cut', 'superseded'];

/** The reason a unit an endgame fix closes is cut with. */
export const endgameCutReason = (command: CommandId): string => `closed by endgame fix ${command}`;

/** The revision cutting `units` for fix `id`, evaluated against the plan in force (accepted, or why not). */
function cutRevision(ctx: CommandContext, id: CommandId, units: readonly UnitId[]) {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: Record<string, unknown>[] };
  for (const unit of units) {
    const entry = raw.units.find((u) => u['id'] === unit);
    if (entry === undefined) throw new Error(`the plan's bytes have no unit ${unit}`);
    entry['cut'] = { reason: endgameCutReason(id) };
  }
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const files = { ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes };
  const proposer = { type: 'endgame', command: id, units } as const;
  return { proposer, verdict: evaluateRevision({ runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv }, files, proposer) };
}

/** Why fix `act` may not be recorded in `episode` now, or null. */
function fixRefusal(ctx: CommandContext, episode: EndgameEpisode, act: Extract<EndgameAct, { type: 'fix' }>): string | null {
  const view = ctx.journal.view;
  const branch = endgameBranch(ctx.plan().arc);
  const tip = refTarget(ctx.repo, branch);
  if (tip === null) throw new Error(`endgame episode ${episode.episode} opened, but ${branch} does not exist`);
  const base = episode.opened!.base;
  if (act.commit === base || !isAncestor(ctx.repo, base, act.commit) || !isAncestor(ctx.repo, act.commit, tip)) {
    return `endgame fix: ${act.commit} is not a commit on ${branch} after its base ${base}`;
  }
  const { obligations } = holisticInForce(ctx);
  for (const ref of act.closes) {
    if (ref.startsWith('F-')) {
      const f = view.holistic().findings.find((x) => x.id === ref);
      if (f === undefined || !isActive(f)) return `endgame fix: ${ref} is ${f === undefined ? 'no finding of this arc' : `${f.state}, not active`}`;
    } else if (ref.startsWith('I-')) {
      if (!(obligations?.obligations ?? []).some((o) => o.id === ref)) return `endgame fix: ${ref} is no obligation in force`;
    } else {
      if (!ctx.plan().units.some((u) => u.id === ref)) return `endgame fix: ${ref} is no unit of the plan in force`;
      const status = view.unit(ref as UnitId).status;
      if (TERMINAL.includes(status)) return `endgame fix: unit ${ref} is ${status}`;
    }
  }
  return null;
}

async function fix(ctx: CommandContext, id: CommandId, episode: EndgameEpisode, act: Extract<EndgameAct, { type: 'fix' }>): Promise<Effect> {
  const units = endgameUnits(act.closes);
  if (!episode.fixes.some((f) => f.command === id)) {
    const refusal = fixRefusal(ctx, episode, act);
    if (refusal !== null) return { kind: 'rejected', reason: refusal };
    if (units.length > 0) {
      const { verdict } = cutRevision(ctx, id, units);
      if (verdict.kind === 'rejected') return { kind: 'rejected', reason: `endgame fix: the cut of ${units.join(', ')} is refused: ${verdict.reasons.join('; ')}` };
    }
    ctx.journal.fact({ kind: 'endgame-fix', command: id, closes: act.closes, commit: act.commit, note: act.note });
  }
  const verified = [`fix ${act.commit} recorded, closing ${act.closes.join(', ')}`];
  const uncut = units.filter((u) => ctx.journal.view.unit(u).status !== 'cut');
  if (uncut.length > 0) {
    for (;;) {
      const { proposer, verdict } = cutRevision(ctx, id, uncut);
      if (verdict.kind !== 'accepted') {
        verified.push(`${uncut.join(', ')} not cut: ${verdict.kind === 'rejected' ? verdict.reasons.join('; ') : 'unchanged'}`);
        break;
      }
      const out = await commitUnderFence(ctx, verdict, proposer, { type: 'endgame', command: id }, { type: 'command', command: id });
      if (out.kind === 'rejected' && out.reasons.some((r) => r.startsWith('stale:'))) continue;
      verified.push(out.kind === 'applied' ? `${uncut.join(', ')} cut (plan rev ${out.fact.rev})` : `${uncut.join(', ')} not cut: ${out.reasons.join('; ')}`);
      break;
    }
  }
  // After the cut: a unit it cut no longer owns what it repaired, so the fix does.
  syncFindings(ctx.journal, repairUnits(ctx), endgameFixes(ctx));
  return { kind: 'applied', verified };
}

/** Why `request` may not be recorded now, or null. */
function requestRefusal(ctx: CommandContext, request: EndgameRequest): string | null {
  const plan = ctx.plan();
  switch (request.type) {
    case 'land': {
      const branch = endgameBranch(plan.arc);
      const tip = refTarget(ctx.repo, branch);
      const head = integrationHeadNow(ctx);
      if (tip === null) throw new Error(`the endgame opened, but ${branch} does not exist`);
      if (tip === head) return `endgame land: ${branch} is at the integration head ${head}: nothing to land`;
      if (!isAncestor(ctx.repo, head, tip)) return `endgame land: ${branch} (${tip}) does not descend from the integration head ${head}: merge ${plan.integrationBranch} into it, then land`;
      return null;
    }
    case 'run': {
      const arc = new Set((holisticInForce(ctx).obligations?.lanes ?? []).map((l) => l.id));
      const unknown = request.lanes.filter((l) => !plan.suite.lanes.some((s) => s.id === l) && !arc.has(l));
      return unknown.length === 0 ? null : `endgame run: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} neither a suite lane nor an arc lane in force`;
    }
    case 'checkpoint': {
      const m: MilestoneId = request.milestone;
      if (!milestonesOf(plan).some((x) => x.id === m)) return `endgame checkpoint: ${m} is no milestone of the plan in force`;
      const rounds = walksOf(ctx.journal.view, m).filter((w) => w.ended !== null && w.ended.outcome !== 'abandoned');
      return rounds.length > 0 ? null : `endgame checkpoint: ${m} has no walked round yet; its walk is the pipeline's`;
    }
    case 'review':
      return null;
  }
}

/** `roadmap endgame <act>` (see the header). */
export async function endgame(ctx: CommandContext, id: CommandId, act: EndgameAct): Promise<Effect> {
  const episode = openEpisode(ctx.journal.view);
  if (episode === null || episode.opened === null) return { kind: 'rejected', reason: `endgame ${act.type}: no endgame episode is open (one opens once the endgame settled with a required worklist)` };
  if (act.type === 'fix') return fix(ctx, id, episode, act);
  if (!episode.requests.some((q) => q.command === id)) {
    const refusal = requestRefusal(ctx, act);
    if (refusal !== null) return { kind: 'rejected', reason: refusal };
    ctx.journal.fact({ kind: 'endgame-requested', command: id, request: act });
  }
  return { kind: 'applied', verified: [`endgame ${act.type} requested; the scheduler serves it`] };
}

/**
 * `resume <unit>` of a unit the endgame holds at admission (src/endgame/phase.ts `endgameHeld`): `endgame-released`, so the
 * hold drops and the unit runs. Null when the endgame does not hold it.
 */
export function releaseHeld(ctx: CommandContext, id: CommandId, unit: UnitId): Effect | null {
  const view = ctx.journal.view;
  const episode = openEpisode(view);
  if (episode?.released.some((r) => r.unit === unit && r.command === id)) return { kind: 'applied', verified: [`unit ${unit} released from the endgame's hold`] };
  if (!endgameHeld(view, ctx.plan(), repairsReader(ctx)).has(unit)) return null;
  if (episode === null) return { kind: 'rejected', reason: `unit ${unit}: the endgame is entered at the scheduler's next tick; resume it again then` };
  ctx.journal.fact({ kind: 'endgame-released', unit, command: id });
  return { kind: 'applied', verified: [`unit ${unit} released from the endgame's hold`] };
}
