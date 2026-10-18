// The ledger: one JSON file, ledger.json, in the data directory. Every write replaces the file whole (write, then rename),
// so a reader never sees half of one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from './errors.js';

/** The data directory: the --data flag, else $LEDGERLY_DATA, else .ledgerly. */
export const dataDir = (flag) => flag ?? process.env.LEDGERLY_DATA ?? '.ledgerly';

const fileOf = (dir) => join(dir, 'ledger.json');

export const hasLedger = (dir) => existsSync(fileOf(dir));

export function createLedger(dir) {
  mkdirSync(dir, { recursive: true });
  save(dir, { next: 1, entries: [], limits: {}, idempotency: {} });
}

export function openLedger(dir) {
  if (!hasLedger(dir)) throw new InputError(`no ledger in ${dir}; create one with: ledgerly init --data ${dir}`);
  return JSON.parse(readFileSync(fileOf(dir), 'utf8'));
}

export function save(dir, ledger) {
  const tmp = `${fileOf(dir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, fileOf(dir));
}

/** Appends `entries` (checked already) and returns them with their ids. */
export function addEntries(dir, entries) {
  const ledger = openLedger(dir);
  const added = entries.map((e) => ({ id: `e-${String(ledger.next++).padStart(4, '0')}`, ...e }));
  ledger.entries.push(...added);
  save(dir, ledger);
  return added;
}

/** Sets a team's monthly limit (minor units), overriding its budget in ledgerly.conf. */
export function setLimit(dir, team, limit) {
  const ledger = openLedger(dir);
  ledger.limits[team] = limit;
  save(dir, ledger);
}
