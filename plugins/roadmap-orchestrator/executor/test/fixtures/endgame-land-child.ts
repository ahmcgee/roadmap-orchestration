// Crash child of the endgame landing's crash cells (test/endgame-recovery.test.ts): reopens the endgame arc whose land
// request is recorded and runs the endgame job due (the landing); the crash trigger in ROADMAP_TEST_CRASH kills it at the
// cell's label.
import { endgameRun, runDue } from './endgame-arc.ts';

const e = endgameRun(JSON.parse(process.argv[2]!));
try {
  await runDue(e);
} finally {
  e.r.journal.close();
}
