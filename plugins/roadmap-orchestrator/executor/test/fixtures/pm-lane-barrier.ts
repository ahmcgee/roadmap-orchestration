// A suite lane for the whole-pipeline matrix: argv <dir> <name>. The first time it runs it parks at file
// barrier `name` in `dir` (test/helpers/barrier.ts) until the test releases it; once released it passes at
// once, so later suite runs of the same arc are plain green lanes.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { waitAtBarrier } from '../helpers/barrier.ts';

const [dir, name] = process.argv.slice(2);
if (dir === undefined || name === undefined) throw new Error(`usage: pm-lane-barrier <dir> <name>, got ${JSON.stringify(process.argv.slice(2))}`);
if (!existsSync(join(dir, `${name}.release`))) waitAtBarrier(dir, name, 120_000);
