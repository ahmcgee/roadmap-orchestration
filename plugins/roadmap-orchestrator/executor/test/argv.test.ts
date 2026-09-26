// The builder must reproduce, token for token, the argv each real CLI accepted in the captures. The Codex
// captures predate the system-prompt flag (step 6) and no capture has `--add-dir`: the builder appends those
// after the captured tokens. The Claude captures predate `--effort <level>` (Claude triples carry an effort
// since 2026-09-26): the builder's argv less that pair must equal the capture, and the pair follows
// `--model`. `npm run probe` runs the full argv against the real CLIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backendArgv, promptBytes } from '../src/backends/argv.ts';
import { implementerSessionId, judgmentSessionId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { BACKEND_FIXTURES, capturedArgv } from './helpers/scenario.ts';

const CLAUDE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' } as const;
const CODEX = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' } as const;
const value = (argv: readonly string[], flag: string): string => argv[argv.indexOf(flag) + 1] as string;
const exitCode = (name: string): string => readFileSync(join(BACKEND_FIXTURES, name, 'exit-code'), 'utf8').trim();
const SYSTEM = 'You are the gate.';
/** The system text the Claude captures were run with. */
const CAPTURED_SYSTEM = 'You are a probe of an unattended build orchestrator. Do exactly what the message asks, then answer in the structured format requested.';
const EVIDENCE = [absPath('/var/evidence/lane-a'), absPath('/var/evidence/build')] as const;

/** A Claude argv less its `--effort <level>` pair, which must follow `--model <id>` and name CLAUDE's effort. */
function capturedShape(argv: readonly string[]): readonly string[] {
  const i = argv.indexOf('--effort');
  assert.equal(i, argv.indexOf('--model') + 2, '--effort follows --model <id>');
  assert.equal(argv[i + 1], CLAUDE.effort);
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}

describe('argv', () => {
  it('codex fresh', () => {
    const c = capturedArgv('codex-fresh');
    const argv = backendArgv({
      kind: 'codex-build', triple: CODEX, session: { backend: 'codex', mode: 'fresh' }, system: SYSTEM,
      cwd: absPath(value(c, '-C')), outputPath: absPath(value(c, '-o')), schemaPath: absPath(value(c, '--output-schema')),
    });
    assert.deepEqual(argv, c);
    assert.equal(exitCode('codex-fresh'), '0');
    assert.equal(argv.at(-1), '-');
    // Codex has no system channel: the system text leads stdin, then a blank line, then the prompt.
    assert.equal(argv.includes(SYSTEM), false);
    assert.equal(promptBytes({
      kind: 'codex-build', triple: CODEX, session: { backend: 'codex', mode: 'fresh' }, system: SYSTEM,
      cwd: absPath('/w'), outputPath: absPath('/o'), schemaPath: absPath('/s'),
    }, 'Do the unit.'), `${SYSTEM}\n\nDo the unit.`);
  });
  it('claude judgment', () => {
    const c = capturedArgv('claude-judgment');
    const call = {
      kind: 'claude-judgment', role: 'gate', triple: CLAUDE, schemaText: value(c, '--json-schema'),
      session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(value(c, '--session-id')) },
      system: CAPTURED_SYSTEM, evidenceDirs: [],
    } as const;
    assert.deepEqual(capturedShape(backendArgv(call)), c);
    assert.equal(exitCode('claude-judgment'), '0');
    assert.deepEqual(capturedShape(backendArgv({ ...call, evidenceDirs: EVIDENCE })), [...c, '--add-dir', EVIDENCE[0], '--add-dir', EVIDENCE[1]]);
    // Claude takes the system text by flag, so stdin is the rendered prompt alone.
    assert.equal(promptBytes(call, 'Judge the diff.'), 'Judge the diff.');
  });
  it('claude implementer, fresh and resumed', () => {
    const fresh = capturedArgv('claude-implementer');
    const resumed = capturedArgv('claude-implementer-resume');
    const id = implementerSessionId(value(fresh, '--session-id'));
    const schemaText = value(fresh, '--json-schema');
    const system = CAPTURED_SYSTEM;
    assert.deepEqual(capturedShape(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, system, session: { backend: 'claude', mode: 'fresh', id }, evidenceDirs: [] })), fresh);
    assert.deepEqual(capturedShape(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, system, session: { backend: 'claude', mode: 'resume', id }, evidenceDirs: [] })), resumed);
    assert.equal(value(fresh, '--append-system-prompt'), system);
    const dirs = [absPath('/run/work/u1'), absPath('/run/evidence/u1/lane')];
    assert.deepEqual(
      capturedShape(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, system, session: { backend: 'claude', mode: 'resume', id }, evidenceDirs: dirs })),
      [...resumed, '--add-dir', dirs[0], '--add-dir', dirs[1]],
    );
    assert.equal(exitCode('claude-implementer-resume'), '0');
  });
});
