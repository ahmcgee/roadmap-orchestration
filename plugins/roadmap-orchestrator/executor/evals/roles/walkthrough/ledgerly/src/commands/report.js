// `ledgerly report --team <id>`: a team's spend for a month against its limit, as a table or (--json) for scripts.
import { parseOptions } from '../args.js';
import { loadConfig } from '../config.js';
import { InputError, UsageError } from '../errors.js';
import { dataDir, openLedger } from '../ledger.js';
import { formatMoney, percent, plainAmount } from '../money.js';
import { isMonth, monthName } from '../month.js';
import { STATE_WORDS, latestMonth, teamMonth } from '../report.js';

export const HELP = `Show a team's spend for a month against its limit.

Examples:
  ledgerly report --team platform --month 2026-09
  ledgerly report --team platform --json

Options:
  --team <id>        A team from ledgerly.conf (required)
  --month <YYYY-MM>  The month (default: the latest month in the ledger)
  --json             Print JSON for scripts (design/cli.md, "report --json")
  --data <dir>       The data directory (default: $LEDGERLY_DATA, else .ledgerly)`;

function table(view, currency) {
  const rows = view.entries.map((e) => `  ${e.id}  ${e.vendor.padEnd(18)} ${formatMoney(e.amount, currency).padStart(12)}  ${e.note}`);
  return [
    `${view.team.name}, ${monthName(view.month)}`,
    ...(rows.length > 0 ? rows : ['  No entries this month.']),
    `  Total: ${formatMoney(view.total, currency)} of ${formatMoney(view.limit, currency)} (${percent(view.total, view.limit)}%). ${STATE_WORDS[view.state]}.`,
  ].join('\n');
}

function json(view, currency) {
  return JSON.stringify({
    team: view.team.id, month: view.month, currency, total: plainAmount(view.total), limit: plainAmount(view.limit), state: view.state,
    entries: view.entries.map((e) => ({ id: e.id, vendor: e.vendor, amount: plainAmount(e.amount), note: e.note })),
  }, null, 2);
}

export function run(argv, io) {
  const { options, positionals } = parseOptions(argv, { team: 'value', month: 'value', json: 'flag', data: 'value', help: 'flag' }, 'report');
  if (options.help) {
    io.out(HELP);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`report takes options only, got "${positionals[0]}"; for example: ledgerly report --team platform`);
  if (options.team === undefined) throw new UsageError('report needs --team <id>, for example: ledgerly report --team platform');
  const dir = dataDir(options.data);
  try {
{{progress-start}}
    const { config, warnings } = loadConfig();
    for (const w of warnings) io.err(`warning: ${w}`);
    const team = config.teams.find((t) => t.id === options.team);
    if (team === undefined) throw new InputError(`no team "${options.team}" in ledgerly.conf; the teams are ${config.teams.map((t) => t.id).join(', ')}`);
    const ledger = openLedger(dir);
    const month = options.month ?? latestMonth(ledger);
    if (month === null) throw new InputError(`the ledger in ${dir} has no entries yet; add some with: ledgerly import <file.csv>`);
    if (!isMonth(month)) throw new InputError(`--month must look like 2026-09, got "${month}"`);
    const view = teamMonth(ledger, team, month);
{{progress-checked}}
    io.out(options.json ? json(view, config.currency) : table(view, config.currency));
    return 0;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
{{input-error}}
  }
}
