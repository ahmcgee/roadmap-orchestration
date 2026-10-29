// The suite-lane proof (plan "Decisions", RC-4, R8): job kind `proof`, spawn purpose `proof` (no `witnessed`; each side's
// records are kept as `inputs/<sha>.flow-proof.json` and named only by `flow-proof`). The old and the new argv each run
// once, in turn, under the job's holder with the lane's reservation (its `@cpu` cost and resources, as that side's lane
// def declares them), in a clean detached checkout of the integration head of its own, with the lane's exact env plus
// `witnessEnv` for the action's reporter. A lane env that sets (or passes) a variable the reporter's env owns
// (NODE_OPTIONS for node-test) cannot be proved: `unprovable`, nothing run.
//
// Outcome: `red` when the old side did not pass (a baseline that is not green, or no verdict: lost, a process fault, a
// stall; the new argv is then not run) or the new side gave no verdict (proved again once by a fresh proof job, then
// refused unremembered, src/flow/apply.ts); `unprovable` when a side's reporter output is malformed, or the old records
// are empty or hold no pass; `preserved` iff the new side passed and the two sides' records (one per test id: `selected`
// summed, the worst outcome) are equal; else `changed`. `changed` and `unprovable` are remembered as rejections. `breaksStandIn`: the lane stood in for an arc lane (F6) and the new argv
// ends that.
//
// Crash: a proof started and not ended (no `flow-proof` of its job) is run again from the start under the same job id,
// its leftover checkouts removed first (residues by job, `removeJobCheckouts`).
import { resourceEnvironments } from '../input/plan.ts';
import { laneCpuKey } from '../resources/calibrate.ts';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Parent } from '../core/events.ts';
import { type JobId, type Sha, opKey } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type LaneDef, STDERR_FILE, STDOUT_FILE } from '../core/records.ts';
import { type AbsPath, absPath, branchRef, isoTimeOf, repoPattern } from '../core/values.ts';
import { revParse } from '../git/git.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import type { WitnessTest } from '../holistic/types.ts';
import { WITNESS_LINES, collectWitness, witnessEnv } from '../holistic/witness.ts';
import { FLOW_PROOF_INPUT, keepInput, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { runOp } from '../pipeline/dispatch.ts';
import { invocationDir, invoke } from '../pipeline/invoke.ts';
import { LANE_DEADLINE_MS, LANE_GRACE_MS, LANE_STALL_MS, laneRequest, removeJobCheckouts, suiteStandIns } from '../pipeline/lanes.ts';
import { releaseEnvironment, useEnvironment } from '../resources/environments.ts';
import { probe } from '../resources/probe.ts';
import { instanceEnv } from '../resources/pool.ts';
import { type JobHolder, type Reservation, type ResourceContext, cleanup, heldReservation, jobOwnerLabel, run } from '../resources/reserve.ts';
import { OWNER_ENV } from '../resources/teardown.ts';
import { evidenceSnapshotOp, worktreeCreateOp } from '../recover/ops.ts';
import type { AcquireFirst } from '../schedule/arbiter.ts';
import type { FlowProposal, FlowReporter, ProofMinutes, ProofOutcome } from './types.ts';

/** What a proof needs: the reservation cycle's context, the executor's environment, and the job holder's first-served wait. */
export type ProofContext = ResourceContext & Readonly<{ hostEnv: Readonly<Record<string, string | undefined>>; acquireFirst: AcquireFirst }>;

/** A job's waits are never cancelled: a proof runs to its end once begun. */
const NEVER = new AbortController().signal;

/** One side's run: its verdict (null: none, the run was lost or faulted), its records (null: malformed), its minutes. */
type Side = Readonly<{ passed: boolean | null; tests: readonly WitnessTest[] | null; minutes: number }>;

/** Runs proof job `job` for an accepted suite-lane proposal to its `flow-proof`. */
export async function runProof(ctx: ProofContext, proposal: FlowProposal, job: JobId): Promise<void> {
  const { action } = proposal;
  if (action.lever !== 'suite-lane' || action.argv === undefined || action.reporter === undefined) {
    throw new Error(`runProof of ${proposal.id}: only a suite-lane argv change with a reporter is proved (code's checks drop the rest)`);
  }
  const view = ctx.journal.view;
  if (view.flowFacts().some((x) => x.fact.kind === 'flow-proof' && x.fact.job === job)) return;
  await removeJobCheckouts(ctx, job);

  const inForce = requirePlanInForce(ctx.runDir, view);
  const plan = inForce.plan;
  const lane = plan.suite.lanes.find((l) => l.id === action.lane);
  if (lane === undefined) throw new Error(`runProof of ${proposal.id}: the plan in force has no suite lane ${action.lane}`);
  const next: LaneDef = { ...lane, argv: action.argv, ...(action.cpu === undefined ? {} : { cpu: action.cpu }) };
  const head = revParse(ctx.repo, branchRef(plan.integrationBranch));
  const treeSha = revParse(ctx.repo, `${head}^{tree}`);
  const arcLanes = revisionInForce(ctx.runDir, inForce).obligations?.value.lanes ?? [];
  const breaksStandIn = suiteStandIns([lane], arcLanes).has(lane.id) && !suiteStandIns([next], arcLanes).has(lane.id);
  const base = { kind: 'flow-proof', proposal: proposal.id, job, treeSha, breaksStandIn } as const;

  const owned = Object.keys(witnessEnv(action.reporter, absPath('/'))).filter((name) => Object.hasOwn(lane.env.set, name) || lane.env.pass.includes(name));
  if (owned.length > 0) {
    ctx.journal.fact({ ...base, oldSha256: null, newSha256: null, outcome: 'unprovable', minutes: null });
    return;
  }

  const keep = (tests: readonly WitnessTest[] | null) => (tests === null ? null : keepInput(ctx.runDir, Buffer.from(canonicalJson(tests), 'utf8'), FLOW_PROOF_INPUT));
  const old = await runSide(ctx, job, proposal, lane, 'old', head, action.reporter);
  // A baseline that did not pass proves nothing: red, and the new argv is not run.
  if (old.passed !== true) {
    ctx.journal.fact({ ...base, oldSha256: keep(old.tests), newSha256: null, outcome: 'red', minutes: null });
    return;
  }
  const now = await runSide(ctx, job, proposal, next, 'new', head, action.reporter);
  const oldSha256 = keep(old.tests);
  const newSha256 = keep(now.tests);
  const outcome = outcomeOf(old, now);
  // `preserved` and `changed` carry both records and the minutes (`outcomeOf` reads a malformed side as `unprovable`).
  const minutes: ProofMinutes | null = oldSha256 === null || newSha256 === null ? null : { old: old.minutes, new: now.minutes };
  ctx.journal.fact({ ...base, oldSha256, newSha256, outcome, minutes });
}

/** The outcome of a proof whose old side passed. */
function outcomeOf(old: Side, now: Side): ProofOutcome {
  if (now.passed === null) return 'red';
  if (old.tests === null || now.tests === null) return 'unprovable';
  if (old.tests.length === 0 || !old.tests.some((t) => t.outcome === 'pass')) return 'unprovable';
  return now.passed && canonicalJson(old.tests) === canonicalJson(now.tests) ? 'preserved' : 'changed';
}

/** One side: reserve its lane's cost under the job's holder, a clean checkout of `head`, the run, its records; then release and remove. */
async function runSide(ctx: ProofContext, job: JobId, proposal: FlowProposal, lane: LaneDef, side: 'old' | 'new', head: Sha, reporter: FlowReporter): Promise<Side> {
  const holder: JobHolder = { type: 'job', job };
  const parent: Parent = { type: 'job', job };
  const request = laneRequest(ctx, lane);
  const environments = resourceEnvironments(ctx.plan(), request?.named ?? []);
  const used: typeof environments[number][] = [];
  let held: Reservation<'running', JobHolder> | null = null;
  if (request !== null) {
    const grant = await ctx.acquireFirst(request, holder, NEVER);
    if (grant.kind === 'cancelled') throw new Error(`${job}: its lane wait was cancelled, and nothing cancels it`);
    const reserved = heldReservation(ctx, holder, 'reserved');
    if ((await probe(ctx, reserved, parent)).kind === 'parked') throw new Error(`${job}: suite lane ${lane.id}'s resources are occupied; a proof waits on a free reservation only`);
    // dev.17: the lane's environment; one that does not come up gives this side no verdict (unprovable), as a lost run does.
    for (const name of environments) {
      if ((await useEnvironment(ctx, name, parent)).kind === 'unavailable') {
        const cleaned = await cleanup(ctx, reserved, parent);
        for (const ready of used) releaseEnvironment(ctx.journal, ready);
        if (cleaned.kind !== 'released') throw new Error(`${job}: suite lane ${lane.id}'s reservation was not released: ${cleaned.kind}`);
        return { passed: null, tests: null, minutes: 0 };
      }
      used.push(name);
    }
    held = run(ctx, reserved, parent);
  }
  try {
    return await runHeld(ctx, job, proposal, lane, side, head, reporter, parent, held);
  } finally {
    for (const name of used) releaseEnvironment(ctx.journal, name);
  }
}

/** The side's run under its held reservation (null: the lane asks for nothing). */
async function runHeld(
  ctx: ProofContext, job: JobId, proposal: FlowProposal, lane: LaneDef, side: 'old' | 'new', head: Sha, reporter: FlowReporter, parent: Parent,
  held: Reservation<'running', JobHolder> | null,
): Promise<Side> {
  const checkout = absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.${side}`));
  await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}`, parent, { path: checkout, checkout: { type: 'detached', at: head } });
  const dirOf = (invDir: string): AbsPath => absPath(join(jobEvidenceRoot(ctx.runDir, job), `proof-${side}-${basename(invDir)}`));
  const env: Record<string, string> = { ...lane.env.set };
  for (const name of lane.env.pass) {
    const value = ctx.hostEnv[name];
    if (value === undefined) throw new Error(`lane ${lane.id} passes ${name}, which the executor's environment lacks`);
    env[name] = value;
  }
  const startedAt = Date.now();
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    cpuKey: laneCpuKey(lane),
    origin: { type: 'new', key: opKey(`lane:${job}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'proof', job, proposal: proposal.id, lane: lane.id, side, at: head },
    launch: (invDir) => {
      mkdirSync(dirOf(invDir), { recursive: true });
      const executor = { [OWNER_ENV]: jobOwnerLabel(ctx.plan().arc, job), ...instanceEnv(held?.resources ?? []), ...witnessEnv(reporter, absPath(join(dirOf(invDir), WITNESS_LINES))) };
      return {
        argv: lane.argv, cwd: absPath(join(checkout, lane.cwd)), env: { ...env, ...executor }, stdinPath: null, stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS,
        terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
      };
    },
  });
  const minutes = (Date.now() - startedAt) / 60_000;
  const invDir = invocationDir(ctx.runDir, outcome.inv);
  const dir = dirOf(invDir);
  mkdirSync(dir, { recursive: true });
  await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${job}`, parent, {
    source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
  });
  if (held !== null) {
    const cleaned = await cleanup(ctx, held, parent);
    if (cleaned.kind !== 'released') throw new Error(`${job}: suite lane ${lane.id}'s reservation was not released: ${cleaned.kind}`);
  }
  await removeJobCheckouts(ctx, job);
  if (outcome.kind === 'lost') return { passed: null, tests: null, minutes };
  if (outcome.result.type !== 'command') throw new Error(`${outcome.inv}: a proof lane produced a ${outcome.result.type} result`);
  const { verdict } = outcome.result;
  const passed = verdict === 'pass' ? true : verdict === 'fail' ? false : null;
  return { passed, tests: collectWitness(reporter, { witnessFile: absPath(join(dir, WITNESS_LINES)), stdoutFile: absPath(join(invDir, STDOUT_FILE)) }), minutes };
}
