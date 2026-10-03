// The canonical issue capture (M4a, H8, H13, K25, R30): one schema for Phase 0 (`roadmap issues --out`) and checkpoints.
//
// Under a trusted policy (trust.ts) with issues enabled, REST `issues?labels=<label>&state=open` once per intake label
// (GitHub ANDs a label list, so each label is its own query), paginated by `per_page`/`page` until a short page, the
// entries united by number. An entry carrying `pull_request` is a PR, dropped before anything else reads it and counted.
// A kept issue's comments come from `issues/<n>/comments`; a comment is kept when its `author_association` is OWNER,
// MEMBER or COLLABORATOR, or its author wrote a kept issue; the rest are counted. Every body is wrapped by the
// `<pasted_content>` sanitiser (src/prompts/inputs.ts `pasted`, labelled with its content ref). The result is ordered
// (issues and comments ascending by number and id, labels ascending) and carries no clock, so a re-run over unchanged
// issues gives identical bytes. Issues disabled: an empty capture, nothing fetched.
import { type Sha256Hex, issueContentRef, issueIdOf, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { AbsPath } from '../core/values.ts';
import { pasted } from '../prompts/inputs.ts';
import { GhError, ghApi } from './gh.ts';
import type { Trusted } from './trust.ts';
import {
  AUTHOR_ASSOCIATIONS, type AuthorAssociation, type CapturedComment, type CapturedIssue, ISSUE_LABELS, ISSUES_CAPTURE_SCHEMA, type IssueCapture,
  type RepoIdentity, parseIssueCapture,
} from './types.ts';

export const PER_PAGE = 100;
const KEPT: readonly AuthorAssociation[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

type Entry = Readonly<{ number: number; title: string; body: string; labels: readonly string[]; author: string; pull: boolean }>;
type Comment = Readonly<{ id: number; author: string; association: AuthorAssociation; body: string }>;

/** Every item of a paginated REST list endpoint (`endpoint` may carry a query already). */
function listAll(cwd: AbsPath, repo: RepoIdentity, endpoint: string): readonly unknown[] {
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const args = [`${endpoint}${sep}per_page=${PER_PAGE}&page=${page}`];
    const got = ghApi(cwd, repo, args);
    if (!Array.isArray(got)) throw new GhError(args, 0, `expected a JSON array, got ${JSON.stringify(got).slice(0, 200)}`);
    items.push(...got);
    if (got.length < PER_PAGE) return items;
  }
}

/** Reads the fields the capture uses from a REST answer; anything else the forge sends is ignored. */
function field<T>(where: string, value: unknown, key: string, check: (v: unknown) => v is T): T {
  const v = (value as Record<string, unknown> | null)?.[key];
  if (!check(v)) throw new GhError([where], 0, `${key} is ${JSON.stringify(v)}`);
  return v;
}
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isString = (v: unknown): v is string => typeof v === 'string';
const isBody = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isLabels = (v: unknown): v is readonly Readonly<{ name: string }>[] => Array.isArray(v) && v.every((l) => typeof (l as { name?: unknown })?.name === 'string');
const isUser = (v: unknown): v is Readonly<{ login: string }> => typeof (v as { login?: unknown } | null)?.login === 'string';
const isAssociation = (v: unknown): v is AuthorAssociation => (AUTHOR_ASSOCIATIONS as readonly unknown[]).includes(v);

function entryOf(raw: unknown): Entry {
  const where = 'issues entry';
  return {
    number: field(where, raw, 'number', isNumber),
    title: field(where, raw, 'title', isString),
    body: field(where, raw, 'body', isBody) ?? '',
    labels: field(where, raw, 'labels', isLabels).map((l) => l.name),
    author: field(where, raw, 'user', isUser).login,
    pull: (raw as Record<string, unknown>)['pull_request'] !== undefined,
  };
}

function commentOf(raw: unknown): Comment {
  const where = 'issue comment';
  return {
    id: field(where, raw, 'id', isNumber),
    author: field(where, raw, 'user', isUser).login,
    association: field(where, raw, 'author_association', isAssociation),
    body: field(where, raw, 'body', isBody) ?? '',
  };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The capture of `repo`'s open intake issues under a trusted policy (`cwd`: where `gh` runs, the product repo). */
export function fetchIssueCapture(cwd: AbsPath, repo: RepoIdentity, trust: Trusted): IssueCapture {
  const base = { schema: ISSUES_CAPTURE_SCHEMA, repo, policy: trust.policy } as const;
  if (!trust.intake) return { ...base, issues: [], filtered: { comments: 0, pullRequests: 0 } };
  const entries = new Map<number, Entry>();
  for (const label of ISSUE_LABELS) {
    for (const raw of listAll(cwd, repo, `repos/${repo.owner}/${repo.name}/issues?labels=${label}&state=open`)) {
      const e = entryOf(raw);
      entries.set(e.number, e);
    }
  }
  const all = [...entries.values()].sort((a, b) => a.number - b.number);
  const kept = all.filter((e) => !e.pull);
  const authors = new Set(kept.map((e) => e.author));
  let droppedComments = 0;
  const issues = kept.map((e): CapturedIssue => {
    const id = issueIdOf(e.number);
    const comments = listAll(cwd, repo, `repos/${repo.owner}/${repo.name}/issues/${e.number}/comments`).map(commentOf).sort((a, b) => a.id - b.id);
    const keptComments = comments.filter((c) => KEPT.includes(c.association) || authors.has(c.author));
    droppedComments += comments.length - keptComments.length;
    return {
      id, title: e.title, labels: [...e.labels].sort(byCodeUnit), body: pasted(id, e.body),
      comments: keptComments.map((c): CapturedComment => {
        const ref = issueContentRef(`${id}/c-${c.id}`);
        return { id: ref, association: c.association, body: pasted(ref, c.body) };
      }),
    };
  });
  const capture: IssueCapture = { ...base, issues, filtered: { comments: droppedComments, pullRequests: all.length - kept.length } };
  return parseIssueCapture(JSON.parse(captureBytes(capture)));
}

/** The capture's bytes (canonical JSON): what `--out` writes and `inputs/<sha>.issues.json` keeps. */
export const captureBytes = (capture: IssueCapture): string => canonicalJson(capture);
export const captureSha256 = (capture: IssueCapture): Sha256Hex => sha256(sha256Hex(captureBytes(capture)));
