// HTML building blocks shared by every page (design/DESIGN.md, "Components").
import { formatMoney, percent } from '../src/money.js';
import { STATE_WORDS } from '../src/report.js';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe for HTML content and attribute values. */
export const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** The state as words, never colour alone. */
export const stateTag = (state) => `<span class="state state--${state}">${STATE_WORDS[state]}</span>`;

/**
 * The burn bar: spent against the limit as one thick stroke, a tick at the team's alert share, the remaining amount at
 * the end in tabular figures. Over the limit, the stroke runs past the frame.
 */
export function burn(view, currency) {
  const pct = percent(view.total, view.limit);
  const left = view.limit - view.total;
  const label = `${formatMoney(view.total, currency)} spent of ${formatMoney(view.limit, currency)}, ${pct}%. ${STATE_WORDS[view.state]}.`;
  return `<div class="burn burn--${view.state}">
  <div class="burn-track" role="img" aria-label="${escape(label)}">
    <span class="burn-spent" style="--pct: ${Math.min(pct, 112)}%"></span>
    <span class="burn-alert" style="--at: ${Math.round(view.team.alertAt * 100)}%"></span>
  </div>
  <p class="burn-figures"><span class="figure">${formatMoney(view.total, currency)}</span> of <span class="figure">${formatMoney(view.limit, currency)}</span>
    <span class="burn-left">${left >= 0 ? `${formatMoney(left, currency)} left` : `${formatMoney(-left, currency)} over`}</span> ${stateTag(view.state)}</p>
</div>`;
}

/** An entries table; `empty` is what the table says when there is nothing to show. */
export function entriesTable(entries, currency, { team = true, empty }) {
  if (entries.length === 0) return `<p class="empty">${empty}</p>`;
  const rows = entries.map((e) => `<tr><td><a href="/entries/${e.id}">${e.id}</a></td><td>${escape(e.month)}</td>${team ? `<td>${escape(e.team)}</td>` : ''}<td>${escape(e.vendor)}</td><td class="num">${formatMoney(e.amount, currency)}</td><td>${escape(e.note)}</td></tr>`).join('\n');
  return `<table class="ledger">
  <thead><tr><th scope="col">Entry</th><th scope="col">Month</th>${team ? '<th scope="col">Team</th>' : ''}<th scope="col">Vendor</th><th scope="col" class="num">Amount</th><th scope="col">Note</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}
