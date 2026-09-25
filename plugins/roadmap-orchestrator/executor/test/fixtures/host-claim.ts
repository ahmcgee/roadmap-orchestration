// argv: <hostDir> <arc> <dir> <name>. A would-be supervisor: claims the host as itself and holds on.
//   1. writes <dir>/<name>.ready, then waits for <dir>/go (so racers start together);
//   2. runs claimHost (a previous arc is always reported reconciled) and writes the outcome to
//      <dir>/<name>.result.json;
//   3. stays alive until <dir>/exit exists, so a won claim stays live while the other racers look at it.
// Every wait times out loudly. With ROADMAP_TEST_CRASH set it may die at a host crashPoint instead.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arcId } from '../../src/core/ids.ts';
import { claimHost } from '../../src/host/lock.ts';
import { selfIdentity } from '../../src/host/liveness.ts';
import { absPath } from '../../src/core/values.ts';

const [hostDir, arc, dir, name] = process.argv.slice(2);
if (hostDir === undefined || arc === undefined || dir === undefined || name === undefined) {
  throw new Error(`usage: host-claim <hostDir> <arc> <dir> <name>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const TIMEOUT_MS = 30_000;

async function until(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`host-claim ${name}: ${path} did not appear within ${TIMEOUT_MS} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

writeFileSync(join(dir, `${name}.ready`), '');
await until(join(dir, 'go'));
const outcome = await claimHost(
  absPath(hostDir),
  { arc: arcId(arc), runDir: absPath(join(dir, 'run', name)), repo: absPath(join(dir, 'repo')), supervisor: selfIdentity() },
  async () => ({ kind: 'reconciled' }),
);
writeFileSync(join(dir, `${name}.result.json`), JSON.stringify(outcome));
await until(join(dir, 'exit'));
