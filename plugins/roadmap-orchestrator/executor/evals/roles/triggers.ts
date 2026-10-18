// Which role evals a change triggers (rung 3.5 is path-triggered): the changed paths, relative to executor/, mapped to the
// roles whose behaviour they can move.
// - Gate: its prompt modules, the bounded diff, the gate stage's capture, the prompt inputs it renders, routing (seats,
//   classes, models), the judgment argv and tool set, the backend adapter that reads the session, and its eval.
// - Walkthrough (dev.13): its prompt modules, the walk job (src/walk/: the job, bring-up, report validation and minting,
//   the milestone node), its MCP config (src/backends/mcp.ts), the prompt inputs and schemas, routing, the
//   `claude-acting-judge` argv and the reader of its session, and its eval.
// The shared harness (evals/roles/*.ts) triggers both.
// TODO(agent J, the polish-judge eval): add `polishJudge` to EvalRole once run.ts can run it, triggered by
// `src/prompts/polishJudge/**`, the compare job `src/walk/compare.ts` (with src/walk/bringup.ts, which it shares), the
// polish revision `src/walk/polish.ts`, SHARED and `evals/roles/polish/**`; then narrow walkthrough's `src/walk/**` so
// compare.ts and polish.ts trigger only the polish judge (agent D, dev.13). Not added now: EvalRole is what run.ts runs.
//
//   node evals/roles/triggers.ts [<base ref>]   prints the triggered roles, one per line (base: origin/main), from
//                                               `git diff --name-only <base>...HEAD` over executor/
import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export type EvalRole = 'gate' | 'walkthrough';

const SHARED = ['src/prompts/inputs.ts', 'src/prompts/schemas.ts', 'src/routing/**', 'src/backends/argv.ts', 'src/backends/claude.ts', 'evals/roles/*.ts'] as const;

export const TRIGGERS: Readonly<Record<EvalRole, readonly string[]>> = {
  gate: ['src/prompts/gate/**', 'src/git/boundeddiff.ts', 'src/pipeline/gate.ts', ...SHARED, 'evals/roles/gate/**', 'evals/roles/gen/**'],
  walkthrough: ['src/prompts/walkthrough/**', 'src/walk/**', 'src/backends/mcp.ts', ...SHARED, 'evals/roles/walkthrough/**'],
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
