// Recovery of an open `spec.patch` intent (plan "Recovery"): the file's hash alone decides. The write is a
// durable temp-and-rename, so a crash leaves the old bytes or the new ones; anything else means someone
// else changed the file, and recovery parks rather than guess.
import { existsSync } from 'node:fs';
import type { Reconciler } from '../core/interfaces.ts';
import { fileSha256 } from '../spec/spec.ts';

export const reconcileSpecPatch: Reconciler<'spec.patch'> = async (intent) => {
  const { path, oldSha256 } = intent.expect;
  if (!existsSync(path)) return { kind: 'park', detail: `spec file ${path} is missing` };
  const actual = fileSha256(path);
  if (actual === intent.post.newSha256) return { kind: 'done', outcome: { kind: 'patched' } };
  if (actual === oldSha256) return { kind: 'redo' };
  return { kind: 'park', detail: `spec file ${path} hashes to ${actual}, neither the old ${oldSha256} nor the new ${intent.post.newSha256}` };
};
