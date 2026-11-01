import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { realJudgeSteps } from '../evals/probe-steps.ts';
import { backendArgv, freshJudgmentSession } from '../src/backends/argv.ts';
import { schemaViolation } from '../src/backends/adapter.ts';
import { EXPERIENCE_SCHEMA, validateExperienceOutput } from '../src/prompts/schemas.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls, writeScenario } from './helpers/scenario.ts';

for (const [unit, fixture] of [['walk-1', 'experienceVerdict-01.json'], ['compare-1', 'experienceVerdict-02.json']] as const) {
  test(`probe ${unit}: fresh and repair both delegate with the current schema and same session (local stub only)`, () => {
    const root = tmpDir('probe-delegate');
    const scenario = writeScenario(join(root, 'scenario'), realJudgeSteps(unit));
    const stubDir = join(root, 'stub');
    mkdirSync(stubDir);
    // This explicit local stub is the ONLY executable available after the fake scenario shim. No
    // installed Claude/Codex executable is ever called, even if the developer has one on PATH.
    const calls = join(root, 'forwarded.jsonl');
    writeFileSync(join(stubDir, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')})+'\\n');
process.stdout.write(JSON.stringify({type:'result',structured_output:JSON.parse(process.env.STUB_VALUE)})+'\\n');
`, { mode: 0o755 });
    const session = freshJudgmentSession();
    const value = JSON.parse(readFileSync(new URL(`./fixtures/real-role-output/${fixture}`, import.meta.url), 'utf8'));
    for (const mode of ['fresh', 'resume'] as const) {
      const argv = backendArgv({
        kind: 'claude-acting-judge', role: 'experienceVerdict', triple: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        session: { ...session, mode }, schemaText: JSON.stringify(EXPERIENCE_SCHEMA), system: 'Return your verdict.',
        mcpConfig: null, denyWrites: [], evidenceDirs: [],
      });
      const prompt = mode === 'fresh' ? 'Walk the product.' : 'Your answer was refused: cite only saved file paths. Return a corrected answer.';
      const result = spawnSync(argv[0]!, argv.slice(1), {
        cwd: root, encoding: 'utf8', input: prompt,
        env: { PATH: `${scenario.binDir}:${stubDir}:/usr/bin:/bin`, RESOURCE_OWNER: `probe/${unit}`, STUB_VALUE: JSON.stringify(value) },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(result.stdout).structured_output;
      assert.deepEqual(actual, value);
      assert.equal(schemaViolation(EXPERIENCE_SCHEMA, actual), null);
      assert.doesNotThrow(() => validateExperienceOutput(actual));
    }
    const forwarded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[0]!.argv[forwarded[0]!.argv.indexOf('--session-id') + 1], session.id);
    assert.equal(forwarded[1]!.argv[forwarded[1]!.argv.indexOf('--resume') + 1], session.id);
    assert.match(forwarded[1]!.stdin, /Your answer was refused:/);
    assert.deepEqual(readCalls(scenario.path).map((c) => c.step), [0, 1]);
  });
}

for (const fixture of ['experienceVerdict-01.json', 'experienceVerdict-02.json']) {
  test(`probe fake emissions wrap ${fixture} into the current experience verdict shape`, () => {
    const root = tmpDir('probe-fake-shape');
    const value = JSON.parse(readFileSync(new URL(`./fixtures/real-role-output/${fixture}`, import.meta.url), 'utf8'));
    const scenario = writeScenario(join(root, 'scenario'), [{ as: 'claude', expect: {}, acts: [{ type: 'emit', value: value.verdict }] }]);
    const argv = backendArgv({
      kind: 'claude-acting-judge', role: 'experienceVerdict', triple: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      session: freshJudgmentSession(), schemaText: JSON.stringify(EXPERIENCE_SCHEMA), system: 'Return your verdict.',
      mcpConfig: null, denyWrites: [], evidenceDirs: [],
    });
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd: root, encoding: 'utf8', input: 'Walk.', env: { PATH: `${scenario.binDir}:/usr/bin:/bin` } });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout.trim().split('\n').at(-1)!).structured_output;
    assert.deepEqual(actual, value);
    assert.equal(schemaViolation(EXPERIENCE_SCHEMA, actual), null);
    assert.doesNotThrow(() => validateExperienceOutput(actual));
  });
}
