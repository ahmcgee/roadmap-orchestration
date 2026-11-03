// Network git runs off the scheduler thread, with the executor's inherited user environment.
import { sha } from '../core/ids.ts';
import { absPath, branchName } from '../core/values.ts';
import { hasOrigin, pushBranch, PushDivergedError, PushError } from './push.ts';

const { repo, branch, head } = JSON.parse(process.argv[2]!) as { repo: string; branch: string; head: string };
try {
  const result = hasOrigin(absPath(repo)) ? pushBranch(absPath(repo), branchName(branch), sha(head)).kind : 'no-origin';
  process.send!({ result, error: null });
} catch (error) {
  if (!(error instanceof PushError)) throw error;
  process.send!({ result: error instanceof PushDivergedError ? 'diverged' : 'failed', error: error.message });
}
