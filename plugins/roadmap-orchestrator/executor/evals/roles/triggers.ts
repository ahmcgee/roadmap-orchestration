// Eval path triggers: verifier covers the unit gate mode; pre-build and campaignAudit have small
// independent dev sets. Walkthrough and polish are experienceVerdict eval modes. Shared schemas,
// routing, method modules and backend changes trigger the affected live-role evaluations.
import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export type EvalRole = 'gate' | 'walkthrough' | 'polishJudge' | 'verifier' | 'pre-build' | 'campaignAudit';

const SHARED = ['src/prompts/inputs.ts', 'src/prompts/schemas.ts', 'src/routing/**', 'src/backends/argv.ts', 'src/backends/claude.ts', 'evals/roles/*.ts'] as const;
/** The polish judge's modules under src/walk/: they trigger it alone. */
const POLISH_MODULES = ['src/walk/compare.ts', 'src/walk/polish.ts'] as const;

export const TRIGGERS: Readonly<Record<EvalRole, readonly string[]>> = {
  gate: ['evals/roles/gate/**'],
  verifier: ['src/prompts/verifier/**', 'src/prompts/method/**', 'src/pipeline/surface.ts', 'src/git/boundeddiff.ts', 'src/pipeline/gate.ts', 'src/pipeline/dispatch.ts', ...SHARED, 'evals/roles/gate/**', 'evals/roles/gen/**'],
  walkthrough: ['src/prompts/experienceVerdict/**', 'src/walk/**', 'src/backends/mcp.ts', ...SHARED, 'evals/roles/walkthrough/**'],
  polishJudge: [
    'src/prompts/experienceVerdict/**', ...POLISH_MODULES, 'src/walk/bringup.ts', 'src/backends/mcp.ts', ...SHARED,
    'evals/roles/polish/**', 'evals/roles/walkthrough/**',
  ],
  'pre-build': ['src/prompts/verifier/**', 'src/prompts/method/**', 'src/pipeline/surface.ts', 'src/pipeline/stages.ts', 'evals/roles/surface/**', ...SHARED],
  campaignAudit: ['src/prompts/campaignAudit/**', 'src/prompts/method/**', 'src/holistic/audit.ts', 'evals/roles/surface/**', ...SHARED],
};

/** Paths a role's globs match that do not trigger it. */
const EXCLUDED: Readonly<Partial<Record<EvalRole, readonly string[]>>> = { walkthrough: POLISH_MODULES };

/** The roles `paths` (relative to executor/) trigger, in TRIGGERS order. This file only chooses evals and runs none,
 * so its own changes trigger nothing. */
export function triggeredRoles(paths: readonly string[]): readonly EvalRole[] {
  return (Object.keys(TRIGGERS) as EvalRole[]).filter((role) => paths.some((p) => p !== 'evals/roles/triggers.ts' && TRIGGERS[role].some((g) => matchesGlob(p, g)) && !(EXCLUDED[role] ?? []).includes(p)));
}

/** Skill evaluation, separate from the role dispatcher. Orchestrate is intentionally conservative:
 * a path trigger cannot distinguish its Phase-0 paragraph from other edits in that file. */
export function triggeredCompaction(paths: readonly string[]): boolean {
  return paths.some((p) => ['../skills/estate-compaction/**', '../skills/orchestrate/SKILL.md', 'evals/compaction/**'].some((g) => matchesGlob(p, g)));
}

if (import.meta.main) {
  const base = process.argv[2] ?? 'origin/main';
  const r = spawnSync('git', ['diff', '--name-only', '--relative=plugins/roadmap-orchestrator', `${base}...HEAD`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git diff ${base}...HEAD: ${r.stderr}`);
  const paths = r.stdout.split('\n').filter((l) => l !== '').map((p) => p.startsWith('executor/') ? p.slice('executor/'.length) : `../${p}`);
  for (const role of triggeredRoles(paths)) process.stdout.write(`${role}\n`);
  if (triggeredCompaction(paths)) process.stdout.write('compaction\n');
}
