// M4a rev 3 step N6 (F9, dx2 7): `roadmap resume-arc --repo <repo>` (src/commands/resumearc.ts), a boot hook's host act,
// through real processes: the real CLI, the real supervisor and executor of a paused claude-only arc, killed to leave a
// claim with a dead owner (as a host restart does). Named tests: resumearc.noop-no-claim, resumearc.noop-alive,
// resumearc.dead-owner-restarts, resumearc.race-noop.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { assertNoSurvivors } from './helpers/reap.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { EXEC_TIMEOUT_MS, type ExecRun, execEnv, setupExec } from './fixtures/exec-common.ts';
import { claimOf, executorOf, idle, kill, pausedFromTheStart, smokes, startCli, startLine, supervisorOf } from './fixtures/sup-common.ts';

after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };

/** `roadmap resume-arc --repo <repo>` as a child on the arc's host dir: its exit code and its one JSON line. */
async function resumeArc(r: ExecRun, repo: string = r.repo): Promise<Readonly<{ code: number | null; line: Record<string, unknown> }>> {
  const out = await runFixture('exec-cli.ts', [r.hostDir, 'resume-arc', '--repo', repo], { env: execEnv(r), timeoutMs: 120_000 });
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `resume-arc printed ${out.stdout}; stderr ${out.stderr}`);
  return { code: out.code, line: JSON.parse(lines[0]!) as Record<string, unknown> };
}

/** Kills the supervisor first (nobody restarts or releases), then the executor: the claim stays, its owner dead. */
async function hostRestart(r: ExecRun, generation: number): Promise<void> {
  const supervisor = supervisorOf(r);
  await kill(supervisor);
  await kill(await executorOf(r, generation));
}

test('resumearc.noop-no-claim / resumearc.noop-alive / resumearc.dead-owner-restarts / resumearc.race-noop', T, async (t) => {
  const r = setupExec(t, { steps: smokes(4) });
  assert.deepEqual(await resumeArc(r), { code: 0, line: { resumed: false, reason: 'no-claim' } }, 'nothing holds the host');

  await pausedFromTheStart(r);
  const started = startLine(await startCli(r));
  assert.equal(started.kind, 'ready', JSON.stringify(started));
  const g1 = started.generation!;
  await idle(r, g1);
  assert.deepEqual(await resumeArc(r), { code: 0, line: { resumed: false, reason: 'alive' } }, 'a live owner is left alone');
  assert.deepEqual(await resumeArc(r, tmpDir('other-repo')), { code: 0, line: { resumed: false, reason: 'other-repo' } });

  // A host restart: the claim names this repo, its owner is dead. resume-arc relaunches start.json's plan and profile.
  await hostRestart(r, g1);
  assert.equal(claimOf(r)?.generation, g1, 'the dead claim stays');
  const resumed = await resumeArc(r);
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(resumed.line['kind'], 'ready', JSON.stringify(resumed));
  const g2 = resumed.line['generation'] as number;
  assert.ok(g2 > g1);
  await idle(r, g2);
  assert.deepEqual(await resumeArc(r), { code: 0, line: { resumed: false, reason: 'alive' } }, 'idempotent once resumed');

  // Two boot hooks race: exactly one relaunches; the other finds the host claimed (already-resumed) or the owner alive.
  await hostRestart(r, g2);
  const both = await Promise.all([resumeArc(r), resumeArc(r)]);
  const winners = both.filter((b) => b.line['kind'] === 'ready');
  assert.equal(winners.length, 1, JSON.stringify(both));
  const loser = both.find((b) => b.line['kind'] !== 'ready')!;
  assert.equal(loser.code, 0);
  assert.equal(loser.line['resumed'], false);
  assert.ok(['already-resumed', 'alive'].includes(loser.line['reason'] as string), JSON.stringify(loser));
  await idle(r, winners[0]!.line['generation'] as number);
});
