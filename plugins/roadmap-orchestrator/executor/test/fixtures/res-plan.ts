// Shared by the reservation tests and res-child.ts: a plan declaring three resources whose probe and
// teardown are res-tool.ts over a state dir, a resource context over a fresh run, readers for the
// resulting log and table, and the lane invocation a holder runs.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionContainment } from '../../src/contain/session.ts';
import type { Event, IntentOf, Parent, ResourceEdge } from '../../src/core/events.ts';
import { type ResourceName, type ResourceUnit, type UnitId, arcId, laneId, opKey, resourceName, sha, unitId } from '../../src/core/ids.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import { absPath, isoTimeOf } from '../../src/core/values.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { type InvocationOutcome, invoke } from '../../src/pipeline/invoke.ts';
import { type ResourceContext, type ResourceStatus, type StageHolder, resourceTable } from '../../src/resources/reserve.ts';
import { fixture } from '../helpers/proc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { arcFor, events } from './invoke-specs.ts';

export const DB = resourceName('db');
export const QUEUE = resourceName('queue');
export const CACHE = resourceName('cache');
export const UNIT = unitId('u1');

/** Everything a child process needs to rebuild the same context, as plain JSON. */
export type ResRun = Readonly<{ runDir: string; arc: string; repo: string; hostDir: string; stateDir: string }>;

export function newRun(): ResRun {
  const stateDir = tmpDir('res-state');
  return { runDir: tmpDir('res-run'), arc: arcFor(), repo: tmpDir('res-repo'), hostDir: join(tmpDir('res-host'), 'roadmap'), stateDir };
}

const tool = (cmd: 'probe' | 'teardown', stateDir: string, resource: string) => ({
  argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, resource],
  cwd: '.',
  env: { set: {}, pass: ['PATH'] },
});

export function planFor(run: ResRun): PlanM1 {
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
    suite: { lanes: [] },
    resources: [DB, QUEUE, CACHE].map((name) => ({ name, probe: tool('probe', run.stateDir, name), teardown: tool('teardown', run.stateDir, name) })),
    units: [{ id: UNIT, spec: 'u1.json', risk: 'low', scope: ['src/**'], resources: [DB, QUEUE] }],
  });
}

export type Opened = Readonly<{ ctx: ResourceContext; journal: OpenJournal }>;

export function openRun(run: ResRun): Opened {
  mkdirSync(run.stateDir, { recursive: true });
  const journal = openJournal(absPath(run.runDir), arcId(run.arc));
  const plan = planFor(run);
  const ctx: ResourceContext = {
    journal, containment: sessionContainment, runDir: absPath(run.runDir),
    plan: () => plan, repo: absPath(run.repo), hostDir: openHostDir(absPath(run.hostDir)),
  };
  return { ctx, journal };
}

export const stageHolder = (stage: StageHolder['stage'], attempt = 1, unit: UnitId = UNIT): StageHolder => ({ type: 'stage', unit, stage, attempt });
export const stageParent = (h: StageHolder): Parent => ({ type: 'stage', unit: h.unit, stage: h.stage, attempt: h.attempt });

/** The holder's workload: a lane command (`node -e script`) through `invoke`, parented by the holder's stage. */
export function laneInvocation(ctx: ResourceContext, holder: StageHolder, set: 'spec' | 'suite' = 'spec', script = 'process.exit(0)'): Promise<InvocationOutcome> {
  return invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${holder.unit}:${set}`), parent: stageParent(holder), deadlineAt: isoTimeOf(new Date(Date.now() + 20_000)) },
    subject: { purpose: 'lane', unit: holder.unit, lane: laneId(set === 'spec' ? 'unit' : 'suite'), set, at: sha('0'.repeat(40)) },
    launch: () => ({
      argv: [process.execPath, '-e', script], cwd: ctx.repo, env: { PATH: process.env['PATH'] ?? '' }, stdinPath: null, stallMs: null, graceMs: 1000,
      terminal: { type: 'command', purpose: 'lane', expectedExit: 0 },
    }),
  });
}

/** The lines res-tool.ts logged: `<cmd> <resource> <label>`. */
export function calls(run: ResRun): readonly string[] {
  try {
    return readFileSync(join(run.stateDir, 'calls.log'), 'utf8').split('\n').filter((l) => l !== '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The resource table of a fresh open of the run's log, as plain statuses (absent = free). */
export function tableOf(run: ResRun): ReadonlyMap<ResourceUnit, ResourceStatus> {
  const journal = openJournal(absPath(run.runDir), arcId(run.arc));
  try {
    assertNoOpen(journal);
    return new Map([...resourceTable(journal.view)].map(([r, e]) => [r, e.status]));
  } finally {
    journal.close();
  }
}

function assertNoOpen(journal: OpenJournal): void {
  const open = journal.view.openIntents();
  if (open.length > 0) throw new Error(`open intents remain: ${open.map((i) => `${i.op} ${i.kind}`).join(', ')}`);
}

export type Transition = Readonly<{ holder: string; resources: readonly ResourceUnit[]; edge: ResourceEdge['type']; from?: string }>;

/** Every resource.transition intent in log order, compactly. */
export function transitions(run: ResRun): readonly Transition[] {
  return events(run.runDir)
    .filter((e): e is Event & IntentOf<'resource.transition'> => e.type === 'intent' && e.kind === 'resource.transition')
    .map((e) => {
      const h = e.expect.holder;
      return {
        holder: h.type === 'stage' ? `${h.unit}/${h.stage}/${h.attempt}` : h.type === 'sweep' ? h.command : JSON.stringify(h),
        resources: e.expect.resources,
        edge: e.expect.edge.type,
        ...(e.expect.edge.type === 'clean' ? { from: e.expect.edge.from } : {}),
      };
    });
}
