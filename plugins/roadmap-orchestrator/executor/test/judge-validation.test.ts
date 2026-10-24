// 2026-10-15 (arc feedback #3): the executor never crash-loops, or parks a unit, on its own judges' output it could have
// refused up front. Over corpus-unit's arc (checks-common.ts: the one arc lane `journey`, I-1 witnessed on it):
//   classify.witness-lane            an apply giving a witness item a lane that is no arc lane is a rejected receipt
//   classify.witness-lane-all-specs  an obligations edit dropping an arc lane a spec witness still names is refused, though
//                                    it touches no spec
//   classify.witness-reuse           a witness item naming an obligation restates its witness exactly (every proposer)
//   stage.witness-lane-park          a dev.9 arc whose spec in force holds such an item parks the unit at build, naming it,
//                                    with no build call (it crash-looped the supervisor before)
//   schemas.checkpoint-ruling-text   a checkpoint answer recorded before structured rulings reads its JSON text as written
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { step } from '../src/pipeline/unit.ts';
import { CHECKPOINT_SCHEMA, validateCheckpointOutput } from '../src/prompts/schemas.ts';
import { schemaViolation } from '../src/backends/adapter.ts';
import { readCalls } from './helpers/scenario.ts';
import { checksArc } from './fixtures/checks-common.ts';
import { editJson, editSpec } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, commandContextFor, contextFor, outcomes } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

const witness = (lane: string, testId: string, obligation?: string): Json =>
  ({ id: 'W-1', lane, testId, clause: 'A1', skeleton: `test('${testId}')`, state: 'active', ...(obligation === undefined ? {} : { obligation }) });

/** Applies the arc's files as they are now: the receipt's reason when refused, null when applied. */
async function applied(r: ArcRun): Promise<string | null> {
  const out = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(r.d)));
  if (out.kind === 'applied') return null;
  assert.equal(out.kind, 'rejected', JSON.stringify(out));
  return (out as { reason: string }).reason;
}

describe('witness items against the arc lanes (classifier, arc feedback #3)', () => {
  test('classify.witness-lane: an apply giving a witness item a lane that is no arc lane is refused, naming it', T, async () => {
    const a = await checksArc({ steps: [] });
    const r = contextFor(a.d);
    try {
      editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('unit-lane', 't9')]; });
      assert.match((await applied(r)) ?? 'applied', /unit u1's witness item W-1 names lane unit-lane, which is not an arc lane in force \(the arc lanes are journey\): name an arc lane, or strike the item/);
      editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('journey', 't9')]; });
      assert.equal(await applied(r), null, 'on the arc lane it applies');
    } finally {
      r.journal.close();
    }
  });

  test('classify.witness-lane-all-specs: an obligations edit dropping an arc lane a spec witness names is refused, though no spec changes', T, async () => {
    const a = await checksArc({ steps: [] });
    const obligations = join(a.planDir, 'obligations.json');
    editJson(obligations, (o) => { o['lanes'] = [...(o['lanes'] as Json[]), { ...(o['lanes'] as Json[])[0]!, id: 'extra' }]; });
    editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('extra', 't9')]; });
    const r = contextFor(a.d);
    try {
      editJson(obligations, (o) => { o['lanes'] = (o['lanes'] as Json[]).filter((l) => l['id'] !== 'extra'); });
      assert.match((await applied(r)) ?? 'applied', /unit u1's witness item W-1 names lane extra, which is not an arc lane in force \(the arc lanes are journey\)/);
    } finally {
      r.journal.close();
    }
  });

  test('classify.witness-reuse: an apply\'s witness item naming a delivered obligation takes its witness exactly; naming one the unit does not deliver is refused', T, async () => {
    const a = await checksArc({ steps: [], activation: 'future', deliveredBy: ['u1'], testIds: ['t1'] });
    const r = contextFor(a.d);
    try {
      editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('journey', 't9', 'I-1')]; });
      assert.match((await applied(r)) ?? 'applied', /unit u1's witness item W-1 names I-1's witness, so it takes that witness's exact lane and test id \(lane journey, test "t1"\), not lane journey, test "t9"/);
      editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('journey', 't1', 'I-9')]; });
      assert.match((await applied(r)) ?? 'applied', /unit u1's witness item W-1 names obligation I-9, which is not an obligation this unit delivers with a witness: set it to null or to one of I-1/);
      editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('journey', 't1', 'I-1')]; });
      assert.equal(await applied(r), null);
    } finally {
      r.journal.close();
    }
  });
});

describe('a spec in force from an arc started on 1.0.0-dev.9', () => {
  test('stage.witness-lane-park: a witness item on no arc lane parks the unit at build, naming the item, with no build call', T, async () => {
    const a = await checksArc({ steps: [planCheckStep({ decision: 'approve' })] });
    // As a dev.9 revision could leave it: the classifier refuses this since.
    editSpec(a.d, 'u1', (s) => { s['witnesses'] = [witness('unit-lane', 't9')]; });
    const r = contextFor(a.d);
    try {
      assert.equal((await step(r.ctx, r.unit('u1'))).kind, 'continue');
      const parked = await step(r.ctx, r.unit('u1'));
      assert.ok(parked.kind === 'parked', JSON.stringify(parked));
      assert.equal(parked.needsUser.reason, 'witness-lane-missing');
      assert.equal(parked.needsUser.blocking, true);
      assert.match(parked.needsUser.summary, /^Unit u1: unit u1's witness item W-1 names lane unit-lane, which is not an arc lane in force/);
      assert.match(parked.needsUser.recommendation, /roadmap resume u1/);
      assert.deepEqual(outcomes(a.d), ['plan-check:approve', 'build:witness-lane-missing']);
      assert.equal(readCalls(a.d.scenarioPath).length, 1, 'the plan-check only: no build call');
      assert.equal(r.journal.view.unit(r.unit('u1').id).counters.chargeableFailures, 0, 'uncharged');
    } finally {
      r.journal.close();
    }
  });
});

describe('checkpoint rulings (arc feedback #3)', () => {
  test('schemas.checkpoint-ruling-text: the schema offers a ruling as an object; a recorded answer\'s ruling as JSON text reads as written', () => {
    const ruling = {
      schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'Helpers reject non-finite input.', kind: 'decision', trigger: 'checkpoint', supersedes: [], condition: null,
      docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }], contractRefs: [], contractOps: [],
      obligations: [], obligationDispositions: [], cites: ['V-1'], evidence: ['e'], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
    };
    const answer = (rulings: readonly unknown[]) => ({
      decision: 'bundle', reasons: ['r'], ops: [{ op: 'rule', ruling: 'C-2', cites: ['V-1'], evidence: ['e'] }], rulings, findingDispositions: [], interpretations: [],
      cites: { vision: ['V-1'], observations: [], findings: [] }, premises: [], corpusAmendments: [],
    });
    assert.equal(schemaViolation(CHECKPOINT_SCHEMA, answer([ruling])), null);
    const { trigger: _t, ...missing } = ruling;
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer([missing])) ?? '', /\$\.rulings\[0\]/, 'a missing field is a schema violation');
    assert.match(schemaViolation(CHECKPOINT_SCHEMA, answer([JSON.stringify(ruling)])) ?? '', /\$\.rulings\[0\]/, 'text is no longer the wire form');
    const text = JSON.stringify(ruling, null, 1);
    assert.deepEqual(validateCheckpointOutput(answer([text])).rulings, [text], 'an earlier answer\'s text reads as written');
    assert.deepEqual(JSON.parse(validateCheckpointOutput(answer([ruling])).rulings[0]!), ruling);
  });
});
