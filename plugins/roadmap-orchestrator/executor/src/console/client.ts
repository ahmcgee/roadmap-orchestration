import { existsSync, statSync } from 'node:fs';
import { commonDirOfRun } from '../answers.ts';
import type { Run } from '../cli/locate.ts';
import { EVENTS_FILE } from '../core/log.ts';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { AbsPath } from '../core/values.ts';
import { isAlive } from '../host/liveness.ts';
import { Observer } from '../observation/observer.ts';
import { checkRunContainment } from '../observation/containment.ts';
import { CONSOLE_PROTOCOL, ConsoleError, validateStatusEnvelope } from '../observation/protocol.ts';
import { consoleStatusLine, readConsoleLease } from './lease.ts';

/** Absence, death, transport failure and version mismatch fall back. Evidence/identity failures remain errors. */
export async function consoleStatus(run: Run, hostDir: AbsPath, summary: boolean, diagnostic: (line: string) => void): Promise<string> {
  const common = commonDirOfRun(run.runDir);
  const lease = readConsoleLease(common);
  diagnostic(consoleStatusLine(lease));
  const local = (reason: string): string => {
    diagnostic(`Roadmap console: ${reason}; using local observation`);
    // The authoritative local capture must not depend on a quiet interval for the console cache.
    // Journal and evidence readers still validate their inputs; containment is identical to the server's.
    checkRunContainment(run.runDir);
    const observer = new Observer();
    const reply = observer.observe({ locator: { type: 'host' }, pinned: run, hostDir, token: 0 });
    if (reply.error || !reply.display || !observer.captured) throw new ConsoleError('corruption', reply.error ?? 'no captured observation');
    return canonicalJson(summary ? observer.captured.summary : reply.display.status) + '\n';
  };
  if (!lease || !isAlive(lease, lease.bootId)) return local(lease ? 'server identity is dead' : 'server is absent');
  if (lease.executorVersion !== CONSOLE_PROTOCOL) return local('console protocol/version mismatch');
  const query = new URLSearchParams();
  const path = join(run.runDir, EVENTS_FILE);
  if (existsSync(path)) { const st = statSync(path); query.set('fenceIdentity', `${st.dev}:${st.ino}`); query.set('fenceSize', String(st.size)); }
  let response: Response;
  try { response = await fetch(`${lease.url}/api/${CONSOLE_PROTOCOL}/runs/${run.arc}/status?summary=${summary ? 1 : 0}&${query}`, { signal: AbortSignal.timeout(2_100) }); }
  catch (e) { return local(e instanceof Error ? e.message : String(e)); }
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new ConsoleError('protocol', 'malformed console JSON payload'); }
  if (!response.ok) {
    const error = (raw as { error?: { code?: string; message?: string } }).error;
    if (response.status === 409 && error?.code === 'protocol' && error.message?.includes('protocol/version mismatch')) return local(error.message);
    if (response.status === 503 && error?.code === 'unavailable') return local(error.message ?? 'catch-up timed out');
    throw new ConsoleError('protocol', `console ${error?.code ?? response.status}: ${error?.message ?? 'invalid error payload'}`);
  }
  if (raw && typeof raw === 'object' && 'protocol' in raw && typeof raw.protocol === 'string' && raw.protocol !== CONSOLE_PROTOCOL) return local('console protocol/version mismatch');
  const e = validateStatusEnvelope(raw, { instance: lease.nonce, repoId: sha256Hex(common), arc: run.arc }, summary);
  if (Date.now() - Date.parse(e.checkedAt) > 5_000) throw new ConsoleError('protocol', 'server returned an unchecked stale observation');
  return canonicalJson(e.data) + '\n';
}
