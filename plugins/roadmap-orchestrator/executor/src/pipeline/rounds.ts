// Build rounds (plan "Pipeline", R3; DESIGN-1.0.md §4 Fix rounds). The implementer is dispatched in one of
// five rounds: the four a decision asks for (`BuildRound`, transitions.ts) and `continue`:
//
//   fresh     a new session in the unit worktree (created on the unit branch at the integration tip the
//             first time); after a reopen (the architect edited the spec of a parked unit), the unit's
//             latest implementer session is resumed instead, told by RESPEC_DIRECTIVE that the spec it
//             now reads was amended and that the worktree holds its earlier work;
//   fix       resume the implementer session with the failing lanes' evidence dirs and any directives (the
//             gate's, or the executor's for a dirty checkout), in the unit worktree at the salvage SHA; the
//             verification checkout of the failed series is removed first, citing its evidence snapshot;
//   resume    the one uncharged resume after a malformed report;
//   resolve   resume after a conflicted merge-in: "resolve and commit";
//   continue  the round after an interrupted build attempt (a pause, a stop, a backend park), whatever that
//             attempt's round was, a continue included: it resumes the interrupted invocation's own session
//             in the unit worktree exactly as left (uncommitted changes, no reset, no salvage-SHA check, no
//             checkout removal) with CONTINUE_DIRECTIVE alone, the session holding the spec and any fix
//             inputs already. It keeps the decided round's window, and a continued resolve must still leave
//             the merge committed (stages.ts). The driver asks for it from the fold (`UnitState.interrupted`).
//
// A session is read from the log, not kept in memory: `invocationSession` is the one reading of the session
// of a build invocation, from its result.json, where the adapter recorded the id launch.json assigned (every
// Claude session, every resume) or the thread id a fresh Codex exec reported on stdout (`thread.started`),
// also for an invocation killed mid-run. A fix, resume or resolve round resumes the latest build invocation
// of the unit that has a session (`lastImplementerSession`); a continue resumes the interrupted one. When
// there is none (the unit's builds were lost with tree effects, a fresh build was malformed without
// reporting one, or a fresh Codex exec was interrupted before its thread started), or that session ran on
// another implementer seat (a plan-check raised the risk after a build, and the raised seat binds another
// model or backend: a session cannot move across them), the round starts a fresh session instead, on the
// kept branch and worktree, with the same inputs plus NO_SESSION_NOTE (a continue: its decided round's
// inputs, then NO_SESSION_NOTE and CONTINUE_DIRECTIVE; a reopen's fresh round: RESPEC_DIRECTIVE, then
// NO_SESSION_NOTE); the round keeps its kind, and its launch.json records the session as fresh. A session's
// seat is the `implementerSeatRev` of the dispatch fact its spawn ran under (`spawnSeatRev`); a routing
// change never moves the seat of a unit whose build started (implementerDispatch parks it instead).
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
import type { IntentOf } from '../core/events.ts';
import { type ImplementerSessionId, type InvocationId, type SeatRev, type Sha, type UnitId, invocationId, parseInvocationId } from '../core/ids.ts';
import { type ImplementerSession, STDERR_FILE } from '../core/records.ts';
import { type AbsPath, type IsoTime, type RefName, branchRef, isoTimeOf } from '../core/values.ts';
import { refTarget, revParse } from '../git/git.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { DECISIONS_FILE } from '../prompts/schemas.ts';
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
export const NO_SESSION_NOTE = 'No earlier session of yours exists for this unit, so this is a fresh session: the worktree holds the work done so far. Read it before you change anything.';
export const RESOLVE_DIRECTIVE = 'Integration was merged into this branch and the merge conflicted: resolve and commit. Resolve every conflict in the worktree, then commit the merge on the current branch (no other changes in that commit), run the fast lanes and return your report.';
export const RESPEC_DIRECTIVE = 'The architect amended this unit\'s spec after your earlier work on it; the spec in this message is the amended revision and replaces the one you worked from. The worktree holds your earlier work, committed. Bring the work in line with the amended spec, run the fast lanes and return your report.';
export const CONTINUE_DIRECTIVE = `You were paused partway through this task and are now resumed. The worktree holds your work so far, including uncommitted changes. Continue from where you stopped; do not restart. The evidence directory named in this message is new: rewrite ${DECISIONS_FILE} there, complete, with every decision so far.`;

/** What a decision asks for: one of the table's rounds, with the inputs its kind needs. */
export type DecidedRound =
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

/** What the caller knows about the round it asks for: a decided round, or the continue of an interrupted one. */
export type RoundInput =
  | DecidedRound
  | Readonly<{
    kind: 'continue';
    /** The round the decision asked for, which the interrupted attempt ran (or itself continued). */
    of: DecidedRound;
    /** The interrupted attempt's last build invocation: its session is the one continued. */
    interrupted: InvocationId;
  }>;

export type PreparedRound = Readonly<{
  worktree: AbsPath;
  branch: RefName;
  session: ImplementerSession;
  fixRound: FixRound | null;
  /** Directories outside the worktree the session reads: the failing evidence of the fix round it runs or continues. */
  evidenceDirs: readonly AbsPath[];
  deadlineAt: IsoTime;
}>;

/** The decided round a round input runs under: its own, or the one a continue continues. */
export function decidedRound(input: RoundInput): BuildRound {
  return input.kind === 'continue' ? input.of.kind : input.kind;
}

/** The fix round after a red or not-certified series: the failing evidence, and for a dirty checkout, why. */
export function laneFixRound(ledger: readonly LaneRecord[], dirty: readonly string[], salvage: Sha): DecidedRound {
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
export function gateReviseRound(directives: readonly string[], ledger: readonly LaneRecord[], verification: VerificationTree | null, salvage: Sha): DecidedRound {
  if (directives.length === 0) throw new Error('gateReviseRound: a revise always carries directives');
  return { kind: 'fix', fix: { failingEvidenceDirs: [], directives }, ledger, verification, salvage };
}

/**
 * The fix round after a refused or red candidate (step 12): the suite's failing evidence (red) or the
 * executor's directive naming what the transient check refused, over `ledger` (the series the window is
 * measured from); the unit's green verification checkout, if still there, is removed first.
 */
export function candidateFixRound(fix: FixRound, ledger: readonly LaneRecord[], verification: VerificationTree | null, salvage: Sha): DecidedRound {
  if (fix.failingEvidenceDirs.length === 0 && fix.directives.length === 0) throw new Error('candidateFixRound: a fix round names failing evidence or directives');
  return { kind: 'fix', fix, ledger, verification, salvage };
}

/** The window of a fix round: the measured lane series plus the edit allowance. */
export function fixWindowMs(ledger: readonly LaneRecord[]): number {
  return seriesDurationMs(ledger) + EDIT_ALLOWANCE_MS;
}

/**
 * The implementer session of build invocation `inv`, from its result.json: the id launch.json assigned, or a
 * fresh Codex thread's id from stdout (adapter.ts); null when a fresh Codex exec never started its thread.
 */
export function invocationSession(ctx: StageContext, inv: InvocationId): ImplementerSessionId | null {
  const result = runnerFiles(invocationDir(ctx.runDir, inv), inv).read('result.json');
  if (result === null || result.type !== 'backend' || result.role !== 'build') throw new Error(`${inv}: a build invocation without its backend result`);
  return result.session;
}

/** An implementer session and the implementer seat it ran on. */
export type SeatedSession = Readonly<{ id: ImplementerSessionId; seatRev: SeatRev }>;

/**
 * The implementer seat a build spawn ran on: the `implementerSeatRev` of the unit's dispatch fact it was
 * spawned under (the spawn names that fact's `routingRev` and floor as its own `routingRev` and `tier`).
 */
function spawnSeatRev(ctx: StageContext, intent: IntentOf<'proc.spawn'>): SeatRev {
  const s = intent.expect.subject;
  if (s.purpose !== 'backend' || s.role !== 'build') throw new Error(`${intent.op}: not a build spawn`);
  const pinned = ctx.journal.view.dispatchesOf(s.unit).filter((d) => d.routingRev === s.routingRev && d.riskFloor === s.tier).at(-1);
  if (pinned === undefined) throw new Error(`${intent.op}: a build spawn under routingRev ${s.routingRev} at ${s.tier} with no dispatch fact of ${s.unit} pinning it`);
  return pinned.implementerSeatRev;
}

/** The session of build invocation `inv` with its seat, or null when it has no session. */
function seatedSessionOf(ctx: StageContext, intent: IntentOf<'proc.spawn'>, inv: InvocationId): SeatedSession | null {
  const id = invocationSession(ctx, inv);
  return id === null ? null : { id, seatRev: spawnSeatRev(ctx, intent) };
}

/** The session of the unit's latest build invocation that has one, with its seat, from the log and `invocationSession`. */
export function lastImplementerSession(ctx: StageContext, unit: UnitId): SeatedSession | null {
  const view = ctx.journal.view;
  const spawns = view.opsOf('proc.spawn');
  for (let i = spawns.length - 1; i >= 0; i--) {
    const intent = spawns[i]!;
    const s = intent.expect.subject;
    if (s.purpose !== 'backend' || s.role !== 'build' || s.unit !== unit) continue;
    if (view.doneOf(intent.op)?.outcome.kind !== 'result') continue;
    const session = seatedSessionOf(ctx, intent, invocationId(intent.op, intent.ordinal));
    if (session !== null) return session;
  }
  return null;
}

/**
 * The session a round on `dispatch` may resume: `earlier` when it ran on the same implementer seat, else null.
 * A session cannot move across models or backends, so a build whose seat moved (a plan-check risk raise
 * after a build) starts a fresh session on the kept branch and worktree, its round's inputs given with
 * NO_SESSION_NOTE.
 */
function onSeat(dispatch: ImplementerDispatch, earlier: SeatedSession | null): ImplementerSessionId | null {
  return earlier !== null && earlier.seatRev === dispatch.seatRev ? earlier.id : null;
}

function freshSession(dispatch: ImplementerDispatch): ImplementerSession {
  return dispatch.triple.backend === 'claude' ? freshClaudeImplementerSession() : { backend: 'codex', mode: 'fresh' };
}

/** A resume of session `id`, or a fresh session when there is none. */
function sessionOf(dispatch: ImplementerDispatch, id: ImplementerSessionId | null): ImplementerSession {
  if (id === null) return freshSession(dispatch);
  return dispatch.triple.backend === 'claude' ? { backend: 'claude', mode: 'resume', id } : { backend: 'codex', mode: 'resume', id };
}

/** The session and inputs of a round that resumes session `id` with `fix`; with no session, a fresh one told so by NO_SESSION_NOTE. */
function resumed(dispatch: ImplementerDispatch, id: ImplementerSessionId | null, fix: FixRound): Readonly<{ session: ImplementerSession; fixRound: FixRound }> {
  return { session: sessionOf(dispatch, id), fixRound: id === null ? { ...fix, directives: [...fix.directives, NO_SESSION_NOTE] } : fix };
}

/** The inputs a decided round gives its session, beyond the spec: a fix round's evidence and directives, or a resume's directive. */
function roundInputs(round: DecidedRound): FixRound | null {
  switch (round.kind) {
    case 'fresh': return null;
    case 'fix': return round.fix;
    case 'resume': return { failingEvidenceDirs: [], directives: [RESUME_DIRECTIVE] };
    case 'resolve': return { failingEvidenceDirs: [], directives: [RESOLVE_DIRECTIVE] };
  }
}

/** The window of a decided round: a fresh build's deadline, a fix round's window, or the edit allowance. */
function windowMs(round: DecidedRound): number {
  switch (round.kind) {
    case 'fresh': return FRESH_BUILD_MS;
    case 'fix': return fixWindowMs(round.ledger);
    case 'resume':
    case 'resolve': return EDIT_ALLOWANCE_MS;
  }
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
  const worktree = unitWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit);
  const branch = unitBranch(ctx.plan.arc, unit);
  const deadlineAt = inMs(windowMs(input.kind === 'continue' ? input.of : input));
  switch (input.kind) {
    case 'fresh': {
      const ready = await ensureWorktree(ctx, unit, parent);
      // Only a reopen leads to a second fresh round, and the unit keeps its implementer session across it
      // (on the same seat: a moved seat gets a fresh session, told the worktree holds the earlier work).
      const earlier = ctx.journal.view.unit(unit).reopened === null ? null : lastImplementerSession(ctx, unit);
      if (earlier === null) return { ...ready, session: freshSession(dispatch), fixRound: null, evidenceDirs: [], deadlineAt };
      return { ...ready, ...resumed(dispatch, onSeat(dispatch, earlier), { failingEvidenceDirs: [], directives: [RESPEC_DIRECTIVE] }), evidenceDirs: [], deadlineAt };
    }
    case 'fix': {
      if (input.verification !== null) await removeVerificationTree(ctx, input.verification, parent);
      const head = revParse(worktree, 'HEAD');
      if (head !== input.salvage) throw new Error(`fix round of ${unit}: the unit worktree is at ${head}, not the salvage SHA ${input.salvage}`);
      const dirty = dirtyPaths(worktree);
      if (dirty.length > 0) throw new Error(`fix round of ${unit}: the unit worktree is not clean after salvage: ${dirty.join(', ')}`);
      return { worktree, branch, ...resumed(dispatch, onSeat(dispatch, lastImplementerSession(ctx, unit)), input.fix), evidenceDirs: input.fix.failingEvidenceDirs, deadlineAt };
    }
    case 'resume':
    case 'resolve':
      return { worktree, branch, ...resumed(dispatch, onSeat(dispatch, lastImplementerSession(ctx, unit)), roundInputs(input)!), evidenceDirs: [], deadlineAt };
    case 'continue': {
      const own = roundInputs(input.of) ?? { failingEvidenceDirs: [], directives: [] };
      const interrupted = ctx.journal.view.latestIntent(parseInvocationId(input.interrupted).op);
      if (interrupted.kind !== 'proc.spawn') throw new Error(`${input.interrupted}: the interrupted build is not a spawn`);
      const id = onSeat(dispatch, seatedSessionOf(ctx, interrupted, input.interrupted));
      // A resumed session already holds the spec and its round's inputs; a fresh one is given them again.
      const fixRound: FixRound = id === null
        ? { ...own, directives: [...own.directives, NO_SESSION_NOTE, CONTINUE_DIRECTIVE] }
        : { failingEvidenceDirs: [], directives: [CONTINUE_DIRECTIVE] };
      return { worktree, branch, session: sessionOf(dispatch, id), fixRound, evidenceDirs: own.failingEvidenceDirs, deadlineAt };
    }
  }
}
