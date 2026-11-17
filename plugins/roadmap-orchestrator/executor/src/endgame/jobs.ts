// The endgame's jobs (dev.82, WS-5): what the scheduler's holistic slot runs for an opened episode, one at a time, each a
// durable job `endgame-<n>` (`endgame-job-started` … `endgame-job-ended`; a started job without its end resumes as the
// same job after a restart: a landing recovery abandoned lands again, a run runs again in a fresh checkout).
//
// - **Requests** (src/commands/endgame.ts), in log order, each served once: `land` (src/pipeline/integrate.ts `landEndgame`:
//   the endgame branch's head, a strict descendant of the integration tip, tested and published by ff); `review` (the
//   independent review now, src/endgame/review.ts); `run <lanes>` (the named suite or arc lanes as a journey series at the
//   endgame branch's head under the job's holder: observations are keyed by input, so a later landing of that head reuses
//   them). A checkpoint request is no job: it makes a walk round due (src/walk/milestones.ts).
// - **The closing step's review** (no command): while the step is `closing` and `reviewDue` (src/endgame/open.ts). While
//   the verifier's backend is parked none is started.
// - **Outcomes** (`endgame-job-ended`): a landing `landed`, `refused` (nothing to land, not a descendant, the tip moved, or
//   another mover moved integration: then a blocking `foreign-ref-move` item too), `red` (the lanes and obligations red
//   named; nothing moved) or `no-verdict`; a review `reviewed` or `no-verdict`; a run `ran` (each lane's verdict named).
import type { EndgameJobOutcome, EndgameJobRequest, EndgameRequest } from '../core/events.ts';
import type { CommandId, EnvId, JobId, LaneId, ObligationId, Sha } from '../core/ids.ts';
import type { EndgameEpisode } from '../core/state.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget } from '../git/git.ts';
import { repairedObligations } from '../holistic/findings.ts';
import type { ArcLaneDef } from '../holistic/types.ts';
import { raiseNeedsUser } from '../needsuser.ts';
import { jobSeat } from '../pipeline/dispatch.ts';
import { type LandingContext, type LandingOutcome, finishLanding, heldLanding, landEndgame } from '../pipeline/integrate.ts';
import { arcJourneyLane, jobSeriesCheckout, journeyRed, removeJobCheckouts, runJourneySeries, suiteJourneyLane } from '../pipeline/lanes.ts';
import { endDetail } from '../pipeline/publish.ts';
import { holisticInForce } from '../pipeline/stages.ts';
import { endgameBranch, endgameNow, reviewDue } from './open.ts';
import { openEpisode } from './phase.ts';
import { runEndgameReview } from './review.ts';

/** The endgame job due now: the running one (resumed), the first unserved request, or the closing step's review. */
export type EndgameJobDue = Readonly<{ job: JobId | null; command: CommandId | null; request: EndgameJobRequest; episode: EndgameEpisode }>;

const isJobRequest = (r: EndgameRequest): r is EndgameJobRequest => r.type !== 'checkpoint';

/** The endgame job due now (see the header), or null. */
export function endgameJobDue(ctx: LandingContext, laneEnv: (lane: ArcLaneDef) => EnvId | null): EndgameJobDue | null {
  const view = ctx.journal.view;
  const episode = openEpisode(view);
  if (episode === null || episode.opened === null) return null;
  const running = episode.jobs.find((j) => j.ended === null);
  if (running !== undefined) return { job: running.started.job, command: running.started.command, request: running.started.request, episode };
  const served = new Set(episode.jobs.flatMap((j) => (j.started.command === null ? [] : [j.started.command])));
  const pending = episode.requests.find((q) => isJobRequest(q.request) && !served.has(q.command));
  if (pending !== undefined && isJobRequest(pending.request)) return { job: null, command: pending.command, request: pending.request, episode };
  const now = endgameNow(ctx, laneEnv);
  if (now.phase.kind !== 'endgame' || now.phase.step !== 'closing' || !reviewDue(ctx, episode)) return null;
  if (view.parkedBackends().includes(jobSeat(ctx, 'verifier').triple.backend)) return null;
  return { job: null, command: null, request: { type: 'review' }, episode };
}

/** The obligations in force the episode's fixes not held by `tip` close (an `I-n`, or a finding's obligation): a landing's repairs. */
function landingRepairs(ctx: LandingContext, episode: EndgameEpisode, tip: Sha): ReadonlySet<ObligationId> {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return new Set();
  const inForce = new Set(obligations.obligations.map((o) => o.id));
  const refs = episode.fixes.filter((f) => !isAncestor(ctx.repo, f.commit, tip)).flatMap((f) => f.closes.filter((r) => r.startsWith('F-') || r.startsWith('I-')));
  return new Set([...repairedObligations(ctx.journal.view.holistic().findings, refs as never)].filter((o) => inForce.has(o)));
}

const landingDetail = (o: Exclude<LandingOutcome, Readonly<{ kind: 'landed' | 'foreign-move' }>>): string => {
  switch (o.kind) {
    case 'refused':
      return o.detail;
    case 'red':
      return `red${o.baseRed ? ' on the integration tip alone too' : ''}: ${[...o.lanes.map((l) => `lane ${l}`), ...o.obligations.map((id) => `obligation ${id} not held`)].join(', ') || 'the checkout changed under the lanes'}; nothing moved`;
    case 'no-verdict':
      return `a lane gave no verdict (${endDetail(o.end)}); nothing moved`;
  }
};

export type EndgameJobRun = Readonly<{ kind: 'ended' }> | Readonly<{ kind: 'no-verdict'; job: JobId; detail: string }>;

/** Runs `due` to its end (see the header). */
export async function runEndgameJob(ctx: LandingContext, due: EndgameJobDue): Promise<EndgameJobRun> {
  const view = ctx.journal.view;
  let job = due.job;
  if (job === null) {
    job = view.nextJobId('endgame');
    ctx.journal.fact({ kind: 'endgame-job-started', job, command: due.command, request: due.request });
  }
  const end = (outcome: EndgameJobOutcome, detail: string): EndgameJobRun => {
    endFact(ctx, job, outcome, detail);
    return outcome === 'no-verdict' ? { kind: 'no-verdict', job, detail } : { kind: 'ended' };
  };
  const head = (): Sha => {
    const at = refTarget(ctx.repo, endgameBranch(ctx.plan().arc));
    if (at === null) throw new Error(`${job}: ${endgameBranch(ctx.plan().arc)} does not exist`);
    return at;
  };
  // A job a restart cut short after its landing or review was recorded only ends; a landing still holding the slot (its
  // snapshot or release cut short) is finished first.
  const episode = openEpisode(view);
  const landed = episode?.landings.find((l) => l.job === job);
  if (landed !== undefined) {
    if (heldLanding(view)?.job === job) await finishLanding(ctx, job);
    return end('landed', `landed ${landed.old}..${landed.head}`);
  }
  const reviewed = episode?.reviews.find((r) => r.job === job);
  if (reviewed !== undefined) return end('reviewed', `reviewed; findings ${reviewed.findings.join(', ') || 'none'}`);
  switch (due.request.type) {
    case 'land': {
      const out = await landEndgame(ctx, job, head(), (tip) => landingRepairs(ctx, due.episode, tip));
      switch (out.kind) {
        case 'landed':
          return end('landed', `landed ${out.old}..${out.head}`);
        case 'foreign-move':
          raiseNeedsUser(ctx.journal, ctx.runDir, out.needsUser, { type: 'job', job });
          return end('refused', out.needsUser.summary);
        case 'refused':
          return end('refused', landingDetail(out));
        case 'red':
          return end('red', landingDetail(out));
        case 'no-verdict':
          return end('no-verdict', landingDetail(out));
      }
    }
    case 'review': {
      const out = await runEndgameReview(ctx, job, due.episode);
      return out.kind === 'reviewed' ? end('reviewed', `reviewed; findings ${out.findings.join(', ') || 'none'}`) : end('no-verdict', out.detail);
    }
    case 'run': {
      const at = head();
      const plan = ctx.plan();
      const { obligations } = holisticInForce(ctx);
      const lane = (id: LaneId) => {
        const suite = plan.suite.lanes.find((l) => l.id === id);
        if (suite !== undefined) return suiteJourneyLane(suite);
        const arc = obligations?.lanes.find((l) => l.id === id);
        if (arc === undefined) throw new Error(`${job}: lane ${id} is neither a suite lane nor an arc lane in force (the command checked it)`);
        return arcJourneyLane(arc);
      };
      // A resumed run removes what the cut-short one left and runs in a fresh checkout.
      await removeJobCheckouts(ctx, job);
      const series = await runJourneySeries(ctx, { type: 'job', job, acquireFirst: ctx.acquireFirst }, due.request.lanes.map(lane), {
        path: jobSeriesCheckout(ctx, job, 'run'), checkout: { type: 'detached', at },
      }, { reuse: true, stop: () => false });
      if (series.end.kind !== 'ran') return end('no-verdict', `a lane gave no verdict (${endDetail(series.end)})`);
      return end('ran', `at ${at}: ${series.runs.map((r) => `${r.lane} ${journeyRed(r) ? 'red' : 'green'}`).join(', ')}`);
    }
  }
}

function endFact(ctx: LandingContext, job: JobId, outcome: EndgameJobOutcome, detail: string): void {
  ctx.journal.fact({ kind: 'endgame-job-ended', job, outcome, detail });
}
