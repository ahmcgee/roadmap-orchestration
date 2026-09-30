// The red-lane protocol (M2, A10; SCHEMAS.md "Lane dir"): what a lane that ran red (failed or stalled) means
// before it counts against the unit. It applies to every lane series, spec and suite alike (lanes.ts
// `runLaneSeries` calls it for each red lane).
//
//   host signature, busy host   the output matches a host signature (src/host/signatures.ts) and the lane's
//                               host samples show a busy host: wait (at most HOST_CLEAR_WAIT_MS, cancellable,
//                               holding nothing) for a clear host, then one rerun at the same SHA. Green: the
//                               lane passes, the red was the host's. Red with a signature again: `blocked`.
//                               Red without one: red, the rerun's verdict.
//   host signature, no evidence the host samples do not show a busy host: `blocked` (no verdict, uncharged).
//   no signature                one diagnostic rerun. Red again: red. Green: still red, `flaky`, charged as
//                               red, and its fix round is told the lane is flaky.
//
// Both runs are kept: the first in the lane's dir, the rerun in `<lane>.rerun/`. A reader of the series later
// derives the same decision from the files with the same functions (`classifyRed`, `afterRerun`), so the
// live series and its read-back agree.
import { setTimeout as sleep } from 'node:timers/promises';
import { type HostSample, isBusy, isClear } from '../host/sample.ts';
import type { HostSignatureId } from '../host/signatures.ts';

/** How long a signature red waits for a clear host before it is `blocked`. Default, unmeasured. */
export const HOST_CLEAR_WAIT_MS = 30 * 60_000;
/** How often the wait samples the host. Default, unmeasured. */
export const HOST_CLEAR_POLL_MS = 10_000;

/** A lane's host samples, taken at its start and its end (`<lane>/host.json`). */
export type LaneHost = Readonly<{ start: HostSample; end: HostSample }>;

/** What the protocol reads from one red run: the host signatures in its output and its host samples (null: none recorded). */
export type RedEvidence = Readonly<{ signatures: readonly HostSignatureId[]; host: LaneHost | null }>;

/** Why a red lane is rerun, or why it is not. */
export type RedClass =
  | Readonly<{ kind: 'host-signature'; signatures: readonly HostSignatureId[] }>
  | Readonly<{ kind: 'signature-without-evidence'; signatures: readonly HostSignatureId[] }>
  | Readonly<{ kind: 'diagnostic' }>;

export type RerunReason = Extract<RedClass, { kind: 'host-signature' | 'diagnostic' }>['kind'];

/** Busy at either sample: the host evidence a signature needs. */
export const hostWasBusy = (host: LaneHost | null): boolean => host !== null && (isBusy(host.start) || isBusy(host.end));

/** The protocol's reading of a red run. */
export function classifyRed(first: RedEvidence): RedClass {
  if (first.signatures.length === 0) return { kind: 'diagnostic' };
  return hostWasBusy(first.host) ? { kind: 'host-signature', signatures: first.signatures } : { kind: 'signature-without-evidence', signatures: first.signatures };
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
  /** The rerun decided: `pass`/`red`/`blocked` as `afterRerun` reads it. */
  | Readonly<{ kind: 'reran'; reason: RerunReason; verdict: LaneVerdict; rerun: R }>
  /** A signature without host evidence, or a host that did not clear in time: no rerun. */
  | Readonly<{ kind: 'blocked'; detail: string }>
  /** Cancelled while waiting for a clear host. */
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'ended'; end: E }>;

/**
 * The protocol for one red run with evidence `first`: classify, wait for a clear host when a signature has
 * busy-host evidence, and `rerun` at most once at the same SHA. `rerun` takes its own reservation and
 * releases it; nothing is held while waiting.
 */
export async function redLane<R, E>(
  first: RedEvidence, rerun: () => Promise<RerunEnd<R, E>>, host: Readonly<{ sample: () => HostSample; signal: AbortSignal }>,
): Promise<RedLaneResult<R, E>> {
  const cls = classifyRed(first);
  if (cls.kind === 'signature-without-evidence') {
    return { kind: 'blocked', detail: `red with host signature ${cls.signatures.join(', ')}, but the host samples do not show a busy host` };
  }
  if (cls.kind === 'host-signature') {
    const waited = await waitForClearHost(host.sample, host.signal);
    if (waited.kind === 'interrupted') return waited;
    if (waited.kind === 'timeout') return { kind: 'blocked', detail: `red with host signature ${cls.signatures.join(', ')}, and the host was not clear within ${HOST_CLEAR_WAIT_MS / 60_000} minutes` };
  }
  const ran = await rerun();
  if (ran.kind === 'ended') return ran;
  return { kind: 'reran', reason: cls.kind, verdict: afterRerun(cls.kind, ran.verdict), rerun: ran.run };
}
