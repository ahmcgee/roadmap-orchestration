// The proof-of-concept stage (dev.17, design pass; DESIGN-1.0.md "Design pass"; SCHEMAS.md "dev.17: the design pass"). A
// plan-check's `poc` decision asks questions reading cannot settle; the unit's builder seat answers them by building in a
// throwaway worktree, and a fresh plan-check decides with the report. At most `POC_LIMIT` per unit, uncharged
// (src/pipeline/design.ts). In order:
//
//   1. Entry: the unit's build entry reservation (its declared resources and `@cpu`), released at the stage's end. Plan
//      environments are not brought up for a PoC (BACKLOG "PoC environments"): it builds and runs what needs none.
//   2. Leftover checkouts of an earlier PoC attempt a crash cut short are snapshotted and removed first.
//   3. A detached checkout of the integration tip, `<worktreeRoot>/<arc>/<unit>.poc-<attempt>` (no branch: nothing it holds can
//      merge), and one fresh call of the unit's implementer seat in it (`pocPromptFor`, `POC_SCHEMA`), its evidence dir
//      `<run>/work/<unit>/<attempt>-poc/`, told the lessons of the unit's earlier PoCs.
//   4. The diff the PoC made against the tip, untracked files included, written to `<evidence root>/poc.diff`.
//   5. Its report, written once to `<evidence root>/poc-report.json` (`PocReport`): the questions, the closed answer
//      (`pocOutputFor`: one answer per question) or why there is none, and the diff's path. Crash label `poc.after-report`.
//   6. The checkout snapshotted (its dirty files) and removed (crash label `poc.after-cleanup`), the reservation released;
//      `answered` or `unanswered`, on to a fresh plan-check either way.
// A crash after the report (5 or 6) is finished by the next attempt from the report: the checkout removed if it is still
// there and the outcome recorded, the builder never asked again (`reportSince`).
//
// The plan-check reads every report of the unit (`pocReports`); the build is told their lessons, never their code
// (`pocLessons`, src/pipeline/stages.ts `planCheckNotes`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { durableMkdir, exclusivePublish } from '../core/fsx.ts';
import type { Sha, UnitId } from '../core/ids.ts';
import { type Read, arrayOf, nullable, object, positive, str } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { git } from '../git/git.ts';
import type { PlanUnit } from '../input/plan.ts';
import { pocPromptFor } from '../prompts/index.ts';
import { type PocDecision, type PocQuestion, pocOutputFor } from '../prompts/schemas.ts';
import type { PocReport } from '../prompts/inputs.ts';
import { pocQuestionId } from '../core/ids.ts';
import { cleanup } from '../resources/reserve.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { renderSpec } from '../spec/render.ts';
import {
  type BackendCallOutcome, type Cancelled, type StageContext, type StageParent, callBackend, enter, evidenceRoot, implementerDispatch, isCancelled, minutesMs, runOp, verdictOf,
  workDir,
} from './dispatch.ts';
import { freshSession } from './rounds.ts';
import {
  type StageDone, at, buildEntry, failedFacts, holdEntry, inMs, integrationTip, judgedAnswer, loadUnitSpec, planCheckAnswerOf, record, removeJudgmentCheckouts, stageHolder, start,
} from './stages.ts';

/** A PoC's window. */
export const POC_MINUTES = 60;
/** The report file a PoC attempt writes under its evidence root. */
export const POC_REPORT_FILE = 'poc-report.json';
/** The diff file a PoC attempt writes under its evidence root. */
export const POC_DIFF_FILE = 'poc.diff';

const pocQuestion: Read<PocQuestion> = object((f) => ({ id: f.get('id', (v, p) => pocQuestionId(v, p)), question: f.get('question', str), whyItMatters: f.get('whyItMatters', str) }));
const pocReport: Read<PocReport> = object((f) => {
  const questions = f.get('questions', arrayOf(pocQuestion, { nonEmpty: true }));
  return {
    attempt: f.get('attempt', positive),
    questions,
    brief: f.get('brief', str),
    answer: f.get('answer', nullable(pocOutputFor(questions.map((q) => q.id)))),
    why: f.get('why', nullable(str)),
    diff: f.get('diff', (v, p) => absPath(v, p)),
  };
});

/** A PoC attempt's detached checkout of the integration tip. */
export const pocWorktree = (ctx: StageContext, parent: StageParent): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${parent.unit}.poc-${parent.attempt}`));

/** The `poc` decision the unit's latest plan-check took (a bug when it took another). */
export function pocDecisionOf(ctx: StageContext, unit: UnitId): PocDecision {
  const out = planCheckAnswerOf(ctx, unit);
  if (out?.decision !== 'poc') throw new Error(`unit ${unit} is at its poc stage, but its latest plan-check decided ${out?.decision ?? 'nothing'}`);
  return out.poc;
}

/** Every PoC report of the unit, in attempt order (`POC_REPORT_FILE` under each poc attempt's evidence root). */
export function pocReports(ctx: Pick<StageContext, 'journal' | 'runDir'>, unit: UnitId): readonly PocReport[] {
  const view = ctx.journal.view;
  const attempts = [...new Set(view.opsOf('worktree.create').flatMap((i) => (i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'poc' ? [i.parent.attempt] : [])))].sort((a, b) => a - b);
  return attempts.flatMap((attempt) => {
    const file = join(evidenceRoot(ctx.runDir, { type: 'stage', unit, stage: 'poc', attempt }), POC_REPORT_FILE);
    return existsSync(file) ? [pocReport(JSON.parse(readFileSync(file, 'utf8')), file)] : [];
  });
}

/** The lessons of every answered PoC of the unit, in order: what its builder is told (never the PoC's code). */
export const pocLessons = (ctx: Pick<StageContext, 'journal' | 'runDir'>, unit: UnitId): readonly string[] =>
  pocReports(ctx, unit).flatMap((r) => r.answer?.lessons ?? []);

/** Step 4: the PoC's diff against `tip` (untracked files included, through the throwaway checkout's own index) into `dest`. */
function writeDiff(worktree: AbsPath, tip: Sha, dest: AbsPath): void {
  git(worktree, ['add', '--all', '--', '.']);
  writeFileSync(dest, git(worktree, ['diff', '--cached', '--binary', tip]));
}

/**
 * The report of a PoC attempt since the unit's latest plan-check (attempts are numbered across a unit's stages) that a crash
 * cut short after writing it: that PoC ran, and its outcome is recorded from the report, never asked again. Null otherwise.
 */
function reportSince(ctx: StageContext, unit: UnitId): PocReport | null {
  const view = ctx.journal.view;
  const checks = view.opsOf('proc.spawn').flatMap((i) => (i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'plan-check' ? [i.parent.attempt] : []));
  const since = checks.at(-1) ?? 0;
  return pocReports(ctx, unit).filter((r) => r.attempt > since).at(-1) ?? null;
}

export async function poc(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'poc'> | Cancelled> {
  const parent = at(start(ctx, unit.id, 'poc'), 'poc');
  // A PoC whose report a crash left unrecorded: its checkout goes (if the crash kept it) and its report is the outcome.
  const ran = reportSince(ctx, unit.id);
  if (ran !== null) {
    await removeJudgmentCheckouts(ctx, unit.id, parent);
    return record(ctx, parent, ran.answer === null ? 'unanswered' : 'answered');
  }
  const entered = await enter(ctx, stageHolder(parent), buildEntry(ctx, unit));
  if (isCancelled(entered)) return entered;
  const held = await holdEntry(ctx, parent);
  if (held.kind === 'occupied') return record(ctx, parent, 'occupied', held.needsUser);
  if (held.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(held.failed));
  const release = async (done: () => StageDone<'poc'>): Promise<StageDone<'poc'>> => {
    const cleaned = held.reservation === null ? null : await cleanup(ctx, held.reservation, parent);
    if (cleaned?.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(cleaned.failed));
    return done();
  };
  const seated = implementerDispatch(ctx, unit.id);
  if (seated.kind !== 'pinned') return release(() => record(ctx, parent, 'routing-changed', seated.needsUser));
  const decision = pocDecisionOf(ctx, unit.id);
  // Step 2: a crashed attempt's checkout goes first; this attempt makes its own.
  await removeJudgmentCheckouts(ctx, unit.id, parent);
  const tip = integrationTip(ctx);
  const worktree = pocWorktree(ctx, parent);
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit.id}:poc`, parent, { path: worktree, checkout: { type: 'detached', at: tip } });
  const work = workDir(ctx.runDir, parent);
  durableMkdir(work);
  const { spec } = loadUnitSpec(ctx, unit);
  const prompt = pocPromptFor(seated.dispatch.triple.model);
  const called: BackendCallOutcome = await callBackend(ctx, {
    unit: unit.id, parent,
    request: { kind: 'implementer', dispatch: seated.dispatch, session: freshSession(seated.dispatch), evidenceDirs: [work], mcpConfig: null },
    system: prompt.system,
    rendered: prompt.render({
      spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, brief: decision.brief, questions: decision.questions, worktree, tip, evidenceDir: work,
      lessons: pocLessons(ctx, unit.id),
    }),
    schema: prompt.schema, cwd: worktree, deadlineAt: inMs(minutesMs(POC_MINUTES)),
  });
  const v = verdictOf(ctx, parent, called);
  // Step 4: the diff kept as evidence (whatever the call ended with).
  const root = evidenceRoot(ctx.runDir, parent);
  durableMkdir(root);
  const diff = absPath(join(root, POC_DIFF_FILE));
  if (existsSync(worktree)) writeDiff(worktree, tip, diff);
  else writeFileSync(diff, '');
  const settled = async (done: () => StageDone<'poc'>): Promise<StageDone<'poc'>> => {
    await removeJudgmentCheckouts(ctx, unit.id, parent);
    crashPoint('poc.after-cleanup', unit.id);
    return release(done);
  };
  if (v.kind === 'interrupted') return settled(() => record(ctx, parent, 'interrupted', v.needsUser, undefined, v.cause ?? undefined));
  if (v.kind === 'context-exceeded') return settled(() => record(ctx, parent, 'context-exceeded', null, undefined, undefined, { kind: 'context-exceeded', inv: v.inv, promptBytes: v.promptBytes }));
  if (v.kind === 'process-fault' && called.kind !== 'lost') return settled(() => record(ctx, parent, 'process-fault', null, { backend: seated.dispatch.triple.backend, failed: [], environment: null }));
  // Step 5: the report, before the checkout goes, so a crash after it records this PoC from it.
  const answer = judgedAnswer(called, (value) => pocOutputFor(decision.questions.map((q) => q.id))(value, 'poc'));
  const why = answer.kind === 'answered' ? null : answer.kind === 'refused' ? answer.reasons.join('; ') : v.kind === 'success' ? 'no answer' : `${v.kind}: ${'detail' in v ? v.detail : ''}`;
  const report: PocReport = { attempt: parent.attempt, questions: decision.questions, brief: decision.brief, answer: answer.kind === 'answered' ? answer.out : null, why, diff };
  exclusivePublish(join(root, POC_REPORT_FILE), `${JSON.stringify(report)}\n`);
  crashPoint('poc.after-report', unit.id);
  return settled(() => record(ctx, parent, report.answer === null ? 'unanswered' : 'answered'));
}
