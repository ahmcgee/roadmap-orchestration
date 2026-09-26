import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt } from '../src/backends/adapter.ts';
import { backendArgv } from '../src/backends/argv.ts';
import { readCodex } from '../src/backends/codex.ts';
import { implementerSessionId } from '../src/core/ids.ts';
import type { BackendErrorClass } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { BACKEND_FIXTURES, CODEX_USAGE_LIMIT, capturedArgv, fixtureInvocation } from './helpers/scenario.ts';

const fixture = (name: string, file: string): string => readFileSync(join(BACKEND_FIXTURES, name, file), 'utf8');
const EXIT0 = { type: 'exited', code: 0 } as const;

function failedStream(message: string): string {
  return [
    { type: 'thread.started', thread_id: '01a0daac-53f4-7f51-87b9-3a5724d59f6e' },
    { type: 'turn.started' },
    { type: 'error', message },
    { type: 'turn.failed', error: { message } },
  ].map((e) => `${JSON.stringify(e)}\n`).join('');
}

describe('codex', () => {
  it('reads the captured fresh run: thread id, usage, final message', () => {
    const r = readCodex(fixture('codex-fresh', 'stdout'), fixture('codex-fresh', 'last.json'));
    assert.equal(r.sessionId, '01a0daac-53f4-7f51-87b9-3a5724d59f6e');
    assert.deepEqual(r.output, { kind: 'present', value: { ok: true } });
    assert.deepEqual(r.usage, { kind: 'known', tokens: { inputTokens: 14524, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, turns: null, costUsd: null } });
    assert.deepEqual(r.backendErrors, []);
  });

  it('a fresh result carries the thread id Codex minted; a resume keeps the launched id', () => {
    const fresh = adapt(fixtureInvocation('codex-fresh', EXIT0));
    const resume = adapt(fixtureInvocation('codex-resume', EXIT0));
    assert.equal(fresh.type === 'backend' ? fresh.session : null, '01a0daac-53f4-7f51-87b9-3a5724d59f6e');
    assert.equal(resume.type === 'backend' ? resume.session : null, '01a0daac-53f4-7f51-87b9-3a5724d59f6e');
    assert.equal(resume.type === 'backend' ? resume.outcome.kind : null, 'success');
  });

  it('codex.exit0-no-output=malformed: exit 0 with no -o file is malformed, not success', () => {
    const invDir = fixtureInvocation('codex-fresh', EXIT0);
    rmSync(join(invDir, 'last.json'));
    const r = adapt(invDir);
    assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'malformed');
    assert.match(r.type === 'backend' && r.outcome.kind === 'malformed' ? r.outcome.detail : '', /no -o file/);
  });

  it('codex.exit0-no-output=malformed: exit 0 after turn.failed (sandbox failure) is malformed even with a valid -o file', () => {
    const invDir = fixtureInvocation('codex-fresh', EXIT0);
    writeFileSync(join(invDir, 'stdout'), failedStream('sandbox error: command was killed by a signal'));
    const r = adapt(invDir);
    assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'malformed');
    assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'no-result' });
    assert.equal(r.type === 'backend' ? r.backendErrors.length : null, 1);
  });

  describe('codex.turn-failed-class', () => {
    const cases: readonly (readonly [BackendErrorClass, string])[] = [
      ['usage-limit', CODEX_USAGE_LIMIT],
      ['usage-limit', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, status: 429 })],
      ['capacity', 'Selected model is at capacity. Please try a different model.'],
      ['platform', 'stream disconnected before completion: error sending request'],
      ['platform', JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'oops' }, status: 503 })],
      ['backend', 'unexpected status 401 Unauthorized'],
    ];
    for (const [cls, message] of cases) {
      it(`${cls}: ${message.slice(0, 60)}`, () => {
        const r = readCodex(failedStream(message), null);
        assert.deepEqual(r.backendErrors, [{ class: cls, message }]);
        assert.equal(r.output.kind, 'absent');
      });
    }
    it('backend: the captured invalid_json_schema turn.failed (HTTP 400), recorded once for error + turn.failed', () => {
      const r = adapt(fixtureInvocation('codex-turn-failed', { type: 'exited', code: 1 }));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'process-fault');
      const errors = r.type === 'backend' ? r.backendErrors : [];
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.class, 'backend');
      assert.match(errors[0]?.message ?? '', /invalid_json_schema/);
    });
  });

  it('codex.resume-argv: the builder reproduces the argv the real CLI accepted on resume', () => {
    const captured = capturedArgv('codex-resume');
    const argv = backendArgv({
      kind: 'codex-build',
      triple: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
      session: { backend: 'codex', mode: 'resume', id: implementerSessionId('01a0daac-53f4-7f51-87b9-3a5724d59f6e') },
      system: 'S',
      cwd: absPath('/unused/on/resume'),
      outputPath: absPath(captured[captured.indexOf('-o') + 1]),
      schemaPath: absPath(captured[captured.indexOf('--output-schema') + 1]),
    });
    assert.deepEqual(argv, captured);
    assert.equal(fixture('codex-resume', 'exit-code').trim(), '0');
    assert.equal(argv.includes('-C'), false);
    assert.equal(argv.includes('-s'), false);
  });
});
