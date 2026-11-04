// Read real /proc records while both generations are alive, then let the child exit naturally.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const mask = (pid: number): string => {
  const value = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  if (value === undefined) throw new Error(`no affinity for ${pid}`);
  return value;
};
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
if (child.pid === undefined) throw new Error('child did not spawn');
console.log(JSON.stringify({ parent: mask(process.pid), child: mask(child.pid) }));
