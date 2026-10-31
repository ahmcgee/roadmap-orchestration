import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, corpusArc, editPlan } from './helpers/corpusarc.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';

test('foreign baseline: first schema-2 arc validates a predecessor commit without a previous arc ref', async () => {
  const previous = await corpusArc();
  const head = git(previous.repo, 'rev-parse', 'HEAD');
  writeFiles(previous.repo, { '.roadmap/config.json': readFileSync(join(previous.repo, '.roadmap/config.json'), 'utf8') + '\n' });
  const baseline = commitAll(previous.repo, 'foreign release boundary');
  const arc = await corpusArc({ repo: previous.repo, forge: previous.forge, plan: { baseline, previousHead: head } });
  assert.equal(git(arc.repo, 'for-each-ref', '--format=%(refname)', 'refs/roadmap/'), '');
  assert.deepEqual((await check(arc)).rows, []);
  editPlan(arc, (p) => ({ ...p, previousHead: baseline }));
  assert.match(JSON.stringify((await check(arc)).rows), /parent-mismatch/);
});

test('foreign baseline: corpus drift is compared against the supplied baseline', async () => {
  const previous = await corpusArc();
  const previousHead = git(previous.repo, 'rev-parse', 'HEAD');
  writeFiles(previous.repo, { '.roadmap/config.json': readFileSync(join(previous.repo, '.roadmap/config.json'), 'utf8') + '\n' });
  const baseline = commitAll(previous.repo, 'foreign release boundary');
  const arc = await corpusArc({ repo: previous.repo, forge: previous.forge, plan: { baseline, previousHead } });
  const file = 'docs/corpus/0010_Overview.md';
  writeFiles(arc.repo, { [file]: readFileSync(join(arc.repo, file), 'utf8') + '\nChanged after baseline.\n' });
  commitAll(arc.repo, 'drift after baseline');
  const report = await check(arc);
  assert.ok(report.rows.some((r) => r.kind === 'corpus-invalid' && r.problems.some((p) => p.type === 'corpus-drift' && p.paths.includes(file as never))), JSON.stringify(report));
});
