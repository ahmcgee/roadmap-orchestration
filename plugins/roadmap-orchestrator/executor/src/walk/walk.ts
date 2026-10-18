// The milestone walk job (dev.13, plan §2; SCHEMAS.md "dev.13"; DESIGN-1.0.md §2.12): one durable job `walk-<n>` at a
// time, arc-wide, modelled on the audit's lifecycle (src/holistic/audit.ts). A walk brings the milestone's product up
// from the integration SHA and an acting judge (`walkthrough`) uses it along the milestone's journeys.
//
// A run (`runWalk`, one call per scheduler turn):
//   0. A running walk (started, not ended: a crash or a restart cut it short) resumes as the same job, from its recorded
//      start (milestone, round, SHA, ports). Otherwise the walk due now (src/walk/milestones.ts `walkDue`: the publication
//      that retired a milestone's last unit makes round 1 due; the rounds brake makes a later one due), skipped (nothing
//      written) while the walkthrough seat's backend is parked or the arc is paused or stopped.
//   1. The capture: `walk-started{job, milestone, round, sha, ports}` under the revision fence (`captureUnderFence`), the
//      SHA the integration head then, a free port allocated per serve entry. Everything after reads the recorded start.
//   2. Its reservation: the milestone's resources and `@cpu`×WALK_CPU under `job{walk-n}`, served first (`acquireFirst`),
//      probed; an occupied resource releases it and the walk waits, started (its occupancy item raised once).
//   3. A detached checkout `<worktreeRoot>/<arc>/<walk-n>.walk` of the SHA; the evidence dir `<runDir>/evidence/jobs/<walk-n>/`.
//   4. Lazily, before the first call it must make: the bring-up (src/walk/bringup.ts), its logs under the evidence dir
//      (`server/`, `bring-up/`). A failed bring-up opens code's P1 citing the failed step's output, no model call, and the
//      walk ends `bring-up-failed`. A stop cancels it: the walk ends `abandoned`.
//   5. The session: `walkthrough` as an acting judge (dispatch.ts `callActingJudge`, `claude-acting-judge`) in the
//      checkout, its MCP servers the repo config's `walkthrough.mcp` with `{evidence}` and `{viewport}` substituted, given
//      only to a milestone with a `browser` journey. A resumed walk consumes a call it already made (`recordedArcCall`).
//      An answer off its schema, or refused by `walkRefusals` (src/walk/report.ts), takes the one judgment repair turn
//      (its session resumed with every reason, `repairTurnOf`); refused again, or interrupted, failed or parked, the walk
//      ends `abandoned` (`interrupted` when a pause, a stop or a backend park cut it short). The same round is due again,
//      once: a round whose walk failed (not interrupted) WALK_ATTEMPTS times ends `abandoned` (src/walk/milestones.ts).
//   6. Teardown: the runner reaps the session's own processes (its browser) once its report is final; code stops the
//      product, then removes the checkout citing an evidence snapshot of it.
//   7. Minting (src/walk/report.ts `mintWalk`): `breaks` → P1, `deviates` → P2, polish → `polish-proposed` (agent D's
//      code-applied polish revision consumes them). Then `walk-ended{job, outcome, findings, proposals, dropped}`: the
//      last round's proposals (round = `walkRounds`) are all dropped, never applied.
//   8. `milestone-passed{milestone, job}` when the walk ended `reported` and the milestone has no active walkthrough P1.
//      A crash between the end and the pass is settled by `settleWalks` (the scheduler's start, and every run).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import { crashPoint } from '../core/crash.ts';
import type { Parent } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type FindingId, type JobId, type PolishId, type ServeName, type Sha, canonicalIds, parseInvocationId } from '../core/ids.ts';
import { readJournal } from '../core/log.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { removeCheckout } from '../holistic/audit.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { isActive, openFinding, raisedWith } from '../holistic/findings.ts';
import type { Vision } from '../holistic/types.ts';
import { type Milestone, type PlanM1, advancesOf, milestoneOf, milestonesOf, walkRoundsOf } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor } from '../needsuser.ts';
import {
  type BackendCallOutcome, type RepairTurn, type StageContext, arcSeat, callActingJudge, recordedArcCall, repairTurnOf, runOp, verdictOf,
} from '../pipeline/dispatch.ts';
import { removeJobCheckouts } from '../pipeline/lanes.ts';
import { holisticInForce, inMs, loadUnitSpec, referenceFiles } from '../pipeline/stages.ts';
import { repairUnits } from '../pipeline/reproduce.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { promptFor } from '../prompts/index.ts';
import { type KeptTweak, type WalkFindingView, type WalkthroughInputs, visionInputOf } from '../prompts/inputs.ts';
import { type WalkthroughOutput, validateWalkthroughOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { probe } from '../resources/probe.ts';
import { requestOf } from '../resources/pool.ts';
import { type JobHolder, type Reservation, cleanup, heldReservation, run } from '../resources/reserve.ts';
import { type WalkMcpServers, walkMcpConfig } from '../backends/mcp.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import { CPU_COST } from '../schedule/types.ts';
import { renderSpec } from '../spec/render.ts';
import { type Instance, allocatePorts, bringUp, substitutePorts, tearDown } from './bringup.ts';
import { type WalkRecord, activeWalkP1s, runningWalk, walkDue, walkItemsDue, walksOf } from './milestones.ts';
import { milestonePassed } from './node.ts';
import { bringUpDraft, mintWalk, walkRefusals } from './report.ts';

/** What a walk needs: a stage context (processes, resources, routing) and the arbiter's first-served waits. */
export type WalkContext = StageContext & Readonly<{ acquireFirst: AcquireFirst }>;

/** A walk holds a build's `@cpu`: the product's processes and a browser run beside the session. */
export const WALK_CPU = CPU_COST.build;
/** A walk session's deadline (it uses the product along every journey, both viewports for a browser journey). */
export const WALK_SESSION_MIN = 90;

export type WalkRunOutcome =
  | Readonly<{ kind: 'none' }>
  /** Due, but not started: the walkthrough backend is parked, the arc is paused or stopped, or a resource is occupied. */
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' | 'occupied' }>
  /** A started walk could not run now (its reservation's resource is occupied, or its cleanup failed): it resumes later. */
  | Readonly<{ kind: 'incomplete'; job: JobId; detail: string }>
  | Readonly<{ kind: 'ended'; job: JobId; outcome: 'reported' | 'bring-up-failed' | 'abandoned'; passed: boolean }>;

/** A job's waits are never cancelled: a walk runs to its end once begun. */
const NEVER = new AbortController().signal;

/** The walk's checkout: `<worktreeRoot>/<arc>/<walk-n>.walk`. */
export const walkCheckout = (ctx: StageContext, job: JobId): AbsPath => absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.walk`));
/** The walk's evidence dir (the job evidence convention): the session's captures, the product's logs. */
export const walkEvidenceDir = (ctx: Pick<StageContext, 'runDir'>, job: JobId): AbsPath => jobEvidenceRoot(ctx.runDir, job);

/** Why a due walk does not start now, or null. */
function skipReason(ctx: StageContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'walkthrough').triple.backend) ? 'backend-parked' : null;
}

/**
 * The session's `--mcp-config` text (src/backends/mcp.ts `walkMcpConfig`): the repo config's `walkthrough.mcp` servers (the
 * config the arc started under), only for a milestone with a `browser` journey; null otherwise. A browser journey without
 * the config is refused at bootstrap (`walk-tools-missing`), so meeting one here is a bug.
 */
export function walkSessionMcp(servers: WalkMcpServers | undefined, m: Milestone, evidenceDir: AbsPath): string | null {
  if (!m.journeys.some((j) => j.via === 'browser')) return null;
  if (servers === undefined) throw new Error(`milestone ${m.id} has a browser journey and the repo config names no walkthrough.mcp servers (Phase 0 refuses this: walk-tools-missing)`);
  return walkMcpConfig(servers, evidenceDir);
}

/** Every text file under the milestone's reference dirs at `sha`, as documents (src/pipeline/stages.ts `referenceFiles`; a binary file is left out). */
function referencesAt(ctx: StageContext, sha: Sha, m: Milestone): WalkthroughInputs['references'] {
  return referenceFiles(ctx.repo, sha, m.references).flatMap((f) => (f.text === null ? [] : [{ path: f.path, text: f.text }]));
}

/** The milestone's kept tweaks so far: its polish units judged `keep` and merged, with their proposal's text. */
function keptTweaks(ctx: StageContext, m: Milestone): readonly KeptTweak[] {
  const view = ctx.journal.view;
  const facts = view.walkFacts().map((x) => x.fact);
  return ctx.plan().units.flatMap((u) => {
    if (u.polish === undefined || u.polish.milestone !== m.id || view.unit(u.id).status !== 'retired') return [];
    if (!facts.some((f) => f.kind === 'tweak-judged' && f.unit === u.id && f.decision === 'keep')) return [];
    const proposed = facts.find((f) => f.kind === 'polish-proposed' && f.id === u.polish!.proposal);
    return proposed?.kind === 'polish-proposed' ? [{ unit: u.id, proposal: proposed.id, text: proposed.text }] : [];
  });
}

/** The milestone's open walkthrough findings, as finding views. */
function openFindings(ctx: StageContext, m: Milestone): readonly WalkFindingView[] {
  return ctx.journal.view.holistic().findings.filter((f) => f.lens === 'walkthrough' && f.milestone === m.id && isActive(f))
    .map((f) => ({ id: f.id, lens: f.lens, severity: f.severity, state: f.state, obligation: f.obligation, claim: f.claim, owner: f.owner, cause: f.cause ?? null }));
}

/** The vision in force, and the slice the plan advances. */
function visionInForce(ctx: StageContext): Readonly<{ vision: Vision; input: WalkthroughInputs['vision'] }> {
  const { vision } = holisticInForce(ctx);
  if (vision === null) throw new Error('a milestone walk outside a holistic revision in force (milestones need the holistic layer)');
  return { vision, input: visionInputOf(vision, advancesOf(ctx.plan())) };
}

function inputsOf(ctx: StageContext, w: WalkRecord, m: Milestone, product: Instance['product'], evidenceDir: AbsPath, vision: WalkthroughInputs['vision']): WalkthroughInputs {
  const view = ctx.journal.view;
  return {
    vision,
    milestone: { id: m.id, text: m.text },
    round: w.round,
    journeys: m.journeys.map((j) => ({ ...j, entry: substitutePorts(j.entry, w.ports) })),
    references: referencesAt(ctx, w.sha, m),
    tweaks: keptTweaks(ctx, m),
    findings: openFindings(ctx, m),
    product,
    units: ctx.plan().units.filter((u) => m.units.includes(u.id) && view.unit(u.id).status === 'retired').map((u) => {
      const spec = loadUnitSpec(ctx, u).spec;
      return { unit: u.id, rev: spec.rev, markdown: renderSpec(spec) };
    }),
    evidenceDir,
  };
}

type Read =
  | Readonly<{ kind: 'reported'; output: WalkthroughOutput }>
  /** `refused`: off its schema or refused by `walkRefusals`, so it may take its repair turn. */
  | Readonly<{ kind: 'failed'; reasons: readonly string[]; refused: boolean; interrupted: boolean }>;

/** Reads a walkthrough call against its inputs. A usage-limit park's item is raised once. */
function readWalk(ctx: StageContext, job: JobId, called: BackendCallOutcome, check: Parameters<typeof walkRefusals>[0]): Read {
  const v = verdictOf(ctx, { type: 'job', job }, called);
  switch (v.kind) {
    case 'success': {
      let output: WalkthroughOutput;
      try {
        output = validateWalkthroughOutput(v.value);
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', reasons: [`the report is off its schema: ${error.message}`], refused: true, interrupted: false };
        throw error;
      }
      const reasons = walkRefusals(check, output);
      return reasons.length === 0 ? { kind: 'reported', output } : { kind: 'failed', reasons, refused: true, interrupted: false };
    }
    case 'malformed':
      return { kind: 'failed', reasons: [`malformed report: ${v.detail}`], refused: true, interrupted: false };
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent: Parent = { type: 'op', op: parseInvocationId(called.inv).op };
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return { kind: 'failed', reasons: [`interrupted: ${v.reason}`], refused: false, interrupted: true };
    }
    default:
      return { kind: 'failed', reasons: [`${v.kind}: ${v.detail}`], refused: false, interrupted: false };
  }
}

/**
 * Takes a milestone job's reservation (see the header, step 2: a walk's, and a polish unit's compare, src/walk/compare.ts):
 * the milestone's resources and `@cpu`×WALK_CPU, served first and probed; `occupied` when a resource is occupied (the
 * reservation released).
 */
export async function reserveJob(ctx: WalkContext, job: JobId, m: Milestone): Promise<Reservation<'running', JobHolder> | 'occupied' | 'cleanup-failed'> {
  const holder: JobHolder = { type: 'job', job };
  const parent: Parent = { type: 'job', job };
  const grant = await ctx.acquireFirst(requestOf(ctx.plan(), m.resources, WALK_CPU), holder, NEVER);
  if (grant.kind === 'cancelled') throw new Error(`${job}: its reservation wait was cancelled, and nothing cancels it`);
  const reserved = heldReservation(ctx, holder, 'reserved');
  const occupancy = await probe(ctx, reserved, parent);
  if (occupancy.kind === 'parked') {
    if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, occupancy.needsUser, parent);
    const cleaned = await cleanup(ctx, reserved, parent);
    return cleaned.kind === 'cleanup-failed' ? 'cleanup-failed' : 'occupied';
  }
  return run(ctx, reserved, parent);
}

/**
 * The capture (step 1): `walk-started` of the walk `due` names, with `ports`, when it is still the walk due under the fence
 * (a revision applied while the ports were allocated may have changed it); null otherwise.
 */
function capture(ctx: WalkContext, due: Readonly<{ milestone: Milestone; round: number }>, ports: Readonly<Record<ServeName, number>>): WalkRecord | null {
  const view = ctx.journal.view;
  const now = walkDue(view, ctx.plan(), repairUnits(ctx));
  if (now === null || now.milestone.id !== due.milestone.id || now.round !== due.round) return null;
  const job = view.nextJobId('walk');
  ctx.journal.fact({ kind: 'walk-started', job, milestone: due.milestone.id, round: due.round, sha: integrationHeadNow(ctx), ports });
  return walksOf(view, due.milestone.id).find((w) => w.job === job) ?? null;
}

/**
 * Writes the `milestone-passed` a crash between `walk-ended` and `milestone-passed` cut short (step 8; the scheduler runs
 * it at its start): for each milestone not passed whose latest walk is a round that ended `reported`, no walk of it started
 * since, and which had no active walkthrough P1 as of that end (the log read through it, so a repair landing since does
 * not pass the node without a walk confirming it).
 */
export function settleWalks(ctx: Pick<StageContext, 'journal' | 'plan' | 'runDir'>): void {
  const view = ctx.journal.view;
  for (const m of milestonesOf(ctx.plan())) {
    const walks = walksOf(view, m.id);
    const last = walks.at(-1);
    if (last?.ended?.outcome !== 'reported' || milestonePassed(view, m.id)) continue;
    if (activeWalkP1s(readJournal(ctx.runDir, view.arc, last.ended.seq).view, m.id).length > 0) continue;
    ctx.journal.fact({ kind: 'milestone-passed', milestone: m.id, job: last.job });
  }
}

/** Ends walk `w`: `walk-ended`, then the node's pass when it holds (steps 7–8). */
function end(
  ctx: WalkContext, w: WalkRecord, m: Milestone, plan: PlanM1, outcome: 'reported' | 'bring-up-failed' | 'abandoned', findings: readonly FindingId[], proposals: readonly PolishId[],
  interrupted = false,
): WalkRunOutcome {
  const last = w.round >= walkRoundsOf(plan);
  crashPoint('walk.before-ended');
  ctx.journal.fact({ kind: 'walk-ended', job: w.job, outcome, findings: canonicalIds(findings), proposals, dropped: last ? proposals : [], ...(interrupted ? { interrupted: true } : {}) });
  crashPoint('walk.after-ended');
  const passes = outcome === 'reported' && !milestonePassed(ctx.journal.view, m.id) && activeWalkP1s(ctx.journal.view, m.id).length === 0;
  if (passes) {
    ctx.journal.fact({ kind: 'milestone-passed', milestone: m.id, job: w.job });
    crashPoint('walk.after-passed');
  }
  return { kind: 'ended', job: w.job, outcome, passed: milestonePassed(ctx.journal.view, m.id) };
}

/** Runs (or resumes) the walk due now: see the header. */
export async function runWalk(ctx: WalkContext): Promise<WalkRunOutcome> {
  const view = ctx.journal.view;
  let w = runningWalk(view);
  if (w === null) {
    const due = walkDue(view, ctx.plan(), repairUnits(ctx));
    if (due === null) return { kind: 'none' };
    const skip = skipReason(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip };
    // Ports first (an await), then the capture in one synchronous step under the fence.
    const ports = await allocatePorts(due.milestone.bringUp.serve.map((s) => s.name));
    w = await captureUnderFence(ctx.journal, () => capture(ctx, due, ports));
    if (w === null) return { kind: 'none' };
    crashPoint('walk.after-started');
  }
  const walk = w;
  const r = await reserveJob(ctx, walk.job, milestoneOf(ctx.plan(), walk.milestone));
  if (r === 'occupied' || r === 'cleanup-failed') return { kind: 'incomplete', job: walk.job, detail: r };
  try {
    return await walkOnce(ctx, walk);
  } finally {
    const cleaned = await cleanup(ctx, r, { type: 'job', job: walk.job });
    if (cleaned.kind !== 'released') throw new Error(`${walk.job}: its reservation was not released: ${cleaned.kind}`);
  }
}

/** Steps 3–8 of a started walk, under its reservation. */
async function walkOnce(ctx: WalkContext, w: WalkRecord): Promise<WalkRunOutcome> {
  const { job } = w;
  const parent: Parent = { type: 'job', job };
  const plan = ctx.plan();
  const m = milestoneOf(plan, w.milestone);
  await removeJobCheckouts(ctx, job);
  const checkout = walkCheckout(ctx, job);
  const evidenceDir = walkEvidenceDir(ctx, job);
  mkdirSync(evidenceDir, { recursive: true });
  const { vision, input: visionInput } = visionInForce(ctx);
  const check = { milestone: m, plan, vision, evidenceDir };
  const deadlineAt = inMs(WALK_SESSION_MIN * 60_000);
  const prompt = promptFor('walkthrough', arcSeat(ctx, 'walkthrough').triple.model);
  const mcpConfig = walkSessionMcp(ctx.routingBase.config?.walkthrough?.mcp, m, evidenceDir);

  let made = false;
  let instance: Instance | null = null;
  /** Makes the checkout and brings the product up, once; a failure or a stop ends the walk (returned). */
  const ensureUp = async (): Promise<WalkRunOutcome | null> => {
    if (instance !== null) return null;
    if (!made) {
      await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, parent, { path: checkout, checkout: { type: 'detached', at: w.sha } });
      made = true;
    }
    const up = await bringUp(ctx, {
      milestone: m, checkout, ports: w.ports, parent, key: `bring-up:${job}`, logDir: absPath(join(evidenceDir, 'server')),
      serveDeadlineAt: inMs((WALK_SESSION_MIN + 15) * 60_000),
    });
    if (up.kind === 'up') {
      instance = up.instance;
      return null;
    }
    await finish();
    if (up.kind === 'interrupted') return end(ctx, w, m, plan, 'abandoned', [], [], true);
    const opened = mintBringUp(ctx, job, m, up.step, up.detail, up.logs);
    crashPoint('walk.after-mint');
    return end(ctx, w, m, plan, 'bring-up-failed', opened, []);
  };
  /** Teardown (step 6): the product stopped, the checkout removed. */
  const finish = async (): Promise<void> => {
    if (instance !== null) await tearDown(ctx, instance);
    instance = null;
    if (made && existsSync(checkout)) await removeCheckout(ctx, job, checkout);
    made = false;
  };
  /** Call `attempt`: the recorded one consumed, else asked fresh (or as the repair turn `repair`) with the product up. */
  const ask = async (attempt: number, repair: Readonly<{ turn: RepairTurn; reasons: readonly string[] }> | null): Promise<Readonly<{ read: Read; called: BackendCallOutcome }> | WalkRunOutcome> => {
    let called = recordedArcCall(ctx, job, 'walkthrough', attempt);
    if (called === null || called.kind === 'lost') {
      const ended = await ensureUp();
      if (ended !== null) return ended;
      if (repair !== null && repair.turn.cwd !== checkout) throw new Error(`${job}: a refused walkthrough call ran in ${repair.turn.cwd}, not the walk's checkout ${checkout}`);
      const inputs = inputsOf(ctx, w, m, instance!.product, evidenceDir, visionInput);
      called = await callActingJudge(ctx, {
        job, role: 'walkthrough', attempt, system: prompt.system, cwd: checkout, evidenceDirs: [evidenceDir], mcpConfig, deadlineAt,
        ...(repair === null
          ? { rendered: prompt.render(inputs), schema: prompt.schema, session: freshJudgmentSession() }
          : { rendered: judgmentRepairDirective(repair.reasons), schema: repair.turn.schema, session: repair.turn.session }),
      });
    }
    return { read: readWalk(ctx, job, called, check), called };
  };

  try {
    const first = await ask(1, null);
    if ('kind' in first) return first;
    let read = first.read;
    if (read.kind === 'failed' && read.refused) {
      const recordedAgain = recordedArcCall(ctx, job, 'walkthrough', 2);
      const turn = recordedAgain?.kind === 'result' ? null : repairTurnOf(ctx.runDir, first.called.inv);
      if (recordedAgain?.kind === 'result' || turn !== null) {
        const again = await ask(2, turn === null ? null : { turn, reasons: read.reasons });
        if ('kind' in again) return again;
        read = again.read;
      }
    }
    await finish();
    if (read.kind !== 'reported') {
      process.stderr.write(`roadmap: ${job}: the walkthrough of ${m.id} was abandoned: ${read.reasons.join('; ')}\n`);
      return end(ctx, w, m, plan, 'abandoned', [], [], read.interrupted);
    }
    const minted = mintWalk(ctx.journal, { repo: ctx.repo, job, sha: w.sha, milestone: m, evidenceDir }, read.output);
    crashPoint('walk.after-mint');
    return end(ctx, w, m, plan, 'reported', minted.findings, minted.proposals);
  } finally {
    await finish();
  }
}

/**
 * Code's P1 for a failed bring-up, through the store: the id it opened or merged into, or (a dismissal suppressing it) the
 * dismissed finding's, which `walk-ended` names.
 */
function mintBringUp(ctx: WalkContext, job: JobId, m: Milestone, step: string, detail: string, logs: readonly AbsPath[]): readonly FindingId[] {
  const o = openFinding(ctx.journal, bringUpDraft(job, m, step, detail, logs));
  return [o.kind === 'suppressed' ? o.by : o.id];
}

/** Whether a walk is due or running now (the scheduler's question before it calls `runWalk`). */
export function walkPending(ctx: StageContext): boolean {
  const view = ctx.journal.view;
  if (milestonesOf(ctx.plan()).length === 0) return false;
  return runningWalk(view) !== null || walkDue(view, ctx.plan(), repairUnits(ctx)) !== null;
}

/** Raises every milestone escalation due at `now` not raised yet (`walkItemsDue`, parented by its walk job; the scheduler's tick). */
export function raiseWalkItems(ctx: StageContext, now: Date): void {
  const view = ctx.journal.view;
  if (milestonesOf(ctx.plan()).length === 0) return;
  for (const item of walkItemsDue(view, ctx.plan(), repairUnits(ctx), now)) {
    const parent: Parent = { type: 'job', job: item.job };
    if (!raisedWith(view, ctx.runDir, parent, 'finding-p1-escalated')) raiseNeedsUser(ctx.journal, ctx.runDir, item.content, parent);
  }
}
