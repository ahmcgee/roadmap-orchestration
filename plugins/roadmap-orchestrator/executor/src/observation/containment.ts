import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConsoleError } from './protocol.ts';
/** Observation never follows a retained run's symlink to an unrelated file, even through formatted details. */
export function checkRunContainment(runDir: string): void {
  if (!existsSync(runDir)) return;
  const root = realpathSync(runDir);
  const pending = [runDir];
  while (pending.length > 0) checkContained(root, pending.pop()!, pending);
}
/**
 * The containment rule for one entry under `root` (the run's real path): a symlink must resolve inside it. A directory's
 * members are pushed onto `pending`, so a caller can walk the run in slices (the console's integrity sweep).
 */
export function checkContained(root: string, path: string, pending: string[]): void {
  // Writers may rename/unlink entries after enumeration; vanished entries are harmless.
  let st;
  try { st = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (st.isSymbolicLink()) {
    let resolved;
    try { resolved = realpathSync(path); }
    catch (error) {
      // A removed entry cannot escape containment. A surviving dangling link still fails.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { lstatSync(path); }
        catch (recheck) { if ((recheck as NodeJS.ErrnoException).code === 'ENOENT') return; throw recheck; }
      }
      throw error;
    }
    const target = relative(root, resolved);
    if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new ConsoleError('invalid', 'evidence symlink escapes its retained run');
  } else if (st.isDirectory()) {
    let names;
    try { names = readdirSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) pending.push(join(path, name));
  }
}
