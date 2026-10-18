// `/entries/<id>`: one entry, and where its team stands that month. `?recorded=1` confirms a new entry.
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { teamMonth } from '../../src/report.js';
import { burn, escape } from '../html.js';
import { layout } from '../layout.js';
import * as notFound from './not-found.js';

export function get(ctx) {
  const { config, ledger, params, query } = ctx;
  const entry = ledger.entries.find((e) => e.id === params[0]);
  if (entry === undefined) return notFound.get(ctx);
  const team = config.teams.find((t) => t.id === entry.team);
  const view = teamMonth(ledger, team, entry.month);
  const notice = query.get('recorded') === '1'
    ? `<p class="notice" role="status">Entry recorded. It counts toward ${escape(team.name)}'s ${monthName(entry.month)} limit.</p>`
    : '';
  return {
    status: 200,
    html: layout({
      title: `Entry ${entry.id}`, section: '/entries', body: `    ${notice}
    <h1>Entry ${entry.id}</h1>
    <p class="lead{{lead}}">${escape(entry.vendor)}, recorded against ${escape(team.name)} for ${monthName(entry.month)}.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="Entry">
      <dl class="facts">
        <div><dt>Amount</dt><dd class="figure">${formatMoney(entry.amount, config.currency)}</dd></div>
        <div><dt>Team</dt><dd><a href="/budgets/${team.id}">${escape(team.name)}</a></dd></div>
        <div><dt>Month</dt><dd>${monthName(entry.month)}</dd></div>
        <div><dt>Vendor</dt><dd>${escape(entry.vendor)}</dd></div>
        <div><dt>Note</dt><dd>${entry.note === '' ? 'None' : escape(entry.note)}</dd></div>
      </dl>
    </section>
    <h2>${escape(team.name)} in ${monthName(entry.month)}</h2>
    ${burn(view, config.currency)}
    <div class="actions">
      <a class="button button-primary{{primary}}" href="/entries/new">Record another entry</a>
      <a class="button button-quiet" href="/entries">Back to entries</a>
    </div>
{{script}}`{{layout}},
    }),
  };
}
