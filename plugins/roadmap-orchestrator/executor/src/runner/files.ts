// Typed access to one invocation's runner files. Every read validates the file and its {arc, op, inv}
// binding; every write goes through a temp file and an atomic rename (fsx.durableWrite), so a concurrent
// reader (the executor polling exit.json while the runner writes it) sees nothing or the whole file.
// runner.json is rewritten once (child: null, then the child); every other file is write-once.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AlreadyExistsError, durableWrite, readJson } from '../core/fsx.ts';
import { type InvocationId, parseInvocationId, parseOpId } from '../core/ids.ts';
import type { RunnerFiles } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { RUNNER_FILE_READERS, type RunnerFileMap, type RunnerFileName } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';

export class BindingMismatchError extends Error {
  constructor(path: string, field: string, expected: string, got: string) {
    super(`${path}: ${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    this.name = 'BindingMismatchError';
  }
}

type Bound = Readonly<{ arc: string; op: string; inv: string }>;

export function runnerFiles(invDir: AbsPath, inv: InvocationId): RunnerFiles {
  const { op } = parseInvocationId(inv);
  const arc = parseOpId(op).arc;
  const checkBinding = (path: string, file: Bound): void => {
    if (file.inv !== inv) throw new BindingMismatchError(path, 'inv', inv, file.inv);
    if (file.op !== op) throw new BindingMismatchError(path, 'op', op, file.op);
    if (file.arc !== arc) throw new BindingMismatchError(path, 'arc', arc, file.arc);
  };
  const files: RunnerFiles = {
    invDir,
    inv,
    read<N extends RunnerFileName>(name: N): RunnerFileMap[N] | null {
      const path = join(invDir, name);
      if (!existsSync(path)) return null;
      const file = RUNNER_FILE_READERS[name](readJson(path), name);
      checkBinding(path, file);
      return file;
    },
    write<N extends RunnerFileName>(name: N, content: RunnerFileMap[N]): void {
      const path = join(invDir, name);
      const bytes = canonicalJson(content);
      // Validate what we write exactly as a reader will, so a bad record fails here, not at recovery.
      checkBinding(path, RUNNER_FILE_READERS[name](JSON.parse(bytes), name));
      if (name !== 'runner.json' && existsSync(path)) throw new AlreadyExistsError(path);
      durableWrite(path, bytes);
    },
  };
  return files;
}
