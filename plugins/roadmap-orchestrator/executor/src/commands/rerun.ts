// `roadmap rerun <u>/lanes#<n>/<lane> --cause estate|infra --evidence <line>` (dev.59): the root waives a lanes red whose cause
// it says is outside the tree, and the unit runs its lanes again at the same commit, no build, in a fresh checkout (a mutation,
// scope {u}: it applies once the unit's task is idle or waiting for admission, and its pending drain keeps an unstarted fix
// build out). The argument is the failure reference `status.units[].failures` prints, so it pins the red the root read.
//
// The effect is one fact, its own postcondition: `lanes-rerun{unit, command, attempt, lane, at, cause, evidence, by: root}`.
// The fold sends the unit to its lanes (`entry`, `rerun`); a park's open needs-user closes with the command (apply.ts). The
// waived red's charge stands. A green rerun goes on to the gate; a red series parks `rerun-red` for the root, uncharged, and
// `resume <unit>` then restores the waived decision (stages.ts `lanes`, src/core/state.ts `#restoreParked`). No build runs,
// so the build cap is untouched; the rerun's lanes attempt counts toward the judged-stage total like any other.
//
// Refused: an unknown, finished or running unit; lanes#n not the unit's latest stage attempt (a fix round started since:
// steer it instead), or not a red a rerun waives (`RERUNNABLE`); a lane that did not run red there; a unit branch that moved
// off the commit lanes#n ran on; a lane already rerun at that commit (at most once per lane per head).
import type { CommandId } from '../core/ids.ts';
import { RERUNNABLE } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { type CommandBody,isRed } from '../core/records.ts';
import { refTarget } from '../git/git.ts';
import { type StageParent,matchesVerificationPath,unitBranch,verificationWorktree } from '../pipeline/dispatch.ts';
import type { CommandContext,Effect } from './apply.ts';

type RerunBody = Extract<CommandBody, { type: 'rerun' }>;

const RERUNNABLE_STATUS = new Set(['active', 'held', 'park-pending']);

export function rerun(ctx: CommandContext, id: CommandId, body: RerunBody): Effect {
  const view = ctx.journal.view;
  const ref = `${body.unit}/lanes#${body.attempt}/${body.lane}`;
  // Run again after a crash past the fact: it is the postcondition.
  const recorded = view.holistic().lanesReruns.find((r) => r.command === id);
  if (recorded !== undefined) return { kind: 'applied', verified: [verifiedText(ref, recorded.at)] };
  const unit = ctx.plan().units.find((u) => u.id === body.unit);
  if (unit === undefined) return { kind: 'rejected', reason: `unknown unit ${body.unit}` };
  const u = view.unit(unit.id);
  if (unit.cut !== undefined || !RERUNNABLE_STATUS.has(u.status)) return { kind: 'rejected', reason: `unit ${unit.id} is ${u.status}: only an active, held or parked unit takes a rerun` };
  if (u.open !== null) return { kind: 'rejected', reason: `unit ${unit.id} is running ${u.open.stage} attempt ${u.open.attempt}` };
  const decided = u.decided;
  if (decided === null || decided.stage !== 'lanes' || decided.attempt !== body.attempt) {
    const latest = view.completedLanes(unit.id);
    return { kind: 'rejected', reason: `${ref}: lanes#${body.attempt} is not unit ${unit.id}'s latest decision (${decided === null ? 'none yet' : `${decided.stage}#${decided.attempt} ${decided.outcome}`}${latest === null ? '' : `; its latest lanes attempt is ${latest}`})` };
  }
  if (u.counters.attempts !== body.attempt) {
    return { kind: 'rejected', reason: `${ref}: unit ${unit.id} started attempt ${u.counters.attempts} since lanes#${body.attempt} (its fix round began): \`roadmap steer ${unit.id} --brief <file> --budget <min>\` redirects it instead` };
  }
  if (!(RERUNNABLE as readonly string[]).includes(decided.outcome)) return { kind: 'rejected', reason: `${ref}: lanes#${body.attempt} ended ${decided.outcome}; a rerun waives only ${RERUNNABLE.join(', ')}` };
  const parent: StageParent = { type: 'stage', unit: unit.id, stage: 'lanes', attempt: body.attempt };
  const { worktreeRoot, arc } = ctx.plan();
  const checkout = view.opsOfParent('worktree.create', parent).find((i) => matchesVerificationPath(i.expect.path, verificationWorktree(worktreeRoot, arc, unit.id), body.attempt));
  if (checkout === undefined || checkout.expect.checkout.type !== 'detached') return { kind: 'rejected', reason: `${ref}: lanes#${body.attempt} ran no lane` };
  const at = checkout.expect.checkout.at;
  const red = (l: string): boolean => view.spawnsOfUnit(unit.id).some((i) => {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || s.lane !== l || s.at !== at || i.parent.type !== 'stage' || i.parent.stage !== 'lanes' || i.parent.attempt !== body.attempt) return false;
    const done = view.doneOf(i.op);
    return done?.kind === 'proc.spawn' && done.outcome.kind === 'result' && done.outcome.summary.type === 'command' && isRed(done.outcome.summary.verdict);
  });
  if (!red(body.lane)) return { kind: 'rejected', reason: `${ref}: lane ${body.lane} did not run red in lanes#${body.attempt}` };
  const tip = refTarget(ctx.repo, unitBranch(arc, unit.id));
  if (tip !== at) return { kind: 'rejected', reason: `${ref}: unit ${unit.id}'s branch is at ${tip ?? 'nothing'}, no longer at ${at}, the commit lanes#${body.attempt} ran on` };
  const earlier = view.holistic().lanesReruns.find((r) => r.unit === unit.id && r.lane === body.lane && r.at === at);
  if (earlier !== undefined) return { kind: 'rejected', reason: `${ref}: lane ${body.lane} of ${unit.id} was rerun at ${at} already (${earlier.command}); a lane reruns at most once per head` };
  ctx.journal.fact({
    kind: 'lanes-rerun', unit: unit.id, command: id, attempt: body.attempt, lane: body.lane, at, cause: body.cause, evidence: body.evidence,
    by: { role: 'root', routingRev: ctx.routing(null).resolved.rev },
  });
  crashPoint('rerun.after-fact');
  return { kind: 'applied', verified: [verifiedText(ref, at)] };
}

const verifiedText = (ref: string, at: string): string => `${ref} waived: the unit runs its lanes again at ${at}, in a fresh checkout, no build`;
