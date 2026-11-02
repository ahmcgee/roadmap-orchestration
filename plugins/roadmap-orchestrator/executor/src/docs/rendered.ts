// The executor's rendered documents and published contracts. Baseline evidence survives changes confined to these
// paths; vision files and other product documentation are deliberately outside this list.
import type { RepoPath } from '../core/values.ts';
import { CONSTRAINTS_DOC } from './constraints.ts';
import { DEBT_DOC } from './debt.ts';
import { INVARIANTS_DOC } from './invariants.ts';

export const EXECUTOR_DOC_PATHS = [CONSTRAINTS_DOC, INVARIANTS_DOC, DEBT_DOC, 'contracts/'] as const;

export const isExecutorDoc = (path: RepoPath): boolean => EXECUTOR_DOC_PATHS.some((p) => p.endsWith('/') ? path.startsWith(p) : path === p);
