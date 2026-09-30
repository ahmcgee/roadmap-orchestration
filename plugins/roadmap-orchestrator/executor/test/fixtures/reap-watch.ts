// The watchdog of a test process's supervised runs (helpers/reap.ts): argv <pid> <start> <registry>. Waits,
// detached, until that process is gone, however it ended, then SIGKILLs every process of every scope named
// in the registry (one JSON array of paths per line) and removes the registry. After a clean end the file's
// own teardown has already killed them all, and it finds nothing.
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive } from '../../src/contain/proc.ts';
import { killAll } from '../helpers/reap.ts';

const [pid, start, registry] = process.argv.slice(2);
if (pid === undefined || start === undefined || registry === undefined) throw new Error(`usage: reap-watch <pid> <start> <registry>, got ${JSON.stringify(process.argv.slice(2))}`);

const owner = { pid: Number(pid), start: Number(start) };
while (isAlive(owner)) await sleep(200);
const scopes = readFileSync(registry, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]);
for (const paths of scopes) await killAll(paths);
rmSync(dirname(registry), { recursive: true });
