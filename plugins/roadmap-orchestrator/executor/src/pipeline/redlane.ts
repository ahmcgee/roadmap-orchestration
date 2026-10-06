// The red-lane protocol (M2, A10; SCHEMAS.md "Lane dir"): what a lane that ran red (failed or stalled) means
// before it counts against the unit. It applies to every lane series, spec and suite alike, and to journey series
// (lanes.ts `runLaneSeries`, `runJourneySeries` call it for each red lane).
//
//   host signature, busy host   the output matches a host signature (src/host/signatures.ts) and the lane's
//                               host samples show a busy host: wait (at most HOST_CLEAR_WAIT_MS, cancellable,
//                               holding nothing) for a clear host, then one rerun at the same SHA. Green: the
//                               lane passes, the red was the host's. Red with a signature again: `blocked`.
//                               Red without one: red, the rerun's verdict.
//   host signature, no evidence the host samples do not show a busy host: `blocked` (no verdict, uncharged).
//   repeat (M4a rev 3, F2)      no signature, a host clear at both samples, and the run repeats the unit's latest
//                               earlier red of the same spec lane (`repeatOf`, lanes.ts: not flaky, no pass since,
//                               equal lane rev and environment) with the same specific failure signature: red, not
//                               flaky, and no rerun: the failure is the tree's.
//   no signature                one diagnostic rerun. Red again: red. Green: still red, `flaky`, charged as
//                               red, and its fix round is told the lane is flaky.
//
// Both runs are kept: the first in the lane's dir, the rerun in `<lane>.rerun/`. The class is decided once, before
// any rerun, and persisted write-once in the first run's dir as `red.json` (`RedFile`, Q20) by a spawn stamped with
// `redRev` (`HOST_SIGNATURES_REV`); a reader of the series takes the class from it, never from the current
// signature table, so a grown table never re-reads an earlier run. An unstamped (1.0.0-dev.6) run has no `red.json`
// and is re-derived with the frozen `HOST_SIGNATURES_DEV6` (`classifyRed`, `afterRerun`), so the live series and
// its read-back agree.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { crashPoint } from '../core/crash.ts';
import { exclusivePublish, canonicalJson as fileJson, readJson } from '../core/fsx.ts';
import { type InvocationId, type Sha256Hex, type UnitId, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type CommandVerdict, RED_FILE, type RedClassRecord, type RedFile, redFile } from '../core/records.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type HostSample, isBusy, isClear } from '../host/sample.ts';
import { HOST_SIGNATURES_REV, type HostSignatureId } from '../host/signatures.ts';

/** How long a signature red waits for a clear host before it is `blocked`. Default, unmeasured. */
export const HOST_CLEAR_WAIT_MS = 30 * 60_000;
/** How often the wait samples the host. Default, unmeasured. */
export const HOST_CLEAR_POLL_MS = 10_000;

/** A lane's host samples, taken at its start and its end (`<lane>/host.json`). */
export type LaneHost = Readonly<{ start: HostSample; end: HostSample }>;

/** What the protocol reads from one red run: the host signatures in its output and its host samples (null: none recorded). */
export type RedEvidence = Readonly<{ signatures: readonly HostSignatureId[]; host: LaneHost | null }>;

/** Why a red lane is rerun, or why it is not (persisted as `red.json`'s class). */
export type RedClass = RedClassRecord;

export type RerunReason = 'host-signature' | 'diagnostic';

/** The unit's earlier red execution a run repeats: its stage attempt and its invocation. */
export type RepeatOf = Readonly<{ attempt: number; inv: InvocationId }>;

/** Busy at either sample: the host evidence a signature needs. */
export const hostWasBusy = (host: LaneHost | null): boolean => host !== null && (isBusy(host.start) || isBusy(host.end));

/**
 * The protocol's reading of a red run. `repeat`: the earlier red execution this run repeats (`repeatOf`, lanes.ts, which
 * checks the history, the identity and the specific failure signature), or null; it counts only without a signature, on
 * a host its samples show clear at both ends.
 */
export function classifyRed(first: RedEvidence, repeat: RepeatOf | null): RedClass {
  if (first.signatures.length > 0) {
    return hostWasBusy(first.host) ? { kind: 'host-signature', signatures: first.signatures } : { kind: 'signature-without-evidence', signatures: first.signatures };
  }
  if (repeat !== null && first.host !== null && !hostWasBusy(first.host)) return { kind: 'repeat', attempt: repeat.attempt, inv: repeat.inv };
  return { kind: 'diagnostic' };
}

/**
 * Words a test runner's summary line is made of: a failure line of only these (and masked values) says nothing about
 * which failure it was, so its signature is not specific (F2, R53).
 */
export const GENERIC_SUMMARY_WORDS: ReadonlySet<string> = new Set([
  'fail', 'failed', 'failing', 'error', 'errors', 'tests', 'test', 'exit', 'code', 'status', 'npm', 'err', 'pass', 'passed', 'total', 'duration', 'ms', 's',
]);

/** What a red run's failure signature reads: its verdict and exit code, its output files' tails, and its checkout. */
export type FailureInput = Readonly<{ verdict: CommandVerdict; exitCode: number | null; stderr: string; stdout: string; checkout: string }>;

/** A run's failure signature (`failure`), whether its line identifies the failure (`specific`), and the masked line. */
export type FailureSignature = Readonly<{ failure: Sha256Hex; specific: boolean; line: string }>;

const lastLine = (text: string): string | undefined => text.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1);

/**
 * The failure signature (F2, R53): sha256 of the canonical `{verdict, exitCode, line}`, where `line` is the last
 * non-empty stderr line (else stdout's) with ISO timestamps, the checkout path, hex runs of 7 or more and digit runs
 * masked. Specific when the masked line keeps a word outside `GENERIC_SUMMARY_WORDS`.
 */
export function failureSignature(input: FailureInput): FailureSignature {
  const raw = lastLine(input.stderr) ?? lastLine(input.stdout) ?? '';
  const line = raw
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replaceAll(input.checkout, '<checkout>')
    .replace(/\b[0-9a-fA-F]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>');
  // Words are letter runs: `duration_ms` is `duration` and `ms`.
  const words = line.replace(/<(time|checkout|hex|n)>/g, ' ').toLowerCase().match(/[a-z]+/g) ?? [];
  return {
    failure: sha256(sha256Hex(canonicalJson({ verdict: input.verdict, exitCode: input.exitCode, line }))),
    specific: words.some((w) => !GENERIC_SUMMARY_WORDS.has(w)),
    line,
  };
}

/**
 * Persists a red run's class, write-once in its dir, before the rerun decision (the `RED_CLASS` crash row): a
 * restarted series never re-derives it.
 */
export function writeRedClass(dir: string, cls: RedClass, failure: Sha256Hex, unit: UnitId | undefined): void {
  const record: RedFile = { v: SCHEMA_VERSION, class: cls, failure, redRev: HOST_SIGNATURES_REV };
  exclusivePublish(join(dir, RED_FILE), fileJson(redFile(record, RED_FILE)));
  crashPoint('redlane.after-class', unit);
}

/** A run's persisted red class, or null when it has none (not red, unstamped, or a crash before the write). */
export function readRedClass(dir: string): RedFile | null {
  const path = join(dir, RED_FILE);
  return existsSync(path) ? redFile(readJson(path), path) : null;
}

/** A rerun's verdict and evidence. */
export type RerunRun = Readonly<{ red: boolean; evidence: RedEvidence }>;

export type LaneVerdict =
  | Readonly<{ kind: 'pass' }>
  /** `flaky`: red, then green on the diagnostic rerun. */
  | Readonly<{ kind: 'red'; flaky: boolean }>
  | Readonly<{ kind: 'blocked'; detail: string }>;

/** The lane's verdict once its rerun (for `reason`) ended with a verdict of its own. */
export function afterRerun(reason: RerunReason, rerun: RerunRun): LaneVerdict {
  if (reason === 'diagnostic') return { kind: 'red', flaky: !rerun.red };
  if (!rerun.red) return { kind: 'pass' };
  const { signatures } = rerun.evidence;
  return signatures.length > 0
    ? { kind: 'blocked', detail: `the rerun on a clear host was red with host signature ${signatures.join(', ')} again` }
    : { kind: 'red', flaky: false };
}

/** Why a stage's wait was cancelled: the stage's abort signal carries `pause` or `stop` as its reason. */
export function abortReason(signal: AbortSignal): 'pause' | 'stop' {
  const reason: unknown = signal.reason;
  if (reason !== 'pause' && reason !== 'stop') throw new Error(`a stage was aborted with ${String(reason)}, not pause or stop`);
  return reason;
}

/**
 * Why a lane's wait was cancelled: `pause` or `stop` (the stage's signal), or, for a candidate's suite lanes, `preempt`
 * (M3, A7: a docs publication took the slot before green; src/pipeline/integrate.ts).
 */
export type LaneCancel = 'pause' | 'stop' | 'preempt';

export function laneAbortReason(signal: AbortSignal): LaneCancel {
  const reason: unknown = signal.reason;
  if (reason !== 'preempt') return abortReason(signal);
  return reason;
}

export type HostWait = Readonly<{ kind: 'clear' }> | Readonly<{ kind: 'timeout' }> | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>;

/** Waits, holding nothing, until a sample is clear, at most `waitMs`; cancelled by `signal`. */
export async function waitForClearHost(sample: () => HostSample, signal: AbortSignal, waitMs: number = HOST_CLEAR_WAIT_MS): Promise<HostWait> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (signal.aborted) return { kind: 'interrupted', reason: laneAbortReason(signal) };
    if (isClear(sample())) return { kind: 'clear' };
    const left = until - Date.now();
    if (left <= 0) return { kind: 'timeout' };
    try {
      await sleep(Math.min(HOST_CLEAR_POLL_MS, left), undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

/** What a rerun ended in: a run with a verdict, or the caller's own end without one (lost, occupied, interrupted...). */
export type RerunEnd<R, E> = Readonly<{ kind: 'ran'; run: R; verdict: RerunRun }> | Readonly<{ kind: 'ended'; end: E }>;

export type RedLaneResult<R, E> =
  /** A repeat of the unit's earlier red: red, not flaky, no rerun. */
  | Readonly<{ kind: 'repeat' }>
  /** The rerun decided: `pass`/`red`/`blocked` as `afterRerun` reads it. */
  | Readonly<{ kind: 'reran'; reason: RerunReason; verdict: LaneVerdict; rerun: R }>
  /** A signature without host evidence, or a host that did not clear in time: no rerun. */
  | Readonly<{ kind: 'blocked'; detail: string }>
  /** Cancelled while waiting for a clear host. */
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'ended'; end: E }>;

/**
 * The protocol for one red run of class `cls` (`classifyRed`, persisted first by `writeRedClass`): a repeat ends at
 * once; otherwise wait for a clear host when a signature has busy-host evidence, and `rerun` at most once at the same
 * SHA. `rerun` takes its own reservation and releases it; nothing is held while waiting.
 */
export async function redLane<R, E>(
  cls: RedClass, rerun: () => Promise<RerunEnd<R, E>>, host: Readonly<{ sample: () => HostSample; signal: AbortSignal }>,
): Promise<RedLaneResult<R, E>> {
  if (cls.kind === 'repeat') return { kind: 'repeat' };
  if (cls.kind === 'signature-without-evidence') {
    return { kind: 'blocked', detail: `red with host signature ${cls.signatures.join(', ')}, but the host samples do not show a busy host` };
  }
  if (cls.kind === 'host-signature') {
    const waited = await waitForClearHost(host.sample, host.signal);
    if (waited.kind === 'interrupted') return waited;
    if (waited.kind === 'timeout') return { kind: 'blocked', detail: `red with host signature ${cls.signatures.join(', ')}, and the host was not clear within ${HOST_CLEAR_WAIT_MS / 60_000} minutes` };
  }
  const reason: RerunReason = cls.kind === 'diagnostic' ? 'diagnostic' : 'host-signature';
  const ran = await rerun();
  if (ran.kind === 'ended') return ran;
  return { kind: 'reran', reason, verdict: afterRerun(reason, ran.verdict), rerun: ran.run };
}
