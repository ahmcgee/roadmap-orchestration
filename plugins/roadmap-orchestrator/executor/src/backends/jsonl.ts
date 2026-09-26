// The JSONL event streams both CLIs print on stdout (`codex exec --json`, `claude -p --output-format
// stream-json`). A workload killed mid-write (pause, stop, deadline) leaves a final line without its
// newline: that unterminated fragment is dropped, so the complete events before it (a thread id, the tool
// calls) are still read. A complete line that is not a JSON object with a string `type` is malformed
// output and throws.
import { MalformedOutputError } from './errors.ts';

export type StreamEvent = Readonly<Record<string, unknown>>;

export function jsonLines(stdout: string, file: string): readonly StreamEvent[] {
  const lines = stdout.split('\n');
  // The last element is '' after a final newline, or the unterminated fragment of a torn write.
  lines.pop();
  return lines.flatMap((line, i) => {
    if (line === '') return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new MalformedOutputError(file, `line ${i + 1} is not JSON: ${line.slice(0, 120)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as StreamEvent)['type'] !== 'string') {
      throw new MalformedOutputError(file, `line ${i + 1} is not an event object with a string type`);
    }
    return [value as StreamEvent];
  });
}
