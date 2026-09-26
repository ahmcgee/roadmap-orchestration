// The M1 fixture's directory layout, shared by setup, driver and check. One fixture dir holds:
//
//   repo/        the product repo (branches `main` and `integration`); its run dir is
//                repo/.git/roadmap-runtime/<arc>/
//   input/       the run input: plan.json, rulings.md and one spec per unit (never in the product tree)
//   worktrees/   the plan's worktreeRoot
//   resource/    the state dir of the declared resource `scratch`
//   fake/        --fake only: the scenario, the backend shims, calls.jsonl and the fake host dir
//   report.json  written by the driver, read by check
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const MAIN = 'main';
export const INTEGRATION = 'integration';
export const UNITS = ['slug', 'page-id'] as const;
export const RESOURCE = 'scratch';

export type Layout = Readonly<{
  dir: string;
  arc: string;
  repo: string;
  input: string;
  plan: string;
  worktrees: string;
  resource: string;
  fake: string;
  report: string;
  runDir: string;
}>;

/**
 * The fixture's arc, unique to its directory. Workload membership is keyed host-wide by ROADMAP_INV
 * (`<arc>/<seq>#<ordinal>`), which production keeps unique with its one host dir and host lock. Fake runs
 * each have their own host dir, and `npm test` runs four at once: sharing one arc name, their invocation ids
 * collide, and one executor finds another fixture's runner as a second live runner of its own invocation.
 */
function arcOf(dir: string): string {
  return `m1-fixture-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12)}`;
}

export function layout(dir: string): Layout {
  const repo = join(dir, 'repo');
  const input = join(dir, 'input');
  const arc = arcOf(dir);
  return {
    dir,
    arc,
    repo,
    input,
    plan: join(input, 'plan.json'),
    worktrees: join(dir, 'worktrees'),
    resource: join(dir, 'resource'),
    fake: join(dir, 'fake'),
    report: join(dir, 'report.json'),
    // `git rev-parse --git-common-dir` of a plain (non-worktree) checkout is its .git.
    runDir: join(repo, '.git', 'roadmap-runtime', arc),
  };
}
