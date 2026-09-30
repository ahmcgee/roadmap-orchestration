// argv: <hostDir> <runtimeRoot> <threshold>. One start's residue-index compaction (src/host/compact.ts) in a child
// process, so the crash tests can SIGKILL it at its crash points; arcs' run dirs are `<runtimeRoot>/<arc>`, as the
// supervisor's are under its repo's `roadmap-runtime/`. Prints the Compaction as one JSON line.
import { join } from 'node:path';
import { absPath } from '../../src/core/values.ts';
import { compactResidues } from '../../src/host/compact.ts';

const [hostDir, root, threshold] = process.argv.slice(2);
if (hostDir === undefined || root === undefined || threshold === undefined) {
  throw new Error(`usage: compact-child <hostDir> <runtimeRoot> <threshold>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const done = compactResidues(absPath(hostDir), (arc) => absPath(join(root, arc)), Number(threshold));
process.stdout.write(`${JSON.stringify(done)}\n`);
