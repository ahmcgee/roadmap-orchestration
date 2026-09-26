// argv: <barrier dir> <name> <timeoutMs>. Parks at the barrier, then prints "released".
import { waitAtBarrier } from '../helpers/barrier.ts';

const [dir, name, timeoutMs] = process.argv.slice(2);
if (dir === undefined || name === undefined || timeoutMs === undefined) {
  throw new Error(`usage: barrier-child <dir> <name> <timeoutMs>, got ${JSON.stringify(process.argv.slice(2))}`);
}
waitAtBarrier(dir, name, Number(timeoutMs));
process.stdout.write('released\n');
