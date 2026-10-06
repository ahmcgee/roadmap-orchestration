// Build rounds (plan "Pipeline", R3; DESIGN-1.0.md §4 Fix rounds). The implementer is dispatched in one of
// five rounds: the four a decision asks for (`BuildRound`, transitions.ts) and `continue`:
//
//   fresh     a new session in the unit worktree (created on the unit branch at the integration tip the
//             first time); after a reopen (a revision of the unit's spec, re-opened by `resume` of a
//             parked unit or at a stage boundary of one in flight, unit.ts), the unit's latest implementer
//             session is resumed instead, told by RESPEC_DIRECTIVE that the spec it now reads was amended
//             and that the worktree holds its earlier work;
//   fix       resume the implementer session with the failing lanes' evidence dirs and any directives (the
//             gate's, or the executor's for a dirty checkout, missing witnesses or smoke survivors: M4a rev 3,
//             `witnessFixRound`, `smokeFixRound`), in the unit worktree at the salvage SHA; the verification
//             checkout of the failed series is removed first, citing its evidence snapshot;
//   resume    the one uncharged resume after a malformed report, told why it was malformed (I3);
//   resolve   resume after a conflicted merge-in: "resolve and commit";
//   steer     (M3, R11) the architect's alternate implementer entry (`roadmap steer`, unit.ts): a fresh session on
//             the kept worktree, the brief as its one directive, its window the steer's budget; uncharged. A
//             later fix round resumes it (it is the unit's latest implementer session, on the seat it re-pinned);
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
// change never moves the session key (backend, model) of a unit whose build started (implementerDispatch parks it
// instead), and an effort-only change re-pins it and resumes the session with the new effort (R4, OR-L3).
//
// A resolve round after a re-entry's conflicted `prepare` (A6) is fresh: the re-entering unit is a new unit
// id with no build of its own, and no session inherits across units, so it starts a fresh session on the
// prepared worktree (MERGE_HEAD kept) with RESOLVE_DIRECTIVE and NO_SESSION_NOTE.
//
// Session never persisted. A round that resumes a session (a fix, resume or resolve round, a continue, a
// reopen's respec round) whose call ends `process-fault` with no complete JSON line on stdout never got its
// session going (`sessionNeverPersisted`, dispatch.ts): it re-runs once, uncharged, as a new invocation of the
// same attempt, fresh on the kept worktree with the round's inputs and NO_SESSION_NOTE (`PreparedRound.fresh`,
// `callRound`).
//
// Stalled rounds and escalation (A11, D4, G1). A fix round is stalled when the failure that asks for the next
// fix round fails a lane that also failed in the failure that asked for it, or the gate revised both times
// (`stalledRounds`). With N = 1, the fix round after the first stalled round runs cold on the arc's
// `build.high` seat, provided `chargeableFailures` is below the unit's chargeable bound and `build.<buildTier>` does
// not already bind `build.high`'s triple: `escalateImplementer` journals `implementer-escalated` before the round's
// implementer seat is chosen, and the fold's `buildTier` becomes `high`. The seat moves, so its session is
// fresh (NO_SESSION_NOTE).
//
// Deadlines (M3: the unit's pinned bounds, `limits`). A fix round's window is the measured lane series plus the
// unit's edit allowance (`editAllowanceMin`), a fresh build's its `freshBuildMin`; the built-in values are
// defaults, unmeasured, to re-derive once arc 2 has measured rounds. A build call
// lost with its runner without tree effects is retried under the deadline it had: live, as the op's next
// invocation (dispatch.ts); after a crash, as the next attempt of the build, which inherits the lost call's
// deadline (`crashLostDeadline`).
//
// Every directive's text is src/prompts/directives.ts's (one canonical place).
//
// Codex resume collision (DESIGN-1.0.md §3 "Codex facts"): a `codex exec resume` that dies at once because
// the thread is still held by a live session is a transient, not a verdict on the unit. `callImplementer`
// retries such a call once, as a new invocation with the same deadline.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { freshClaudeImplementerSession } from '../backends/argv.ts';
import type { IntentOf, TestRef } from '../core/events.ts';
import type { RequiredWitness } from '../holistic/required.ts';
import { type ImplementerSessionId, type InvocationId, type SeatRev, type Sha, type Sha256Hex, type UnitId, invocationId, parseInvocationId } from '../core/ids.ts';
import { keptInput } from '../input/inforce.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type LogSnapshot, readJournal } from '../core/log.ts';
import { type Bounds, type ImplementerSession, STDERR_FILE } from '../core/records.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import type { RiskTier } from '../routing/types.ts';
import { type AbsPath, type IsoTime, type RefName, type RepoPath, branchRef, isoTimeOf } from '../core/values.ts';
import { refTarget, revParse } from '../git/git.ts';
import { type FixRound, ignoredText } from '../prompts/inputs.ts';
import {
  CONTINUE_DIRECTIVE, NO_SESSION_NOTE, RESOLVE_DIRECTIVE, RESPEC_DIRECTIVE, STEER_DIRECTIVE, dirtyLanesDirective, flakyLaneDirective, movedHeadDirective,
  repeatRedDirective, resumeDirectives, smokeFixDirectives, stalledLaneDirective, witnessFixDirectives,
} from '../prompts/directives.ts';
import { runnerFiles } from '../runner/files.ts';
import {
  type BackendCallOutcome, type BackendCallSpec, type ImplementerDispatch, type StageContext, type StageParent, callBackend, implementerSeatRev, minutesMs, runOp, sameSession, seatTripleOf, sessionNeverPersisted, unitBranch,
  unitWorktree,
} from './dispatch.ts';
import { invocationDir } from './invoke.ts';
import { LANE_STALL_MS, type LaneRecord, type VerificationTree, dirtyPaths, removeVerificationTree, seriesDurationMs } from './lanes.ts';
import { type BuildRound, decidedBy } from './transitions.ts';
import { worktreeCreateOp } from '../recover/ops.ts';


/** A steer's brief, kept content-addressed by `roadmap steer` (src/commands/steer.ts) as `inputs/<sha256>.brief.md`. */
export const BRIEF_INPUT = 'brief.md';

/** The kept brief a `steered` fact names; a missing one is a bug (the command keeps it before the fact). */
export function steerBrief(runDir: AbsPath, sha: Sha256Hex): string {
  const bytes = keptInput(runDir, sha, BRIEF_INPUT);
  if (bytes === null) throw new Error(`steer brief ${sha} is named in the log but not kept`);
  return bytes.toString('utf8');
}

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
  /** I3 (F25): `error` the validation error of the malformed report it follows, quoted to the session; null when unknown. */
  | Readonly<{ kind: 'resume'; error: string | null }>
  | Readonly<{ kind: 'resolve' }>
  /** M3 (R11): the steer round a `steered` fact asks for: the brief's text and the budget (its window). */
  | Readonly<{ kind: 'steer'; brief: string; budgetMin: number }>;

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

/** The session a round's call runs and what it is given beyond the spec. */
export type RoundCall = Readonly<{
  session: ImplementerSession;
  fixRound: FixRound | null;
  /** Directories outside the worktree the session reads: the failing evidence of the fix round it runs or continues. */
  evidenceDirs: readonly AbsPath[];
}>;

export type PreparedRound = RoundCall & Readonly<{
  worktree: AbsPath;
  branch: RefName;
  deadlineAt: IsoTime;
  /**
   * The same round as a fresh session told so (NO_SESSION_NOTE), for a resumed session that never persisted
   * (`callRound`); null when the round's session is already fresh.
   */
  fresh: RoundCall | null;
}>;

/**
 * The table's round a round input is read under (a build attempt's report): its own, or the one a continue
 * continues. A steer round is the table's `fresh` round: its report is read as a fresh build's.
 */
export function decidedRound(input: RoundInput): BuildRound {
  const kind = input.kind === 'continue' ? input.of.kind : input.kind;
  return kind === 'steer' ? 'fresh' : kind;
}

/**
 * What a fix round is told about its failing lanes beyond their evidence: that a lane the stall watchdog
 * killed hung (its output alone does not say so), that a red lane repeated the unit's earlier red exactly and so was
 * not rerun (F2, `LaneRecord.repeat`), that a flaky lane passed its diagnostic rerun (redlane.ts), and each lane's
 * ignored-output census. The text is src/prompts/directives.ts's.
 */
export function failingLaneDirectives(failing: readonly LaneRecord[]): readonly string[] {
  return failing.flatMap((l) => {
    const ignored = l.ignored === null ? null : ignoredText(l.ignored);
    return [
      ...(l.verdict === 'stall' ? [stalledLaneDirective(l.lane, LANE_STALL_MS)] : []),
      ...(l.repeat === null ? [] : [repeatRedDirective(l.lane, l.repeat)]),
      ...(l.flaky && l.diagnostic !== null ? [flakyLaneDirective(l.lane, l.diagnostic.evidenceDir)] : []),
      ...(ignored === null ? [] : [`Lane ${l.lane} ${ignored}.`]),
    ];
  });
}

/** The evidence dirs a fix round reads for a failing lane: its failing run's, and a flaky lane's passing rerun's. */
export const failingEvidenceDirs = (l: LaneRecord): readonly AbsPath[] => (l.flaky && l.diagnostic !== null ? [...l.fixDirs, ...l.diagnostic.fixDirs] : l.fixDirs);

/** The fix round after a red or not-certified series: the failing evidence, and for a dirty checkout, why. */
export function laneFixRound(ledger: readonly LaneRecord[], dirty: readonly string[], salvage: Sha): DecidedRound {
  const red = ledger.filter((l) => l.verdict === 'fail' || l.verdict === 'stall');
  if (red.length > 0) return { kind: 'fix', fix: { failingEvidenceDirs: red.flatMap(failingEvidenceDirs), directives: failingLaneDirectives(red) }, ledger, verification: null, salvage };
  if (dirty.length === 0) throw new Error('laneFixRound: the series was green and clean; there is nothing to fix');
  return {
    kind: 'fix',
    fix: {
      failingEvidenceDirs: ledger.flatMap((l) => l.fixDirs),
      directives: [dirtyLanesDirective(dirty)],
    },
    ledger, verification: null, salvage,
  };
}

/**
 * M4a rev 3 (D1): the fix round after `witnesses-missing`: each required test still missing or failing, with what requires
 * it (`required`, at the salvage SHA), and the witness lanes' evidence; over the green spec series (`ledger`).
 */
export function witnessFixRound(
  missing: readonly TestRef[], failed: readonly TestRef[], required: readonly RequiredWitness[], evidence: readonly AbsPath[], ledger: readonly LaneRecord[], salvage: Sha,
): DecidedRound {
  return { kind: 'fix', fix: { failingEvidenceDirs: evidence, directives: witnessFixDirectives(missing, failed, required) }, ledger, verification: null, salvage };
}

/** M4a rev 3 (D1): the fix round after a witness check whose own checkout the lanes left dirty or moved (`not-certified`). */
export function witnessCheckoutFixRound(dirty: readonly RepoPath[], evidence: readonly AbsPath[], ledger: readonly LaneRecord[], salvage: Sha): DecidedRound {
  return { kind: 'fix', fix: { failingEvidenceDirs: evidence, directives: [dirty.length === 0 ? movedHeadDirective() : dirtyLanesDirective(dirty)] }, ledger, verification: null, salvage };
}

/** M4a rev 3 (D2): the fix round after `smoke-survived`: each surviving target, with the smoke runs' evidence. */
export function smokeFixRound(survived: readonly TestRef[], required: readonly RequiredWitness[], evidence: readonly AbsPath[], ledger: readonly LaneRecord[], salvage: Sha): DecidedRound {
  return { kind: 'fix', fix: { failingEvidenceDirs: evidence, directives: smokeFixDirectives(survived, required) }, ledger, verification: null, salvage };
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

/** The window of a fix round: the measured lane series plus the unit's edit allowance. */
export function fixWindowMs(ledger: readonly LaneRecord[], bounds: Bounds): number {
  return seriesDurationMs(ledger) + minutesMs(bounds.editAllowanceMin);
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
 * spawned under (the spawn names that fact's `routingRev` and floor as its own `routingRev` and `tier`). An
 * escalated spawn (A11: its tier above every floor pinned under its rev) sat on `build.<tier>`: its rev under the
 * routing in force when that is the spawn's, else null, as no record holds an earlier routing's seat (its session
 * is then not resumed: a fresh one is told the worktree holds the work).
 */
function spawnSeatRev(ctx: StageContext, intent: IntentOf<'proc.spawn'>): SeatRev | null {
  const s = intent.expect.subject;
  if (s.purpose !== 'backend' || s.role !== 'build') throw new Error(`${intent.op}: not a build spawn`);
  const underRev = ctx.journal.view.dispatchesOf(s.unit).filter((d) => d.routingRev === s.routingRev);
  if (underRev.length === 0) throw new Error(`${intent.op}: a build spawn under routingRev ${s.routingRev} with no dispatch fact of ${s.unit} under it`);
  const pinned = underRev.filter((d) => d.riskFloor === s.tier).at(-1);
  if (pinned !== undefined) return pinned.implementerSeatRev;
  const routing = ctx.routing(s.unit);
  return routing.rev === s.routingRev ? implementerSeatRev(routing, s.tier) : null;
}

/** The session of build invocation `inv` with its seat, or null when it has no session (or no seat that can be proven). */
function seatedSessionOf(ctx: StageContext, intent: IntentOf<'proc.spawn'>, inv: InvocationId): SeatedSession | null {
  const id = invocationSession(ctx, inv);
  if (id === null) return null;
  const seatRev = spawnSeatRev(ctx, intent);
  return seatRev === null ? null : { id, seatRev };
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
 * The session a round on `dispatch` may resume: `earlier` when its seat has the same session key (R4: backend and
 * model; an effort-only change resumes it with the new `--effort`, OR-L3), else null. A session cannot move across
 * models or backends, so a build whose seat moved to another model (a plan-check risk raise after a build) starts a
 * fresh session on the kept branch and worktree, its round's inputs given with NO_SESSION_NOTE.
 */
function onSeat(dispatch: ImplementerDispatch, earlier: SeatedSession | null): ImplementerSessionId | null {
  return earlier !== null && sameSession(seatTripleOf(earlier.seatRev), dispatch.triple) ? earlier.id : null;
}

export function freshSession(dispatch: ImplementerDispatch): ImplementerSession {
  return dispatch.triple.backend === 'claude' ? freshClaudeImplementerSession() : { backend: 'codex', mode: 'fresh' };
}

/** A resume of session `id`, or a fresh session when there is none. */
function sessionOf(dispatch: ImplementerDispatch, id: ImplementerSessionId | null): ImplementerSession {
  if (id === null) return freshSession(dispatch);
  return dispatch.triple.backend === 'claude' ? { backend: 'claude', mode: 'resume', id } : { backend: 'codex', mode: 'resume', id };
}

/**
 * The call of a round that resumes session `id` with `fix`, and its fresh variant: a fresh session told so by
 * NO_SESSION_NOTE. With no session to resume the round is that fresh variant.
 */
export function resumed(
  dispatch: ImplementerDispatch, id: ImplementerSessionId | null, fix: FixRound, evidenceDirs: readonly AbsPath[],
): RoundCall & Readonly<{ fresh: RoundCall | null }> {
  const fresh: RoundCall = { session: freshSession(dispatch), fixRound: { ...fix, directives: [...fix.directives, NO_SESSION_NOTE] }, evidenceDirs };
  return id === null ? { ...fresh, fresh: null } : { session: sessionOf(dispatch, id), fixRound: fix, evidenceDirs, fresh };
}

/** The inputs a decided round gives its session, beyond the spec: a fix round's evidence and directives, or a resume's directive. */
function roundInputs(round: DecidedRound): FixRound | null {
  switch (round.kind) {
    case 'fresh': return null;
    case 'fix': return round.fix;
    case 'resume': return { failingEvidenceDirs: [], directives: resumeDirectives(round.error) };
    case 'resolve': return { failingEvidenceDirs: [], directives: [RESOLVE_DIRECTIVE] };
    case 'steer': return { failingEvidenceDirs: [], directives: [STEER_DIRECTIVE, round.brief] };
  }
}

/**
 * The window of a decided round under the unit's bounds: a fresh build's deadline, a fix round's window, the edit
 * allowance, or a steer's budget.
 */
function windowMs(round: DecidedRound, bounds: Bounds): number {
  switch (round.kind) {
    case 'fresh': return minutesMs(bounds.freshBuildMin);
    case 'fix': return fixWindowMs(round.ledger, bounds);
    case 'resume':
    case 'resolve': return minutesMs(bounds.editAllowanceMin);
    case 'steer': return minutesMs(round.budgetMin);
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

/**
 * The implementer's call for a prepared round (`callImplementer`, the collision retry included), with `spec`
 * building the call from the round's session and inputs. A resumed session that never persisted
 * (`sessionNeverPersisted`) is re-run once, uncharged, as a new invocation of the same attempt: fresh on the
 * kept worktree with NO_SESSION_NOTE (`round.fresh`). The outcome is the last call's.
 */
export async function callRound(ctx: StageContext, round: PreparedRound, spec: (call: RoundCall) => BackendCallSpec): Promise<BackendCallOutcome> {
  const first = spec(round);
  const called = await callImplementer(ctx, first);
  if (round.fresh === null || !sessionNeverPersisted(first, called)) return called;
  return callImplementer(ctx, spec(round.fresh));
}

/** The unit worktree on the unit branch; created at the integration tip for the unit's first build. */
async function ensureWorktree(ctx: StageContext, unit: UnitId, parent: StageParent): Promise<Readonly<{ worktree: AbsPath; branch: RefName }>> {
  const worktree = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit);
  const branch = unitBranch(ctx.plan().arc, unit);
  if (existsSync(worktree)) return { worktree, branch };
  const existing = refTarget(ctx.repo, branch);
  const at = existing ?? revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit}:unit`, parent, {
    path: worktree, checkout: { type: 'branch', branch, at, createBranch: existing === null },
  });
  return { worktree, branch };
}

/**
 * The deadline of the build call a crash left lost without tree effects: the unit's build attempt just before this one,
 * cut short by the crash (no stage outcome records it), whose latest backend spawn recovery closed `lost` without tree
 * effects. The attempt that re-runs it inherits that deadline, as the live retry does; null otherwise. The new attempt
 * may already hold its entry reservation (`@cpu`), so the crashed attempt is found by number, not as the open one.
 */
function crashLostDeadline(ctx: StageContext, parent: StageParent): IsoTime | null {
  const view = ctx.journal.view;
  const crashed = parent.attempt - 1;
  const u = view.unit(parent.unit);
  if (u.decided?.attempt === crashed || u.interrupted?.attempt === crashed) return null;
  const spawn = view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.parent.type === 'stage'
    && i.parent.unit === parent.unit && i.parent.stage === 'build' && i.parent.attempt === crashed).at(-1);
  if (spawn === undefined) return null;
  const done = view.doneOf(spawn.op);
  if (done === null || done.kind !== 'proc.spawn' || done.outcome.kind !== 'lost' || done.outcome.treeEffects) return null;
  if (spawn.deadlineAt === null) throw new Error(`proc.spawn ${spawn.op} has no deadlineAt`);
  return spawn.deadlineAt;
}

/** Everything a build round needs before its invocation: the worktree ready, the session, the fix inputs, the deadline. */
export async function prepareRound(ctx: StageContext, dispatch: ImplementerDispatch, input: RoundInput, parent: StageParent): Promise<PreparedRound> {
  const unit = parent.unit;
  const worktree = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit);
  const branch = unitBranch(ctx.plan().arc, unit);
  const bounds = ctx.journal.view.unit(unit).bounds;
  const deadlineAt = crashLostDeadline(ctx, parent) ?? inMs(windowMs(input.kind === 'continue' ? input.of : input, bounds));
  switch (input.kind) {
    case 'steer': {
      // A fresh session on the kept worktree (R11): never the unit's earlier session, whatever its seat.
      const ready = await ensureWorktree(ctx, unit, parent);
      return { ...ready, session: freshSession(dispatch), fixRound: roundInputs(input), evidenceDirs: [], deadlineAt, fresh: null };
    }
    case 'fresh': {
      const ready = await ensureWorktree(ctx, unit, parent);
      // Only a reopen leads to a second fresh round, and the unit keeps its implementer session across it
      // (on the same seat: a moved seat gets a fresh session, told the worktree holds the earlier work).
      const earlier = ctx.journal.view.unit(unit).reopened === null ? null : lastImplementerSession(ctx, unit);
      if (earlier === null) return { ...ready, session: freshSession(dispatch), fixRound: null, evidenceDirs: [], deadlineAt, fresh: null };
      return { ...ready, ...resumed(dispatch, onSeat(dispatch, earlier), { failingEvidenceDirs: [], directives: [RESPEC_DIRECTIVE] }, []), deadlineAt };
    }
    case 'fix': {
      if (input.verification !== null) await removeVerificationTree(ctx, input.verification, parent);
      const head = revParse(worktree, 'HEAD');
      if (head !== input.salvage) throw new Error(`fix round of ${unit}: the unit worktree is at ${head}, not the salvage SHA ${input.salvage}`);
      const dirty = dirtyPaths(worktree);
      if (dirty.length > 0) throw new Error(`fix round of ${unit}: the unit worktree is not clean after salvage: ${dirty.join(', ')}`);
      return { worktree, branch, ...resumed(dispatch, onSeat(dispatch, lastImplementerSession(ctx, unit)), input.fix, input.fix.failingEvidenceDirs), deadlineAt };
    }
    case 'resume':
    case 'resolve':
      // A re-entry's resolve finds no session: the unit is new and has no build of its own (the header).
      return { worktree, branch, ...resumed(dispatch, onSeat(dispatch, lastImplementerSession(ctx, unit)), roundInputs(input)!, []), deadlineAt };
    case 'continue': {
      const own = roundInputs(input.of) ?? { failingEvidenceDirs: [], directives: [] };
      const interrupted = ctx.journal.view.latestIntent(parseInvocationId(input.interrupted).op);
      if (interrupted.kind !== 'proc.spawn') throw new Error(`${input.interrupted}: the interrupted build is not a spawn`);
      const id = onSeat(dispatch, seatedSessionOf(ctx, interrupted, input.interrupted));
      // A resumed session already holds the spec and its round's inputs; a fresh one is given them again.
      const fresh: RoundCall = {
        session: freshSession(dispatch), fixRound: { ...own, directives: [...own.directives, NO_SESSION_NOTE, CONTINUE_DIRECTIVE] }, evidenceDirs: own.failingEvidenceDirs,
      };
      if (id === null) return { worktree, branch, ...fresh, deadlineAt, fresh: null };
      return {
        worktree, branch, session: sessionOf(dispatch, id), fixRound: { failingEvidenceDirs: [], directives: [CONTINUE_DIRECTIVE] }, evidenceDirs: own.failingEvidenceDirs,
        deadlineAt, fresh,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Stalled rounds and escalation (A11, D4, G1)

/**
 * The lanes each of the unit's stage attempts failed, as `<set>:<lane>` (a lane whose run was red, a flaky
 * one included; a red a host signature voided on a busy host counts too, as the log cannot tell it apart).
 */
function failedLanes(view: JournalView, unit: UnitId): ReadonlyMap<number, ReadonlySet<string>> {
  const failed = new Map<number, Set<string>>();
  for (const intent of view.opsOf('proc.spawn')) {
    const s = intent.expect.subject;
    if (s.purpose !== 'lane' || s.unit !== unit || intent.parent.type !== 'stage') continue;
    const done = view.doneOf(intent.op);
    if (done?.kind !== 'proc.spawn' || done.outcome.kind !== 'result' || done.outcome.summary.type !== 'command') continue;
    const { verdict } = done.outcome.summary;
    if (verdict !== 'fail' && verdict !== 'stall') continue;
    const keys = failed.get(intent.parent.attempt) ?? new Set<string>();
    keys.add(`${s.set}:${s.lane}`);
    failed.set(intent.parent.attempt, keys);
  }
  return failed;
}

/** What a gate's revise failed, beside lanes. */
const GATE_REVISED = 'gate';

/**
 * The unit's stalled fix rounds, ascending by build attempt. A fix round (the first build attempt after a
 * failure whose decision is a fix round) is stalled when the next such failure fails a lane that also failed
 * in the one before it, or the gate revised both times. A reopen (a new spec revision) starts over. Pure over
 * the log: the stage-outcome and reopened facts of `log.events`, the lane verdicts of `log.view`.
 */
export function stalledRounds(log: LogSnapshot, unit: UnitId): readonly number[] {
  const failed = failedLanes(log.view, unit);
  const stalled: number[] = [];
  let before: ReadonlySet<string> | null = null;
  let fix: number | null = null;
  for (const e of log.events) {
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'reopened' && f.unit === unit) {
      before = null;
      fix = null;
    }
    if (f.kind !== 'stage-outcome' || f.unit !== unit || f.class === 'hold') continue;
    if (f.stage === 'build') {
      if (before !== null && fix === null) fix = f.attempt;
      continue;
    }
    const decided = decidedBy(f);
    if (decided.kind !== 'stage' || decided.target.stage !== 'build' || decided.target.round !== 'fix') continue;
    const keys: ReadonlySet<string> = f.stage === 'gate' ? new Set([GATE_REVISED]) : failed.get(f.attempt) ?? new Set();
    const earlier = before;
    if (fix !== null && earlier !== null && [...keys].some((k) => earlier.has(k))) stalled.push(fix);
    before = keys;
    fix = null;
  }
  return stalled;
}

/** Whether a round escalates the implementer to `build.high`, and if not, why. */
export type Escalation =
  | Readonly<{ kind: 'escalate'; from: Exclude<RiskTier, 'high'>; stalled: number }>
  | Readonly<{ kind: 'none'; why: 'not-a-fix-round' | 'no-stalled-round' | 'already-high' | 'same-triple' | 'at-bound' }>;

/**
 * The escalation decision for build round `input` of `unit` (N = 1): a fix round after the unit's first
 * stalled round moves to `build.high`, while `chargeableFailures` is below the unit's chargeable bound and unless its
 * build tier's seat already binds `build.high`'s triple under the unit's routing. A continue keeps the seat its
 * interrupted attempt ran on.
 */
export function escalation(log: LogSnapshot, routing: ResolvedRouting, unit: UnitId, input: RoundInput): Escalation {
  if (input.kind !== 'fix') return { kind: 'none', why: 'not-a-fix-round' };
  const u = log.view.unit(unit);
  if (u.buildTier === null) throw new Error(`a fix round of ${unit}, which was never dispatched`);
  if (u.buildTier === 'high') return { kind: 'none', why: 'already-high' };
  const [stalled] = stalledRounds(log, unit);
  if (stalled === undefined) return { kind: 'none', why: 'no-stalled-round' };
  if (u.counters.chargeableFailures >= u.bounds.chargeable) return { kind: 'none', why: 'at-bound' };
  if (canonicalJson(routing.table.build[u.buildTier]) === canonicalJson(routing.table.build.high)) return { kind: 'none', why: 'same-triple' };
  return { kind: 'escalate', from: u.buildTier, stalled };
}

/**
 * Decides and journals the escalation of build attempt `attempt` of `unit` (`implementer-escalated`), and
 * returns the unit's build tier after it: the tier whose implementer seat the round is dispatched on. Called
 * before the round's implementer seat is selected (G1). Reads the arc's log from `runDir` for its history.
 */
export function escalateImplementer(
  ctx: Readonly<{ journal: Journal; runDir: AbsPath; routing: (unit: UnitId | null) => ResolvedRouting }>, unit: UnitId, attempt: number, input: RoundInput,
): RiskTier {
  const decided = escalation(readJournal(ctx.runDir, ctx.journal.view.arc), ctx.routing(unit), unit, input);
  if (decided.kind === 'escalate') {
    ctx.journal.fact({ kind: 'implementer-escalated', unit, attempt, from: decided.from, to: 'high', stalled: decided.stalled });
  }
  const tier = ctx.journal.view.unit(unit).buildTier;
  if (tier === null) throw new Error(`${unit} has no build tier after its escalation decision`);
  return tier;
}
