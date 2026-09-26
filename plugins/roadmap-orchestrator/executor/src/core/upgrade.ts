// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by the
// previous release, 1.0.0-dev.1, so HEAD adopts an arc it started. Delete this module and its BACKLOG entry
// once no arc started on 1.0.0-dev.1 is in flight. Nothing here rewrites a file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).

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
