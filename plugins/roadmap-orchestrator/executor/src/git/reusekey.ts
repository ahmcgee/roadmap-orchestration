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
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type EnvId, type LaneId, type LaneRev, type Sha, sha } from '../core/ids.ts';
import type { LaneDef } from '../core/records.ts';
import type { AbsPath, RepoPath } from '../core/values.ts';
import { type SystemsMap, laneInput } from '../input/systems.ts';
import { catFileTrees, git, revParse } from './git.ts';
import { matchesPattern } from '../core/values.ts';

export type ReuseKey = Readonly<{ lane: LaneId; laneRev: LaneRev; envId: EnvId; inputSha: Sha }>;

/** A key's text, the index of every reuse store. */
export const reuseKeyText = (k: ReuseKey): string => `${k.inputSha}/${k.lane}/${k.laneRev}/${k.envId}`;

type Listing = readonly Readonly<{ line: string; path: RepoPath }>[];

/**
 * `git ls-tree -r` of a tree, per entry: its raw line and its path. Trees are immutable, so a listing is kept, least recently
 * used first, while the listings kept hold at most LISTING_ENTRIES entries (about 40 MB; the most recent is kept even when it
 * alone holds more). Nothing pins a listing: a history walk prefetches chunks that fit (`listingChunks`) and is done with each
 * tree before the next chunk, and the input shas it computes are remembered on their own (`inputShaOf`).
 */
const LISTINGS = new Map<Sha, Listing>();
export const LISTING_ENTRIES = 200_000;
let listingEntries = 0;

function keepListing(tree: Sha, out: Listing): void {
  const old = LISTINGS.get(tree);
  if (old !== undefined) { LISTINGS.delete(tree); listingEntries -= old.length; }
  LISTINGS.set(tree, out); listingEntries += out.length;
  for (const [kept, entries] of LISTINGS) {
    if (listingEntries <= LISTING_ENTRIES || LISTINGS.size === 1) break;
    LISTINGS.delete(kept); listingEntries -= entries.length;
  }
}

/** The entries the kept listings hold, of LISTING_ENTRIES. */
export const listingEntriesKept = (): number => listingEntries;

function listing(repo: AbsPath, tree: Sha): Listing {
  const known = LISTINGS.get(tree);
  if (known !== undefined) { LISTINGS.delete(tree); LISTINGS.set(tree, known); return known; }
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter((l) => l !== '').map((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) throw new Error(`git ls-tree ${tree}: no path in ${JSON.stringify(line)}`);
    return { line, path: line.slice(tab + 1) as RepoPath };
  });
  keepListing(tree, out);
  return out;
}

/**
 * `trees` in chunks whose listings fit the kept listings together: as many trees as LISTING_ENTRIES holds listings the size
 * of `known`'s (a tree of the same history, e.g. its head), from 1 to 32 per chunk.
 */
export function listingChunks(repo: AbsPath, known: Sha, trees: readonly Sha[]): readonly (readonly Sha[])[] {
  const size = Math.min(32, Math.max(1, Math.floor(LISTING_ENTRIES / Math.max(1, listing(repo, known).length))));
  const out: Sha[][] = [];
  for (let at = 0; at < trees.length; at += size) out.push(trees.slice(at, at + size));
  return out;
}

/** Batch remaining immutable trees by directory depth; reconstruct exactly ls-tree -r -z's entry order. Pass a chunk that fits (`listingChunks`). */
export function prefetchTreeListings(repo: AbsPath, trees: readonly Sha[]): void {
  const missing = trees.filter((t) => !LISTINGS.has(t));
  type Entry = { mode: string; name: string; object: Sha };
  const entries = new Map<Sha, Entry[]>();
  let pending = missing;
  while (pending.length > 0) {
    const next = new Set<Sha>();
    for (const [tree, bytes] of catFileTrees(repo, pending)) {
      const rows: Entry[] = [];
      for (let at = 0; at < bytes.length;) {
        const space = bytes.indexOf(32, at), nul = bytes.indexOf(0, space + 1);
        if (space < 0 || nul < 0 || nul + 21 > bytes.length) throw new Error(`malformed Git tree ${tree}`);
        const mode = bytes.toString('ascii', at, space).padStart(6, '0');
        const object = sha(bytes.subarray(nul + 1, nul + 21).toString('hex'));
        rows.push({ mode, name: bytes.toString('utf8', space + 1, nul), object });
        if (mode === '040000' && !entries.has(object)) next.add(object);
        at = nul + 21;
      }
      entries.set(tree, rows);
    }
    pending = [...next].filter((t) => !entries.has(t));
  }
  const flatten = (tree: Sha, prefix: string): { line: string; path: RepoPath }[] => entries.get(tree)!.flatMap((e) => {
    const path = `${prefix}${e.name}` as RepoPath;
    return e.mode === '040000' ? flatten(e.object, `${path}/`)
      : [{ path, line: `${e.mode} ${e.mode === '160000' ? 'commit' : 'blob'} ${e.object}\t${path}` }];
  });
  for (const tree of missing) keepListing(tree, flatten(tree, ''));
}

/**
 * Lane input hashes, `inputAt` key to sha, per scope. A lane with explicit patterns has one scope whatever the map. A lane read
 * through the systems map is scoped by the map's content (`mapScope`), not by the map object: every `plan-applied` fact carries
 * its own object, and an apply that leaves the map's content as it was keeps every hash. The two most recently used map scopes
 * are kept; a third content evicts the least recent (one content is in force; the second covers an arc moving between two).
 */
const EXPLICIT_INPUTS = new Map<string, Sha>();
const MAP_INPUTS = new Map<string, Map<string, Sha>>();
const MAP_SCOPES = 2;
/** Each map object's content key (sha256 of its canonical JSON), hashed once per object. */
const MAP_KEYS = new WeakMap<SystemsMap, string>();

function mapScope(map: SystemsMap): string {
  let key = MAP_KEYS.get(map);
  if (key === undefined) { key = sha256Hex(canonicalJson(map)); MAP_KEYS.set(map, key); }
  return key;
}

/** The memo of `lane`'s inputs under `map`, made the most recently used map scope. */
function inputsMemo(lane: Pick<LaneDef, 'inputs'>, map: SystemsMap | null): Map<string, Sha> {
  if (lane.inputs !== undefined) return EXPLICIT_INPUTS;
  const scope = mapScope(map!);
  const memo = MAP_INPUTS.get(scope) ?? new Map<string, Sha>();
  MAP_INPUTS.delete(scope); MAP_INPUTS.set(scope, memo);
  for (const old of MAP_INPUTS.keys()) {
    if (MAP_INPUTS.size <= MAP_SCOPES) break;
    MAP_INPUTS.delete(old);
  }
  return memo;
}

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
 * depend on the map's content and lane systems. The listing above is the one source for both kinds of input.
 */
const inputAt = (tree: Sha, lane: Pick<LaneDef, 'systems' | 'inputs'>): string => `${tree}/${JSON.stringify(lane.inputs === undefined ? lane.systems ?? null : lane.inputs)}`;

/** Whether `inputShaOf` answers for `lane` on `tree` without the tree's listing: a history walk prefetches only the others. */
export function inputKnown(tree: Sha, lane: Pick<LaneDef, 'systems' | 'inputs'>, map: SystemsMap | null): boolean {
  if (map === null && lane.inputs === undefined) return true;
  return (lane.inputs === undefined ? MAP_INPUTS.get(mapScope(map!)) : EXPLICIT_INPUTS)?.has(inputAt(tree, lane)) === true;
}

export function inputShaOf(repo: AbsPath, tree: Sha, lane: Pick<LaneDef, 'systems' | 'inputs'>, map: SystemsMap | null): Sha {
  if (map === null && lane.inputs === undefined) return tree;
  const memo = inputsMemo(lane, map);
  const at = inputAt(tree, lane);
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
