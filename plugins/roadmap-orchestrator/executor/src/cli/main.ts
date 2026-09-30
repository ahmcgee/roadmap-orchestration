// CLI entry: parses argv into the closed Command union (src/input/cli.ts) and runs it. Run commands find
// their run dir through the RunLocator: the host lock claim's, or `--repo` + `--arc` explicitly. Commands
// for the executor (`pause`, `stop`, `ack`, `resume`, `sweep`, `apply`, `resolve-edge`, `run-only`) only
// write a file into its durable queue and print the command id; the executor applies it and writes the
// receipts. `apply` first hashes the
// plan file the arc started with (start.json) and every unit's spec into the command's manifest; `apply
// --dry-run` instead classifies them against the plan in force, read-only, and prints the verdict (it runs
// no smoke: a backend the new routing needs is listed under `smoke`). Output is agent-facing JSON.
// `start` launches the supervisor detached (src/supervisor.ts), which claims the host and spawns the
// executor, and waits for its own generation's readiness (the executor passed every startup check), at
// most 240 s by default or `--wait <ms>`. It prints one JSON line: `ready` (exit 0; start returns while the
// run goes on), the refused exit line (exit 78/75), or `failed` / `timeout` (exit 70). The run's own end is
// in exit.reason.json and `status`. `status` prints the status object.
//
// `runCli` takes the host directory, as every host function does: `main` passes HOST_DIR, tests a temp dir.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { submitCommand } from '../commands/queue.ts';
import { evaluateApply } from '../commands/apply.ts';
import { readJson } from '../core/fsx.ts';
import type { ArcId, PlanRev } from '../core/ids.ts';
import { readJournal } from '../core/log.ts';
import { canonicalJson } from '../core/json.ts';
import { type CommandBody, type RunStart, runStart } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { START_FILE } from '../executor.ts';
import { manifestOf, readInputFiles } from '../input/inforce.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { HOST_DIR } from '../host/hostdir.ts';
import { readClaim } from '../host/lock.ts';
import { CliError, type Command, type RunLocator, parseCommand, runDir } from '../input/cli.ts';
import { gitCommonDir, readRepoConfig } from '../preflight/checks.ts';
import { arcStack, resolveRouting } from '../routing/layers.ts';
import { status } from '../status.ts';
import { START_WAIT_MS, launchSupervisor } from '../supervisor.ts';
import { watch } from '../watch.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/** EX_USAGE: the arguments were wrong. */
const EXIT_USAGE = 64;

type Run = Readonly<{ runDir: AbsPath; arc: ArcId }>;

function locate(locator: RunLocator, hostDir: AbsPath): Run {
  if (locator.type === 'explicit') {
    const repo = absPath(resolve(locator.repo));
    return { runDir: runDir(gitCommonDir(repo), locator.arc), arc: locator.arc };
  }
  const claim = readClaim(hostDir);
  if (claim === null) throw new CliError(`no arc holds this host (${hostDir}); name the run with --repo and --arc`);
  return { runDir: claim.runDir, arc: claim.arc };
}

function submit(locator: RunLocator, hostDir: AbsPath, body: CommandBody): void {
  const run = locate(locator, hostDir);
  const file = submitCommand(run.runDir, run.arc, body);
  process.stdout.write(`${canonicalJson({ command: file.id, arc: run.arc, type: body.type })}\n`);
}

async function runCommand(command: Command, hostDir: AbsPath): Promise<void> {
  switch (command.command) {
    case 'version':
      process.stdout.write(`${pkg.version}\n`);
      return;
    case 'pause':
      return submit(command.run, hostDir, { type: 'pause', target: command.target });
    case 'stop':
      return submit(command.run, hostDir, { type: 'stop' });
    case 'ack':
      return submit(command.run, hostDir, { type: 'ack', needsUser: command.id, choice: command.choice });
    case 'resume':
      return submit(command.run, hostDir, { type: 'resume', target: command.target });
    case 'sweep':
      return submit(command.run, hostDir, { type: 'sweep', resource: command.resource });
    case 'resolve-edge':
      return submit(command.run, hostDir, { type: 'resolve-edge', edge: command.edge, evidence: command.evidence });
    case 'run-only':
      return submit(command.run, hostDir, { type: 'run-only', units: command.units });
    case 'apply': {
      const run = locate(command.run, hostDir);
      const start = startOf(run);
      if (command.dryRun) {
        process.stdout.write(`${canonicalJson(await dryRun(run, start, hostDir, command.expectRev))}\n`);
        return;
      }
      let manifest: ReturnType<typeof manifestOf>;
      try {
        manifest = manifestOf(readInputFiles(start.planFile));
      } catch (error) {
        if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
        throw new CliError(`apply: ${start.planFile} does not load: ${error.message}`);
      }
      if ('missing' in manifest) throw new CliError(`apply: no spec file for ${manifest.missing.join(', ')}`);
      return submit(command.run, hostDir, { type: 'apply', expectRev: command.expectRev, manifest });
    }
    case 'watch': {
      const run = locate(command.run, hostDir);
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
      await watch(run.runDir, run.arc, hostDir, (line) => process.stdout.write(`${line}\n`), stop.signal);
      return;
    }
    case 'start': {
      const outcome = await launchSupervisor({
        hostDir, repo: absPath(resolve(command.args.repo)), planFile: absPath(resolve(command.args.plan)), profile: command.args.profile, heartbeatStaleMs: null,
      }, process.env, command.args.waitMs ?? START_WAIT_MS);
      process.stdout.write(`${outcome.line}\n`);
      process.exitCode = outcome.code;
      return;
    }
    case 'status': {
      const run = locate(command.run, hostDir);
      process.stdout.write(`${canonicalJson(status(run.runDir, run.arc, hostDir))}\n`);
      return;
    }
  }
}

/** start.json of a run: the plan file an apply hashes, the repo and the resolved profile. */
function startOf(run: Run): RunStart {
  const path = join(run.runDir, START_FILE);
  if (!existsSync(path)) throw new CliError(`arc ${run.arc} has never started (no ${path})`);
  return runStart(readJson(path), START_FILE);
}

/** `apply --dry-run`: the executor's evaluation, read-only, over the log as `status` reads it. */
async function dryRun(run: Run, start: RunStart, hostDir: AbsPath, expectRev: PlanRev | null): Promise<unknown> {
  const { view } = readJournal(run.runDir, run.arc);
  const config = readRepoConfig(start.repo);
  const verdict = await evaluateApply({
    runDir: run.runDir, view, hostDir, repo: start.repo, planFile: start.planFile, profile: start.profile,
    resolve: (plan) => resolveRouting(arcStack(start.profile, config, plan.routing ?? null)), laneEnv: process.env, manifest: null, expectRev,
  });
  switch (verdict.kind) {
    case 'rejected':
      return { dryRun: true, kind: 'rejected', reasons: verdict.reasons };
    case 'unchanged':
      return { dryRun: true, kind: 'unchanged', rev: verdict.rev };
    case 'accepted':
      return { dryRun: true, kind: 'accepted', rev: verdict.rev, nextRev: verdict.rev + 1, changes: verdict.changes, smoke: verdict.smoke };
  }
}

/** Parses and runs one command against the host directory `hostDir`. */
export async function runCli(argv: readonly string[], hostDir: AbsPath): Promise<void> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    process.stderr.write(`roadmap: ${error.message}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  try {
    await runCommand(command, hostDir);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    process.stderr.write(`roadmap: ${error.message}\n`);
    process.exitCode = EXIT_USAGE;
  }
}

export function main(argv: readonly string[]): Promise<void> {
  return runCli(argv, HOST_DIR);
}
