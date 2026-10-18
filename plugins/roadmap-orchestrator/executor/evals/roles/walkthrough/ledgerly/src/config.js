// ledgerly.conf: `key = value` lines, `[team.<id>]` sections and `#` comments (design/config.md). Every error names the
// file, the line, the key and the fix.
import { readFileSync } from 'node:fs';
import { closest } from './closest.js';
import { InputError } from './errors.js';

export const CONFIG_FILE = 'ledgerly.conf';
const TOP_KEYS = ['currency'];
const TEAM_KEYS = ['name', 'budget', 'alert_at'];
export const CURRENCIES = ['EUR', 'USD', 'GBP'];
const DEFAULT_ALERT_AT = 0.8;

/** The configuration in `text` (read from `file`) and its warnings; an InputError at the first mistake. */
export function parseConfig(text, file) {
  const config = { currency: 'EUR', teams: [] };
  const warnings = [];
  let team = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.replace(/#.*$/, '').trim();
    if (t === '') return;
    const section = /^\[team\.([a-z][a-z0-9-]*)\]$/.exec(t);
    if (section !== null) {
      const id = section[1];
      if (config.teams.some((x) => x.id === id)) throw new InputError(`${file}:${line}: team "${id}" is defined twice; keep one [team.${id}] section`);
      team = { id, name: id, budget: null, alertAt: DEFAULT_ALERT_AT, line };
      config.teams.push(team);
      return;
    }
    if (t.startsWith('[')) throw new InputError(`${file}:${line}: unknown section ${t}; a section looks like [team.<id>], for example [team.platform]`);
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (kv === null) throw new InputError(`${file}:${line}: expected "key = value", got "${t}"`);
    const [, key, value] = kv;
    const known = team === null ? TOP_KEYS : TEAM_KEYS;
    if (!known.includes(key)) {
{{unknown-key}}
    }
    if (key === 'currency') {
      if (!CURRENCIES.includes(value)) throw new InputError(`${file}:${line}: currency must be one of ${CURRENCIES.join(', ')}, got "${value}"`);
      config.currency = value;
    } else if (key === 'name') {
      if (value === '') throw new InputError(`${file}:${line}: name is empty; give the team a display name, for example "name = Platform"`);
      team.name = value;
    } else if (key === 'budget') {
      if (!/^\d+$/.test(value) || Number(value) === 0) throw new InputError(`${file}:${line}: budget must be a whole amount above zero without a currency sign, for example "budget = 4000", got "${value}"`);
      team.budget = Number(value) * 100;
    } else if (key === 'alert_at') {
      const x = Number(value);
      if (!(x > 0 && x <= 1)) throw new InputError(`${file}:${line}: alert_at must be a share of the budget between 0 and 1, for example "alert_at = 0.8", got "${value}"`);
      team.alertAt = x;
    }
  });
  if (config.teams.length === 0) throw new InputError(`${file}: no teams; add a [team.<id>] section with a budget`);
  for (const t of config.teams) {
    if (t.budget === null) throw new InputError(`${file}:${t.line}: [team.${t.id}] has no budget; add a line like "budget = 4000" under it`);
  }
  return { config, warnings };
}

/** Reads and parses `path` (default ledgerly.conf in the working directory). */
export function loadConfig(path = CONFIG_FILE) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new InputError(`no ${path} in ${process.cwd()}; run ledgerly from the project root, or pass --file <path>`);
    throw e;
  }
  return parseConfig(text, path);
}
