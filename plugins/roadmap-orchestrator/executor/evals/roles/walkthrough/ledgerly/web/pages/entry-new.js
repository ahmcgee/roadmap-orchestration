// `/entries/new`: record one entry. POST `/entries` checks it; a refused form comes back with what was typed.
import { addEntries } from '../../src/ledger.js';
import { formatMoney } from '../../src/money.js';
import { monthName } from '../../src/month.js';
import { latestMonth } from '../../src/report.js';
import { checkEntry } from '../../src/validate.js';
import { errorSummary, field } from '../forms.js';
import { layout } from '../layout.js';

function page({ config, ledger }, values, errors) {
  const month = latestMonth(ledger);
  const inMonth = ledger.entries.filter((e) => e.month === month);
  const shown = {{shown-errors}};
  const teams = config.teams.map((t) => [t.id, t.name]);
  return layout({
    title: 'Record an entry', section: '/entries', body: `    <h1>Record an entry</h1>
    <p class="lead{{lead}}">Add one payment to a team's ledger. It counts toward that month's limit straight away.</p>
{{after-lead}}
    <section class="card{{card}}" aria-label="This month so far">
      <p class="card-figure">${month === null ? 'Nothing recorded yet.' : `${monthName(month)} so far: ${formatMoney(inMonth.reduce((a, e) => a + e.amount, 0), config.currency)} across ${inMonth.length} entries.`}</p>
    </section>
    ${errorSummary(shown, 'record this entry')}
    <form class="form" method="post" action="{{action}}" novalidate>
    ${field({ name: 'team', label: 'Team', control: 'select', options: teams, value: values.team ?? teams[0][0], errors: shown })}
    ${field({ name: 'month', label: 'Month', hint: 'The month the payment belongs to.', type: 'month', value: values.month ?? month ?? '', errors: shown })}
    ${field({ name: 'vendor', label: 'Vendor', hint: 'Who was paid, for example Hetzner.', value: values.vendor ?? '', errors: shown, attrs: ' autocomplete="off"' })}
    ${field({ name: 'amount', label: `Amount (${config.currency})`, hint: 'Without the currency sign, like 120.50.', value: values.amount ?? '', errors: shown, attrs: ' inputmode="decimal"' })}
    ${field({ name: 'note', label: 'Note (optional)', value: values.note ?? '', errors: shown, control: 'textarea' })}
      <div class="actions">
        <button class="button button-primary{{primary}}" type="submit">Record entry</button>
        <a class="button button-quiet" href="/entries">Cancel</a>
      </div>
    </form>
{{script}}`{{layout}},
  });
}

export function get(ctx) {
  return { status: 200, html: page(ctx, {}, []) };
}

export function post(ctx) {
  const checked = checkEntry(ctx.form, ctx.config);
  if (!checked.ok) return { status: 422, html: page(ctx, ctx.form, checked.errors) };
  const [entry] = addEntries(ctx.dir, [checked.entry]);
  return { status: 303, location: `/entries/${entry.id}?recorded=1` };
}
