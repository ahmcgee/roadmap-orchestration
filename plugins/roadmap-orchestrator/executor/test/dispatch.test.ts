// The dispatch record and seats (src/pipeline/dispatch.ts): pinned once per unit with the routingRev in
// force and the implementer seat's hash, re-pinned (never lowered, never widened) when plan-check raises the
// risk, re-pinned when a routing change leaves the implementer's seat alone or no build has started, and a
// park (never a crash) when the change moves the seat of an implementer whose session already exists.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatchRecord } from '../src/core/records.ts';
import { sha256, specRev } from '../src/core/ids.ts';
import { type StageContext, implementerDispatch, judgmentDispatch, pinDispatch } from '../src/pipeline/dispatch.ts';
import { build, planCheck } from '../src/pipeline/stages.ts';
import { step } from '../src/pipeline/unit.ts';
import { arcStack, resolveRouting } from '../src/routing/layers.ts';
import { MODEL_IDS, type RoutingLayer, routingLayer } from '../src/routing/types.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, type StageRun, U1, facts, planCheckStep, seated, setupUnit } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const SPEC_1 = { rev: specRev(1), sha256: sha256('1'.repeat(64)) };

/** The run's context under the default profile with `plan` as the plan's routing layer. */
const rerouted = (run: StageRun, plan: unknown): StageContext => {
  const routing = resolveRouting(arcStack('default', null, routingLayer(plan, 'plan') as RoutingLayer));
  return { ...run.ctx, routing: () => routing };
};
const dispatches = (run: StageRun): readonly DispatchRecord[] => facts(run).flatMap((f) => (f.kind === 'dispatch' ? [f.record] : []));

test('dispatch.pinned-once: the first dispatch pins scope, risk floor, routingRev and the implementer seat', () => {
  const run = setupUnit({ steps: [], risk: 'low' });
  const first = seated(pinDispatch(run.ctx, run.unit, SPEC_1));
  assert.deepEqual(first.scope, ['src/**', 'test/**']);
  assert.equal(first.riskFloor, 'low');
  assert.equal(first.routingRev, run.ctx.routing().rev);
  assert.match(first.implementerSeatRev, /^[0-9a-f]{16}$/);
  assert.deepEqual(seated(pinDispatch(run.ctx, run.unit, { rev: specRev(2), sha256: sha256('2'.repeat(64)) })), first, 'a later call returns the pinned record');
  assert.equal(dispatches(run).length, 1);
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'plan-check')).tier, 'low');
  assert.equal(seated(implementerDispatch(run.ctx, U1)).triple.backend, 'codex', 'default profile: the efficient class builds low');
});

test('dispatch.risk-raise: a plan-check that raises the risk records a new dispatch fact; every later seat follows it', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve', risk: 'high' })], risk: 'low' });
  const done = await planCheck(run.ctx, run.unit);
  assert.equal(done.outcome.kind, 'approve');
  assert.ok(done.next.kind === 'stage' && done.next.stage === 'build' && done.next.seat === 'high', 'the build sits on the raised seat');
  const [low, high] = dispatches(run);
  assert.deepEqual([low?.riskFloor, high?.riskFloor], ['low', 'high']);
  assert.deepEqual(high!.scope, low!.scope, 'the scope envelope is kept');
  assert.equal(high!.routingRev, low!.routingRev);
  assert.notEqual(high!.implementerSeatRev, low!.implementerSeatRev, 'the raised floor pins the high implementer seat');
  assert.equal(run.journal.view.unit(U1).risk, 'high');
  assert.equal(seated(implementerDispatch(run.ctx, U1)).tier, 'high');
  assert.equal(seated(implementerDispatch(run.ctx, U1)).triple.backend, 'claude', 'default profile: the frontier class builds high');
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'gate')).tier, 'high');
});

test('dispatch.repin-before-build: a routing change before any build re-pins the unit, whatever it moves', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' })] });
  seated(pinDispatch(run.ctx, run.unit, SPEC_1));
  const changed = rerouted(run, { build: { med: 'frontier' }, planCheck: { med: 'summit' } });
  const done = await planCheck(changed, run.unit);
  assert.equal(done.outcome.kind, 'approve');
  const [first, repinned] = dispatches(run);
  assert.equal(repinned?.routingRev, changed.routing().rev);
  assert.notEqual(repinned?.implementerSeatRev, first?.implementerSeatRev);
  assert.deepEqual([repinned?.scope, repinned?.riskFloor], [first?.scope, first?.riskFloor], 'scope and floor are unchanged');
  assert.equal(seated(implementerDispatch(changed, U1)).triple.backend, 'claude', 'the build will sit on the new binding');
});

/** A unit whose fresh build ran (malformed, so the next step is the build's resume round). */
async function builtOnce(extra: readonly Parameters<typeof setupUnit>[0]['steps'][number][]): Promise<StageRun> {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'exitZeroNoop' }] }, ...extra] });
  await planCheck(run.ctx, run.unit);
  const malformed = await build(run.ctx, run.unit, { kind: 'fresh' });
  assert.equal(malformed.outcome.kind, 'malformed');
  return run;
}

test('dispatch.repin-judgment-only: after a build, a change that leaves the implementer seat alone re-pins and the unit continues', T, async () => {
  const run = await builtOnce([{ as: 'codex', expect: {}, acts: [{ type: 'emit', value: BUILD_REPORT }] }]);
  const changed = rerouted(run, { gate: { med: 'summit' }, planCheck: { escalation: 'frontier' } });
  assert.notEqual(changed.routing().rev, run.ctx.routing().rev);
  const s = await step(changed, run.unit);
  assert.equal(s.kind, 'continue', 'the resumed build ran');
  const [first, repinned] = dispatches(run);
  assert.equal(repinned?.routingRev, changed.routing().rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev);
  assert.equal(seated(judgmentDispatch(changed, U1, 'gate')).triple.model, 'claude-fable-5-1', 'the gate follows the new binding');
});

test('dispatch.routing-changed-parks: after a build, a change that moves the implementer seat parks the unit with a needs-user, never a crash', T, async () => {
  const run = await builtOnce([]);
  const changed = rerouted(run, { build: { med: 'frontier' } });
  const s = await step(changed, run.unit);
  assert.equal(s.kind, 'parked');
  assert.ok(s.kind === 'parked');
  assert.equal(s.needsUser.reason, 'routing-changed');
  assert.deepEqual(s.needsUser.subject, { type: 'unit', unit: U1 });
  assert.match(s.needsUser.summary, /build\.med/);
  assert.match(s.needsUser.recommendation, /^Restore the routing of build\.med or re-enter the unit under a new id\./);
  for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(s.needsUser), new RegExp(m.replace('.', '\\.')));
  assert.equal(dispatches(run).length, 1, 'nothing is re-pinned');
  const u = run.journal.view.unit(U1);
  assert.equal(u.status, 'park-pending');
  assert.equal(u.decided?.outcome, 'routing-changed');
  assert.equal(u.decided?.chargeable, false);
  // Restoring the routing makes the same seat dispatchable again.
  assert.equal(seated(implementerDispatch(run.ctx, U1)).tier, 'med');
});
