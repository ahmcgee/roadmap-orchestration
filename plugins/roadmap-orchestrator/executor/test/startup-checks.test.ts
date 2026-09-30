// startup.rejections: every row of the startup rejection table through `runChecks` and then `smokeCheck`
// (src/preflight/checks.ts; the executor runs recovery between the two),
// over a real repo, real host files, a real journal and fake backends for the smoke. One case per kind, each
// with its exit code, and a fully valid setup that passes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { arcId, invocationId, opId, opKey, resourceName, routingRev, seatRev, specRev, unitId } from '../src/core/ids.ts';
import { unkeptSpecReason } from '../src/core/upgrade.ts';
import { evaluateApply } from '../src/commands/apply.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { openJournal } from '../src/core/log.ts';
import type { ProcIdentity, RecoveryLockClaim } from '../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf, nonce, repoPattern } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { HOST_LOCK, RECOVERY_LOCK, hostPath, openHostDir } from '../src/host/hostdir.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { type PreviousArcVerdict, claimHost, releaseHost } from '../src/host/lock.ts';
import { publishOwner } from '../src/host/owner.ts';
import { recordResidue } from '../src/host/residues.ts';
import { runDir } from '../src/input/cli.ts';
import { type StartChecks, type StartInput, gitCommonDir, readRepoConfig, runChecks, smokeCheck } from '../src/preflight/checks.ts';
import { resolveArgv0 } from '../src/preflight/argv0.ts';
import type { SmokeReport } from '../src/preflight/smoke.ts';
import { type StartupRejection, type StartupRejectionKind, exitCodeFor, startupRejection } from '../src/preflight/startup.ts';
import { git, makeRepo, revParse, tmpDir } from './helpers/repo.ts';
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
    respawn: null,
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

  it('plan-invalid: a --plan file that does not exist (78)', T, async () => {
    const s = setup();
    const missing = absPath(join(s.planDir, 'nope.json'));
    const [r] = refusedWith(await allChecks({ ...input(s), planFile: missing }), 'plan-invalid', 78);
    assert.deepEqual(r?.kind === 'plan-invalid' ? r.problem : null, { type: 'schema', field: 'plan', detail: `${missing} does not exist` });
  });

  it('plan-invalid: an integrationBranch naming no local branch; a full ref or remote-tracking name is told to use the short name (78)', T, async () => {
    const problemFor = async (integrationBranch: string, prepare: (s: Setup) => void = () => {}) => {
      const s = setup();
      prepare(s);
      write({ ...s, plan: { ...s.plan, integrationBranch } });
      const [r, ...rest] = refusedWith(await allChecks(input(s)), 'plan-invalid', 78);
      assert.deepEqual(rest, []);
      assert.ok(r?.kind === 'plan-invalid' && r.problem.type === 'unknown-integration-branch', JSON.stringify(r));
      assert.deepEqual(startupRejection(JSON.parse(JSON.stringify(r)), 'r'), r, 'the persisted form reads back');
      return r.problem;
    };
    const typo = await problemFor('mian');
    assert.equal(typo.ref, 'refs/heads/mian');
    assert.doesNotMatch(typo.detail, /short name/);
    const full = await problemFor('refs/heads/main');
    assert.equal(full.ref, 'refs/heads/refs/heads/main');
    assert.match(full.detail, /short name of a local branch/);
    const remote = await problemFor('origin/main', (s) => git(s.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'));
    assert.equal(remote.ref, 'refs/heads/origin/main');
    assert.match(remote.detail, /remote-tracking branch.*short name of a local branch/);
  });

  it('plan-invalid: a branch at roadmap or roadmap/<arc>, or an integrationBranch inside roadmap/<arc>/, blocks the unit branches (78)', T, async () => {
    const conflicts = async (s: Setup) => refusedWith(await allChecks(input(s)), 'plan-invalid', 78)
      .map((r) => (r.kind === 'plan-invalid' && r.problem.type === 'unit-branch-conflict' ? r.problem.ref : JSON.stringify(r)));
    const a = setup();
    git(a.repo, 'branch', 'roadmap');
    assert.deepEqual(await conflicts(a), ['refs/heads/roadmap']);
    const b = setup();
    git(b.repo, 'branch', `roadmap/${b.arc}`);
    assert.deepEqual(await conflicts(b), [`refs/heads/roadmap/${b.arc}`]);
    const c = setup();
    git(c.repo, 'branch', `roadmap/${c.arc}/integration`);
    write({ ...c, plan: { ...c.plan, integrationBranch: `roadmap/${c.arc}/integration` } });
    const [r] = refusedWith(await allChecks(input(c)), 'plan-invalid', 78);
    assert.equal(r?.kind === 'plan-invalid' && r.problem.type === 'unit-branch-conflict' ? r.problem.ref : null, `refs/heads/roadmap/${c.arc}/integration`);
    assert.deepEqual(startupRejection(JSON.parse(JSON.stringify(r)), 'r'), r, 'the persisted form reads back');
  });

  it('a recovered arc\'s own unit branch roadmap/<arc>/<unit> is not a conflict', T, async () => {
    const s = setup();
    git(s.repo, 'branch', `roadmap/${s.arc}/u1`);
    const result = await runChecks(input(s));
    assert.equal(result.kind, 'passed', JSON.stringify(result));
    if (result.kind !== 'passed') return;
    result.journal.close();
    releaseHost(s.hostDir, result.claim);
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

describe('startup.plan-in-force', () => {
  /** Groups 1 to 4 only (no smoke), then the journal closed and the claim released: one start. */
  async function start(i: StartInput): Promise<StartChecks> {
    const result = await runChecks(i);
    result.journal?.close();
    if (result.claim !== null) releaseHost(i.hostDir, result.claim);
    return result;
  }
  const appliedFacts = (s: Setup) => {
    const j = openJournal(runDirOf(s), arcId(s.arc));
    try {
      const f = j.view.planApplied();
      return { rev: f?.rev ?? null, command: f?.command ?? null, changes: f?.changes ?? [], units: j.view.plannedUnits() };
    } finally {
      j.close();
    }
  };
  const addU2 = (s: Setup): void => {
    writeFileSync(join(s.planDir, 'u2.json'), JSON.stringify({ ...s.spec, unit: 'u2' }));
    writeFileSync(s.planFile, JSON.stringify({ ...s.plan, units: [...(s.plan['units'] as Raw[]), { id: 'u2', spec: 'u2.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
  };

  it('a first start puts the files in force as revision 1; a start whose files add a unit applies it (no command); a respawn runs the plan in force, ignoring an edit nobody applied', T, async () => {
    const s = setup();
    assert.equal((await start(input(s))).kind, 'passed');
    assert.deepEqual(appliedFacts(s), { rev: 1, command: null, changes: [], units: ['u1'] });

    addU2(s);
    assert.equal((await start(input(s))).kind, 'passed');
    assert.deepEqual(appliedFacts(s), { rev: 2, command: null, changes: [{ type: 'unit-added', unit: 'u2' }], units: ['u1', 'u2'] });

    // An edit the respawn must not take: u3 added, nothing applied.
    writeFileSync(join(s.planDir, 'u3.json'), JSON.stringify({ ...s.spec, unit: 'u3' }));
    const plan = JSON.parse(JSON.stringify(s.plan)) as Raw;
    writeFileSync(s.planFile, JSON.stringify({ ...plan, units: [...(plan['units'] as Raw[]), { id: 'u2', spec: 'u2.json', risk: 'low', scope: ['src/**'], resources: ['db'] }, { id: 'u3', spec: 'u3.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
    const respawn = await start({ ...input(s), respawn: { runDir: runDirOf(s), arc: arcId(s.arc) } });
    assert.ok(respawn.kind === 'passed', JSON.stringify(respawn));
    assert.deepEqual(respawn.context.plan.units.map((u) => u.id), ['u1', 'u2'], 'the respawn checked the plan in force');
    assert.equal(appliedFacts(s).rev, 2, 'and applied nothing');
  });

  /**
   * The log a release before plan revisions (1.0.0-dev.3) leaves: u1 dispatched on its spec file as it is now
   * and parked at its gate, no plan-applied fact. It ran the live files.
   */
  function dev3Parked(s: Setup): void {
    const dir = runDirOf(s);
    mkdirSync(dir, { recursive: true });
    const j = openJournal(dir, arcId(s.arc));
    j.fact({
      kind: 'dispatch',
      record: {
        unit: unitId('u1'), specRev: specRev(1), specSha256: fileSha256(absPath(join(s.planDir, 'u1.json'))), scope: [repoPattern('src/**')], riskFloor: 'low',
        routingRev: routingRev('0123456789abcdef'), implementerSeatRev: seatRev('fedcba9876543210'), at: isoTimeOf(new Date()),
      },
    });
    j.fact({ kind: 'stage-outcome', unit: unitId('u1'), stage: 'gate', attempt: 1, outcome: 'escalate', class: 'park', chargeable: false });
    j.close();
  }
  const u1Of = (s: Setup) => {
    const j = openJournal(runDirOf(s), arcId(s.arc));
    try {
      return j.view.unit(unitId('u1'));
    } finally {
      j.close();
    }
  };
  const editU1 = (s: Setup, over: Raw): void => writeFileSync(join(s.planDir, 'u1.json'), JSON.stringify({ ...s.spec, ...over }));

  it('startup.upgrade-baseline: the first start of an arc 1.0.0-dev.3 ran records revision 1 as that release ran the files: a spec edited at its rev is the unit\'s spec, at rev + 1 a pending revision; another rev, or a unit with state missing from plan.json, refuses the start', T, async () => {
    const evidence = setup();
    dev3Parked(evidence);
    editU1(evidence, { lanes: [{ ...lane(), evidenceGlobs: ['out/**'], state: 'active' }] });
    const evidenceSha = fileSha256(absPath(join(evidence.planDir, 'u1.json')));
    assert.equal((await start(input(evidence))).kind, 'passed');
    assert.deepEqual(appliedFacts(evidence), { rev: 1, command: null, changes: [{ type: 'spec', unit: 'u1', edit: 'evidence', specRev: 1, specSha256: evidenceSha }], units: ['u1'] });
    assert.deepEqual([u1Of(evidence).spec, u1Of(evidence).pendingRevision], [{ rev: 1, sha256: evidenceSha }, null]);

    const revision = setup();
    dev3Parked(revision);
    editU1(revision, { rev: 2, facts: [{ id: 'F1', text: 'A fact.', state: 'active' }] });
    const revisionSha = fileSha256(absPath(join(revision.planDir, 'u1.json')));
    assert.equal((await start(input(revision))).kind, 'passed');
    assert.deepEqual(appliedFacts(revision).changes, [{ type: 'spec', unit: 'u1', edit: 'revision', specRev: 2, specSha256: revisionSha }]);
    assert.deepEqual([u1Of(revision).spec?.rev, u1Of(revision).pendingRevision], [1, { rev: 2, sha256: revisionSha, command: null }]);

    const skipped = setup();
    dev3Parked(skipped);
    editU1(skipped, { rev: 3 });
    const refused = await start(input(skipped));
    assert.deepEqual(refused.kind === 'refused' ? refused.rejections : refused.kind, [{
      kind: 'plan-change-refused', reasons: [`unit u1: its spec ${join(skipped.planDir, 'u1.json')} is at rev 3, but the unit's recorded rev is 1; set rev 1 or 2`],
    }]);
    assert.equal(appliedFacts(skipped).rev, null, 'no revision recorded');

    const dropped = setup();
    dev3Parked(dropped);
    writeFileSync(join(dropped.planDir, 'u2.json'), JSON.stringify({ ...dropped.spec, unit: 'u2' }));
    writeFileSync(dropped.planFile, JSON.stringify({ ...dropped.plan, units: [{ id: 'u2', spec: 'u2.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
    const gone = await start(input(dropped));
    assert.ok(gone.kind === 'refused' && gone.rejections[0]?.kind === 'plan-change-refused', JSON.stringify(gone));
    assert.match(gone.rejections[0].reasons.join('\n'), /^unit u1 has run in this arc but .*plan\.json no longer lists it/);
  });

  it('startup.upgrade-unkept-spec: an edit of a unit whose dispatched spec was never kept is refused with the reason, not compared with itself; the dry run of it writes nothing', T, async () => {
    const s = setup();
    dev3Parked(s);
    editU1(s, { rev: 2, facts: [{ id: 'F1', text: 'A fact.', state: 'active' }] });
    assert.equal((await start(input(s))).kind, 'passed');
    // Another rev 2 than the pending one: the recorded rev 1 spec was never kept, so nothing to compare it to.
    editU1(s, { rev: 2, facts: [{ id: 'F1', text: 'Another fact.', state: 'active' }] });
    const inputs = join(runDirOf(s), 'inputs');
    const before = readdirSync(inputs).sort();
    const j = openJournal(runDirOf(s), arcId(s.arc));
    let verdict: Awaited<ReturnType<typeof evaluateApply>>;
    try {
      verdict = await evaluateApply({
        runDir: runDirOf(s), view: j.view, hostDir: s.hostDir, repo: s.repo, planFile: s.planFile, routingBase: { profile: 'default', config: readRepoConfig(s.repo) },
        laneEnv: process.env, manifest: null, expectRev: null,
      });
    } finally {
      j.close();
    }
    assert.deepEqual(verdict, { kind: 'rejected', reasons: [unkeptSpecReason('u1', join(s.planDir, 'u1.json'))] });
    assert.deepEqual(readdirSync(inputs).sort(), before, 'the dry run kept nothing');
    const refused = await start(input(s));
    assert.deepEqual(refused.kind === 'refused' ? refused.rejections : refused.kind, [{ kind: 'plan-change-refused', reasons: [unkeptSpecReason('u1', join(s.planDir, 'u1.json'))] }]);
  });

  it('plan-change-refused: a fresh arc\'s unit with a reserved id (batch-<n>, jobs, mutants) is refused, and so is a start whose files add one', T, async () => {
    const fresh = setup();
    writeFileSync(join(fresh.planDir, 'batch-1.json'), JSON.stringify({ ...fresh.spec, unit: 'batch-1' }));
    writeFileSync(fresh.planFile, JSON.stringify({ ...fresh.plan, units: [...(fresh.plan['units'] as Raw[]), { id: 'batch-1', spec: 'batch-1.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
    const refused = await start(input(fresh));
    assert.ok(refused.kind === 'refused' && refused.rejections.length === 1 && refused.rejections[0]?.kind === 'plan-change-refused', JSON.stringify(refused));
    assert.equal(refused.rejections[0].reasons.length, 1);
    assert.match(refused.rejections[0].reasons[0]!, /^unit id batch-1 is reserved/);
    assert.equal(appliedFacts(fresh).rev, null, 'no revision recorded');

    const added = setup();
    assert.equal((await start(input(added))).kind, 'passed');
    writeFileSync(join(added.planDir, 'mutants.json'), JSON.stringify({ ...added.spec, unit: 'mutants' }));
    writeFileSync(added.planFile, JSON.stringify({ ...added.plan, units: [...(added.plan['units'] as Raw[]), { id: 'mutants', spec: 'mutants.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
    const later = await start(input(added));
    assert.ok(later.kind === 'refused' && later.rejections[0]?.kind === 'plan-change-refused', JSON.stringify(later));
    assert.match(later.rejections[0].reasons.join('\n'), /^unit id mutants is reserved/);
    assert.equal(appliedFacts(added).rev, 1);
  });

  it('plan-change-refused: a start whose files drop a started unit and move the worktree root is refused with every reason (78); the plan in force stays', T, async () => {
    const s = setup();
    assert.equal((await start(input(s))).kind, 'passed');
    addU2(s);
    assert.equal((await start(input(s))).kind, 'passed');
    const j = openJournal(runDirOf(s), arcId(s.arc));
    j.fact({ kind: 'stage-outcome', unit: 'u1' as never, stage: 'plan-check', attempt: 1, outcome: 'approve', class: 'advance', chargeable: false });
    j.close();
    const moved = tmpDir('st-wt2');
    writeFileSync(s.planFile, JSON.stringify({ ...s.plan, worktreeRoot: moved, units: [{ id: 'u2', spec: 'u2.json', risk: 'low', scope: ['src/**'], resources: ['db'] }] }));
    const result = await runChecks(input(s));
    const rejections = refusedWith(result as Checked, 'plan-change-refused', 78);
    assert.ok(result.kind === 'refused' && result.claim !== null);
    releaseHost(s.hostDir, result.claim);
    // A first start on M2 schedules a DAG, whose started units keep only their relative order (G3): no prefix reason.
    assert.deepEqual(rejections, [{
      kind: 'plan-change-refused',
      reasons: [
        `worktreeRoot may never change (in force: ${String(s.plan['worktreeRoot'])}; plan.json: ${moved})`,
        'unit u1 has started; it cannot be removed',
      ],
    }]);
    assert.equal(startupRejection(JSON.parse(JSON.stringify(rejections[0])), 'r').kind, 'plan-change-refused', 'the row round-trips');
    assert.equal(appliedFacts(s).rev, 2);
  });
});

describe('startup.m2: over capacity, own-arc residues, the respawn smoke', () => {
  /** runChecks, the smoke when they passed, then the journal closed and the claim released. */
  async function once(i: StartInput) {
    const checks = await runChecks(i);
    if (checks.kind === 'refused') {
      checks.journal?.close();
      if (checks.claim !== null) releaseHost(i.hostDir, checks.claim);
      return { checks, smoked: null, parks: [] };
    }
    const smoked = await smokeCheck(checks, i.env);
    const parks = checks.journal.view.backendParks();
    checks.journal.close();
    releaseHost(i.hostDir, checks.claim);
    return { checks, smoked, parks };
  }
  const respawnOf = (s: Setup): StartInput => ({ ...input(s), respawn: { runDir: runDirOf(s), arc: arcId(s.arc) } });

  it('plan-invalid{over-capacity}: a build asking for more @cpu than the pool has (78), and the row round-trips', T, async () => {
    const s = setup();
    write({ ...s, plan: { ...s.plan, capacity: { cpu: 2 } } });
    const rejections = refusedWith(await allChecks(input(s)), 'plan-invalid', 78);
    assert.deepEqual(rejections.map((r) => (r.kind === 'plan-invalid' ? r.problem : null)), [
      { type: 'over-capacity', unit: unitId('u1'), lane: null, resource: '@cpu', requested: 4, total: 2 },
    ]);
    assert.deepEqual(startupRejection(JSON.parse(JSON.stringify(rejections[0])), 'r'), rejections[0], 'the persisted form reads back');
    write({ ...s, plan: { ...s.plan, capacity: { cpu: 2 }, units: [{ ...(s.plan['units'] as Raw[])[0], cpu: 2 }] } });
    const { checks } = await once(input(s));
    assert.equal(checks.kind, 'passed', JSON.stringify(checks));
  });

  it('residue.own-arc-start: a residue the arc\'s own log proves it owns never refuses its start or respawn; another arc\'s still does (A9)', T, async () => {
    const s = setup([...SMOKE_OK, ...SMOKE_OK, ...SMOKE_OK]);
    assert.equal((await once(input(s))).checks.kind, 'passed');
    // The arc's cleanup of db failed: its fail intent (left open, as a crash leaves it) names the residue it appended.
    const j = openJournal(runDirOf(s), arcId(s.arc));
    const inv = invocationId(opId(arcId(s.arc), j.view.highWater() + 50), 1);
    const u1 = unitId('u1');
    j.begin({
      kind: 'resource.transition', key: opKey('resources:db'), parent: { type: 'stage', unit: u1, stage: 'build', attempt: 1 }, deadlineAt: null,
      body: () => ({
        expect: { holder: { type: 'stage', unit: u1, stage: 'build', attempt: 1 }, resources: [resourceName('db')], edge: { type: 'fail', residues: [{ resource: resourceName('db'), teardown: inv }] } },
        post: null,
      }),
    });
    j.close();
    const own = residueEntry(resourceName('db'), arcId(s.arc));
    recordResidue(s.hostDir, { ...own, key: { arc: own.key.arc, resource: own.key.resource, unit: u1, inv } });
    const start = await once(input(s));
    assert.equal(start.checks.kind, 'passed', JSON.stringify(start.checks));
    assert.equal((await once(respawnOf(s))).checks.kind, 'passed');

    recordResidue(s.hostDir, residueEntry(FAILED[0]!));
    const refused = await once(input(s));
    assert.equal(refused.checks.kind, 'refused');
    if (refused.checks.kind !== 'refused') return;
    assert.deepEqual(refused.checks.rejections, [{ kind: 'undispositioned-residue', residues: [residueEntry(FAILED[0]!).key] }], 'only the other arc\'s residue refuses');
  });

  it('smoke.respawn-parks: a respawn of an established arc parks a backend whose smoke fails (outage) and runs on; a start still refuses (A18)', T, async () => {
    const failing = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'exit', code: 1 }] } as const;
    const codexOk = SMOKE_OK[1]!;
    const s = setup([...SMOKE_OK, failing, codexOk, failing, codexOk]);
    const first = await once(input(s));
    assert.deepEqual([first.checks.kind, first.smoked?.kind], ['passed', 'passed']);
    assert.equal(first.checks.kind === 'passed' && first.checks.respawn, false);

    const respawn = await once(respawnOf(s));
    assert.equal(respawn.checks.kind === 'passed' && respawn.checks.respawn, true);
    assert.equal(respawn.smoked?.kind, 'passed', JSON.stringify(respawn.smoked));
    assert.deepEqual(respawn.smoked?.kind === 'passed' ? respawn.smoked.parked : null, [{ backend: 'claude', class: 'outage', inv: null }]);
    assert.deepEqual(respawn.parks.map((p) => [p.backend, p.class]), [['claude', 'outage']], 'a retryable backend-park, recorded');

    const start = await once(input(s));
    assert.equal(start.checks.kind === 'passed' && start.checks.respawn, false);
    assert.equal(start.smoked?.kind, 'refused', 'a start with the architect present refuses');
    assert.deepEqual(start.smoked?.kind === 'refused' ? start.smoked.rejections.map((r) => r.kind) : null, ['backend-smoke']);
  });
});

