// The reuse key (dev.17, DESIGN-1.0.md §4 "Lane topology"): the one key every lane run is reused by, a spec or suite lane's
// clean pass (src/pipeline/lanes.ts `reusablePass`, the batch skip) and an arc lane's observation (src/holistic/observe.ts)
// alike: `(lane, laneRev, envId, inputSha)`.
//
//   laneRev   the lane's normalised definition (src/holistic/types.ts `laneRevOf`);
//   envId     the host and the values of the variables it passes through (src/holistic/witness.ts `envIdOf`);
//   inputSha  the content of the paths the lane reads on the tree (src/input/systems.ts `laneInput`): the tree id itself
//             when that is every path (no systems map, or nothing of the tree left out), so a key written before dev.17
//             (a `witnessed` fact's `treeSha`) is the same key; else the sha1 of the `git ls-tree -r` entries kept.
//
// A spec or suite lane's key also binds argv[0]'s resolved program and its content (the lane spawn's `identity`): a tool
// upgraded under the same path is another environment. An arc lane's witness record names its reporter's output instead.
import { createHash } from 'node:crypto';
import { type EnvId, type LaneId, type LaneRev, type Sha, sha } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import type { AbsPath, RepoPath } from '../core/values.ts';
import { type SystemsMap, laneInput } from '../input/systems.ts';
import { git } from './git.ts';

export type ReuseKey = Readonly<{ lane: LaneId; laneRev: LaneRev; envId: EnvId; inputSha: Sha }>;

/** A key's text, the index of every reuse store. */
export const reuseKeyText = (k: ReuseKey): string => `${k.inputSha}/${k.lane}/${k.laneRev}/${k.envId}`;

/**
 * `git ls-tree -r` of a tree, per entry: its raw line and its path. Trees are immutable, so a listing is kept, the
 * `LISTINGS_KEPT` latest only (a long arc lists a tree per candidate).
 */
const LISTINGS = new Map<Sha, readonly Readonly<{ line: string; path: RepoPath }>[]>();
const LISTINGS_KEPT = 32;

function listing(repo: AbsPath, tree: Sha): readonly Readonly<{ line: string; path: RepoPath }>[] {
  const known = LISTINGS.get(tree);
  if (known !== undefined) return known;
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter((l) => l !== '').map((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) throw new Error(`git ls-tree ${tree}: no path in ${JSON.stringify(line)}`);
    return { line, path: line.slice(tab + 1) as RepoPath };
  });
  LISTINGS.set(tree, out);
  if (LISTINGS.size > LISTINGS_KEPT) LISTINGS.delete(LISTINGS.keys().next().value!);
  return out;
}

const INPUTS = new WeakMap<object, Map<string, Sha>>();
const NO_MAP = {};

/** The input of `lane` on `tree` (a tree id) under `map` (see the header), memoised per map, lane systems and tree. */
export function inputShaOf(repo: AbsPath, tree: Sha, lane: Pick<LaneDef, 'systems'>, map: SystemsMap | null): Sha {
  const memo = INPUTS.get(map ?? NO_MAP) ?? new Map<string, Sha>();
  INPUTS.set(map ?? NO_MAP, memo);
  const at = `${tree}/${JSON.stringify(lane.systems ?? null)}`;
  const known = memo.get(at);
  if (known !== undefined) return known;
  let out = tree;
  if (map !== null) {
    const entries = listing(repo, tree);
    const keep = laneInput(map, lane);
    const kept = entries.filter((e) => keep(e.path));
    if (kept.length < entries.length) out = sha(createHash('sha1').update(kept.map((e) => `${e.line}\0`).join('')).digest('hex'));
  }
  memo.set(at, out);
  return out;
}
