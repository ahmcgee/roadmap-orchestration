import assert from 'node:assert/strict';
import { test } from 'node:test';
import { obligationId, rulingId, ruleId, sha, sha256 } from '../src/core/ids.ts';
import { repoPath } from '../src/core/values.ts';
import type { CorpusPin } from '../src/corpus/types.ts';
import { unitRules } from '../src/holistic/impact.ts';
import { ruleMentions } from '../src/holistic/rederive.ts';
import type { CensusEntry, ObligationDef } from '../src/holistic/types.ts';

const hash = sha256('a'.repeat(64));
const pin: CorpusPin = {
  schema: 'roadmap/corpus-pin-m4', guideSha256: hash, source: { kind: 'same-repo', root: repoPath('docs'), commit: sha('b'.repeat(40)) },
  files: [], rules: [1, 2, 3, 4, 5, 6].map((n) => ({ id: ruleId(`T-${n}`), text: `Rule ${n}`, textSha256: hash, file: repoPath('rules.md'), section: null })),
  retired: [{ id: ruleId('T-99'), textSha256: hash }], highWater: 99, vision: { path: repoPath('vision.md'), sha256: hash },
};
const anchored = (n: number): ObligationDef => ({
  id: obligationId(`I-${n}`), rev: 1, statement: 'Anchor', rule: { id: ruleId(`T-${n}`), textSha256: hash },
  serves: [], witness: null, proofJudgment: null, deliveredBy: [], activation: 'must-hold', contracts: [],
  state: { type: 'active' },
});

test('unit rules union anchors, universal census states and mentions in pin order, skipping retired anchors', () => {
  const census: readonly CensusEntry[] = [
    { rule: ruleId('T-1'), state: { type: 'obligation', id: obligationId('I-1') } },
    { rule: ruleId('T-2'), state: { type: 'untestable' } },
    { rule: ruleId('T-3'), state: { type: 'prod-only' } },
    { rule: ruleId('T-6'), state: { type: 'out-of-slice' } },
  ];
  const retired: ObligationDef = { ...anchored(99), state: { type: 'waived', ruling: rulingId('C-1') } };
  assert.deepEqual(unitRules(pin, census, [anchored(4), retired], [ruleId('T-5'), ruleId('T-2')]), pin.rules.slice(1, 5));
  assert.deepEqual(unitRules(pin, [], [], []), []);
});

test('rule mentions use the canonical T-n parser, once each in mention order', () => {
  assert.deepEqual(ruleMentions('T-5, T-2; T-5; (T-99). XT-4 T-0 T-01 T-7x T-8-9'), ['T-5', 'T-2', 'T-99', 'T-7', 'T-8']);
});
