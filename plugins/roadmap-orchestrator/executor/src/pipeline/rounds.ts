// Build rounds (plan "Pipeline", R3; DESIGN-1.0.md §4 Fix rounds). The implementer is dispatched in one of
// four rounds (`BuildRound`, transitions.ts):
//
//   fresh    a new session in the unit worktree (created on the unit branch at the integration tip the
//            first time);
//   fix      resume the implementer session with the failing lanes' evidence dirs and any directives (the
//            gate's, or the executor's for a dirty checkout), in the unit worktree at the salvage SHA; the
//            verification checkout of the failed series is removed first, citing its evidence snapshot;
//   resume   the one uncharged resume after a malformed report;
//   resolve  resume after a conflicted merge-in: "resolve and commit".
//
// A resumed session is found from the log, not kept in memory: the latest build invocation of the unit
// whose result reported a session. The implementer keeps its seat for the whole unit (implementerDispatch).
//
// Deadlines. A fix round's window is the measured lane series plus an edit allowance; the allowance and the
// fresh build's deadline are defaults, unmeasured, to re-derive once arc 2 has measured rounds.
//
// Codex resume collision (DESIGN-1.0.md §3 "Codex facts"): a `codex exec resume` that dies at once because
// the thread is still held by a live session is a transient, not a verdict on the unit. `callImplementer`
// retries such a call once, as a new invocation with the same deadline.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { freshClaudeImplementerSession } from '../backends/argv.ts';
import { type ImplementerSessionId, type Sha, type UnitId, invocationId } from '../core/ids.ts';
import { type ImplementerSession, STDERR_FILE } from '../core/records.ts';
import { type AbsPath, type IsoTime, type RefName, branchRef, isoTimeOf } from '../core/values.ts';
import { refTarget, revParse } from '../git/git.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, type BackendCallSpec, type ImplementerDispatch, type StageContext, type StageParent, callBackend, runOp, unitBranch,
  unitWorktree,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { type LaneRecord, type VerificationTree, dirtyPaths, removeVerificationTree, seriesDurationMs } from './lanes.ts';
import type { BuildRound } from './transitions.ts';
import { worktreeCreateOp } from '../recover/ops.ts';

/** Default, unmeasured: what a fix, resume or resolve round may spend editing on top of the lane series. */
export const EDIT_ALLOWANCE_MS = 60 * 60_000;
/** Default, unmeasured: a fresh build's deadline. */
export const FRESH_BUILD_MS = 3 * 60 * 60_000;

export const RESUME_DIRECTIVE = 'Your previous final report did not match the required structured format. Do not change any code: return the structured report for the work in this worktree now.';
export const RESOLVE_DIRECTIVE = 'Integration was merged into this branch and the merge conflicted: resolve and commit. Resolve every conflict in the worktree, then commit the merge on the current branch (no other changes in that commit), run the fast lanes and return your report.';

/** What the caller knows about the round it asks for. */
export type RoundInput =
  | Readonly<{ kind: 'fresh' }>
  | Readonly<{
    kind: 'fix';
    fix: FixRound;
    /** The series the window is measured from. */
    ledger: readonly LaneRecord[];
    /** The failed series' checkout, if it is still there (a gate revise); removed before the round. */
    verification: VerificationTree | null;
    /** The unit worktree must be clean at this commit. */
    salvage: Sha;
  }>
  | Readonly<{ kind: 'resume' }>
  | Readonly<{ kind: 'resolve' }>;

export type PreparedRound = Readonly<{
  kind: BuildRound;
  worktree: AbsPath;
  branch: RefName;
  session: ImplementerSession;
  fixRound: FixRound | null;
  deadlineAt: IsoTime;
}>;

/** The fix round after a red or not-certified series: the failing evidence, and for a dirty checkout, why. */
export function laneFixRound(ledger: readonly LaneRecord[], dirty: readonly string[], salvage: Sha): RoundInput {
  const red = ledger.filter((l) => l.verdict === 'fail');
  if (red.length > 0) return { kind: 'fix', fix: { failingEvidenceDirs: red.flatMap((l) => l.fixDirs), directives: [] }, ledger, verification: null, salvage };
  if (dirty.length === 0) throw new Error('laneFixRound: the series was green and clean; there is nothing to fix');
  return {
    kind: 'fix',
    fix: {
      failingEvidenceDirs: ledger.flatMap((l) => l.fixDirs),
      directives: [`The lanes changed these paths in a clean checkout of your commit: ${dirty.join(', ')}. A lane may write only ignored paths; make the lanes leave every tracked and unignored file as committed.`],
    },
    ledger, verification: null, salvage,
  };
}

/** The fix round after a gate revise (step 12): the gate's directives, over the green series it judged. */
export function gateReviseRound(directives: readonly string[], ledger: readonly LaneRecord[], verification: VerificationTree | null, salvage: Sha): RoundInput {
  if (directives.length === 0) throw new Error('gateReviseRound: a revise always carries directives');
  return { kind: 'fix', fix: { failingEvidenceDirs: [], directives }, ledger, verification, salvage };
}

/**
 * The fix round after a refused or red candidate (step 12): the suite's failing evidence (red) or the
 * executor's directive naming what the transient check refused, over `ledger` (the series the window is
 * measured from); the unit's green verification checkout, if still there, is removed first.
 */
export function candidateFixRound(fix: FixRound, ledger: readonly LaneRecord[], verification: VerificationTree | null, salvage: Sha): RoundInput {
  if (fix.failingEvidenceDirs.length === 0 && fix.directives.length === 0) throw new Error('candidateFixRound: a fix round names failing evidence or directives');
  return { kind: 'fix', fix, ledger, verification, salvage };
}

/** The window of a fix round: the measured lane series plus the edit allowance. */
export function fixWindowMs(ledger: readonly LaneRecord[]): number {
  return seriesDurationMs(ledger) + EDIT_ALLOWANCE_MS;
}

/** The session id of the unit's latest build invocation that reported one, from the log and its result.json. */
export function lastImplementerSession(ctx: StageContext, unit: UnitId): ImplementerSessionId | null {
  const view = ctx.journal.view;
  const spawns = view.opsOf('proc.spawn');
  for (let i = spawns.length - 1; i >= 0; i--) {
    const intent = spawns[i]!;
    const s = intent.expect.subject;
    if (s.purpose !== 'backend' || s.role !== 'build' || s.unit !== unit) continue;
    if (view.doneOf(intent.op)?.outcome.kind !== 'result') continue;
    const inv = invocationId(intent.op, intent.ordinal);
    const result = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('result.json');
    if (result === null || result.type !== 'backend' || result.role !== 'build') throw new Error(`${inv}: a done build spawn without its backend result`);
    if (result.session !== null) return result.session;
  }
  return null;
}

function resumed(ctx: StageContext, unit: UnitId, dispatch: ImplementerDispatch): ImplementerSession {
  const id = lastImplementerSession(ctx, unit);
  if (id === null) throw new Error(`unit ${unit}: a resumed build round, but no earlier build reported a session`);
  return dispatch.triple.backend === 'claude' ? { backend: 'claude', mode: 'resume', id } : { backend: 'codex', mode: 'resume', id };
}

const inMs = (ms: number): IsoTime => isoTimeOf(new Date(Date.now() + ms));

/**
 * How the Codex CLI reports a resume onto a thread another live session still holds. No capture exists:
 * the text is the fragment 0.x matched on the CLI's stderr after arc 1 observed it ("thread already has
 * a..."). Read from stderr and from the CLI's own error events, never from model output.
 */
export const CODEX_RESUME_COLLISION = /thread already/i;
/** Default, unmeasured: how long a collided resume waits for the other session to let go. */
export const COLLISION_RETRY_DELAY_MS = 5_000;

/** A failed Codex resume whose CLI said the thread is held by another live session. */
function resumeCollided(spec: BackendCallSpec, called: BackendCallOutcome): boolean {
  const { request } = spec;
  if (request.kind !== 'implementer' || request.session.backend !== 'codex' || request.session.mode !== 'resume') return false;
  if (called.kind !== 'result' || called.result.outcome.kind === 'success') return false;
  const stderr = readFileSync(join(called.invDir, STDERR_FILE), 'utf8');
  return CODEX_RESUME_COLLISION.test(stderr) || called.result.backendErrors.some((e) => CODEX_RESUME_COLLISION.test(e.message));
}

/** The implementer's call for a round: one retry, as a new invocation, when a Codex resume collided. */
export async function callImplementer(ctx: StageContext, spec: BackendCallSpec): Promise<BackendCallOutcome> {
  const first = await callBackend(ctx, spec);
  if (!resumeCollided(spec, first)) return first;
  await sleep(COLLISION_RETRY_DELAY_MS);
  return callBackend(ctx, spec);
}

/** The unit worktree on the unit branch; created at the integration tip for the unit's first build. */
async function ensureWorktree(ctx: StageContext, unit: UnitId, parent: StageParent): Promise<Readonly<{ worktree: AbsPath; branch: RefName }>> {
  const worktree = unitWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit);
  const branch = unitBranch(ctx.plan.arc, unit);
  if (existsSync(worktree)) return { worktree, branch };
  const existing = refTarget(ctx.repo, branch);
  const at = existing ?? revParse(ctx.repo, branchRef(ctx.plan.integrationBranch));
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit}:unit`, parent, {
    path: worktree, checkout: { type: 'branch', branch, at, createBranch: existing === null },
  });
  return { worktree, branch };
}

/** Everything a build round needs before its invocation: the worktree ready, the session, the fix inputs, the deadline. */
export async function prepareRound(ctx: StageContext, dispatch: ImplementerDispatch, input: RoundInput, parent: StageParent): Promise<PreparedRound> {
  const unit = parent.unit;
  switch (input.kind) {
    case 'fresh': {
      const { worktree, branch } = await ensureWorktree(ctx, unit, parent);
      const session: ImplementerSession = dispatch.triple.backend === 'claude' ? freshClaudeImplementerSession() : { backend: 'codex', mode: 'fresh' };
      return { kind: 'fresh', worktree, branch, session, fixRound: null, deadlineAt: inMs(FRESH_BUILD_MS) };
    }
    case 'fix': {
      if (input.verification !== null) await removeVerificationTree(ctx, input.verification, parent);
      const worktree = unitWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit);
      const head = revParse(worktree, 'HEAD');
      if (head !== input.salvage) throw new Error(`fix round of ${unit}: the unit worktree is at ${head}, not the salvage SHA ${input.salvage}`);
      const dirty = dirtyPaths(worktree);
      if (dirty.length > 0) throw new Error(`fix round of ${unit}: the unit worktree is not clean after salvage: ${dirty.join(', ')}`);
      return {
        kind: 'fix', worktree, branch: unitBranch(ctx.plan.arc, unit), session: resumed(ctx, unit, dispatch), fixRound: input.fix,
        deadlineAt: inMs(fixWindowMs(input.ledger)),
      };
    }
    case 'resume':
    case 'resolve':
      return {
        kind: input.kind,
        worktree: unitWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit),
        branch: unitBranch(ctx.plan.arc, unit),
        session: resumed(ctx, unit, dispatch),
        fixRound: { failingEvidenceDirs: [], directives: [input.kind === 'resume' ? RESUME_DIRECTIVE : RESOLVE_DIRECTIVE] },
        deadlineAt: inMs(EDIT_ALLOWANCE_MS),
      };
  }
}
