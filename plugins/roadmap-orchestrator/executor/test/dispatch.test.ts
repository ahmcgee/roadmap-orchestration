// The dispatch record and seats (src/pipeline/dispatch.ts): pinned once per unit with the routingRev in
// force and the implementer seat's hash, re-pinned (never lowered, never widened) when plan-check raises the
// risk, re-pinned when a routing change leaves the implementer's session key (backend, model) alone or no build has
// started (an effort-only change resumes the session with the new effort, R4/OR-L3), and a park (never a crash) when
// the change moves the backend or model of an implementer whose session already exists. M4a named tests:
// dispatch.seat-triples, dispatch.effort-only-repins-resumes, dispatch.model-change-parks, dispatch.packreview-role-no-park,
// dispatch.dev6-decoder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatchRecord } from '../src/core/records.ts';
import { seatRev, sha256, specRev } from '../src/core/ids.ts';
import {
  SEAT_TRIPLES, type StageContext, implementerDispatch, implementerSeatRev, judgmentDispatch, pinDispatch, seatTripleOf,
} from '../src/pipeline/dispatch.ts';
import { build, planCheck } from '../src/pipeline/stages.ts';
import { step } from '../src/pipeline/unit.ts';
import { type RoutingStack, arcStack, parseRepoConfig, resolveRouting } from '../src/routing/layers.ts';
import {
  CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS, MODEL_IDS, RISK_TIERS, type RoutingLayer, type Triple, routingLayer,
} from '../src/routing/types.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, type StageRun, U1, facts, planCheckStep, seated, setupUnit, started } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** The unit's spec in force at rev 1: the kept spec its first start recorded. */
const spec1 = (run: StageRun) => ({ rev: specRev(1), sha256: run.journal.view.planApplied()!.specs[U1]! });

/** The run's context under the default profile with `plan` as the plan's routing layer. */
const rerouted = (run: StageRun, plan: unknown): StageContext => {
  const routing = resolveRouting(arcStack('default', null, routingLayer(plan, 'plan') as RoutingLayer));
  return { ...run.ctx, routing: () => routing };
};
const dispatches = (run: StageRun): readonly DispatchRecord[] => facts(run).flatMap((f) => (f.kind === 'dispatch' ? [f.record] : []));

test('dispatch.pinned-once: the first dispatch pins scope, risk floor, routingRev and the implementer seat', () => {
  const run = setupUnit({ steps: [], risk: 'low' });
  const first = seated(pinDispatch(run.ctx, run.unit, spec1(run)));
  assert.deepEqual(first.scope, ['src/**', 'test/**']);
  assert.equal(first.riskFloor, 'low');
  assert.equal(first.routingRev, run.ctx.routing(null).rev);
  assert.match(first.implementerSeatRev, /^[0-9a-f]{16}$/);
  assert.deepEqual(seated(pinDispatch(run.ctx, run.unit, { rev: specRev(2), sha256: sha256('2'.repeat(64)) })), first, 'a later call returns the pinned record');
  assert.equal(dispatches(run).length, 1);
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'plan-check')).tier, 'low');
  assert.equal(seated(implementerDispatch(run.ctx, U1)).triple.backend, 'codex', 'default profile: the efficient class builds low');
});

test('dispatch.risk-raise: a plan-check that raises the risk records a new dispatch fact; every later seat follows it', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve', risk: 'high' })], risk: 'low' });
  const done = started(await planCheck(run.ctx, run.unit));
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
  seated(pinDispatch(run.ctx, run.unit, spec1(run)));
  const changed = rerouted(run, { build: { med: 'frontier' }, planCheck: { med: 'summit' } });
  const done = started(await planCheck(changed, run.unit));
  assert.equal(done.outcome.kind, 'approve');
  const [first, repinned] = dispatches(run);
  assert.equal(repinned?.routingRev, changed.routing(null).rev);
  assert.notEqual(repinned?.implementerSeatRev, first?.implementerSeatRev);
  assert.deepEqual([repinned?.scope, repinned?.riskFloor], [first?.scope, first?.riskFloor], 'scope and floor are unchanged');
  assert.equal(seated(implementerDispatch(changed, U1)).triple.backend, 'claude', 'the build will sit on the new binding');
});

type Steps = readonly Parameters<typeof setupUnit>[0]['steps'][number][];

/** A unit whose fresh build ran (malformed, so the next step is the build's resume round). */
async function builtOnce(extra: Steps): Promise<StageRun> {
  return builtWith({ type: 'exitZeroNoop' }, extra);
}

/** A unit whose fresh build ran with session-establishing output `first`, malformed. */
async function builtWith(first: Extract<Steps[number], { as: 'codex' }>['acts'][number], extra: Steps): Promise<StageRun> {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [first] }, ...extra] });
  started(await planCheck(run.ctx, run.unit));
  const malformed = started(await build(run.ctx, run.unit, { kind: 'fresh' }));
  assert.equal(malformed.outcome.kind, 'malformed');
  return run;
}

test('dispatch.repin-judgment-only: after a build, a change that leaves the implementer seat alone re-pins and the unit continues', T, async () => {
  const run = await builtOnce([{ as: 'codex', expect: {}, acts: [{ type: 'emit', value: BUILD_REPORT }] }]);
  const changed = rerouted(run, { gate: { med: 'summit' }, planCheck: { escalation: 'frontier' } });
  assert.notEqual(changed.routing(null).rev, run.ctx.routing(null).rev);
  const s = await step(changed, run.unit);
  assert.equal(s.kind, 'continue', 'the resumed build ran');
  const [first, repinned] = dispatches(run);
  assert.equal(repinned?.routingRev, changed.routing(null).rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev);
  assert.deepEqual(seated(judgmentDispatch(changed, U1, 'gate')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, 'the gate follows the new binding');
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

// ---------------------------------------------------------------------------------------------------
// M4a (OR-Q17, OR-L3, R4): the session key is {backend, model}; effort is a per-call flag.

/** The run's context under `stack`. */
const under = (run: StageRun, stack: RoutingStack): StageContext => {
  const routing = resolveRouting(stack);
  return { ...run.ctx, routing: () => routing };
};
/** The default profile with the repo config's class rebinds `classes`, and plan layer `plan`. */
const rebound = (classes: unknown, plan: unknown = {}): RoutingStack =>
  arcStack('default', parseRepoConfig({ routing: { classes } }), routingLayer(plan, 'plan') as RoutingLayer);
/** A first build's output that establishes its session and is malformed: the next step resumes it. */
const MALFORMED = { type: 'emit', value: { bogus: true } } as const;
const LUNA_HIGH: Triple ={ backend: 'codex', model: 'gpt-5.6-luna', effort: 'high' };
const SOL: Triple = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'medium' };
/** What 1.0.0-dev.6 bound frontier and summit to; a dev.6 dispatch record's seat rev hashes one of these. */
const DEV6: Readonly<{ frontier: Triple; summit: Triple }> = {
  frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
};

test('dispatch.seat-triples: every triple has its own seat rev, and a pinned seat rev reads back its triple; an unknown rev throws', () => {
  const all: Triple[] = [
    ...CLAUDE_MODELS.flatMap((model) => CLAUDE_EFFORTS.map((effort): Triple => ({ backend: 'claude', model, effort }))),
    ...CODEX_MODELS.flatMap((model) => CODEX_EFFORTS.map((effort): Triple => ({ backend: 'codex', model, effort }))),
  ];
  assert.equal(SEAT_TRIPLES.size, all.length, 'no two triples share a seat rev');
  for (const profile of ['default', 'claude-only'] as const) {
    const r = resolveRouting(arcStack(profile, null, null));
    for (const tier of RISK_TIERS) assert.deepEqual(seatTripleOf(implementerSeatRev(r, tier)), r.table.build[tier], `${profile} build.${tier}`);
  }
  assert.throws(() => seatTripleOf(seatRev('0123456789abcdef')), /hash of no triple/);
});

test('dispatch.effort-only-repins-resumes: after a build, an effort-only change of its seat re-pins and resumes the session with the new effort', T, async () => {
  const run = await builtWith(MALFORMED, [{ as: 'codex', expect: { argv: ['exec', 'resume', 'model_reasoning_effort=high'], argvLacks: ['-C'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] }]);
  const changed = under(run, rebound({ efficient: LUNA_HIGH }));
  assert.notEqual(changed.routing(null).rev, run.ctx.routing(null).rev);
  const s = await step(changed, run.unit);
  assert.equal(s.kind, 'continue', `the resumed build ran: ${JSON.stringify(s)}`);
  const all = dispatches(run);
  assert.equal(all.length, 2, 'one re-pin: a new dispatch fact');
  assert.equal(all[1]!.routingRev, changed.routing(null).rev);
  assert.deepEqual(seatTripleOf(all[0]!.implementerSeatRev), { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' });
  assert.deepEqual(seatTripleOf(all[1]!.implementerSeatRev), LUNA_HIGH);
  assert.notEqual(run.journal.view.unit(U1).decided?.outcome, 'routing-changed');
});

test('dispatch.model-change-parks: after a build, a change of its seat to another model on the same backend parks routing-changed', T, async () => {
  const run = await builtOnce([]);
  const s = await step(under(run, rebound({ efficient: SOL })), run.unit);
  assert.ok(s.kind === 'parked');
  assert.equal(s.needsUser.reason, 'routing-changed');
  assert.match(s.needsUser.summary, /build\.med now resolves to a different backend or model/);
  assert.equal(dispatches(run).length, 1, 'nothing is re-pinned');
});

test('dispatch.packreview-role-no-park: after a build, the rev change of a corpus scope (role packReview\'s seat in force) re-pins and the build resumes', T, async () => {
  const run = await builtWith(MALFORMED, [{ as: 'codex', expect: { argv: ['exec', 'resume'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] }]);
  const changed = under(run, { ...rebound({}, { packReview: { arc: 'summit' } }), arcScope: 'corpus' });
  assert.notEqual(changed.routing(null).rev, run.ctx.routing(null).rev);
  const s = await step(changed, run.unit);
  assert.equal(s.kind, 'continue');
  const [first, repinned] = dispatches(run);
  assert.equal(repinned?.routingRev, changed.routing(null).rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev);
});

/**
 * A high-risk unit built once (malformed, its session established) under the dev.6 bindings: an adopted dev.6 arc's
 * dispatch record, its seat build.high = frontier = Opus high.
 */
async function dev6Built(extra: Steps): Promise<StageRun> {
  const run = setupUnit({
    risk: 'high',
    steps: [planCheckStep({ decision: 'approve', risk: 'high' }), { as: 'claude', expect: { argv: ['--effort', 'high', '--session-id'] }, acts: [MALFORMED] }, ...extra],
  });
  const dev6 = under(run, { ...rebound(DEV6), arcScope: 'architecture-doc' });
  started(await planCheck(dev6, run.unit));
  const malformed = started(await build(dev6, run.unit, { kind: 'fresh' }));
  assert.equal(malformed.outcome.kind, 'malformed');
  return run;
}

test('dispatch.dev6-decoder: a dev.6-shaped record reads back its triple; frontier Opus high to medium resumes (packReview not in force parks nothing); a model change parks', T, async () => {
  // Effort-only: build.high was frontier (Opus high); HEAD binds Opus medium, in an architecture-doc scope (the packReview
  // seat resolves but is not in force, LR-0a-1).
  const run = await dev6Built([{ as: 'claude', expect: { argv: ['--effort', 'medium', '--resume'], argvLacks: ['--session-id'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] }]);
  assert.deepEqual(seatTripleOf(dispatches(run)[0]!.implementerSeatRev), DEV6.frontier);
  const head = under(run, { ...arcStack('default', null, null), arcScope: 'architecture-doc' });
  const packMoved = resolveRouting({ ...rebound({}, { packReview: { arc: 'summit' } }), arcScope: 'architecture-doc' });
  assert.equal(packMoved.rev, head.routing(null).rev, 'the packReview seat is not hashed in an architecture-doc scope');
  const s = await step(head, run.unit);
  assert.equal(s.kind, 'continue', 'the session resumed with --effort medium');
  assert.deepEqual(seatTripleOf(dispatches(run).at(-1)!.implementerSeatRev), { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' });

  // A model change of the same dev.6 record parks. (No dev.6 build seat sat on summit: Fable 5.1 has no build prompt.)
  const moved = await dev6Built([]);
  const parked = await step(under(moved, { ...rebound({}, { build: { high: 'efficient' } }), arcScope: 'architecture-doc' }), moved.unit);
  assert.ok(parked.kind === 'parked');
  assert.equal(parked.needsUser.reason, 'routing-changed');
});
