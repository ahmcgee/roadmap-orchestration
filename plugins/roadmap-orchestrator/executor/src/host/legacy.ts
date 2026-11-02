// Temporary schema-cut scaffolding: delete once no host carries dev.32 state.
// Classify raw versions before any schema-2 host reader runs. A previous-schema holder must be stopped
// by its own executor; inert files are renamed reversibly. Never hide a residue index or its archives:
// their disposition history is authority for the undispositioned-residue startup row.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readBootId } from '../contain/proc.ts';
import { durableRename, readJson } from '../core/fsx.ts';
import { procIdentity } from '../core/records.ts';
import { Fields, SchemaError } from '../core/validate.ts';
import { type AbsPath, bootId } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { HOST_LOCK, HOST_OWNER, RECOVERY_LOCK, RESIDUES, hostPath } from './hostdir.ts';
import { isAlive } from './liveness.ts';
import { RESIDUE_ARCHIVE } from './residues.ts';

const SINGLE_FILES = new Set([
  HOST_LOCK, RECOVERY_LOCK, HOST_OWNER, 'supervisor.state.json', 'demo.json',
  'exit.reason.json', 'heartbeat.json',
]);
const GENERATION_FILE = /^(?:handshake|supervisor\.ready|supervisor\.failed)\.[1-9][0-9]*$|^executor\.[1-9][0-9]*\.exit\.json$/;

function rawVersion(fields: Fields): 1 | typeof SCHEMA_VERSION {
  return fields.get('v', (v, path) => {
    if (v !== 1 && v !== SCHEMA_VERSION) throw new SchemaError(path, `${SCHEMA_VERSION}`, v);
    return v;
  });
}

function busy(path: AbsPath, pid: number): StartupRejection {
  return { kind: 'previous-schema-host-busy', path, pid,
    detail: `A previous-schema executor owns the host (pid ${pid}, ${path}); stop it with its own \`roadmap stop\` before starting this executor.` };
}

/** Called once, before claimHost and before the supervisor reads its crash window or starts the keeper. */
export function prepareLegacyHost(dir: AbsPath): StartupRejection | null {
  // dev.32 (7a94a4d6) used supervisor:{pid,start}, holder:{pid,start}, and a top-level bootId.
  // Read only those fields, never pass schema-1 data through the current record parsers.
  const locks = [HOST_LOCK, RECOVERY_LOCK].flatMap((name) => {
    const path = hostPath(dir, name);
    if (!existsSync(path)) return [];
    const fields = new Fields(readJson(path), path);
    const v = rawVersion(fields);
    const holder = fields.get(name === HOST_LOCK ? 'supervisor' : 'holder', procIdentity);
    const boot = fields.get('bootId', bootId);
    return [{ path, v, holder, boot }];
  });
  for (const lock of locks) {
    if (lock.v === 1 && isAlive(lock.holder, lock.boot)) return busy(lock.path, lock.holder.pid);
  }
  // An active current-schema supervisor may still be using ancillary files. Let claimHost refuse it
  // through the normal path; do not rename anything beside its live claim/critical section.
  if (locks.some((lock) => lock.v === SCHEMA_VERSION && isAlive(lock.holder, lock.boot))) return null;

  const legacy: AbsPath[] = [];
  let residue: AbsPath | null = null;
  for (const name of readdirSync(dir).sort()) {
    const path = hostPath(dir, name);
    if (name === RESIDUES || RESIDUE_ARCHIVE.test(name)) {
      // Match the index's tail rule: only complete lines are records. An unterminated suffix stays
      // untouched for the existing owner/read-only readers; malformed complete JSON remains loud.
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.pop();
      for (const line of lines) {
        if (rawVersion(new Fields(JSON.parse(line), path)) === 1) residue = path;
      }
    } else if (SINGLE_FILES.has(name) || GENERATION_FILE.test(name)) {
      const fields = new Fields(readJson(path), path);
      if (rawVersion(fields) !== 1) continue;
      if (name === HOST_OWNER) {
        const executor = fields.get('executor', (v, p) => v === null ? null : procIdentity(v, p));
        const boot = locks.find((lock) => lock.path === hostPath(dir, HOST_LOCK))?.boot ?? readBootId();
        if (executor !== null && isAlive(executor, boot)) return busy(path, executor.pid);
      }
      legacy.push(path);
    }
  }
  // Refuse before *any* rename. Even an apparently disposed index needs the old executor to verify its
  // chain and archived history; raw version classification cannot prove disposition is complete.
  if (residue !== null) return { kind: 'schema-version', path: residue, recorded: 1, expected: SCHEMA_VERSION,
    detail: 'Schema-1 host residue history is preserved. Use the dev.32 executor to inspect and disposition its residues. After verifying none remain, move residues.jsonl and all its archives together aside manually, then retry; do not move undispositioned residue history.' };

  for (const path of legacy) {
    let aside = `${path}.schema1`;
    for (let suffix = 1; existsSync(aside); suffix++) aside = `${path}.schema1.${suffix}`;
    durableRename(path, aside);
    process.stderr.write(`schema-1 host residue renamed: ${path} -> ${aside}\n`);
  }
  return null;
}
