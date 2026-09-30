// A child executor for the M2 resource crash tests: argv <mode> <ResRun json> [<dieAt>]. Crash tests SIGKILL it at
// a crashPoint (ROADMAP_TEST_CRASH), or it SIGKILLs itself at `dieAt` (a point between facts that has no label).
//   retry:        u1's build reserves one estate instance → run → cleanup from its teardown stage (the test makes
//                 the first teardown fail: cleanup-failed with its residue) → the retry reclaims it (reclaim →
//                 teardown → cleaned disposition → release). Prints the retry's answer.
//   reclaim:      the retry alone, as a park's probe after a restart would run it. Prints its answer.
//   publication:  publication{u1, 1} reserves integration-slot → run → candidate green → ff published → snapshot
//                 published (facts) → cleanup. `dieAt` green|ff|snapshot kills the process right after that fact.
//   recover:      the resources phase of recovery alone (recoverReservations).
import type { StageOutcomeFact } from '../../src/core/events.ts';
import { poolInstance, unitId } from '../../src/core/ids.ts';
import { recoverReservations } from '../../src/recover/resource.ts';
import {
  type PublicationHolder, type RetryHolder, type StageHolder, cleanup, reserve, retryReclaim, run,
} from '../../src/resources/reserve.ts';
import { ESTATE, openPoolRun } from './pool-plan.ts';
import type { ResRun } from './res-plan.ts';

const [mode, json, dieAt] = process.argv.slice(2);
const MODES = ['retry', 'reclaim', 'publication', 'recover'];
if (json === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: pool-child <${MODES.join('|')}> <run json> [dieAt], got ${JSON.stringify(process.argv.slice(2))}`);
const { ctx, journal } = openPoolRun(JSON.parse(json) as ResRun);

const U1 = unitId('u1');
const RETRY: RetryHolder = { type: 'retry', unit: U1, stage: 'teardown', attempt: 1 };
const INSTANCE = poolInstance(ESTATE, 1);

const outcome = (stage: 'candidate' | 'ff' | 'snapshot', out: string, cls: string): StageOutcomeFact =>
  ({ kind: 'stage-outcome', unit: U1, stage, attempt: 1, outcome: out, class: cls, chargeable: false }) as StageOutcomeFact;

switch (mode) {
  case 'retry': {
    const build: StageHolder = { type: 'stage', unit: U1, stage: 'build', attempt: 1 };
    const parent = { type: 'stage', unit: U1, stage: 'build', attempt: 1 } as const;
    const got = reserve(ctx, build, { named: [], pools: [ESTATE], cpu: 0, publication: false }, parent);
    if (got.state === 'refused') throw new Error(`refused: ${got.busy.join(', ')}`);
    const cleaned = await cleanup(ctx, run(ctx, got, parent), { ...parent, stage: 'teardown' });
    if (cleaned.kind !== 'cleanup-failed') throw new Error(`the first teardown was meant to fail: ${JSON.stringify(cleaned)}`);
    process.stdout.write(`${await retryReclaim(ctx, RETRY, INSTANCE, { type: 'arc' })}\n`);
    break;
  }
  case 'reclaim':
    process.stdout.write(`${await retryReclaim(ctx, RETRY, INSTANCE, { type: 'arc' })}\n`);
    break;
  case 'publication': {
    const holder: PublicationHolder = { type: 'publication', unit: U1, attempt: 1 };
    const parent = { type: 'stage', unit: U1, stage: 'candidate', attempt: 1 } as const;
    const got = reserve(ctx, holder, { named: [], pools: [], cpu: 0, publication: true }, parent);
    if (got.state === 'refused') throw new Error(`refused: ${got.busy.join(', ')}`);
    const held = run(ctx, got, parent);
    const facts = [['green', outcome('candidate', 'green', 'advance')], ['ff', outcome('ff', 'published', 'advance')], ['snapshot', outcome('snapshot', 'published', 'retire')]] as const;
    for (const [at, fact] of facts) {
      journal.fact(fact);
      if (dieAt === at) process.kill(process.pid, 'SIGKILL');
    }
    process.stdout.write(`${JSON.stringify(await cleanup(ctx, held, parent))}\n`);
    break;
  }
  case 'recover':
    await recoverReservations(ctx);
    break;
}
journal.close();
