// Small real docs publication for transport/recovery tests: the same docs.commit and integration.ff
// operations the pipeline uses, without backend calls or lanes.
import { join } from 'node:path';
import { arcId, jobIdOf, sha } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath, branchName, branchRef, repoPath } from '../../src/core/values.ts';
import { startIntegrationPushes } from '../../src/forge/integration-push.ts';
import { planDocs } from '../../src/git/docs.ts';
import { planDocsFf } from '../../src/git/ff.ts';
import { docsCommitOp, integrationFfOp } from '../../src/recover/ops.ts';
import { git, makeRepo, tmpDir } from '../helpers/repo.ts';
import { IDENTITY, runOp } from './git-common.ts';

export const BRANCH = branchName('arc/push');
export type PushScene = Readonly<{ repo: string; runDir: string }>;
export function pushScene(): PushScene {
  const repo = makeRepo(tmpDir('push-repo'), { files: { 'seed.txt': 'seed\n' } });
  git(repo, 'branch', BRANCH);
  return { repo, runDir: tmpDir('push-run') };
}
export function openPush(s: PushScene) {
  const repo = absPath(s.repo);
  const runDir = absPath(s.runDir);
  const journal = openJournal(runDir, arcId('push'));
  const pushes = startIntegrationPushes({ repo, runDir, journal });
  return { repo, runDir, journal, pushes };
}
export type PushRun = ReturnType<typeof openPush>;
export async function publish(r: PushRun, branch = BRANCH) {
  const pub = jobIdOf(`docs-${r.journal.view.opsOf('docs.commit').length + 1}`);
  const tip = sha(git(r.repo, 'rev-parse', branch));
  const docs = await runOp(r.journal, docsCommitOp(r.repo), `docs:${pub}`, planDocs(r.repo, {
    arc: r.journal.view.arc, pub, tip, files: [{ path: repoPath('docs.md'), bytes: Buffer.from(`${pub}\n`) }],
    worktree: absPath(join(r.runDir, pub)), identity: IDENTITY, message: `${pub}\n`,
  }));
  const ff = planDocsFf(r.repo, branchRef(branch), docs);
  if (ff.kind !== 'ff') throw new Error(`expected ff, got ${ff.kind}`);
  await runOp(r.journal, integrationFfOp(r.repo, () => true), 'integration:push', ff);
  return docs.post.new;
}
