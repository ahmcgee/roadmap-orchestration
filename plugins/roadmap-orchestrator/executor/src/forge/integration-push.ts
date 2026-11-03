// Automatic origin publication (dev.44). One serial network worker at a time; only the executor thread
// writes the journal. Durable done records cover every live ff site; startup covers recovered ffs.
// Startup publishes the current ref, so death before enqueue or before recording a network result is
// harmless. Remote-equals-head is a no-op. Failed attempts retry only at the next ff or startup.
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crashPoint } from '../core/crash.ts';
import { type IntegrationPushFact, parentUnit } from '../core/events.ts';
import type { NeedsUserId, Sha } from '../core/ids.ts';
import type { OpenJournal } from '../core/log.ts';
import { type AbsPath, type BranchName, absPath, branchName, refName } from '../core/values.ts';
import { refTarget } from '../git/git.ts';
import { openNeedsUser, raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import { PUSH_TIMEOUT_MS } from './push.ts';

type Result = Pick<IntegrationPushFact, 'result' | 'error'>;
type Context = Readonly<{ journal: OpenJournal; repo: AbsPath; runDir: AbsPath }>;

function network(repo: AbsPath, branch: BranchName, head: Sha): Promise<Result> {
  return new Promise((resolve) => {
    // A separate process group lets the wall deadline kill git and its credential/SSH descendants,
    // including helpers that ignore TERM. No network call runs on the scheduler's event loop.
    const worker = fork(fileURLToPath(new URL('./push-worker.ts', import.meta.url)), [JSON.stringify({ repo, branch, head })], {
      env: process.env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result: Result | null = null;
    let stderr = '';
    worker.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => {
      result = { result: 'failed', error: `git origin publication of ${branch} at ${head} timed out after ${PUSH_TIMEOUT_MS}ms` };
      if (worker.pid !== undefined) {
        try { process.kill(-worker.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }, PUSH_TIMEOUT_MS);
    worker.on('message', (message: Result) => { result = message; });
    worker.on('error', (error) => { result = { result: 'failed', error: `git publication worker: ${error.message}` }; });
    // Join before another push; a normal executor exit cannot close the journal underneath a result.
    worker.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(result ?? { result: 'failed', error: `git publication worker exited ${code ?? signal} without a result: ${stderr.trim()}` });
    });
  });
}

/** Attach after journal recovery, then recover(current branch); join drain()/close() outside stages. */
export function startIntegrationPushes(ctx: Context): Readonly<{
  recover: (branch: BranchName) => void;
  drain: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const { journal, repo, runDir } = ctx;
  let tail = Promise.resolve();
  let fatal: unknown = null;

  const pushItems = (): readonly NeedsUserId[] => openNeedsUser(journal.view).flatMap((n) => {
    const item = readNeedsUser(runDir, n.id);
    return item?.reason === 'push-failed' || item?.reason === 'push-diverged' ? [n.id] : [];
  });

  // Facts precede notices. Reconstruct an episode cut between its failed fact and its raise, even
  // when the next attempt will succeed. A named ack does not manufacture a new failure episode.
  function restoreNotices(): void {
    const pending = new Map<'failed' | 'diverged', { seq: number; fact: IntegrationPushFact }>();
    for (const p of journal.view.integrationPushes()) {
      if (p.fact.result === 'pushed' || p.fact.result === 'up-to-date') pending.clear();
      else if ((p.fact.result === 'failed' || p.fact.result === 'diverged') && !pending.has(p.fact.result)) pending.set(p.fact.result, p);
    }
    for (const { seq, fact } of pending.values()) {
      const evidence = `integration-push failure episode: fact ${seq}`;
      if (journal.view.needsUser().some((n) => readNeedsUser(runDir, n.id)?.summary.startsWith(evidence))) continue;
      const reason = fact.result === 'diverged' ? 'push-diverged' : 'push-failed';
      raiseNeedsUser(journal, runDir, {
        reason, blocking: false, subject: { type: 'arc' },
        summary: `${evidence}: origin publication of ${fact.branch} at ${fact.head}: ${fact.error}`,
        recommendation: reason === 'push-diverged'
          ? 'Preserve the remote work and make its tip an ancestor of integration, or acknowledge this item by id. Later publications check ancestry again; roadmap never overwrites a diverged tip. A later successful push settles this notice.'
          : 'Resolve the git/network/credential error. The arc continues; the next integration publication or startup retries the current head. A later successful push settles this notice.',
        options: [], evidence: [absPath(join(runDir, 'events.jsonl'))],
      }, { type: 'arc' });
    }
  }

  function request(branch: BranchName, head: Sha): void {
    tail = tail.then(async () => {
      if (fatal !== null) return;
      restoreNotices();
      const outcome = await network(repo, branch, head);
      crashPoint('integration-push.after-network');
      if (outcome.result === 'no-origin' && journal.view.integrationPushes().some((p) => p.fact.result === 'no-origin')) return;
      const success = outcome.result === 'pushed' || outcome.result === 'up-to-date';
      journal.fact({ kind: 'integration-push', branch, head, ...outcome, settles: success ? pushItems() : [] });
      crashPoint('integration-push.after-result');
      restoreNotices();
    }).catch((error: unknown) => {
      // Expected git and network failures are results, not throws (push-worker.ts). Anything that reaches here is a defect
      // (a journal or needs-user write failing): crash the executor at once so the supervisor restarts it and recovery
      // retries, rather than pushes stopping silently until the arc ends.
      fatal = error;
      setImmediate(() => { throw error; });
    });
  }

  const unsubscribe = journal.subscribe((event) => {
    if (event.type !== 'done' || event.kind !== 'integration.ff' || event.outcome.kind !== 'published') return;
    const ff = journal.view.latestIntent(event.op);
    if (ff.kind !== 'integration.ff') throw new Error(`publication ${event.op} has no integration.ff intent`);
    if (!ff.expect.ref.startsWith('refs/heads/')) throw new Error(`integration publication targets a non-branch ref: ${ff.expect.ref}`);
    crashPoint('integration-push.after-ff', parentUnit(ff.parent));
    request(branchName(ff.expect.ref.slice('refs/heads/'.length)), ff.expect.new);
  });

  async function drain(): Promise<void> {
    let joined: Promise<void>;
    do { joined = tail; await joined; } while (joined !== tail);
    if (fatal !== null) throw fatal;
  }
  return {
    recover: (branch) => {
      restoreNotices();
      const head = refTarget(repo, refName(`refs/heads/${branch}`));
      if (head === null) throw new Error(`integration branch ${branch} is missing at push recovery`);
      request(branch, head);
    },
    drain,
    close: async () => { unsubscribe(); await drain(); },
  };
}
