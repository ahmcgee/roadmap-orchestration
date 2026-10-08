// The flow loop's state as the log records it (plan "Triggers and the job", "Verdicts"; SCHEMAS.md "M4b"), read from the
// fold's flow facts (`JournalView.flowFacts`) and the accepted proposals' phases (src/flow/apply.ts
// `acceptedProposals`): the flow runs (started, ended), the requests, the decisions, the applies, the verdicts, the kept
// series, the arc's completions and the surviving proposals. The flow track, the triggers, status and the brief read the
// loop through it.
//
// The one open window arc-wide (plan "Triggers and the job") is the earliest accepted appliable proposal (pending its
// proof or apply, or applied) with no verdict: its window opened at its `flow-applied`, or, accepted and not applied yet,
// it counts as open from its decision with no samples (the checks and the triggers treat it as one).
import type { Event, FlowFact } from '../core/events.ts';
import type { ProposalId } from '../core/ids.ts';
import type { FlowFactAt, JournalView } from '../core/interfaces.ts';
import type { IsoTime } from '../core/values.ts';
import { type AcceptedProposal, acceptedProposals } from './apply.ts';
import { metricOf } from './levers.ts';
import type { ClosedVerdict, FlowMetric, FlowProposal, FlowWindow } from './types.ts';

type Stamped<K extends FlowFact['kind']> = Extract<FlowFact, { kind: K }> & Readonly<{ at: IsoTime; seq: number }>;

export type FlowRun = Readonly<{ started: Stamped<'flow-started'>; ended: Stamped<'flow-ended'> | null }>;

export type FlowLog = Readonly<{
  runs: readonly FlowRun[];
  requests: readonly Stamped<'flow-requested'>[];
  decisions: ReadonlyMap<ProposalId, Stamped<'flow-decided'>>;
  applied: ReadonlyMap<ProposalId, Stamped<'flow-applied'>>;
  verdicts: ReadonlyMap<ProposalId, Stamped<'flow-verdict'>>;
  series: readonly Stamped<'flow-series'>[];
  /** Every `arc-completed`, in log order. */
  completions: readonly Readonly<{ at: IsoTime; seq: number }>[];
  /** The surviving proposals of the ended runs, by id. */
  proposals: ReadonlyMap<ProposalId, FlowProposal>;
  /** The accepted proposals with their phases, in decision order. */
  accepted: readonly AcceptedProposal[];
}>;

const stamped = <K extends FlowFact['kind']>(x: FlowFactAt, _kind: K): Stamped<K> => ({ ...(x.fact as Extract<FlowFact, { kind: K }>), at: x.at, seq: x.seq });

/** The flow facts of `view` folded; `events` (the same log) gives the completions. */
export function flowLog(view: JournalView, events: readonly Event[]): FlowLog {
  const runs: { started: Stamped<'flow-started'>; ended: Stamped<'flow-ended'> | null }[] = [];
  const requests: Stamped<'flow-requested'>[] = [];
  const decisions = new Map<ProposalId, Stamped<'flow-decided'>>();
  const applied = new Map<ProposalId, Stamped<'flow-applied'>>();
  const verdicts = new Map<ProposalId, Stamped<'flow-verdict'>>();
  const series: Stamped<'flow-series'>[] = [];
  const proposals = new Map<ProposalId, FlowProposal>();
  for (const x of view.flowFacts()) {
    const f = x.fact;
    switch (f.kind) {
      case 'flow-started':
        runs.push({ started: stamped(x, 'flow-started'), ended: null });
        break;
      case 'flow-ended': {
        const run = runs.find((r) => r.started.job === f.job);
        if (run === undefined || run.ended !== null) throw new Error(`flow log: flow-ended of ${f.job}, which is not running`);
        run.ended = stamped(x, 'flow-ended');
        if (f.proposal !== null) proposals.set(f.proposal.id, f.proposal);
        break;
      }
      case 'flow-requested':
        requests.push(stamped(x, 'flow-requested'));
        break;
      case 'flow-decided':
        decisions.set(f.proposal, stamped(x, 'flow-decided'));
        break;
      case 'flow-applied':
        applied.set(f.proposal, stamped(x, 'flow-applied'));
        break;
      case 'flow-verdict':
        if (verdicts.has(f.proposal)) throw new Error(`flow log: a second flow-verdict of ${f.proposal}`);
        verdicts.set(f.proposal, stamped(x, 'flow-verdict'));
        break;
      case 'flow-series':
        series.push(stamped(x, 'flow-series'));
        break;
      case 'flow-proof':
        break;
    }
  }
  const completions = events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'arc-completed' ? [{ at: e.at, seq: e.seq }] : []));
  return { runs, requests, decisions, applied, verdicts, series, completions, proposals, accepted: acceptedProposals(view) };
}

/** The run started and not ended (at most one: a run ends before the next starts), or null. */
export const runningRun = (log: FlowLog): FlowRun | null => log.runs.find((r) => r.ended === null) ?? null;

/** A proposal the log holds (a surviving one of a `done` run); one it does not fails loud. */
export function proposalOf(log: FlowLog, id: ProposalId): FlowProposal {
  const p = log.proposals.get(id);
  if (p === undefined) throw new Error(`flow log: no run proposed ${id}`);
  return p;
}

/** Every surviving proposal, in run order. */
export const proposalsOf = (log: FlowLog): readonly FlowProposal[] => [...log.proposals.values()];

/** The verdict metric of a proposal (G7); null for host advice. */
export const proposalMetric = (p: FlowProposal): FlowMetric | null => metricOf(p.action, p.target);

/**
 * The open window (see the header), with the samples taken so far (`samplesSince(metric, openedAt)`), or null. An
 * accepted proposal not applied yet opens at its decision with 0 samples.
 */
export function openWindow(log: FlowLog, samplesSince: (metric: FlowMetric, openedAt: IsoTime) => number): FlowWindow | null {
  for (const { proposal: p, phase } of log.accepted) {
    if (log.verdicts.has(p.id) || (phase.phase !== 'pending-proof' && phase.phase !== 'pending-apply' && phase.phase !== 'applied')) continue;
    const metric = proposalMetric(p);
    if (metric === null) throw new Error(`flow log: ${p.id} is appliable but has no metric`);
    const applied = log.applied.get(p.id);
    const openedAt = applied?.at ?? log.decisions.get(p.id)!.at;
    return { proposal: p.id, lever: p.action.lever, target: p.target, metric, openedAt, samples: applied === undefined ? 0 : samplesSince(metric, openedAt) };
  }
  return null;
}

/** This arc's closed verdicts, in log order. */
export const closedVerdicts = (log: FlowLog): readonly ClosedVerdict[] => [...log.verdicts.values()].sort((a, b) => a.seq - b.seq).map((v) => {
  const p = proposalOf(log, v.proposal);
  return { proposal: v.proposal, lever: p.action.lever, target: p.target, verdict: v.verdict };
});
