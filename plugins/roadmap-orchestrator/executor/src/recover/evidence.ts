// Reconciler for an open `evidence.snapshot` intent (plan "Recovery"): a complete manifest whose files
// all hash as listed, and which lists exactly the source's current evidence set → done; anything else
// → redo, which is an idempotent copy that fills the gaps.
//
// Uses src/git/evidence.ts's pure helpers and git.ts plumbing only; src/recover/ops.ts assembles the op.
import type { IntentOf } from '../core/events.ts';
import type { Disposition, JournalView } from '../core/interfaces.ts';
import { checkManifest, listEvidence } from '../git/evidence.ts';

export async function reconcileEvidenceSnapshot(
  intent: IntentOf<'evidence.snapshot'>,
  _view: JournalView,
): Promise<Extract<Disposition<'evidence.snapshot'>, { kind: 'done' | 'redo' }>> {
  const { source, globs, dest } = intent.expect;
  const check = checkManifest(dest);
  if (check.kind !== 'verified') return { kind: 'redo' };
  const listed = check.manifest.files.map((e) => `${e.path} ${e.sha256}`).join('\n');
  const current = listEvidence(source, globs).map((e) => `${e.path} ${e.sha256}`).join('\n');
  if (listed !== current) return { kind: 'redo' };
  return { kind: 'done', outcome: { kind: 'captured', manifestSha256: check.manifestSha256, files: check.manifest.files.length } };
}
