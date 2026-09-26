import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt, writeResult } from '../src/backends/adapter.ts';
import { type BackendCall, backendArgv, freshClaudeImplementerSession, freshJudgmentSession } from '../src/backends/argv.ts';
import { readClaude } from '../src/backends/claude.ts';
import { judgmentSessionId } from '../src/core/ids.ts';
import { RUNNER_FILE_READERS } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { BACKEND_FIXTURES, CLAUDE_USAGE_LIMIT, capturedClaudeResult, editClaudeResult, fixtureInvocation } from './helpers/scenario.ts';

const EXIT0 = { type: 'exited', code: 0 } as const;
const TRIPLE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;
const stdoutOf = (name: string): string => readFileSync(join(BACKEND_FIXTURES, name, 'stdout'), 'utf8');
/** A one-event stream: the captured api-error result with `fields` replaced. */
const errorStream = (fields: Readonly<Record<string, unknown>>): string => `${JSON.stringify({ ...capturedClaudeResult('claude-api-error'), ...fields })}\n`;
const initOf = (name: string): Record<string, unknown> => JSON.parse(stdoutOf(name).split('\n')[0]!) as Record<string, unknown>;

describe('claude', () => {
  it('reads the captured judgment stream: structured_output, session id, usage with turns and cost', () => {
    const r = readClaude(stdoutOf('claude-judgment'));
    assert.deepEqual(r.output, { kind: 'present', value: { ok: true } });
    assert.equal(r.sessionId, '8519f8cd-0b40-4801-8782-5bbf12dbaf58');
    assert.deepEqual(r.usage, {
      kind: 'known', tokens: { inputTokens: 4, outputTokens: 316, cacheReadTokens: 3200, cacheWriteTokens: 3627, turns: 5, costUsd: 0.035992 },
    });
  });

  it('the captured implementer fresh and resume runs are successes on the launched id', () => {
    for (const name of ['claude-implementer', 'claude-implementer-resume']) {
      const r = adapt(fixtureInvocation(name, EXIT0));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success', name);
      assert.equal(r.type === 'backend' ? r.session : null, '53bca479-1996-48db-a888-8b79912fae20', name);
    }
  });

  it('the captured is_error result (unknown model, HTTP 404, exit 1) → process-fault with a backend error', () => {
    const r = adapt(fixtureInvocation('claude-api-error', { type: 'exited', code: 1 }));
    assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'process-fault');
    assert.deepEqual(r.type === 'backend' ? r.backendErrors.map((e) => e.class) : null, ['backend']);
  });

  it('a usage-limit is_error result is classified usage-limit (by status or by text)', () => {
    for (const status of [429, null]) {
      const r = readClaude(errorStream({ result: CLAUDE_USAGE_LIMIT, api_error_status: status }));
      assert.deepEqual(r.backendErrors, [{ class: 'usage-limit', message: CLAUDE_USAGE_LIMIT }]);
    }
    assert.equal(readClaude(errorStream({ result: 'Overloaded', api_error_status: 529 })).backendErrors[0]?.class, 'capacity');
    assert.equal(readClaude(errorStream({ result: 'API Error: 500', api_error_status: 500 })).backendErrors[0]?.class, 'platform');
  });

  describe('claude.usage-unavailable', () => {
    it('a result without usage is still a success; usage unavailable{absent}', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => {
        delete o['usage'];
        return o;
      }));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'absent' });
    });
    it('a usage block of the wrong shape → unavailable{malformed}, judgment still a success', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => ({ ...o, usage: { input_tokens: 'many' } })));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'malformed' });
    });
    it('without num_turns and total_cost_usd the tokens are still known; turns and cost null', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => {
        delete o['num_turns'];
        delete o['total_cost_usd'];
        return o;
      }));
      assert.deepEqual(r.type === 'backend' && r.usage.kind === 'known' ? [r.usage.tokens.turns, r.usage.tokens.costUsd, r.usage.tokens.outputTokens] : null, [null, null, 316]);
    });
    it('no result event at all → unavailable{no-result}', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      writeFileSync(join(invDir, 'stdout'), '');
      const r = adapt(invDir);
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'malformed');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'no-result' });
    });
  });

  describe('claude.reads', () => {
    it('writeResult records the judgment\'s Glob, Grep and Read calls, in order, as reads.json', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      writeResult(invDir);
      const reads = RUNNER_FILE_READERS['reads.json'](JSON.parse(readFileSync(join(invDir, 'reads.json'), 'utf8')), 'reads.json');
      assert.equal(reads.inv, 'arc-1/7#1');
      assert.deepEqual(reads.reads, [
        { tool: 'Glob', pattern: '*.txt', path: null },
        { tool: 'Grep', pattern: 'probe', path: null },
        { tool: 'Read', path: '/tmp/claude-1000/-workspaces-roadmap-orchestration/9db8f7a3-57cf-4d1d-aae8-163dd8be0936/scratchpad/cap/work/notes.txt' },
      ]);
      // Write-once like result.json: a re-run is a byte-identical no-op.
      const bytes = readFileSync(join(invDir, 'reads.json'), 'utf8');
      writeResult(invDir);
      assert.equal(readFileSync(join(invDir, 'reads.json'), 'utf8'), bytes);
    });
    it('a call killed before its result keeps the reads it made', () => {
      const invDir = fixtureInvocation('claude-judgment', { type: 'signalled', signal: 'SIGKILL' }, 'deadline');
      const lines = readFileSync(join(invDir, 'stdout'), 'utf8').split('\n').filter((l) => l !== '');
      writeFileSync(join(invDir, 'stdout'), lines.slice(0, -1).map((l) => `${l}\n`).join(''));
      writeResult(invDir);
      const reads = JSON.parse(readFileSync(join(invDir, 'reads.json'), 'utf8')) as { reads: unknown[] };
      assert.equal(reads.reads.length, 3);
    });
    it('Codex writes no reads.json', () => {
      const invDir = fixtureInvocation('codex-fresh', EXIT0);
      writeResult(invDir);
      assert.equal(existsSync(join(invDir, 'reads.json')), false);
    });
  });

  describe('claude.clean-context', () => {
    // The init event of each capture is what the CLI loaded for the executor's argv and env.
    it('a judgment loads the three read tools only, no MCP server, no skill, no auto-memory', () => {
      const init = initOf('claude-judgment');
      assert.deepEqual(init['tools'], ['Glob', 'Grep', 'Read', 'StructuredOutput']);
      assert.deepEqual(init['mcp_servers'], []);
      assert.deepEqual(init['skills'], []);
      assert.equal(Object.hasOwn(init, 'memory_paths'), false);
    });
    it('an implementer loads no MCP server, no skill, no auto-memory', () => {
      const init = initOf('claude-implementer');
      assert.deepEqual(init['mcp_servers'], []);
      assert.deepEqual(init['skills'], []);
      assert.equal(Object.hasOwn(init, 'memory_paths'), false);
      assert.ok((init['tools'] as string[]).every((t) => !t.startsWith('mcp__')));
    });
    it('the argv carries the flags that make it so: no settings for a judgment, project settings for an implementer', () => {
      const judgment = backendArgv({ kind: 'claude-judgment', role: 'gate', triple: TRIPLE, session: freshJudgmentSession(), schemaText: '{}', system: 'S', evidenceDirs: [] });
      const build = backendArgv({ kind: 'claude-build', triple: TRIPLE, session: freshClaudeImplementerSession(), schemaText: '{}', system: 'S', evidenceDirs: [] });
      for (const argv of [judgment, build]) {
        for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--verbose']) assert.ok(argv.includes(flag), flag);
        assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
        assert.equal(argv.includes('--mcp-config'), false);
      }
      assert.equal(judgment[judgment.indexOf('--setting-sources') + 1], '');
      assert.equal(build[build.indexOf('--setting-sources') + 1], 'project');
    });
  });

  describe('claude.fresh-session-id', () => {
    it('every judgment session is freshly minted, launched with --session-id and never resumed', () => {
      const a = freshJudgmentSession();
      const b = freshJudgmentSession();
      assert.notEqual(a.id, b.id);
      const argv = backendArgv({ kind: 'claude-judgment', role: 'gate', triple: TRIPLE, session: a, schemaText: '{}', system: 'S', evidenceDirs: [] });
      assert.equal(argv[argv.indexOf('--session-id') + 1], a.id);
      assert.equal(argv.includes('--resume'), false);
      assert.equal(argv.includes('--no-session-persistence'), true);
      assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
    });
    it('a resumed judgment call is unrepresentable', () => {
      const call: BackendCall = {
        kind: 'claude-judgment', role: 'planCheck', triple: TRIPLE, schemaText: '{}', system: 'S', evidenceDirs: [],
        // @ts-expect-error: a judgment session's only mode is 'fresh'
        session: { backend: 'claude', mode: 'resume', id: judgmentSessionId('18b3bbf3-98ce-4ced-87c2-639d61b25ef1') },
      };
      assert.equal(call.kind, 'claude-judgment');
    });
    it('a Codex judgment call is unrepresentable', () => {
      // @ts-expect-error: judgment is Claude only (R21); a Codex triple does not fit a judgment call
      const call: BackendCall = {
        kind: 'claude-judgment', role: 'gate', session: freshJudgmentSession(), schemaText: '{}', system: 'S', evidenceDirs: [],
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
      assert.equal(r.type === 'backend' ? r.session : null, '8519f8cd-0b40-4801-8782-5bbf12dbaf58');
    });
  });
});
