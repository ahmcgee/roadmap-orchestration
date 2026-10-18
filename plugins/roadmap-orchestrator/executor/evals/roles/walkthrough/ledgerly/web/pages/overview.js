// `/`: where every team stands this month.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { latestMonth, teamMonth } from '../../src/report.js';
import { burn, escape } from '../html.js';
import { layout } from '../layout.js';

export function get({ config, ledger }) {
  const month = latestMonth(ledger);
  if (month === null) {
    return {
      status: 200,
      html: layout({
        title: 'Overview', section: '/', body: `    <h1>Nothing recorded yet</h1>
    <p class="lead">Record the first entry here, or import a month with <code>ledgerly import</code>.</p>
    <section class="card" aria-label="This month">
      <p class="card-figure">No spend recorded yet.</p>
      <p><a class="button button-primary" href="/entries/new">Record entry</a></p>
    </section>`,
      }),
    };
  }
  const views = config.teams.map((team) => teamMonth(ledger, team, month));
  const spent = views.reduce((a, v) => a + v.total, 0);
  const limits = views.reduce((a, v) => a + v.limit, 0);
  const rows = views.map((view) => `<li class="team-row">
      <h2 class="team-name"><a href="/budgets/${view.team.id}">${escape(view.team.name)}</a></h2>
      ${burn(view, config.currency)}
    </li>`).join('\n    ');
  return {
    status: 200,
    html: layout({
      title: 'Overview', section: '/', body: `    <h1>${monthName(month)}</h1>
    <p class="lead">Where each team stands against its monthly limit.</p>
    <section class="card" aria-label="This month">
      <p class="card-figure">${formatMoney(spent, config.currency)} spent of ${formatMoney(limits, config.currency)} across ${views.length} teams.</p>
      <p><a class="button button-primary" href="/entries/new">Record entry</a></p>
    </section>
    <ul class="team-list">
    ${rows}
    </ul>`,
    }),
  };
}
