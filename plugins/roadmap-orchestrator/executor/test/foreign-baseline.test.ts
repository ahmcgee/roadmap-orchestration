import { requirePlanInForce } from '../src/input/inforce.ts';
import { absPath } from '../src/core/values.ts';
import { type ExecRun, cli, journalOf, until } from './fixtures/exec-common.ts';
import { claimOf, idle, pausedFromTheStart, smokes, startCli, startLine } from './fixtures/sup-common.ts';
import { assertNoSurvivors, own } from './helpers/reap.ts';
import { writeScenario } from './helpers/scenario.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, corpusArc, editPlan, newHostDir, runDirOfArc } from './helpers/corpusarc.ts';
import { commitAll, git, writeFiles, tmpDir } from './helpers/repo.ts';

after(assertNoSurvivors);

test('foreign baseline: actual start accepts a predecessor commit without a previous arc ref', { timeout: 120_000 }, async (t) => {
  const previous = await corpusArc();
  const head = git(previous.repo, 'rev-parse', 'HEAD');
  writeFiles(previous.repo, { '.roadmap/config.json': readFileSync(join(previous.repo, '.roadmap/config.json'), 'utf8') + '\n' });
  const baseline = commitAll(previous.repo, 'foreign release boundary');
  const arc = await corpusArc({ repo: previous.repo, forge: previous.forge, plan: { baseline, previousHead: head } });
  assert.equal(git(arc.repo, 'for-each-ref', '--format=%(refname)', 'refs/roadmap/'), '');
  assert.deepEqual((await check(arc)).rows, []);
  const scenarioDir = tmpDir('foreign-start-scenario');
  const scenario = writeScenario(scenarioDir, smokes(1));
  const r: ExecRun = { arc: arc.arc, repo: arc.repo, planPath: arc.planPath, runDir: runDirOfArc(arc), hostDir: newHostDir(),
    binDir: scenario.binDir, scenarioPath: scenario.path, scenarioDir, stateDir: tmpDir('foreign-start-state') };
  own(t, { paths: [r.hostDir, r.repo], stop: () => cli(r, ['stop']) });
  await pausedFromTheStart(r);
  const started = await startCli(r, undefined, { PATH: `${scenario.binDir}:${arc.forge.path}` });
  const line = startLine(started);
  assert.equal(line.kind, 'ready', JSON.stringify(started));
  await idle(r, line.generation!);
  const applied = journalOf(r).view.planApplied();
  assert.equal(applied!.rev, 1);
  const inForce = requirePlanInForce(absPath(r.runDir), journalOf(r).view).plan;
  assert.equal(inForce.baseline, baseline);
  assert.equal(inForce.previousHead, head);
  assert.equal(journalOf(r).view.planApplied()!.systemsMap !== null, true);
  await cli(r, ['stop']);
  await until(() => claimOf(r) === null, 60_000, 'foreign-baseline start to release its host claim');
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
