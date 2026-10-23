// A child executor for the environment crash tests: argv <EnvRun json>. It opens the run's journal and plan and uses
// environment `name` once (src/resources/environments.ts `useEnvironment`), so a test can SIGKILL it at a crashPoint
// (ROADMAP_TEST_CRASH) inside the environment's up.
import { useEnvironment } from '../../src/resources/environments.ts';
import { type EnvRun, openEnvRun } from './env-common.ts';

const [json] = process.argv.slice(2);
if (json === undefined) throw new Error(`usage: env-child <run json>, got ${JSON.stringify(process.argv.slice(2))}`);
const r = JSON.parse(json) as EnvRun;
const { ctx, journal } = openEnvRun(r);
const used = await useEnvironment(ctx, r.name, { type: 'arc' });
process.stdout.write(`${used.kind}\n`);
journal.close();
