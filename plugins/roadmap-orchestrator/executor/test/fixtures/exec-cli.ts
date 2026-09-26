// The `roadmap` CLI as a child process, against a test's own host directory: argv <hostDir> <roadmap argv...>.
// Production's bin/roadmap is `main(argv)`, which is `runCli(argv, HOST_DIR)`; this is the same entry with
// the host directory every host function takes as a parameter, so parallel tests never share /var/tmp/roadmap.
import { runCli } from '../../src/cli/main.ts';
import { absPath } from '../../src/core/values.ts';

const [hostDir, ...argv] = process.argv.slice(2);
if (hostDir === undefined) throw new Error('usage: exec-cli <hostDir> <roadmap argv...>');
await runCli(argv, absPath(hostDir));
