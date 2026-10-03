// The staged plugin's `roadmap` CLI against a host dir of the fixture's own (fake runs: argv <plugin> <hostDir>
// <roadmap argv...>). As test/fixtures/exec-cli.ts, but the code is the staged copy's, so a fake run exercises exactly
// the tree a paid session is given, and never claims the machine's host lock.
import { enableCompileCache } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

enableCompileCache();
const [plugin, hostDir, ...argv] = process.argv.slice(2);
if (plugin === undefined || hostDir === undefined) throw new Error('usage: stage-cli <plugin> <hostDir> <roadmap argv...>');
const executor = join(plugin, 'executor', 'src');
const [{ runCli }, { absPath }] = await Promise.all([
  import(pathToFileURL(join(executor, 'cli', 'main.ts')).href) as Promise<typeof import('../../src/cli/main.ts')>,
  import(pathToFileURL(join(executor, 'core', 'values.ts')).href) as Promise<typeof import('../../src/core/values.ts')>,
]);
await runCli(argv, absPath(hostDir));
