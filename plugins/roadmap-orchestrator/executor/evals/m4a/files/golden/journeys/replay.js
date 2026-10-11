// The fake story's witness-lane fake (fake runs only; the paid product has no such file): a suite lane that writes
// node-test witness lines itself when a witness run names a file for them ($ROADMAP_WITNESS_FILE). Under
// --test-concurrency=1 both of its tests pass; under any other value the second is skipped, so an in-place
// concurrency edit changes its (testId, selected, outcome) triples: the flow proof's `changed`, the story's bait.
// Outside a witness run it prints one line and exits 0.
import { appendFileSync } from 'node:fs';

const serial = process.argv.includes('--test-concurrency=1');
const file = process.env.ROADMAP_WITNESS_FILE;
if (file !== undefined && file !== '') {
  const line = (testId, outcome) => appendFileSync(file, `${JSON.stringify({ testId, selected: 1, outcome })}\n`);
  line('the replay books every slot in order', 'pass');
  line('the replay keeps the kiosk and the office in step', serial ? 'pass' : 'skip');
}
console.log(`replay: ${serial ? 'one file at a time' : 'files side by side'}`);
