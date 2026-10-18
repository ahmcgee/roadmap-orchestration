// `/budgets/<team>`: one team's month against its limit, and the entries behind it. `?saved=1` confirms a new limit.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { latestMonth, teamMonth } from '../../src/report.js';
import { burn, entriesTable, escape } from '../html.js';
import { layout } from '../layout.js';
import * as notFound from './not-found.js';

export function get(ctx) {
  const { config, ledger, params, query } = ctx;
  const team = config.teams.find((t) => t.id === params[0]);
  if (team === undefined) return notFound.get(ctx);
  const month = latestMonth(ledger);
  const view = month === null ? null : teamMonth(ledger, team, month);
  const limit = view === null ? team.budget : view.limit;
  const notice = query.get('saved') === '1'
    ? `<p class="notice" role="status">Limit saved. ${escape(team.name)}'s monthly limit is now ${formatMoney(limit, config.currency)}.</p>`
    : '';
  return {
    status: 200,
    html: layout({
      title: `${team.name} budget`, section: '/budgets', body: `    ${notice}
    <h1>${escape(team.name)} budget</h1>
    <p class="lead{{lead}}">${view === null ? 'Nothing recorded yet.' : `${monthName(month)}: ${formatMoney(view.total, config.currency)} spent of a ${formatMoney(limit, config.currency)} limit.`} The team turns amber at ${Math.round(team.alertAt * 100)}% of its limit.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="This month">
      ${view === null ? `<p class="card-figure">Limit: ${formatMoney(limit, config.currency)}</p>` : burn(view, config.currency)}
      <p><a class="button button-primary{{primary}}" href="/budgets/${team.id}/edit">Change limit</a></p>
    </section>
    <h2>Entries${month === null ? '' : ` in ${monthName(month)}`}</h2>
    ${entriesTable(view === null ? [] : view.entries, config.currency, { team: false, empty: `No entries for ${escape(team.name)} this month.` })}
{{script}}`{{layout}},
    }),
  };
}
