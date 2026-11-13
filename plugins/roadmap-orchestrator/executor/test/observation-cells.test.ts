// dev.78: the derivation cells (src/observation/memo.ts `cell`). Each cell's key must name every input of what it wraps: for
// each cell, each kind of input is changed and the status it feeds is seen to change, with the cell computed again. Every
// capture here goes through the collector with `shadow: 'always'`, so each one is also derived from nothing and compared.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitCommand, writeReceipt } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { arcId, commandId, envId, invocationId, jobId, obligationId, opKey, planRev, sha, sha256, unitId } from '../src/core/ids.ts';
import { isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { inputShaOf } from '../src/git/reusekey.ts';
import { witnessDir } from '../src/git/snapshot.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { witnessRecordOf, writeWitnessRecord } from '../src/holistic/witness.ts';
import { OBLIGATIONS_INPUT, commitRevisionNow, keepInput, keptPayload, planInForce } from '../src/input/inforce.ts';
import { hasMilestones } from '../src/input/plan.ts';
import { systemsMapInForce } from '../src/input/systems.ts';
import type { CellWork } from '../src/observation/memo.ts';
import { arcScopeOf, provenanceStack, resolveRouting } from '../src/routing/layers.ts';
import type { Status } from '../src/status.ts';
import { git } from './helpers/repo.ts';
import { Observations, type ObservedArc } from './helpers/observations.ts';
import { enrichedParityArc } from './fixtures/status-parity.ts';
import { contextFor } from './fixtures/unit-common.ts';

const NONE: CellWork = { refs: 0, receipts: 0, routing: 0, truths: 0, history: 0 };

/** The enriched parity arc through the collector: `next()` runs one step and returns the status and cells of its capture. */
async function cellsArc() {
  const f = await enrichedParityArc();
  const arc: ObservedArc = new Observations(f.hostDir, 'cells', 'repo').arc({ runDir: f.runDir, arc: f.d.arc });
  const next = (): Readonly<{ status: Status; cells: CellWork }> => {
    const before = arc.messages.length;
    const e = arc.read();
    const published = arc.messages.slice(before).filter((m) => m.kind === 'observation');
    assert.equal(published.length, 1, `one capture published: ${JSON.stringify(arc.messages.slice(before).map((m) => m.kind === 'failed' ? m.error : m.kind))}`);
    return { status: e.data.display.status, cells: published[0]!.kind === 'observation' ? published[0]!.work.cells : NONE };
  };
  return { f, repo: f.d.repo, next };
}
const truthOf = (s: Status, id: string) => [...s.nowTrue, ...s.notYetTrue].find((o) => o.obligation === obligationId(id));

test('cell refs: a ref moved loose or in packed-refs is read again, with what keys on the head; other refs answers stand', { timeout: 120_000 }, async () => {
  const { repo, next } = await cellsArc();
  const cold = next();
  assert.ok(Object.values(cold.cells).every((n) => n > 0), `the first capture computes every cell: ${JSON.stringify(cold.cells)}`);
  assert.equal(truthOf(cold.status, 'I-1')?.verdict, 'not-covered', 'the head moved past the observation');
  const tip = git(repo, 'rev-parse', 'main').trim(), observed = git(repo, 'rev-parse', 'main~1').trim();

  git(repo, 'update-ref', 'refs/heads/main', observed);
  const back = next();
  assert.deepEqual(back.cells, { ...NONE, refs: 1, truths: 1, history: 1 });
  assert.equal(truthOf(back.status, 'I-1')?.verdict, 'held', 'the head is the observed tree again');

  git(repo, 'pack-refs', '--all');
  const packed = next();
  assert.deepEqual(packed.cells, { ...NONE, refs: 1 }, 'the refs moved files, not values: the head is the same');
  assert.equal(truthOf(packed.status, 'I-1')?.verdict, 'held');

  // A packed ref updated in place, as git does: packed-refs rewritten, no loose ref.
  const packedRefs = join(repo, '.git', 'packed-refs');
  writeFileSync(packedRefs, readFileSync(packedRefs, 'utf8').replace(`${observed} refs/heads/main`, `${tip} refs/heads/main`));
  const moved = next();
  assert.deepEqual(moved.cells, { ...NONE, refs: 1, truths: 1, history: 1 });
  assert.equal(truthOf(moved.status, 'I-1')?.verdict, 'not-covered');
});

test('cell receipts: a new receipt, a new incoming command and a command answered are each read again', { timeout: 120_000 }, async () => {
  const { f, next } = await cellsArc();
  const cold = next();
  const at = isoTimeOf(new Date('2026-01-02T00:00:00.000Z'));
  writeReceipt(f.runDir as never, { v: SCHEMA_VERSION, command: commandId('cmd-00000000000000b1'), state: 'rejected', at, reason: 'Rejected b1' });
  const receipt = next();
  assert.deepEqual(receipt.cells, { ...NONE, receipts: 1 });
  assert.equal(receipt.status.commands.receipts.at(-1)?.command, commandId('cmd-00000000000000b1'));
  assert.notDeepEqual(receipt.status.commands.receipts, cold.status.commands.receipts);

  const { id } = submitCommand(f.runDir as never, arcId(f.d.arc), { type: 'resume', target: { type: 'all' } });
  const incoming = next();
  assert.deepEqual(incoming.cells, { ...NONE, receipts: 1 });
  assert.ok(incoming.status.commands.pending.some((p) => p.id === id));

  writeReceipt(f.runDir as never, { v: SCHEMA_VERSION, command: id, state: 'rejected', at, reason: 'Rejected the resume' });
  const answered = next();
  assert.deepEqual(answered.cells, { ...NONE, receipts: 1 });
  assert.ok(!answered.status.commands.pending.some((p) => p.id === id));
  assert.equal(answered.status.commands.receipts.at(-1)?.command, id);
});

test('cell routing: a plan revision under new routing provenance resolves a meter row it left unresolved', { timeout: 120_000 }, async () => {
  const { f, next } = await cellsArc();
  next();
  const r = contextFor(f.d), j = r.journal;
  try {
    const previous = keptPayload(f.runDir as never, j.view.planApplied()!.payloadSha256);
    // A plan layer no revision of the fixture has: a routing revision none of its tables resolves to.
    const provenance = { ...previous.routingProvenance, planLayer: { ...previous.routingProvenance.planLayer, verifier: { med: 'economy' as const } } };
    const plan = planInForce(f.runDir as never, j.view)!.plan;
    const rev = resolveRouting(provenanceStack(provenance, arcScopeOf(plan), null, hasMilestones(plan))).rev;
    // An unmetered spawn of the fixture charged under the routing revision the new provenance resolves to.
    const spawn = j.view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'lane' && !j.view.usageRecorded(invocationId(i.op, i.ordinal)))!;
    j.fact({ kind: 'meter', inv: invocationId(spawn.op, spawn.ordinal), routingRev: rev, subject: { type: 'seat', unit: unitId('u1'), attempt: 1, role: 'build', tier: 'med' },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: 0.5 } } as Fact);
    const metered = next();
    assert.deepEqual(metered.cells, NONE, 'a meter fact is in no cell key');
    assert.ok(metered.status.spend.byModel.unresolvedRevs.includes(rev), 'no revision resolves the meter row yet');

    commitRevisionNow(j, f.runDir as never, { ...previous, routingProvenance: provenance, source: { type: 'command', command: commandId('cmd-00000000000000c1') },
      base: planRev(previous.rev), rev: planRev(previous.rev + 1), changes: [], dispositions: [], divergences: [], publication: null }, { type: 'arc' });
    const applied = next();
    assert.equal(applied.cells.routing, 1, 'a plan-applied computes the routing again');
    assert.equal(applied.cells.truths, 1, 'and what reads the obligations in force');
    assert.ok(!applied.status.spend.byModel.unresolvedRevs.includes(rev), 'the new revision resolves it');
  } finally { j.close(); }
});

test('cells truths and history: a witness on the head, a root attestation, a latch and an apply of new obligations each change the verdicts', { timeout: 120_000 }, async () => {
  const { f, repo, next } = await cellsArc();
  const cold = next();
  assert.equal(truthOf(cold.status, 'I-1')?.verdict, 'not-covered');
  assert.equal(cold.status.notYetTrue.find((o) => o.obligation === obligationId('I-1'))?.lastObserved?.verdict, 'held', 'the history holds the earlier observation');
  const r = contextFor(f.d), j = r.journal;
  try {
    const raw = JSON.parse(readFileSync(join(f.d.planPath, '..', 'obligations.json'), 'utf8'));
    const [lane, external] = parseObligations(raw).lanes;
    const head = sha(git(repo, 'rev-parse', 'main').trim()), tree = sha(git(repo, 'rev-parse', 'main^{tree}').trim());
    const map = systemsMapInForce(j.view.planApplied());

    // A failing witness of I-1's lane on the head's tree.
    const parent = { type: 'job', job: jobId('baseline', 1) } as const;
    const { op } = j.begin({ kind: 'proc.spawn', key: opKey('cells-witness'), parent, deadlineAt: null,
      body: () => ({ expect: { subject: { purpose: 'journey', lane: lane!.id, laneRev: laneRevOf(lane!), at: head, owner: parent }, launchSha256: sha256('d'.repeat(64)) }, post: null }) });
    const inv = invocationId(op, 1);
    const entry = { lane: lane!.id, laneRev: laneRevOf(lane!), envId: envId('fedcba9876543210'), treeSha: tree, inv, purpose: 'witness', for: parent } as const;
    const dir = witnessDir(f.runDir as never, entry); mkdirSync(dir, { recursive: true });
    const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane: lane!, envId: entry.envId, treeSha: tree, inv, purpose: 'witness' }, [{ testId: 't1', selected: 1, outcome: 'fail' }]));
    j.fact({ kind: 'witnessed', ...entry, recordsSha256, inputSha: inputShaOf(repo as never, tree, lane!, map) });
    const witnessed = next();
    assert.deepEqual(witnessed.cells, { ...NONE, truths: 1, history: 1 });
    assert.equal(truthOf(witnessed.status, 'I-1')?.verdict, 'not-held');

    // A passing root attestation of I-2 on the head's inputs.
    j.fact({ kind: 'external-witness', command: commandId('cmd-00000000000000c2'), obligation: obligationId('I-2'), obligationRev: 1, laneRev: laneRevOf(external!),
      inputSha: inputShaOf(repo as never, tree, external!, map), head, result: 'pass', evidence: 'https://ci.example.invalid/cells', evidenceSha256: null } as Fact);
    const attested = next();
    assert.deepEqual(attested.cells, { ...NONE, truths: 1, history: 1 });
    assert.equal(truthOf(attested.status, 'I-2')?.verdict, 'held');

    j.fact({ kind: 'obligation-latched', obligation: obligationId('I-2'), unit: unitId('u1'), treeSha: tree } as Fact);
    const latched = next();
    assert.equal(latched.cells.truths, 1);
    assert.equal(truthOf(latched.status, 'I-2')?.activation, 'must-hold');

    // An apply that waives I-1: its obligations in force change.
    const previous = keptPayload(f.runDir as never, j.view.planApplied()!.payloadSha256);
    const waived = { ...raw, obligations: raw.obligations.map((o: { id: string }) => o.id === 'I-1' ? { ...o, state: { type: 'waived', reason: 'Not in this slice', rev: 1 } } : o) };
    const obligations = keepInput(f.runDir as never, Buffer.from(JSON.stringify(waived)), OBLIGATIONS_INPUT);
    commitRevisionNow(j, f.runDir as never, { ...previous, manifest: { ...previous.manifest, obligations }, source: { type: 'command', command: commandId('cmd-00000000000000c3') },
      base: planRev(previous.rev), rev: planRev(previous.rev + 1), changes: [], dispositions: [], divergences: [], publication: null }, { type: 'arc' });
    const applied = next();
    assert.equal(applied.cells.truths, 1);
    assert.equal(truthOf(applied.status, 'I-1'), undefined, 'a waived obligation is no truth');
    assert.ok(applied.status.waived.some((w) => w.obligation === obligationId('I-1')));
  } finally { j.close(); }
});
