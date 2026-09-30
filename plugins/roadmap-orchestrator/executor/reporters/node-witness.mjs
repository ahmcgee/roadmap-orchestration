// The shipped `node-test` witness reporter (plan "Witnesses, observations, the transition table"; src/holistic/witness.ts
// loads it): a `node --test` custom reporter, loaded through NODE_OPTIONS, that appends one JSON line per finished test
// to $ROADMAP_WITNESS_FILE, the same line format a `jsonl` wrapper writes:
//
//   {"testId": "<suite > ... > test name>", "selected": 1, "outcome": "pass" | "fail" | "skip"}
//
// A test's id is its name path from its outermost suite, joined with " > ". Suites are not recorded (their
// tests are); a skipped or todo test is `skip`. Each line is one O_APPEND write, so concurrent writers never tear
// a line. Only the runner process loads it (a `node --test` child reports to it), and it removes the file's
// variable from its own environment on load, so a nested `node --test` that a test spawns records nothing.
// It writes nothing to its stream, whose destination is stderr (node fsyncs a file destination at exit, which
// fails on /dev/null). Plain JavaScript: the lane's node loads it, outside the executor's type stripping.
import { closeSync, openSync, writeSync } from 'node:fs';

const FILE_ENV = 'ROADMAP_WITNESS_FILE';
const file = process.env[FILE_ENV];
delete process.env[FILE_ENV];

export default async function* witnessReporter(source) {
  // Per test file, the names of the tests started at each nesting level.
  const stacks = new Map();
  for await (const event of source) {
    const { type, data } = event;
    if (type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      stacks.set(data.file, stack);
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (file === undefined) continue;
    if (data.details?.type === 'suite') continue;
    const stack = stacks.get(data.file) ?? [];
    const path = [...stack.slice(0, data.nesting), data.name];
    const skipped = (data.skip !== undefined && data.skip !== false) || (data.todo !== undefined && data.todo !== false);
    const outcome = skipped ? 'skip' : type === 'test:pass' ? 'pass' : 'fail';
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, `${JSON.stringify({ testId: path.join(' > '), selected: 1, outcome })}\n`);
    } finally {
      closeSync(fd);
    }
  }
}
