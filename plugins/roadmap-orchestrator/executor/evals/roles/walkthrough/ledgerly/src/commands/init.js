// `ledgerly init`: create an empty ledger. Safe to re-run: an existing ledger is kept unless --force.
import { parseOptions } from '../args.js';
import { UsageError } from '../errors.js';
import { createLedger, dataDir, hasLedger } from '../ledger.js';

export const HELP = `Create an empty ledger in a data directory.

Example:
  ledgerly init --data .ledgerly

Options:
  --data <dir>   Where to keep the ledger (default: $LEDGERLY_DATA, else .ledgerly)
  --force        Replace an existing ledger with an empty one`;

export function run(argv, io) {
  const { options, positionals } = parseOptions(argv, { data: 'value', force: 'flag', help: 'flag' }, 'init');
  if (options.help) {
    io.out(HELP);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`init takes no arguments, got "${positionals[0]}"; pass the directory as --data <dir>`);
  const dir = dataDir(options.data);
  if (hasLedger(dir) && !options.force) {
    io.out(`A ledger already exists in ${dir}; nothing changed. Use --force to replace it with an empty one.`);
    return 0;
  }
  createLedger(dir);
  io.out(`Created an empty ledger in ${dir}.\nNext: ledgerly import <file.csv> --data ${dir}`);
  return 0;
}
