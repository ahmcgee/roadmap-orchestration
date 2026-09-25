// argv: <barrier dir>. Forks without end: every 10 ms a shell that itself forks two sleeps. After 20 forks
// it announces barrier `growing` (writes growing.reached, the helpers/barrier.ts convention) and keeps
// forking, so the tree is still growing while the test kills it.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: workload-growing <barrier dir>');
let forks = 0;
setInterval(() => {
  spawn('sh', ['-c', 'sleep 600 & sleep 600 & wait'], { stdio: 'ignore' });
  forks += 1;
  if (forks === 20) writeFileSync(join(dir, 'growing.reached'), `${process.pid}\n`, { flag: 'wx' });
}, 10);
