// The whole-pipeline matrix's crash cells, test-only (production code keeps one seam, `crashPoint`). Loaded
// into every roadmap process of a crash run by NODE_OPTIONS=--import=<this file>; it acts only in the
// supervisor. Once the crash trigger has fired (the executor renames it to `.fired`, then SIGKILLs itself),
// the supervisor stops itself (SIGSTOP) for the watcher (pm-common.ts), which adjusts the scenario and lets
// it go on (SIGCONT).
//
// Why here and not from the watcher: the supervisor learns of the crash only after the rename, then sleeps
// its backoff. This poll's next tick expires before that backoff timer does, and libuv runs expired timers
// in expiry order, so the supervisor always stops before it restarts the executor, however loaded the host
// is. A watcher in the test process had to win the 2 s backoff on its own event loop, and under a full
// suite it sometimes did not.
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

const POLL_MS = 10;
const trigger = process.env['ROADMAP_TEST_CRASH'];
if (trigger === undefined || trigger === '') throw new Error('pm-stop: ROADMAP_TEST_CRASH is not set');

if (basename(process.argv[1] ?? '') === 'supervisor.ts') {
  const poll = setInterval(() => {
    if (!existsSync(`${trigger}.fired`)) return;
    clearInterval(poll);
    process.kill(process.pid, 'SIGSTOP');
  }, POLL_MS);
  poll.unref();
}
