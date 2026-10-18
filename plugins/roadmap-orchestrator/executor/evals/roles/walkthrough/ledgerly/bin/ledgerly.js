#!/usr/bin/env node
// The ledgerly CLI: `ledgerly <command> [options]`. Results go to stdout; progress, warnings and errors go to stderr. Exit
// codes: 0 done, 1 a bug in ledgerly, 2 a wrong command line, 3 a wrong file or value (design/cli.md).
import { closest } from '../src/closest.js';
import { InputError, UsageError } from '../src/errors.js';
import * as config from '../src/commands/config.js';
import * as importCommand from '../src/commands/import.js';
import * as init from '../src/commands/init.js';
import * as report from '../src/commands/report.js';

const COMMANDS = { init, import: importCommand, report, config };

const USAGE = `Record team spend and check it against monthly budgets.

Examples:
  ledgerly init --data .ledgerly
  ledgerly import samples/2026-09.csv --data .ledgerly
  ledgerly report --team platform --month 2026-09 --json
  ledgerly config check

Commands:
  init      Create an empty ledger in a data directory
  import    Add the entries of a CSV file to the ledger
  report    Show a team's spend for a month against its limit
  config    Check ledgerly.conf for mistakes

Options:
  --data <dir>   The data directory (default: $LEDGERLY_DATA, else .ledgerly)
  --help         Show help for ledgerly, or for a command after its name
  --version      Print the version

Run "ledgerly <command> --help" for a command's options.`;

const io = { out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`) };

function main(argv) {
  if (argv[0] === '--help' || argv[0] === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (argv[0] === '--version') {
    io.out('ledgerly 0.4.0');
    return 0;
  }
{{dispatch}}
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    io.err(`ledgerly: ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof InputError) {
    io.err(`ledgerly: ${e.message}`);
    process.exitCode = 3;
  } else {
    throw e;
  }
}
