// The flow track (plan "Triggers and the job", "Verdicts", "Stations and the flow series"): what the scheduler runs for
// the flow loop on every arc whose revisions carry the `m4b` role set (an arc 1.0.0-dev.7 started has the loop off,
// `off-dev7`, with one logged warning). Each run of the track, in this order:
//   1. `ruler-changed`: every revision after the first admission (the first `dispatch`) whose source is `command` and
//      whose ruler (src/flow/levers.ts `rulerChanges`, against the revision before it) changed raises one non-blocking
//      item, parented by the command. A revision that changed the vision record is the owner's vision apply and is not
//      flagged; bundles, the executor's and flow's revisions are not `command`s.
//   2. With the arc neither paused nor stopping: the accepted proposal `pending-apply` is applied (src/flow/apply.ts),
//      then the one `pending-proof` is proved (src/flow/proof.ts, a fresh `proof-<n>` job);
//   3. the verdicts due (`writeVerdicts`): one `flow-verdict` per applied proposal whose window closed, and a `worse`
//      verdict's non-blocking `flow-worse` item (parented by the proposal's run, once);
//   4. the flow job (src/flow/job.ts): the run started and not ended resumes; else, while units remain to flow and no
//      holistic job runs (one judgment job at a time; the holistic jobs come first), a run starts when triggers are due.
// Right before each `arc-completed` (`beforeCompletion`): the verdicts the completion closes, then the compact series
// kept as `inputs/<sha>.flow-series.json` with `flow-series{sha256, highWater}`, skipped when the latest series is the
// last work the log records (a crash between the two: crash point `flow.series-before-completed`).
//
// A verdict window's samples and close (src/flow/verdict.ts): opened at the proposal's `flow-applied`; idle time is the
// ARC-scope drains (an applied command revision that `drainsArc`, from its submission to its `plan-applied`); the
// obligation guard reads an obligation as no longer held when a P1 finding over it opened inside the window.
import type { Event, PlanAppliedFact } from '../core/events.ts';
import { crashPoint } from '../core/crash.ts';
import { type CommandId, type ObligationId, type ProposalId, proposalJob } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type IsoTime, isoTimeOf } from '../core/values.ts';
import { submittedAtMs } from '../commands/queue.ts';
import { dev7ArcRolesDefault } from '../core/upgrade.ts';
import type { CheckpointContext } from '../holistic/bundle.ts';
import { workRemains } from '../holistic/cadence.ts';
import { drainsArc } from '../input/classify.ts';
import { FLOW_SERIES_INPUT, arcRolesOf, keepInput } from '../input/inforce.ts';
import { raiseNeedsUser, raisedWithReason } from '../needsuser.ts';
import { applyPendingFlow, flowApplyHolds } from './apply.ts';
import { flowSkipped, proposalLine, runFlowJob } from './job.ts';
import { type FlowNow, flowLogNow, flowNow, windowNow } from './live.ts';
import { metricOf, rulerChanges } from './levers.ts';
import { type FlowLog, phaseOf, proposalOf, proposalsOf, runningRun } from './log.ts';
import { runProof } from './proof.ts';
import type { SeriesInputs } from './series.ts';
import { dueTriggers } from './trigger.ts';
import type { FlowProposal } from './types.ts';
import { type IdleSpan, afterOf, beforeOf, closeWindow, guardBreaches, verdictOf, windowSamples } from './verdict.ts';

export type FlowTrackContext = CheckpointContext;

const now = (): IsoTime => isoTimeOf(new Date());

/**
 * Whether the flow loop is on for the arc: its revisions carry the `m4b` role set. Off (`off-dev7`, an arc 1.0.0-dev.7
 * started) logs its warning once per process (src/core/upgrade.ts).
 */
export function flowOn(view: JournalView): boolean {
  if (arcRolesOf(view.planApplied()) === 'm4b') return true;
  dev7ArcRolesDefault();
  return false;
}

// ---------------------------------------------------------------------------------------------------
// The ruler

/** A command revision after the first admission that changed the ruler: its command, revision and the ruler paths. */
export type RulerChange = Readonly<{ command: CommandId; rev: number; seq: number; at: IsoTime; paths: readonly string[] }>;

/** Every ruler change of `events` (see the header), in log order. Pure over the log and the kept plan bytes. */
export function rulerChangesOf(events: readonly Event[], inputs: SeriesInputs): readonly RulerChange[] {
  const out: RulerChange[] = [];
  let admitted = false;
  let prev: PlanAppliedFact | null = null;
  const view = (f: PlanAppliedFact) => ({ plan: inputs.planOf(f), obligationsSha256: f.obligationsSha256 ?? null, visionSha256: f.visionSha256 ?? null });
  for (const e of events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'dispatch') admitted = true;
    if (f.kind !== 'plan-applied') continue;
    if (admitted && prev !== null && f.source.type === 'command') {
      const paths = rulerChanges(view(prev), view(f));
      if (paths.length > 0 && !paths.includes('vision')) out.push({ command: f.source.command, rev: f.rev, seq: e.seq, at: e.at, paths });
    }
    prev = f;
  }
  return out;
}

function raiseRulerChanges(ctx: FlowTrackContext, flow: FlowNow): void {
  for (const c of rulerChangesOf(flow.events, flow.inputs)) {
    const parent = { type: 'command', command: c.command } as const;
    if (raisedWithReason(ctx.journal.view, ctx.runDir, parent, 'ruler-changed') !== null) continue;
    raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: false, subject: { type: 'arc' }, reason: 'ruler-changed',
      summary: `Plan revision ${c.rev} (command ${c.command}), applied after the first admission, changed the ruler: ${c.paths.join(', ')}. What the arc is measured by moved; the flow verdicts and obligations read the new ruler from here.`,
      recommendation: 'Confirm the change was meant (a measurement is never edited to make a number move), or revert it with `roadmap apply`; then acknowledge this item.',
      options: [], evidence: [],
    }, parent);
  }
}

// ---------------------------------------------------------------------------------------------------
// Verdicts

/** The ARC-scope drains of `events`: idle time no verdict window counts. */
function drainSpans(events: readonly Event[]): readonly IdleSpan[] {
  return events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'plan-applied' && e.fact.source.type === 'command' && e.fact.changes.some(drainsArc)
    ? [{ from: isoTimeOf(new Date(Math.min(submittedAtMs(e.fact.source.command), Date.parse(e.at)))), to: e.at }] : []));
}

/** The obligations a P1 finding opened over in (from, to]: no longer held (the obligation guard). */
function unheldIn(events: readonly Event[], from: number, to: number): readonly ObligationId[] {
  const out = new Set<ObligationId>();
  for (const e of events) {
    if (e.type !== 'fact' || e.fact.kind !== 'finding-opened' || e.fact.severity !== 'P1' || e.fact.obligation === null) continue;
    const at = Date.parse(e.at);
    if (at > from && at <= to) out.add(e.fact.obligation);
  }
  return [...out].sort();
}

const worseParent = (p: ProposalId) => ({ type: 'job', job: proposalJob(p) }) as const;

function raiseWorse(ctx: FlowTrackContext, p: FlowProposal, detail: string): void {
  if (raisedWithReason(ctx.journal.view, ctx.runDir, worseParent(p.id), 'flow-worse') !== null) return;
  raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking: false, subject: { type: 'arc' }, reason: 'flow-worse',
    summary: `Flow proposal ${proposalLine(p)} made the flow worse: ${detail}. Its (station, lever, target) is remembered; no flow run proposes it again.`,
    recommendation: `Revert it with \`roadmap apply\`: the flow-verdict fact of ${p.id} carries the preimage (the plan values it replaced). Then acknowledge this item.`,
    options: [], evidence: [],
  }, worseParent(p.id));
}

/**
 * Writes the verdict of every applied proposal whose window closed by `at` (`completing`: the arc completes at `at`,
 * closing every open window), and raises each `worse` verdict's item once.
 */
export function writeVerdicts(ctx: FlowTrackContext, flow: FlowNow, at: IsoTime, completing: boolean): void {
  const { log, series, events } = flow;
  const idle = drainSpans(events);
  for (const [id, applied] of log.applied) {
    const p = proposalOf(log, id);
    const done = log.verdicts.get(id);
    if (done !== undefined) {
      if (done.verdict === 'worse') raiseWorse(ctx, p, done.guards.length > 0 ? done.guards.map((g) => `${g.guard}: ${g.detail}`).join('; ') : 'its metric rose');
      continue;
    }
    const metric = metricOf(p.action, p.target);
    if (metric === null) throw new Error(`flow: ${id} was applied but is host advice`);
    const w = windowSamples(metric, applied.at, series);
    const completedAt = completing ? at : log.completions.findLast((c) => c.at >= applied.at)?.at ?? null;
    const close = closeWindow(applied.at, at, w.after, idle, completedAt);
    if (close === null) continue;
    const after = afterOf(w.after, close);
    const before = beforeOf(metric, w.before);
    const afterPoints = w.afterPoints.filter((x) => Date.parse(x.mergedAt) <= close.at);
    const guards = guardBreaches({ metric, beforePoints: w.beforePoints, afterPoints, leadUcl: flow.limits?.ucl ?? null, unheld: unheldIn(events, Date.parse(applied.at), close.at) });
    const verdict = verdictOf(metric, before, after, guards);
    ctx.journal.fact({ kind: 'flow-verdict', proposal: id, metric, before, after, guards, verdict, preimage: applied.preimage });
    if (verdict === 'worse') raiseWorse(ctx, p, guards.length > 0 ? guards.map((g) => `${g.guard}: ${g.detail}`).join('; ') : 'its metric rose');
  }
}

// ---------------------------------------------------------------------------------------------------
// The series at completion

/** The verdicts the completion closes, then the compact series (see the header). Nothing for an arc with the loop off. */
export function beforeCompletion(ctx: FlowTrackContext): void {
  const view = ctx.journal.view;
  if (!flowOn(view)) return;
  writeVerdicts(ctx, flowNow(ctx, now()), now(), true);
  const flow = flowNow(ctx, now());
  if (flow.log.series.at(-1)?.seq === view.lastWorkSeq()) return;
  const sha256 = keepInput(ctx.runDir, Buffer.from(canonicalJson(flow.series), 'utf8'), FLOW_SERIES_INPUT);
  ctx.journal.fact({ kind: 'flow-series', sha256, highWater: view.highWater() });
  crashPoint('flow.series-before-completed');
}

// ---------------------------------------------------------------------------------------------------
// The track

/** The accepted proposal `pending-apply`, the one `pending-proof`: what the track hands B2's apply and proof. */
const inPhase = (log: FlowLog, phase: 'pending-apply' | 'pending-proof'): FlowProposal | null =>
  proposalsOf(log).find((p) => phaseOf(log, p.id).type === phase) ?? null;

/** Whether new candidate starts wait for an accepted proposal's revision (`flow-apply`). Off-dev7: never. */
export function flowApplyHeld(ctx: Pick<FlowTrackContext, 'runDir' | 'repo' | 'journal'>): boolean {
  if (!flowOn(ctx.journal.view)) return false;
  return inPhase(flowLogNow(ctx), 'pending-apply') !== null && flowApplyHolds(ctx.journal.view);
}

export type FlowTrackInput = Readonly<{
  /** Whether a holistic job runs now: the flow job neither starts nor resumes meanwhile. */
  holisticRunning: () => boolean;
  /** Told while the flow job (the judgment) runs, so no holistic job starts meanwhile. */
  judging: (on: boolean) => void;
}>;

/** One run of the track (see the header); whether it wrote anything (progress) or found nothing to do. */
export async function runFlowTrack(ctx: FlowTrackContext, input: FlowTrackInput): Promise<'progress' | 'wait'> {
  const view = ctx.journal.view;
  const before = view.highWater();
  raiseRulerChanges(ctx, flowNow(ctx, now()));
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return view.highWater() === before ? 'wait' : 'progress';
  if (inPhase(flowLogNow(ctx), 'pending-apply') !== null) await applyPendingFlow(ctx);
  const proving = inPhase(flowLogNow(ctx), 'pending-proof');
  if (proving !== null) await runProof(ctx, proving, view.nextJobId('proof'));
  writeVerdicts(ctx, flowNow(ctx, now()), now(), false);
  const flow = flowNow(ctx, now());
  const running = runningRun(flow.log) !== null;
  if (!input.holisticRunning() && flowSkipped(ctx) === null && (running || workRemains(ctx))) {
    const triggers = running ? [] : dueTriggers({ log: flow.log, points: flow.series.points, limits: flow.limits, inFlight: flow.inFlight, window: windowNow(flow), now: now() });
    if (running || triggers.length > 0) {
      input.judging(true);
      try {
        await runFlowJob(ctx, triggers);
      } finally {
        input.judging(false);
      }
    }
  }
  return view.highWater() === before ? 'wait' : 'progress';
}
