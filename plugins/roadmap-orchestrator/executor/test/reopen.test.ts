// Post-completion PR fixes (owner ruling 2026-10-16): an arc's life ends when its PR merges, not at `arc-completed`.
// Through real processes (the real CLI, supervisor and executor, fake backends, a bare origin and the fake forge): a
// completed arc reopened by fix units added to its plan and `roadmap start` run again merges them and completes again,
// and `roadmap pr` fast-forwards the same PR; once the next arc started on its head, the reopen is refused
// `arc-superseded`. A reopening start that died before its revision (a host restart) leaves a claim on a completed arc,
// which `roadmap resume-arc` relaunches. Named tests: reopen.fix-unit-and-pr-ff, reopen.resume-arc-relaunches,
// reopen.refused-after-next-started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openPr } from '../src/commands/pr.ts';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { arcId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { EXIT_REASON_FILE } from '../src/executor.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { HOST_LOCK, hostPath } from '../src/host/hostdir.ts';
import { publishOwner } from '../src/host/owner.ts';
import { runDir as runDirOf } from '../src/input/cli.ts';
import { readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { makeForge } from './helpers/forge.ts';
import { attachOrigin, makeBareOrigin, originRef } from './helpers/origin.ts';
import { runFixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { claimRecord } from './fixtures/host-records.ts';
import { BASE } from './fixtures/route-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, execEnv, hostFile, hostLockHeld, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';

after(assertNoSurvivors);

const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];
const BRANCH = 'integration';
type Json = Record<string, unknown>;

function editPlan(planPath: string, edit: (plan: Json & { units: Json[] }) => void): void {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Json & { units: Json[] };
  edit(plan);
  writeFileSync(planPath, JSON.stringify(plan));
}

/** Adds fix unit `id` (its spec a copy of u1's) at high priority, as a PR fix is added. */
function addFixUnit(r: ExecRun, id: string): void {
  const spec = JSON.parse(readFileSync(join(r.planPath, '..', 'u1.json'), 'utf8')) as Json;
  writeFileSync(join(r.planPath, '..', `${id}.json`), JSON.stringify({ ...spec, unit: id, rev: 1 }));
  editPlan(r.planPath, (p) => void p.units.push({ ...p.units[0]!, id, spec: `${id}.json`, priority: 'high' }));
}

test('reopen.fix-unit-and-pr-ff, reopen.resume-arc-relaunches, reopen.refused-after-next-started: a completed arc reopened by a fix unit and a start merges it and completes again, roadmap pr fast-forwards the same PR; a dead reopening start\'s claim is relaunched by resume-arc; once the next arc started on its head the reopen is refused arc-superseded', { timeout: 2 * EXEC_TIMEOUT_MS }, async (t) => {
  const r = setupExec(t, {
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild({ 'src/fix.js': 'export const fix = 1;\n' }), gateStep({ decision: 'approve' }),
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild({ 'src/fix2.js': 'export const fix2 = 2;\n' }), gateStep({ decision: 'approve' }),
    ],
  });
  git(r.repo, 'branch', BRANCH, 'main');
  editPlan(r.planPath, (p) => void (p['integrationBranch'] = BRANCH));
  const origin = makeBareOrigin();
  attachOrigin(r.repo, origin);
  const forge = makeForge({ originPath: origin });
  const pr = async () => {
    const path = process.env['PATH'];
    process.env['PATH'] = forge.path;
    try {
      return await openPr({ repo: absPath(r.repo), arc: arcId(r.arc), supersedePrevious: false });
    } finally {
      process.env['PATH'] = path;
    }
  };

  const first = await startExec(r).exit;
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(reasonOf(first), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
  const head1 = git(r.repo, 'rev-parse', BRANCH);
  const opened = await pr();
  assert.deepEqual({ created: opened.created, base: opened.base }, { created: true, base: 'main' });
  assert.equal(originRef(origin, BRANCH), head1);

  // The PR's review asks for a fix: a fix unit in the arc's plan, and the same start again.
  addFixUnit(r, 'u2');
  const second = await startExec(r).exit;
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(reasonOf(second), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
  assert.deepEqual(outcomes(r, 'u2'), STRAIGHT);
  assert.equal((await statusOf(r)).run.state, 'complete');
  const head2 = git(r.repo, 'rev-parse', BRANCH);
  assert.notEqual(head2, head1);
  git(r.repo, 'merge-base', '--is-ancestor', head1, head2);
  const updated = await pr();
  assert.deepEqual({ number: updated.number, created: updated.created, base: updated.base }, { number: opened.number, created: false, base: 'main' }, 'the same PR');
  assert.equal(originRef(origin, BRANCH), head2, 'its branch fast-forwarded to the new completed head');
  assert.deepEqual(forge.read().mutations.map((m) => m.kind), ['pr-create'], 'nothing but the first create');

  // A second fix's reopening start dies with its supervisor before its revision (a host restart): the claim names the
  // completed arc and a dead owner. resume-arc relaunches it, and the arc runs the fix.
  addFixUnit(r, 'u3');
  const gone = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(gone.pid !== undefined);
  const dead = { pid: gone.pid, start: identityOf(gone.pid).start };
  const exited = new Promise((resolve) => gone.once('exit', resolve));
  gone.kill('SIGKILL');
  await exited;
  const generation = (JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { generation: number }).generation + 1;
  const claim = { ...claimRecord({ supervisor: dead, bootId: readBootId(), arc: arcId(r.arc), generation }), runDir: absPath(r.runDir), repo: absPath(r.repo) };
  atomicJson(hostPath(absPath(r.hostDir), HOST_LOCK), claim);
  publishOwner(absPath(r.hostDir), claim, dead);
  assert.equal((await statusOf(r)).run.state, 'complete', 'the completion is still active: the dead start applied nothing');
  const resumed = await runFixture('exec-cli.ts', [r.hostDir, 'resume-arc', '--repo', r.repo], { env: execEnv(r), timeoutMs: 120_000 });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((JSON.parse(resumed.stdout.trim()) as { kind?: string }).kind, 'ready', resumed.stdout);
  await until(async () => {
    const s = await statusOf(r);
    return s.run.state === 'complete' && s.units.find((u) => u.unit === 'u3')?.state === 'merged' && !hostLockHeld(r);
  }, 120_000, 'the relaunched arc to merge u3, complete and release the host');
  const head3 = git(r.repo, 'rev-parse', BRANCH);
  assert.equal((await pr()).number, opened.number);
  assert.equal(originRef(origin, BRANCH), head3);

  // The next arc starts on this head (its plan in force names this arc as previous): reopening this arc is refused.
  const nextDir = tmpDir('reopen-next-plan');
  cpSync(join(r.planPath, '..'), nextDir, { recursive: true });
  const nextPlan = join(nextDir, 'plan.json');
  const next = arcId(`${r.arc}-next`);
  editPlan(nextPlan, (p) => Object.assign(p, { arc: next, integrationBranch: `${BRANCH}-next`, chain: { previousArc: r.arc, previousHead: head3 } }));
  const nextRun = runDirOf(gitCommonDir(absPath(r.repo)), next);
  mkdirSync(nextRun, { recursive: true });
  const j = openJournal(nextRun, next);
  try {
    recordPlan(j, nextRun, readInputFiles(absPath(nextPlan), absPath(r.repo)), [], BASE);
  } finally {
    j.close();
  }
  addFixUnit(r, 'u4');
  const refused = await startExec(r).exit;
  assert.equal(refused.code, 78, refused.stderr);
  assert.deepEqual(reasonOf(refused), { kind: 'refused', rejections: [{ kind: 'arc-superseded', by: next }], exitCode: 78 });
});
