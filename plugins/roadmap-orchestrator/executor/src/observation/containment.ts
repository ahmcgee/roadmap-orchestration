import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConsoleError } from './protocol.ts';
/** Observation never follows a retained run's symlink to an unrelated file, even through formatted details. */
export function checkRunContainment(runDir: string): void {
  if (!existsSync(runDir)) return;
  const root = realpathSync(runDir);
  const visit = (path: string): void => {
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
      for (const name of names) visit(join(path, name));
    }
  };
  visit(runDir);
}
