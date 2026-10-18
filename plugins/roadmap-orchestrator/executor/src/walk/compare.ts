// A polish unit's compare (dev.13, plan §4 "Polish units", R2; SCHEMAS.md "dev.13"): after its gate approved it and
// before its candidate is admitted, a polish unit's tweak is judged against the product as it is. A polish unit's
// candidate admission waits until its `tweak-judged` is a `keep` (src/schedule/ready.ts, constraint `compare`); a `drop`
// never lands, so nothing needs reverting. The compare is a durable job `compare-<n>`, one at a time, run in the holistic
// slot as a walk is (`runCompare`, one call per scheduler turn); the polish judge is an arc seat metered to the job.
//
//   0. A dropped tweak not cut yet is cut first (`cutDropped`): a revision cutting the unit with reason
//      `polish-dropped`, proposer and source `compare{unit}` (src/input/classify.ts `polishRows`), under the fence.
//   1. A running compare (started, not closed) resumes from its recorded start. Otherwise the first polish unit in plan
//      order, active, approved at its gate and awaiting its candidate, with no `tweak-judged` (`compareDue`); skipped
//      (nothing written) while the polish judge's backend is parked or the arc is paused or stopped.
//   2. Its unit diff (merge-base of the integration tip and the approved commit, to that commit) touches no milestone
//      reference: `tweak-judged{drop, reference-untouched}`, no instance and no call; then the cut.
//   3. `compare-started{job, unit, before, after, ports}` under the revision fence: `before` the integration tip, `after`
//      the approval's unit commit (the salvage tree the gate approved), a free port per serve entry for each.
//   4. The milestone job's reservation (src/walk/walk.ts `reserveJob`: the milestone's resources, `@cpu`×WALK_CPU).
//   5. Lazily, before the first call it must make: two detached checkouts `<worktreeRoot>/<arc>/<job>.before|after`, each
//      brought up (src/walk/bringup.ts), logs under `<evidence>/server-before|server-after/`. A failed before is
//      `compare-abandoned` (the integration tip itself does not come up: a walk's to find); a failed after, with the before
//      up, is `tweak-judged{drop, bring-up-failed}` (the tweak broke the bring-up); a stop abandons.
//   6. The session: a fresh `polishJudge` (src/pipeline/dispatch.ts `callActingJudge`) in the after checkout, with the
//      walkthrough's MCP servers for a `browser` journey, its evidence dir `<runDir>/evidence/jobs/<job>/`, the original
//      walk's evidence dir readable. It walks the cited journey on both instances and answers keep or drop
//      (POLISH_JUDGE_SCHEMA); every cited file must exist under its evidence dir or the walk's. A refused answer takes the
//      one judgment repair turn; refused again, failed, interrupted or parked: `compare-abandoned` (`interrupted` for a
//      pause, a stop or a backend park). A later compare runs, once: the unit's COMPARE_ATTEMPTS-th failed compare (not
//      interrupted) is followed by `tweak-judged{drop, abandoned}` and the cut (lead ruling: a brake, not a retry for ever).
//   7. Teardown of both instances and checkouts; then `tweak-judged{decision, judged}`, and a drop's cut (step 0).
// Crash labels: `compare.after-started`, `compare.after-judged` (`tweak-judged` written, a drop's cut not yet),
// `compare.after-cut`.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import { walkMcpConfig } from '../backends/mcp.ts';
import { crashPoint } from '../core/crash.ts';
import type { Parent, WalkFact } from '../core/events.ts';
import { captureUnderFence } from '../core/fence.ts';
import { type JobId, type ServeName, type Sha, type UnitId, parseInvocationId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { type FencedCommitContext, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { boundedDiff } from '../git/boundeddiff.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { diffBase, unitDiffPaths } from '../git/transient.ts';
import { removeCheckout } from '../holistic/audit.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { POLISH_DROPPED } from '../input/classify.ts';
import { inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { type Milestone, type PlanM1, type PlanUnit, advancesOf, derivedOf, milestoneOf, parsePlan } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor } from '../needsuser.ts';
import { type BackendCallOutcome, type RepairTurn, arcSeat, callActingJudge, recordedArcCall, repairTurnOf, runOp, verdictOf } from '../pipeline/dispatch.ts';
import { GATE_DIFF_BUDGET } from '../pipeline/gate.ts';
import { removeJobCheckouts } from '../pipeline/lanes.ts';
import { holisticInForce, inMs, referenceFiles } from '../pipeline/stages.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { promptFor } from '../prompts/index.ts';
import { type PolishJudgeInputs, visionInputOf } from '../prompts/inputs.ts';
import { type PolishJudgeOutput, validatePolishJudgeOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { cleanup } from '../resources/reserve.ts';
import { type Instance, allocatePorts, bringUp, substitutePorts, tearDown } from './bringup.ts';
import { evidencePath } from './report.ts';
import { type WalkContext, WALK_SESSION_MIN, reserveJob } from './walk.ts';

/** What a compare needs: a walk's context (processes, resources, the arbiter's first-served waits) and the fenced commit's. */
export type CompareContext = WalkContext & FencedCommitContext;

/** A compare as the log has it: its start, and whether a `tweak-judged` of its unit or its `compare-abandoned` closed it. */
export type CompareRecord = Readonly<{
  job: JobId; unit: UnitId; before: Sha; after: Sha;
  ports: Readonly<{ before: Readonly<Record<ServeName, number>>; after: Readonly<Record<ServeName, number>> }>; closed: boolean;
}>;

export type CompareOutcome =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'skipped'; reason: 'backend-parked' | 'paused' }>
  /** A started compare could not run now (a resource occupied, a cleanup failed): it resumes later. */
  | Readonly<{ kind: 'incomplete'; job: JobId; detail: string }>
  | Readonly<{ kind: 'judged'; unit: UnitId; decision: 'keep' | 'drop'; reason: Extract<WalkFact, { kind: 'tweak-judged' }>['reason'] }>
  | Readonly<{ kind: 'abandoned'; job: JobId; detail: string }>
  /** A dropped tweak cut (or, the arc having moved under the commit, to be cut at the next run). */
  | Readonly<{ kind: 'cut'; unit: UnitId; committed: boolean }>;

const SIDES = ['before', 'after'] as const;
type Side = (typeof SIDES)[number];

/** A unit's `tweak-judged`, or null before it. */
export function tweakOf(view: JournalView, unit: UnitId): Extract<WalkFact, { kind: 'tweak-judged' }> | null {
  const f = view.walkFacts().find((x) => x.fact.kind === 'tweak-judged' && x.fact.unit === unit)?.fact;
  return f?.kind === 'tweak-judged' ? f : null;
}

/** Every compare in log order. */
export function comparesOf(view: JournalView): readonly CompareRecord[] {
  const facts = view.walkFacts().map((x) => x.fact);
  return facts.flatMap((f) => (f.kind === 'compare-started'
    ? [{ job: f.job, unit: f.unit, before: f.before, after: f.after, ports: f.ports, closed: facts.some((g) => (g.kind === 'compare-abandoned' && g.job === f.job) || (g.kind === 'tweak-judged' && g.unit === f.unit)) }]
    : []));
}

/** The compare started and not closed (one at a time), or null. */
export const runningCompare = (view: JournalView): CompareRecord | null => comparesOf(view).find((c) => !c.closed) ?? null;

/** The polish unit due a compare now (see the header, step 1), or null. */
export function compareDue(view: JournalView, plan: PlanM1): PlanUnit | null {
  return plan.units.find((u) => {
    if (u.origin !== 'polish' || u.cut !== undefined || tweakOf(view, u.id) !== null) return false;
    const s = view.unit(u.id);
    if (s.status !== 'active' || s.approval === null || s.open !== null || s.entry !== null || s.decided === null) return false;
    const d = decidedBy(s.decided);
    return d.kind === 'stage' && d.target.stage === 'candidate';
  }) ?? null;
}

/** The polish unit judged `drop` and not cut yet (step 0), or null. */
export const cutDue = (view: JournalView, plan: PlanM1): PlanUnit | null =>
  plan.units.find((u) => u.origin === 'polish' && u.cut === undefined && tweakOf(view, u.id)?.decision === 'drop') ?? null;

/** Whether a compare or a dropped tweak's cut is due or running (the scheduler's question before `runCompare`). */
export function comparePending(ctx: Pick<CompareContext, 'journal' | 'runDir'>): boolean {
  const view = ctx.journal.view;
  const plan = requirePlanInForce(ctx.runDir, view).plan;
  return runningCompare(view) !== null || cutDue(view, plan) !== null || compareDue(view, plan) !== null;
}

/** Compares a unit gets: the first and one retry; the second failed (not interrupted) one drops the tweak, reason `abandoned`. */
export const COMPARE_ATTEMPTS = 2;

/** The compares of `unit` abandoned on a failure (`compare-abandoned` without `interrupted`). */
export function failedCompares(view: JournalView, unit: UnitId): number {
  const facts = view.walkFacts().map((x) => x.fact);
  const jobs = new Set(facts.flatMap((f) => (f.kind === 'compare-started' && f.unit === unit ? [f.job] : [])));
  return facts.filter((f) => f.kind === 'compare-abandoned' && jobs.has(f.job) && f.interrupted !== true).length;
}

/** Whether `paths` touch one of `m`'s references (a path at or under a reference dir). */
export const touchesReference = (m: Milestone, paths: readonly string[]): boolean =>
  paths.some((p) => m.references.some((r) => p === r || p.startsWith(`${r}/`)));

const checkoutOf = (ctx: CompareContext, job: JobId, side: Side): AbsPath => absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.${side}`));
/** The compare's evidence dir (the job evidence convention): the judge's captures and both instances' logs. */
export const compareEvidenceDir = (ctx: Pick<CompareContext, 'runDir'>, job: JobId): AbsPath => jobEvidenceRoot(ctx.runDir, job);

/** Writes `tweak-judged` (step 7, or step 2's / 5's code drop). */
function judge(ctx: CompareContext, unit: UnitId, decision: 'keep' | 'drop', reason: Extract<WalkFact, { kind: 'tweak-judged' }>['reason']): CompareOutcome {
  ctx.journal.fact({ kind: 'tweak-judged', unit, decision, reason });
  crashPoint('compare.after-judged');
  return { kind: 'judged', unit, decision, reason };
}

/** Step 0: the revision cutting dropped polish unit `unit` (reason `polish-dropped`). A classifier refusal is a bug here. */
export async function cutDropped(ctx: CompareContext, unit: PlanUnit): Promise<CompareOutcome> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const raw = JSON.parse(current.planBytes.toString('utf8')) as { units: Record<string, unknown>[] };
  const entry = raw.units.find((u) => u['id'] === unit.id);
  if (entry === undefined) throw new Error(`the plan's bytes have no unit ${unit.id}`);
  entry['cut'] = { reason: POLISH_DROPPED };
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const files = { ...current, plan: parsePlan(JSON.parse(planBytes.toString('utf8'))), planBytes };
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const proposer = { type: 'compare', unit: unit.id } as const;
  const evaluated = evaluateRevision(rctx, files, proposer);
  if (evaluated.kind !== 'accepted') throw new Error(`the cut of dropped tweak ${unit.id} was refused: ${evaluated.kind === 'rejected' ? evaluated.reasons.join('; ') : 'unchanged'}`);
  const out = await commitUnderFence(ctx, evaluated, proposer, proposer, { type: 'arc' });
  if (out.kind === 'rejected') return { kind: 'cut', unit: unit.id, committed: false };
  crashPoint('compare.after-cut');
  return { kind: 'cut', unit: unit.id, committed: true };
}

/** Why a due compare does not start now, or null. */
function skipReason(ctx: CompareContext): 'backend-parked' | 'paused' | null {
  const view = ctx.journal.view;
  const control = view.control();
  if (control.stop !== null || control.pausedAll) return 'paused';
  return view.parkedBackends().includes(arcSeat(ctx, 'polishJudge').triple.backend) ? 'backend-parked' : null;
}

/** Runs the cut, or the compare, due or running now (see the header). */
export async function runCompare(ctx: CompareContext): Promise<CompareOutcome> {
  const view = ctx.journal.view;
  const plan = requirePlanInForce(ctx.runDir, view).plan;
  const drop = cutDue(view, plan);
  if (drop !== null) return cutDropped(ctx, drop);
  let c = runningCompare(view);
  if (c === null) {
    const unit = compareDue(view, plan);
    if (unit === null) return { kind: 'none' };
    const m = milestoneOf(plan, unit.polish!.milestone);
    const after = view.unit(unit.id).approval!.fingerprint.unitCommit;
    if (!touchesReference(m, unitDiffPaths(ctx.repo, integrationHeadNow(ctx), after))) {
      judge(ctx, unit.id, 'drop', 'reference-untouched');
      await cutDropped(ctx, unit);
      return { kind: 'judged', unit: unit.id, decision: 'drop', reason: 'reference-untouched' };
    }
    const skip = skipReason(ctx);
    if (skip !== null) return { kind: 'skipped', reason: skip };
    const names = m.bringUp.serve.map((s) => s.name);
    const ports = { before: await allocatePorts(names), after: await allocatePorts(names) };
    c = await captureUnderFence(ctx.journal, (): CompareRecord | null => {
      if (compareDue(ctx.journal.view, requirePlanInForce(ctx.runDir, ctx.journal.view).plan)?.id !== unit.id) return null;
      const job = ctx.journal.view.nextJobId('compare');
      ctx.journal.fact({ kind: 'compare-started', job, unit: unit.id, before: integrationHeadNow(ctx), after, ports });
      return runningCompare(ctx.journal.view);
    });
    if (c === null) return { kind: 'none' };
    crashPoint('compare.after-started');
  }
  const started = c;
  const unit = plan.units.find((u) => u.id === started.unit);
  if (unit?.polish === undefined) throw new Error(`${started.job}: unit ${started.unit} is no polish unit of the plan in force`);
  const m = milestoneOf(plan, unit.polish.milestone);
  const r = await reserveJob(ctx, started.job, m);
  if (r === 'occupied' || r === 'cleanup-failed') return { kind: 'incomplete', job: started.job, detail: r };
  let out: CompareOutcome;
  try {
    out = await compareOnce(ctx, started, m, unit);
  } finally {
    const cleaned = await cleanup(ctx, r, { type: 'job', job: started.job });
    if (cleaned.kind !== 'released') throw new Error(`${started.job}: its reservation was not released: ${cleaned.kind}`);
  }
  if (out.kind === 'judged' && out.decision === 'drop') await cutDropped(ctx, unit);
  return out;
}

type Read = Readonly<{ kind: 'judged'; output: PolishJudgeOutput }> | Readonly<{ kind: 'failed'; reasons: readonly string[]; refused: boolean; interrupted: boolean }>;

/** Every cited file outside both the judge's evidence dir and the walk's, or missing there, as a refusal reason. */
export function judgeRefusals(dirs: readonly AbsPath[], out: PolishJudgeOutput): readonly string[] {
  return out.evidence.flatMap((e) => {
    const path = dirs.map((d) => evidencePath(d, e)).find((p) => p !== null && existsSync(p) && statSync(p).isFile());
    return path === undefined ? [`the answer cites ${e}, which is no file in the evidence dir ${dirs[0]} (or the walk's ${dirs[1]}): cite what you saved, by its path`] : [];
  });
}

/** Reads a polish judge call. A usage-limit park's item is raised once. */
function readJudge(ctx: CompareContext, job: JobId, called: BackendCallOutcome, dirs: readonly AbsPath[]): Read {
  const v = verdictOf(ctx, { type: 'job', job }, called);
  switch (v.kind) {
    case 'success': {
      let output: PolishJudgeOutput;
      try {
        output = validatePolishJudgeOutput(v.value);
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', reasons: [`the answer is off its schema: ${error.message}`], refused: true, interrupted: false };
        throw error;
      }
      const reasons = judgeRefusals(dirs, output);
      return reasons.length === 0 ? { kind: 'judged', output } : { kind: 'failed', reasons, refused: true, interrupted: false };
    }
    case 'malformed':
      return { kind: 'failed', reasons: [`malformed answer: ${v.detail}`], refused: true, interrupted: false };
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

/** Steps 5–7 of a started compare, under its reservation. */
async function compareOnce(ctx: CompareContext, c: CompareRecord, m: Milestone, unit: PlanUnit): Promise<CompareOutcome> {
  const { job } = c;
  const parent: Parent = { type: 'job', job };
  const evidenceDir = compareEvidenceDir(ctx, job);
  mkdirSync(evidenceDir, { recursive: true });
  const proposed = ctx.journal.view.walkFacts().find((x) => x.fact.kind === 'polish-proposed' && x.fact.id === unit.polish!.proposal)?.fact;
  if (proposed?.kind !== 'polish-proposed') throw new Error(`${job}: proposal ${unit.polish!.proposal} of ${unit.id} was never proposed`);
  const journey = m.journeys.find((j) => j.id === proposed.journey);
  if (journey === undefined) throw new Error(`${job}: proposal ${proposed.id} cites ${proposed.journey}, no journey of ${m.id}`);
  const walkEvidenceDir = jobEvidenceRoot(ctx.runDir, proposed.job);
  const dirs = [evidenceDir, walkEvidenceDir];
  const servers = ctx.routingBase.config?.walkthrough?.mcp;
  if (journey.via === 'browser' && servers === undefined) throw new Error(`${job}: ${journey.id} is a browser journey and the repo config names no walkthrough.mcp servers (Phase 0 refuses this)`);
  const mcpConfig = journey.via === 'browser' ? walkMcpConfig(servers!, evidenceDir) : null;
  const prompt = promptFor('polishJudge', arcSeat(ctx, 'polishJudge').triple.model);
  const deadlineAt = inMs(WALK_SESSION_MIN * 60_000);
  const instances: Partial<Record<Side, Instance>> = {};
  const made = new Set<Side>();

  const finish = async (): Promise<void> => {
    for (const side of SIDES) {
      const i = instances[side];
      if (i !== undefined) await tearDown(ctx, i);
      delete instances[side];
      const checkout = checkoutOf(ctx, job, side);
      if (made.has(side) && existsSync(checkout)) await removeCheckout(ctx, job, checkout);
      made.delete(side);
    }
  };
  /** Ends the compare unjudged; the unit's COMPARE_ATTEMPTS-th failed (not interrupted) one drops the tweak (the brake). */
  const abandon = async (detail: string, interrupted = false): Promise<CompareOutcome> => {
    await finish();
    ctx.journal.fact({ kind: 'compare-abandoned', job, detail, ...(interrupted ? { interrupted: true } : {}) });
    process.stderr.write(`roadmap: ${job}: the compare of ${unit.id} was abandoned: ${detail}\n`);
    if (!interrupted && failedCompares(ctx.journal.view, unit.id) >= COMPARE_ATTEMPTS) return judge(ctx, unit.id, 'drop', 'abandoned');
    return { kind: 'abandoned', job, detail };
  };
  /** Both instances up (step 5), once; an end of the compare when one does not come up. */
  const ensureUp = async (): Promise<CompareOutcome | null> => {
    if (made.size === 0) await removeJobCheckouts(ctx, job);
    for (const side of SIDES) {
      if (instances[side] !== undefined) continue;
      const checkout = checkoutOf(ctx, job, side);
      if (!made.has(side)) {
        await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}:${side}`, parent, { path: checkout, checkout: { type: 'detached', at: c[side] } });
        made.add(side);
      }
      const up = await bringUp(ctx, {
        milestone: m, checkout, ports: c.ports[side], parent, key: `bring-up:${job}:${side}`, logDir: absPath(join(evidenceDir, `server-${side}`)),
        serveDeadlineAt: inMs((WALK_SESSION_MIN + 15) * 60_000),
      });
      if (up.kind === 'up') {
        instances[side] = up.instance;
        continue;
      }
      if (up.kind === 'interrupted') return abandon(`the ${side} instance's ${up.step} was interrupted (${up.reason})`, true);
      if (side === 'before') return abandon(`the before instance (the integration tip ${c.before}) did not come up: ${up.step} failed (${up.detail})`);
      await finish();
      return judge(ctx, unit.id, 'drop', 'bring-up-failed');
    }
    return null;
  };
  const inputsOf = (): PolishJudgeInputs => {
    const { vision } = holisticInForce(ctx);
    if (vision === null) throw new Error(`${job}: a compare outside a holistic revision in force`);
    const instance = (side: Side): PolishJudgeInputs['before'] => ({ ...instances[side]!.product, entry: substitutePorts(journey.entry, c.ports[side]) });
    return {
      vision: visionInputOf(vision, advancesOf(ctx.plan())),
      milestone: { id: m.id, text: m.text },
      journey,
      proposal: { id: proposed.id, unit: unit.id, text: proposed.text, evidence: proposed.evidence },
      references: referenceFiles(ctx.repo, c.after, m.references).flatMap((f) => (f.text === null ? [] : [{ path: f.path, text: f.text }])),
      referenceDiff: boundedDiff(ctx.repo, diffBase(ctx.repo, c.before, c.after), c.after, {
        budget: GATE_DIFF_BUDGET, derived: [...new Set(derivedOf(ctx.plan()).flatMap((d) => d.outputs))].sort(), removes: null, dir: absPath(join(evidenceDir, 'diff')),
      }),
      walkEvidenceDir,
      before: instance('before'),
      after: instance('after'),
      evidenceDir,
    };
  };
  /** Call `attempt`: the recorded one consumed, else asked (fresh, or as the repair turn) with both instances up. */
  const ask = async (attempt: number, repair: Readonly<{ turn: RepairTurn; reasons: readonly string[] }> | null): Promise<Readonly<{ read: Read; called: BackendCallOutcome }> | CompareOutcome> => {
    let called = recordedArcCall(ctx, job, 'polishJudge', attempt);
    if (called === null || called.kind === 'lost') {
      const ended = await ensureUp();
      if (ended !== null) return ended;
      const cwd = checkoutOf(ctx, job, 'after');
      if (repair !== null && repair.turn.cwd !== cwd) throw new Error(`${job}: a refused polish judge call ran in ${repair.turn.cwd}, not ${cwd}`);
      called = await callActingJudge(ctx, {
        job, role: 'polishJudge', attempt, system: prompt.system, cwd, evidenceDirs: dirs, mcpConfig, deadlineAt,
        ...(repair === null
          ? { rendered: prompt.render(inputsOf()), schema: prompt.schema, session: freshJudgmentSession() }
          : { rendered: judgmentRepairDirective(repair.reasons), schema: repair.turn.schema, session: repair.turn.session }),
      });
    }
    return { read: readJudge(ctx, job, called, dirs), called };
  };

  try {
    const first = await ask(1, null);
    if ('kind' in first) return first;
    let read = first.read;
    if (read.kind === 'failed' && read.refused) {
      const recordedAgain = recordedArcCall(ctx, job, 'polishJudge', 2);
      const turn = recordedAgain?.kind === 'result' ? null : repairTurnOf(ctx.runDir, first.called.inv);
      if (recordedAgain?.kind === 'result' || turn !== null) {
        const again = await ask(2, turn === null ? null : { turn, reasons: read.reasons });
        if ('kind' in again) return again;
        read = again.read;
      }
    }
    if (read.kind !== 'judged') return abandon(read.reasons.join('; '), read.interrupted);
    await finish();
    return judge(ctx, unit.id, read.output.decision, 'judged');
  } finally {
    await finish();
  }
}
