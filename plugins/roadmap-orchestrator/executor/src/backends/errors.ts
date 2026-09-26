// Backend error vocabulary, in one place. Nothing here is thrown for a backend failure: a failed turn is
// data (`result.json.backendErrors[]`), classified once by `classifyBackendError`. The thrown classes are
// for the adapter's own inputs: a CLI output the parser cannot read, a schema the validator cannot
// check, and a second, different result for one invocation.
//
// The classifier reads only the text of a CLI error event (Codex `turn.failed` / `error`, Claude's
// `is_error` result), never a model's answer or command output: an agent that prints "at capacity"
// while doing its work is not an outage (DESIGN §3.1, test `backend.capacity-text`).
//
// Vocabulary ported from 0.x (v0.20.0 harness.mjs `limitLines` / `capacityLines` / `OUTAGE_TEXT`).
import type { BackendErrorClass } from '../core/records.ts';

/** A CLI's output does not have the shape its format promises (a torn line, a non-object result). */
export class MalformedOutputError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'MalformedOutputError';
    this.file = file;
  }
}

/** A role schema uses a JSON Schema keyword the adapter's validator does not implement. */
export class UnsupportedSchemaError extends Error {
  constructor(path: string, keyword: string) {
    super(`${path}: JSON Schema keyword ${JSON.stringify(keyword)} is not supported by the adapter's validator`);
    this.name = 'UnsupportedSchemaError';
  }
}

/** result.json is write-once: a re-run must produce the same bytes, or something changed under it. */
export class ResultConflictError extends Error {
  constructor(path: string) {
    super(`${path} already holds a different result; the adapter is deterministic, so an input file changed`);
    this.name = 'ResultConflictError';
  }
}

const USAGE_LIMIT = /usage limit|hit your limit|rate limit|quota/i;
const CAPACITY = /at capacity|try a different model|overloaded/i;
const PLATFORM = /stream disconnected|connection (?:lost|reset|refused|closed)|timed out|service unavailable|internal server error|bad gateway/i;

/**
 * Classify one CLI error event. `httpStatus` is the API status the CLI reported with it (Claude's
 * `api_error_status`, the `status` of a Codex error body), or null. The status decides when it is
 * specific; otherwise the message text does; anything unrecognised is `backend`.
 */
export function classifyBackendError(message: string, httpStatus: number | null): BackendErrorClass {
  if (httpStatus === 429) return 'usage-limit';
  if (httpStatus === 529) return 'capacity';
  if (USAGE_LIMIT.test(message)) return 'usage-limit';
  if (CAPACITY.test(message)) return 'capacity';
  if (httpStatus !== null && httpStatus >= 500) return 'platform';
  if (PLATFORM.test(message)) return 'platform';
  return 'backend';
}
