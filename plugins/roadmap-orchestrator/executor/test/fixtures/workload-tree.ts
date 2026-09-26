// argv: <barrier dir> <depth> <level> [--ignore-term]. Level `level` spawns level + 1 (same session, same
// env) until `depth`, then every level parks at barrier `level-<n>` (its .reached file holds its pid).
// With --ignore-term every level survives SIGTERM, so only SIGKILL ends it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitAtBarrier } from '../helpers/barrier.ts';

const [dir, depthArg, levelArg, flag] = process.argv.slice(2);
if (dir === undefined || depthArg === undefined || levelArg === undefined) {
  throw new Error(`usage: workload-tree <dir> <depth> <level> [--ignore-term], got ${JSON.stringify(process.argv.slice(2))}`);
}
const depth = Number(depthArg);
const level = Number(levelArg);
if (flag === '--ignore-term') process.on('SIGTERM', () => {});
if (level < depth) {
  const next = [fileURLToPath(import.meta.url), dir, depthArg, String(level + 1), ...(flag === undefined ? [] : [flag])];
  spawn(process.execPath, next, { stdio: 'inherit' });
}
waitAtBarrier(dir, `level-${level}`, 120_000);
