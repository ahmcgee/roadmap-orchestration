// The fake `gh`'s state (M4a step 0b): one JSON file, the whole forge. The fake (fake-gh.ts) reads it on every call and
// rewrites it by atomic rename on a mutation; tests change it between calls (test/helpers/forge.ts), so a policy flip
// mid-run is a rewrite of this file. Calls are logged beside it in `gh-calls.jsonl`.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthorAssociation, IssuePolicy, RepoIdentity } from '../../src/forge/types.ts';

export type GhUser = Readonly<{ login: string }>;

/** A REST comment of an issue or PR entry. */
export type GhComment = Readonly<{ id: number; user: GhUser; author_association: AuthorAssociation; body: string }>;

/** An entry of the REST issues endpoint. A pull request is an issue entry carrying `pull_request`, as on GitHub. */
export type GhIssue = Readonly<{
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: readonly Readonly<{ name: string }>[];
  user: GhUser;
  author_association: AuthorAssociation;
  pull_request?: Readonly<{ url: string }>;
}>;

export type GhPullState = 'OPEN' | 'MERGED' | 'CLOSED';
/** The fields `gh pr list|view --json` can name. */
export type GhPull = Readonly<{
  number: number;
  title: string;
  body: string;
  state: GhPullState;
  url: string;
  baseRefName: string;
  headRefName: string;
  mergeCommit: Readonly<{ oid: string }> | null;
  isDraft: boolean;
}>;

/**
 * What the forge was asked to change: the fixture's injection check reads this (a PR, a label). `call` is the 1-based
 * sequence number of the logged call (`GhCallRecord.seq`).
 */
export type GhMutation =
  | Readonly<{ call: number; kind: 'pr-create'; number: number; base: string; head: string; title: string }>
  | Readonly<{ call: number; kind: 'pr-edit'; number: number; fields: Readonly<Record<string, string>> }>
  | Readonly<{ call: number; kind: 'label-create'; name: string }>
  | Readonly<{ call: number; kind: 'labels-add' | 'labels-remove'; number: number; labels: readonly string[] }>;

export type GhStore = Readonly<{
  repo: RepoIdentity;
  policy: IssuePolicy;
  /** A bare repo path: `pr create --head <b>` fails unless it holds `refs/heads/<b>`, as gh does for an unpushed branch. */
  originPath: string | null;
  /** The shared issue/PR number space; the next number to hand out. */
  nextNumber: number;
  nextCommentId: number;
  issues: readonly GhIssue[];
  /** Comments by issue/PR number (string keys: JSON). */
  comments: Readonly<Record<string, readonly GhComment[]>>;
  labels: readonly string[];
  pulls: readonly GhPull[];
  mutations: readonly GhMutation[];
}>;

/** One logged call: argv, cwd, and what it carried to the forge (`--hostname`, owner and name), null when it named none. */
export type GhCallRecord = Readonly<{
  seq: number;
  argv: readonly string[];
  cwd: string;
  hostname: string | null;
  owner: string | null;
  name: string | null;
  status: number;
  /** Set for a call that touched the forge: `repo-view`, `graphql`, `rest`, `pr-list`... */
  kind: string;
}>;

export const STORE_FILE = 'gh-store.json';
export const GH_CALLS_FILE = 'gh-calls.jsonl';

export function readStore(storePath: string): GhStore {
  return JSON.parse(readFileSync(storePath, 'utf8')) as GhStore;
}

export function writeStore(storePath: string, store: GhStore): void {
  const tmp = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, storePath);
}

/** The sequence number the next logged call takes. */
export function nextSeq(storePath: string): number {
  return readGhCalls(storePath).length + 1;
}

export function appendCall(storePath: string, record: GhCallRecord): void {
  appendFileSync(join(dirname(storePath), GH_CALLS_FILE), `${JSON.stringify(record)}\n`);
}

export function readGhCalls(storePath: string): readonly GhCallRecord[] {
  const path = join(dirname(storePath), GH_CALLS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as GhCallRecord);
}
