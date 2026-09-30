// The M3 fixture's directory layout, shared by setup, driver and check. One fixture dir holds:
//
//   repo/        the product repo, the Node CLI `ledger` (branches `main` and `integration`); its run dir is
//                repo/.git/roadmap-runtime/<arc>/
//   input/       the run input: plan.json, vision.json, obligations.json, rulings.md (the C-nn ledger) and one
//                spec per unit (never in the product tree)
//   worktrees/   the plan's worktreeRoot
//   barriers/    the money lane's audit barrier (`<job>.money.reached` / `.release`, barrier.ts)
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
/** The arc lane of I-2 and the audit whose run of it waits at the barrier (A1: the first audit job). */
export const MONEY_LANE = 'money';
export const BARRIER_JOB = 'audit-1';
/** The fake checkpoint call of the first checkpoint waits here until the driver's stale `apply` is applied. */
export const FAKE_CKPT_HOLD = 'ckpt-1.hold';
/** The ledger-file fixture I-1's journey test reconciles, and the line it expects. */
export const MONTH = '2026-09';
export const RECONCILED = '2026-09 balance 12.75';

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

/** The barrier file of `job`'s run of the money lane. */
export const barrierFile = (l: Layout, job: string, what: 'reached' | 'release'): string => join(l.barriers, `${job}.${MONEY_LANE}.${what}`);
