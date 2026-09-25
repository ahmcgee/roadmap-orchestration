// The builder must reproduce, token for token, the argv each real CLI accepted in the captures. The
// captures predate the system-prompt and `--add-dir` flags (step 6), which the builder appends after the
// captured tokens; `npm run probe` runs the full argv against the real CLIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backendArgv, promptBytes } from '../src/backends/argv.ts';
import { implementerSessionId, judgmentSessionId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { BACKEND_FIXTURES, capturedArgv } from './helpers/scenario.ts';

const CLAUDE = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;
const CODEX = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' } as const;
const value = (argv: readonly string[], flag: string): string => argv[argv.indexOf(flag) + 1] as string;
const exitCode = (name: string): string => readFileSync(join(BACKEND_FIXTURES, name, 'exit-code'), 'utf8').trim();
const SYSTEM = 'You are the gate.';
const EVIDENCE = [absPath('/var/evidence/lane-a'), absPath('/var/evidence/build')] as const;

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
    const argv = backendArgv({
      kind: 'claude-judgment', role: 'gate', triple: CLAUDE, schemaText: value(c, '--json-schema'),
      session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(value(c, '--session-id')) },
      system: SYSTEM, evidenceDirs: EVIDENCE,
    });
    assert.deepEqual(argv, [...c, '--system-prompt', SYSTEM, '--add-dir', EVIDENCE[0], '--add-dir', EVIDENCE[1]]);
    assert.equal(exitCode('claude-judgment'), '0');
    // Claude takes the system text by flag, so stdin is the rendered prompt alone.
    const call = {
      kind: 'claude-judgment', role: 'gate', triple: CLAUDE, schemaText: '{}', system: SYSTEM, evidenceDirs: [],
      session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(value(c, '--session-id')) },
    } as const;
    assert.deepEqual(backendArgv(call), [...c.slice(0, c.indexOf('--json-schema') + 1), '{}', ...c.slice(c.indexOf('--json-schema') + 2), '--system-prompt', SYSTEM]);
    assert.equal(promptBytes(call, 'Judge the diff.'), 'Judge the diff.');
  });
  it('claude implementer, fresh and resumed', () => {
    const fresh = capturedArgv('claude-implementer');
    const resumed = capturedArgv('claude-implementer-resume');
    const id = implementerSessionId(value(fresh, '--session-id'));
    const schemaText = value(fresh, '--json-schema');
    const system = ['--append-system-prompt', SYSTEM];
    assert.deepEqual(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, system: SYSTEM, session: { backend: 'claude', mode: 'fresh', id } }), [...fresh, ...system]);
    assert.deepEqual(backendArgv({ kind: 'claude-build', triple: CLAUDE, schemaText, system: SYSTEM, session: { backend: 'claude', mode: 'resume', id } }), [...resumed, ...system]);
    assert.equal(exitCode('claude-implementer-resume'), '0');
  });
});
