// The M1 fixture's directory layout, shared by setup, driver and check. One fixture dir holds:
//
//   repo/        the product repo (branches `main` and `integration`); its run dir is
//                repo/.git/roadmap-runtime/<ARC>/
//   input/       the run input: plan.json, rulings.md and one spec per unit (never in the product tree)
//   worktrees/   the plan's worktreeRoot
//   resource/    the state dir of the declared resource `scratch`
//   fake/        --fake only: the scenario, the backend shims, calls.jsonl and the fake host dir
//   report.json  written by the driver, read by check
import { join } from 'node:path';

export const ARC = 'm1-fixture';
export const MAIN = 'main';
export const INTEGRATION = 'integration';
export const UNITS = ['slug', 'page-id'] as const;
export const RESOURCE = 'scratch';

export type Layout = Readonly<{
  dir: string;
  repo: string;
  input: string;
  plan: string;
  worktrees: string;
  resource: string;
  fake: string;
  report: string;
  runDir: string;
}>;

export function layout(dir: string): Layout {
  const repo = join(dir, 'repo');
  const input = join(dir, 'input');
  return {
    dir,
    repo,
    input,
    plan: join(input, 'plan.json'),
    worktrees: join(dir, 'worktrees'),
    resource: join(dir, 'resource'),
    fake: join(dir, 'fake'),
    report: join(dir, 'report.json'),
    // `git rev-parse --git-common-dir` of a plain (non-worktree) checkout is its .git.
    runDir: join(repo, '.git', 'roadmap-runtime', ARC),
  };
}
