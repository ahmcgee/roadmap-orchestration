// The reuse key (dev.17, DESIGN-1.0.md §2.7 "Plan, specs and certification lanes"): the one key every lane run is reused by, a spec or suite lane's
// clean pass (src/pipeline/lanes.ts `reusablePass`, the batch skip) and an arc lane's observation (src/holistic/observe.ts)
// alike: `(lane, laneRev, envId, inputSha)`.
//
//   laneRev   the lane's normalised definition (src/holistic/types.ts `laneRevOf`);
//   envId     the host and the values of the variables it passes through (src/holistic/witness.ts `envIdOf`);
//   inputSha  the content of the paths the lane reads on the tree (src/input/systems.ts `laneInput`): with no systems map
//             the tree id itself (every path), so a key written before dev.17 (a `witnessed` fact's `treeSha`, an arc with
//             no map) is the same key; with a map, always the sha1 of the `git ls-tree -r` entries kept (one encoding: two
//             trees with the same input get the same key, whatever else they hold).
//
// A spec or suite lane's key also binds argv[0]'s resolved program and its content (the lane spawn's `identity`): a tool
// upgraded under the same path is another environment. An arc lane's witness record names its reporter's output instead.
import { createHash } from 'node:crypto';
import { type EnvId, type LaneId, type LaneRev, type Sha, sha } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import type { AbsPath, RepoPath } from '../core/values.ts';
import { type SystemsMap, laneInput } from '../input/systems.ts';
import { git, revParse } from './git.ts';
import { matchesPattern } from '../core/values.ts';

export type ReuseKey = Readonly<{ lane: LaneId; laneRev: LaneRev; envId: EnvId; inputSha: Sha }>;

/** A key's text, the index of every reuse store. */
export const reuseKeyText = (k: ReuseKey): string => `${k.inputSha}/${k.lane}/${k.laneRev}/${k.envId}`;

/**
 * `git ls-tree -r` of a tree, per entry: its raw line and its path. Trees are immutable, so a listing is kept, the
 * `LISTINGS_KEPT` latest only between reads (a long arc lists a tree per candidate). A status computation retains
 * its whole working set: walking more than 32 historical trees for each lane must not evict the next lane's listings.
 */
const LISTINGS = new Map<Sha, readonly Readonly<{ line: string; path: RepoPath }>[]>();
const LISTINGS_KEPT = 32;
let listingReaders = 0;

function trimListings(): void {
  if (listingReaders > 0) return;
  while (LISTINGS.size > LISTINGS_KEPT) LISTINGS.delete(LISTINGS.keys().next().value!);
}

/** Retain the canonical listings throughout a synchronous read, then restore the process's bounded working set. */
export function withTreeListings<T>(read: () => T): T {
  listingReaders++;
  try { return read(); }
  finally { listingReaders--; trimListings(); }
}

function listing(repo: AbsPath, tree: Sha): readonly Readonly<{ line: string; path: RepoPath }>[] {
  const known = LISTINGS.get(tree);
  if (known !== undefined) return known;
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter((l) => l !== '').map((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) throw new Error(`git ls-tree ${tree}: no path in ${JSON.stringify(line)}`);
    return { line, path: line.slice(tab + 1) as RepoPath };
  });
  LISTINGS.set(tree, out);
  trimListings();
  return out;
}

const INPUTS = new WeakMap<object, Map<string, Sha>>();
const NO_MAP = {};
const COMMIT_TREES = new Map<Sha, Sha>();

/** A commit's tree is immutable, including when the branch that named the commit advances. */
export function treeOfCommit(repo: AbsPath, commit: Sha): Sha {
  const known = COMMIT_TREES.get(commit);
  if (known !== undefined) return known;
  const tree = revParse(repo, `${commit}^{tree}`);
  COMMIT_TREES.set(commit, tree);
  return tree;
}

/**
 * The input of `lane` on `tree` (an immutable object id). Explicit patterns override systems and the map, so their
 * hashes share one memo across plan revisions and callers (including external witnesses). Only implicit inputs
 * depend on the map's identity and lane systems. The listing above is the one source for both kinds of input.
 */
export function inputShaOf(repo: AbsPath, tree: Sha, lane: Pick<LaneDef, 'systems' | 'inputs'>, map: SystemsMap | null): Sha {
  if (map === null && lane.inputs === undefined) return tree;
  const scope = lane.inputs === undefined ? map! : NO_MAP;
  const memo = INPUTS.get(scope) ?? new Map<string, Sha>();
  INPUTS.set(scope, memo);
  const at = `${tree}/${JSON.stringify(lane.inputs === undefined ? lane.systems ?? null : lane.inputs)}`;
  const known = memo.get(at);
  if (known !== undefined) return known;
  let out = tree;
  if (map !== null || lane.inputs !== undefined) {
    const entries = listing(repo, tree);
    const keep = lane.inputs === undefined ? laneInput(map!, lane) : (path: RepoPath) => lane.inputs!.some((p) => matchesPattern(path, p));
    out = sha(createHash('sha1').update(entries.filter((e) => keep(e.path)).map((e) => `${e.line}\0`).join('')).digest('hex'));
  }
  memo.set(at, out);
  return out;
}
