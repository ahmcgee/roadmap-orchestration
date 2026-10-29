// Execution equality shared by lane deduplication and Phase-0's near-duplicate advisory.
import { canonicalJson } from '../core/json.ts';
import type { LaneDef } from '../core/records.ts';

/** The command, working directory, declared environment and expected exit and timeout semantics; scheduling is not execution. */
export const executionShape = (l: LaneDef): string => canonicalJson({ argv: l.argv, cwd: l.cwd, set: l.env.set, pass: [...l.env.pass].sort(), expectedExit: l.expectedExit, ...(l.timeoutMin === undefined ? {} : { timeoutMin: l.timeoutMin }) });

export const sameExecution = (a: LaneDef, b: LaneDef): boolean => executionShape(a) === executionShape(b);
