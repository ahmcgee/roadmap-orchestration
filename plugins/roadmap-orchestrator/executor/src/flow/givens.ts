// Givens (plan "Givens"): what cannot be tuned. Host scope `$(git rev-parse --git-common-dir)/roadmap/givens.json`
// (`roadmap/flow-givens-m4b`, write-once entries, never committed, surviving codespace rebuilds), each enforced only while
// its fingerprint matches the host (else `stale`); repo scope `.roadmap/config.json` `flow.givens` from the committed
// config (src/preflight/checks.ts `committedRepoConfig`). Both appear in `status.flow.givens` and a run's inputs.
//
// The host file is rewritten whole on each declaration (atomic replace), every earlier entry carried byte-for-byte: an
// entry, once written, never changes and its id is never reused. One arc per host, and `flow given` is the only writer.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicJson, durableMkdir, readJson } from '../core/fsx.ts';
import { givenIdOf } from '../core/ids.ts';
import { type AbsPath, type IsoTime, absPath } from '../core/values.ts';
import type { RepoConfig } from '../routing/layers.ts';
import {
  type FlowLever, type GivenInForce, type HostFingerprint, type HostGiven, type HostGivens, type RepoGiven, HOST_GIVENS_SCHEMA, parseHostGivens, sameHost,
} from './types.ts';

/** The host givens file of the repo whose git common dir is `commonDir`. */
export function givensPath(commonDir: AbsPath): AbsPath {
  return absPath(join(commonDir, 'roadmap', 'givens.json'));
}

/** The host givens (none when the file is absent). */
export function readHostGivens(commonDir: AbsPath): HostGivens {
  const path = givensPath(commonDir);
  return existsSync(path) ? parseHostGivens(readJson(path)) : { schema: HOST_GIVENS_SCHEMA, givens: [] };
}

/** Appends one host given under `fingerprint` (the next `G-<n>`), or returns the equal one already there. */
export function declareHostGiven(commonDir: AbsPath, lever: FlowLever, note: string, fingerprint: HostFingerprint, at: IsoTime): HostGiven {
  const current = readHostGivens(commonDir);
  const equal = current.givens.find((g) => g.lever === lever && g.note === note && sameHost(g.fingerprint, fingerprint));
  if (equal !== undefined) return equal;
  const given: HostGiven = { id: givenIdOf(current.givens.length + 1), lever, note, fingerprint, at };
  const path = givensPath(commonDir);
  durableMkdir(dirname(path));
  atomicJson(path, parseHostGivens({ schema: HOST_GIVENS_SCHEMA, givens: [...current.givens, given] }));
  return given;
}

/** The repo givens a committed `.roadmap/config.json` declares (none without one, or without `flow`). */
export function repoGivensOf(config: RepoConfig | null): readonly RepoGiven[] {
  return config?.flow?.givens ?? [];
}

/** The givens in force on a host with `fingerprint`: host givens (enforced or stale), then the repo's. */
export function givensInForce(host: HostGivens, repo: readonly RepoGiven[], fingerprint: HostFingerprint): readonly GivenInForce[] {
  return [
    ...host.givens.map((g): GivenInForce => ({ scope: 'host', id: g.id, lever: g.lever, note: g.note, state: sameHost(g.fingerprint, fingerprint) ? 'enforced' : 'stale' })),
    ...repo.map((g): GivenInForce => ({ scope: 'repo', lever: g.lever, note: g.note })),
  ];
}
