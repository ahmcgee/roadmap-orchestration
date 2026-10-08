// PATH shims for the fake backends. Each test writes `bin/codex` and `bin/claude` that exec the fake with
// an absolute scenario path embedded in the script (R22), so the runner's exact environment needs nothing
// extra: no env var carries the scenario. Node is named by its absolute path so a cleared PATH still works.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_BACKEND = fileURLToPath(new URL('./fake-entry.ts', import.meta.url));
export const FAKE_GH = fileURLToPath(new URL('./gh-entry.ts', import.meta.url));

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function writeShims(binDir: string, scenarioPath: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude'] as const) {
    const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_BACKEND)} --scenario ${quote(scenarioPath)} --as ${name} "$@"\n`;
    writeFileSync(join(binDir, name), script, { mode: 0o755, flag: 'wx' });
  }
}

/** `bin/gh`, which execs the fake `gh` over the forge store at `storePath` (test/fakes/gh-store.ts). */
export function writeGhShim(binDir: string, storePath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_GH)} --store ${quote(storePath)} "$@"\n`;
  writeFileSync(join(binDir, 'gh'), script, { mode: 0o755, flag: 'wx' });
}
