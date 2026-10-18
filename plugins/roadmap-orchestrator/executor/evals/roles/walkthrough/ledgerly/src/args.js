// Command-line options: `--name value` and `--flag`, checked against what a command accepts.
import { UsageError } from './errors.js';

const EXAMPLES = { data: '.ledgerly', team: 'platform', month: '2026-09', file: 'ledgerly.conf' };

/** `spec` maps each option name to 'value' or 'flag'; returns the options given and the positional arguments in order. */
export function parseOptions(argv, spec, command) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!Object.hasOwn(spec, name)) {
      throw new UsageError(`unknown option ${a} for "${command}"; its options are ${Object.keys(spec).map((k) => `--${k}`).join(', ')}`);
    }
    if (spec[name] === 'flag') {
      options[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value, for example ${a} ${EXAMPLES[name] ?? '<value>'}`);
    options[name] = value;
    i += 1;
  }
  return { options, positionals };
}
