// Process entry of the runner (launch.ts spawns `node src/entry/runner.ts <invDir>`); its shape is
// src/entry/supervisor.ts's.
import { enableCompileCache } from 'node:module';

enableCompileCache();
Error.stackTraceLimit = 50;
const { runnerMain } = await import('../runner/runner.ts');
await runnerMain();
process.exit(0);
