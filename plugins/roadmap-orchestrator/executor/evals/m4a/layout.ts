// The M4a fixture's directory layout, shared by setup, driver, check, adjudicate and the scripted root agent. One
// fixture dir (outside this repository) holds:
//
//   stage/            everything a session is given (LR-f, H1); nothing in it names this repository or the answer key
//     plugin/         the staged plugin copy, without executor/evals, executor/test or node_modules (driver.ts)
//     product/        the session's cwd: the scratch product repo `tidewater` (branch main)
//     origin.git/     its bare origin
//     forge/          the fake forge: gh-store.json (+ gh-calls.jsonl), lib/ (the fake gh's sources, copied), bin/gh
//     config/         gh/ and xdg/ (empty: GH_CONFIG_DIR, XDG_CONFIG_HOME), gitconfig (GIT_CONFIG_GLOBAL: identity only)
//     roadmap-inputs/ where the root agent keeps each arc's inputs (the skill's `<repo>/../roadmap-inputs/<arc>/`)
//     worktrees/      the plans' worktreeRoot (the scripted root agent's; a real one picks its own)
//   fake/             --fake only: per-arc backend scenarios and shims (arc-<n>/), the host dir, the scripted root's state
//   transcript.jsonl  every session turn's stream-json, one event per line, each tagged with its turn
//   canary.json       the real forge before and after (real runs)
//   diagnostics/      the session-end copy of each arc's needs-user files and the turn stderr tails (driver)
//   costs.jsonl       per-invocation and per-turn cost rows, unknowns explicit (transcript.ts)
//   report.json       written by the driver, read by check
import { join } from 'node:path';

/** The fixture forge's repo identity (no real forge exists for the scratch repo). */
export const FORGE_REPO = { host: 'forge.test', owner: 'harbour-office', name: 'tidewater' } as const;
export const MAIN = 'main';

/**
 * M4b's two plants (plan "Fixture … the two plants"), named once for setup, the golden outputs, the driver and check.
 * S: the product's suite gate is that every unit test passes; `npm test` runs them as `node --test --test-concurrency=1
 * 'test/unit/*.test.js'`, six replay files of about a minute each, serial for a reason the corpus shows is stale (every
 * file makes its own temp dir). G: one of them is
 * the soak run, which guards the ledger (V-2) and witnesses an obligation: slow, and it stays.
 */
export const PLANT = {
  selector: 'test/unit/*.test.js',
  serial: '--test-concurrency=1',
  soakFile: 'test/unit/soak.test.js',
  soakTest: 'the ledger survives a season of bookings and cancellations',
} as const;
/** The suite lane argv of the corpus's `npm test` (plant S), as a golden plan writes it. */
export const SEED_SUITE_ARGV: readonly string[] = ['node', '--test', PLANT.serial, PLANT.selector];
export const SESSION_END = /^ROADMAP-SESSION: stopped (\S+)\s*$/m;
/** The skill's closed set of stop reasons (skills/orchestrate/SKILL.md "Chaining"). */
export const STOP_REASONS = ['k-limit', 'vision-silent', 'owner'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type Layout = Readonly<{
  dir: string;
  stage: string;
  plugin: string;
  product: string;
  origin: string;
  forge: string;
  store: string;
  forgeBin: string;
  forgeLib: string;
  config: string;
  ghConfig: string;
  xdgConfig: string;
  gitConfig: string;
  inputs: string;
  worktrees: string;
  fake: string;
  transcript: string;
  canary: string;
  diagnostics: string;
  costs: string;
  report: string;
}>;

export function layout(dir: string): Layout {
  const stage = join(dir, 'stage');
  const forge = join(stage, 'forge');
  const config = join(stage, 'config');
  return {
    dir,
    stage,
    plugin: join(stage, 'plugin'),
    product: join(stage, 'product'),
    origin: join(stage, 'origin.git'),
    forge,
    store: join(forge, 'gh-store.json'),
    forgeBin: join(forge, 'bin'),
    forgeLib: join(forge, 'lib'),
    config,
    ghConfig: join(config, 'gh'),
    xdgConfig: join(config, 'xdg'),
    gitConfig: join(config, 'gitconfig'),
    inputs: join(stage, 'roadmap-inputs'),
    worktrees: join(stage, 'worktrees'),
    fake: join(dir, 'fake'),
    transcript: join(dir, 'transcript.jsonl'),
    canary: join(dir, 'canary.json'),
    diagnostics: join(dir, 'diagnostics'),
    costs: join(dir, 'costs.jsonl'),
    report: join(dir, 'report.json'),
  };
}
