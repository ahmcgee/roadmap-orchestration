// Process entry of the fake `gh` (the shim execs `node gh-entry.ts`), shaped like fake-entry.ts.
import { enableCompileCache } from 'node:module';

enableCompileCache();
const { main } = await import('./fake-gh.ts');
main();
