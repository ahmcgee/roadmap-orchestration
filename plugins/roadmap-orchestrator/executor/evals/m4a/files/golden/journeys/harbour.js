// The journeys' harness: the tidewater command run as a skipper would, against a fresh ledger and outbox.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** A fresh harbour: `run(args, now?)` runs the command; `outbox()` is every text written so far. */
export function harbour() {
  const dir = mkdtempSync(join(tmpdir(), 'tidewater-journey-'));
  const env = { ...process.env, TIDEWATER_DATA: join(dir, 'ledger.json'), TIDEWATER_OUTBOX: join(dir, 'outbox.txt') };
  delete env.TIDEWATER_NOW;
  return {
    run: (args, now) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: now === undefined ? env : { ...env, TIDEWATER_NOW: now } }),
    outbox: () => (existsSync(env.TIDEWATER_OUTBOX) ? readFileSync(env.TIDEWATER_OUTBOX, 'utf8') : ''),
  };
}
