import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ConsoleError } from '../observation/protocol.ts';
/** Verify the opened descriptor, not merely a path checked before an open. No directory listings or arbitrary paths. */
export function openEvidence(root: string, path: string): number {
  const base = realpathSync(root);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new ConsoleError('invalid', 'evidence symlink escapes permitted descriptor traversal');
    throw error;
  }
  try {
    const actual = realpathSync(`/proc/self/fd/${fd}`);
    const rel = relative(base, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !fstatSync(fd).isFile()) throw new ConsoleError('invalid', 'evidence escapes its retained run');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function readEvidence(root: string, path: string): Buffer {
  const fd = openEvidence(root, resolve(path));
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
export function logPage(root: string, path: string, after: number) {
  const fd = openEvidence(root, path);
  try {
    const st = fstatSync(fd);
    if (after > st.size) throw new ConsoleError('reset', 'log cursor exceeds replaced or truncated evidence');
    const bytes = Buffer.alloc(Math.min(65536, st.size - after));
    const count = readSync(fd, bytes, 0, bytes.length, after);
    return { after, next: after + count, size: st.size, identity: `${st.dev}:${st.ino}`, text: bytes.subarray(0, count).toString('utf8'), encoding: 'utf8', bytes: bytes.subarray(0, count).toString('base64') };
  } finally { closeSync(fd); }
}
