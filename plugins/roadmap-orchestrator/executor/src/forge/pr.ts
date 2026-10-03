// Pull requests on the forge (M4a, OR-Q19, OR-L5, OR-L7): the forge is the only record of an arc's PR, so every
// question is asked of it by head branch. `gh pr` calls name the resolved repository (`-R`, `GH_HOST`; gh.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArcId, type Sha, sha } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { GhError, ghPr, ghPrJson } from './gh.ts';
import type { RepoIdentity } from './types.ts';

export const PULL_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const;
export type PullState = (typeof PULL_STATES)[number];

export type Pull = Readonly<{ number: number; url: string; state: PullState; base: string; head: string; mergeCommit: Sha | null }>;

const PULL_FIELDS = 'number,url,state,baseRefName,headRefName,mergeCommit';

function pullOf(raw: unknown): Pull {
  const r = raw as { number?: unknown; url?: unknown; state?: unknown; baseRefName?: unknown; headRefName?: unknown; mergeCommit?: { oid?: unknown } | null };
  const bad = (what: string): never => {
    throw new GhError(['pr', 'list'], 0, `a pull request with ${what}: ${JSON.stringify(raw)}`);
  };
  if (typeof r.number !== 'number' || typeof r.url !== 'string' || typeof r.baseRefName !== 'string' || typeof r.headRefName !== 'string') return bad('missing fields');
  if (!(PULL_STATES as readonly unknown[]).includes(r.state)) return bad('an unknown state');
  const oid = r.mergeCommit?.oid;
  const mergeCommit = typeof oid === 'string' ? sha(oid, `pull ${r.number}.mergeCommit.oid`) : null;
  if (r.state === 'MERGED' && mergeCommit === null) return bad('state MERGED and no merge commit');
  return { number: r.number, url: r.url, state: r.state as PullState, base: r.baseRefName, head: r.headRefName, mergeCommit };
}

/** Every PR whose head is `head`, in any state. */
export function pullsByHead(cwd: AbsPath, repo: RepoIdentity, head: string): readonly Pull[] {
  const out = ghPrJson(cwd, repo, 'list', ['--head', head, '--state', 'all', '--json', PULL_FIELDS]);
  if (!Array.isArray(out)) throw new GhError(['pr', 'list'], 0, `expected a JSON array, got ${JSON.stringify(out).slice(0, 200)}`);
  return out.map(pullOf).filter((p) => p.head === head);
}

/** The one pull request `pulls` hold in `state`, or null; two is a forge state roadmap never makes, so it fails loud. */
export function onlyIn(pulls: readonly Pull[], state: PullState): Pull | null {
  const hits = pulls.filter((p) => p.state === state);
  if (hits.length > 1) throw new GhError(['pr', 'list'], 0, `${hits.length} ${state} pull requests for head ${hits[0]?.head}: ${hits.map((p) => p.url).join(', ')}`);
  return hits[0] ?? null;
}

/** Runs `body` with a temp file holding `text` (gh's `--body-file`), removed afterwards. */
function withBodyFile<T>(text: string, body: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-pr-'));
  try {
    const path = join(dir, 'body.md');
    writeFileSync(path, text);
    return body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type NewPull = Readonly<{ base: string; head: string; title: string; body: string }>;

/** Opens the PR and returns it as the forge lists it. */
export function createPull(cwd: AbsPath, repo: RepoIdentity, pull: NewPull): Pull {
  withBodyFile(pull.body, (file) => ghPr(cwd, repo, 'create', ['--base', pull.base, '--head', pull.head, '--title', pull.title, '--body-file', file]));
  const open = onlyIn(pullsByHead(cwd, repo, pull.head), 'OPEN');
  if (open === null || open.base !== pull.base) throw new GhError(['pr', 'create'], 0, `created a pull request ${pull.head} → ${pull.base}, but the forge lists ${JSON.stringify(open)}`);
  return open;
}

export function retargetPull(cwd: AbsPath, repo: RepoIdentity, number: number, base: string): void {
  ghPr(cwd, repo, 'edit', [String(number), '--base', base]);
}

// ---------------------------------------------------------------------------------------------------
// The body (code-rendered)

export type PullBodyInput = Readonly<{
  arc: ArcId;
  branch: string;
  head: Sha;
  /** The arc this one is stacked on, or null for the chain's first (based on main). */
  previousArc: ArcId | null;
  /** `<arc>/M-n` and its rules, proposal and why, ascending by id: the corpus amendments arc `arc` derived (OR-L7). */
  amendments: readonly Readonly<{ ref: string; rules: readonly string[]; proposal: string; why: string }>[];
}>;

export const MERGE_COMMIT_LINE = 'Merge this stack with merge commits, never squash or rebase: each arc\'s PR is based on the previous arc\'s branch, and a squash or rebase merge leaves the PRs stacked on it needing a rebase.';

export function pullTitle(arc: ArcId): string {
  return `roadmap: arc ${arc}`;
}

export function pullBody(input: PullBodyInput): string {
  const lines = [
    `Roadmap arc \`${input.arc}\`: integration branch \`${input.branch}\` at ${input.head}.`,
    input.previousArc === null ? 'The first arc of its chain, based on `main`.' : `Stacked on arc \`${input.previousArc}\`'s pull request; merge that one first.`,
    '',
    MERGE_COMMIT_LINE,
    '',
    '## Corpus amendments derived from this arc',
    '',
    ...(input.amendments.length === 0
      ? ['None.']
      : input.amendments.map((a) => `- \`${a.ref}\`${a.rules.length === 0 ? '' : ` (${a.rules.join(', ')})`}: ${a.proposal} Why: ${a.why}`)),
    '',
  ];
  return lines.join('\n');
}
