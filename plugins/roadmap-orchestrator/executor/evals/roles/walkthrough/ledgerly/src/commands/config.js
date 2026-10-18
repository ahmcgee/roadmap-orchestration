// `ledgerly config check`: read ledgerly.conf the way every other command does and say what it found.
import { parseOptions } from '../args.js';
import { CONFIG_FILE, loadConfig } from '../config.js';
import { UsageError } from '../errors.js';

export const HELP = `Check ledgerly.conf for mistakes. Errors exit 3; warnings are printed and the check still passes.

Example:
  ledgerly config check

Options:
  --file <path>  The file to check (default: ledgerly.conf)`;

export function run(argv, io) {
  const { options, positionals } = parseOptions(argv, { file: 'value', help: 'flag' }, 'config');
  if (options.help) {
    io.out(HELP);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== 'check') throw new UsageError('config has one subcommand, check; for example: ledgerly config check');
  const file = options.file ?? CONFIG_FILE;
  const { config, warnings } = loadConfig(file);
  for (const w of warnings) io.err(`warning: ${w}`);
  const teams = config.teams.map((t) => t.id).join(', ');
  io.out(`${file} is valid: ${config.teams.length} ${config.teams.length === 1 ? 'team' : 'teams'} (${teams}), currency ${config.currency}.${warnings.length > 0 ? ` See the ${warnings.length === 1 ? 'warning' : `${warnings.length} warnings`} above.` : ''}`);
  return 0;
}
