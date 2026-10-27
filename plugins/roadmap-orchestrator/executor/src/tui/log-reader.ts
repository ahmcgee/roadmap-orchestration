import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { keptInput, inputPath } from '../input/inforce.ts';
import { invocationIdOf, sha256 } from '../core/ids.ts';
import { runnerFiles } from '../runner/files.ts';
import { launchSha256 } from '../runner/launch.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { activityState, assessmentExplanation } from './outcome.ts';
import { TranscriptReader } from './transcript.ts';
import { project, record } from './projection.ts';
import { type LogPage, type LogReadRequest, type LogReply, pretty } from './types.ts';

const missing = (key: string, reason: string): LogPage => ({ key, start: 0, end: 0, size: 0, lines: [reason], error: reason });

/** Log pages are independent of journal folding and display observations. */
export class LogReader {
  #logs = new TranscriptReader();
  #verifiedPrompts = new Map<string, string>();

  read(request: LogReadRequest): LogReply {
    try {
      if (request.selected.id !== request.log.inv) throw new Error('Log invocation does not match the selected row');
      const { run, selected } = request;
      const dir = invocationDir(run.runDir, invocationIdOf(request.log.inv));
      let log: LogPage;
      if (request.log.source === 'prompt') {
        const launch = runnerFiles(dir, invocationIdOf(request.log.inv)).read('launch.json');
        if (launch && launchSha256(launch) !== selected.launchSha256) throw new Error('Recorded prompt launch binding changed');
        const match = launch?.stdinPath ? /^([0-9a-f]{64})\.prompt\.txt$/.exec(basename(launch.stdinPath)) : null;
        if (!match) log = missing(`${request.log.inv}:prompt`, 'No retained agent input prompt is recorded for this invocation.');
        else {
          const hash = sha256(match[1]!); const path = inputPath(run.runDir, hash, 'prompt.txt');
          if (!existsSync(path)) log = missing(`${request.log.inv}:prompt`, 'The recorded input prompt is unavailable or has been pruned.');
          else {
            const stat = statSync(path); const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
            if (this.#verifiedPrompts.get(path) !== stamp) {
              keptInput(run.runDir, hash, 'prompt.txt');
              this.#verifiedPrompts.delete(path); this.#verifiedPrompts.set(path, stamp);
              while (this.#verifiedPrompts.size > 8) this.#verifiedPrompts.delete(this.#verifiedPrompts.keys().next().value!);
            }
            log = this.#logs.read(path, request.log.before, false, false, request.log.after);
          }
        }
      }
      else if (request.log.source === 'result') {
        const files = runnerFiles(dir, invocationIdOf(selected.id));
        const result = files.read('result.json');
        const details = { invocation: JSON.parse(selected.body), launch: files.read('launch.json'), runner: files.read('runner.json'),
          result: result ?? 'Unavailable or pruned result', exit: files.read('exit.json') };
        const outcome = record(record(result)['outcome']);
        const friendly = {
          ...(selected.execution === 'agent' ? { model: selected.model ?? 'unavailable', backend: selected.backend ?? 'unavailable', adapter: selected.adapter ?? null, requestedModel: selected.requestedModel ?? null } : {}),
          ...(selected.milestone ? { milestone: selected.milestone } : {}),
          outcome: activityState(selected), processOutcome: selected.state, ...(assessmentExplanation(selected) ? { explanation: assessmentExplanation(selected) } : {}), role: selected.role, unit: selected.unit, attempt: selected.attempt,
          ...(outcome['value'] !== undefined ? { report: outcome['value'] } : {}),
          ...(outcome['detail'] !== undefined ? { detail: outcome['detail'] } : {}),
          startedAt: selected.startedAt, endedAt: selected.endedAt,
          result: result?.type === 'backend' && result.outcome.kind === 'success' ? { ...result, outcome: { kind: result.outcome.kind } } : result ?? 'Unavailable or pruned result', executionDetails: { invocation: selected.id, session: selected.session || null, cwd: details.launch?.cwd ?? null, exit: details.exit, diagnostics: 'Press r for full launch arguments and runner metadata.' },
        };
        log = { key: `${selected.id}:result`, start: 0, end: 0, size: 0,
          lines: request.log.raw ? pretty(details).split('\n') : project(friendly).map((row) => row.text), error: null };
      }
      else log = this.#logs.read(join(dir, request.log.source === 'transcript' ? 'stdout' : request.log.source), request.log.before, ['transcript', 'stdout'].includes(request.log.source) && !request.log.raw, request.log.expanded, request.log.after);
      return { token: request.token, log, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { token: request.token, log: missing(`${request.log.inv}:${request.log.source}`, message), error: message };
    }
  }
}
