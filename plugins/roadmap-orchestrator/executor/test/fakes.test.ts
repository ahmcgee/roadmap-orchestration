import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeResult } from '../src/backends/adapter.ts';
import { type BackendCall, backendArgv, freshJudgmentSession } from '../src/backends/argv.ts';
import type { BackendResult, LaunchTerminal } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { reached, release } from './helpers/barrier.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';
import {
  BACKEND_FIXTURES, CLAUDE_USAGE_LIMIT, CODEX_USAGE_LIMIT, type ClaudeAct, type CodexAct, OK_SCHEMA, ROUTING_REV,
  type Scenario, type Step, readCalls, runLaunch, writeLaunch, writeScenario,
} from './helpers/scenario.ts';

const CODEX = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' } as const;
const CLAUDE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;
const SCHEMA_TEXT = readFileSync(OK_SCHEMA, 'utf8').trim();
const TIMEOUT_MS = 20_000;

type Backend = 'codex' | 'claude';

/** Launch one backend call through the shims, as the runner would, then adapt it. */
function invoke(scenario: Scenario, backend: Backend, cwd: string, prompt = 'Reply with {"ok": true}'): { result: BackendResult; invDir: string } {
  const invDir = tmpDir('inv');
  const stdinPath = join(invDir, 'stdin');
  writeFileSync(stdinPath, prompt);
  const base = { type: 'backend', purpose: 'backend', routingRev: ROUTING_REV, schemaPath: absPath(OK_SCHEMA) } as const;
  let call: BackendCall;
  let terminal: LaunchTerminal;
  if (backend === 'codex') {
    const outputPath = absPath(join(invDir, 'last.json'));
    call = { kind: 'codex-build', triple: CODEX, session: { backend: 'codex', mode: 'fresh' }, system: 'Reply with the JSON the schema asks for.', cwd: absPath(cwd), outputPath, schemaPath: base.schemaPath };
    terminal = { ...base, outputPath, role: 'build', session: { backend: 'codex', mode: 'fresh' } };
  } else {
    const session = freshJudgmentSession();
    call = { kind: 'claude-judgment', role: 'gate', triple: CLAUDE, session, schemaText: SCHEMA_TEXT, system: 'Reply with the JSON the schema asks for.', evidenceDirs: [] };
    terminal = { ...base, outputPath: absPath(join(invDir, 'stdout')), role: 'gate', session };
  }
  const launch = writeLaunch(invDir, { argv: backendArgv(call), cwd, terminal, stdinPath });
  runLaunch(invDir, launch, { PATH: `${scenario.binDir}:/usr/bin:/bin`, ROADMAP_INV: 'arc-1/7#1' }, TIMEOUT_MS);
  const result = writeResult(invDir);
  assert.equal(result.type, 'backend');
  return { result: result as BackendResult, invDir };
}

function oneStep(backend: Backend, acts: readonly (CodexAct | ClaudeAct)[]): Scenario {
  const step: Step = backend === 'codex' ? { as: 'codex', expect: {}, acts: acts as CodexAct[] } : { as: 'claude', expect: {}, acts: acts as ClaudeAct[] };
  return writeScenario(tmpDir('scenario'), [step]);
}

const OK = { ok: true } as const;

describe('fakes', () => {
  describe('fakes.roundtrip: every emit variant through the shim and the real adapter', () => {
    type Want = Readonly<{ outcome: string; usage: string; errors: readonly string[] }>;
    const variants: readonly (readonly [string, CodexAct | ClaudeAct, Want, readonly Backend[]])[] = [
      ['emit', { type: 'emit', value: OK }, { outcome: 'success', usage: 'known', errors: [] }, ['codex', 'claude']],
      ['capacityText', { type: 'capacityText', value: OK }, { outcome: 'success', usage: 'known', errors: [] }, ['codex', 'claude']],
      ['noUsage', { type: 'noUsage', value: OK }, { outcome: 'success', usage: 'absent', errors: [] }, ['codex', 'claude']],
      ['malformed', { type: 'malformed' }, { outcome: 'malformed', usage: 'known', errors: [] }, ['codex', 'claude']],
      ['usageLimit', { type: 'usageLimit' }, { outcome: 'process-fault', usage: 'no-result', errors: ['usage-limit'] }, ['codex']],
      ['usageLimit', { type: 'usageLimit' }, { outcome: 'process-fault', usage: 'known', errors: ['usage-limit'] }, ['claude']],
      ['exitZeroNoop', { type: 'exitZeroNoop' }, { outcome: 'malformed', usage: 'no-result', errors: [] }, ['codex', 'claude']],
      ['refusal', { type: 'refusal' }, { outcome: 'refusal', usage: 'known', errors: [] }, ['claude']],
    ];
    for (const [name, act, want, backends] of variants) {
      for (const backend of backends) {
        it(`${backend} ${name} → ${want.outcome}`, () => {
          const { result } = invoke(oneStep(backend, [act]), backend, tmpDir('work'));
          assert.equal(result.outcome.kind, want.outcome);
          assert.equal(result.usage.kind === 'known' ? 'known' : result.usage.reason, want.usage);
          assert.deepEqual(result.backendErrors.map((e) => e.class), want.errors);
        });
      }
    }
    it('codex emit: the event types match the captured stream, and the thread id is the result session', () => {
      const { result, invDir } = invoke(oneStep('codex', [{ type: 'emit', value: OK }]), 'codex', tmpDir('work'));
      const types = (text: string): string[] => text.trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
      assert.deepEqual(types(readFileSync(join(invDir, 'stdout'), 'utf8')), types(readFileSync(join(BACKEND_FIXTURES, 'codex-fresh', 'stdout'), 'utf8')));
      assert.equal(result.session, '00000000-0000-4000-8000-000000000000');
    });
    it('claude emit: the result object has exactly the captured keys and the launched session id', () => {
      const { result, invDir } = invoke(oneStep('claude', [{ type: 'emit', value: OK }]), 'claude', tmpDir('work'));
      const keys = (text: string): string[] => Object.keys(JSON.parse(text) as object).sort();
      assert.deepEqual(keys(readFileSync(join(invDir, 'stdout'), 'utf8')), keys(readFileSync(join(BACKEND_FIXTURES, 'claude-judgment', 'stdout'), 'utf8')));
      const reported = (JSON.parse(readFileSync(join(invDir, 'stdout'), 'utf8')) as { session_id: string }).session_id;
      assert.equal(reported, result.session);
    });
    it('the usage-limit messages are the ones the fakes emit', () => {
      const codex = invoke(oneStep('codex', [{ type: 'usageLimit' }]), 'codex', tmpDir('work')).result;
      const claude = invoke(oneStep('claude', [{ type: 'usageLimit' }]), 'claude', tmpDir('work')).result;
      assert.equal(codex.backendErrors[0]?.message, CODEX_USAGE_LIMIT);
      assert.equal(claude.backendErrors[0]?.message, CLAUDE_USAGE_LIMIT);
    });
  });

  describe('matching and the call log', () => {
    it('steps are consumed in order; each call is logged with argv, cwd, stdin and only ROADMAP_* env', () => {
      const work = tmpDir('work');
      const s = writeScenario(tmpDir('scenario'), [
        { as: 'codex', expect: { argv: ['exec', '-C', work], argvLacks: ['resume'], cwd: work, stdinContains: ['first'] }, acts: [{ type: 'emit', value: OK }] },
        { as: 'claude', expect: { argv: ['-p', '--session-id'], argvLacks: ['--resume'], stdinContains: ['second'] }, acts: [{ type: 'emit', value: OK }] },
      ]);
      assert.equal(invoke(s, 'codex', work, 'first prompt').result.outcome.kind, 'success');
      assert.equal(invoke(s, 'claude', work, 'second prompt').result.outcome.kind, 'success');
      const calls = readCalls(s.path);
      assert.deepEqual(calls.map((c) => [c.as, c.step, c.stdin]), [['codex', 0, 'first prompt'], ['claude', 1, 'second prompt']]);
      assert.equal(calls[0]?.cwd, work);
      assert.deepEqual(calls[0]?.env, { ROADMAP_INV: 'arc-1/7#1' });
    });
    it('an unmatched call exits 99, names the mismatch on stderr and consumes no step', () => {
      const s = writeScenario(tmpDir('scenario'), [{ as: 'claude', expect: {}, acts: [{ type: 'emit', value: OK }] }]);
      const { invDir } = invoke(s, 'codex', tmpDir('work'));
      assert.equal((JSON.parse(readFileSync(join(invDir, 'exit.json'), 'utf8')) as { child: { code: number } }).child.code, 99);
      assert.match(readFileSync(join(invDir, 'stderr'), 'utf8'), /step is for claude, the call is codex/);
      assert.equal(readCalls(s.path)[0]?.step, null);
      assert.equal(invoke(s, 'claude', tmpDir('work')).result.outcome.kind, 'success');
    });
  });

  describe('world acts', () => {
    it('commit, stage and dirty act on the real repo in cwd; exit sets the code', () => {
      const repo = makeRepo(tmpDir('repo'), { files: { 'a.txt': 'a\n' } });
      const s = oneStep('codex', [
        { type: 'commit', message: 'unit work', files: { 'src/x.ts': 'export {};\n' } },
        { type: 'stage', files: { 'staged.txt': 's\n' } },
        { type: 'dirty', files: { 'a.txt': 'changed\n' } },
        { type: 'exit', code: 3 },
      ]);
      const { invDir } = invoke(s, 'codex', repo);
      assert.equal(git(repo, 'log', '-1', '--format=%s'), 'unit work');
      assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD'), 'src/x.ts');
      assert.equal(git(repo, 'status', '--porcelain'), 'M a.txt\nA  staged.txt');
      assert.equal((JSON.parse(readFileSync(join(invDir, 'exit.json'), 'utf8')) as { child: { code: number } }).child.code, 3);
    });
    it('forkSetsid leaves a detached child alive after the fake exits, with or without the environment', () => {
      for (const env of ['keepEnv', 'envClear'] as const) {
        const dir = tmpDir('fork');
        const pidFile = join(dir, 'child.pid');
        invoke(oneStep('codex', [{ type: 'forkSetsid', env, lifeMs: 10_000, pidFile }, { type: 'emit', value: OK }]), 'codex', tmpDir('work'));
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        try {
          assert.equal(existsSync(`/proc/${pid}`), true);
          const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
          assert.equal(environ.includes('ROADMAP_INV=arc-1/7#1'), env === 'keepEnv');
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
          assert.equal(Number(stat[3]), pid, 'the child leads its own session (setsid)');
        } finally {
          process.kill(pid, 'SIGKILL');
        }
      }
    });
    it('barrier parks the fake until the test releases it; hang sleeps', async () => {
      const s = oneStep('claude', [{ type: 'barrier', name: 'mid', timeoutMs: TIMEOUT_MS }, { type: 'hang', ms: 50 }, { type: 'emit', value: OK }]);
      const invDir = tmpDir('inv');
      const session = freshJudgmentSession();
      const terminal: LaunchTerminal = { type: 'backend', purpose: 'backend', routingRev: ROUTING_REV, schemaPath: absPath(OK_SCHEMA), outputPath: absPath(join(invDir, 'stdout')), role: 'gate', session };
      const argv = backendArgv({ kind: 'claude-judgment', role: 'gate', triple: CLAUDE, session, schemaText: SCHEMA_TEXT, system: 'Reply with the JSON the schema asks for.', evidenceDirs: [] });
      const launch = writeLaunch(invDir, { argv, cwd: invDir, terminal, stdinPath: null });
      const { spawn } = await import('node:child_process');
      const child = spawn('claude', argv.slice(1), { cwd: invDir, env: { PATH: `${s.binDir}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      await reached(s.dir, 'mid', TIMEOUT_MS);
      assert.equal(child.exitCode, null, 'parked at the barrier');
      release(s.dir, 'mid');
      assert.equal(await closed, 0);
      assert.equal((JSON.parse(stdout) as { session_id: string }).session_id, launch.terminal.type === 'backend' && 'id' in launch.terminal.session ? launch.terminal.session.id : '');
    });
  });
});
