import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt } from '../src/backends/adapter.ts';
import { type BackendCall, backendArgv, freshJudgmentSession } from '../src/backends/argv.ts';
import { readClaude } from '../src/backends/claude.ts';
import { judgmentSessionId } from '../src/core/ids.ts';
import { RUNNER_FILE_READERS } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { BACKEND_FIXTURES, CLAUDE_USAGE_LIMIT, fixtureInvocation } from './helpers/scenario.ts';

const EXIT0 = { type: 'exited', code: 0 } as const;
const stdoutOf = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(BACKEND_FIXTURES, name, 'stdout'), 'utf8')) as Record<string, unknown>;
const TRIPLE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;

function rewrite(invDir: string, edit: (o: Record<string, unknown>) => void): string {
  const o = JSON.parse(readFileSync(join(invDir, 'stdout'), 'utf8')) as Record<string, unknown>;
  edit(o);
  writeFileSync(join(invDir, 'stdout'), JSON.stringify(o));
  return invDir;
}

describe('claude', () => {
  it('reads the captured judgment run: structured_output, session id, usage', () => {
    const r = readClaude(readFileSync(join(BACKEND_FIXTURES, 'claude-judgment', 'stdout'), 'utf8'));
    assert.deepEqual(r.output, { kind: 'present', value: { ok: true } });
    assert.equal(r.sessionId, '18b3bbf3-98ce-4ced-87c2-639d61b25ef1');
    assert.deepEqual(r.usage, { kind: 'known', tokens: { inputTokens: 2, outputTokens: 52, cacheReadTokens: 0, cacheWriteTokens: 11372 } });
  });

  it('the captured implementer fresh and resume runs are successes on the launched id', () => {
    for (const name of ['claude-implementer', 'claude-implementer-resume']) {
      const r = adapt(fixtureInvocation(name, EXIT0));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success', name);
      assert.equal(r.type === 'backend' ? r.session : null, 'd571723e-7eac-4b0c-94a3-e1f07df8c074', name);
    }
  });

  it('the captured is_error result (unknown model, HTTP 404, exit 1) → process-fault with a backend error', () => {
    const r = adapt(fixtureInvocation('claude-api-error', { type: 'exited', code: 1 }));
    assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'process-fault');
    assert.deepEqual(r.type === 'backend' ? r.backendErrors.map((e) => e.class) : null, ['backend']);
  });

  it('a usage-limit is_error result is classified usage-limit (by status or by text)', () => {
    const base = stdoutOf('claude-api-error');
    for (const status of [429, null]) {
      const r = readClaude(JSON.stringify({ ...base, result: CLAUDE_USAGE_LIMIT, api_error_status: status }));
      assert.deepEqual(r.backendErrors, [{ class: 'usage-limit', message: CLAUDE_USAGE_LIMIT }]);
    }
    const overloaded = readClaude(JSON.stringify({ ...base, result: 'Overloaded', api_error_status: 529 }));
    assert.equal(overloaded.backendErrors[0]?.class, 'capacity');
    const down = readClaude(JSON.stringify({ ...base, result: 'API Error: 500', api_error_status: 500 }));
    assert.equal(down.backendErrors[0]?.class, 'platform');
  });

  describe('claude.usage-unavailable', () => {
    it('a result without usage is still a success; usage unavailable{absent}', () => {
      const r = adapt(rewrite(fixtureInvocation('claude-judgment', EXIT0), (o) => delete o['usage']));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'absent' });
    });
    it('a usage block of the wrong shape → unavailable{malformed}, judgment still a success', () => {
      const r = adapt(rewrite(fixtureInvocation('claude-judgment', EXIT0), (o) => (o['usage'] = { input_tokens: 'many' })));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'malformed' });
    });
    it('no result object at all → unavailable{no-result}', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      writeFileSync(join(invDir, 'stdout'), '');
      const r = adapt(invDir);
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'malformed');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'no-result' });
    });
  });

  describe('claude.fresh-session-id', () => {
    it('every judgment session is freshly minted, launched with --session-id and never resumed', () => {
      const a = freshJudgmentSession();
      const b = freshJudgmentSession();
      assert.notEqual(a.id, b.id);
      const argv = backendArgv({ kind: 'claude-judgment', role: 'gate', triple: TRIPLE, session: a, schemaText: '{}' });
      assert.equal(argv[argv.indexOf('--session-id') + 1], a.id);
      assert.equal(argv.includes('--resume'), false);
      assert.equal(argv.includes('--no-session-persistence'), true);
      assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
    });
    it('a resumed judgment call is unrepresentable', () => {
      const call: BackendCall = {
        kind: 'claude-judgment', role: 'planCheck', triple: TRIPLE, schemaText: '{}',
        // @ts-expect-error: a judgment session's only mode is 'fresh'
        session: { backend: 'claude', mode: 'resume', id: judgmentSessionId('18b3bbf3-98ce-4ced-87c2-639d61b25ef1') },
      };
      assert.equal(call.kind, 'claude-judgment');
    });
    it('a Codex judgment call is unrepresentable', () => {
      // @ts-expect-error: judgment is Claude only (R21); a Codex triple does not fit a judgment call
      const call: BackendCall = {
        kind: 'claude-judgment', role: 'gate', session: freshJudgmentSession(), schemaText: '{}',
        triple: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
      };
      assert.equal(call.kind, 'claude-judgment');
    });
    it('launch.json refuses a judgment terminal whose session resumes', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      const launch = JSON.parse(readFileSync(join(invDir, 'launch.json'), 'utf8')) as { terminal: { session: { mode: string } } };
      launch.terminal.session.mode = 'resume';
      assert.throws(() => RUNNER_FILE_READERS['launch.json'](launch, 'launch.json'), SchemaError);
    });
    it('a judgment result carries the launched session id', () => {
      const r = adapt(fixtureInvocation('claude-judgment', EXIT0));
      assert.equal(r.type === 'backend' ? r.session : null, '18b3bbf3-98ce-4ced-87c2-639d61b25ef1');
    });
  });
});
