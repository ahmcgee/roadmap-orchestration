// One contained workload owns the stack and capture script. The runner reaps it before evidence is read.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(process.env['ROADMAP_CAPTURE_CONFIG']!) as { up: string[]; script: string[]; states: string[] };
const dir = process.env['ROADMAP_CAPTURE_DIR']!;
mkdirSync(dir, { recursive: true });
const stack = spawn(config.up[0]!, config.up.slice(1), { stdio: 'inherit', env: process.env });
let failed = false;
stack.once('error', (e) => { failed = true; process.stderr.write(`capture stack: ${e.message}\n`); });
stack.once('exit', () => { failed = true; });
const capture = spawn(config.script[0]!, config.script.slice(1), { stdio: 'inherit', env: process.env });
capture.once('error', (e) => { process.stderr.write(`capture script: ${e.message}\n`); process.exitCode = 1; stack.kill(); });
capture.once('exit', (code) => {
  const missing = config.states.filter((state) => !existsSync(join(dir, `${state}.png`)));
  if (missing.length > 0) process.stderr.write(`missing capture states: ${missing.join(', ')}\n`);
  process.exitCode = code === 0 && !failed && missing.length === 0 ? 0 : 1;
  stack.kill();
});
