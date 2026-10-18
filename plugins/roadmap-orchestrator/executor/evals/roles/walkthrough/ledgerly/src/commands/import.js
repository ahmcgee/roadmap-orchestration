// `ledgerly import <file.csv>`: add a CSV file's entries to the ledger, all or nothing.
import { readFileSync } from 'node:fs';
import { parseOptions } from '../args.js';
import { loadConfig } from '../config.js';
import { parseCsv } from '../csv.js';
import { InputError, UsageError } from '../errors.js';
import { addEntries, dataDir, openLedger } from '../ledger.js';
import { formatMoney } from '../money.js';
import { checkEntry } from '../validate.js';

export const HELP = `Add the entries of a CSV file to the ledger. Nothing is added unless every row is valid.

Example:
  ledgerly import samples/2026-09.csv --data .ledgerly

The file starts with the header team,month,vendor,amount,note (design/cli.md).

Options:
  --data <dir>   The data directory (default: $LEDGERLY_DATA, else .ledgerly)
  --dry-run      Check the file and say what would be added, without adding it`;

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new InputError(`no file ${path}; check the path, relative to ${process.cwd()}`);
    throw e;
  }
}

export function run(argv, io) {
  const { options, positionals } = parseOptions(argv, { data: 'value', 'dry-run': 'flag', help: 'flag' }, 'import');
  if (options.help) {
    io.out(HELP);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('import takes one CSV file, for example: ledgerly import samples/2026-09.csv');
  const [path] = positionals;
  const dir = dataDir(options.data);
  try {
{{progress-start}}
    const { config, warnings } = loadConfig();
    for (const w of warnings) io.err(`warning: ${w}`);
    const rows = parseCsv(readText(path), path);
    const entries = rows.map((row) => {
      const checked = checkEntry(row, config);
      if (!checked.ok) throw new InputError(`${path}:${row.line}: ${checked.errors.map((e) => e.message).join(' ')} Nothing was imported.`);
      return checked.entry;
    });
{{progress-checked}}
    const total = formatMoney(entries.reduce((a, e) => a + e.amount, 0), config.currency);
    if (options['dry-run']) {
      io.out(`Would add ${entries.length} entries (${total}) to the ledger in ${dir}. Nothing was added.`);
      return 0;
    }
    openLedger(dir);
    const added = addEntries(dir, entries);
    io.out(`Added ${added.length} entries (${total}) to the ledger in ${dir}: ${added[0].id} to ${added.at(-1).id}.`);
    return 0;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
{{input-error}}
  }
}
