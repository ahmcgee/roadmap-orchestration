// Shared by the environment tests and env-child.ts: environment declarations over env-tool.ts, the calls it logged, and
// a run's reservation context rebuilt from plain JSON (for a child executor).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionContainment } from '../../src/contain/session.ts';
import { type ResourceName, arcId } from '../../src/core/ids.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { parsePlan } from '../../src/input/plan.ts';
import type { ResourceContext } from '../../src/resources/reserve.ts';
import { fixture } from '../helpers/proc.ts';

const tool = (action: 'up' | 'down' | 'probe', stateDir: string, name: string) => ({
  argv: [process.execPath, fixture('env-tool.ts'), action, stateDir, name], cwd: '.', env: { set: {}, pass: [] },
});

/** A managed environment as plan.json declares it: up, down and probe over env-tool.ts, idle after `idleMinutes`. */
export const managedEnv = (stateDir: string, name: string, idleMinutes: number) => ({
  up: tool('up', stateDir, name), down: tool('down', stateDir, name), probe: tool('probe', stateDir, name), idleMinutes,
});

/** A plain environment: its probe alone. */
export const plainEnv = (stateDir: string, name: string) => ({ probe: tool('probe', stateDir, name) });

/** The calls env-tool.ts logged, in order, without the owner label (`up stack`, `up-done stack`, …). */
export function envCalls(stateDir: string): readonly string[] {
  const path = join(stateDir, 'calls.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' '));
}

/** The commands alone, as each started (`up stack`, `probe stack`, …; no `-done` lines). */
export const startedCalls = (stateDir: string): readonly string[] => envCalls(stateDir).filter((c) => !c.split(' ')[0]!.endsWith('-done'));

/** Everything a child needs to rebuild the run's reservation context, as plain JSON. */
export type EnvRun = Readonly<{ arc: string; runDir: string; repo: string; planPath: string; hostDir: string; name: ResourceName }>;

export function openEnvRun(r: EnvRun): Readonly<{ ctx: ResourceContext; journal: OpenJournal }> {
  const plan = parsePlan(JSON.parse(readFileSync(r.planPath, 'utf8')));
  const journal = openJournal(absPath(r.runDir), arcId(r.arc));
  const ctx: ResourceContext = {
    journal, containment: sessionContainment, runDir: absPath(r.runDir), plan: () => plan, repo: absPath(r.repo), hostDir: openHostDir(absPath(r.hostDir)),
  };
  return { ctx, journal };
}
