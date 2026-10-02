// The M3 fixture's directory layout, shared by setup, driver and check. One fixture dir holds:
//
//   repo/        the product repo, the Node CLI `ledger` (branches `main` and `integration`); its run dir is
//                repo/.git/roadmap-runtime/<arc>/
//   input/       the run input: plan.json, vision.json, obligations.json, rulings.md (the C-nn ledger) and one
//                spec per unit (never in the product tree)
//   worktrees/   the plan's worktreeRoot
//   barriers/    the money lane's audit barrier, branch R only (`money.reached`, holding the audit's job id / `money.release`,
//                barrier.ts)
//   fake/        --fake only: the scenario, the backend shims, calls.jsonl, the fake host dir, and the fake
//                checkpoint's hold barrier (`ckpt-1.hold.reached` / `.release`)
//   report.json  written by the driver, read by check
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export const MAIN = 'main';
export const INTEGRATION = 'integration';
/** The plan's units at start, in plan order. The repair joins through a checkpoint bundle. */
export const UNITS = ['parse', 'tidy', 'report'] as const;
export type FixtureUnit = (typeof UNITS)[number];
/** The units run-only lets run from the start: `report` is held out until audit A1 waits at its barrier. */
export const FIRST = ['parse', 'tidy'] as const;
/** The required lens set L (H9), ascending as the plan holds it. */
export const LENSES = ['invariants', 'vision'] as const;
export const AUDIT_EVERY = 2;
export const CONVERGENCE_K = 1;
/** The arc lane of I-2; its run in the first audit that sees the regression waits at the barrier (branch R: A1). */
export const MONEY_LANE = 'money';
/** The fake checkpoint call of the first checkpoint waits here until the driver's stale `apply` is applied. */
export const FAKE_CKPT_HOLD = 'ckpt-1.hold';

export type Layout = Readonly<{
  dir: string;
  arc: string;
  repo: string;
  input: string;
  plan: string;
  vision: string;
  obligations: string;
  worktrees: string;
  barriers: string;
  fake: string;
  report: string;
  runDir: string;
}>;

/** The fixture's arc, unique to its directory (see evals/m1/layout.ts: invocation ids key workloads host-wide). */
function arcOf(dir: string): string {
  return `m3-fixture-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12)}`;
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
    vision: join(input, 'vision.json'),
    obligations: join(input, 'obligations.json'),
    worktrees: join(dir, 'worktrees'),
    barriers: join(dir, 'barriers'),
    fake: join(dir, 'fake'),
    report: join(dir, 'report.json'),
    runDir: join(repo, '.git', 'roadmap-runtime', arc),
  };
}

/** The money barrier's files: `reached` holds the waiting audit's job id. */
export const barrierFile = (l: Layout, what: 'reached' | 'release'): string => join(l.barriers, `${MONEY_LANE}.${what}`);

/**
 * The paid story's honest branches (DESIGN-1.0.md §10 M3): tidy's regression merged with I-2's witness not held on S
 * (R), prevented upstream (P), or tidy published with the witness held on S while a defect the witness cannot see
 * remains, which the lenses find (L, latent; paid run 9).
 */
export const STORY_BRANCHES = ['R', 'P', 'L'] as const;
export type StoryBranch = (typeof STORY_BRANCHES)[number];
