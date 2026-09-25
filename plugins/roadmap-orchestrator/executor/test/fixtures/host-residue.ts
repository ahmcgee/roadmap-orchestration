// argv: <mode> <runDir> <hostDir>. Drives the failed-cleanup ordering in a child process so crash tests
// can SIGKILL it at the residue crashPoints.
//   fail:    journals a `fail` transition of two resources (FAILED), appends their residues to the host
//            index, then writes the local done: the reservation cycle's normal path.
//   recover: for every open `fail` transition, runs the residue reconciler and writes its done
//            (`recoveredBy: reconciled`): the recovery path.
import { arcId } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { appendFailedCleanupResidues, reconcileFailedCleanup } from '../../src/recover/residue.ts';
import { ARC_NAME, RECIPES, failIntent } from './host-records.ts';

const [mode, runDir, hostDir] = process.argv.slice(2);
if (runDir === undefined || hostDir === undefined) throw new Error(`usage: host-residue <mode> <runDir> <hostDir>, got ${JSON.stringify(process.argv.slice(2))}`);
const host = absPath(hostDir);
const journal = openJournal(absPath(runDir), arcId(ARC_NAME));

if (mode === 'fail') {
  const { op } = journal.begin(failIntent());
  const intent = journal.view.latestIntent(op);
  if (intent.kind !== 'resource.transition') throw new Error(`host-residue: ${op} is a ${intent.kind}`);
  appendFailedCleanupResidues(host, intent, RECIPES);
  journal.done(op, 'resource.transition', { kind: 'transitioned' }, null);
} else if (mode === 'recover') {
  for (const intent of journal.view.openIntents()) {
    if (intent.kind !== 'resource.transition' || intent.expect.edge.type !== 'fail') continue;
    const disposition = reconcileFailedCleanup(host, intent, RECIPES);
    journal.done(intent.op, 'resource.transition', disposition.outcome, 'reconciled');
  }
} else {
  throw new Error(`host-residue: unknown mode ${JSON.stringify(mode)}`);
}
journal.close();
