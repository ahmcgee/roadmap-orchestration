import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { planInForce } from '../src/input/inforce.ts';
import { status } from '../src/status.ts';
import { statusSummary, summarize } from '../src/status/summary.ts';
import { enrichedParityArc, parityArc, portableEnrichedStatus, portableStatus } from './fixtures/status-parity.ts';

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

test('status and summary validate malformed receipts outside the ten displayed rows', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { d, runDir, hostDir } = parityArc();
  writeFileSync(join(runDir, 'commands', 'receipts', 'cmd-0000000000000001.rejected.json'), '{}');
  assert.throws(() => status(runDir, arcId(d.arc), hostDir));
  assert.throws(() => statusSummary(runDir, arcId(d.arc), hostDir));
});

test('status and summary match origin/main with certification, exit records, historical witnesses, chain and answers', async () => {
  const { d, runDir, hostDir } = await enrichedParityArc();
  const arc = arcId(d.arc);
  const full = status(runDir, arc, hostDir);
  const log = readJournal(runDir, arc);
  const summary = summarize(full, log.events, planInForce(runDir, log.view)!.plan);
  // Captured by status-parity-capture.ts against origin/main (327204ae), never the optimized projection.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/status-parity-enriched.golden.json', import.meta.url), 'utf8'));
  assert.deepEqual(portableEnrichedStatus({ full, summary }), golden);
  assert.deepEqual(full.units.slice(0, 2).map((u) => u.certification?.lanes.map((l) => l.state)), [['green', 'reused'], ['green', 'reused']]);
  assert.ok(full.units.slice(0, 2).every((u) => u.work.length === 1 && u.work[0]!.cause === 'exited' && u.work[0]!.measured?.runMs === 80));
  assert.deepEqual(full.notYetTrue.map((o) => o.lastObserved?.verdict), ['held', 'not-held']);
  assert.equal(full.notYetTrue[1]!.lastObserved?.evidence.length, 0, 'the second historical verdict comes from an external attestation');
  assert.equal(full.chain?.position, 2);
  assert.equal(full.chain?.arcs[0]?.arc, 'earlier');
  assert.ok(full.corpus !== null && full.corpus.rules.active > 0);
  assert.equal(full.census?.lastHeld, 1);
  assert.equal(full.debt?.banked.length, 1);
  assert.equal(full.debt?.ledger.length, 1);
  assert.equal(full.answers.length, 1);
  assert.equal(full.commands.receipts.length, 10);
  assert.equal(full.commands.pending.length, 1);
  assert.equal(full.milestones.length, 1);
  assert.equal(JSON.stringify(statusSummary(runDir, arc, hostDir)), JSON.stringify(summary));
});
