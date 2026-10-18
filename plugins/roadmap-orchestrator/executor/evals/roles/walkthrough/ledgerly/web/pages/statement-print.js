// `/statements/<month>/print`: the month's statement as a plain print view (design/DESIGN.md, "Print views").
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { monthsOf, teamMonth, STATE_WORDS } from '../../src/report.js';
import { escape } from '../html.js';
import { printLayout } from '../layout.js';
import * as notFound from './not-found.js';

export function get(ctx) {
  const { config, ledger, params } = ctx;
  const month = params[0];
  if (!monthsOf(ledger).includes(month)) return notFound.get(ctx);
  const views = config.teams.map((team) => teamMonth(ledger, team, month));
  const total = views.reduce((a, v) => a + v.total, 0);
  const sections = views.map((v) => {
    const lines = v.entries.map((e) => `<tr><td>${e.id}</td><td>${escape(e.vendor)}</td><td>${escape(e.note)}</td><td class="num">${formatMoney(e.amount, config.currency)}</td></tr>`).join('\n        ');
    return `<section>
    <h2>${escape(v.team.name)}</h2>
    <table>
      <thead><tr><th scope="col">Entry</th><th scope="col">Vendor</th><th scope="col">Note</th><th scope="col" class="num">Amount</th></tr></thead>
      <tbody>
        ${lines}
      </tbody>
      <tfoot><tr><th scope="row" colspan="3">Total, against a limit of ${formatMoney(v.limit, config.currency)} (${STATE_WORDS[v.state].toLowerCase()})</th><td class="num">${formatMoney(v.total, config.currency)}</td></tr></tfoot>
    </table>
  </section>`;
  }).join('\n  ');
  return {
    status: 200,
    html: printLayout({
      title: `Statement for ${monthName(month)}, print view`, body: `  <h1>ledgerly statement, ${monthName(month)}</h1>
  <p>${formatMoney(total, config.currency)} across ${views.length} teams. Use your browser's print command to print it or save it as a PDF.</p>
  ${sections}
  <p><a href="/statements/${month}">Back to the statement</a></p>`,
    }),
  };
}
