// Reading the estate fake's instance directories (test/fakes/estate.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const instanceDir = (stateDir: string, pool: string, n: number): string => join(stateDir, `${pool}#${n}`);

export function history(dir: string): readonly string[] {
  const path = join(dir, 'history.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : [];
}

/** The most owners the instance ever had at once, replaying enter/leave; a `conflict` line counts as a second owner. */
export function maxConcurrentOwners(dir: string): number {
  const open = new Set<string>();
  let max = 0;
  for (const line of history(dir)) {
    const [event, owner] = line.split(' ') as [string, string];
    if (event === 'enter') open.add(owner);
    else if (event === 'leave') open.delete(owner);
    else if (event === 'conflict') max = Math.max(max, open.size + 1);
    else throw new Error(`${dir}/history.log: unknown event ${JSON.stringify(line)}`);
    max = Math.max(max, open.size);
  }
  return max;
}
