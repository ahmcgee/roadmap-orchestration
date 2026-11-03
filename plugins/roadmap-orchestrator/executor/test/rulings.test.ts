import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { anchorSection,headingSlug } from '../src/docs/contracts.ts';
import { parseRulings } from '../src/spec/rulings.ts';
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
describe('document references', () => {
  it('contracts.anchor-exact: document references name exactly one heading or line, bounded by section', () => {
    assert.equal(headingSlug(' Rounding & Display! '), 'rounding--display');
    const s = anchorSection(MONEY, '#rounding');
    assert.ok(typeof s !== 'string');
    assert.equal(MONEY.slice(s.start, s.end), '## Rounding\n\nTotals round half-up at the cent.\nRates keep four places.\n\n### Display\n\nAmounts show two places.\n\n');
    assert.match(anchorSection(MONEY, 'places') as string, /matches 2 lines/);
    const line = anchorSection(MONEY, 'Rates keep');
    assert.ok(typeof line !== 'string');
    assert.equal(MONEY.slice(line.start, line.end), 'Rates keep four places.\n\n', 'a line anchor runs to the next heading');

    const currency = anchorSection(MONEY, '#currency');
    assert.ok(typeof currency !== 'string');
    assert.ok(!MONEY.slice(currency.start, currency.end).includes('half-up'), 'references stay in their named section');
    assert.match(anchorSection(MONEY, '#missing') as string, /matches 0 headings/);
    assert.match(anchorSection(MONEY + '\n## Rounding\n', '#rounding') as string, /matches 2 headings/);
  });
});



it('plain ledger refuses duplicate ids', () => {assert.throws(() => parseRulings('C-1 — one\nC-1 — two\n', 'ledger'));});
