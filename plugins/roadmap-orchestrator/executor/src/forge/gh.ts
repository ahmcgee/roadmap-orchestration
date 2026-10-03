// The executor's one way to run `gh` (M4a, R22): like `git`, a spawnSync with a timeout, a read rather than a workload.
// The repo identity is resolved once (`gh repo view` in the product repo, which reads its remotes, H13) and every later
// call names it explicitly: `gh api --hostname <host> ...` for GraphQL and REST, and `-R <owner>/<name>` with
// `GH_HOST=<host>` for `gh pr`, so no call falls back to whatever repository the cwd or the user's config implies.
// The user's environment is inherited (gh's own auth lives there); prompts are disabled.
import { spawnSync } from 'node:child_process';
import type { AbsPath } from '../core/values.ts';
import { type RepoIdentity, repoIdentity } from './types.ts';

/** One `gh` call's bound: a forge read or a PR edit, never a long-running workload. */
export const GH_TIMEOUT_MS = 60_000;

export class GhError extends Error {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;
  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`gh ${args.join(' ')} ${code === null ? 'did not exit' : `exited ${code}`}: ${stderr.trim()}`);
    this.name = 'GhError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Runs `gh <args>` in `cwd` (`GH_HOST` set when `host` is given) and returns its stdout; throws GhError on any failure. */
function run(cwd: AbsPath, args: readonly string[], host: string | null): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', ...(host === null ? {} : { GH_HOST: host }) };
  const r = spawnSync('gh', args, { cwd, env, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) throw new GhError(args, null, r.error.message);
  if (r.status !== 0) throw new GhError(args, r.status, r.stderr);
  return r.stdout;
}

function parsed(args: readonly string[], stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new GhError(args, 0, `stdout is not JSON (${(error as Error).message}): ${stdout.slice(0, 200)}`);
  }
}

/** The repo `repo`'s remotes name on the forge: `gh repo view --json owner,name,url`, the host taken from the url. */
export function resolveRepo(repo: AbsPath): RepoIdentity {
  const args = ['repo', 'view', '--json', 'owner,name,url'];
  const out = parsed(args, run(repo, args, null)) as { owner?: { login?: unknown }; name?: unknown; url?: unknown };
  const host = typeof out.url === 'string' ? URL.parse(out.url)?.host : undefined;
  if (host === undefined || host === '') throw new GhError(args, 0, `no host in the url ${JSON.stringify(out.url)}`);
  return repoIdentity({ host, owner: out.owner?.login, name: out.name }, 'gh repo view');
}

/** `gh api --hostname <host> <args...>` (GraphQL or REST), its JSON answer. */
export function ghApi(cwd: AbsPath, repo: RepoIdentity, args: readonly string[]): unknown {
  const full = ['api', '--hostname', repo.host, ...args];
  return parsed(full, run(cwd, full, repo.host));
}

/** `gh pr <sub> -R <owner>/<name> <args...>` with `GH_HOST=<host>`, its stdout. */
export function ghPr(cwd: AbsPath, repo: RepoIdentity, sub: 'list' | 'create' | 'edit', args: readonly string[]): string {
  return run(cwd, ['pr', sub, '-R', `${repo.owner}/${repo.name}`, ...args], repo.host);
}

/** `ghPr` whose stdout is JSON (`--json`). */
export function ghPrJson(cwd: AbsPath, repo: RepoIdentity, sub: 'list', args: readonly string[]): unknown {
  return parsed(['pr', sub, ...args], ghPr(cwd, repo, sub, args));
}
