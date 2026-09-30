// A child executor for the job-owned residue tests (G4): argv <mode> <ResRun json>, over the pool plan. Crash tests
// SIGKILL it at a crashPoint (ROADMAP_TEST_CRASH).
//   lane:     job audit-1 reserves one estate instance → run → its lane (a `journey` invocation parented by the job,
//             under the job's owner label) → cleanup. Prints the cleanup result.
//   retry:    job audit-1 reserves one estate instance → run → cleanup (the test makes the teardown fail:
//             cleanup-failed with a job-owned residue) → the job reclaims it (retryReclaim under the job's holder).
//             Prints the reclaim's answer.
//   reclaim:  the job's reclaim alone, as the residue's probe after a restart runs it. Prints its answer.
//   recover:  the resources phase of recovery alone (recoverReservations).
import { type Parent } from '../../src/core/events.ts';
import { jobId, laneId, laneRev, opKey, poolInstance, sha } from '../../src/core/ids.ts';
import { isoTimeOf } from '../../src/core/values.ts';
import { invoke } from '../../src/pipeline/invoke.ts';
import { recoverReservations } from '../../src/recover/resource.ts';
import { type JobHolder, cleanup, jobOwnerLabel, reserve, retryReclaim, run } from '../../src/resources/reserve.ts';
import { ESTATE, openPoolRun } from './pool-plan.ts';
import type { ResRun } from './res-plan.ts';

const JOB = jobId('audit', 1);
const JOB_HOLDER: JobHolder = { type: 'job', job: JOB };
const JOB_PARENT: Parent = { type: 'job', job: JOB };
const INSTANCE = poolInstance(ESTATE, 1);

const MODES = ['lane', 'retry', 'reclaim', 'recover'];

async function main(): Promise<void> {
  const [mode, json] = process.argv.slice(2);
  if (json === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: job-child <${MODES.join('|')}> <run json>, got ${JSON.stringify(process.argv.slice(2))}`);
  const r = JSON.parse(json) as ResRun;
  const { ctx, journal } = openPoolRun(r);
  const reserved = () => {
    const got = reserve(ctx, JOB_HOLDER, { named: [], pools: [ESTATE], cpu: 0, publication: false }, JOB_PARENT);
    if (got.state === 'refused') throw new Error(`refused: ${got.busy.join(', ')}`);
    return run(ctx, got, JOB_PARENT);
  };
  switch (mode) {
    case 'lane': {
      const held = reserved();
      await invoke(ctx.journal, ctx.containment, {
        runDir: ctx.runDir,
        origin: { type: 'new', key: opKey(`lane:${JOB}:audit`), parent: JOB_PARENT, deadlineAt: isoTimeOf(new Date(Date.now() + 20_000)) },
        subject: { purpose: 'journey', lane: laneId('audit'), laneRev: laneRev('0'.repeat(16)), at: sha('0'.repeat(40)), owner: { type: 'job', job: JOB } },
        launch: () => ({
          argv: [process.execPath, '-e', 'process.exit(0)'], cwd: ctx.repo,
          env: { PATH: process.env['PATH'] ?? '', RESOURCE_OWNER: jobOwnerLabel(ctx.plan().arc, JOB), RESOURCE_INSTANCE_ESTATE: '1' },
          stdinPath: null, stallMs: null, graceMs: 1000, terminal: { type: 'command', purpose: 'lane', expectedExit: 0 },
        }),
      });
      process.stdout.write(`${JSON.stringify(await cleanup(ctx, held, JOB_PARENT))}\n`);
      break;
    }
    case 'retry': {
      const cleaned = await cleanup(ctx, reserved(), JOB_PARENT);
      if (cleaned.kind !== 'cleanup-failed') throw new Error(`the first teardown was meant to fail: ${JSON.stringify(cleaned)}`);
      process.stdout.write(`${await retryReclaim(ctx, JOB_HOLDER, INSTANCE, { type: 'arc' })}\n`);
      break;
    }
    case 'reclaim':
      process.stdout.write(`${await retryReclaim(ctx, JOB_HOLDER, INSTANCE, { type: 'arc' })}\n`);
      break;
    case 'recover':
      await recoverReservations(ctx);
      break;
  }
  journal.close();
}

await main();
