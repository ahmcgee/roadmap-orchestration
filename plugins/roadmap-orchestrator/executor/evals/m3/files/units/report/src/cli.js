// ledger: node src/cli.js <command> [args...] (.roadmap/contracts/ledger.md, commands).
import { readFileSync } from 'node:fs';
import { formatDisplay } from './display.js';
import { formatAmount, isAmount, sumAmounts } from './format.js';
import { LedgerError, parseLedger } from './parse.js';
import { reconcile } from './report.js';

/** A month as `reconcile` takes it: YYYY-MM. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A command line the ledger refuses: its message goes to stderr, and the exit is 2. */
class UsageError extends Error {}

/** The arguments, each checked to be an amount. */
function amounts(args) {
  for (const a of args) {
    if (!isAmount(a)) throw new UsageError(`not an amount: ${JSON.stringify(a)} (write digits, an optional minus and decimals, e.g. -12.50)`);
  }
  return args;
}

const COMMANDS = {
  format: (args) => {
    if (args.length !== 1) throw new UsageError('usage: format <amount>');
    const [amount] = amounts(args);
    return formatAmount(amount);
  },
  total: (args) => {
    if (args.length === 0) throw new UsageError('usage: total <amount>...');
    return formatDisplay(Number(sumAmounts(amounts(args))));
  },
  reconcile: (args) => {
    if (args.length !== 2) throw new UsageError('usage: reconcile <YYYY-MM> <file>');
    const [month, file] = args;
    if (!MONTH.test(month)) throw new UsageError(`not a month: ${JSON.stringify(month)} (write YYYY-MM, e.g. 2026-09)`);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${error.message}`);
    }
    try {
      return reconcile(parseLedger(text), month);
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      throw new UsageError(`${file}: ${error.message}`);
    }
  },
};

const [name, ...args] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, name ?? '')) {
  process.stderr.write(`ledger: unknown command ${JSON.stringify(name ?? '')}\n`);
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${COMMANDS[name](args)}\n`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`ledger: ${error.message}\n`);
    process.exitCode = 2;
  }
}
