// `/`: where every team stands this month.
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
    <p><a class="button button-primary" href="/entries/new">Record entry</a></p>`,
      }),
    };
  }
  const rows = config.teams.map((team) => {
    const view = teamMonth(ledger, team, month);
    return `<li class="team-row">
      <h2 class="team-name"><a href="/budgets/${team.id}">${escape(team.name)}</a></h2>
      ${burn(view, config.currency)}
    </li>`;
  }).join('\n    ');
  return {
    status: 200,
    html: layout({
      title: 'Overview', section: '/', body: `    <h1>${monthName(month)}</h1>
    <p class="lead">Where each team stands against its monthly limit.</p>
    <ul class="team-list">
    ${rows}
    </ul>
    <p><a class="button button-primary" href="/entries/new">Record entry</a></p>`,
    }),
  };
}
