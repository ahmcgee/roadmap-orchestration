// Resolve CLI paths, export revisions and queue durable commands.
import { existsSync,readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename,join,resolve } from 'node:path';
import { recordAnswer } from '../answers.ts';
import { evaluateApply } from '../commands/apply.ts';
import { brief } from '../commands/brief.ts';
import { chainStatus } from '../commands/chain.ts';
import { corpusPin } from '../commands/corpus.ts';
import { flowCommand } from '../commands/flow.ts';
import { DEFAULT_KEEP,gc } from '../commands/gc.ts';
import { exportInputs,readExport } from '../commands/inputs.ts';
import { phase0Check } from '../commands/phase0.ts';
import { openPr } from '../commands/pr.ts';
import { submitCommand } from '../commands/queue.ts';
import { resumeArc } from '../commands/resumearc.ts';
import { witnessCheck } from '../commands/witnesscheck.ts';
import { readJson } from '../core/fsx.ts';
import { planRev,sha256 } from '../core/ids.ts';
import { canonicalJson,sha256Hex } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import { type CommandBody,type RevisionManifest,type RunStart,runStart } from '../core/records.ts';
import { type AbsPath,absPath } from '../core/values.ts';
import { START_FILE } from '../executor.ts';
import { HOST_DIR } from '../host/hostdir.ts';
import { CliError,type Command,type RunLocator,parseCommand } from '../input/cli.ts';
import { arcRolesOf,readInputFiles,revisionManifestOf } from '../input/inforce.ts';
import { readRepoConfig } from '../preflight/checks.ts';
import { EXIT_HOST_BUSY,EXIT_REFUSED,type StartupRejection } from '../preflight/startup.ts';
import { status, statusSingleFlight } from '../status.ts';
import { START_WAIT_MS,launchSupervisor } from '../supervisor.ts';
import { tui } from '../tui/main.ts';
import { HEARTBEAT_MIN,watch,watchActionable } from '../watch.ts';
import { type Run,locate } from './locate.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/** EX_USAGE: the arguments were wrong. */
const EXIT_USAGE = 64;

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
      const from = absPath(resolve(command.from));
      const exported = readExport(from, command.rev);
      const planFile = absPath(join(from, basename(start.planFile)));
      const base = exported.base;
      if (command.dryRun) {
        process.stdout.write(`${canonicalJson(await dryRun(run, start, hostDir, planFile, base, command.rev, command.reason))}\n`);
        return;
      }
      const manifest = revisionManifestOf(readInputFiles(planFile, start.repo, true));
      if ('missing' in manifest) throw new CliError(`apply: ${manifest.missing.join('; ')}`);
      return submit(command.run, hostDir, { type: 'apply', planFile, base, manifest, rev: planRev(command.rev), reason: command.reason });
    }
    case 'watch': {
      const run = locate(command.run, hostDir);
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
      const emit = (line: string): void => void process.stdout.write(`${line}\n`);
      if (command.actionable === null) await watch(run.runDir, run.arc, hostDir, emit, stop.signal);
      else await watchActionable(run.runDir, run.arc, hostDir, command.actionable.heartbeatMin ?? HEARTBEAT_MIN, command.actionable.from, emit, stop.signal);
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
    case 'tui':
      await tui(command.run, hostDir);
      return;
    case 'status': {
      const run = locate(command.run, hostDir);
      process.stdout.write(`${canonicalJson(statusSingleFlight(run.runDir, run.arc, () => status(run.runDir, run.arc, hostDir)))}\n`);
      return;
    }
    case 'reverse':
      return submit(command.run, hostDir, { type: 'reverse', divergence: command.divergence });
    case 'note':
      return submit(command.run, hostDir, { type: 'note', unit: command.unit, brief: hashedFile('note', command.brief) });
    case 'steer':
      return submit(command.run, hostDir, {
        type: 'steer', unit: command.unit, brief: hashedFile('steer', command.brief), budgetMin: command.budgetMin, class: command.class, resume: command.resume,
      });
    case 'merge-in':
      return submit(command.run, hostDir, { type: 'merge-in', unit: command.unit });
    case 'scope-decide':
      return submit(command.run, hostDir, { type: 'scope-decide', unit: command.unit, decision: command.decision, reason: command.reason });
    case 'demo':
      return submit(command.run, hostDir, { type: 'demo', act: command.act });
    case 'audit':
      return submit(command.run, hostDir, { type: 'audit', lenses: command.lenses });
    case 'close-admissions':
      return submit(command.run, hostDir, { type: 'close-admissions' });
    case 'gc': {
      const outcome = await gc({ hostDir, repo: absPath(resolve(command.repo)), keep: command.keep ?? DEFAULT_KEEP, dryRun: command.dryRun });
      if (outcome.kind === 'done') {
        process.stdout.write(`${canonicalJson(outcome.report)}\n`);
        return;
      }
      process.stdout.write(`${canonicalJson({ refused: outcome.rejection })}\n`);
      process.exitCode = outcome.rejection.kind === 'host-busy' ? EXIT_HOST_BUSY : EXIT_REFUSED;
      return;
    }
    case 'phase0-check': {
      const report = await phase0Check({ repo: repoOf(command.repo), source: command.source.type === 'plan' ? { type: 'plan', plan: resolve(command.source.plan) } : command.source });
      process.stdout.write(`${canonicalJson(report)}\n`);
      if (report.rows.length > 0) process.exitCode = EXIT_REFUSED;
      return;
    }
    case 'corpus-pin': {
      const outcome = await corpusPin({ repo: repoOf(command.repo), commit: command.commit, baseline: command.baseline, out: absPath(resolve(command.out)) });
      if (outcome.kind === 'refused') return refused(outcome.rejection);
      process.stdout.write(`${canonicalJson({ pin: outcome.pin, sha256: outcome.sha256 })}\n`);
      return;
    }
    case 'brief': {
      const outcome = await brief({ repo: repoOf(command.repo), ack: command.ack });
      switch (outcome.kind) {
        case 'brief':
          process.stdout.write(command.json ? `${canonicalJson({ briefId: outcome.briefId, payload: outcome.payload })}\n` : outcome.markdown);
          return;
        case 'acked':
          process.stdout.write(`${canonicalJson({ acked: outcome.briefId, commands: outcome.commands })}\n`);
          return;
        case 'stale':
          process.stdout.write(`${canonicalJson({ stale: { expected: outcome.expected, actual: outcome.actual } })}\n`);
          process.exitCode = EXIT_REFUSED;
          return;
      }
      return;
    }
    case 'pr':
      process.stdout.write(`${canonicalJson(await openPr({ repo: repoOf(command.repo), arc: command.arc, supersedePrevious: command.supersedePrevious }))}\n`);
      return;
    case 'chain-status':
      process.stdout.write(`${canonicalJson(await chainStatus({ repo: repoOf(command.repo) }))}\n`);
      return;
    case 'answer': {
      const outcome = recordAnswer(repoOf(command.repo), command.question, command.text, command.arc);
      process.stdout.write(`${canonicalJson(outcome.kind === 'refused' ? { refused: outcome.refusal } : { [outcome.kind]: outcome.answer })}\n`);
      if (outcome.kind === 'refused') process.exitCode = EXIT_REFUSED;
      return;
    }
    case 'witness-check': {
      const outcome = await witnessCheck({ laneFile: absPath(resolve(command.laneFile)), cwd: absPath(process.cwd()) });
      if (outcome.kind === 'passed') {
        process.stdout.write(`${canonicalJson({ passed: true })}\n`);
        return;
      }
      process.stdout.write(`${canonicalJson({ missing: outcome.missing, failed: outcome.failed, malformed: outcome.malformed })}\n`);
      process.exitCode = EXIT_REFUSED;
      return;
    }
    case 'resume-arc': {
      const outcome = await resumeArc({ hostDir, repo: repoOf(command.repo) });
      if (!outcome.resumed) {
        process.stdout.write(`${canonicalJson({ resumed: false, reason: outcome.reason })}\n`);
        return;
      }
      process.stdout.write(`${outcome.line}\n`);
      process.exitCode = outcome.code;
      return;
    }
    case 'inputs-export':
      process.stdout.write(`${canonicalJson(await exportInputs({ repo: repoOf(command.repo), arc: command.arc, out: absPath(resolve(command.out)) }))}\n`);
      return;
    case 'flow-decide':
    case 'flow-request':
    case 'flow-given': {
      const args = command.command === 'flow-decide'
        ? { type: 'decide' as const, proposal: command.proposal, decision: command.decision, reason: command.reason, run: command.run }
        : command.command === 'flow-request'
          ? { type: 'request' as const, reason: command.reason, run: command.run }
          : { type: 'given' as const, repo: repoOf(command.repo), lever: command.lever, note: command.note };
      const outcome = await flowCommand(args, hostDir);
      switch (outcome.kind) {
        case 'submitted':
          process.stdout.write(`${canonicalJson({ command: outcome.command, arc: outcome.arc })}\n`);
          return;
        case 'given':
          process.stdout.write(`${canonicalJson({ given: outcome.given })}\n`);
          return;
        case 'refused':
          process.stdout.write(`${canonicalJson({ refused: outcome.reason })}\n`);
          process.exitCode = EXIT_REFUSED;
          return;
      }
      return;
    }
  }
}

const repoOf = (repo: string): AbsPath => absPath(resolve(repo));

/** A host act's refusal: the row as JSON, exit 78. */
function refused(rejection: StartupRejection): void {
  process.stdout.write(`${canonicalJson({ refused: rejection })}\n`);
  process.exitCode = EXIT_REFUSED;
}

/** A file a command names, by its absolute path and the sha256 of its bytes as the CLI read them. */
function hashedFile(command: string, path: string): Readonly<{ path: AbsPath; sha256: ReturnType<typeof sha256> }> {
  const abs = absPath(resolve(path));
  if (!existsSync(abs)) throw new CliError(`${command}: no file ${abs}`);
  return { path: abs, sha256: sha256(sha256Hex(readFileSync(abs))) };
}

/** start.json of a run: the plan file an apply hashes, the repo and the resolved profile. */
function startOf(run: Run): RunStart {
  const path = join(run.runDir, START_FILE);
  if (!existsSync(path)) throw new CliError(`arc ${run.arc} has never started (no ${path})`);
  return runStart(readJson(path), START_FILE);
}

/** `apply --dry-run`: the executor's evaluation, read-only, over the log as `status` reads it. */
async function dryRun(run: Run, start: RunStart, hostDir: AbsPath, planFile: AbsPath, base: RevisionManifest, rev: number, reason: string): Promise<unknown> {
  const { view } = readJournal(run.runDir, run.arc);
  const verdict = await evaluateApply({
    runDir: run.runDir, view, hostDir, repo: start.repo, planFile, routingBase: { profile: start.profile, config: readRepoConfig(start.repo), arcRoles: arcRolesOf(view.planApplied()) },
    laneEnv: process.env, manifest: null, base, rev, reason,
  });
  switch (verdict.kind) {
    case 'rejected':
      // dev.17: refused only because units run a stage attempt: the apply would queue behind their boundary and be evaluated there.
      return verdict.busy === undefined
        ? { dryRun: true, kind: 'rejected', reasons: verdict.reasons }
        : { dryRun: true, kind: 'queues', waitsFor: verdict.busy, reasons: verdict.reasons };
    case 'unchanged':
      return { dryRun: true, kind: 'unchanged', rev: verdict.rev };
    case 'accepted':
      return {
        dryRun: true, kind: 'accepted', rev: verdict.rev, nextRev: verdict.evaluated.draft.rev, changes: verdict.evaluated.draft.changes, smoke: verdict.smoke,
        advisories: verdict.advisories, warnings: verdict.warnings,
      };
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
