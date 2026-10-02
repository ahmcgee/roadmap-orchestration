// M3 test support: the scripted lens and checkpoint (per job, per lens) and the fake witness lanes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JsonValue } from '../src/core/json.ts';
import { validateCheckpointOutput, validateLensOutput } from '../src/prompts/schemas.ts';
import {
  INVALID_OP, VALID_OP, checkpointAnswer, checkpointStep, interpretationOnlyNoop, lensAnswer, lensStep, twoOpBundleSecondInvalid,
} from './helpers/holistic.ts';
import { git, makeRepo, tmpDir, worktreeTree, writeFiles } from './helpers/repo.ts';
import { type Step, readCalls, writeScenario } from './helpers/scenario.ts';
import { readWitnessFile, scriptTree, witnessLaneArgv, writeWitnessControl } from './helpers/witness.ts';

/** A claude call through the shim as job `job`, its prompt `stdin`; returns the structured output (or the exit code). */
function claude(binDir: string, job: string, stdin: string): { code: number | null; out: unknown } {
  const r = spawnSync('claude', ['-p', '--session-id', '00000000-0000-4000-8000-000000000001'], {
    input: stdin, encoding: 'utf8', cwd: tmpDir('elsewhere'), env: { PATH: `${binDir}:/usr/bin:/bin`, RESOURCE_OWNER: `arc/${job}` },
  });
  const last = r.stdout.split('\n').filter((l) => l !== '').at(-1);
  const result = last === undefined ? undefined : (JSON.parse(last) as { structured_output?: unknown });
  return { code: r.status, out: result?.structured_output };
}

describe('fakes.lens', () => {
  it('answers per job and lens kind, each in its own order, with output the frozen reader accepts', () => {
    const steps: Step[] = [
      lensStep('audit-1', 'vision', [{ severity: 'P2', claim: 'vision gap' }]),
      lensStep('audit-1', 'drift', []),
      lensStep('audit-1', 'vision', [{ severity: 'P3', claim: 'second vision call' }]),
      lensStep('audit-2', 'vision', [{ severity: 'P1', obligation: 'I-1', claim: 'other job' }]),
      lensStep(undefined, 'vacuity', [{ mutant: { patch: '--- a\n+++ b\n', lane: 'unit' } }]),
    ];
    const s = writeScenario(tmpDir('scenario'), steps);
    const claims = (job: string, lens: string): string[] =>
      (claude(s.binDir, job, `{"lens": "${lens}"}`).out as { findings: { claim: string }[] }).findings.map((f) => f.claim);
    assert.deepEqual(claims('audit-2', 'vision'), ['other job']);
    assert.deepEqual(claims('audit-1', 'drift'), []);
    assert.deepEqual(claims('audit-1', 'vision'), ['vision gap']);
    assert.deepEqual(claims('audit-1', 'vision'), ['second vision call']);
    assert.equal(validateLensOutput(claude(s.binDir, 'audit-9', 'lens: vacuity').out).findings[0]?.mutant?.lane, 'unit');
    assert.equal(claude(s.binDir, 'audit-1', '{"lens": "vision"}').code, 99, 'no vision step left for audit-1');
    assert.deepEqual(readCalls(s.path).map((c) => [c.unit, c.lens, c.step]), [
      ['audit-2', 'vision', 3], ['audit-1', 'drift', 1], ['audit-1', 'vision', 0], ['audit-1', 'vision', 2], ['audit-9', 'vacuity', 4], ['audit-1', 'vision', null],
    ]);
  });
});

describe('fakes.checkpoint', () => {
  const ops = (answer: JsonValue): readonly unknown[] => (answer as { ops: unknown[] }).ops;

  it('scripts a two-op bundle whose second op is invalid, and an interpretation-only no-op, per job', () => {
    const bundle = twoOpBundleSecondInvalid();
    const noop = interpretationOnlyNoop(['V-2'], 'no clause anticipates a second arc', 'proceed as the first');
    const s = writeScenario(tmpDir('scenario'), [checkpointStep('ckpt-1', bundle), checkpointStep('ckpt-2', noop)]);
    const second = validateCheckpointOutput(claude(s.binDir, 'ckpt-2', 'checkpoint inputs').out);
    assert.equal(second.decision, 'no-op');
    assert.deepEqual(second.ops, []);
    assert.deepEqual(second.interpretations.map((i) => i.clauses), [['V-2']]);
    const first = validateCheckpointOutput(claude(s.binDir, 'ckpt-1', 'checkpoint inputs').out);
    assert.equal(first.decision, 'bundle');
    assert.deepEqual(first.ops.map((o) => o.op), ['limits', 'cut']);
    assert.deepEqual(ops(bundle), [VALID_OP, INVALID_OP]);
  });

  it('a checkpoint answer the reader refuses is never built', () => {
    assert.throws(() => checkpointAnswer({ decision: 'no-op', ops: [VALID_OP] }));
    assert.throws(() => checkpointAnswer({ decision: 'bundle' }));
    assert.throws(() => lensAnswer([{ severity: 'P0' as 'P1' }]));
  });

  it('a checkpoint prompt that lists findings (which name lenses) still takes its own job\'s step', () => {
    const s = writeScenario(tmpDir('scenario'), [checkpointStep('ckpt-1', interpretationOnlyNoop())]);
    assert.equal(claude(s.binDir, 'ckpt-1', '{"findings": [{"lens": "drift"}]}').code, 0);
  });
});

describe('fakes.witness-lanes', () => {
  function setup() {
    const repo = makeRepo(tmpDir('repo'), { files: { 'a.txt': 'one\n' } });
    const dir = tmpDir('lane');
    const control = join(dir, 'control.json');
    const treeA = worktreeTree(repo);
    writeFiles(repo, { 'a.txt': 'two\n' });
    const treeB = worktreeTree(repo);
    writeFiles(repo, { 'a.txt': 'one\n' });
    const run = (argv: readonly string[], file: string) => {
      const [cmd, ...args] = argv as [string, ...string[]];
      return spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ROADMAP_WITNESS_FILE: file } });
    };
    return { repo, dir, control, treeA, treeB, run };
  }

  it('worktreeTree is the committed tree when clean and moves with an uncommitted change', () => {
    const { repo, treeA, treeB } = setup();
    assert.notEqual(treeA, treeB);
    assert.equal(worktreeTree(repo), treeA);
    assert.equal(treeA, git(repo, 'rev-parse', 'HEAD^{tree}'));
  });

  for (const reporter of ['node-test', 'jsonl'] as const) {
    it(`${reporter}: a chosen test id passes, fails, skips or selects nothing, per tree`, () => {
      const { repo, dir, control, treeA, treeB, run } = setup();
      writeWitnessControl(control, {
        trees: {
          [treeA]: { outcomes: { 'b.test': 'pass', 'a.test': 'pass', 'c.test': 'skip', 'd.test': 'zero-selected' } },
          [treeB]: { outcomes: { 'a.test': 'fail', 'b.test': 'pass' } },
        },
      });
      const argv = witnessLaneArgv(reporter, dir, control);
      const onA = join(dir, 'a.jsonl');
      const a = run(argv, onA);
      assert.equal(a.status, 0, a.stderr);
      assert.deepEqual(readWitnessFile(onA), [
        { testId: 'a.test', selected: 1, outcome: 'pass' }, { testId: 'b.test', selected: 1, outcome: 'pass' },
        { testId: 'c.test', selected: 1, outcome: 'skip' }, { testId: 'd.test', selected: 0, outcome: 'zero-selected' },
      ]);
      if (reporter === 'node-test') assert.match(a.stdout, /^ok 3 - c\.test # SKIP$/m);
      else assert.equal(a.stdout, '');
      writeFiles(repo, { 'a.txt': 'two\n' });
      const onB = join(dir, 'b.jsonl');
      const b = run(argv, onB);
      assert.equal(b.status, 1, 'a failed test fails the lane');
      assert.deepEqual(readWitnessFile(onB).map((r) => [r.testId, r.outcome]), [['a.test', 'fail'], ['b.test', 'pass']]);
    });
  }

  it('a tree with no entry falls back to `*`, else reports nothing; a malformed script writes an unparsable line', () => {
    const { repo, dir, control, treeA, run } = setup();
    writeWitnessControl(control, { trees: { [treeA]: { outcomes: { 'a.test': 'pass' } } } });
    const argv = witnessLaneArgv('jsonl', dir, control);
    writeFiles(repo, { 'a.txt': 'three\n' });
    const none = join(dir, 'none.jsonl');
    assert.equal(run(argv, none).status, 0);
    assert.deepEqual(spawnSync('test', ['-e', none]).status, 1, 'nothing was appended');
    scriptTree(control, '*', { outcomes: { 'z.test': 'pass' } });
    const star = join(dir, 'star.jsonl');
    run(argv, star);
    assert.deepEqual(readWitnessFile(star).map((r) => r.testId), ['z.test']);
    scriptTree(control, '*', { outcomes: {}, malformed: true });
    const bad = join(dir, 'bad.jsonl');
    run(argv, bad);
    assert.throws(() => readWitnessFile(bad));
  });

  it('a lane without ROADMAP_WITNESS_FILE fails loudly', () => {
    const { dir, control, treeA } = setup();
    writeWitnessControl(control, { trees: { [treeA]: { outcomes: {} } } });
    const [cmd, ...args] = witnessLaneArgv('node-test', dir, control) as [string, ...string[]];
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ROADMAP_WITNESS_FILE is not set/);
  });
});
