// `roadmap flow …` (M4b, plan "Decisions"; SCHEMAS.md "M4b").
//
//   flow accept|reject <proposal> --reason <text>   the root agent's decision on a flow proposal: a `flow-decide` command
//                                                   (scope ∅). The CLI refuses an unknown proposal (never proposed, or
//                                                   dropped by code's checks) and one already decided the other way;
//                                                   the effect checks the same again on the log as it is then. Its
//                                                   effect journals `flow-decided` once per proposal (a second decide the
//                                                   same way is a no-op: idempotent by proposal id) and acknowledges the
//                                                   proposal's `flow-proposal` (or `flow-host`) item (raised under its flow run's job). A rejection adds the
//                                                   proposal's RC-9 key to the rejection memory (src/flow/apply.ts `rejectionMemory`); an
//                                                   accepted appliable proposal then moves through its phases
//                                                   (src/flow/apply.ts).
//   flow request --reason <text>                    a `flow-request` command (scope ∅): `flow-requested`, which the
//                                                   triggers read (RC-5: it bypasses the cooldown once per window).
//   flow given --repo <path> --lever <l> --note <t> a host act: a write-once host given under this host's fingerprint
//                                                   (src/flow/givens.ts), or the equal one already there.
//
// Each effect checks its postcondition first, so a re-run after a crash (recovery's `finish`) writes nothing twice.
import { existsSync } from 'node:fs';
import { type ArcId, type CommandId, type NeedsUserId, type ProposalId, proposalJob } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { JournalView } from '../core/interfaces.ts';
import { readJournal } from '../core/log.ts';
import type { CommandBody } from '../core/records.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { locate } from '../cli/locate.ts';
import { acceptedProposals, decisionOf, proposalOf } from '../flow/apply.ts';
import { declareHostGiven } from '../flow/givens.ts';
import { rejectionKeyOf, rejectionKeyText } from '../flow/levers.ts';
import type { FlowLever, HostGiven } from '../flow/types.ts';
import { readHostFingerprint } from '../host/sample.ts';
import type { RunLocator } from '../input/cli.ts';
import { readNeedsUser } from '../needsuser.ts';
import { gitCommonDir } from '../preflight/checks.ts';
import { type CommandContext, type Effect, acknowledge } from './apply.ts';
import { submitCommand } from './queue.ts';

export type FlowArgs =
  | Readonly<{ type: 'decide'; proposal: ProposalId; decision: 'accept' | 'reject'; reason: string; run: RunLocator }>
  | Readonly<{ type: 'request'; reason: string; run: RunLocator }>
  | Readonly<{ type: 'given'; repo: AbsPath; lever: FlowLever; note: string }>;

/** `submitted`: the queued command; `given`: the host given written (or the equal one already there); `refused`: exit 78. */
export type FlowCommandOutcome =
  | Readonly<{ kind: 'submitted'; command: CommandId; arc: ArcId }>
  | Readonly<{ kind: 'given'; given: HostGiven }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export async function flowCommand(args: FlowArgs, hostDir: AbsPath): Promise<FlowCommandOutcome> {
  switch (args.type) {
    case 'decide': {
      const run = locate(args.run, hostDir);
      if (!existsSync(run.runDir)) return { kind: 'refused', reason: `run dir ${run.runDir} does not exist; has arc ${run.arc} been started on this repo?` };
      const problem = decideProblem(readJournal(run.runDir, run.arc).view, args.proposal, args.decision);
      if (problem !== null) return { kind: 'refused', reason: problem };
      const file = submitCommand(run.runDir, run.arc, { type: 'flow-decide', proposal: args.proposal, decision: args.decision, reason: args.reason });
      return { kind: 'submitted', command: file.id, arc: run.arc };
    }
    case 'request': {
      const run = locate(args.run, hostDir);
      const file = submitCommand(run.runDir, run.arc, { type: 'flow-request', reason: args.reason });
      return { kind: 'submitted', command: file.id, arc: run.arc };
    }
    case 'given':
      return { kind: 'given', given: declareHostGiven(gitCommonDir(args.repo), args.lever, args.note, readHostFingerprint(), isoTimeOf(new Date())) };
  }
}

const DECIDED = { accept: 'accepted', reject: 'rejected' } as const;

/** Why `decision` on `id` is refused, or null: an unknown or dropped proposal, or one decided the other way. */
function decideProblem(view: JournalView, id: ProposalId, decision: 'accept' | 'reject'): string | null {
  if (proposalOf(view, id) === null) {
    const dropped = view.flowFacts().find((x) => x.fact.kind === 'flow-ended' && x.fact.dropped?.proposal.id === id);
    return dropped !== undefined && dropped.fact.kind === 'flow-ended' && dropped.fact.dropped !== null
      ? `flow ${decision} ${id}: code's checks dropped it (${dropped.fact.dropped.reason}: ${dropped.fact.dropped.detail}); there is nothing to decide`
      : `flow ${decision} ${id}: no flow run of arc ${view.arc} proposed it`;
  }
  const done = decisionOf(view, id);
  if (done !== null && done.decision !== DECIDED[decision]) return `flow ${decision} ${id}: it is already ${done.decision} (by ${done.command}: ${done.reason})`;
  return null;
}

type FlowCommandContext = Pick<CommandContext, 'journal' | 'runDir'>;

/** `flow-decide`'s effect: `flow-decided` once per proposal, then the proposal's item acknowledged. */
export function decideFlow(ctx: FlowCommandContext, id: CommandId, body: Extract<CommandBody, { type: 'flow-decide' }>): Effect {
  const view = ctx.journal.view;
  const problem = decideProblem(view, body.proposal, body.decision);
  if (problem !== null) return { kind: 'rejected', reason: problem };
  const verified: string[] = [];
  const done = decisionOf(view, body.proposal);
  if (done === null) {
    ctx.journal.fact({ kind: 'flow-decided', proposal: body.proposal, command: id, decision: DECIDED[body.decision], reason: body.reason });
    verified.push(`${body.proposal} ${DECIDED[body.decision]} by ${id}`);
  } else {
    verified.push(`${body.proposal} was ${done.decision} by ${done.command} already`);
  }
  for (const item of proposalItems(ctx, body.proposal)) verified.push(...acknowledge(ctx, id, item, null));
  const proposal = proposalOf(view, body.proposal)!;
  if (body.decision === 'reject') verified.push(`rejection key ${rejectionKeyText(rejectionKeyOf(proposal))} remembered`);
  else {
    const phase = acceptedProposals(ctx.journal.view).find((a) => a.proposal.id === body.proposal)?.phase.phase;
    verified.push(`${body.proposal} is ${phase}`);
  }
  return { kind: 'applied', verified };
}

/** The proposal's open `flow-proposal` or `flow-host` item: raised once per proposal id by its flow run (parent `job{flow-n}`). */
function proposalItems(ctx: FlowCommandContext, proposal: ProposalId): readonly NeedsUserId[] {
  const view = ctx.journal.view;
  const parent = canonicalJson({ type: 'job', job: proposalJob(proposal) });
  return view.opsOf('needsuser.raise').flatMap((i) => {
    if (canonicalJson(i.parent) !== parent || view.doneOf(i.op) === null || view.ackOf(i.expect.id) !== null) return [];
    const item = readNeedsUser(ctx.runDir, i.expect.id);
    return item !== null && (item.reason === 'flow-proposal' || item.reason === 'flow-host') ? [i.expect.id] : [];
  });
}

/** `flow-request`'s effect: `flow-requested` once per command. */
export function requestFlow(ctx: FlowCommandContext, id: CommandId, reason: string): Effect {
  const seen = ctx.journal.view.flowFacts().some((x) => x.fact.kind === 'flow-requested' && x.fact.command === id);
  if (!seen) ctx.journal.fact({ kind: 'flow-requested', command: id, reason });
  return { kind: 'applied', verified: [`flow run requested by ${id}: it bypasses the cooldown once per cooldown window`] };
}
