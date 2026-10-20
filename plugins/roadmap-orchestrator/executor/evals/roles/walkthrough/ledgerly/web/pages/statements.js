// `/statements`: one statement per month with entries, newest first.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { monthsOf } from '../../src/report.js';
import { layout } from '../layout.js';

export function get({ config, ledger }) {
  const months = monthsOf(ledger);
  const totalOf = (m) => ledger.entries.filter((e) => e.month === m).reduce((a, e) => a + e.amount, 0);
  const rows = months.map((m) => `<tr><th scope="row"><a href="/statements/${m}">${monthName(m)}</a></th><td class="num">${formatMoney(totalOf(m), config.currency)}</td></tr>`).join('\n      ');
  const latest = months[0] ?? null;
  return {
    status: 200,
    html: layout({
      title: 'Statements', section: '/statements', body: `    <h1>Statements</h1>
    <p class="lead{{lead}}">One statement per month, with each team's total against the limit that applied.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="Latest statement">
      ${latest === null
        ? '<p class="card-figure">No statements yet: they appear once a month has entries.</p>'
        : `<p class="card-figure">Latest: ${monthName(latest)}, ${formatMoney(totalOf(latest), config.currency)} across ${config.teams.length} teams.</p>
      <p><a class="button button-primary{{primary}}" href="/statements/${latest}">Open ${monthName(latest)}</a></p>`}
    </section>
    <table class="ledger">
      <thead><tr><th scope="col">Month</th><th scope="col" class="num">Total</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
{{script}}`{{layout}},
    }),
  };
}
