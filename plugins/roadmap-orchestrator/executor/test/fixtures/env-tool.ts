// A plan environment's lifecycle commands for the environment tests: argv <up|down|probe> <stateDir> <name>. The
// "environment" is files in stateDir:
//   <name>.up           present while it is up: up writes it, down removes it.
//   <name>.up-fails     up exits 1 (writing nothing).
//   <name>.probe-fails  probe exits 1.
//   <name>.down-ms      down sleeps this many ms before it brings the environment down.
// Every call appends `<action> <name> <label>` to calls.log when it starts and `<action>-done <name>` when it ends, so
// tests read the order and overlap of the lifecycle's commands.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [action, stateDir, name] = process.argv.slice(2);
if ((action !== 'up' && action !== 'down' && action !== 'probe') || stateDir === undefined || name === undefined) {
  throw new Error(`usage: env-tool <up|down|probe> <stateDir> <name>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const label = process.env['RESOURCE_OWNER'];
if (label === undefined) throw new Error('env-tool: RESOURCE_OWNER is not set');
const log = (line: string): void => appendFileSync(join(stateDir, 'calls.log'), `${line}\n`);
const file = (suffix: string): string => join(stateDir, `${name}.${suffix}`);
log(`${action} ${name} ${label}`);

let code = 0;
if (action === 'up') {
  if (existsSync(file('up-fails'))) code = 1;
  else writeFileSync(file('up'), label);
} else if (action === 'down') {
  if (existsSync(file('down-ms'))) await sleep(Number(readFileSync(file('down-ms'), 'utf8')));
  rmSync(file('up'), { force: true });
} else if (existsSync(file('probe-fails'))) {
  code = 1;
}
log(`${action}-done ${name}`);
process.exit(code);
