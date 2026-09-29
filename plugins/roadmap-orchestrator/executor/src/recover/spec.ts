// Recovery of an open `spec.patch` intent (plan "Recovery"): the kept spec bytes decide. The patched spec
// kept means the op is done; the old spec still kept (or still the file's content) means it is redone; with
// neither, recovery parks rather than guess. An architect's edit of the spec file is not the op's business.
import { existsSync } from 'node:fs';
import type { Reconciler } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import { SPEC_INPUT, keptInput } from '../input/inforce.ts';
import { fileSha256 } from '../spec/spec.ts';

export function reconcileSpecPatch(runDir: AbsPath): Reconciler<'spec.patch'> {
  return async (intent) => {
    const { path, oldSha256 } = intent.expect;
    if (keptInput(runDir, intent.post.newSha256, SPEC_INPUT) !== null) return { kind: 'done', outcome: { kind: 'patched' } };
    if (keptInput(runDir, oldSha256, SPEC_INPUT) !== null) return { kind: 'redo' };
    if (existsSync(path) && fileSha256(path) === oldSha256) return { kind: 'redo' };
    return { kind: 'park', detail: `neither the patched spec ${intent.post.newSha256} nor the old ${oldSha256} is kept in the run dir, and ${path} holds neither` };
  };
}
