// The M2 fixture's directory layout, shared by setup, driver and check. One fixture dir holds:
//
//   repo/        the product repo (branches `main` and `integration`); its run dir is
//                repo/.git/roadmap-runtime/<arc>/
//   input/       the run input: plan.json, rulings.md and one spec per unit (never in the product tree); the
//                driver adds right2.json at the re-entry
//   worktrees/   the plan's worktreeRoot
//   estate/      the pool `estate`'s state dir: one directory per instance (`estate#<n>/`, its occupant and
//                history.log), calls.log, and the teardown-fails-once marker of instance #2 the driver arms
//                (estate.ts)
//   barriers/    the lane barriers the driver releases (`<unit>.<name>.<round>.reached` / `.release`)
//   fake/        --fake only: the scenario, the backend shims, calls.jsonl and the fake host dir
//   report.json  written by the driver, read by check
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const MAIN = 'main';
export const INTEGRATION = 'integration';
/** The plan's units at start, in plan order. `right2` joins by `apply` at the re-entry. */
export const UNITS = ['base', 'left', 'right', 'top', 'urgent'] as const;
export type FixtureUnit = (typeof UNITS)[number] | 'right2';
export const REENTRY = 'right2';
export const POOL = 'estate';
export const POOL_SIZE = 2;
/** The `@cpu` pool's size (plan.capacity.cpu): two estate lanes (4 each) at once, and nothing beside them. */
export const CPU_CAPACITY = 8;
/** The contingent edge of `top`, resolved by the driver once `left` merges. */
export const EDGE = 'e-top';
/**
 * The barrier `left` and `right` hold both pool instances at (estate.ts `hold`), in two rounds: round 1 is the
 * executor's SIGKILL (released after the respawn), round 2 the lanes run again after the recovery, when the
 * driver arms instance #2's failing teardown. `right`'s own barrier after its edit commit has one round.
 */
export const ESTATE_HOLD = 'estate-hold';
export const ESTATE_ROUNDS = 2;
export const RIGHT_HOLD = 'right-hold';
/** The product line `right` and `urgent` both edit: the conflict the re-entry resolves. */
export const SHARED_FILE = 'src/registry.js';

export type Layout = Readonly<{
  dir: string;
  arc: string;
  repo: string;
  input: string;
  plan: string;
  worktrees: string;
  estate: string;
  barriers: string;
  fake: string;
  report: string;
  runDir: string;
}>;

/** The fixture's arc, unique to its directory (see evals/m1/layout.ts: invocation ids key workloads host-wide). */
function arcOf(dir: string): string {
  return `m2-fixture-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12)}`;
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
    estate: join(dir, 'estate'),
    barriers: join(dir, 'barriers'),
    fake: join(dir, 'fake'),
    report: join(dir, 'report.json'),
    runDir: join(repo, '.git', 'roadmap-runtime', arc),
  };
}

export const instanceDir = (l: Layout, n: number): string => join(l.estate, `${POOL}#${n}`);
/** The marker instance #2's next teardown consumes, failing (estate.ts). */
export const teardownFailsOnce = (l: Layout): string => join(l.estate, `${POOL}#2.teardown-fails-once`);
export const barrierFile = (l: Layout, unit: string, name: string, round: number, what: 'reached' | 'release'): string =>
  join(l.barriers, `${unit}.${name}.${round}.${what}`);
