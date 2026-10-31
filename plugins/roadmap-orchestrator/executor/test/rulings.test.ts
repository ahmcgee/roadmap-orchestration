import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {rulingId} from '../src/core/ids.ts';
import {type RepoPath, repoPath} from '../src/core/values.ts';
import {anchorSection, headingSlug, applyContractOps, citeRuling} from '../src/docs/contracts.ts';
import {parseRulings} from '../src/spec/rulings.ts';
const MONEY = [
  '# Money',
  '',
  '## Rounding',
  '',
  'Totals round half-up at the cent.',
  'Rates keep four places.',
  '',
  '### Display',
  '',
  'Amounts show two places.',
  '',
  '## Currency',
  '',
  'One currency per ledger.',
  '',
  '```md',
  '## Rounding',
  '```',
  '',
].join('\n');
const DOCS: Readonly<Record<string, string>> = {'docs/money.md': MONEY};
describe('contract ops', () => {
  it('contracts.anchor-exact: anchors name one heading (by slug, not in fences) or one line; old text exactly once; the header cites the ruling', () => {
    assert.equal(headingSlug(' Rounding & Display! '), 'rounding--display');
    const s = anchorSection(MONEY, '#rounding');
    assert.ok(typeof s !== 'string');
    assert.equal(MONEY.slice(s.start, s.end), '## Rounding\n\nTotals round half-up at the cent.\nRates keep four places.\n\n### Display\n\nAmounts show two places.\n\n');
    assert.match(anchorSection(MONEY, 'places') as string, /matches 2 lines/);
    const line = anchorSection(MONEY, 'Rates keep');
    assert.ok(typeof line !== 'string');
    assert.equal(MONEY.slice(line.start, line.end), 'Rates keep four places.\n\n', 'a line anchor runs to the next heading');

    const C3 = rulingId('C-3');
    const at = (p: RepoPath): string | null => DOCS[p] ?? null;
    const ok = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#rounding', oldText: 'half-up', newText: 'half-even' }], C3, at);
    assert.ok('edits' in ok);
    assert.deepEqual(ok.edits, [{ path: 'docs/money.md', text: `<!-- revised by C-3 -->\n${MONEY.replace('half-up', 'half-even')}` }]);
    const twice = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#rounding', oldText: 'places', newText: 'digits' }], C3, at);
    assert.ok('reasons' in twice);
    assert.match(twice.reasons[0]!, /occurs more than once under anchor "#rounding"/);
    const outside = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#currency', oldText: 'half-up', newText: 'x' }], C3, at);
    assert.ok('reasons' in outside && /occurs nowhere/.test(outside.reasons[0]!), 'text elsewhere in the document does not count');
    const missing = applyContractOps([{ path: repoPath('docs/none.md'), anchor: '#a', oldText: 'a', newText: 'b' }], C3, at);
    assert.ok('reasons' in missing && /no such document/.test(missing.reasons[0]!));

    assert.equal(citeRuling('<!-- revised by C-1 -->\n# X\n', rulingId('C-4')), '<!-- revised by C-1, C-4 -->\n# X\n');
    assert.equal(citeRuling('<!-- revised by C-1, C-4 -->\n# X\n', rulingId('C-4')), '<!-- revised by C-1, C-4 -->\n# X\n');
  });
});



it('plain ledger refuses duplicate ids', () => {assert.throws(() => parseRulings('C-1 — one\nC-1 — two\n', 'ledger'));});
