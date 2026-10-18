// Which role evals a change triggers (rung 3.5 is path-triggered): the changed paths, relative to executor/, mapped to the
// roles whose behaviour they can move. Gate: its prompt modules, the bounded diff, the gate stage's capture, the prompt
// inputs it renders, routing (seats, classes, models), the judgment argv and tool set, the backend adapter that reads the
// session, and the eval itself.
//
//   node evals/roles/triggers.ts [<base ref>]   prints the triggered roles, one per line (base: origin/main), from
//                                               `git diff --name-only <base>...HEAD` over executor/
import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export type EvalRole = 'gate';

export const TRIGGERS: Readonly<Record<EvalRole, readonly string[]>> = {
  gate: [
    'src/prompts/gate/**',
    'src/prompts/inputs.ts',
    'src/prompts/schemas.ts',
    'src/git/boundeddiff.ts',
    'src/pipeline/gate.ts',
    'src/routing/**',
    'src/backends/argv.ts',
    'src/backends/claude.ts',
    'evals/roles/**',
  ],
};

/** The roles `paths` (relative to executor/) trigger, in TRIGGERS order. */
export function triggeredRoles(paths: readonly string[]): readonly EvalRole[] {
  return (Object.keys(TRIGGERS) as EvalRole[]).filter((role) => paths.some((p) => TRIGGERS[role].some((g) => matchesGlob(p, g))));
}

if (import.meta.main) {
  const base = process.argv[2] ?? 'origin/main';
  const r = spawnSync('git', ['diff', '--name-only', '--relative', `${base}...HEAD`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git diff ${base}...HEAD: ${r.stderr}`);
  for (const role of triggeredRoles(r.stdout.split('\n').filter((l) => l !== ''))) process.stdout.write(`${role}\n`);
}
