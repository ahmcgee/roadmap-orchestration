// The flow job (plan "Triggers and the job", "Levers, proposals and the fence"; SCHEMAS.md "M4b"): kind `flow`, run by
// the scheduler's flow track (src/flow/track.ts) when triggers are due, one judgment job at a time.
//
// - **Capture** under the revision fence: the run's `FlowInputs` (the triggers; the chart, the station table and code's
//   constraint over the series; the accounting, stated diagnostic only; the lever catalogue of the plan in force; the
//   givens in force; the open window, the closed verdicts and the rejection memory; the `advances` clause texts), kept
//   as `inputs/<sha>.flow-inputs.json`, then `flow-started{job, triggers, inputsSha256}`.
// - **The call**: the `flow` seat `arc` (`callArcRole`, a fresh read-only session, cwd a detached checkout of the
//   integration head, which the prompt lets it read to judge a lever's risk; `@cpu`×1 under the job), rendered from the
//   kept inputs alone, so a resumed job and recovery read only those bytes. A recorded call is consumed, never asked
//   again; an interrupted one (a pause, a stop, a backend park) leaves the job running. An answer the reader refuses (a
//   schema failure, `invalid`) is asked once more, the retry told why; a second is `invalid`. A call lost with its
//   runner is asked once more; a refusal, a fault or a second loss is `failed`.
// - **The end**: the proposal (id `<job>.0`) through code's checks (src/flow/levers.ts `checkProposal`, its context the
//   kept inputs, the plan in force, the host, whether a repair unit waits, and the units flow set `high` that have not
//   merged), then `flow-ended{outcome, proposal | dropped, constraint}`; then, once per proposal id, one non-blocking
//   `flow-proposal` item (`flow-host` for host advice), or after `invalid` one non-blocking `flow-invalid` item, each
//   parented by the job (`settleFlowItems` raises an item a crash left unraised).
// Crash points `flow.after-started` (inputs kept, before the call), `flow.after-call` (before `flow-ended`) and
// `flow.after-ended` (the item not raised).
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JobId, type UnitId, compareIds, parseInvocationId, proposalIdOf } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { DEFAULT_BOUNDS, type NeedsUserContent } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type IsoTime, absPath, isoTimeOf } from '../core/values.ts';
import type { CheckpointContext } from '../holistic/bundle.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { interruptedCall } from '../holistic/checkpoint.ts';
import { removeCheckout, withCpu } from '../holistic/audit.ts';
import { FLOW_INPUTS_INPUT, inputPath, keepInput, keptInput, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { advancesOf } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor, raisedWithReason } from '../needsuser.ts';
import { type BackendCallOutcome, type JobParent, arcSeat, callArcRole, minutesMs, recordedArcCall, runOp, verdictOf } from '../pipeline/dispatch.ts';
import { removeJobCheckouts } from '../pipeline/lanes.ts';
import { inMs } from '../pipeline/stages.ts';
import { promptFor } from '../prompts/index.ts';
import { validateFlowOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { constraintWindow, codeConstraintOf } from './constraint.ts';
import { type FlowNow, flowNow, givensNow, leverCatalogue, windowNow } from './live.ts';
import { LEVER_STEP, type ProposalContext, checkProposal, metricOf } from './levers.ts';
import { rejectionMemory } from './apply.ts';
import { type FlowLog, type FlowRun, closedVerdicts, proposalOf, runningRun } from './log.ts';
import { stationTable } from './series.ts';
import { chartOf } from './spc.ts';
import {
  FLOW_INPUTS_SCHEMA, type FlowAction, type FlowInputs, type FlowOutcome, type FlowOutput, type FlowProposal, type FlowPromptInputs, type FlowTrigger,
  type JudgedConstraint, parseFlowInputs,
} from './types.ts';

/** The flow job runs under the checkpoint's context: the stage's, the arbiter's first-served `@cpu`, the plan file. */
export type FlowJobContext = CheckpointContext;

const jobParent = (job: JobId): JobParent => ({ type: 'job', job });

export type FlowJobOutcome =
  | Readonly<{ kind: 'none' }>
  /** Due or running, but not asked: the seat's backend is parked, or the arc is paused or stopped. */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>
  /** The call was interrupted (a pause, a stop, a backend park): the job stays running. */
  | Readonly<{ kind: 'interrupted'; job: JobId; detail: string }>
  | Readonly<{ kind: 'ended'; job: JobId; outcome: FlowOutcome }>;

/** Why a flow call does not start now, or null. */
function skip(ctx: FlowJobContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'flow').triple.backend) ? 'backend-parked' : null;
}

/** Whether the flow call would be skipped now (the track asks before it captures). */
export const flowSkipped = (ctx: FlowJobContext): 'backend-parked' | 'paused' | null => skip(ctx);

// ---------------------------------------------------------------------------------------------------
// Capture

/** The `advances` clause texts of a holistic arc's vision in force, ascending; none outside one. */
function advancesNow(ctx: FlowJobContext): FlowInputs['advances'] {
  const inForce = requirePlanInForce(ctx.runDir, ctx.journal.view);
  const vision = revisionInForce(ctx.runDir, inForce).vision?.value ?? null;
  if (vision === null) return [];
  const clauses = new Map(vision.clauses.map((c) => [c.id, c.text]));
  return [...advancesOf(inForce.plan)].sort(compareIds).map((id) => {
    const text = clauses.get(id);
    if (text === undefined) throw new Error(`the plan in force advances ${id}, which the vision in force does not hold`);
    return { id, text };
  });
}

/** The units a flow `sequence` set `high` (an applied one) that have not merged. */
export function flowHighOf(ctx: Pick<FlowJobContext, 'journal'>, log: FlowLog): readonly UnitId[] {
  return [...log.applied.keys()].flatMap((id) => {
    const action = proposalOf(log, id).action;
    return action.lever === 'sequence' && ctx.journal.view.unit(action.unit).status !== 'retired' ? [action.unit] : [];
  });
}

/** Whether a repair unit is ready or waiting: an active unit of origin `repair`. */
const repairWaiting = (ctx: FlowJobContext): boolean => ctx.plan().units.some((u) => u.origin === 'repair' && ctx.journal.view.unit(u.id).status === 'active');

/** The inputs a run binds now, as `job` (see the header). */
export function flowInputsNow(ctx: FlowJobContext, job: JobId, triggers: readonly FlowTrigger[], flow: FlowNow): FlowInputs {
  const plan = ctx.plan();
  const points = flow.series.points;
  const view = ctx.journal.view;
  return {
    schema: FLOW_INPUTS_SCHEMA,
    job,
    triggers,
    chart: flow.limits === null ? null : chartOf(flow.limits, points, flow.inFlight),
    stations: stationTable(constraintWindow(points)),
    constraint: codeConstraintOf(points),
    accounting: flow.series.accounting,
    levers: leverCatalogue(plan, flow.host.cpus, ctx.routing(null).classes, (u) => view.unit(u).status === 'active'),
    givens: givensNow(ctx.repo, integrationHeadNow(ctx), flow.host),
    window: windowNow(flow),
    verdicts: closedVerdicts(flow.log),
    rejections: rejectionMemory(view),
    advances: advancesNow(ctx),
  };
}

/** The kept inputs of a started run: recovery and a resumed call read only these bytes. */
export function keptFlowInputs(runDir: AbsPath, run: FlowRun): FlowInputs {
  const { job, inputsSha256 } = run.started;
  const bytes = keptInput(runDir, inputsSha256, FLOW_INPUTS_INPUT);
  if (bytes === null) throw new Error(`${job} names flow inputs ${inputsSha256}, but ${inputPath(runDir, inputsSha256, FLOW_INPUTS_INPUT)} is not kept`);
  const inputs = parseFlowInputs(JSON.parse(bytes.toString('utf8')));
  if (inputs.job !== job || canonicalJson(inputs.triggers) !== canonicalJson(run.started.triggers)) throw new Error(`${job}: its kept inputs do not match its flow-started fact`);
  return inputs;
}

// ---------------------------------------------------------------------------------------------------
// The call

type Asked =
  | Readonly<{ kind: 'output'; output: FlowOutput }>
  | Readonly<{ kind: 'invalid'; detail: string }>
  | Readonly<{ kind: 'failed'; detail: string }>
  | Readonly<{ kind: 'interrupted'; detail: string }>
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>;

type Read =
  | Readonly<{ kind: 'output'; output: FlowOutput }>
  | Readonly<{ kind: 'invalid'; detail: string }>
  | Readonly<{ kind: 'lost'; detail: string }>
  | Readonly<{ kind: 'failed'; detail: string }>
  | Readonly<{ kind: 'interrupted'; detail: string }>;

/** Reads a call: an output, an answer the reader refuses, a loss, a failure, or an interruption (its park item written). */
function read(ctx: FlowJobContext, job: JobId, called: BackendCallOutcome): Read {
  if (called.kind === 'lost') return { kind: 'lost', detail: `${called.inv} was lost with its runner` };
  const v = verdictOf(ctx, jobParent(job), called);
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'output', output: validateFlowOutput(v.value) };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'invalid', detail: error.message };
        throw error;
      }
    case 'malformed':
      return { kind: 'invalid', detail: v.detail };
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent: Parent = { type: 'op', op: parseInvocationId(called.inv).op };
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return { kind: 'interrupted', detail: `interrupted: ${v.reason}` };
    }
    default:
      return { kind: 'failed', detail: `${v.kind}: ${v.detail}` };
  }
}

/** The prompt of attempt `attempt`: the kept inputs rendered, and on a retry why the previous answer was refused. */
function rendered(ctx: FlowJobContext, inputs: FlowInputs, refused: string | null): Readonly<{ system: string; text: string; schema: ReturnType<typeof promptFor<'flow'>>['schema'] }> {
  const prompt = promptFor('flow', arcSeat(ctx, 'flow').triple.model);
  const { schema: _s, job: _j, ...promptInputs } = inputs;
  const text = prompt.render(promptInputs satisfies FlowPromptInputs);
  return {
    system: prompt.system, schema: prompt.schema,
    text: refused === null ? text : `${text}\n\n<previous_answer_refused>\nYour previous answer to this request was refused by the report's reader: ${refused}. Answer again, every key present, exactly one of proposal and noAction.\n</previous_answer_refused>`,
  };
}

/** One new call of the job, attempt `attempt` (cwd: a detached checkout of the integration head). */
async function call(ctx: FlowJobContext, inputs: FlowInputs, attempt: number, refused: string | null): Promise<BackendCallOutcome> {
  const { job } = inputs;
  const p = rendered(ctx, inputs, refused);
  const checkout: AbsPath = absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.flow`));
  await removeJobCheckouts(ctx, job);
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, jobParent(job), { path: checkout, checkout: { type: 'detached', at: integrationHeadNow(ctx) } });
  const called = await withCpu(ctx, job, () => callArcRole(ctx, {
    job, role: 'flow', attempt, system: p.system, rendered: p.text, schema: p.schema, cwd: checkout, evidenceDirs: [],
    deadlineAt: inMs(minutesMs(ctx.plan().limits?.judgmentDeadlineMin ?? DEFAULT_BOUNDS.judgmentDeadlineMin)),
  }));
  await removeCheckout(ctx, job, checkout);
  return called;
}

/** The job's answer: its recorded calls consumed in order, then a new attempt while one is owed (see the header). */
async function ask(ctx: FlowJobContext, inputs: FlowInputs): Promise<Asked> {
  const { job } = inputs;
  let refused: string | null = null;
  let invalids = 0;
  let losses = 0;
  for (let attempt = 1; ; attempt++) {
    const recorded = recordedArcCall(ctx, job, 'flow', attempt);
    if (recorded !== null && interruptedCall(recorded)) continue;
    let called = recorded;
    if (called === null) {
      const why = skip(ctx);
      if (why !== null) return { kind: 'skipped', reason: why };
      called = await call(ctx, inputs, attempt, refused);
    }
    const r = read(ctx, job, called);
    switch (r.kind) {
      case 'output':
      case 'failed':
      case 'interrupted':
        return r;
      case 'lost':
        if (++losses >= 2) return { kind: 'failed', detail: r.detail };
        continue;
      case 'invalid':
        refused = r.detail;
        if (++invalids >= 2) return r;
        continue;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Items

const describe = (a: FlowAction): string => {
  switch (a.lever) {
    case 'concurrency': return `capacity.cpu to ${a.cpu}`;
    case 'resource-pool': return `resource ${a.resource}'s pool to ${a.size}`;
    case 'suite-lane': return `suite lane ${a.lane}${a.argv === undefined ? '' : ` argv to ${JSON.stringify(a.argv)} (proved with ${a.reporter ?? 'no reporter'})`}${a.cpu === undefined ? '' : ` cpu to ${a.cpu}`}`;
    case 'sequence': return `unit ${a.unit} to priority high`;
    case 'build-class': return `build.${a.tier} to class ${a.class}`;
    case 'host': return `host advice: ${a.note}`;
  }
};

/** One line naming a proposal: its lever's change, target, focusing step and verdict metric. */
export function proposalLine(p: FlowProposal): string {
  const metric = metricOf(p.action, p.target);
  const m = metric === null ? 'none' : metric.type === 'lead' ? 'lead time' : metric.type === 'suite-run' ? `per-run service of ${metric.lane}` : `the wait ${metric.station}`;
  return `${p.id}: ${describe(p.action)} at ${p.target} (${LEVER_STEP[p.action.lever]}; verdict metric ${m})`;
}

function itemContent(p: FlowProposal, inputsPath: AbsPath): NeedsUserContent {
  const host = p.action.lever === 'host';
  const options = [
    { id: 'accept', label: `roadmap flow accept ${p.id} --reason <text>` },
    { id: 'reject', label: `roadmap flow reject ${p.id} --reason <text>` },
  ];
  return {
    blocking: false, subject: { type: 'arc' }, reason: host ? 'flow-host' : 'flow-proposal',
    summary: host
      ? `Flow proposal ${p.id} is advice for the owner, never applied: ${describe(p.action)}. Rationale: ${p.rationale} Risks: ${p.risks}`
      : `Flow proposal ${proposalLine(p)}. Rationale: ${p.rationale} Risks: ${p.risks}`,
    recommendation: host
      ? `Pass the advice to the owner (or declare a given with \`roadmap flow given\` when it is self-evident), then accept or reject ${p.id} with a one-line reason.`
      : `Assess it: does it touch a measurement (tests, lanes, witnesses, judgment); does its target match the constraint; is the effect plausible at the target's share of lead; what guard could it breach. Then accept or reject ${p.id} with a one-line reason. Never edit a ruler path to make a number move.`,
    options, evidence: [inputsPath],
  };
}

function invalidContent(job: JobId, detail: string | null, inputsPath: AbsPath): NeedsUserContent {
  return {
    blocking: false, subject: { type: 'arc' }, reason: 'flow-invalid',
    summary: `Flow run ${job} gave no valid report twice${detail === null ? '' : ` (${detail})`}; nothing was proposed. The next trigger runs the flow role again.`,
    recommendation: 'Acknowledge this item. If it repeats, read the run\'s calls (`roadmap status` names the job) and report the prompt or schema problem.',
    options: [], evidence: [inputsPath],
  };
}

/** The item an ended run calls for and its reason, or null. */
function itemOf(runDir: AbsPath, run: FlowRun, detail: string | null): NeedsUserContent | null {
  const ended = run.ended;
  if (ended === null) return null;
  const inputs = inputPath(runDir, run.started.inputsSha256, FLOW_INPUTS_INPUT);
  if (ended.outcome === 'invalid') return invalidContent(run.started.job, detail, inputs);
  return ended.proposal === null ? null : itemContent(ended.proposal, inputs);
}

/**
 * Raises the item of every ended run that calls for one and has none (once per job and reason: a crash between the end
 * and the raise loses only `detail`, which the job that just ended passes for itself).
 */
export function settleFlowItems(ctx: Pick<FlowJobContext, 'journal' | 'runDir'>, log: FlowLog, detail: Readonly<{ job: JobId; text: string }> | null = null): void {
  for (const run of log.runs) {
    const content = itemOf(ctx.runDir, run, detail?.job === run.started.job ? detail.text : null);
    if (content === null) continue;
    const parent = jobParent(run.started.job);
    if (raisedWithReason(ctx.journal.view, ctx.runDir, parent, content.reason) === null) raiseNeedsUser(ctx.journal, ctx.runDir, content, parent);
  }
}

// ---------------------------------------------------------------------------------------------------
// The job

/** Code's checks' context (`checkProposal`): the kept inputs, the role's reading, and the arc now. */
function proposalContext(ctx: FlowJobContext, inputs: FlowInputs, judged: JudgedConstraint, flow: FlowNow): ProposalContext {
  return {
    plan: ctx.plan(), host: flow.host, constraint: inputs.constraint, judged, levers: inputs.levers, givens: inputs.givens, window: inputs.window,
    verdicts: inputs.verdicts, rejections: inputs.rejections, repairWaiting: repairWaiting(ctx), flowHigh: flowHighOf(ctx, flow.log),
  };
}

const now = (): IsoTime => isoTimeOf(new Date());

/**
 * Runs the flow job: resumes the run started and not ended, or starts one for `triggers` (none: nothing to do). See the
 * header.
 */
export async function runFlowJob(ctx: FlowJobContext, triggers: readonly FlowTrigger[]): Promise<FlowJobOutcome> {
  settleFlowItems(ctx, flowNow(ctx, now()).log);
  let run = runningRun(flowNow(ctx, now()).log);
  if (run === null) {
    if (triggers.length === 0) return { kind: 'none' };
    const why = skip(ctx);
    if (why !== null) return { kind: 'skipped', reason: why };
    run = await captureUnderFence(ctx.journal, () => {
      const job = ctx.journal.view.nextJobId('flow');
      const inputs = flowInputsNow(ctx, job, triggers, flowNow(ctx, now()));
      const inputsSha256 = keepInput(ctx.runDir, Buffer.from(canonicalJson(inputs), 'utf8'), FLOW_INPUTS_INPUT);
      ctx.journal.fact({ kind: 'flow-started', job, triggers, inputsSha256 });
      return runningRun(flowNow(ctx, now()).log)!;
    });
    crashPoint('flow.after-started');
  }
  const inputs = keptFlowInputs(ctx.runDir, run);
  const { job } = inputs;
  await removeJobCheckouts(ctx, job);
  const asked = await ask(ctx, inputs);
  if (asked.kind === 'skipped') return asked;
  if (asked.kind === 'interrupted') return { kind: 'interrupted', job, detail: asked.detail };
  crashPoint('flow.after-call');
  const code = inputs.constraint;
  if (asked.kind === 'output') {
    const { output } = asked;
    const proposal: FlowProposal | null = output.proposal === null ? null : { id: proposalIdOf(job, 0), ...output.proposal };
    const dropped = proposal === null ? null : checkProposal(proposal, proposalContext(ctx, inputs, output.constraint, flowNow(ctx, now())));
    ctx.journal.fact({ kind: 'flow-ended', job, outcome: 'done', proposal: dropped === null ? proposal : null, dropped, constraint: { code, judged: output.constraint } });
  } else {
    ctx.journal.fact({ kind: 'flow-ended', job, outcome: asked.kind, proposal: null, dropped: null, constraint: { code, judged: null } });
  }
  crashPoint('flow.after-ended');
  settleFlowItems(ctx, flowNow(ctx, now()).log, asked.kind === 'invalid' ? { job, text: asked.detail } : null);
  return { kind: 'ended', job, outcome: asked.kind === 'output' ? 'done' : asked.kind };
}
