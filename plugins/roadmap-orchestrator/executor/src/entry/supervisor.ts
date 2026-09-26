// Process entry of the supervisor (`roadmap start` spawns `node src/entry/supervisor.ts`). Every Node
// process entry has this shape: enable Node's compile cache, then import the code dynamically, because a
// static import is compiled before any statement of the importing module runs.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { supervisorMain } = await import('../supervisor.ts');
process.exitCode = await supervisorMain(process.argv.slice(2));
