import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { systemName } from '../src/core/ids.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { revParse } from '../src/git/git.ts';
import { systemNotes } from '../src/pipeline/systemnotes.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { readCalls } from './helpers/scenario.ts';
import { git, makeRepo, tmpDir, writeFiles } from './helpers/repo.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { appendSteps, contextFor, gateStep, mulBuild, setupArc } from './fixtures/unit-common.ts';

const names = ['api', 'db', 'absent'].map((s) => systemName(s));

test('system notes: existing files only, sorted, at the role commit; default and configurable directory', () => {
  const repo = absPath(tmpDir('system-notes'));
  makeRepo(repo, { files: {
    'docs/systems/api.md': 'API memory, never a claim.\n',
    'docs/systems/db.md': 'DB memory.\n',
    'docs/systems/other.md': 'Not this unit.\n',
    'memory/api.md': 'Custom API memory.\n',
  } });
  const head = revParse(repo, 'HEAD');
  writeFiles(repo, { 'docs/systems/absent.md': 'Uncommitted notes must not enter the input.\n' });
  assert.deepEqual(systemNotes(repo, head, [...names].reverse(), null), [repoPath('docs/systems/api.md'), repoPath('docs/systems/db.md')]);
  const config = parseRepoConfig({ systemNotesDir: 'memory' });
  assert.deepEqual(systemNotes(repo, head, names, config), [repoPath('memory/api.md')]);
  assert.deepEqual(systemNotes(repo, head, [], null), []);
  assert.deepEqual(systemNotes(repo, head, [systemName('absent')], null), []);
  for (const path of ['/outside', '../outside', 'docs/../outside']) assert.throws(() => parseRepoConfig({ systemNotesDir: path }));
});

test('system notes: build and gate receive paths only, and an edit lands as an ordinary unit diff', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
  const original = setupArc({ steps: [], units: [{ id: 'u1' }] });
  writeFiles(original.repo, { 'memory/api.md': 'PRIVATE NOTES CONTENT\n', 'memory/unrelated.md': 'UNRELATED NOTES\n' });
  git(original.repo, 'add', 'memory');
  git(original.repo, 'commit', '--quiet', '-m', 'seed per-system memory');
  const plan = JSON.parse(readFileSync(original.planPath, 'utf8'));
  plan.units[0].systems = ['api'];
  writeFileSync(original.planPath, JSON.stringify(plan));
  const d = { ...original, config: parseRepoConfig({ systemNotesDir: 'memory', systemsMap: { systems: { api: { paths: ['src/**', 'test/**', 'memory/api.md'] } } } }) };
  const expected = ['<system_notes>\nmemory/api.md\n</system_notes>'];
  const build = mulBuild({ 'memory/api.md': 'Record the seam discovered while building mul.\n' });
  appendSteps(d, [planCheckStep({ decision: 'approve' }), { ...build, expect: { ...build.expect, stdinContains: expected } }, gateStep({ decision: 'approve' }, { stdinContains: expected })]);
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.equal(git(d.repo, 'show', 'main:memory/api.md'), 'Record the seam discovered while building mul.');
    const calls = readCalls(d.scenarioPath).filter((c) => c.stdin.includes('<system_notes>'));
    assert.equal(calls.length, 2, 'both build and gate receive the notes input');
    for (const call of calls) {
      const slot = call.stdin.split('<system_notes>')[1]!.split('</system_notes>')[0]!;
      assert.equal(slot, '\nmemory/api.md\n');
      if (call.as === 'codex') assert.ok(!call.stdin.includes('PRIVATE NOTES CONTENT'), 'the build receives a path, without inline note contents');
      else assert.ok(call.stdin.includes('PRIVATE NOTES CONTENT'), 'the gate still sees the notes edit in its ordinary diff');
      assert.ok(!call.stdin.includes('memory/unrelated.md'));
    }
  } finally { r.journal.close(); }
});
