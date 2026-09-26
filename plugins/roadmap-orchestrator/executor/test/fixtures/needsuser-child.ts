// A child executor for the needs-user tests: argv <runDir> <arc>. Raises one blocking needs-user, prints its
// id, then waits to be killed (`needsuser.durable-restart`) unless a crash trigger kills it first.
import { setTimeout as sleep } from 'node:timers/promises';
import { arcId, unitId } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { raiseNeedsUser } from '../../src/needsuser.ts';

const [runDir, arc] = process.argv.slice(2);
if (runDir === undefined || arc === undefined) throw new Error(`usage: needsuser-child <runDir> <arc>, got ${JSON.stringify(process.argv.slice(2))}`);
const journal = openJournal(absPath(runDir), arcId(arc));
const id = raiseNeedsUser(journal, absPath(runDir), {
  blocking: true,
  subject: { type: 'unit', unit: unitId('u1') },
  reason: 'base-red',
  summary: 'the integration tip is red on its own',
  recommendation: 'fix the base, then resume u1',
  options: [{ id: 'resume', label: 'resume u1 after fixing the base' }],
  evidence: [absPath('/evidence/base-red')],
});
process.stdout.write(`${id}\n`);
await sleep(60_000);
