// A fake forge for tests (M4a step 0b): the stateful fake `gh` (test/fakes/fake-gh.ts) over a JSON store this helper
// seeds and edits between calls. `forge.binDir` goes first on PATH; `forge.read()` is the whole forge; `forge.calls()` is
// every call with the hostname, owner and name it carried.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AuthorAssociation, AUTHOR_ASSOCIATIONS, type IssuePolicy, type RepoIdentity } from '../../src/forge/types.ts';
import { type GhCallRecord, type GhComment, type GhIssue, type GhPull, type GhStore, STORE_FILE, readGhCalls, readStore, writeStore } from '../fakes/gh-store.ts';
import { writeGhShim } from '../fakes/shim.ts';
import { tmpDir } from './repo.ts';

export const DEFAULT_REPO: RepoIdentity = { host: 'forge.test', owner: 'tidewater', name: 'harbour' };
/** PUBLIC + COLLABORATORS_ONLY: trusted under OR-L6 (the fixture's policy). */
export const TRUSTED_POLICY: IssuePolicy = { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'COLLABORATORS_ONLY' };
/** PUBLIC + ALL: untrusted under OR-L6. */
export const UNTRUSTED_POLICY: IssuePolicy = { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'ALL' };

/** The associations whose comments are kept (the test's own oracle, independent of production's filter). */
export const KEPT_ASSOCIATIONS: readonly AuthorAssociation[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];
/** One entry per `author_association`, with whether a comment of a non-author is kept. */
export const ASSOCIATION_MATRIX: readonly Readonly<{ association: AuthorAssociation; kept: boolean }>[] = AUTHOR_ASSOCIATIONS.map((association) => ({
  association, kept: KEPT_ASSOCIATIONS.includes(association),
}));

export type ForgeInit = Readonly<{ repo?: RepoIdentity; policy?: IssuePolicy; originPath?: string }>;

export type NewIssue = Readonly<{ title: string; body?: string; labels?: readonly string[]; author?: string; association?: AuthorAssociation; state?: 'open' | 'closed' }>;
export type NewComment = Readonly<{ body: string; author?: string; association?: AuthorAssociation }>;

export type Forge = Readonly<{
  dir: string;
  storePath: string;
  binDir: string;
  /** `PATH` with the fake gh first. */
  path: string;
  read(): GhStore;
  calls(): readonly GhCallRecord[];
  /** Rewrite the store (a policy flip mid-run is `setPolicy`). */
  update(edit: (s: GhStore) => GhStore): void;
  setPolicy(policy: IssuePolicy): void;
  /** Adds an issue (labels are created in the repo as needed); returns its number. */
  addIssue(issue: NewIssue): number;
  /** Adds a pull-request entry to the issues endpoint (with `pull_request`), not a `gh pr` PR; returns its number. */
  addPullEntry(issue: NewIssue): number;
  /** Adds a comment; returns its REST id. */
  addComment(issueNumber: number, comment: NewComment): number;
  /** A PR as `gh pr list` returns it, state OPEN; returns its number. */
  addPull(pull: Readonly<{ head: string; base: string; title?: string; body?: string }>): number;
  /** The PR is merged (mergeCommit `oid`) or closed. */
  setPullState(number: number, state: 'MERGED' | 'CLOSED', oid?: string): void;
}>;

const label = (name: string): { name: string } => ({ name });

export function makeForge(init: ForgeInit = {}): Forge {
  const dir = tmpDir('forge');
  const storePath = join(dir, STORE_FILE);
  const binDir = join(dir, 'bin');
  mkdirSync(dir, { recursive: true });
  const empty: GhStore = {
    repo: init.repo ?? DEFAULT_REPO, policy: init.policy ?? TRUSTED_POLICY, originPath: init.originPath ?? null,
    nextNumber: 1, nextCommentId: 1000, issues: [], comments: {}, labels: [], pulls: [], mutations: [],
  };
  writeFileSync(storePath, `${JSON.stringify(empty)}\n`);
  writeGhShim(binDir, storePath);
  const update = (edit: (s: GhStore) => GhStore): void => writeStore(storePath, edit(readStore(storePath)));
  const add = (issue: NewIssue, pr: boolean): number => {
    let number = 0;
    update((s) => {
      number = s.nextNumber;
      const entry: GhIssue = {
        number, title: issue.title, body: issue.body ?? null, state: issue.state ?? 'open', labels: (issue.labels ?? []).map(label),
        user: { login: issue.author ?? 'someone' }, author_association: issue.association ?? 'NONE',
        ...(pr ? { pull_request: { url: `https://${s.repo.host}/${s.repo.owner}/${s.repo.name}/pull/${number}` } } : {}),
      };
      const labels = [...s.labels, ...(issue.labels ?? []).filter((l) => !s.labels.includes(l))];
      return { ...s, nextNumber: number + 1, issues: [...s.issues, entry], labels };
    });
    return number;
  };
  return {
    dir, storePath, binDir, path: `${binDir}:${process.env['PATH'] ?? ''}`,
    read: () => readStore(storePath),
    calls: () => readGhCalls(storePath),
    update,
    setPolicy: (policy) => update((s) => ({ ...s, policy })),
    addIssue: (issue) => add(issue, false),
    addPullEntry: (issue) => add(issue, true),
    addComment(issueNumber, comment) {
      let id = 0;
      update((s) => {
        id = s.nextCommentId;
        const c: GhComment = { id, user: { login: comment.author ?? 'someone' }, author_association: comment.association ?? 'NONE', body: comment.body };
        return { ...s, nextCommentId: id + 1, comments: { ...s.comments, [String(issueNumber)]: [...(s.comments[String(issueNumber)] ?? []), c] } };
      });
      return id;
    },
    addPull(pull) {
      let number = 0;
      update((s) => {
        number = s.nextNumber;
        const p: GhPull = {
          number, title: pull.title ?? pull.head, body: pull.body ?? '', state: 'OPEN', url: `https://${s.repo.host}/${s.repo.owner}/${s.repo.name}/pull/${number}`,
          baseRefName: pull.base, headRefName: pull.head, mergeCommit: null, isDraft: false,
        };
        const entry: GhIssue = {
          number, title: p.title, body: p.body, state: 'open', labels: [], user: { login: s.repo.owner }, author_association: 'OWNER', pull_request: { url: p.url },
        };
        return { ...s, nextNumber: number + 1, pulls: [...s.pulls, p], issues: [...s.issues, entry] };
      });
      return number;
    },
    setPullState(number, state, oid) {
      update((s) => {
        if (!s.pulls.some((p) => p.number === number)) throw new Error(`forge: no PR ${number}`);
        return {
          ...s,
          pulls: s.pulls.map((p) => (p.number === number ? { ...p, state, mergeCommit: state === 'MERGED' && oid !== undefined ? { oid } : null } : p)),
          issues: s.issues.map((i) => (i.number === number ? { ...i, state: 'closed' as const } : i)),
        };
      });
    },
  };
}

/**
 * One comment per `author_association` on `issueNumber`, each by a distinct author (`as-<association>`), the comment
 * body its association. Returns the comment ids in matrix order.
 */
export function seedAssociationMatrix(forge: Forge, issueNumber: number): readonly number[] {
  return ASSOCIATION_MATRIX.map(({ association }) => forge.addComment(issueNumber, { body: association, author: `as-${association}`, association }));
}
