// The scaffold stage (dev.17, design pass; DESIGN-1.0.md "Design pass"; SCHEMAS.md "dev.17: the design pass"). A plan-check's
// `scaffold` decision specifies a new system's skeleton (its paths and test paths, entry points, exports, manifest entries and
// one load test); the economy role `scaffold` writes it in the unit worktree before the first build, and code checks it:
//
//   1. Entry: the unit's build entry reservation (its declared resources and `@cpu`), held through the writer's call and
//      released before the dry run (whose lane reserves its own set under the attempt).
//   2. A skeleton this decision already committed (a crash after the commit, before the outcome): `scaffolded`, no call.
//   3. The unit worktree (created at the integration tip on the unit branch, as the first build would) and one fresh call of
//      the `scaffold` seat in it (src/backends/argv.ts `claude-scaffold`), told on a retry why the attempt before was refused.
//   4. Code's checks, every reason together: something was written; every written path lies within the new system's paths or
//      test paths or is a manifest path; every entry point exists. Then the dry run: the tree as written, as a commit object no
//      ref names (a temporary index), its load test's arc lane run once in its own detached checkout
//      (`<unit>.scaffold-<attempt>`, a journey series of this attempt); the lane must exit as declared and its reporter's
//      record show the load test ran (a record of it, selected, not skipped).
//   5. Passed: committed on the unit branch as the unit's first executor-authored commit (`salvage.commit`, the executor's
//      identity, the effective scope and evidence globs as at salvage), `scaffolded`, on to the fresh build. Crash label
//      `scaffold.after-commit`.
//   Refused: `refused{reasons, laneEvidence}` the first time since the decision (the next attempt tries again, its files kept
//   in the worktree); the second time, `plan-defect{reasons}`: an uncharged park naming them.
//
// A crash in the call leaves the attempt to the startup's recovery hold (src/pipeline/unit.ts `holdAbandoned`); it runs again
// as a new attempt over what the worktree holds.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import { crashPoint } from '../core/crash.ts';
import type { StageOutcomeFact } from '../core/events.ts';
import type { ResourceInstance, Sha, UnitId } from '../core/ids.ts';
import { type NeedsUserContent, effectiveScope } from '../core/records.ts';
import { type AbsPath, type RepoPath, absPath, matchesPattern } from '../core/values.ts';
import { git, revParse } from '../git/git.ts';
import { type SalvageRules, planSalvage } from '../git/salvage.ts';
import { type ArcLaneDef } from '../holistic/types.ts';
import type { PlanUnit } from '../input/plan.ts';
import { renderPrompt, promptFor } from '../prompts/index.ts';
import { type ScaffoldDecision, SCAFFOLD_SCHEMA, validateScaffoldOutput } from '../prompts/schemas.ts';
import { cleanup } from '../resources/reserve.ts';
import { renderSpec } from '../spec/render.ts';
import { salvageCommitOp } from '../recover/ops.ts';
import {
  type BackendCallOutcome, type Cancelled, type StageContext, type StageParent, callBackend, dispatchOf, enter, evidenceRoot, isCancelled, minutesMs, runPrepared,
  scaffoldDispatch, unitBranch, verdictOf,
} from './dispatch.ts';
import { arcJourneyLane, dirtyPaths, laneRuntime, runJourneySeries } from './lanes.ts';
import { ensureWorktree } from './rounds.ts';
import {
  type StageDone, at, buildEntry, executorIdentity, failedFacts, holdEntry, holisticInForce, inMs, judgedAnswer, loadUnitSpec, planCheckAnswerOf, record, stageHolder, start,
} from './stages.ts';

/** The scaffold writer's window: a skeleton is small. */
export const SCAFFOLD_MINUTES = 30;

/** The detached checkout a scaffold attempt dry-runs its load test in. */
export const scaffoldCheckout = (ctx: StageContext, parent: StageParent): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${parent.unit}.scaffold-${parent.attempt}`));

/** The `scaffold` decision the unit's latest plan-check took (a bug when it took another). */
export function scaffoldDecisionOf(ctx: StageContext, unit: UnitId): ScaffoldDecision {
  const out = planCheckAnswerOf(ctx, unit);
  if (out?.decision !== 'scaffold') throw new Error(`unit ${unit} is at its scaffold stage, but its latest plan-check decided ${out?.decision ?? 'nothing'}`);
  return out.scaffold;
}

/** The scaffold attempts refused since the decision this attempt carries out: each `refused` scaffold outcome after it. */
function refusedSince(ctx: StageContext, unit: UnitId): readonly StageOutcomeFact[] {
  const d = ctx.journal.view.unit(unit).decided;
  return d !== null && d.stage === 'scaffold' && d.outcome === 'refused' ? [d] : [];
}

/**
 * The done `salvage.commit` of a scaffold attempt after the unit's latest plan-check (attempts are numbered across a unit's
 * stages): a skeleton already committed, whose attempt a crash cut short before its outcome.
 */
function committedSkeleton(ctx: StageContext, unit: UnitId): Sha | null {
  const view = ctx.journal.view;
  const attemptOf = (p: { readonly type: string; readonly attempt?: number }): number => (p.type === 'stage' ? p.attempt ?? 0 : 0);
  const since = view.opsOf('proc.spawn').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'plan-check').map((i) => attemptOf(i.parent)).at(-1) ?? 0;
  const latest = view.opsOf('salvage.commit')
    .filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'scaffold' && view.doneOf(i.op) !== null && attemptOf(i.parent) > since).at(-1);
  return latest === undefined ? null : latest.post.new;
}

/** Why the written tree fails code's path checks (step 4, before the dry run). */
function pathReasons(worktree: AbsPath, decision: ScaffoldDecision, written: readonly RepoPath[]): readonly string[] {
  if (written.length === 0) return ['the scaffold writer wrote nothing'];
  const allowed = [...decision.newSystem.paths, ...decision.newSystem.tests];
  const manifest = new Set<string>(decision.manifest.map((m) => m.path));
  const outside = written.filter((p) => !manifest.has(p) && !allowed.some((g) => matchesPattern(p, g)));
  const reasons = outside.length === 0 ? [] : [`it wrote ${outside.join(', ')}, outside ${decision.newSystem.name}'s paths and test paths and the manifest files`];
  const present = new Set(git(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter((f) => f !== ''));
  const missing = decision.entryPoints.filter((e) => !present.has(e));
  if (missing.length > 0) reasons.push(`entry point${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist`);
  return reasons;
}

/** The written tree as a commit no ref names, on the worktree's HEAD (a temporary index, the worktree's own untouched). */
function dryRunCommit(ctx: StageContext, parent: StageParent, worktree: AbsPath): Sha {
  const dir = evidenceRoot(ctx.runDir, parent);
  mkdirSync(dir, { recursive: true });
  const index = absPath(join(dir, 'scaffold.index'));
  rmSync(index, { force: true });
  git(worktree, ['read-tree', 'HEAD'], { indexFile: index });
  git(worktree, ['add', '--all', '--', '.'], { indexFile: index });
  const tree = git(worktree, ['write-tree'], { indexFile: index }).trim();
  rmSync(index, { force: true });
  return revParse(worktree, git(worktree, ['commit-tree', tree, '-p', 'HEAD', '-m', `roadmap ${ctx.plan().arc}: scaffold dry run of unit ${parent.unit}\n`], { identity: executorIdentity() }).trim());
}

type DryRun =
  | Readonly<{ kind: 'passed' }>
  | Readonly<{ kind: 'failed'; reasons: readonly string[]; laneEvidence: AbsPath | null }>
  | Readonly<{ kind: 'ended'; done: 'interrupted' | 'occupied' | 'cleanup-failed'; needsUser: NeedsUserContent | null; failed: readonly ResourceInstance[] }>;

/** Step 4's dry run of the load test's arc lane at `at`. */
async function dryRun(ctx: StageContext, parent: StageParent, decision: ScaffoldDecision, lane: ArcLaneDef, at: Sha): Promise<DryRun> {
  const series = await runJourneySeries(ctx, { type: 'unit', parent, rt: laneRuntime(ctx, parent.unit) }, [arcJourneyLane(lane)], {
    path: scaffoldCheckout(ctx, parent), checkout: { type: 'detached', at },
  }, { reuse: false, stop: () => false });
  switch (series.end.kind) {
    case 'interrupted':
      return { kind: 'ended', done: 'interrupted', needsUser: null, failed: [] };
    case 'occupied':
      return { kind: 'ended', done: 'occupied', needsUser: series.end.needsUser, failed: [] };
    case 'cleanup-failed':
      return { kind: 'ended', done: 'cleanup-failed', needsUser: null, failed: series.end.failed };
    case 'blocked':
      return { kind: 'failed', reasons: [`the load test's lane ${lane.id} gave no verdict: ${series.end.detail}`], laneEvidence: null };
    case 'ran':
      break;
  }
  const run = series.runs[0];
  if (run === undefined) throw new Error(`${parent.unit} scaffold#${parent.attempt}: a dry run that ran no lane`);
  const reasons: string[] = [];
  if (run.verdict !== 'pass') reasons.push(`the load test's lane ${lane.id} did not exit ${lane.expectedExit} as declared (${run.verdict})`);
  const test = run.record?.records.find((r) => r.testId === decision.loadTest.testId);
  if (test === undefined || test.selected === 0 || test.outcome === 'skip' || test.outcome === 'zero-selected') {
    reasons.push(`the lane's reporter does not show the load test ${JSON.stringify(decision.loadTest.testId)} ran${test === undefined ? '' : ` (${test.outcome})`}`);
  }
  return reasons.length === 0 ? { kind: 'passed' } : { kind: 'failed', reasons, laneEvidence: run.dir };
}

/** The blocking item of a scaffold's `plan-defect` park. */
function defectNeedsUser(unit: PlanUnit, reasons: readonly string[]): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'plan-defect',
    summary: `Unit ${unit.id}: its scaffold was refused twice: ${reasons.join('; ')}. The unit is parked, uncharged.`,
    recommendation: `Fix the plan (the load test's lane, the new system's paths) with \`roadmap apply\`, then \`roadmap resume ${unit.id}\` runs the scaffold again; or revise the spec so its plan-check approves without a scaffold.`,
    options: [],
    evidence: [],
  };
}

export async function scaffold(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'scaffold'> | Cancelled> {
  const parent = at(start(ctx, unit.id, 'scaffold'), 'scaffold');
  const entered = await enter(ctx, stageHolder(parent), buildEntry(ctx, unit));
  if (isCancelled(entered)) return entered;
  const held = await holdEntry(ctx, parent);
  if (held.kind === 'occupied') return record(ctx, parent, 'occupied', held.needsUser);
  if (held.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(held.failed));
  // The entry reservation is released once: before the dry run (its lane takes its own reservation under this attempt), or
  // before the outcome of an attempt that ends earlier.
  let holding = held.reservation;
  const release = async (done: () => StageDone<'scaffold'>): Promise<StageDone<'scaffold'>> => {
    const cleaned = holding === null ? null : await cleanup(ctx, holding, parent);
    holding = null;
    if (cleaned?.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed));
    return done();
  };
  // Step 2: a skeleton committed before a crash cut the attempt that committed it short.
  if (committedSkeleton(ctx, unit.id) !== null) return release(() => record(ctx, parent, 'scaffolded'));
  const decision = scaffoldDecisionOf(ctx, unit.id);
  const seated = scaffoldDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') return release(() => record(ctx, parent, 'routing-changed', seated.needsUser));
  const lane = holisticInForce(ctx).obligations?.lanes.find((l) => l.id === decision.loadTest.lane);
  const refused = refusedSince(ctx, unit.id);
  const prior = refused.at(-1)?.detail;
  const defect = (reasons: readonly string[]): Promise<StageDone<'scaffold'>> =>
    release(() => record(ctx, parent, 'plan-defect', defectNeedsUser(unit, reasons), undefined, undefined, { kind: 'design-defect', reasons }));
  const refuse = (reasons: readonly string[], laneEvidence: AbsPath | null): Promise<StageDone<'scaffold'>> => (refused.length > 0
    ? defect(reasons)
    : release(() => record(ctx, parent, 'refused', null, undefined, undefined, { kind: 'scaffold-refused', reasons, laneEvidence })));
  // The load test's lane left the arc lanes since the decision (an apply): no dry run can pass.
  if (lane === undefined) return defect([`the load test's lane ${decision.loadTest.lane} is no arc lane in force`]);

  const { worktree } = await ensureWorktree(ctx, unit.id, parent);
  const { spec } = loadUnitSpec(ctx, unit);
  const prompt = promptFor('scaffold', seated.dispatch.triple.model);
  const measured = renderPrompt(prompt, {
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, scaffold: decision, worktree,
    loadLane: { id: lane.id, argv: lane.argv, cwd: lane.cwd, testPaths: lane.testPaths ?? [] },
    retry: prior?.kind === 'scaffold-refused' ? { reasons: prior.reasons, laneEvidence: prior.laneEvidence } : null,
  });
  const called: BackendCallOutcome = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'scaffold', dispatch: seated.dispatch, session: freshJudgmentSession() },
    system: prompt.system, ...measured, schema: SCAFFOLD_SCHEMA, cwd: worktree, deadlineAt: inMs(minutesMs(SCAFFOLD_MINUTES)),
  });
  const v = verdictOf(ctx, parent, called);
  if (v.kind === 'interrupted') return release(() => record(ctx, parent, 'interrupted', v.needsUser, undefined, v.cause ?? undefined));
  if (v.kind === 'refusal') return release(() => record(ctx, parent, 'refusal'));
  if (v.kind === 'context-exceeded') return release(() => record(ctx, parent, 'context-exceeded', null, undefined, undefined, { kind: 'context-exceeded', inv: v.inv, promptBytes: v.promptBytes }));
  if (v.kind === 'process-fault') {
    return release(() => record(ctx, parent, called.kind === 'lost' ? 'lost' : 'process-fault', null, { backend: seated.dispatch.triple.backend, failed: [], environment: null }));
  }
  const answer = judgedAnswer(called, validateScaffoldOutput);
  if (v.kind === 'malformed' || answer.kind !== 'answered') return refuse([`the scaffold writer's report does not match its schema${v.kind === 'malformed' ? `: ${v.detail}` : ''}`], null);

  // Step 4: code's checks.
  const written = dirtyPaths(worktree);
  const reasons = pathReasons(worktree, decision, written);
  if (reasons.length > 0) return refuse(reasons, null);
  if (holding !== null) {
    const cleaned = await cleanup(ctx, holding, parent);
    holding = null;
    if (cleaned.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed));
  }
  const ran = await dryRun(ctx, parent, decision, lane, dryRunCommit(ctx, parent, worktree));
  if (ran.kind === 'ended') {
    if (ran.done === 'interrupted') return release(() => record(ctx, parent, 'interrupted'));
    if (ran.done === 'occupied') return release(() => record(ctx, parent, 'occupied', ran.needsUser));
    return record(ctx, parent, 'cleanup-failed', null, failedFacts(ran.failed));
  }
  if (ran.kind === 'failed') return refuse(ran.reasons, ran.laneEvidence);

  // Step 5: the unit's first executor-authored commit.
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const rules: SalvageRules = { scope: effectiveScope(pinned), excluded: [...new Set(spec.lanes.flatMap((l) => l.evidenceGlobs))].sort(), rejectedRoot: absPath(join(ctx.runDir, 'rejected', unit.id)) };
  const op = salvageCommitOp(rules);
  const decided = planSalvage(rules, {
    worktree, branch: unitBranch(ctx.plan().arc, unit.id), identity: executorIdentity(),
    message: `roadmap ${ctx.plan().arc}: scaffold of unit ${unit.id} (${decision.newSystem.name})\n`,
  });
  if (decided.kind === 'no-change') throw new Error(`${unit.id} scaffold#${parent.attempt}: a dry-run tree with written paths, but nothing to commit`);
  await runPrepared(ctx.journal, op, `salvage:${unit.id}`, parent, await op.prepare(decided.plan));
  crashPoint('scaffold.after-commit', unit.id);
  return release(() => record(ctx, parent, 'scaffolded'));
}
