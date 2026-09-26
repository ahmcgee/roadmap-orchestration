// startup.rejections: every row of the startup rejection table through `runChecks` and then `smokeCheck`
// (src/preflight/checks.ts; the executor runs recovery between the two),
// over a real repo, real host files, a real journal and fake backends for the smoke. One case per kind, each
// with its exit code, and a fully valid setup that passes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { arcId, invocationId, opId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import type { ProcIdentity, RecoveryLockClaim } from '../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf, nonce } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { HOST_LOCK, RECOVERY_LOCK, hostPath, openHostDir } from '../src/host/hostdir.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { type PreviousArcVerdict, claimHost, releaseHost } from '../src/host/lock.ts';
import { publishOwner } from '../src/host/owner.ts';
import { recordResidue } from '../src/host/residues.ts';
import { runDir } from '../src/input/cli.ts';
import { type StartChecks, type StartInput, gitCommonDir, runChecks, smokeCheck } from '../src/preflight/checks.ts';
import { resolveArgv0 } from '../src/preflight/argv0.ts';
import type { SmokeReport } from '../src/preflight/smoke.ts';
import { type StartupRejection, type StartupRejectionKind, exitCodeFor } from '../src/preflight/startup.ts';
import { makeRepo, revParse, tmpDir } from './helpers/repo.ts';
import { type Step, writeScenario } from './helpers/scenario.ts';
import { FAILED, claimRecord, residueEntry } from './fixtures/host-records.ts';

const T = { timeout: 60_000 };
const OK = { ok: true } as const;
const TMPFS_MAGIC = 0x01021994;

const SMOKE_OK: readonly Step[] = [
  { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] },
  { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: OK }] },
];

type Raw = Record<string, unknown>;
type Setup = Readonly<{ repo: AbsPath; planDir: string; planFile: AbsPath; hostDir: AbsPath; binDir: string; plan: Raw; spec: Raw; arc: string }>;

const lane = (over: Raw = {}): Raw => ({
  id: 'unit', argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], ...over,
});
const tool = { argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] } };

/** A valid start: repo with a baseline on main, one unit with its spec, a writable worktree root, both fakes answering. */
function setup(steps: readonly Step[] = SMOKE_OK): Setup {
  const repo = absPath(makeRepo(tmpDir('st-repo'), { files: { 'README.md': 'hello\n', 'ARCHITECTURE.md': 'arch\n' } }));
  const arc = `st-${randomBytes(5).toString('hex')}`;
  const planDir = tmpDir('st-plan');
  const spec: Raw = {
    schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [{ ...lane(), state: 'active' }],
    acceptance: [{ id: 'A1', clause: 'It works.', failLoudIfUndelivered: true, state: 'active' }],
    scope: ['src/**'], resources: ['db'], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
  };
  const plan: Raw = {
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: revParse(repo, 'HEAD'), worktreeRoot: tmpDir('st-wt'),
    contracts: [], rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md', direction: 'test the startup table',
    suite: { lanes: [lane({ id: 'suite' })] },
    resources: [{ name: 'db', probe: tool, teardown: tool }],
    units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: ['db'] }],
  };
  const s = writeScenario(tmpDir('st-scenario'), steps);
  const hostDir = openHostDir(absPath(join(tmpDir('st-host'), 'roadmap')));
  const out = { repo, planDir, planFile: absPath(join(planDir, 'plan.json')), hostDir, binDir: s.binDir, plan, spec, arc };
  write(out);
  return out;
}

/** (Re)writes the plan and spec files from the setup's raw values. */
function write(s: Setup): void {
  writeFileSync(s.planFile, JSON.stringify(s.plan));
  writeFileSync(join(s.planDir, 'u1.json'), JSON.stringify(s.spec));
  writeFileSync(join(s.planDir, 'rulings.md'), '# Rulings\n\nC-1 — Helpers live in src/.\nC-2 — withdrawn by C-1\n');
}

function input(s: Setup, reconcile: () => Promise<PreviousArcVerdict> = async () => assert.fail('no previous arc to reconcile')): StartInput {
  return {
    repo: s.repo, planFile: s.planFile, profile: null, hostDir: s.hostDir,
    env: { ...process.env, PATH: `${s.binDir}:${process.env['PATH'] ?? ''}` },
    claim: (ctx) => claimHost(ctx.hostDir, { arc: ctx.plan.arc, runDir: ctx.runDir, repo: ctx.repo, supervisor: selfIdentity() }, reconcile),
  };
}

const runDirOf = (s: Setup): AbsPath => runDir(gitCommonDir(s.repo), arcId(s.arc));

async function deadIdentity(): Promise<ProcIdentity> {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const { start } = identityOf(pid);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return { pid, start };
}

/** A dead supervisor's claim on the host, with (or without) its owner record. */
async function deadClaim(s: Setup, opts: Readonly<{ arc?: string; owner: boolean }>) {
  const claim = claimRecord({ supervisor: await deadIdentity(), bootId: readBootId(), ...(opts.arc === undefined ? {} : { arc: arcId(opts.arc) }) });
  atomicJson(hostPath(s.hostDir, HOST_LOCK), claim);
  if (opts.owner) publishOwner(s.hostDir, claim, null);
  return claim;
}

type Checked = Extract<StartChecks, { kind: 'refused' }> | (Extract<StartChecks, { kind: 'passed' }> & Readonly<{ smoke: SmokeReport }>);

/** Groups 1 to 4, then the smoke on the journal they opened: the table in the executor's order. */
async function allChecks(i: StartInput): Promise<Checked> {
  const checks = await runChecks(i);
  if (checks.kind === 'refused') return checks;
  const smoked = await smokeCheck(checks, i.env);
  if (smoked.kind === 'refused') return { kind: 'refused', rejections: smoked.rejections, claim: checks.claim, journal: checks.journal };
  return { ...checks, smoke: smoked.smoke };
}

function refusedWith(result: Checked, kind: StartupRejectionKind, exit: 75 | 78): readonly StartupRejection[] {
  assert.equal(result.kind, 'refused', JSON.stringify(result));
  const { rejections } = result as Extract<Checked, { kind: 'refused' }>;
  assert.deepEqual(rejections.map((r) => r.kind), rejections.map(() => kind), JSON.stringify(rejections));
  assert.ok(rejections.length > 0);
  for (const r of rejections) assert.equal(exitCodeFor(r), exit);
  const r = result as Extract<Checked, { kind: 'refused' }>;
  r.journal?.close();
  return rejections;
}

describe('startup.rejections', () => {
  it('a fully valid setup produces no rejection: claimed, journal open, mode recorded, both smokes green', T, async () => {
    const s = setup();
    const result = await allChecks(input(s));
    assert.equal(result.kind, 'passed', JSON.stringify(result));
    if (result.kind !== 'passed') return;
    assert.equal(result.context.profile, 'default');
    assert.deepEqual(result.smoke.backends.map((b) => [b.backend, b.ran]), [['claude', true], ['codex', true]]);
    assert.equal(result.journal.view.containmentMode(), 'session');
    assert.equal(result.claim.arc, s.arc);
    result.journal.close();
    releaseHost(s.hostDir, result.claim);
  });

  it('legacy-roadmap-dir: a 0.x .roadmap/ layout (78)', T, async () => {
    const s = setup();
    mkdirSync(join(s.repo, '.roadmap', 'contracts'), { recursive: true });
    writeFileSync(join(s.repo, '.roadmap', 'config.json'), '{}');
    writeFileSync(join(s.repo, '.roadmap', 'state.json'), '{}');
    mkdirSync(join(s.repo, '.roadmap', 'waves'));
    const [r] = refusedWith(await allChecks(input(s)), 'legacy-roadmap-dir', 78);
    assert.deepEqual(r?.kind === 'legacy-roadmap-dir' ? r.unexpected : null, ['state.json', 'waves']);
  });

  it('plan-invalid: schema (78)', T, async () => {
    const s = setup();
    write({ ...s, plan: { ...s.plan, units: [{ id: 'u1', spec: 'u1.json', risk: 'extreme', scope: ['src/**'], resources: [] }] } });
    const [r] = refusedWith(await allChecks(input(s)), 'plan-invalid', 78);
    assert.deepEqual(r?.kind === 'plan-invalid' && r.problem.type === 'schema' ? r.problem.field : null, 'plan.units[0].risk');
  });

  it('plan-invalid: unknown spec path, baseline not an ancestor, unknown resource (78)', T, async () => {
    const s = setup();
    write({
      ...s,
      plan: {
        ...s.plan,
        baseline: 'f'.repeat(40),
        units: [
          { id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: ['db', 'nope'] },
          { id: 'u2', spec: 'missing.json', risk: 'low', scope: ['src/**'], resources: [] },
        ],
      },
    });
    const rejections = refusedWith(await allChecks(input(s)), 'plan-invalid', 78);
    assert.deepEqual(rejections.map((r) => (r.kind === 'plan-invalid' ? r.problem.type : null)).sort(), ['baseline-not-ancestor', 'unknown-resource', 'unknown-spec-path']);
  });

  it('plan-invalid: a spec cite naming no plan contract or no ledger ruling; an unreadable ledger (78)', T, async () => {
    const s = setup();
    write({ ...s, spec: { ...s.spec, cites: { contracts: ['docs/nope.md'], rulings: ['C-2', 'C-9'] } } });
    const rejections = refusedWith(await allChecks(input(s)), 'plan-invalid', 78);
    assert.deepEqual(rejections.map((r) => (r.kind === 'plan-invalid' && r.problem.type === 'unknown-cite' ? r.problem.cite : null)), ['docs/nope.md', 'C-9'],
      'a withdrawn ruling is still in the ledger');
    const t = setup();
    write(t);
    writeFileSync(join(t.planDir, 'rulings.md'), 'C-1 — One.\nC-1 — Two.\n');
    const [r] = refusedWith(await allChecks(input(t)), 'plan-invalid', 78);
    assert.equal(r?.kind === 'plan-invalid' ? r.problem.type : null, 'schema');
  });

  it('worktree-root-unusable: tmpfs, and not writable (78)', T, async () => {
    assert.equal(statfsSync('/dev/shm').type, TMPFS_MAGIC, 'this host has tmpfs at /dev/shm');
    const shm = join('/dev/shm', `roadmap-st-${randomBytes(4).toString('hex')}`);
    mkdirSync(shm);
    try {
      const s = setup();
      write({ ...s, plan: { ...s.plan, worktreeRoot: shm } });
      const [r] = refusedWith(await allChecks(input(s)), 'worktree-root-unusable', 78);
      assert.equal(r?.kind === 'worktree-root-unusable' ? r.problem : null, 'tmpfs');
    } finally {
      rmSync(shm, { recursive: true });
    }
    const s = setup();
    const readOnly = tmpDir('st-ro');
    chmodSync(readOnly, 0o555);
    write({ ...s, plan: { ...s.plan, worktreeRoot: readOnly } });
    const [r] = refusedWith(await allChecks(input(s)), 'worktree-root-unusable', 78);
    chmodSync(readOnly, 0o755);
    assert.equal(r?.kind === 'worktree-root-unusable' ? r.problem : null, 'not-writable');
  });

  it('argv0.resolves: a bare name on the lane\'s own PATH, followed through a symlink to its real path', () => {
    const dir = tmpDir('argv0');
    mkdirSync(join(dir, 'lib'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'lib', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(join(dir, 'lib', 'tool'), join(dir, 'bin', 'tool'));
    const bin = join(dir, 'bin');
    const cmd = (argv0: string, env: Raw) => ({ argv: [argv0], env: { set: {}, pass: [], ...env } as { set: Record<string, string>; pass: string[] } });
    assert.deepEqual(resolveArgv0(cmd('tool', { set: { PATH: bin } }), {}), { kind: 'program', realpath: realpathSync(join(dir, 'lib', 'tool')) });
    assert.deepEqual(resolveArgv0(cmd('tool', { pass: ['PATH'] }), { PATH: bin }), { kind: 'program', realpath: realpathSync(join(dir, 'lib', 'tool')) });
    assert.deepEqual(resolveArgv0(cmd('tool', {}), { PATH: bin }), { kind: 'not-found' }, 'a PATH the lane does not declare is not searched');
    assert.deepEqual(resolveArgv0(cmd('scripts/run.sh', {}), {}), { kind: 'repository-file' });
    assert.deepEqual(resolveArgv0(cmd(join(bin, 'tool'), {}), {}), { kind: 'program', realpath: realpathSync(join(dir, 'lib', 'tool')) });
  });

  it('spec-lane-unrunnable: argv[0] unresolvable, env prerequisite missing, estate lane for the implementer (78)', T, async () => {
    const s = setup();
    write({
      ...s,
      spec: {
        ...s.spec,
        lanes: [
          { ...lane({ id: 'ghost', argv: ['no-such-tool-roadmap-st'] }), state: 'active' },
          { ...lane({ id: 'needsenv', env: { set: {}, pass: ['PATH', 'ROADMAP_ST_NO_SUCH_VAR'] } }), state: 'active' },
          { ...lane({ id: 'estate', resources: ['cache'] }), state: 'active' },
          { ...lane({ id: 'struck', argv: ['no-such-tool-either'] }), state: 'struck' },
        ],
      },
      plan: { ...s.plan, resources: [{ name: 'db', probe: tool, teardown: tool }, { name: 'cache', probe: tool, teardown: tool }] },
    });
    const rejections = refusedWith(await allChecks(input(s)), 'spec-lane-unrunnable', 78);
    assert.deepEqual(rejections.map((r) => (r.kind === 'spec-lane-unrunnable' && 'lane' in r ? `${r.lane} ${r.problem.type}` : null)), [
      'ghost argv0-unresolvable', 'needsenv env-missing', 'estate estate-lane-for-implementer',
    ]);
  });

  it('unsupported-routing: a Codex judgment seat, named by seat, layer and class, never by model (78)', T, async () => {
    const s = setup();
    write({ ...s, plan: { ...s.plan, routing: { planCheck: { low: 'efficient' } } } });
    const [r] = refusedWith(await allChecks(input(s)), 'unsupported-routing', 78);
    assert.deepEqual(r, { kind: 'unsupported-routing', role: 'planCheck', tier: 'low', layer: 'plan', class: 'efficient', unit: null, why: 'codex-judgment' });
  });

  it('undispositioned-residue (78)', T, async () => {
    const s = setup();
    recordResidue(s.hostDir, residueEntry(FAILED[0]!));
    const [r] = refusedWith(await allChecks(input(s)), 'undispositioned-residue', 78);
    assert.deepEqual(r?.kind === 'undispositioned-residue' ? r.residues : null, [residueEntry(FAILED[0]!).key]);
  });

  it('host-busy: a live owner (75)', T, async () => {
    const s = setup();
    const held = await claimHost(s.hostDir, { arc: arcId('other-arc'), runDir: absPath('/elsewhere'), repo: absPath('/elsewhere'), supervisor: selfIdentity() }, async () => assert.fail());
    assert.equal(held.kind, 'claimed');
    const [r] = refusedWith(await allChecks(input(s)), 'host-busy', 75);
    assert.equal(r?.kind === 'host-busy' ? r.holder : null, 'owner');
  });

  it('previous-arc-unreconciled: a dead claim of another arc with surviving invocations (78)', T, async () => {
    const s = setup();
    await deadClaim(s, { arc: 'prev-arc', owner: true });
    const left = invocationId(opId(arcId('prev-arc'), 4), 1);
    const [r] = refusedWith(await allChecks(input(s, async () => ({ kind: 'unreconciled', invocations: [left] }))), 'previous-arc-unreconciled', 78);
    assert.deepEqual(r, { kind: 'previous-arc-unreconciled', arc: 'prev-arc', invocations: [left] });
  });

  it('recovery-holder-dead: a takeover died holding the recovery lock (78)', T, async () => {
    const s = setup();
    await deadClaim(s, { owner: true });
    const holder = await deadIdentity();
    const recovery: RecoveryLockClaim = { v: SCHEMA_VERSION, nonce: nonce('1'.repeat(32)), bootId: readBootId(), holder, at: isoTimeOf(new Date()) };
    atomicJson(hostPath(s.hostDir, RECOVERY_LOCK), recovery);
    const [r] = refusedWith(await allChecks(input(s)), 'recovery-holder-dead', 78);
    assert.deepEqual(r, { kind: 'recovery-holder-dead', pid: holder.pid });
  });

  it('owner-mismatch: a dead claim without its owner record (78)', T, async () => {
    const s = setup();
    await deadClaim(s, { owner: false });
    const [r] = refusedWith(await allChecks(input(s)), 'owner-mismatch', 78);
    assert.match(r?.kind === 'owner-mismatch' ? r.detail : '', /missing/);
  });

  it('log-corrupt: an invalid complete line in the run\'s log (78); the claim is returned for release', T, async () => {
    const s = setup();
    const dir = runDirOf(s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), 'not a record\n');
    const result = await allChecks(input(s));
    const [r] = refusedWith(result, 'log-corrupt', 78);
    assert.deepEqual(r?.kind === 'log-corrupt' ? [r.file, r.offset] : null, [join(dir, 'events.jsonl'), 0]);
    assert.ok(result.kind === 'refused' && result.claim !== null);
    releaseHost(s.hostDir, result.claim);
  });

  it('containment-mode-changed: the arc recorded another mode (78)', T, async () => {
    const s = setup();
    const dir = runDirOf(s);
    mkdirSync(dir, { recursive: true });
    const journal = openJournal(dir, arcId(s.arc));
    journal.fact({ kind: 'containment-mode', mode: 'cgroup' });
    journal.close();
    const [r] = refusedWith(await allChecks(input(s)), 'containment-mode-changed', 78);
    assert.deepEqual(r, { kind: 'containment-mode-changed', recorded: 'cgroup', detected: 'session' });
  });

  it('backend-smoke: a failed smoke for the resolved profile (78), journaled as smoke spawns', T, async () => {
    const s = setup([
      { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'exit', code: 1 }] },
      { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: OK }] },
    ]);
    const [r] = refusedWith(await allChecks(input(s)), 'backend-smoke', 78);
    assert.deepEqual(r?.kind === 'backend-smoke' ? [r.profile, r.backend, r.problem] : null, ['default', 'claude', 'failed']);
    assert.equal(existsSync(join(runDirOf(s), 'events.jsonl')), true);
  });

});
