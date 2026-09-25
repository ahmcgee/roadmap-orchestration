// A declared resource probe and teardown for the reservation tests: argv <probe|teardown> <stateDir> <resource>.
// The "resource" is files in stateDir:
//   <resource>.occupant        who occupies it: its content is the owner label (RESOURCE_OWNER) of the
//                              occupant. Probe: absent → 0, this caller's label → 10, anything else → 11.
//   <resource>.probe-exit      forces the probe's exit code (a faulted probe).
//   <resource>.teardown-fails  the teardown exits 1 and removes nothing.
// The teardown removes the occupant only when it carries the caller's label. Every call appends
// `<cmd> <resource> <label>` to calls.log, so tests can read the order of probes and teardowns.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, stateDir, resource] = process.argv.slice(2);
if ((cmd !== 'probe' && cmd !== 'teardown') || stateDir === undefined || resource === undefined) {
  throw new Error(`usage: res-tool <probe|teardown> <stateDir> <resource>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const label = process.env['RESOURCE_OWNER'];
if (label === undefined) throw new Error('res-tool: RESOURCE_OWNER is not set');
appendFileSync(join(stateDir, 'calls.log'), `${cmd} ${resource} ${label}\n`);

const file = (suffix: string): string => join(stateDir, `${resource}.${suffix}`);
const occupant = existsSync(file('occupant')) ? readFileSync(file('occupant'), 'utf8') : null;

if (cmd === 'probe') {
  if (existsSync(file('probe-exit'))) process.exit(Number(readFileSync(file('probe-exit'), 'utf8')));
  process.exit(occupant === null ? 0 : occupant === label ? 10 : 11);
}
if (existsSync(file('teardown-fails'))) process.exit(1);
if (occupant === label) rmSync(file('occupant'));
process.exit(0);
