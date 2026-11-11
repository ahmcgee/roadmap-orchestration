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
import { consoleSettings, consolePort, literalHost, consoleUrl, ConsoleBindError, ConsoleUnavailableError } from './settings.ts';

export type ConsoleLease = ProcIdentity & Readonly<{
  bootId: BootId; nonce: Nonce; executorVersion: string; repo: AbsPath; common: AbsPath; hostDir: AbsPath; configSource: string;
  host: string; port: number; bindUrl: string; url: string; ready: boolean; startedAt: string;
}>;
export const consoleLease = object((f): ConsoleLease => {
  // Older consoles published this unused check timestamp. Accept it during replacement.
  f.optional('lastObservation', nullable(str));
  return {
    pid: f.get('pid', positive), start: f.get('start', nat), bootId: f.get('bootId', bootId), nonce: f.get('nonce', nonce),
    executorVersion: f.get('executorVersion', str), repo: f.get('repo', (v, p) => absPath(str(v, p))), common: f.get('common', (v, p) => absPath(str(v, p))),
    hostDir: f.get('hostDir', (v, p) => absPath(str(v, p))), configSource: f.get('configSource', str), host: f.get('host', literalHost), port: f.get('port', (v, p) => consolePort(positive(v, p), p)),
    bindUrl: f.get('bindUrl', str), url: f.get('url', str), ready: f.get('ready', bool), startedAt: f.get('startedAt', str),
  };
});
export const serviceDir = (common: AbsPath): string => join(common, 'roadmap-console');
export function readConsoleLease(common: AbsPath): ConsoleLease | null {
  const path = join(serviceDir(common), 'lease.json');
  if (!existsSync(path)) return null;
  const lease = consoleLease(readJson(path), path);
  if (lease.common !== realpathSync(common) && isAlive(lease, lease.bootId)) throw new Error(`${path}: live console pid ${lease.pid} has a different common directory (${lease.common}); use roadmap console stop in its recorded repository, or stop pid ${lease.pid}`);
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
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      if (Date.now() >= deadline) throw new ConsoleUnavailableError('console mutex wait timed out after 20 seconds; use roadmap console stop before retrying');
      await sleep(25);
    }
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
  if (isAlive(lease, lease.bootId)) throw new ConsoleUnavailableError(`console pid ${lease.pid} survived SIGKILL; use roadmap console stop after resolving the stuck process`);
}
export async function ensureConsole(repo: AbsPath, hostDir: AbsPath): Promise<ConsoleLease> {
  const common = consoleCommon(repo);
  let settings;
  try { settings = consoleSettings(readRepoConfig(repo)); }
  catch (e) { throw new Error(`.roadmap/config.json webConsole.port: invalid console configuration: ${(e as Error).message}`); }
  return locked(common, async () => {
    const old = readConsoleLease(common);
    if (old && isAlive(old, old.bootId)) {
      if (old.host !== settings.host || (settings.port !== 0 && old.port !== settings.port)) throw new ConsoleUnavailableError(`.roadmap/config.json webConsole.port conflicts with console settings from ${old.configSource}; roadmap console stop/start is required`);
      if (old.executorVersion === CONSOLE_PROTOCOL && old.ready) return old;
      await terminate(old);
    }
    durableMkdir(serviceDir(common));
    const instance = nonce(randomBytes(16).toString('hex'));
    const outPath = join(serviceDir(common), `${instance}.log`);
    const fd = openSync(outPath, 'a');
    const env: NodeJS.ProcessEnv = { ...process.env, ROADMAP_ROLE: 'console' }; delete env['ROADMAP_INV'];
    // --expose-gc: a collector collects its captures' garbage itself (src/console/collector.ts `tidy`).
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('../entry/console.ts', import.meta.url)), repo, common, hostDir, settings.host, String(settings.port), instance], { detached: true, stdio: ['ignore', fd, fd], env });
    closeSync(fd); child.unref();
    let died = false; let spawnError: Error | null = null;
    child.once('exit', () => { died = true; }); child.once('error', (e) => { spawnError = e; died = true; });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lease = readConsoleLease(common);
      if (lease?.nonce === instance && lease.ready && isAlive(lease, lease.bootId)) return lease;
      if (died || Date.now() >= deadline) {
        if (child.pid && !died) child.kill('SIGTERM');
        if (!died) throw new ConsoleUnavailableError('.roadmap/config.json webConsole.port: console startup timed out after 10 seconds; use roadmap console stop before retrying');
        const detail = (spawnError as Error | null)?.message ?? readFileSync(outPath, 'utf8');
        const binding = detail.split('\n').find(line => line.startsWith('ConsoleBindError: '));
        if (binding) throw new ConsoleBindError(settings.host, settings.port, binding.slice(binding.indexOf('failed: ') + 8));
        throw new Error(`.roadmap/config.json webConsole.port: console failed startup: ${detail}`);
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

/** Console operational failures never block arc execution; direct console start still refuses them. */
export async function ensureArcConsole(repo: AbsPath, hostDir: AbsPath): Promise<ConsoleLease | null> {
  try { return await ensureConsole(repo, hostDir); }
  catch (error) {
    if (!(error instanceof ConsoleUnavailableError)) throw error;
    process.stderr.write(`WARNING: Roadmap console unavailable; arc work continues. ${error.message.replace('.roadmap/config.json', `${repo}/.roadmap/config.json`).replace(/\s+/g, ' ')}\n`);
    return null;
  }
}
