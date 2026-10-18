// `/statements/<month>`: each team's total for the month against its limit, with a print view.
import { formatMoney, percent } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { monthsOf, teamMonth } from '../../src/report.js';
import { escape, stateTag } from '../html.js';
import { layout } from '../layout.js';
import * as notFound from './not-found.js';

export function get(ctx) {
  const { config, ledger, params } = ctx;
  const month = params[0];
  if (!monthsOf(ledger).includes(month)) return notFound.get(ctx);
  const views = config.teams.map((team) => teamMonth(ledger, team, month));
  const total = views.reduce((a, v) => a + v.total, 0);
  const limits = views.reduce((a, v) => a + v.limit, 0);
  const rows = views.map((v) => `<tr><th scope="row"><a href="/budgets/${v.team.id}">${escape(v.team.name)}</a></th><td class="num">${v.entries.length}</td><td class="num">${formatMoney(v.total, config.currency)}</td><td class="num">${formatMoney(v.limit, config.currency)}</td><td class="num">${percent(v.total, v.limit)}%</td><td>${stateTag(v.state)}</td></tr>`).join('\n      ');
  return {
    status: 200,
    html: layout({
      title: `Statement for ${monthName(month)}`, section: '/statements', body: `    <h1>Statement for ${monthName(month)}</h1>
    <p class="lead{{lead}}">Each team's spend for the month, with the limit that applied.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="Month total">
      <p class="card-figure">${formatMoney(total, config.currency)} spent of ${formatMoney(limits, config.currency)} across ${views.length} teams.</p>
      <p><a class="button button-primary{{primary}}" href="{{print-link}}">Print view</a></p>
    </section>
    <table class="ledger">
      <thead><tr><th scope="col">Team</th><th scope="col" class="num">Entries</th><th scope="col" class="num">Spent</th><th scope="col" class="num">Limit</th><th scope="col" class="num">Used</th><th scope="col">State</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
{{script}}`{{layout}},
    }),
  };
}
