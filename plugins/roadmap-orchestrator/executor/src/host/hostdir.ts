// The host directory: one per machine, shared by every arc, holding the host lock, the owner record, the
// recovery lock, the handshake and supervisor files, and the residue index (SCHEMAS.md "Host files").
// Every host function takes the directory as a parameter; production passes HOST_DIR, tests a temp dir.
import { join } from 'node:path';
import { durableMkdir } from '../core/fsx.ts';
import { type AbsPath, absPath } from '../core/values.ts';

/** `/var/tmp` survives reboots, so residues and a dead claim are still there after one. */
export const HOST_DIR: AbsPath = absPath('/var/tmp/roadmap');

/** Creates the host directory durably on first use (idempotent) and returns it. */
export function openHostDir(dir: AbsPath): AbsPath {
  durableMkdir(dir);
  return dir;
}

export const HOST_LOCK = 'host.lock';
export const HOST_OWNER = 'host.owner.json';
export const RECOVERY_LOCK = 'host.recovery.lock';
export const RESIDUES = 'residues.jsonl';

export const hostPath = (dir: AbsPath, name: string): AbsPath => absPath(join(dir, name));
export const handshakePath = (dir: AbsPath, generation: number): AbsPath => hostPath(dir, `handshake.${generation}`);
