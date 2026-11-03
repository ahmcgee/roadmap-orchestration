// Profile ownership across real CLI/supervisor/executor restarts, with PATH-backed fake backends.
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { basename,join } from 'node:path';
import { after,test } from 'node:test';
import { terminalReceipt } from '../src/commands/queue.ts';
import { commandId } from '../src/core/ids.ts';
import { atSeat } from '../src/routing/types.ts';
import { arcScopeOf,provenanceStack,resolveRouting,seatsInForce } from '../src/routing/layers.ts';
import { hasMilestones } from '../src/input/plan.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { absPath } from '../src/core/values.ts';
import { EXEC_TIMEOUT_MS,SMOKE_DEFAULT,cli,execEnv,hostFile,journalOf,reasonOf,setupExec,startExec,until,type ExecRun } from './fixtures/exec-common.ts';
import { CLAUDE_ONLY,UNIT_CLAUDE_ONLY,WAIT_MS,claimOf,cmdline,executorOf,gone,kill,pausedFromTheStart,smokes,startCli,startLine,supervisorOf } from './fixtures/sup-common.ts';
import { runFixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { git,tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

after(assertNoSurvivors);
const T = { timeout: EXEC_TIMEOUT_MS };
const startProfile = (r: ExecRun): string => JSON.parse(readFileSync(join(r.runDir, 'start.json'), 'utf8')).profile;
const provenance = (r: ExecRun) => journalOf(r).view.planApplied()!.routingProvenance;
function claudeSeats(r: ExecRun): void {
  const { plan } = requirePlanInForce(absPath(r.runDir), journalOf(r).view);
  const resolved = resolveRouting(provenanceStack(provenance(r), arcScopeOf(plan), null, hasMilestones(plan)));
  assert.ok(seatsInForce(resolved).every((seat) => atSeat(resolved.table, seat).backend === 'claude'));
}
// sup-common's idle waits for every backend ever smoked by the arc. A routing
// apply can remove Codex, so require the exact backend set of this generation here.
async function profileIdle(r: ExecRun, generation: number) {
  await until(() => {
    const { events, view } = journalOf(r);
    const started = events.findIndex((e) => e.type === 'fact' && e.fact.kind === 'executor-started' && e.fact.generation === generation);
    if (started === -1 || !view.control().pausedAll) return false;
    const done = events.slice(started).flatMap((e) => e.type === 'intent' && e.kind === 'proc.spawn'
      && e.expect.subject.purpose === 'smoke' && e.expect.subject.target.type === 'backend' && view.doneOf(e.op) !== null
      ? [e.expect.subject.target.backend] : []);
    const expected = startProfile(r) === 'claude-only' ? ['claude'] : ['claude', 'codex'];
    return done.length === expected.length && expected.every((backend) => done.includes(backend as 'claude' | 'codex'));
  }, WAIT_MS, `generation ${generation}'s profile smoke and pause`);
  return executorOf(r, generation);
}
async function stop(r: ExecRun): Promise<void> {
  const supervisor = supervisorOf(r);
  await cli(r, ['stop']);
  await gone(supervisor);
}
async function ready(r: ExecRun, flags: readonly string[]): Promise<number> {
  const exit = await startCli(r, flags);
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  const line = startLine(exit);
  assert.equal(line.kind, 'ready', exit.stdout);
  await profileIdle(r, line.generation!);
  return line.generation!;
}
function unchanged(r: ExecRun): readonly string[] {
  return ['start.json', 'events.jsonl'].map((f) => readFileSync(join(r.runDir, f), 'utf8')).concat(
    ['host.generation', 'supervisor.state.json'].map((f) => readFileSync(hostFile(r, f), 'utf8')),
  );
}
async function refuses(r: ExecRun, requested: string, recorded: string): Promise<void> {
  const before = unchanged(r);
  const exit = await startCli(r, ['--profile', requested]);
  assert.equal(exit.code, 78, exit.stdout + exit.stderr);
  const reason = reasonOf(exit);
  assert.ok(reason.kind === 'refused');
  assert.deepEqual(reason.rejections, [{ kind: 'profile-conflict', requested, recorded,
    detail: `The arc's recorded profile is ${recorded}; --profile ${requested} conflicts. Change the profile with a routing apply.` }]);
  assert.equal(claimOf(r), null, 'no host claimed');
  assert.deepEqual(unchanged(r), before, 'no generation, startup state or journal changed');
}

test('restart.profile: omitted and matching flags retain claude-only; a conflicting flag refuses before claim', T, async (t) => {
  const r = setupExec(t, { steps: smokes(4) });
  await pausedFromTheStart(r);
  await ready(r, CLAUDE_ONLY);
  await stop(r);
  await refuses(r, 'default', 'claude-only');
  await ready(r, []);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  await stop(r);
  const generation = await ready(r, CLAUDE_ONLY);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  await kill(await executorOf(r, generation));
  await profileIdle(r, generation + 1);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  assert.equal(readCalls(r.scenarioPath).length, 4);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.as === 'claude' && c.step !== null));
});

test('restart.profile-paused: default arc paused then stopped refuses explicit claude-only instead of silently retaining default (field defect 2)', T, async (t) => {
  const r = setupExec(t, { steps: SMOKE_DEFAULT });
  await pausedFromTheStart(r);
  await ready(r, []);
  assert.equal(startProfile(r), 'default', 'first start without config falls back to default');
  assert.equal(provenance(r).profile, 'default');
  await stop(r);
  await refuses(r, 'claude-only', 'default');
});

test('restart.profile-config: repo config selects only the first start; later config defaults cannot replace recorded routing', T, async (t) => {
  const r = setupExec(t, { steps: smokes(2) });
  mkdirSync(join(r.repo, '.roadmap'), { recursive: true });
  const config = join(r.repo, '.roadmap/config.json');
  const original = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...original, routing: { profile: 'claude-only' } }));
  git(r.repo, 'add', '.roadmap/config.json');
  git(r.repo, 'commit', '-m', 'select claude-only');
  await pausedFromTheStart(r);
  await ready(r, []);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  await stop(r);
  writeFileSync(config, JSON.stringify({ ...original, routing: { profile: 'default' } }));
  git(r.repo, 'add', '.roadmap/config.json');
  git(r.repo, 'commit', '-m', 'change default for new arcs');
  await ready(r, []);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
});

async function applyEdit(r: ExecRun, edit: (plan: Record<string, unknown>) => void): Promise<void> {
  const out = join(tmpDir('profile-export'), 'inputs');
  const rev = journalOf(r).view.planApplied()!.rev;
  await cli(r, ['inputs', 'export', '--out', out]);
  const planPath = join(out, basename(r.planPath));
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  edit(plan);
  writeFileSync(planPath, JSON.stringify(plan));
  const submitted = await cli(r, ['apply', '--from', out, '--rev', String(rev), '--reason', 'Change routing profile']);
  const id = commandId(JSON.parse(submitted.stdout).command);
  await until(() => terminalReceipt(absPath(r.runDir), id) !== null, WAIT_MS, 'routing apply receipt');
  const receipt = terminalReceipt(absPath(r.runDir), id)!;
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
}

async function applyProfile(r: ExecRun, profile: string | null): Promise<void> {
  await applyEdit(r, (plan) => {
    if (profile === null) delete plan['routing'];
    else plan['routing'] = { profile };
  });
}

test('restart.profile-apply: routing apply supersedes stale start.json and supervisor flags, survives resume-arc and crash respawn', T, async (t) => {
  const r = setupExec(t, { steps: [...SMOKE_DEFAULT, ...smokes(1), SMOKE_DEFAULT[1]!, ...SMOKE_DEFAULT, ...smokes(1)] });
  await pausedFromTheStart(r);
  const generation = await ready(r, ['--profile', 'default']);
  await applyProfile(r, 'claude-only');
  assert.equal(provenance(r).profile, 'claude-only');
  assert.equal(startProfile(r), 'default', 'start.json is only a startup snapshot, stale after a routing apply');
  claudeSeats(r);
  // Removing an explicit plan profile keeps the profile now in force, rather than the old startup base.
  await applyProfile(r, null);
  assert.equal(provenance(r).profile, 'claude-only');
  // The live supervisor still has --profile default in its original arguments.
  await kill(await executorOf(r, generation));
  const respawn = await profileIdle(r, generation + 1);
  assert.equal(cmdline(respawn).includes('--profile'), false, 'respawns read recorded routing instead of replaying CLI selection');
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  // A host restart must also ignore a stale startup snapshot. The file is naturally stale
  // on the first apply; switch back and forth through routing applies to reproduce that here.
  await applyProfile(r, 'default');
  assert.equal(startProfile(r), 'claude-only');
  assert.equal(provenance(r).profile, 'default', 'resume-arc must ignore the stale startup snapshot');
  await kill(supervisorOf(r));
  await kill(await executorOf(r, generation + 1));
  const resumed = startLine(await runFixture('exec-cli.ts', [r.hostDir, 'resume-arc', '--repo', r.repo], { env: execEnv(r), timeoutMs: WAIT_MS }));
  assert.equal(resumed.kind, 'ready');
  await profileIdle(r, resumed.generation!);
  assert.equal(startProfile(r), 'default');
  await applyProfile(r, 'claude-only');
  await applyProfile(r, null);
  await stop(r);
  await ready(r, []);
  assert.equal(startProfile(r), 'claude-only');
  claudeSeats(r);
  const calls = readCalls(r.scenarioPath);
  assert.deepEqual(calls.map((c) => c.as), ['claude', 'codex', 'claude', 'codex', 'claude', 'codex', 'claude']);
  assert.ok(calls.every((c) => c.step !== null), 'every smoke matched the profile in force');
});

test('restart.profile-build: after a flagless restart the build runs on Claude', T, async (t) => {
  const r = setupExec(t, { steps: [...smokes(3), ...UNIT_CLAUDE_ONLY] });
  await pausedFromTheStart(r);
  await ready(r, CLAUDE_ONLY);
  await stop(r);
  await ready(r, []);
  await applyEdit(r, (plan) => { plan['direction'] = 'Keep the recorded profile across an ordinary revision.'; });
  assert.equal(provenance(r).profile, 'claude-only');
  claudeSeats(r);
  await stop(r);
  const running = startExec(r);
  await until(() => claimOf(r) !== null, WAIT_MS, 'restart claim');
  await cli(r, ['resume']);
  const exit = await running.exit;
  assert.equal(exit.code, 0, exit.stdout + exit.stderr);
  assert.equal(reasonOf(exit).kind, 'complete');
  assert.equal(readCalls(r.scenarioPath).length, 6);
  assert.ok(readCalls(r.scenarioPath).every((c) => c.as === 'claude' && c.step !== null));
});
