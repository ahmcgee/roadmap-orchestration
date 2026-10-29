import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGateTrial } from '../evals/roles/gate/arc.ts';
import { DEV_CELLS, isCorpusCell } from '../evals/roles/gate/cells.ts';
import { buildFixture } from '../evals/roles/gate/fixture.ts';
import { grade } from '../evals/roles/gate/grade.ts';
import { readTranscript } from '../evals/roles/transcript.ts';
import { repoPath } from '../src/core/values.ts';
import { validateGateOutput } from '../src/prompts/schemas.ts';
import { tmpDir } from './helpers/repo.ts';

const cells = DEV_CELLS.filter(isCorpusCell);
test('corpus eval cells reach the production gate with exactly their anchor and universal rules embedded', { timeout: 300_000 }, async () => {
  assert.equal(cells.length, 3);
  for (const cell of cells) {
    const out = tmpDir('roles-corpus');
    const row = await runGateTrial({ set: 'dev', cell, trial: 0, seed: 'corpus-test', size: 150, gate: cell.corpus === 'clean' ? 'approve-all' : 'cite-plant',
      risk: 'med', config: null, out, medianLoad: null, trialCap: null, readOnly: false, log: () => {} });
    assert.equal(row.void, null, JSON.stringify(row.void));
    assert.equal(row.graded?.verdict, cell.corpus === 'clean' ? 'clean-pass' : 'caught');
    const prompt = readFileSync(join(out, 'prompt.txt'), 'utf8');
    assert.match(prompt, /T-1: A vessel export preserves the vessel id/);
    assert.match(prompt, /T-2: Vessel access tokens remain confidential/);
    assert.match(prompt, /40 other active rules are readable in/);
    assert.doesNotMatch(prompt, /The archived tariff screen displays/);
    assert.ok(row.stages.includes('lanes:green'), row.stages.join(' '));
  }
});

test('a clean corpus cell fails grading if a finding invents a violation of an unshown rule', () => {
  const cell = cells.find((c) => c.corpus === 'clean')!;
  const fx = buildFixture(cell, { seed: 'corpus-test', trial: 0, size: 150, scratch: tmpDir('roles-scratch') });
  const shown = { inlined: fx.key.changed.map((p) => repoPath(p)), notInlined: [] };
  const answer = validateGateOutput({ decision: 'approve', findings: [{ severity: 'note', path: null, text: 'T-3 tariff band is missing.', contractRef: 'T-3', experiments: [], debt: null }],
    directives: [], reasons: ['The export is acceptable.'], premises: [], unreviewed: [], clusters: null, rulings: [] });
  assert.equal(grade(fx.key, shown, '', readTranscript([]), answer).verdict, 'false-positive');
});
