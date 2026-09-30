// Crash child of the AUDIT_JOB matrix row (test/audit.test.ts): reopens the arc an audit was requested in and runs the
// audit; the crash trigger in ROADMAP_TEST_CRASH kills it at the row's label.
import { runAudit } from '../../src/holistic/audit.ts';
import { auditContext } from './audit-common.ts';
import { contextFor } from './unit-common.ts';

const r = contextFor(JSON.parse(process.argv[2]!));
try {
  process.stdout.write(`${JSON.stringify(await runAudit(auditContext(r).ctx))}\n`);
} finally {
  r.journal.close();
}
