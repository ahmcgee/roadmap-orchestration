// A stand-in for a revision's docs publication (step A4's src/pipeline/publish.ts) behind `DocsPublisher`, for the
// revision tests until A4 lands: it leaves in the log what recovery reads (src/recover/revision.ts `docsStateOf`), a
// docs `integration.ff` (subject docs{pub}, parent job{docs-n}) moving the integration branch to a commit on its tip,
// with the ref really moved (real git). No lanes, no rendered files: those are A4's.
import { opKey, sha } from '../../src/core/ids.ts';
import type { Journal } from '../../src/core/interfaces.ts';
import { type AbsPath, type BranchName, branchRef } from '../../src/core/values.ts';
import type { DocsPublisher } from '../../src/recover/revision.ts';
import { git } from '../helpers/repo.ts';

export function fakeDocs(journal: Journal, repo: AbsPath, branch: BranchName): DocsPublisher {
  return async () => {
    const pub = journal.view.nextJobId('docs');
    const ref = branchRef(branch);
    const old = sha(git(repo, 'rev-parse', ref));
    const commit = sha(git(repo, 'commit-tree', `${old}^{tree}`, '-p', old, '-m', `docs ${pub}`));
    const { op } = journal.begin({
      kind: 'integration.ff', key: opKey(`integration:docs:${pub}`), parent: { type: 'job', job: pub }, deadlineAt: null,
      body: () => ({ expect: { ref, old, new: commit, subject: { type: 'docs', pub } }, post: null }),
    });
    git(repo, 'update-ref', ref, commit, old);
    journal.done(op, 'integration.ff', { kind: 'published' }, null);
    return { kind: 'published', publication: { pub, head: commit } };
  };
}
