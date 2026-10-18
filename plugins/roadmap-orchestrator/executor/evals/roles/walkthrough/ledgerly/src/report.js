// A team's month against its limit: what the dashboard, `ledgerly report` and the statements all show.

/** The limit that applies to `team`: the ledger's override (set from the dashboard), else its budget in ledgerly.conf. */
export const limitOf = (ledger, team) => ledger.limits[team.id] ?? team.budget;

/** `within`, `near` (at or past the team's alert share) or `over` the limit. */
export function stateOf(total, limit, alertAt) {
  if (total > limit) return 'over';
  if (total >= limit * alertAt) return 'near';
  return 'within';
}

export function teamMonth(ledger, team, month) {
  const entries = ledger.entries.filter((e) => e.team === team.id && e.month === month);
  const total = entries.reduce((a, e) => a + e.amount, 0);
  const limit = limitOf(ledger, team);
  return { team, month, entries, total, limit, state: stateOf(total, limit, team.alertAt) };
}

/** Every month with an entry, newest first. */
export const monthsOf = (ledger) => [...new Set(ledger.entries.map((e) => e.month))].sort().reverse();

/** The newest month with an entry; null for an empty ledger. */
export const latestMonth = (ledger) => monthsOf(ledger)[0] ?? null;

export const STATE_WORDS = { within: 'Within the limit', near: 'Near the limit', over: 'Over the limit' };
