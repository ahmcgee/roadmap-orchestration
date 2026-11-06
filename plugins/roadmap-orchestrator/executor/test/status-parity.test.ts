import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { planInForce } from '../src/input/inforce.ts';
import { status } from '../src/status.ts';
import { statusSummary, summarize } from '../src/status/summary.ts';
import { parityArc, portableStatus } from './fixtures/status-parity.ts';

test('status and summary retain the captured rich projection, including receipt order and completion', () => {
  const { d, runDir, hostDir } = parityArc();
  const arc = arcId(d.arc);
  const full = status(runDir, arc, hostDir);
  const log = readJournal(runDir, arc);
  const summary = summarize(full, log.events, planInForce(runDir, log.view)!.plan);
  const golden = JSON.parse(readFileSync(new URL('./fixtures/status-parity.golden.json', import.meta.url), 'utf8'));
  assert.deepEqual(portableStatus({ full, summary }), golden);
  assert.equal(full.commands.receipts.length, 10);
  assert.equal(full.commands.pending.length, 1);
  assert.equal(full.units.length, 3);
  assert.equal(full.milestones.length, 1);
  assert.equal(full.notYetTrue.length, 1);
  assert.equal(full.needsUser.length, 1);
  // Compare the complete serialized summary, with no field omissions or reordering.
  assert.equal(JSON.stringify(statusSummary(runDir, arc, hostDir)), JSON.stringify(summary));
});
