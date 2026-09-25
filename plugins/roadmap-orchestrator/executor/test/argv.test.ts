// The builder must reproduce, token for token, the argv each real CLI accepted in the captures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backendArgv } from '../src/backends/argv.ts';
import { implementerSessionId, judgmentSessionId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { BACKEND_FIXTURES, capturedArgv } from './helpers/scenario.ts';

const CLAUDE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;
const CODEX = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' } as const;
const value = (argv: readonly string[], flag: string): string => argv[argv.indexOf(flag) + 1] as string;
const exitCode = (name: string): string => readFileSync(join(BACKEND_FIXTURES, name, 'exit-code'), 'utf8').trim();

describe('argv', () => {
  it('codex fresh', () => {
    const c = capturedArgv('codex-fresh');
    const argv = backendArgv({
      kind: 'codex-build', triple: CODEX, session: { backend: 'codex', mode: 'fresh' },
      cwd: absPath(value(c, '-C')), outputPath: absPath(value(c, '-o')), schemaPath: absPath(value(c, '--output-schema')),
    });
    assert.deepEqual(argv, c);
    assert.equal(exitCode('codex-fresh'), '0');
    assert.equal(argv.at(-1), '-');
  });
  it('claude judgment', () => {
    const c = capturedArgv('claude-judgment');
    const argv = backendArgv({
      kind: 'claude-judgment', role: 'gate', triple: CLAUDE, schemaText: value(c, '--json-schema'),
      session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(value(c, '--session-id')) },
    });
    assert.deepEqual(argv, c);
    assert.equal(exitCode('claude-judgment'), '0');
  });
  it('claude implementer, fresh and resumed', () => {
    const fresh = capturedArgv('claude-implementer');
    const resumed = capturedArgv('claude-implementer-resume');
    const id = implementerSessionId(value(fresh, '--session-id'));
    const schemaText = value(fresh, '--json-schema');
    assert.deepEqual(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, session: { backend: 'claude', mode: 'fresh', id } }), fresh);
    assert.deepEqual(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, session: { backend: 'claude', mode: 'resume', id } }), resumed);
    assert.equal(exitCode('claude-implementer-resume'), '0');
  });
});
