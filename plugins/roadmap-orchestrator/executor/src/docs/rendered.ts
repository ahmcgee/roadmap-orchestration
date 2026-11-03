// The executor's rendered documents. Baseline evidence survives changes confined to these paths. Vision files, other
// product documentation and documents a ruling's contract ops edit (src/docs/contracts.ts: any product document, possibly
// a lane input) are deliberately outside this list.
import type { RepoPath } from '../core/values.ts';
import { CONSTRAINTS_DOC } from './constraints.ts';
import { DEBT_DOC } from './debt.ts';
import { INVARIANTS_DOC } from './invariants.ts';

export const EXECUTOR_DOC_PATHS = [CONSTRAINTS_DOC, INVARIANTS_DOC, DEBT_DOC] as const;

export const isExecutorDoc = (path: RepoPath): boolean => (EXECUTOR_DOC_PATHS as readonly string[]).includes(path);
