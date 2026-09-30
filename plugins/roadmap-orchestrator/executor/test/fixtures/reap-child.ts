// A test process that owns one scope and then dies without its teardown, for reap.test.ts: argv <path>.
// Tracks a scope named by `path`, starts a detached process carrying `path` in its argv (as a supervisor
// carries its host dir), prints that process's pid and waits to be killed.
import { spawn } from 'node:child_process';
import { track } from '../helpers/reap.ts';

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: reap-child <path>');
track({ paths: [path], stop: () => Promise.reject(new Error('never stopped: this process is killed')) });
const run = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path], { detached: true, stdio: 'ignore' });
run.unref();
process.stdout.write(`${run.pid}\n`);
setInterval(() => {}, 1000);
