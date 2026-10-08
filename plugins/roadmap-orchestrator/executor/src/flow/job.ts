// The flow job (plan "Triggers and the job"): kind `flow`, its own scheduler track on every arc, mutually exclusive with a
// running holistic job and after it in priority, skipped while paused or stopped or its backend is parked. Under the
// fence it keeps `FlowInputs` as `inputs/<sha>.flow-inputs.json` and journals `flow-started`; the call reads only the kept
// bytes; code's checks run after the schema (src/flow/levers.ts); `flow-ended`, then one non-blocking `flow-proposal`
// (or `flow-host`) item per proposal id, or `flow-invalid` after one retry. Crash points `flow.after-started`,
// `flow.after-call`, `flow.after-ended`. PLACEHOLDER (step 0a): step B1 replaces this module in place.
import type { JobId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';

export type FlowJobContext = Readonly<{ runDir: AbsPath; journal: Journal }>;

/** Runs flow job `job` to its `flow-ended` (resuming a started one from its kept inputs). */
export async function runFlowJob(_ctx: FlowJobContext, _job: JobId): Promise<void> {
  return notYet('runFlowJob', 'B1');
}
