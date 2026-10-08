// Givens (plan "Givens"): what cannot be tuned. Host scope `$(git rev-parse --git-common-dir)/roadmap/givens.json`
// (`roadmap/flow-givens-m4b`, write-once entries, never committed, surviving codespace rebuilds), each enforced only while
// its fingerprint matches the host (else `stale`); repo scope `.roadmap/config.json` `flow.givens` from the committed
// config. Both appear in `status.flow.givens` and a run's inputs. PLACEHOLDER (step 0a): step A2 replaces these bodies.
import { notYet } from '../core/notyet.ts';
import type { AbsPath, IsoTime } from '../core/values.ts';
import type { FlowLever, GivenInForce, HostFingerprint, HostGiven, HostGivens, RepoGiven } from './types.ts';

/** The host givens file of the repo whose git common dir is `commonDir`. */
export function givensPath(_commonDir: AbsPath): AbsPath {
  return notYet('givensPath', 'A2');
}

/** The host givens (none when the file is absent). */
export function readHostGivens(_commonDir: AbsPath): HostGivens {
  return notYet('readHostGivens', 'A2');
}

/** Appends one host given under `fingerprint` (the next `G-<n>`), or returns the equal one already there. */
export function declareHostGiven(_commonDir: AbsPath, _lever: FlowLever, _note: string, _fingerprint: HostFingerprint, _at: IsoTime): HostGiven {
  return notYet('declareHostGiven', 'A2');
}

/** The givens in force on a host with `fingerprint`: host givens (enforced or stale), then the repo's. */
export function givensInForce(_host: HostGivens, _repo: readonly RepoGiven[], _fingerprint: HostFingerprint): readonly GivenInForce[] {
  return notYet('givensInForce', 'A2');
}
