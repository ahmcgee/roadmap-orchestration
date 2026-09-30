// Shared by the M2 resource tests (pools, @cpu, the arbiter, retry and publication holders) and pool-child.ts:
// a plan declaring named resources (res-tool.ts over the state dir), an estate pool (test/fakes/estate.ts,
// directory-backed instances) and an `@cpu` capacity, and a resource context over a fresh run.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionContainment } from '../../src/contain/session.ts';
import { type ResourceName, arcId, resourceName } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import type { ResourceContext } from '../../src/resources/reserve.ts';
import { fixture } from '../helpers/proc.ts';
import { type Opened, type ResRun, newRun } from './res-plan.ts';

export { newRun };
export const DB = resourceName('db');
export const QUEUE = resourceName('queue');
export const CACHE = resourceName('cache');
export const ESTATE = resourceName('estate');
export const ESTATE_SIZE = 2;
export const CPU = 4;

const estateFake = fileURLToPath(new URL('../fakes/estate.ts', import.meta.url));

const named = (cmd: 'probe' | 'teardown', stateDir: string, resource: string) => ({
  argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, resource], cwd: '.', env: { set: {}, pass: ['PATH'] },
});
const estate = (cmd: 'probe' | 'teardown', stateDir: string) => ({
  argv: [process.execPath, estateFake, cmd, stateDir, ESTATE], cwd: '.', env: { set: {}, pass: ['PATH'] },
});

/** `extra` overrides plan fields (units, capacity, resources) for plan-shape tests. */
export function poolPlanFor(run: ResRun, extra: Readonly<Record<string, unknown>> = {}): PlanM1 {
  return parsePlan({
    schema: 'roadmap/plan-m1',
    arc: run.arc,
    integrationBranch: 'main',
    baseline: '0'.repeat(40),
    worktreeRoot: '/var/tmp',
    contracts: [],
    rulings: 'rulings.md',
    architectureDoc: 'ARCHITECTURE.md',
    direction: 'test',
    capacity: { cpu: CPU },
    suite: { lanes: [] },
    resources: [
      ...[DB, QUEUE, CACHE].map((name: ResourceName) => ({ name, probe: named('probe', run.stateDir, name), teardown: named('teardown', run.stateDir, name) })),
      { name: ESTATE, pool: { size: ESTATE_SIZE }, probe: estate('probe', run.stateDir), teardown: estate('teardown', run.stateDir) },
    ],
    units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: [DB, ESTATE] }],
    ...extra,
  });
}

export function openPoolRun(run: ResRun): Opened {
  mkdirSync(run.stateDir, { recursive: true });
  const journal = openJournal(absPath(run.runDir), arcId(run.arc));
  const plan = poolPlanFor(run);
  const ctx: ResourceContext = {
    journal, containment: sessionContainment, runDir: absPath(run.runDir),
    plan: () => plan, repo: absPath(run.repo), hostDir: openHostDir(absPath(run.hostDir)),
  };
  return { ctx, journal };
}
