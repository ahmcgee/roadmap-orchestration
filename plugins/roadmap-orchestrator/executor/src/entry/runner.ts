// Process entry of the runner (launch.ts spawns `node src/entry/runner.ts <invDir>`); its shape is
// src/entry/supervisor.ts's.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { runnerMain } = await import('../runner/runner.ts');
await runnerMain();
process.exit(0);
