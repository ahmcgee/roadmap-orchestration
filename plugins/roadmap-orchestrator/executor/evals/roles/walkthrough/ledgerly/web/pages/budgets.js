// `/budgets`: every team's monthly limit and where it stands.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { latestMonth, limitOf, teamMonth } from '../../src/report.js';
import { burn, escape } from '../html.js';
import { layout } from '../layout.js';

export function get({ config, ledger }) {
  const month = latestMonth(ledger);
  const views = month === null ? [] : config.teams.map((team) => teamMonth(ledger, team, month));
  const spent = views.reduce((a, v) => a + v.total, 0);
  const limits = views.reduce((a, v) => a + v.limit, 0);
  // An empty ledger still lists every team with its limit, so a limit can be set before anything is recorded.
  const rows = month === null
    ? config.teams.map((team) => `<li class="team-row">
      <h2 class="team-name"><a href="/budgets/${team.id}">${escape(team.name)}</a></h2>
      <p>Limit: <span class="figure">${formatMoney(limitOf(ledger, team), config.currency)}</span> a month. <a href="/budgets/${team.id}/edit">Change limit</a></p>
    </li>`).join('\n    ')
    : views.map((view) => `<li class="team-row">
      <h2 class="team-name"><a href="/budgets/${view.team.id}">${escape(view.team.name)}</a></h2>
      ${burn(view, config.currency)}
    </li>`).join('\n    ');
  return {
    status: 200,
    html: layout({
      title: 'Budgets', section: '/budgets', body: `    <h1>Budgets</h1>
    <p class="lead{{lead}}">Each team's monthly limit${month === null ? '' : ` for ${monthName(month)}`}. A team turns amber at its alert level and red past its limit.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="All teams">
      ${month === null
        ? `<p class="card-figure">No spend recorded yet: ${config.teams.length} teams, nothing against their limits.</p>
      <p>Record the first entry, or import a CSV with <code>ledgerly import</code>. Each team's limit can be set below first.</p>
      <p><a class="button button-primary" href="/entries/new">Record entry</a></p>`
        : `<p class="card-figure">${config.teams.length} teams: ${formatMoney(spent, config.currency)} spent of ${formatMoney(limits, config.currency)} in all.</p>`}
    </section>
    <ul class="team-list">
    ${rows}
    </ul>
{{script}}`{{layout}},
    }),
  };
}
