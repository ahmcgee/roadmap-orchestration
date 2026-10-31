// Supervisor-owned evidence collected after SIGKILL. Pressure is context, never proof of an OOM kill.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Reading = Readonly<{ kind: 'readable'; text: string }> | Readonly<{ kind: 'unavailable'; reason: string }>;
function reading(path: string): Reading {
  try { return { kind: 'readable', text: readFileSync(path, 'utf8') }; }
  catch (e) { return { kind: 'unavailable', reason: (e as Error).message }; }
}
export function readOomKills(): number | null {
  const r = reading('/proc/vmstat');
  const m = r.kind === 'readable' ? /^oom_kill (\d+)$/m.exec(r.text) : null;
  return m === null ? null : Number(m[1]);
}
export function oomForPid(text: string, pid: number): readonly string[] {
  return text.split('\n').filter((line) => new RegExp(`(?:Killed process |pid=)${pid}(?:\\s|\\b)`).test(line) && /oom|out of memory|killed process/i.test(line));
}
export function killEvidence(pid: number, oomBefore: number | null, watchdog: boolean, sinceMs = Date.now()) {
  let kernel: Reading;
  try { kernel = { kind: 'readable', text: execFileSync('dmesg', ['--ctime', '--level=err,warn', '--since', `@${Math.floor(sinceMs / 1000)}`], { encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { kernel = { kind: 'unavailable', reason: (e as Error).message }; }
  const matching = kernel.kind === 'readable' ? oomForPid(kernel.text, pid).slice(-20) : [];
  const after = readOomKills();
  return {
    cause: watchdog ? 'supervisor-watchdog' as const : matching.length > 0 ? 'oom-kill' as const : 'external-unknown' as const,
    pressure: { cpu: reading('/proc/pressure/cpu'), memory: reading('/proc/pressure/memory'), io: reading('/proc/pressure/io'), meminfo: reading('/proc/meminfo') },
    oomKills: { before: oomBefore, after, delta: after === null || oomBefore === null ? null : after - oomBefore },
    dmesg: kernel.kind === 'readable' ? { kind: 'readable' as const, matching } : kernel,
  };
}
