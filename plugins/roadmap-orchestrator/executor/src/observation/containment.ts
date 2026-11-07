import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ConsoleError } from './protocol.ts';
/** Observation never follows a retained run's symlink to an unrelated file, even through formatted details. */
export function checkRunContainment(runDir: string): void {
  if (!existsSync(runDir)) return;
  const root = realpathSync(runDir);
  const visit = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      const target = relative(root, realpathSync(path));
      if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new ConsoleError('invalid', 'evidence symlink escapes its retained run');
    } else if (st.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(runDir);
}
