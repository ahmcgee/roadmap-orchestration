// The runner's view of a backend's final report (runner.ts "Reported"). A build may legitimately leave something
// pending when it ends a turn: a ScheduleWakeup, a Monitor, a background command (waiting for Kubernetes to reconcile is
// idle and silent, so no watchdog can tell it from a hang). Claude's `-p` session then stays alive until the pending
// work fires, and every turn it ends emits a `result` with schema-valid `structured_output` (with `--json-schema` the
// CLI forces a StructuredOutput call at each turn end; Claude Code 2.1.288, 2026-10-11: a Monitor wait printed a
// `result` per turn, `result_index` 0, 1, 2, each schema-valid). A schema-valid result alone therefore does not say
// the build is done; the answer says so itself.
//
// A role whose schema declares a top-level boolean `final` (the build answer, src/prompts/schemas.ts `BUILD_SCHEMA`)
// marks its final report `final: true` and an answer it gives only because it ends a turn to wait `final: false`.
// The runner watches the terminal's output: Claude's stdout stream (its latest `result` event's `structured_output`),
// Codex's `-o` file (written once, at the end of the turn). Once the latest report is schema-valid and final, and the
// workload is still running `REPORT_GRACE_MS` later (the CLI exiting, or descendants outliving it), the runner ends
// it with cause `reported`. Before a final report, waiting is unrestricted; the deadline stays the backstop. A schema
// without `final` (every judgment, the smoke) is never watched.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { backendSchemaViolation } from '../backends/adapter.ts';
import type { BackendTerminal, LaunchTerminal } from '../core/records.ts';

/** How long the runner lets a workload run on after its final report before it ends it (cause `reported`). */
export const REPORT_GRACE_MS = 30_000;

/** Whether the latest report on a terminal's output is schema-valid and final. */
export type ReportWatch = () => boolean;

type Json = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The watch for `terminal`, or null when its schema declares no `final` (nothing to watch). */
export function reportWatch(terminal: LaunchTerminal): ReportWatch | null {
  if (terminal.type !== 'backend') return null;
  const schema: unknown = JSON.parse(readFileSync(terminal.schemaPath, 'utf8'));
  const final = isObject(schema) && isObject(schema['properties']) ? schema['properties']['final'] : undefined;
  if (!isObject(final) || final['type'] !== 'boolean') return null;
  const isFinal = (value: unknown): boolean => isObject(value) && value['final'] === true && backendSchemaViolation(schema, value, terminal.role) === null;
  return terminal.session.backend === 'claude' ? streamWatch(terminal, isFinal) : fileWatch(terminal, isFinal);
}

/**
 * Claude: the stdout stream, read incrementally. Only complete lines count (a torn last line waits for its newline); the
 * latest `result` event decides, so an interim answer after a final one withdraws it. A result line that is not JSON
 * reads as not final: the adapter, not the runner, judges malformed output.
 */
function streamWatch(terminal: BackendTerminal, isFinal: (value: unknown) => boolean): ReportWatch {
  let offset = 0;
  // Bytes after the last newline: split on bytes, so a UTF-8 character torn across two reads is decoded whole.
  let pending = Buffer.alloc(0);
  let latest = false;
  return () => {
    if (!existsSync(terminal.outputPath)) return false;
    const fd = openSync(terminal.outputPath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return latest;
      const chunk = Buffer.alloc(size - offset);
      const got = readSync(fd, chunk, 0, chunk.length, offset);
      offset += got;
      const bytes = Buffer.concat([pending, chunk.subarray(0, got)]);
      const end = bytes.lastIndexOf(0x0a);
      pending = bytes.subarray(end + 1);
      if (end < 0) return latest;
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"result"')) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          latest = false;
          continue;
        }
        if (isObject(event) && event['type'] === 'result') latest = isFinal(event['structured_output']);
      }
      return latest;
    } finally {
      closeSync(fd);
    }
  };
}

/** Codex: the `-o` file, re-read whenever its size or mtime changes. */
function fileWatch(terminal: BackendTerminal, isFinal: (value: unknown) => boolean): ReportWatch {
  let seen = '';
  let latest = false;
  return () => {
    if (!existsSync(terminal.outputPath)) return false;
    // Codex writes the file whole at the end of its turn; a read that races the write sees invalid JSON, not final.
    const st = statSync(terminal.outputPath);
    const stamp = `${st.size}:${st.mtimeMs}`;
    if (stamp === seen) return latest;
    seen = stamp;
    try {
      latest = isFinal(JSON.parse(readFileSync(terminal.outputPath, 'utf8')));
    } catch {
      latest = false;
    }
    return latest;
  };
}
