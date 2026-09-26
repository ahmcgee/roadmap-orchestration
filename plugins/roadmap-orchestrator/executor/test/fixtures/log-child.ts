// argv: <mode> <runDir> <arc> [actsFile | ms]. Drives the journal in a child process so crash tests can
// SIGKILL it at a crashPoint.
//   append3: opens the journal and appends an intent, its done and a fact. After each append returns
//            it makes a visible act (a line `act <n>` in actsFile), so a test can tell whether a caller
//            ever acted on an append that did not complete.
//   open:    opens the journal (applying the tail rule) and closes it.
//   append-for <ms>: appends command intents with their done for <ms> milliseconds, so a concurrent
//            read-only reader meets appends in flight (each line is written in two parts).
// The last argument is actsFile for append3 and the duration for append-for.
import { appendFileSync } from 'node:fs';
import { commandId, arcId, opKey, sha256 } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';

const [mode, runDir, arc, actsFile] = process.argv.slice(2);
if (runDir === undefined || arc === undefined) throw new Error(`usage: log-child <mode> <runDir> <arc> [actsFile | ms], got ${JSON.stringify(process.argv.slice(2))}`);
const journal = openJournal(absPath(runDir), arcId(arc));

if (mode === 'append3') {
  if (actsFile === undefined) throw new Error('log-child append3 needs an actsFile');
  const act = (n: number): void => appendFileSync(actsFile, `act ${n}\n`);
  const { op } = journal.begin({
    kind: 'command.apply',
    key: opKey('command:cmd-0123456789abcdef'),
    parent: { type: 'arc' },
    deadlineAt: null,
    body: () => ({ expect: { command: commandId('cmd-0123456789abcdef'), commandSha256: sha256('a'.repeat(64)) }, post: null }),
  });
  act(1);
  journal.done(op, 'command.apply', { kind: 'rejected', reason: 'test' }, null);
  act(2);
  journal.fact({ kind: 'containment-mode', mode: 'session' });
  act(3);
} else if (mode === 'append-for') {
  const until = Date.now() + Number(actsFile);
  for (let i = 0; Date.now() < until; i++) {
    const { op } = journal.begin({
      kind: 'command.apply',
      key: opKey(`command:${i}`),
      parent: { type: 'arc' },
      deadlineAt: null,
      body: () => ({ expect: { command: commandId('cmd-0123456789abcdef'), commandSha256: sha256('a'.repeat(64)) }, post: null }),
    });
    journal.done(op, 'command.apply', { kind: 'rejected', reason: `reason ${i}` }, null);
  }
} else if (mode !== 'open') {
  throw new Error(`log-child: unknown mode ${JSON.stringify(mode)}`);
}
journal.close();
