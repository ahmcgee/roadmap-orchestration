// Shared by the command tests and cmd-child.ts: a command context over the reservation tests' run (plan
// with resources db, queue, cache whose probe and teardown are res-tool.ts), the default routing, and a
// backend environment whose PATH is a scenario's shim dir.
import { mkdirSync } from 'node:fs';
import type { CommandContext } from '../../src/commands/apply.ts';
import type { OpenJournal } from '../../src/core/log.ts';
import { join } from 'node:path';
import { absPath } from '../../src/core/values.ts';
import { resolveRouting } from '../../src/routing/layers.ts';
import { type ResRun, openRun } from './res-plan.ts';
import { serialRuntime, testProbes } from './stage-common.ts';

export type CmdRun = ResRun & Readonly<{ binDir: string }>;

export function openCommandRun(run: CmdRun): Readonly<{ ctx: CommandContext; journal: OpenJournal }> {
  mkdirSync(run.binDir, { recursive: true });
  const { ctx, journal } = openRun(run);
  const routing = { profile: 'default' as const, resolved: resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null }) };
  const home = process.env['HOME'];
  if (home === undefined) throw new Error('tests need HOME');
  const hostEnv = { PATH: run.binDir, HOME: home };
  const planDir = absPath(run.repo);
  const stage = { ...ctx, hostEnv, planDir, routing: () => routing.resolved, ...serialRuntime(ctx) };
  return {
    journal,
    ctx: {
      ...ctx,
      hostEnv,
      planDir,
      laneEnv: {}, planFile: absPath(join(run.repo, 'plan.json')),
      resolve: (plan) => resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: plan.routing ?? null, unit: null }),
      routing: () => routing,
      probes: testProbes(stage),
    },
  };
}
