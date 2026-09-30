// The coalesced prober (M2; SCHEMAS.md "Parks", "Backend parks"): one probe job per target, covering every
// current park of that target (fixed when the job starts, G7), ending in one `probe` fact. The fold derives
// recovery from those facts (src/core/state.ts); nothing here moves a unit. The scheduler runs each job as a
// tracked async job; `run` never blocks the caller beyond its own awaits, and at most one job per target runs.
//
// What a job checks, per target:
//   backend{b}   b's smoke (`probeSmoke`), bound to the park epochs it covers (F12): a pass clears b's park
//                only when it covers exactly the current epoch and the class is retryable.
//   host         a clear host sample and the smoke's shell command, then each covered park's local check:
//                the host sample for a blocked lane, `git -C <worktree> status` for a salvage (G7).
//   resource{i}  the reclaim order under the residue's reclaim holder (`retryHolderOf`: the reclaim in progress's,
//                else the residue's owner: a `retry` of the attempt whose cleanup failed, as the residue key names
//                it, or the owning `job` (G4; its reclaim order is step A4's) — `retryReclaim`: reclaim →
//                teardown → the residue's `cleaned` disposition → release — then the fact; a pass is written only
//                once the instance is free and its residue disposed. The same whether a unit park names the
//                instance, a residue alone does (a failed cleanup no stage outcome parked), or both.
// A job cancelled by its signal records nothing: its target is probed again when next due.
//
// `resumeBackend` is `resume --backend b` through the prober: b's smoke under the same one-job-per-target
// rule, then `resumed{backend}`, which clears whatever park is current and releases the holds it caused.
import { existsSync } from 'node:fs';
import { crashPoint } from '../core/crash.ts';
import { type Holder, type ProbeTarget, probeTargetKey } from '../core/events.ts';
import type { CommandId, ResourceInstance } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { UnitState } from '../core/state.ts';
import { gitRun } from '../git/git.ts';
import { type HostSample, isClear } from '../host/sample.ts';
import { type StageContext, unitWorktree } from '../pipeline/dispatch.ts';
import { backendEnv, invokeCommand, probeSmoke, smokeDir, smokePassed, smokeRejections, type InvocationContext } from '../preflight/smoke.ts';
import { type RetryHolder, retryReclaim } from '../resources/reserve.ts';
import type { Backend, ProfileName } from '../routing/types.ts';
import type { ProbeJob, Prober } from '../schedule/types.ts';
import { dueJobs, nextProbeAt, retryableParks } from './schedule.ts';

/** What the prober runs with: the stages' context, the arc's profile (a smoke's routing) and the host sampler. */
export type ProberContext = StageContext & Readonly<{
  profile: ProfileName;
  /** The host's load and memory now (`readHostSample` in the executor). */
  sample: () => HostSample;
}>;

/** What `resume --backend` gets back. `not-parked`: nothing to resume, no smoke run. */
export type ResumeBackend =
  | Readonly<{ kind: 'resumed' }>
  | Readonly<{ kind: 'not-parked' }>
  | Readonly<{ kind: 'smoke-failed'; detail: string }>;

export type ProberHandle = Prober & Readonly<{
  /** `resume --backend b`: b's smoke through the prober, then `resumed{backend}` on a pass. */
  resumeBackend: (backend: Backend, command: CommandId, signal: AbortSignal) => Promise<ResumeBackend>;
  /** The targets a job is running for, by `probeTargetKey`. */
  running: () => readonly string[];
}>;

const invocationContext = (ctx: ProberContext): InvocationContext => ({ journal: ctx.journal, runDir: ctx.runDir, hostEnv: backendEnv(ctx.hostEnv) });

async function backendCheck(ctx: ProberContext, backend: Backend): Promise<Readonly<{ pass: boolean; detail: string }>> {
  const report = await probeSmoke({ profile: ctx.profile, resolved: ctx.routing(null) }, invocationContext(ctx), backend);
  const pass = report.backends.every(smokePassed);
  return { pass, detail: pass ? 'passed' : smokeRejections(report).map((r) => `${r.problem}: ${r.detail}`).join('; ') || 'failed' };
}

/** The current retryable parks among `covers`, by seq (a stale cover checks nothing). */
function coveredParks(ctx: ProberContext, covers: readonly number[]): readonly UnitState[] {
  return retryableParks(ctx.journal.view).filter((p) => covers.includes(p.park.seq)).map((p) => p.unit);
}

/** A covered park's own host check (G7): its worktree still answers `git status` after a failed salvage commit. */
function localCheck(ctx: ProberContext, unit: UnitState): boolean {
  const d = unit.decided;
  if (d === null) throw new Error(`unit ${unit.unit} is parked with no decision`);
  if (d.stage !== 'salvage') return true; // a blocked lane or candidate: the host sample, checked for all
  const wt = unitWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.unit);
  return existsSync(wt) && gitRun(wt, ['status', '--porcelain'], { okCodes: [0, 128] }).code === 0;
}

async function hostCheck(ctx: ProberContext, covers: readonly number[]): Promise<boolean> {
  if (!isClear(ctx.sample())) return false;
  const shell = await invokeCommand(invocationContext(ctx), {
    check: 'probe-host', argv: ['sh', '-c', 'exit 0'], cwd: smokeDir(ctx), purpose: 'smoke', expectedExit: 0,
  });
  if (shell.result.verdict !== 'pass') return false;
  return coveredParks(ctx, covers).every((u) => localCheck(ctx, u));
}

/** The holder a probe reclaims a residue under: a unit's `retry` holder, or the owning job's own holder (G4). */
export type ReclaimHolder = RetryHolder | Extract<Holder, { type: 'job' }>;

/**
 * The holder a probe reclaims `instance` under: the `retry` or `job` holder already cleaning it (a reclaim a failed
 * teardown or a crash left), else the residue's owner (`ResidueState.holder`): for a unit-owned residue a retry keyed
 * by the stage attempt whose fail named the key's teardown, for a job-owned one that job. Null once it is released.
 */
export function retryHolderOf(view: JournalView, instance: ResourceInstance): ReclaimHolder | null {
  const status = view.resources().get(instance)?.status;
  if (status === undefined || status.state === 'free') return null;
  if (status.state === 'cleaning' && (status.holder.type === 'retry' || status.holder.type === 'job')) return status.holder;
  const residue = view.residues().find((r) => r.key.resource === instance);
  if (status.state !== 'cleanup-failed' || residue === undefined) {
    throw new Error(`a probe of ${instance}, which is ${status.state} under ${JSON.stringify(status.holder)}${residue === undefined ? ' with no residue' : ''}`);
  }
  const owner = residue.holder;
  if (owner.type === 'job') return owner;
  return { type: 'retry', unit: owner.unit, stage: owner.stage, attempt: owner.attempt };
}

async function resourceCheck(ctx: ProberContext, target: Extract<ProbeTarget, { type: 'resource' }>): Promise<boolean> {
  const holder = retryHolderOf(ctx.journal.view, target.instance);
  // Released: the reclaim order finished (a crash came before the probe fact), or a sweep took the residue.
  if (holder === null) return true;
  if (holder.type === 'job') {
    throw new Error(`a probe of ${target.instance}: the reclaim order under job ${holder.job}'s holder is step A4's (retryReclaim takes a unit's retry holder only)`);
  }
  return (await retryReclaim(ctx, holder, target.instance, { type: 'arc' })) === 'pass';
}

async function check(ctx: ProberContext, job: ProbeJob): Promise<boolean> {
  switch (job.target.type) {
    case 'backend':
      return (await backendCheck(ctx, job.target.backend)).pass;
    case 'host':
      return hostCheck(ctx, job.covers);
    case 'resource':
      return resourceCheck(ctx, job.target);
  }
}

export function createProber(ctx: ProberContext): ProberHandle {
  const running = new Set<string>();
  /** Runs `body` as the one job of `target`: a second concurrent job of the target is a scheduler bug. */
  const exclusive = async <T>(target: ProbeTarget, body: () => Promise<T>): Promise<T> => {
    const key = probeTargetKey(target);
    if (running.has(key)) throw new Error(`a probe of ${key} is already running`);
    running.add(key);
    try {
      return await body();
    } finally {
      running.delete(key);
    }
  };

  return {
    due: (view, now) => dueJobs(view, now, running),

    run: (job, signal) => exclusive(job.target, async () => {
      if (job.covers.length === 0) throw new Error(`a probe of ${probeTargetKey(job.target)} covering no park`);
      signal.throwIfAborted();
      const pass = await check(ctx, job);
      signal.throwIfAborted();
      const now = new Date();
      const result = pass ? 'pass' : 'fail';
      crashPoint('probe.before-fact');
      ctx.journal.fact({
        kind: 'probe', target: job.target, covers: job.covers, result,
        nextProbeAt: pass ? null : nextProbeAt(ctx.journal.view, job.target, job.covers, now),
      });
      crashPoint('probe.after-fact');
      return result;
    }),

    resumeBackend: (backend, command, signal) => exclusive({ type: 'backend', backend }, async () => {
      if (!ctx.journal.view.parkedBackends().includes(backend)) return { kind: 'not-parked' };
      signal.throwIfAborted();
      const smoked = await backendCheck(ctx, backend);
      signal.throwIfAborted();
      if (!smoked.pass) return { kind: 'smoke-failed', detail: smoked.detail };
      ctx.journal.fact({ kind: 'resumed', command, target: { type: 'backend', backend } });
      return { kind: 'resumed' };
    }),

    running: () => [...running].sort(),
  };
}
