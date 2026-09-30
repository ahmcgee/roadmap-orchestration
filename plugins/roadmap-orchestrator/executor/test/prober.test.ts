// The coalesced prober (src/park/probe.ts) and the dispatch side of backend parks (src/pipeline/dispatch.ts),
// with real journals, runners and fake backends behind PATH shims. Backend targets smoke through the fake;
// host targets use an injected host sample and the real shell command; resource targets run the reclaim order.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { freshClaudeImplementerSession, freshJudgmentSession } from '../src/backends/argv.ts';
import type { ProbeTarget, StageOutcomeFact } from '../src/core/events.ts';
import { commandId, invocationId, opId, poolInstance, sha256, specRev, unitId } from '../src/core/ids.ts';
import type { BackendResult } from '../src/core/records.ts';
import { absPath, isoTimeOf } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { createProber } from '../src/park/probe.ts';
import { dueJobs } from '../src/park/schedule.ts';
import {
  type BackendCallOutcome, callBackend, implementerDispatch, judgmentDispatch, pinDispatch, sessionNeverPersisted, verdictOf,
} from '../src/pipeline/dispatch.ts';
import { outcomeFact } from '../src/pipeline/transitions.ts';
import { SMOKE_SCHEMA } from '../src/preflight/smoke.ts';
import { cleanup, reserve, run as runReservation } from '../src/resources/reserve.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { capturedClaudeResult, readCalls } from './helpers/scenario.ts';
import { BUSY, BUILD_CLEANUP_FAILED, LANES_BLOCKED, SALVAGE_COMMIT_FAILED, newProbeRun, openProbeRun, parkBackend, parkUnit, seedArc } from './fixtures/probe-common.ts';
import { ESTATE } from './fixtures/pool-plan.ts';
import { seated, setupUnit } from './fixtures/stage-common.ts';

const T = { timeout: 120_000 };
const OK = { ok: true } as const;
const U1 = unitId('u1');
const U2 = unitId('u2');
const U3 = unitId('u3');
const HOST: ProbeTarget = { type: 'host' };
const CLAUDE: ProbeTarget = { type: 'backend', backend: 'claude' };
const CMD = commandId('cmd-0123456789abcdef');
const claudeOk = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] } as const;
const claudeFails = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'exit', code: 1 }] } as const;
const signal = (): AbortSignal => new AbortController().signal;

/** A backend-park needs its failed invocation; any id of the arc stands in for it here. */
const someInv = (arc: string) => invocationId(opId(arc as never, 1), 1);

const hold = (unit: typeof U1, parkSeq: number): StageOutcomeFact => ({
  kind: 'stage-outcome', unit, stage: 'plan-check', attempt: 1, outcome: 'interrupted', class: 'hold', chargeable: false,
  cause: { type: 'backend', backend: 'claude', parkSeq },
} as StageOutcomeFact);

describe('prober: backend targets (F12)', () => {
  it('probe.stale-epoch-ignored: a pass bound to an older park epoch does not clear a newer park of the backend', T, async () => {
    const r = newProbeRun([claudeOk, claudeOk]);
    const { ctx, journal } = openProbeRun(r);
    seedArc(journal, [U1]);
    const p1 = parkBackend(journal, 'claude', 'capacity', someInv(journal.view.arc));
    const prober = createProber(ctx);
    const [job] = prober.due(journal.view, new Date());
    assert.deepEqual(job, { target: CLAUDE, covers: [p1] });
    const running = prober.run(job!, signal());
    assert.deepEqual(prober.running(), ['backend:claude']);
    assert.deepEqual(prober.due(journal.view, new Date()), [], 'one job per target at a time');
    // A newer park of the backend lands while the probe's smoke runs.
    const p2 = parkBackend(journal, 'claude', 'capacity', someInv(journal.view.arc));
    assert.equal(await running, 'pass');
    assert.deepEqual(journal.view.backendParks(), [{ backend: 'claude', seq: p2, class: 'capacity' }], 'the stale pass cleared nothing');
    const [again] = prober.due(journal.view, new Date());
    assert.deepEqual(again, { target: CLAUDE, covers: [p2] }, 'the newer epoch is probed at once');
    assert.equal(await prober.run(again!, signal()), 'pass');
    assert.deepEqual(journal.view.backendParks(), []);
    assert.deepEqual(readCalls(join(r.binDir, '..', 'scenario.json')).map((c) => c.as), ['claude', 'claude']);
    journal.close();
  });

  it('probe.usage-limit-dominates: a usage limit over a retryable park is never probed or cleared by a probe; resume --backend clears it', T, async () => {
    const r = newProbeRun([claudeOk, claudeOk]);
    const { ctx, journal } = openProbeRun(r);
    seedArc(journal, [U1]);
    const p1 = parkBackend(journal, 'claude', 'capacity', someInv(journal.view.arc));
    const prober = createProber(ctx);
    const [job] = prober.due(journal.view, new Date());
    const running = prober.run(job!, signal());
    const p2 = parkBackend(journal, 'claude', 'usage-limit', someInv(journal.view.arc));
    assert.equal(await running, 'pass');
    assert.deepEqual(journal.view.backendParks(), [{ backend: 'claude', seq: p2, class: 'usage-limit' }]);
    assert.deepEqual(prober.due(journal.view, new Date(Date.now() + 24 * 3600_000)), [], 'D4: a usage limit is never probed');
    // A later capacity park keeps the usage-limit class (dominance) under its newer epoch.
    const p3 = parkBackend(journal, 'claude', 'capacity', someInv(journal.view.arc));
    assert.deepEqual(journal.view.backendParks(), [{ backend: 'claude', seq: p3, class: 'usage-limit' }]);
    assert.deepEqual(prober.due(journal.view, new Date()), []);
    assert.deepEqual(await prober.resumeBackend('claude', CMD, signal()), { kind: 'resumed' });
    assert.deepEqual(journal.view.backendParks(), []);
    journal.close();
  });

  it('resume-backend.via-prober: the smoke runs through the prober; a failure keeps the park, a pass releases exactly the holds the park caused', T, async () => {
    const r = newProbeRun([claudeFails, claudeOk]);
    const { ctx, journal } = openProbeRun(r);
    seedArc(journal, [U1, U2]);
    const p = parkBackend(journal, 'claude', 'usage-limit', someInv(journal.view.arc));
    journal.fact(hold(U1, p));
    journal.fact(hold(U2, p));
    journal.fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: U2 } });
    const prober = createProber(ctx);

    const failed = await prober.resumeBackend('claude', commandId('cmd-0123456789abcde1'), signal());
    assert.equal(failed.kind, 'smoke-failed');
    assert.match(failed.kind === 'smoke-failed' ? failed.detail : '', /failed/);
    assert.deepEqual(journal.view.parkedBackends(), ['claude']);
    assert.equal(journal.view.unit(U1).status, 'held');

    assert.deepEqual(await prober.resumeBackend('claude', commandId('cmd-0123456789abcde2'), signal()), { kind: 'resumed' });
    assert.deepEqual(journal.view.parkedBackends(), []);
    assert.equal(journal.view.unit(U1).status, 'active', 'the hold the park caused is released');
    assert.equal(journal.view.unit(U2).status, 'held', 'an operator pause is kept');
    assert.deepEqual(await prober.resumeBackend('claude', commandId('cmd-0123456789abcde3'), signal()), { kind: 'not-parked' });
    const smokes = journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'smoke');
    assert.deepEqual(smokes.map((i) => i.key), ['smoke/probe-backend-claude', 'smoke/probe-backend-claude']);
    journal.close();
  });
});

describe('prober: host and resource targets (G7, F2)', () => {
  it('probe.host-late-park-not-covered: a host park that arrives while a probe runs is not recovered by it, and is probed next', T, async () => {
    const r = newProbeRun([]);
    const { ctx, journal } = openProbeRun(r);
    seedArc(journal, [U1, U2]);
    const p1 = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    const prober = createProber(ctx);
    const [job] = prober.due(journal.view, new Date());
    assert.deepEqual(job, { target: HOST, covers: [p1] });
    const running = prober.run(job!, signal());
    const p2 = parkUnit(journal, U2, LANES_BLOCKED, 1, [HOST]);
    assert.equal(await running, 'pass');
    const probe = journal.view.probes().find((x) => x.target.type === 'host');
    assert.deepEqual(probe?.covers, [p1]);
    assert.equal(journal.view.unit(U1).status, 'active', 'the covered park recovered');
    assert.equal(journal.view.unit(U2).status, 'park-pending', 'the late park did not');
    assert.deepEqual(prober.due(journal.view, new Date()), [{ target: HOST, covers: [p2] }]);
    assert.equal(await prober.run({ target: HOST, covers: [p2] }, signal()), 'pass');
    assert.equal(journal.view.unit(U2).status, 'active');
    journal.close();
  });

  it('a busy host fails the probe with a backoff; a salvage park\'s worktree must answer git status (the covered park\'s local check)', T, async () => {
    const r = newProbeRun([]);
    const { ctx, journal, host } = openProbeRun(r);
    seedArc(journal, [U1, U3]);
    const prober = createProber(ctx);
    const p1 = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    host.sample = BUSY;
    assert.equal(await prober.run({ target: HOST, covers: [p1] }, signal()), 'fail');
    const failed = journal.view.probes()[0]!;
    assert.equal(failed.result, 'fail');
    assert.ok(failed.nextProbeAt !== null && Date.parse(failed.nextProbeAt) > Date.now());
    assert.equal(journal.view.unit(U1).status, 'park-pending');

    host.sample = { ...BUSY, load1: 1 };
    const p3 = parkUnit(journal, U3, SALVAGE_COMMIT_FAILED, 1, [HOST]);
    // u3's worktree does not exist yet: its local check fails, so the whole job does.
    assert.equal(await prober.run({ target: HOST, covers: [p1, p3] }, signal()), 'fail');
    // The pool plan's worktree root is /var/tmp: the arc's own dir there goes when the test ends.
    const arcDir = join(ctx.plan().worktreeRoot, ctx.plan().arc);
    const wt = join(arcDir, U3);
    mkdirSync(wt, { recursive: true });
    try {
      git(wt, 'init', '-q');
      assert.equal(await prober.run({ target: HOST, covers: [p1, p3] }, signal()), 'pass');
    } finally {
      rmSync(arcDir, { recursive: true, force: true });
    }
    assert.deepEqual([journal.view.unit(U1).status, journal.view.unit(U3).status], ['active', 'active']);
    journal.close();
  });

  it('a resource target runs the reclaim order under the parked attempt\'s retry holder, then records the pass', T, async () => {
    const r = newProbeRun([]);
    const { ctx, journal } = openProbeRun(r);
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    seedArc(journal, [U1]);
    const holder = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;
    const parent = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;
    const got = reserve(ctx, holder, { named: [], pools: [ESTATE], cpu: 0, publication: false }, parent);
    assert.equal(got.state, 'reserved');
    if (got.state !== 'reserved') return;
    const cleaned = await cleanup(ctx, runReservation(ctx, got, parent), parent);
    assert.equal(cleaned.kind, 'cleanup-failed');
    const instance = poolInstance(ESTATE, 1);
    const p = parkUnit(journal, U1, BUILD_CLEANUP_FAILED, 1, [{ type: 'resource', instance }]);
    assert.equal(undispositioned(absPath(r.hostDir)).length, 1);

    const prober = createProber(ctx);
    const [job] = prober.due(journal.view, new Date());
    assert.deepEqual(job, { target: { type: 'resource', instance }, covers: [p] });
    assert.equal(await prober.run(job!, signal()), 'pass');
    assert.equal(journal.view.unit(U1).status, 'active');
    assert.deepEqual(undispositioned(absPath(r.hostDir)), [], 'disposed before the pass');
    assert.ok(readResidues(absPath(r.hostDir)).some((l) => l.type === 'disposition' && l.disposition === 'cleaned'));
    assert.deepEqual(journal.view.resources().get(instance)?.status, { state: 'free' });
    const retry = journal.view.opsOf('resource.transition').filter((i) => i.expect.holder.type === 'retry');
    assert.deepEqual(retry.map((i) => [i.expect.holder, i.expect.edge.type]), [
      [{ type: 'retry', unit: U1, stage: 'build', attempt: 1 }, 'reclaim'], [{ type: 'retry', unit: U1, stage: 'build', attempt: 1 }, 'release'],
    ]);
    assert.deepEqual(dueJobs(journal.view, new Date()), []);
    journal.close();
  });

  it('a job cancelled by its signal records nothing', T, async () => {
    const r = newProbeRun([]);
    const { ctx, journal } = openProbeRun(r);
    seedArc(journal, [U1]);
    const p = parkUnit(journal, U1, LANES_BLOCKED, 1, [HOST]);
    const aborted = new AbortController();
    aborted.abort(new Error('stop'));
    await assert.rejects(createProber(ctx).run({ target: HOST, covers: [p] }, aborted.signal), /stop/);
    assert.deepEqual(journal.view.probes(), []);
    journal.close();
  });
});

describe('dispatch: backend park epochs, hold causes, instance env, sessions (G5, F7)', () => {
  /** A `claude` that answers every call with the CLI's capacity error (HTTP 529), as the captured error stream has it. */
  function capacityBin(): string {
    const dir = tmpDir('capacity-bin');
    const out = join(dir, 'stdout.jsonl');
    writeFileSync(out, `${JSON.stringify({ ...capturedClaudeResult('claude-api-error'), result: 'Overloaded', api_error_status: 529 })}\n`);
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat ${JSON.stringify(out)}\nexit 1\n`, { mode: 0o755 });
    return dir;
  }

  it('probe.capacity-recovers-held-unit: a capacity error parks the backend with an epoch, the unit holds with that cause, and a passing probe releases it', T, async () => {
    const run = setupUnit({ steps: [claudeOk], profile: 'claude-only' });
    const capacity = { ...run.ctx, hostEnv: { ...run.ctx.hostEnv, PATH: `${capacityBin()}:${run.ctx.hostEnv['PATH'] ?? ''}` } };
    seated(pinDispatch(run.ctx, run.unit, { rev: specRev(1), sha256: sha256('1'.repeat(64)) }));
    const parent = { type: 'stage', unit: run.unit.id, stage: 'plan-check', attempt: 1 } as const;
    const called = await callBackend(capacity, {
      unit: run.unit.id, parent, request: { kind: 'judgment', dispatch: seated(judgmentDispatch(run.ctx, run.unit.id, 'plan-check')), session: freshJudgmentSession(), evidenceDirs: [] },
      system: 'check', rendered: 'check', schema: SMOKE_SCHEMA, cwd: run.repo, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
    });
    const v = verdictOf(capacity, parent, called);
    assert.equal(v.kind, 'interrupted');
    if (v.kind !== 'interrupted') return;
    const [park] = run.journal.view.backendParks();
    assert.deepEqual(park && [park.backend, park.class], ['claude', 'capacity']);
    assert.deepEqual(v.cause, { type: 'backend', backend: 'claude', parkSeq: park!.seq }, 'the hold names the park epoch');
    assert.equal(v.needsUser, null, 'a capacity park is retryable: nobody is asked');
    run.journal.fact(outcomeFact(run.journal.view.unit(run.unit.id), { stage: 'plan-check', kind: 'interrupted' }, 1, { cause: v.cause! }));
    assert.equal(run.journal.view.unit(run.unit.id).status, 'held');

    const prober = createProber({ ...run.ctx, profile: 'claude-only', sample: () => BUSY });
    const [job] = prober.due(run.journal.view, new Date());
    assert.deepEqual(job, { target: CLAUDE, covers: [park!.seq] });
    assert.equal(await prober.run(job!, signal()), 'pass');
    assert.deepEqual(run.journal.view.backendParks(), []);
    assert.equal(run.journal.view.unit(run.unit.id).status, 'active', 'the held unit is released');
    run.journal.close();
  });

  it('a usage-limit error keeps its blocking item and names the park as the hold\'s cause', T, async () => {
    const run = setupUnit({ steps: [{ as: 'claude', expect: {}, acts: [{ type: 'usageLimit' }] }], profile: 'claude-only' });
    seated(pinDispatch(run.ctx, run.unit, { rev: specRev(1), sha256: sha256('1'.repeat(64)) }));
    const parent = { type: 'stage', unit: run.unit.id, stage: 'plan-check', attempt: 1 } as const;
    const called = await callBackend(run.ctx, {
      unit: run.unit.id, parent, request: { kind: 'judgment', dispatch: seated(judgmentDispatch(run.ctx, run.unit.id, 'plan-check')), session: freshJudgmentSession(), evidenceDirs: [] },
      system: 'check', rendered: 'check', schema: SMOKE_SCHEMA, cwd: run.repo, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
    });
    const v = verdictOf(run.ctx, parent, called);
    assert.ok(v.kind === 'interrupted');
    const [park] = run.journal.view.backendParks();
    assert.deepEqual(v.cause, { type: 'backend', backend: 'claude', parkSeq: park!.seq });
    assert.deepEqual([v.needsUser?.reason, v.needsUser?.blocking], ['usage-limit', true]);
    run.journal.close();
  });

  it('the implementer launch env binds the pool instances its build holds (F7)', T, async () => {
    const r = newProbeRun([{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] }]);
    const { ctx, journal } = openProbeRun(r);
    const unit = ctx.plan().units[0]!;
    seated(pinDispatch(ctx, unit, { rev: specRev(1), sha256: sha256('1'.repeat(64)) }));
    const parent = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;
    const got = reserve(ctx, { type: 'stage', unit: U1, stage: 'build', attempt: 1 }, { named: [], pools: [ESTATE], cpu: 0, publication: false }, parent);
    assert.equal(got.state, 'reserved');
    const cwd = tmpDir('impl-cwd');
    const called = await callBackend(ctx, {
      unit: U1, parent, request: { kind: 'implementer', dispatch: seated(implementerDispatch(ctx, U1)), session: freshClaudeImplementerSession(), evidenceDirs: [] },
      system: 'build', rendered: 'build', schema: SMOKE_SCHEMA, cwd: absPath(cwd), deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
    });
    const launch = runnerFiles(called.invDir, called.inv).read('launch.json');
    assert.equal(launch?.env['RESOURCE_INSTANCE_ESTATE'], '1');
    assert.equal(launch?.env['RESOURCE_OWNER'], `${ctx.plan().arc}/u1`);
    journal.close();
  });

  it('sessionNeverPersisted: a resuming round\'s process fault with no complete JSON line on stdout, and nothing else', () => {
    const dir = tmpDir('npers');
    const inv = invocationId(opId('arc-1' as never, 3), 1);
    const called = (stdout: string | null, kind: 'process-fault' | 'malformed'): BackendCallOutcome => {
      const invDir = join(dir, `${Math.random()}`);
      mkdirSync(invDir);
      if (stdout !== null) writeFileSync(join(invDir, 'stdout'), stdout);
      return { kind: 'result', inv, invDir: absPath(invDir), result: { outcome: { kind, detail: 'exit 1' } } as unknown as BackendResult };
    };
    for (const round of ['resume', 'fix', 'continue'] as const) {
      assert.equal(sessionNeverPersisted(round, called('', 'process-fault')), true, round);
      assert.equal(sessionNeverPersisted(round, called(null, 'process-fault')), true, `${round}: no stdout file`);
      assert.equal(sessionNeverPersisted(round, called('{"type":"sys', 'process-fault')), true, `${round}: a torn line is not complete`);
      assert.equal(sessionNeverPersisted(round, called('{"type":"system"}\n', 'process-fault')), false, `${round}: the CLI got going`);
      assert.equal(sessionNeverPersisted(round, called('', 'malformed')), false);
    }
    assert.equal(sessionNeverPersisted('fresh', called('', 'process-fault')), false, 'a fresh session has nothing to resume');
    assert.equal(sessionNeverPersisted('resolve', called('', 'process-fault')), false);
    assert.equal(sessionNeverPersisted('fix', { kind: 'lost', inv, invDir: absPath(dir), treeEffects: false }), false);
  });
});
