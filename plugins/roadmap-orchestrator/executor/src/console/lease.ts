// The console is a repo service, owned by realpath Git common directory, outside arc GC and host containment.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBootId, signal } from '../contain/proc.ts';
import { atomicJson, durableMkdir, durableUnlink, readJson } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import type { ProcIdentity } from '../core/records.ts';
import { absPath, bootId, nonce, type AbsPath, type BootId, type Nonce } from '../core/values.ts';
import { bool, nat, object, positive, str, nullable } from '../core/validate.ts';
import { gitCommonDir } from '../git/git.ts';
import { isAlive } from '../host/liveness.ts';
import { readRepoConfig } from '../preflight/checks.ts';
import { CONSOLE_PROTOCOL } from '../observation/protocol.ts';
import { consoleSettings, consolePort, literalHost, consoleUrl } from './settings.ts';

export type ConsoleLease = ProcIdentity & Readonly<{
  bootId: BootId; nonce: Nonce; executorVersion: string; repo: AbsPath; common: AbsPath; hostDir: AbsPath; configSource: string;
  host: string; port: number; bindUrl: string; url: string; ready: boolean; startedAt: string; lastObservation: string | null;
}>;
export const consoleLease = object((f): ConsoleLease => ({
  pid: f.get('pid', positive), start: f.get('start', nat), bootId: f.get('bootId', bootId), nonce: f.get('nonce', nonce),
  executorVersion: f.get('executorVersion', str), repo: f.get('repo', (v, p) => absPath(str(v, p))), common: f.get('common', (v, p) => absPath(str(v, p))),
  hostDir: f.get('hostDir', (v, p) => absPath(str(v, p))), configSource: f.get('configSource', str), host: f.get('host', literalHost), port: f.get('port', consolePort),
  bindUrl: f.get('bindUrl', str), url: f.get('url', str), ready: f.get('ready', bool), startedAt: f.get('startedAt', str), lastObservation: f.get('lastObservation', nullable(str)),
}));
export const serviceDir = (common: AbsPath): string => join(common, 'roadmap-console');
export function readConsoleLease(common: AbsPath): ConsoleLease | null {
  const path = join(serviceDir(common), 'lease.json');
  if (!existsSync(path)) return null;
  const lease = consoleLease(readJson(path), path);
  if (lease.common !== realpathSync(common)) throw new Error('console lease common-directory identity mismatch');
  if (lease.url !== consoleUrl(lease.host, lease.port) || lease.bindUrl !== consoleUrl(lease.host, lease.port, false)) throw new Error('console lease URL/binding identity mismatch');
  return lease;
}
export const consoleCommon = (repo: AbsPath): AbsPath => absPath(realpathSync(gitCommonDir(repo)));
async function locked<T>(common: AbsPath, act: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 20_000;
  let mutex: Server;
  for (;;) {
    mutex = createServer();
    try { await new Promise<void>((resolve, reject) => { mutex.once('error', reject); mutex.listen(`\0roadmap-console-${sha256Hex(common)}`, resolve); }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= deadline) throw e; await sleep(25); }
  }
  try { return await act(); } finally { await new Promise<void>((r) => mutex.close(() => r())); }
}
async function terminate(lease: ConsoleLease): Promise<void> {
  for (const [sig, ms] of [['SIGTERM', 5_000], ['SIGKILL', 2_000]] as const) {
    if (!isAlive(lease, lease.bootId)) return;
    signal(lease, sig);
    const deadline = Date.now() + ms;
    while (isAlive(lease, lease.bootId) && Date.now() < deadline) await sleep(25);
  }
  if (isAlive(lease, lease.bootId)) throw new Error(`console pid ${lease.pid} survived SIGKILL`);
}
export async function ensureConsole(repo: AbsPath, hostDir: AbsPath): Promise<ConsoleLease> {
  const common = consoleCommon(repo);
  let settings;
  try { settings = consoleSettings(readRepoConfig(repo)); }
  catch (e) { throw new Error(`.roadmap/config.json webConsole.port: invalid console configuration: ${(e as Error).message}`); }
  return locked(common, async () => {
    const old = readConsoleLease(common);
    if (old && isAlive(old, old.bootId)) {
      if (old.host !== settings.host || old.port !== settings.port) throw new Error(`.roadmap/config.json webConsole.port conflicts with console settings from ${old.configSource}; console stop/start is required`);
      if (old.executorVersion === CONSOLE_PROTOCOL && old.ready) return old;
      await terminate(old);
    }
    durableMkdir(serviceDir(common));
    const instance = nonce(randomBytes(16).toString('hex'));
    const outPath = join(serviceDir(common), `${instance}.log`);
    const fd = openSync(outPath, 'a');
    const env: NodeJS.ProcessEnv = { ...process.env, ROADMAP_ROLE: 'console' }; delete env['ROADMAP_INV'];
    const child = spawn(process.execPath, [fileURLToPath(new URL('../entry/console.ts', import.meta.url)), repo, common, hostDir, settings.host, String(settings.port), instance], { detached: true, stdio: ['ignore', fd, fd], env });
    closeSync(fd); child.unref();
    let died = false; let spawnError: Error | null = null;
    child.once('exit', () => { died = true; }); child.once('error', (e) => { spawnError = e; died = true; });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lease = readConsoleLease(common);
      if (lease?.nonce === instance && lease.ready && isAlive(lease, lease.bootId)) return lease;
      if (died || Date.now() >= deadline) {
        if (child.pid && !died) child.kill('SIGTERM');
        throw new Error(`.roadmap/config.json webConsole.port: console failed startup: ${(spawnError as Error | null)?.message ?? readFileSync(outPath, 'utf8')}`);
      }
      await sleep(25);
    }
  });
}
export async function stopConsole(repo: AbsPath) {
  const common = consoleCommon(repo);
  return locked(common, async () => {
    const lease = readConsoleLease(common);
    if (!lease) return { state: 'none' as const };
    const live = isAlive(lease, lease.bootId);
    if (live) await terminate(lease);
    const current = readConsoleLease(common);
    if (current?.nonce === lease.nonce) durableUnlink(join(serviceDir(common), 'lease.json'));
    return { state: live ? 'stopped' as const : 'stale' as const, pid: lease.pid };
  });
}
export function consoleStatusLine(lease: ConsoleLease | null): string {
  return lease ? `Roadmap console: ${isAlive(lease, lease.bootId) && lease.ready ? lease.url : 'stale'} (bind ${lease.bindUrl}; config ${lease.configSource})` : 'Roadmap console: stopped';
}
export function publishConsoleLease(lease: ConsoleLease): void { atomicJson(join(serviceDir(lease.common), 'lease.json'), lease); }
export function releaseConsoleLease(lease: ConsoleLease): void {
  if (readConsoleLease(lease.common)?.nonce === lease.nonce) durableUnlink(join(serviceDir(lease.common), 'lease.json'));
}
