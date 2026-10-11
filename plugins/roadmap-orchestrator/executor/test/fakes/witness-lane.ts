// A fake arc lane that reports per-test results the way a reporting lane does: it appends one JSON line per
// test id to `$ROADMAP_WITNESS_FILE` (O_APPEND), `{testId, selected, outcome}` (a WitnessTest).
// argv: <node-test|jsonl> <controlFile> [lane]. The control file (test/helpers/witness.ts) says which outcome each
// test id gets on the tree the lane runs in: the cwd's working tree id (worktreeTree), else the `*` entry.
// A tree with neither entry reports nothing (every declared test unwitnessed). A `malformed` entry writes a
// line that is not JSON. A lane the entry names `absent` reports nothing, says so on stderr and exits 1. Exit 1 when any test failed, as `node --test` does, else 0.
// `node-test` also prints TAP-like lines to stdout, as `node --test` would; `jsonl` prints nothing (it is run
// through the shell wrapper helpers/witness.ts writes).
import { appendFileSync, readFileSync } from 'node:fs';
import { worktreeTree } from '../helpers/repo.ts';
import type { TreePlan, WitnessControl } from '../helpers/witness.ts';

const [reporter, controlFile, lane] = process.argv.slice(2);
if ((reporter !== 'node-test' && reporter !== 'jsonl') || controlFile === undefined) {
  throw new Error(`usage: witness-lane <node-test|jsonl> <controlFile>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const witnessFile = process.env['ROADMAP_WITNESS_FILE'];
if (witnessFile === undefined) throw new Error('witness-lane: ROADMAP_WITNESS_FILE is not set');

const control = JSON.parse(readFileSync(controlFile, 'utf8')) as WitnessControl;
const tree = worktreeTree(process.cwd());
const plan: TreePlan | undefined = control.trees[tree] ?? control.trees['*'];

if (lane !== undefined && plan?.absent?.includes(lane) === true) {
  process.stderr.write(`Could not find the test file of lane ${lane}\n`);
  process.exit(1);
}
let failed = false;
if (plan !== undefined) {
  if (plan.malformed === true) appendFileSync(witnessFile, 'not json\n');
  let n = 0;
  for (const [testId, outcome] of Object.entries(plan.outcomes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    n += 1;
    appendFileSync(witnessFile, `${JSON.stringify({ testId, selected: outcome === 'zero-selected' ? 0 : 1, outcome })}\n`);
    if (outcome === 'fail') failed = true;
    if (reporter === 'node-test') {
      const line = outcome === 'fail' ? `not ok ${n} - ${testId}` : outcome === 'skip' ? `ok ${n} - ${testId} # SKIP` : `ok ${n} - ${testId}`;
      process.stdout.write(`${line}\n`);
    }
  }
}
process.exit(failed ? 1 : 0);
