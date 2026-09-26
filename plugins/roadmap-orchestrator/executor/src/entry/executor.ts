// Process entry of the executor (the supervisor spawns `node src/entry/executor.ts`); its shape is
// src/entry/supervisor.ts's.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { executorMain } = await import('../executor.ts');
process.exitCode = await executorMain(process.argv.slice(2));
