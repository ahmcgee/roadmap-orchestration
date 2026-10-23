import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt, writeResult } from '../src/backends/adapter.ts';
import { type BackendCall, backendArgv, freshClaudeImplementerSession, freshJudgmentSession, resumedJudgmentSession } from '../src/backends/argv.ts';
import { readClaude } from '../src/backends/claude.ts';
import { classifyBackendError, usageLimitResets } from '../src/backends/errors.ts';
import { type InvocationId, judgmentSessionId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { repairTurnOf } from '../src/pipeline/dispatch.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { tmpDir } from './helpers/repo.ts';
import { RUNNER_FILE_READERS } from '../src/core/records.ts';
import { chargedUsage } from '../src/core/usage.ts';
import { SchemaError } from '../src/core/validate.ts';
import { BACKEND_FIXTURES, CLAUDE_USAGE_LIMIT, capturedClaudeResult, editClaudeResult, fixtureInvocation } from './helpers/scenario.ts';

const EXIT0 = { type: 'exited', code: 0 } as const;
const TRIPLE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' } as const;
const stdoutOf = (name: string): string => readFileSync(join(BACKEND_FIXTURES, name, 'stdout'), 'utf8');
/** The captured api-error stream (its init event, then its result with `fields` replaced). */
const errorStream = (fields: Readonly<Record<string, unknown>>): string =>
  `${stdoutOf('claude-api-error').split('\n')[0]}\n${JSON.stringify({ ...capturedClaudeResult('claude-api-error'), ...fields })}\n`;
const initOf = (name: string): Record<string, unknown> => JSON.parse(stdoutOf(name).split('\n')[0]!) as Record<string, unknown>;

describe('claude', () => {
  it('reads the captured judgment stream: structured_output, session id, usage with turns and cost', () => {
    const r = readClaude(stdoutOf('claude-judgment'));
    assert.deepEqual(r.output, { kind: 'present', value: { ok: true } });
    assert.equal(r.sessionId, '8519f8cd-0b40-4801-8782-5bbf12dbaf58');
    assert.deepEqual(r.usage, {
      kind: 'known', tokens: { inputTokens: 4, outputTokens: 316, cacheReadTokens: 3200, cacheWriteTokens: 3627, turns: 5, costUsd: 0.035992 }, delegated: [],
    });
  });

  describe('claude.subagent-usage (2026-10-16)', () => {
    // The 2.1.301 capture: a Sonnet judgment that put a background Explore subagent on Haiku, so it printed two results
    // (the interim {ok: false}, then {ok: true}), each with the session's cumulative modelUsage of both models.
    it('every model in modelUsage counts; the session\'s own model is its seat\'s, Haiku delegated to economy; turns summed over the results', () => {
      const r = readClaude(stdoutOf('claude-judgment-subagents'));
      assert.deepEqual(r.output, { kind: 'present', value: { ok: true } }, 'the last result is the answer');
      assert.ok(r.usage.kind === 'known');
      const { tokens, delegated } = r.usage;
      assert.deepEqual([tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens, tokens.turns], [8 + 4, 280 + 152, 11950 + 4313, 6868 + 4494, 3 + 2]);
      assert.equal(tokens.costUsd, 0.03216428);
      assert.deepEqual(delegated, [{ class: 'economy', inputTokens: 4, outputTokens: 152, cacheReadTokens: 4313, cacheWriteTokens: 4494, costUsd: 0.0006812799999999999 }]);
      // The subagent's Read is in the session's reads (reads.json), beside the session's own.
      assert.ok(r.access?.reads.some((x) => x.tool === 'Read' && x.path.endsWith('/a.ts')));
    });
    it('a resume reports its session\'s cumulative usage: charged less the fresh call\'s, it is the resume\'s own (the captured implementer pair)', () => {
      const fresh = readClaude(stdoutOf('claude-implementer')).usage;
      const resumed = readClaude(stdoutOf('claude-implementer-resume')).usage;
      assert.ok(fresh.kind === 'known' && resumed.kind === 'known' && fresh.delegated !== undefined && resumed.delegated !== undefined);
      const charged = chargedUsage({ tokens: resumed.tokens, delegated: resumed.delegated }, { tokens: fresh.tokens, delegated: fresh.delegated }, 'resume');
      // The resume's own turn, as its result's top-level usage reports it: 2 in, 52 out, 18474 cache reads, 112 writes.
      assert.deepEqual([charged.tokens.inputTokens, charged.tokens.outputTokens, charged.tokens.cacheReadTokens, charged.tokens.cacheWriteTokens, charged.tokens.turns], [2, 52, 18474, 112, 2]);
      assert.ok(Math.abs((charged.tokens.costUsd ?? 0) - (0.1544788 - 0.14884)) < 1e-12);
    });
    it('a build\'s advisor spend (dev.17) is its own modelUsage entry: delegated to Opus\'s class, frontier', () => {
      // The 2.1.301 capture: a Sonnet build with `--advisor claude-opus-5-5` that consulted the advisor once.
      const r = readClaude(stdoutOf('claude-build-advisor'));
      assert.deepEqual(r.output, { kind: 'present', value: { ok: true } });
      assert.ok(r.usage.kind === 'known');
      assert.equal(initOf('claude-build-advisor')['model'], 'claude-sonnet-5-5');
      assert.deepEqual(r.usage.delegated, [{ class: 'frontier', inputTokens: 19316, outputTokens: 189, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.081044 }]);
      assert.equal(r.usage.tokens.costUsd, 0.15488390000000002);
    });
    it('per-model costs that do not sum to total_cost_usd fail loud', () => {
      const invDir = editClaudeResult(fixtureInvocation('claude-judgment-subagents', EXIT0), (o) => ({ ...o, total_cost_usd: 0.05 }));
      assert.throws(() => adapt(invDir), /usage does not add up: result_index 1: modelUsage costUSD sums to 0\.032\d*, total_cost_usd is 0\.05/);
    });
    it('a model of an uncatalogued version is metered by its family: claude-haiku-9-9 to economy', () => {
      const invDir = editClaudeResult(fixtureInvocation('claude-judgment-subagents', EXIT0), (o) => {
        const m = o['modelUsage'] as Record<string, unknown>;
        return { ...o, modelUsage: { 'claude-sonnet-5-5': m['claude-sonnet-5-5'], 'claude-haiku-9-9': m['claude-haiku-5-5'] } };
      });
      const r = readClaude(readFileSync(join(invDir, 'stdout'), 'utf8'));
      assert.ok(r.usage.kind === 'known');
      assert.deepEqual(r.usage.delegated, [{ class: 'economy', inputTokens: 4, outputTokens: 152, cacheReadTokens: 4313, cacheWriteTokens: 4494, costUsd: 0.0006812799999999999 }]);
    });
    it('a model of no catalogued family fails loud', () => {
      const invDir = editClaudeResult(fixtureInvocation('claude-judgment-subagents', EXIT0), (o) => {
        const m = o['modelUsage'] as Record<string, unknown>;
        return { ...o, modelUsage: { 'claude-sonnet-5-5': m['claude-sonnet-5-5'], 'claude-zephyr-1-0': m['claude-haiku-5-5'] } };
      });
      assert.throws(() => adapt(invDir), /modelUsage names "claude-zephyr-1-0", of no family src\/routing\/classes\.ts DELEGATE_CLASSES catalogues/);
    });
  });

  describe('claude.context-exceeded (2026-10-16)', () => {
    it('the captured prompt-too-long result (2.1.301: is_error, "Prompt is too long", exit 1) is a process fault classed context-exceeded', () => {
      const r = adapt(fixtureInvocation('claude-prompt-too-long', { type: 'exited', code: 1 }));
      assert.ok(r.type === 'backend');
      assert.equal(r.outcome.kind, 'process-fault');
      assert.deepEqual(r.backendErrors, [{ class: 'context-exceeded', message: 'Prompt is too long' }]);
    });
    it('by text or by HTTP 413', () => {
      assert.equal(readClaude(errorStream({ result: 'Input is too long for requested model.', api_error_status: 400 })).backendErrors[0]?.class, 'context-exceeded');
      assert.equal(readClaude(errorStream({ result: 'API Error: 413 request too large', api_error_status: 413 })).backendErrors[0]?.class, 'context-exceeded');
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

  describe('claude.usage-limit-any-result (field feedback 2026-10-23)', () => {
    // Synthesised in the field shape (PROVENANCE): a judge put two background subagents to work; its first result is the
    // session limit (is_error, no HTTP status), and the empty results of its failing subagents follow it.
    const SESSION_LIMIT = "You've hit your session limit · resets 11:40pm (UTC)";
    it('a usage-limit result anywhere in the stream is the call\'s backend error, though empty results follow it', () => {
      const r = readClaude(stdoutOf('claude-judgment-usage-limit-subagents'));
      assert.deepEqual(r.backendErrors, [{ class: 'usage-limit', message: SESSION_LIMIT }]);
      assert.equal(r.output.kind, 'absent');
      const a = adapt(fixtureInvocation('claude-judgment-usage-limit-subagents', EXIT0));
      // Exit 0 without an answer: malformed (the field's ended as a process fault); either way not a success, so verdictOf parks it.
      assert.deepEqual(a.type === 'backend' ? [a.outcome.kind, a.backendErrors.map((e) => e.class)] : null, ['malformed', ['usage-limit']]);
      assert.equal(a.type === 'backend' ? a.usage.kind : null, 'known', 'its usage is the results\'');
    });
    it('a usage limit before a later answer still ends the call: the answer is a background wind-down', () => {
      const lines = stdoutOf('claude-judgment-usage-limit-subagents').split('\n').filter((l) => l !== '');
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      const answered = [...lines.slice(0, -1), JSON.stringify({ ...last, result: '{"ok":true}', structured_output: { ok: true } })].join('\n');
      const r = readClaude(`${answered}\n`);
      assert.deepEqual([r.output.kind, r.backendErrors.map((e) => e.class)], ['absent', ['usage-limit']]);
    });
    it('usageLimitResets: the reset the text names, as written; null when it names none', () => {
      assert.equal(usageLimitResets(SESSION_LIMIT), '11:40pm (UTC)');
      assert.equal(usageLimitResets(CLAUDE_USAGE_LIMIT), '3am (UTC)');
      assert.equal(usageLimitResets('Claude usage limit reached.'), null);
      assert.equal(classifyBackendError("You've hit your weekly limit · resets Oct 27, 6:30am (UTC)", null), 'usage-limit');
    });
  });

  describe('claude.usage-unavailable', () => {
    it('a result without modelUsage is still a success; usage unavailable{absent}', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => {
        delete o['modelUsage'];
        return o;
      }));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'success');
      assert.deepEqual(r.type === 'backend' ? r.usage : null, { kind: 'unavailable', reason: 'absent' });
    });
    it('a modelUsage of the wrong shape → unavailable{malformed}, judgment still a success', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => ({ ...o, modelUsage: { 'claude-opus-5-5': { inputTokens: 'many' } } })));
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
    it('a judgment killed before its result: unavailable{no-result} with what its own model\'s messages streamed; an implementer\'s without it', () => {
      // The 2.1.301 subagents capture without its results: three Sonnet messages of the session (its Haiku subagent's are
      // not its own). Input and cache figures are the API's; output as streamed (64 against the result's 280).
      const cut = (name: string) => {
        const invDir = fixtureInvocation(name, { type: 'signalled', signal: 'SIGKILL' }, 'deadline');
        const lines = readFileSync(join(invDir, 'stdout'), 'utf8').split('\n').filter((l) => l !== '' && (JSON.parse(l) as { type: string }).type !== 'result');
        writeFileSync(join(invDir, 'stdout'), lines.map((l) => `${l}\n`).join(''));
        return adapt(invDir);
      };
      const judged = cut('claude-judgment-subagents');
      assert.deepEqual(judged.type === 'backend' ? judged.usage : null, {
        kind: 'unavailable', reason: 'no-result', streamed: { inputTokens: 8, outputTokens: 64, cacheReadTokens: 11950, cacheWriteTokens: 6868, turns: 3, costUsd: null },
      });
      const built = cut('claude-implementer');
      assert.deepEqual(built.type === 'backend' ? built.usage : null, { kind: 'unavailable', reason: 'no-result' }, 'its resumed session reports this spend');
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
    it('the result\'s permission_denials of Read, Grep and Glob are reads.json\'s denied, in order (paid M4b run 5)', () => {
      const glob = { tool_name: 'Glob', tool_use_id: 'toolu_1', tool_input: { pattern: '**/*', path: '/run/evidence/u1' } };
      const bash = { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'ls' } };
      const read = { tool_name: 'Read', tool_use_id: 'toolu_3', tool_input: { file_path: '/elsewhere/x.md' } };
      const invDir = editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => ({ ...o, permission_denials: [glob, bash, read] }));
      writeResult(invDir);
      const reads = RUNNER_FILE_READERS['reads.json'](JSON.parse(readFileSync(join(invDir, 'reads.json'), 'utf8')), 'reads.json');
      assert.deepEqual(reads.denied, [{ tool: 'Glob', pattern: '**/*', path: '/run/evidence/u1' }, { tool: 'Read', path: '/elsewhere/x.md' }]);
      assert.equal(reads.reads.length, 3, 'the refused calls are not counted twice: reads come from the tool_use blocks');
    });
    it('a result without permission_denials is malformed output', () => {
      const r = adapt(editClaudeResult(fixtureInvocation('claude-judgment', EXIT0), (o) => {
        delete o['permission_denials'];
        return o;
      }));
      assert.equal(r.type === 'backend' ? r.outcome.kind : null, 'malformed');
    });
    it('a reads.json an earlier executor wrote, without denied, reads as written', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      writeResult(invDir);
      const raw = JSON.parse(readFileSync(join(invDir, 'reads.json'), 'utf8')) as Record<string, unknown>;
      delete raw['denied'];
      const reads = RUNNER_FILE_READERS['reads.json'](raw, 'reads.json');
      assert.equal('denied' in reads, false);
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
    it('an implementer loads no MCP server, no auto-memory', () => {
      // The capture predates dev.13 (it ran with --disable-slash-commands, so its skill list is empty); builds now load
      // the project's skills (argv.ts, measured on 2.1.301).
      const init = initOf('claude-implementer');
      assert.deepEqual(init['mcp_servers'], []);
      assert.equal(Object.hasOwn(init, 'memory_paths'), false);
      assert.ok((init['tools'] as string[]).every((t) => !t.startsWith('mcp__')));
    });
    it('the argv carries the flags that make it so: no settings and no skill for a judgment, project settings and skills for an implementer', () => {
      const judgment = backendArgv({ kind: 'claude-judgment', role: 'planCheck', triple: TRIPLE, session: freshJudgmentSession(), schemaText: '{}', system: 'S', evidenceDirs: [] });
      const build = backendArgv({ kind: 'claude-build', triple: TRIPLE, session: freshClaudeImplementerSession(), schemaText: '{}', system: 'S', mcpConfig: null, evidenceDirs: [] });
      for (const argv of [judgment, build]) {
        for (const flag of ['--strict-mcp-config', '--verbose']) assert.ok(argv.includes(flag), flag);
        assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
        assert.equal(argv.includes('--mcp-config'), false);
      }
      assert.ok(judgment.includes('--disable-slash-commands'), 'a judgment loads no skill');
      assert.ok(!build.includes('--disable-slash-commands'), 'a build loads the project skills (dev.13)');
      assert.equal(judgment[judgment.indexOf('--setting-sources') + 1], '');
      assert.equal(build[build.indexOf('--setting-sources') + 1], 'project');
    });
  });

  describe('claude.fresh-session-id', () => {
    it('every judgment session is freshly minted and launched with --session-id, persisted for its repair turn', () => {
      const a = freshJudgmentSession();
      const b = freshJudgmentSession();
      assert.notEqual(a.id, b.id);
      const argv = backendArgv({ kind: 'claude-judgment', role: 'planCheck', triple: TRIPLE, session: a, schemaText: '{}', system: 'S', evidenceDirs: [] });
      assert.equal(argv[argv.indexOf('--session-id') + 1], a.id);
      assert.equal(argv.includes('--resume'), false);
      assert.equal(argv.includes('--no-session-persistence'), false);
      assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob,Agent');
    });
    it('every read-only judgment role (dev.12; the gate acts since dev.13) persists its fresh session and resumes it with --resume for its repair turn', () => {
      const id = judgmentSessionId('18b3bbf3-98ce-4ced-87c2-639d61b25ef1');
      for (const role of ['planCheck', 'lens', 'checkpoint', 'packReview', 'flow'] as const) {
        const fresh = backendArgv({ kind: 'claude-judgment', role, triple: TRIPLE, session: { backend: 'claude', mode: 'fresh', id }, schemaText: '{}', system: 'S', evidenceDirs: [] });
        assert.equal(fresh[fresh.indexOf('--session-id') + 1], id);
        assert.equal(fresh.includes('--no-session-persistence'), false, `${role}: its session persists for the repair turn`);
        const repair = backendArgv({ kind: 'claude-judgment', role, triple: TRIPLE, session: resumedJudgmentSession(id), schemaText: '{}', system: 'S', evidenceDirs: [] });
        assert.equal(repair[repair.indexOf('--resume') + 1], id);
        assert.equal(repair.includes('--session-id'), false);
      }
    });
    it('a Codex judgment call is unrepresentable', () => {
      // @ts-expect-error: judgment is Claude only (R21); a Codex triple does not fit a judgment call
      const call: BackendCall = {
        kind: 'claude-judgment', role: 'planCheck', session: freshJudgmentSession(), schemaText: '{}', system: 'S', evidenceDirs: [],
        triple: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
      };
      assert.equal(call.kind, 'claude-judgment');
    });
    it('launch.json reads a judgment terminal whose session resumes (its repair turn) on every judgment role, and refuses another mode', () => {
      const invDir = fixtureInvocation('claude-judgment', EXIT0);
      const launch = JSON.parse(readFileSync(join(invDir, 'launch.json'), 'utf8')) as { terminal: { role: string; session: { mode: string } } };
      launch.terminal.session.mode = 'continue';
      assert.throws(() => RUNNER_FILE_READERS['launch.json'](launch, 'launch.json'), SchemaError);
      launch.terminal.session.mode = 'resume';
      for (const role of ['planCheck', 'gate', 'lens', 'checkpoint', 'packReview', 'flow']) {
        launch.terminal.role = role;
        const read = RUNNER_FILE_READERS['launch.json'](launch, 'launch.json');
        assert.ok(read.terminal.type === 'backend' && read.terminal.session.backend === 'claude' && read.terminal.session.mode === 'resume');
      }
    });
    it('repairTurnOf: a persisted fresh judgment call takes a repair turn (its session resumed, its schema and cwd); a dev.11 unpersisted one and a repair turn itself take none', () => {
      const runDir = absPath(tmpDir('run'));
      const src = fixtureInvocation('claude-judgment', EXIT0);
      const launchPath = join(src, 'launch.json');
      const launch = JSON.parse(readFileSync(launchPath, 'utf8')) as { inv: InvocationId; argv: string[]; cwd: string; terminal: { session: { mode: string; id: string } } };
      const place = (): void => cpSync(src, invocationDir(runDir, launch.inv), { recursive: true });
      assert.ok(launch.argv.includes('--no-session-persistence'), 'the dev.11 capture ran unpersisted');
      place();
      assert.equal(repairTurnOf(runDir, launch.inv), null, 'an earlier release\'s unpersisted session takes no repair turn');
      writeFileSync(launchPath, JSON.stringify({ ...launch, argv: launch.argv.filter((a) => a !== '--no-session-persistence') }));
      place();
      const turn = repairTurnOf(runDir, launch.inv);
      assert.deepEqual(turn === null ? null : [turn.session, turn.cwd], [resumedJudgmentSession(judgmentSessionId(launch.terminal.session.id)), launch.cwd]);
      assert.deepEqual(turn!.schema, JSON.parse(readFileSync(join(BACKEND_FIXTURES, 'schema.json'), 'utf8')));
      writeFileSync(launchPath, JSON.stringify({ ...launch, argv: launch.argv.filter((a) => a !== '--no-session-persistence'), terminal: { ...launch.terminal, session: { ...launch.terminal.session, mode: 'resume' } } }));
      place();
      assert.equal(repairTurnOf(runDir, launch.inv), null, 'a repair turn takes no further one');
    });
    it('a judgment result carries the launched session id', () => {
      const r = adapt(fixtureInvocation('claude-judgment', EXIT0));
      assert.equal(r.type === 'backend' ? r.session : null, '8519f8cd-0b40-4801-8782-5bbf12dbaf58');
    });
  });
});
