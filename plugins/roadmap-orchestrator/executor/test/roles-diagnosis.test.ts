// dev.82 (E2): the diagnosis role eval's harness, free: the dev case lays out a repository whose lane really fails on the head
// and the base, the prompt renders its evidence, the reference answer conforms to the schema and passes the mechanical grade,
// a code-change answer fails it, and the dry run makes no backend call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEV } from '../evals/roles/diagnosis/dev.ts';
import { diagnosisInput, gradeDiagnosis, layOut, referenceAnswer, runDiagnosis } from '../evals/roles/diagnosis/run.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { schemaViolation } from '../src/backends/adapter.ts';
import { promptFor } from '../src/prompts/index.ts';
import { DIAGNOSIS_SCHEMA } from '../src/prompts/schemas.ts';
import { tmpDir } from './helpers/repo.ts';

test('roles.diagnosis-dev: one case; its lane fails with its line after every fix and on the base, and the prompt carries the evidence', () => {
  assert.equal(DEV.length, 1);
  const c = DEV[0]!;
  const t = layOut(c, tmpDir('roles-diagnosis-case'));
  assert.equal(t.attempts.length, 1 + c.fixes.length, 'the first build and each fix ran the lane red');
  for (const dir of [...t.attempts, t.baseRun]) assert.ok(readFileSync(join(dir, 'stderr'), 'utf8').includes(c.failure), dir);
  const text = promptFor('verifier', 'claude-opus-5-5').render(diagnosisInput(c, t));
  for (const v of ['<mode>diagnosis</mode>', c.failure, t.base, t.baseRun, ...t.attempts]) assert.ok(text.includes(v), v);
});

test('roles.diagnosis-grade: the reference answer conforms and passes; a code-change answer, a wrong cause or no dump citation fails', () => {
  const c = DEV[0]!;
  const expected = referenceAnswer(c, 'expected');
  assert.equal(schemaViolation(DIAGNOSIS_SCHEMA, expected), null);
  assert.deepEqual(gradeDiagnosis(c, expected), { pass: true, void: null, checks: { cause: true, cites: true, noCodeChange: true } });
  assert.deepEqual(gradeDiagnosis(c, referenceAnswer(c, 'code')).checks, { cause: false, cites: false, noCodeChange: false });
  const e = expected as Record<string, unknown>;
  assert.equal(gradeDiagnosis(c, { ...e, cause: 'base' }).pass, false);
  assert.equal(gradeDiagnosis(c, { ...e, evidence: ['the lane is red on the base'] }).pass, false);
  assert.equal(gradeDiagnosis(c, { ...e, brief: 'Restore the account, then retry src/signin.js unchanged.' }).checks?.noCodeChange, false);
  assert.notEqual(gradeDiagnosis(c, { ...e, cause: 'environment', evidence: [] }).void, null, 'an external cause without evidence is malformed: void');
});

test('roles.diagnosis-dry-run: the CLI harness grades three trials without backend calls; diagnosis paths trigger the role', async () => {
  const out = tmpDir('roles-diagnosis');
  assert.equal(await runDiagnosis(['diagnosis', '--set', 'dev', '--n', '3', '--dry-run', '--out', out]), true);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as { rows: { pass: boolean; usd: number }[]; spent: number };
  assert.equal(summary.rows.length, 3);
  assert.ok(summary.rows.every((r) => r.pass && r.usd === 0));
  assert.equal(summary.spent, 0);
  assert.equal(await runDiagnosis(['diagnosis', '--set', 'dev', '--n', '1', '--fake', 'code', '--out', tmpDir('roles-diagnosis-code')]), false);
  for (const path of ['src/prompts/verifier/claude-opus-5-5.ts', 'src/pipeline/surface.ts', 'src/pipeline/lanes.ts', 'evals/roles/diagnosis/dev.ts']) assert.ok(triggeredRoles([path]).includes('diagnosis'), path);
  assert.ok(!triggeredRoles(['src/holistic/audit.ts']).includes('diagnosis'));
});
