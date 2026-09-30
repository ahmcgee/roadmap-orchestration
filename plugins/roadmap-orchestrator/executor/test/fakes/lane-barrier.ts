// A lane script that parks at a per-unit barrier, printing progress while it waits, then exits 0.
// argv: <barrierDir> <name> <timeoutMs> <progressMs>. The unit is the owner label's `<unit>` in
// RESOURCE_OWNER (unitBarrierName), so two units running this lane park at different barriers.
import { unitBarrierName, waitAtBarrier } from '../helpers/barrier.ts';

const [dir, name, timeoutMs, progressMs] = process.argv.slice(2);
const owner = process.env['RESOURCE_OWNER'];
if (dir === undefined || name === undefined || timeoutMs === undefined || progressMs === undefined) {
  throw new Error(`usage: lane-barrier <dir> <name> <timeoutMs> <progressMs>, got ${JSON.stringify(process.argv.slice(2))}`);
}
if (owner === undefined) throw new Error('lane-barrier: RESOURCE_OWNER is not set');
waitAtBarrier(dir, unitBarrierName(owner.slice(owner.lastIndexOf('/') + 1), name), Number(timeoutMs), Number(progressMs));
process.stdout.write('released\n');
