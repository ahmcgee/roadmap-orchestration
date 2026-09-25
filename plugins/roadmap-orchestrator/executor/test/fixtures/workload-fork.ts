// argv: <same|setsid> <keep|clear> <exit|hang> <fixture> [args...]. Spawns `node <fixture> args` as a
// descendant: in this session or a new one (setsid), with this environment or an empty one, prints the
// descendant's pid on stdout, then exits 0 or hangs.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [session, env, after, name, ...args] = process.argv.slice(2);
if (name === undefined || !['same', 'setsid'].includes(session ?? '') || !['keep', 'clear'].includes(env ?? '') || !['exit', 'hang'].includes(after ?? '')) {
  throw new Error(`usage: workload-fork <same|setsid> <keep|clear> <exit|hang> <fixture> [args...], got ${JSON.stringify(process.argv.slice(2))}`);
}
const script = fileURLToPath(new URL(`./${name}`, import.meta.url));
const child = spawn(process.execPath, [script, ...args], {
  detached: session === 'setsid',
  env: env === 'keep' ? process.env : {},
  stdio: 'ignore',
});
child.unref();
process.stdout.write(`${child.pid}\n`);
if (after === 'hang') setInterval(() => {}, 60_000);
