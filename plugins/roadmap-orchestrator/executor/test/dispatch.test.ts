// The dispatch record and seats (src/pipeline/dispatch.ts): pinned once per unit with the routingRev in
// force, re-pinned (never lowered, never widened) when plan-check raises the risk, and a routing change
// mid-unit refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256, specRev } from '../src/core/ids.ts';
import { RoutingChangedError, implementerDispatch, judgmentDispatch, pinDispatch } from '../src/pipeline/dispatch.ts';
import { planCheck } from '../src/pipeline/stages.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import { SCENARIO_TIMEOUT_MS, U1, facts, planCheckStep, setupUnit } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const SPEC_1 = { rev: specRev(1), sha256: sha256('1'.repeat(64)) };

test('dispatch.pinned-once: the first dispatch pins scope, risk floor and routingRev; a routing change mid-unit is refused', () => {
  const run = setupUnit({ steps: [], risk: 'low' });
  const first = pinDispatch(run.ctx, run.unit, SPEC_1);
  assert.deepEqual(first.scope, ['src/**', 'test/**']);
  assert.equal(first.riskFloor, 'low');
  assert.equal(first.routingRev, run.ctx.routing.rev);
  assert.deepEqual(pinDispatch(run.ctx, run.unit, { rev: specRev(2), sha256: sha256('2'.repeat(64)) }), first, 'a later call returns the pinned record');
  assert.equal(facts(run).filter((f) => f.kind === 'dispatch').length, 1);
  assert.equal(judgmentDispatch(run.ctx, U1, 'plan-check').tier, 'low');
  assert.equal(implementerDispatch(run.ctx, U1).triple.backend, 'codex', 'default profile: Luna builds low');

  const changed = { ...run.ctx, routing: resolveRouting({ profile: 'claude-only', repoConfig: null, plan: null, unit: null }) };
  assert.notEqual(changed.routing.rev, run.ctx.routing.rev);
  assert.throws(() => pinDispatch(changed, run.unit, SPEC_1), RoutingChangedError);
  assert.throws(() => judgmentDispatch(changed, U1, 'gate'), RoutingChangedError);
  assert.throws(() => implementerDispatch(changed, U1), RoutingChangedError);
});

test('dispatch.risk-raise: a plan-check that raises the risk records a new dispatch fact; every later seat follows it', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve', risk: 'high' })], risk: 'low' });
  const done = await planCheck(run.ctx, run.unit);
  assert.equal(done.outcome.kind, 'approve');
  assert.ok(done.next.kind === 'stage' && done.next.stage === 'build' && done.next.seat === 'high', 'the build sits on the raised seat');
  const dispatches = facts(run).flatMap((f) => (f.kind === 'dispatch' ? [f.record] : []));
  assert.deepEqual(dispatches.map((d) => d.riskFloor), ['low', 'high']);
  assert.deepEqual(dispatches[1]!.scope, dispatches[0]!.scope, 'the scope envelope is kept');
  assert.equal(dispatches[1]!.routingRev, dispatches[0]!.routingRev);
  assert.equal(run.journal.view.unit(U1).risk, 'high');
  assert.equal(implementerDispatch(run.ctx, U1).tier, 'high');
  assert.equal(implementerDispatch(run.ctx, U1).triple.backend, 'claude', 'default profile: Opus builds high');
  assert.equal(judgmentDispatch(run.ctx, U1, 'gate').tier, 'high');
});
