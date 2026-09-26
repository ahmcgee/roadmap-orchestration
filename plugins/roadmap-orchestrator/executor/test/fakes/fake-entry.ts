// Process entry of the fake backends (the shims exec `node fake-entry.ts`), shaped like production's
// process entries (src/entry/supervisor.ts): the compile cache first, then the fake itself.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { main } = await import('./fake-backend.ts');
main();
