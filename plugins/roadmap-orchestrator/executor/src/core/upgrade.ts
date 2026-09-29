// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by earlier
// releases, so HEAD adopts an arc they started. Each default names the release it serves; delete it (and its
// BACKLOG entry) once no arc started on that release is in flight. Nothing here rewrites a file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CancelFile, ExitFile, ResultFile } from './records.ts';
import type { InputFiles } from '../input/inforce.ts';
import { SpecFileError, bytesSha256, parseSpec } from '../spec/spec.ts';
import type { PlanChange } from './events.ts';
import type { SpecRev } from './ids.ts';
import type { JournalView } from './interfaces.ts';
import { SchemaError } from './validate.ts';

const warned = new Set<string>();

function warnDefaulted(kind: string, detail: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  process.stderr.write(`roadmap: upgrade default (${kind}): ${detail}\n`);
}

/** launch.json `stallMs`, absent before the stall watchdog: read as null, no watchdog. */
export function launchStallMs(read: number | null | undefined, path: string): number | null {
  if (read !== undefined) return read;
  warnDefaulted('launch.stallMs', `${path} has no stallMs (written by 1.0.0-dev.1); read as null, no stall watchdog`);
  return null;
}

/** 1.0.0-dev.1's fixed lane deadline: a lane launched by it started this long before its `deadlineAt`. */
export const DEV1_LANE_DEADLINE_MS = 30 * 60_000;

/**
 * 1.0.0-dev.3 and earlier kept no plan revisions: an arc they started has no `plan-applied` fact until its
 * first start on this release records the baseline (rev 1). Until then `status` reads its plan from the file;
 * this only warns that it does (and the baseline, that it records the files).
 */
export function warnPlanFromFile(arc: string, planFile: string): void {
  warnDefaulted('plan.inForce', `arc ${arc} has no plan-applied fact (started before 1.0.0-dev.4); reading ${planFile} as its plan`);
}

/**
 * Whether a re-pin (a later `dispatch` fact of a unit) names the unit's spec. It does not: the first pin
 * does. But 1.0.0-dev.3's fold took each re-pin's spec, and its routing re-pin copied the first pin's spec
 * rev and hash, so after a reopen a re-pin set the unit back to the first spec, and its later reopen was at
 * that rev + 1. Its log folds only that way, so a re-pin names the spec until the arc's first plan revision
 * (a start on this release records one before anything runs).
 */
export function repinNamesSpec(planApplied: boolean): boolean {
  if (planApplied) return false;
  warnDefaulted('dispatch.repin', 'a re-pin before the arc\'s first plan revision (written by 1.0.0-dev.3 or earlier) names the unit\'s spec, as that release folded it');
  return true;
}

/**
 * The changes the first start on this release records in revision 1 of an arc 1.0.0-dev.3 or earlier
 * started, or why that start is refused. That release ran the live files, so:
 * - a unit the log has state for must still be in plan.json (recovery rebuilds its ops from it, and it
 *   becomes a planned id, never reused);
 * - a dispatched unit whose spec file no longer hashes to its recorded spec takes the file as that release
 *   would have: at the recorded rev, as its spec at once (`evidence`); at rev + 1, as a pending `revision`
 *   (it re-opens on it like any applied revision, so a `resume <unit>` queued before the update re-opens a
 *   parked unit); at any other rev the start is refused.
 * A fresh arc (no unit state) records no change and warns nothing.
 */
export function earlierReleaseBaseline(view: JournalView, files: InputFiles, planFile: string): Readonly<{ changes: readonly PlanChange[] }> | Readonly<{ reasons: readonly string[] }> {
  const known = view.unitsWithState();
  if (known.length === 0) return { changes: [] };
  warnPlanFromFile(view.arc, planFile);
  const reasons: string[] = [];
  const changes: PlanChange[] = [];
  const ids = new Set(files.plan.units.map((u) => u.id));
  for (const unit of known) {
    if (!ids.has(unit)) {
      reasons.push(`unit ${unit} has run in this arc but ${planFile} no longer lists it; restore its entry (an arc started before 1.0.0-dev.4 records its plan revision 1 from the files)`);
      continue;
    }
    const recorded = view.unit(unit).spec;
    const file = files.specs.get(unit);
    if (recorded === null || file === undefined || file.bytes === null) continue;
    const sha = bytesSha256(file.bytes);
    if (sha === recorded.sha256) continue;
    let rev: SpecRev;
    try {
      rev = parseSpec(file.bytes, file.path).rev;
    } catch (error) {
      if (!(error instanceof SchemaError || error instanceof SpecFileError)) throw error;
      reasons.push(`unit ${unit}: its spec does not load: ${error.message}`);
      continue;
    }
    const edit = rev === recorded.rev ? 'evidence' : rev === recorded.rev + 1 ? 'revision' : null;
    if (edit === null) {
      reasons.push(`unit ${unit}: its spec ${file.path} is at rev ${rev}, but the unit's recorded rev is ${recorded.rev}; set rev ${recorded.rev} or ${recorded.rev + 1}`);
      continue;
    }
    warnDefaulted(`spec.baseline.${edit}`, `unit ${unit}'s spec changed after its dispatch (before 1.0.0-dev.4); revision 1 records it as ${edit === 'evidence' ? 'its spec at the recorded rev' : 'a pending revision'}`);
    changes.push({ type: 'spec', unit, edit, specRev: rev, specSha256: sha });
  }
  return reasons.length > 0 ? { reasons } : { changes };
}

/**
 * Why a spec edit of a dispatched unit is refused when the spec it was dispatched at was never kept (an arc
 * started before 1.0.0-dev.4) and its file no longer hashes to it: there is nothing to compare the edit to.
 */
export function unkeptSpecReason(unit: string, path: string): string {
  return `unit ${unit}: the spec it was dispatched at was not kept (dispatched before 1.0.0-dev.4) and ${path} has changed since, `
    + 'so the edit cannot be classified; the file may only be its pending revision, or the dispatched spec to withdraw it';
}

/**
 * The bytes of a spec an arc started before 1.0.0-dev.4 dispatched, which that release never kept: the live
 * file, when it still hashes to `sha`; otherwise the live file as that release would have read it, warned.
 */
export function specBytesFromLiveFile(path: string, sha: string): Buffer {
  const bytes = readFileSync(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  warnDefaulted(
    actual === sha ? 'spec.kept' : 'spec.live',
    actual === sha
      ? `spec ${sha} was not kept in the run dir (dispatched before 1.0.0-dev.4); keeping ${path}, which hashes to it`
      : `spec ${sha} was not kept in the run dir (dispatched before 1.0.0-dev.4) and ${path} has changed since; reading the live file`,
  );
  return bytes;
}

/**
 * 1.0.0-dev.3 and earlier recorded a command (a lane) its runner ended for a pause or stop (exit cause
 * `cancel`) as verdict `process-fault`, the reason only in cancel.json: read as `cancelled{reason}`, the
 * shape written since. `ended` reads the invocation's exit.json and cancel.json, only for such a result.
 */
export function commandCancelled(result: ResultFile, ended: () => Readonly<{ exit: ExitFile | null; cancel: CancelFile | null }>, path: string): ResultFile {
  if (result.type !== 'command' || result.verdict !== 'process-fault') return result;
  const { exit, cancel } = ended();
  if (exit === null || exit.cause !== 'cancel') return result;
  if (cancel === null || cancel.reason === 'recovery') throw new Error(`${path}: exit cause cancel with cancel.json ${JSON.stringify(cancel?.reason ?? null)}, expected pause or stop`);
  warnDefaulted('result.cancelled', `${path} records a cancelled command as process-fault (written by 1.0.0-dev.3 or earlier); read as cancelled{${cancel.reason}}`);
  return { ...result, verdict: 'cancelled', reason: cancel.reason };
}
