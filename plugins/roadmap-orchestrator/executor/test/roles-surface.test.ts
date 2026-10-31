import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEV} from '../evals/roles/surface/dev.ts';
import {gradeSurface, referenceAnswer, runSurface, surfaceInput} from '../evals/roles/surface/run.ts';
import {triggeredRoles} from '../evals/roles/triggers.ts';
import {promptFor} from '../src/prompts/index.ts';
import type {RoleInputs} from '../src/prompts/inputs.ts';
import {schemaViolation} from '../src/backends/adapter.ts';
import {tmpDir} from './helpers/repo.ts';

for (const role of ['pre-build', 'campaignAudit'] as const) {
  test(`roles.${role}-dev: three balanced cells, strict schemas and a grader that rejects missing findings`, () => {
    assert.equal(DEV.length, 3);
    assert.equal(DEV.filter((c) => !c.defect).length, 1);
    for (const cell of DEV) {
      const input = surfaceInput(role, cell, '/fixture');
      const prompt = promptFor(role === 'pre-build' ? 'verifier' : 'campaignAudit', 'claude-opus-5-5');
      const rendered = role === 'pre-build' ? promptFor('verifier', 'claude-opus-5-5').render(input as RoleInputs['verifier']) : promptFor('campaignAudit', 'claude-opus-5-5').render(input as RoleInputs['campaignAudit']);
      assert.ok(rendered.includes(cell.contract));
      const answer = referenceAnswer(role, cell.defect);
      assert.equal(schemaViolation(prompt.schema, answer), null);
      assert.equal(gradeSurface(role, cell.defect, answer), true);
      if (cell.defect) assert.equal(gradeSurface(role, true, referenceAnswer(role, false)), false);
    }
  });
  test(`roles.${role}-dry-run: the CLI harness exercises all nine trials without backend calls`, async () => {
    const out = tmpDir(`roles-${role}`);
    assert.equal(await runSurface([role, '--set', 'dev', '--n', '3', '--dry-run', '--out', out]), true);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as {rows: {pass: boolean; usd: number}[]; spent: number};
    assert.equal(summary.rows.length, 9);
    assert.ok(summary.rows.every((r) => r.pass && r.usd === 0));
    assert.equal(summary.spent, 0);
  });
}
test('roles.live-surface-triggers: verifier gate/pre-build and campaign files trigger their current evals', () => {
  for (const path of ['src/prompts/verifier/claude-opus-5-5.ts', 'src/prompts/schemas.ts', 'src/prompts/method/persistence.ts']) {
    assert.ok(triggeredRoles([path]).includes('verifier'));
    assert.ok(triggeredRoles([path]).includes('pre-build'));
  }
  assert.ok(triggeredRoles(['src/prompts/campaignAudit/claude-opus-5-5.ts']).includes('campaignAudit'));
  assert.deepEqual(triggeredRoles(['src/prompts/walkthrough/deleted.ts', 'src/prompts/polishJudge/deleted.ts']), []);
});
