// CLI entry: parses argv into the closed Command union (src/input/cli.ts) and runs it. Run commands find
// their run dir through the RunLocator: the host lock claim's, or `--repo` + `--arc` explicitly. Commands
// for the executor (`pause`, `stop`, `ack`, `resume`, `sweep`) only write a file into its durable queue and
// print the command id; the executor applies it and writes the receipts. Output is agent-facing JSON.
// `start` runs the executor in the foreground (13b; the supervisor is 14a's) and prints its exit reason as
// one JSON line, exiting 0 (stop, complete) or 78/75 (refused). `status` prints the status object.
//
// `runCli` takes the host directory, as every host function does: `main` passes HOST_DIR, tests a temp dir.
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { submitCommand } from '../commands/queue.ts';
import type { ArcId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { CommandBody } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { exitCodeOf, exitLine, runExecutor } from '../executor.ts';
import { HOST_DIR } from '../host/hostdir.ts';
import { readClaim } from '../host/lock.ts';
import { CliError, type Command, type RunLocator, parseCommand, runDir } from '../input/cli.ts';
import { gitCommonDir } from '../preflight/checks.ts';
import { status } from '../status.ts';
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
    case 'watch': {
      const run = locate(command.run, hostDir);
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
      await watch(run.runDir, hostDir, (line) => process.stdout.write(`${line}\n`), stop.signal);
      return;
    }
    case 'start': {
      const reason = await runExecutor({
        repo: absPath(resolve(command.args.repo)), planFile: absPath(resolve(command.args.plan)), profile: command.args.profile, hostDir, env: process.env,
      });
      process.stdout.write(`${exitLine(reason)}\n`);
      process.exitCode = exitCodeOf(reason);
      return;
    }
    case 'status': {
      const run = locate(command.run, hostDir);
      process.stdout.write(`${canonicalJson(status(run.runDir, run.arc, hostDir))}\n`);
      return;
    }
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
