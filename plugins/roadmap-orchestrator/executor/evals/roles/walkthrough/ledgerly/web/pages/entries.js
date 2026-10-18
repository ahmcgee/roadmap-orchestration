// `/entries`: every recorded entry, newest first.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { latestMonth } from '../../src/report.js';
import { entriesTable } from '../html.js';
import { layout } from '../layout.js';

const SHOWN = 50;

export function get({ config, ledger }) {
  const newest = [...ledger.entries].reverse().slice(0, SHOWN);
  const month = latestMonth(ledger);
  const inMonth = ledger.entries.filter((e) => e.month === month);
  const summary = month === null
    ? 'No entries yet.'
    : `${inMonth.length} entries in ${monthName(month)}, ${formatMoney(inMonth.reduce((a, e) => a + e.amount, 0), config.currency)} in all.`;
  return {
    status: 200,
    html: layout({
      title: 'Entries', section: '/entries', body: `    <h1>Entries</h1>
    <p class="lead{{lead}}">Every payment recorded against a team, newest first.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="This month">
      <p class="card-figure">${summary}</p>
      <p><a class="button button-primary{{primary}}" href="/entries/new">Record entry</a></p>
    </section>
    ${entriesTable(newest, config.currency, { empty: 'No entries yet. Record the first one, or import a CSV with <code>ledgerly import</code>.' })}
    ${ledger.entries.length > SHOWN ? `<p class="caption">Showing the newest ${SHOWN} of ${ledger.entries.length}. Older months are in their statements.</p>` : ''}
{{script}}`{{layout}},
    }),
  };
}
