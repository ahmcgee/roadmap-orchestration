// The flow loop's state as the log records it (plan "Decisions", "Verdicts"; SCHEMAS.md "M4b"), a pure fold over one arc's
// events: the flow runs (started, ended), the requests, the decisions, the proofs, the applies, the verdicts, the kept
// series and the arc's completions. The journal's fold sees only the jobs the flow facts name, so everything the flow
// track, the triggers, status and the brief read of the loop is derived here, from the events alone.
//
// A proposal's phase: `undecided` until a `flow-decided`; `rejected`; an accepted `host` proposal is `advice` (never
// applied); an accepted suite-lane argv change is `pending-proof` until a proof is `preserved` (then `pending-apply`),
// `refused` by a `changed` or `unprovable` proof or a second `red`; any other accepted proposal is `pending-apply`; a
// `flow-applied` makes it `applied`. The one open window arc-wide (plan "Triggers and the job") is the earliest accepted
// appliable proposal with no verdict that is not refused: its window opened at its `flow-applied`, or, accepted and not yet
// applied, it counts as open from its decision with no samples (the checks and the triggers treat it as one).
import type { Event, FlowFact } from '../core/events.ts';
import type { CommandId, JobId, ProposalId, Sha256Hex } from '../core/ids.ts';
import type { IsoTime } from '../core/values.ts';
import { metricOf, rejectionKeyOf } from './levers.ts';
import type { ClosedVerdict, FlowMetric, FlowProposal, FlowWindow, Rejection } from './types.ts';

type Stamped<K extends FlowFact['kind']> = Extract<FlowFact, { kind: K }> & Readonly<{ at: IsoTime; seq: number }>;

export type FlowRun = Readonly<{ started: Stamped<'flow-started'>; ended: Stamped<'flow-ended'> | null }>;

export type FlowLog = Readonly<{
  runs: readonly FlowRun[];
  requests: readonly Stamped<'flow-requested'>[];
  decisions: ReadonlyMap<ProposalId, Stamped<'flow-decided'>>;
  proofs: ReadonlyMap<ProposalId, readonly Stamped<'flow-proof'>[]>;
  applied: ReadonlyMap<ProposalId, Stamped<'flow-applied'>>;
  verdicts: ReadonlyMap<ProposalId, Stamped<'flow-verdict'>>;
  series: readonly Stamped<'flow-series'>[];
  /** Every `arc-completed`, in log order. */
  completions: readonly Readonly<{ at: IsoTime; seq: number; highWater: number }>[];
  /** The surviving proposals of the ended runs, by id. */
  proposals: ReadonlyMap<ProposalId, FlowProposal>;
}>;

/** The flow facts of `events`, folded. */
export function flowLog(events: readonly Event[]): FlowLog {
  const runs: { started: Stamped<'flow-started'>; ended: Stamped<'flow-ended'> | null }[] = [];
  const requests: Stamped<'flow-requested'>[] = [];
  const decisions = new Map<ProposalId, Stamped<'flow-decided'>>();
  const proofs = new Map<ProposalId, Stamped<'flow-proof'>[]>();
  const applied = new Map<ProposalId, Stamped<'flow-applied'>>();
  const verdicts = new Map<ProposalId, Stamped<'flow-verdict'>>();
  const series: Stamped<'flow-series'>[] = [];
  const completions: { at: IsoTime; seq: number; highWater: number }[] = [];
  const proposals = new Map<ProposalId, FlowProposal>();
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    const stamp = { at: e.at, seq: e.seq };
    switch (f.kind) {
      case 'flow-started':
        runs.push({ started: { ...f, ...stamp }, ended: null });
        break;
      case 'flow-ended': {
        const run = runs.find((r) => r.started.job === f.job);
        if (run === undefined || run.ended !== null) throw new Error(`flow log: flow-ended of ${f.job}, which is not running`);
        run.ended = { ...f, ...stamp };
        if (f.proposal !== null) proposals.set(f.proposal.id, f.proposal);
        break;
      }
      case 'flow-requested':
        requests.push({ ...f, ...stamp });
        break;
      case 'flow-decided':
        if (!decisions.has(f.proposal)) decisions.set(f.proposal, { ...f, ...stamp });
        break;
      case 'flow-proof':
        proofs.set(f.proposal, [...(proofs.get(f.proposal) ?? []), { ...f, ...stamp }]);
        break;
      case 'flow-applied':
        if (applied.has(f.proposal)) throw new Error(`flow log: a second flow-applied of ${f.proposal}`);
        applied.set(f.proposal, { ...f, ...stamp });
        break;
      case 'flow-verdict':
        if (verdicts.has(f.proposal)) throw new Error(`flow log: a second flow-verdict of ${f.proposal}`);
        verdicts.set(f.proposal, { ...f, ...stamp });
        break;
      case 'flow-series':
        series.push({ ...f, ...stamp });
        break;
      case 'arc-completed':
        completions.push({ ...stamp, highWater: f.highWater });
        break;
      default:
        break;
    }
  }
  return { runs, requests, decisions, proofs, applied, verdicts, series, completions, proposals };
}

/** The run started and not ended (at most one: a run ends before the next starts), or null. */
export const runningRun = (log: FlowLog): FlowRun | null => log.runs.find((r) => r.ended === null) ?? null;

/** A proposal the log holds (a surviving one of a `done` run); one it does not fails loud. */
export function proposalOf(log: FlowLog, id: ProposalId): FlowProposal {
  const p = log.proposals.get(id);
  if (p === undefined) throw new Error(`flow log: no run proposed ${id}`);
  return p;
}

/** How many `red` proofs refuse an accepted argv change (a red reruns once). */
export const RED_PROOFS_REFUSE = 2;

export type ProposalPhase =
  | Readonly<{ type: 'undecided' }>
  | Readonly<{ type: 'rejected' }>
  | Readonly<{ type: 'advice' }>
  | Readonly<{ type: 'pending-proof' }>
  | Readonly<{ type: 'pending-apply' }>
  | Readonly<{ type: 'applied' }>
  | Readonly<{ type: 'refused'; reason: 'changed' | 'unprovable' | 'red' }>;

/** Whether an accepted proposal needs a proof first: a suite-lane argv change (RC-4). */
export const needsProof = (p: FlowProposal): boolean => p.action.lever === 'suite-lane' && p.action.argv !== undefined;

/** The phase of proposal `id` (see the header). */
export function phaseOf(log: FlowLog, id: ProposalId): ProposalPhase {
  const decision = log.decisions.get(id);
  if (decision === undefined) return { type: 'undecided' };
  if (decision.decision === 'rejected') return { type: 'rejected' };
  const p = proposalOf(log, id);
  if (p.action.lever === 'host') return { type: 'advice' };
  if (log.applied.has(id)) return { type: 'applied' };
  if (!needsProof(p)) return { type: 'pending-apply' };
  const proofs = log.proofs.get(id) ?? [];
  const final = proofs.find((x) => x.outcome === 'preserved' || x.outcome === 'changed' || x.outcome === 'unprovable');
  if (final?.outcome === 'preserved') return { type: 'pending-apply' };
  if (final?.outcome === 'changed' || final?.outcome === 'unprovable') return { type: 'refused', reason: final.outcome };
  return proofs.filter((x) => x.outcome === 'red').length >= RED_PROOFS_REFUSE ? { type: 'refused', reason: 'red' } : { type: 'pending-proof' };
}

/** Every proposal the log holds, in id order of its run. */
export const proposalsOf = (log: FlowLog): readonly FlowProposal[] => log.runs.flatMap((r) => (r.ended?.proposal === null || r.ended === null ? [] : [r.ended.proposal]));

/** The verdict metric of a proposal (G7); null for host advice. */
export const proposalMetric = (p: FlowProposal): FlowMetric | null => metricOf(p.action, p.target);

/**
 * The open window (see the header), with the samples taken so far (`samplesSince(metric, openedAt)`), or null. An
 * accepted proposal not applied yet opens at its decision with 0 samples.
 */
export function openWindow(log: FlowLog, samplesSince: (metric: FlowMetric, openedAt: IsoTime) => number): FlowWindow | null {
  for (const p of proposalsOf(log)) {
    const phase = phaseOf(log, p.id).type;
    if (log.verdicts.has(p.id) || (phase !== 'pending-proof' && phase !== 'pending-apply' && phase !== 'applied')) continue;
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

/** The rejection memory (RC-9): rejected proposals, `worse` verdicts, `changed` and `unprovable` proofs; never a red proof. */
export function rejectionsOf(log: FlowLog): readonly Rejection[] {
  const out: Readonly<Rejection & { seq: number }>[] = [];
  for (const d of log.decisions.values()) if (d.decision === 'rejected') out.push({ key: rejectionKeyOf(proposalOf(log, d.proposal)), proposal: d.proposal, cause: 'rejected', seq: d.seq });
  for (const v of log.verdicts.values()) if (v.verdict === 'worse') out.push({ key: rejectionKeyOf(proposalOf(log, v.proposal)), proposal: v.proposal, cause: 'worse', seq: v.seq });
  for (const [id, proofs] of log.proofs) {
    const x = proofs.find((p) => p.outcome === 'changed' || p.outcome === 'unprovable');
    if (x !== undefined) out.push({ key: rejectionKeyOf(proposalOf(log, id)), proposal: id, cause: x.outcome as 'changed' | 'unprovable', seq: x.seq });
  }
  return out.sort((a, b) => a.seq - b.seq).map(({ seq: _s, ...r }) => r);
}

/** The latest `flow-series` covering `highWater`, or null. */
export const seriesCovering = (log: FlowLog, highWater: number): Readonly<{ sha256: Sha256Hex; highWater: number }> | null =>
  log.series.findLast((s) => s.highWater >= highWater) ?? null;

/** The requests a run started after `since` (null: every request) has not seen: by command. */
export const requestsAfter = (log: FlowLog, since: IsoTime | null): readonly Readonly<{ command: CommandId; reason: string }>[] =>
  log.requests.filter((r) => since === null || r.at > since);

/** The job a run of the log names: its started run, or null. */
export const runOf = (log: FlowLog, job: JobId): FlowRun | null => log.runs.find((r) => r.started.job === job) ?? null;
