// dev.13 (D1), the Phase-0 and start row `walk-tools-missing`: what a milestone's walk needs that this environment lacks.
// The architect fixes the environment during bootstrapping (preferably the project's devcontainer); the row names the fix.
// - Every program a milestone's bring-up names (`setup[i]`, `serve.<name>`, `seed[i]`) resolves, as a lane's argv[0] does
//   (src/preflight/argv0.ts): on the bring-up's own `PATH` when its `env` sets one, else the executor's. A relative path
//   with a slash names a file of the checkout (a unit may create it), so it is not checked here.
// - A milestone with a `browser` journey has `walkthrough.mcp` in the repo config, and every configured server starts and
//   connects: the MCP `initialize` handshake over stdio, no model call (src/backends/mcp.ts `mcpHandshake`), each server
//   once, substituted as a session's would be with a scratch evidence dir that is removed afterwards.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpHandshake, substituteWalkServer } from '../backends/mcp.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { type Argv, type Milestone, milestonesOf } from '../input/plan.ts';
import type { RepoConfig } from '../routing/layers.ts';
import { resolveArgv0 } from './argv0.ts';
import type { StartupCheck, StartupRejection, WalkToolsProblem } from './startup.ts';

type Row = Extract<StartupRejection, { kind: 'walk-tools-missing' }>;

/** The bring-up's commands, each with the `step` the row names it by. */
function bringUpCommands(m: Milestone): readonly Readonly<{ step: string; argv: Argv }>[] {
  const b = m.bringUp;
  return [
    ...b.setup.map((argv, i) => ({ step: `setup[${i}]`, argv })),
    ...b.serve.map((s) => ({ step: `serve.${s.name}`, argv: s.argv })),
    ...b.seed.map((argv, i) => ({ step: `seed[${i}]`, argv })),
  ];
}

function programRows(m: Milestone, env: Readonly<Record<string, string | undefined>>): readonly Row[] {
  const laneEnv = { set: m.bringUp.env, pass: ['PATH'] };
  return bringUpCommands(m).flatMap(({ step, argv }) => (resolveArgv0({ argv, env: laneEnv }, env).kind === 'not-found'
    ? [{ kind: 'walk-tools-missing', milestone: m.id, problem: { type: 'program', step, argv0: argv[0] as string } }]
    : []));
}

/** The configured servers that did not connect, by name, with why not. */
async function unconnected(config: NonNullable<RepoConfig['walkthrough']>, cwd: AbsPath, env: Readonly<Record<string, string | undefined>>): Promise<ReadonlyMap<string, string>> {
  const evidence = absPath(mkdtempSync(join(tmpdir(), 'roadmap-walk-check-')));
  try {
    const outcomes = await Promise.all(Object.entries(config.mcp).map(async ([name, server]) => [name, await mcpHandshake(substituteWalkServer(server, evidence), cwd, env)] as const));
    return new Map(outcomes.flatMap(([name, o]) => (o.ok ? [] : [[name, o.detail] as const])));
  } finally {
    rmSync(evidence, { recursive: true, force: true });
  }
}

/** The rows of `plan`'s milestones under `config` (the working tree's `.roadmap/config.json`), servers started from `repo`. */
export async function walkToolsRows(
  plan: Parameters<typeof milestonesOf>[0], config: RepoConfig | null, repo: AbsPath, env: Readonly<Record<string, string | undefined>>,
): Promise<readonly Row[]> {
  const milestones = milestonesOf(plan);
  const browser = milestones.filter((m) => m.journeys.some((j) => j.via === 'browser'));
  const servers = browser.length === 0 || config?.walkthrough === undefined ? null : await unconnected(config.walkthrough, repo, env);
  const mcp = (m: Milestone): readonly WalkToolsProblem[] => {
    if (!browser.includes(m)) return [];
    if (servers === null) return [{ type: 'mcp-unconfigured' }];
    return [...servers].map(([server, detail]) => ({ type: 'mcp-unconnected', server, detail }));
  };
  return milestones.flatMap((m) => [...programRows(m, env), ...mcp(m).map((problem): Row => ({ kind: 'walk-tools-missing', milestone: m.id, problem }))]);
}

/** The row as a start runs it (group 2, environment) and `phase0 check --plan` does: the working tree's repo config. */
export function walkToolsCheck(env: Readonly<Record<string, string | undefined>>, config: RepoConfig | null): StartupCheck<'walk-tools-missing'> {
  return { kind: 'walk-tools-missing', check: async (context) => walkToolsRows(context.plan, config, context.repo, env) };
}
