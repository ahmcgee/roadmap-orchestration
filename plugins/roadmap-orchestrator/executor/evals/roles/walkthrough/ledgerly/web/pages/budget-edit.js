// `/budgets/<team>/edit`: change a team's monthly limit. POST `/budgets/<team>/limit` saves it.
import { setLimit } from '../../src/ledger.js';
import { formatMoney } from '../../src/money.js';
import { limitOf } from '../../src/report.js';
import { checkLimit } from '../../src/validate.js';
import { escape } from '../html.js';
import { errorSummary, field } from '../forms.js';
import { layout } from '../layout.js';
import * as notFound from './not-found.js';

function page({ config, ledger }, team, value, errors) {
  const shown = {{shown-errors}};
  const limit = limitOf(ledger, team);
  return layout({
    title: `Change ${team.name}'s limit`, section: '/budgets', body: `    <h1>Change ${escape(team.name)}'s monthly limit</h1>
    <p class="lead{{lead}}">The new limit applies to every month, this one included. ledgerly.conf sets the starting value, ${formatMoney(team.budget, config.currency)}.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="Current limit">
      <p class="card-figure">Current limit: ${formatMoney(limit, config.currency)} a month</p>
    </section>
    ${errorSummary(shown, 'save this limit')}
    <form class="form" method="post" action="{{action}}" novalidate>
    ${field({ name: 'limit', label: `New monthly limit (${config.currency})`, hint: 'A whole amount without the currency sign, like 5000.', value, errors: shown, attrs: ' inputmode="numeric"' })}
      <div class="actions">
        <button class="button button-primary{{primary}}" type="submit">Save limit</button>
        <a class="button button-quiet" href="/budgets/${team.id}">Cancel</a>
      </div>
    </form>
{{script}}`{{layout}},
  });
}

const teamOf = ({ config, params }) => config.teams.find((t) => t.id === params[0]);

export function get(ctx) {
  const team = teamOf(ctx);
  if (team === undefined) return notFound.get(ctx);
  return { status: 200, html: page(ctx, team, String(limitOf(ctx.ledger, team) / 100), []) };
}

export function post(ctx) {
  const team = teamOf(ctx);
  if (team === undefined) return notFound.get(ctx);
  const checked = checkLimit(ctx.form.limit);
  if (!checked.ok) return { status: 422, html: page(ctx, team, ctx.form.limit ?? '', checked.errors) };
  setLimit(ctx.dir, team.id, checked.limit);
  return { status: 303, location: `/budgets/${team.id}?saved=1` };
}
