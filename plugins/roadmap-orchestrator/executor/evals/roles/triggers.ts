// Which role evals a change triggers (rung 3.5 is path-triggered): the changed paths, relative to executor/, mapped to the
// roles whose behaviour they can move.
// - Gate: its prompt modules, the bounded diff, the gate stage's capture, its call (src/pipeline/dispatch.ts: dev.13, the
//   gate's acting-judge argv is chosen there), the prompt inputs it renders, routing (seats,
//   classes, models), the judgment argv and tool set, the backend adapter that reads the session, and its eval.
// - Walkthrough (dev.13): its prompt modules, the walk job (src/walk/: the job, bring-up, report validation and minting,
//   the milestone node and rounds; not the compare or the polish revision, which are the polish judge's), its MCP config
//   (src/backends/mcp.ts), the prompt inputs and schemas, routing, the `claude-acting-judge` argv and the reader of its
//   session, and its eval.
// - Polish judge (dev.13): its prompt modules, the compare job (src/walk/compare.ts) and the bring-up it shares
//   (src/walk/bringup.ts), the polish revision that admits the units it judges (src/walk/polish.ts), its MCP config, the
//   prompt inputs and schemas, routing, the acting-judge argv and reader, and its eval (which runs on the walkthrough
//   eval's product, so that product triggers it too).
// The shared harness (evals/roles/*.ts) triggers every role.
//
//   node evals/roles/triggers.ts [<base ref>]   prints the triggered roles, one per line (base: origin/main), from
//                                               `git diff --name-only <base>...HEAD` over executor/
import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export type EvalRole = 'gate' | 'walkthrough' | 'polishJudge';

const SHARED = ['src/prompts/inputs.ts', 'src/prompts/schemas.ts', 'src/routing/**', 'src/backends/argv.ts', 'src/backends/claude.ts', 'evals/roles/*.ts'] as const;
/** The polish judge's modules under src/walk/: they trigger it alone. */
const POLISH_MODULES = ['src/walk/compare.ts', 'src/walk/polish.ts'] as const;

export const TRIGGERS: Readonly<Record<EvalRole, readonly string[]>> = {
  gate: ['src/prompts/gate/**', 'src/git/boundeddiff.ts', 'src/pipeline/gate.ts', 'src/pipeline/dispatch.ts', ...SHARED, 'evals/roles/gate/**', 'evals/roles/gen/**'],
  walkthrough: ['src/prompts/walkthrough/**', 'src/walk/**', 'src/backends/mcp.ts', ...SHARED, 'evals/roles/walkthrough/**'],
  polishJudge: [
    'src/prompts/polishJudge/**', ...POLISH_MODULES, 'src/walk/bringup.ts', 'src/backends/mcp.ts', ...SHARED,
    'evals/roles/polish/**', 'evals/roles/walkthrough/**',
  ],
};

/** Paths a role's globs match that do not trigger it. */
const EXCLUDED: Readonly<Partial<Record<EvalRole, readonly string[]>>> = { walkthrough: POLISH_MODULES };

/** The roles `paths` (relative to executor/) trigger, in TRIGGERS order. */
export function triggeredRoles(paths: readonly string[]): readonly EvalRole[] {
  return (Object.keys(TRIGGERS) as EvalRole[]).filter((role) => paths.some((p) => TRIGGERS[role].some((g) => matchesGlob(p, g)) && !(EXCLUDED[role] ?? []).includes(p)));
}

if (import.meta.main) {
  const base = process.argv[2] ?? 'origin/main';
  const r = spawnSync('git', ['diff', '--name-only', '--relative', `${base}...HEAD`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git diff ${base}...HEAD: ${r.stderr}`);
  for (const role of triggeredRoles(r.stdout.split('\n').filter((l) => l !== ''))) process.stdout.write(`${role}\n`);
}
