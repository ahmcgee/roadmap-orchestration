// The dispatch record and seats (src/pipeline/dispatch.ts): pinned once per unit with the routingRev in
// force and the implementer seat's hash, re-pinned (never lowered, never widened) when plan-check raises the
// risk, re-pinned when a routing change leaves the implementer's session key (backend, model) alone or no build has
// started (an effort-only change resumes the session with the new effort, R4/OR-L3), and a park (never a crash) when
// the change moves the backend or model of an implementer whose session already exists. M4a named tests:
// dispatch.seat-triples, dispatch.effort-only-repins-resumes, dispatch.model-change-parks, dispatch.packreview-role-no-park,
// dispatch.dev6-decoder; dispatch.dev9-adopted (efficient judgment, 1.0.0-dev.10); dispatch.dev16-started-keeps-seat,
// dispatch.dev16-unstarted-moves (experience-won routing, 1.0.0-dev.17).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DispatchRecord, dispatchRecord, effectiveScope, inScope } from '../src/core/records.ts';
import { repoPattern, repoPath } from '../src/core/values.ts';
import { seatRev, sha256, specRev } from '../src/core/ids.ts';
import {
  SEAT_TRIPLES, type StageContext, implementerDispatch, implementerSeatRev, judgmentDispatch, pinDispatch, firstPin, seatTripleOf,
} from '../src/pipeline/dispatch.ts';
import { build, planCheck } from '../src/pipeline/stages.ts';
import { step } from '../src/pipeline/unit.ts';
import { largeDiffSeat } from '../src/pipeline/transitions.ts';
import { type RoutingStack, arcStack, parseRepoConfig, resolveRouting, resolveRoutingUnder } from '../src/routing/layers.ts';
import { PRE_DEV10_BUILTIN_SEATS, PRE_DEV12_BUILTIN_SEATS, PRE_DEV17_BUILTIN_SEATS } from '../src/core/upgrade.ts';
import {
  CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS, JUDGMENT_SEATS, type JudgmentSeat, MODEL_IDS, RISK_TIERS, type RoutingLayer, type Triple, routingLayer,
} from '../src/routing/types.ts';
import { BUILD_REPORT, HIGH_BUILDS_ON_FRONTIER, SCENARIO_TIMEOUT_MS, type StageRun, U1, facts, planCheckStep, seated, setupUnit, started } from './fixtures/stage-common.ts';

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
  // 1.0.0-dev.12: a gate over the large-diff threshold sits at least at high; only a gate takes a large diff.
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'gate')).tier, 'low');
  assert.equal(seated(judgmentDispatch(run.ctx, U1, 'gate', { overflow: 1 })).tier, 'high');
  assert.throws(() => judgmentDispatch(run.ctx, U1, 'plan-check', { overflow: 1 }), /a large diff given to a plan-check seat/);
  assert.deepEqual(JUDGMENT_SEATS.map((t: JudgmentSeat) => largeDiffSeat(t, { overflow: 3 })), ['high', 'high', 'high', 'escalation']);
  assert.deepEqual(JUDGMENT_SEATS.map((t: JudgmentSeat) => largeDiffSeat(t, null)), ['low', 'med', 'high', 'escalation']);
});

test('dispatch.risk-raise: a plan-check that raises the risk records a new dispatch fact; every later seat follows it', T, async () => {
  // A plan seats build.high on frontier, so the raise moves the implementer (every built-in build seat is efficient since dev.17).
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve', risk: 'high' })], risk: 'low', routing: HIGH_BUILDS_ON_FRONTIER });
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
  assert.equal(seated(implementerDispatch(run.ctx, U1)).triple.backend, 'claude', 'the plan\'s frontier class builds high');
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
  assert.deepEqual(seated(judgmentDispatch(changed, U1, 'gate')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'the gate follows the new binding');
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
  // dev.6's built-in seats built high on frontier (a plan layer stands for them: HEAD's built-ins build every tier efficient).
  const dev6 = under(run, { ...rebound(DEV6, { build: { high: 'frontier' } }), arcScope: 'architecture-doc' });
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
  const head = under(run, { ...rebound({}, { build: { high: 'frontier' } }), arcScope: 'architecture-doc' });
  const packMoved = resolveRouting({ ...rebound({}, { build: { high: 'frontier' }, packReview: { arc: 'summit' } }), arcScope: 'architecture-doc' });
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

// ---------------------------------------------------------------------------------------------------
// Efficient judgment (owner ruling 2026-10-15, 1.0.0-dev.10): the built-in seats moved the low-risk judgments, the lenses
// and flow to the efficient class; the builds did not move.

test('dispatch.dev9-adopted: a unit dispatched and built under the built-in seats before 1.0.0-dev.10 re-pins under HEAD\'s, its med build resumes, and its judgments sit on Opus medium', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [MALFORMED] },
      { as: 'codex', expect: { argv: ['exec', 'resume'], argvLacks: ['-C'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] },
    ],
  });
  for (const profile of ['default', 'claude-only'] as const) {
    const before = resolveRoutingUnder(PRE_DEV10_BUILTIN_SEATS, arcStack(profile, null, null));
    assert.notEqual(before.rev, resolveRouting(arcStack(profile, null, null)).rev, `${profile}: the seat table moved the rev`);
    const now = resolveRouting(arcStack(profile, null, null)).table.build;
    assert.deepEqual([before.table.build.low, before.table.build.med], [now.low, now.med], `${profile}: no low or med build seat moved (dev.17 moved build.high)`);
  }
  const dev9Routing = resolveRoutingUnder(PRE_DEV10_BUILTIN_SEATS, arcStack('default', null, null));
  const dev9: StageContext = { ...run.ctx, routing: () => dev9Routing };
  assert.deepEqual(dev9Routing.table.planCheck.med, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'dev.9 plan-checked med on frontier');
  started(await planCheck(dev9, run.unit));
  assert.equal(started(await build(dev9, run.unit, { kind: 'fresh' })).outcome.kind, 'malformed');
  const head = under(run, arcStack('default', null, null));
  const s = await step(head, run.unit);
  assert.equal(s.kind, 'continue', `the resumed build ran: ${JSON.stringify(s)}`);
  const [first, repinned, ...more] = dispatches(run);
  assert.deepEqual(more, [], 'one re-pin');
  assert.equal(first?.routingRev, dev9Routing.rev);
  assert.equal(repinned?.routingRev, head.routing(null).rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev, 'the implementer seat is unchanged');
  assert.notEqual(run.journal.view.unit(U1).decided?.outcome, 'routing-changed');
  assert.deepEqual(seated(judgmentDispatch(head, U1, 'plan-check')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'frontier plan-checks every tier (dev.17)');
  assert.deepEqual(seated(judgmentDispatch(head, U1, 'gate')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'frontier gates every tier (dev.17)');
});

// The gate risk ladder (owner direction 2026-10-17, 1.0.0-dev.12): gate.med moved to efficient; gate.low stays efficient
// (it moved to economy, then reverted after the paid gate role eval).

test('dispatch.dev11-adopted: a unit dispatched and built under the seats 1.0.0-dev.10 and dev.11 hashed re-pins under HEAD\'s without a park, its build resumes, and its med plan-check moves from Sonnet high to Opus medium', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [MALFORMED] },
      { as: 'codex', expect: { argv: ['exec', 'resume'], argvLacks: ['-C'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] },
    ],
  });
  const dev11Routing = resolveRoutingUnder(PRE_DEV12_BUILTIN_SEATS, arcStack('default', null, null));
  assert.deepEqual(dev11Routing.table.gate.med, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'dev.11 gated med on frontier');
  const dev11: StageContext = { ...run.ctx, routing: () => dev11Routing };
  started(await planCheck(dev11, run.unit));
  assert.equal(started(await build(dev11, run.unit, { kind: 'fresh' })).outcome.kind, 'malformed');
  const head = under(run, arcStack('default', null, null));
  const s = await step(head, run.unit);
  assert.equal(s.kind, 'continue', `the resumed build ran: ${JSON.stringify(s)}`);
  const [first, repinned, ...more] = dispatches(run);
  assert.deepEqual(more, [], 'one re-pin');
  assert.equal(first?.routingRev, dev11Routing.rev);
  assert.equal(repinned?.routingRev, head.routing(null).rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev, 'the implementer seat is unchanged');
  assert.notEqual(run.journal.view.unit(U1).decided?.outcome, 'routing-changed');
  assert.deepEqual(seated(judgmentDispatch(head, U1, 'plan-check')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'plan-check.med moves to frontier (dev.17)');
  assert.deepEqual(seated(judgmentDispatch(head, U1, 'gate')).triple, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'gate.med stays on Opus medium');
});

// Experience-won routing (owner 2026-10-22, 1.0.0-dev.17): build.high moved from frontier to efficient (with an Opus advisor).
// A release upgrade is not an owner edit: a dev.16 high unit whose build started keeps its Opus seat through to its merge;
// one not yet started builds under the new seats (scaffolding, src/core/upgrade.ts `implementerSeatKept`).

const OPUS_MEDIUM: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const SONNET_MEDIUM: Triple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
/** The claude-only routing a dev.12 to dev.16 executor resolved: the same stack under the seats it hashed. */
const dev16Ctx = (run: StageRun): StageContext => {
  const routing = resolveRoutingUnder(PRE_DEV17_BUILTIN_SEATS, arcStack('claude-only', null, null));
  return { ...run.ctx, routing: () => routing };
};

test('dispatch.dev16-started-keeps-seat: a dev.16 high unit whose build started on Opus resumes on Opus under HEAD\'s routing, no routing-changed park; an owner edit still parks', T, async () => {
  const resumed = { as: 'claude', expect: { argv: ['--model', 'claude-opus-5-5', '--advisor', '--resume'], argvLacks: ['--session-id'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] } as const;
  const run = setupUnit({
    profile: 'claude-only', risk: 'high',
    steps: [planCheckStep({ decision: 'approve', risk: 'high' }), { as: 'claude', expect: { argv: ['--model', 'claude-opus-5-5', '--session-id'] }, acts: [MALFORMED] }, resumed],
  });
  const dev16 = dev16Ctx(run);
  assert.deepEqual(dev16.routing(null).table.build.high, OPUS_MEDIUM, 'dev.16 built high on frontier');
  started(await planCheck(dev16, run.unit));
  assert.equal(started(await build(dev16, run.unit, { kind: 'fresh' })).outcome.kind, 'malformed');
  const head = under(run, arcStack('claude-only', null, null));
  assert.deepEqual(head.routing(null).table.build.high, SONNET_MEDIUM, 'HEAD builds high on efficient');
  assert.equal(head.routing(null).preDev17Rev, dev16.routing(null).rev, 'the dev.16 rev is the same stack under dev.16\'s seats');
  const s = await step(head, run.unit);
  assert.equal(s.kind, 'continue', `the resumed build ran on Opus: ${JSON.stringify(s)}`);
  const [first, repinned, ...more] = dispatches(run);
  assert.deepEqual(more, [], 'one re-pin');
  assert.equal(repinned?.routingRev, head.routing(null).rev);
  assert.equal(repinned?.implementerSeatRev, first?.implementerSeatRev, 'the pinned Opus seat is kept');
  assert.deepEqual(seated(implementerDispatch(head, U1)).triple, OPUS_MEDIUM, 'it builds on Opus through to its merge');
  assert.notEqual(run.journal.view.unit(U1).decided?.outcome, 'routing-changed');

  // An owner edit that moves a started implementer's seat is no release upgrade: it parks as before.
  const edited = setupUnit({
    profile: 'claude-only', risk: 'high', routing: HIGH_BUILDS_ON_FRONTIER,
    steps: [planCheckStep({ decision: 'approve', risk: 'high' }), { as: 'claude', expect: { argv: ['--model', 'claude-opus-5-5', '--session-id'] }, acts: [MALFORMED] }],
  });
  started(await planCheck(edited.ctx, edited.unit));
  assert.equal(started(await build(edited.ctx, edited.unit, { kind: 'fresh' })).outcome.kind, 'malformed');
  const parked = await step(under(edited, arcStack('claude-only', null, null)), edited.unit);
  assert.ok(parked.kind === 'parked');
  assert.equal(parked.needsUser.reason, 'routing-changed');
});

test('dispatch.dev16-unstarted-moves: a dev.16 high unit dispatched but not yet built re-pins onto HEAD\'s seat and builds on Sonnet with the Opus advisor', T, async () => {
  const run = setupUnit({
    profile: 'claude-only', risk: 'high',
    steps: [{ as: 'claude', expect: { argv: ['--model', 'claude-sonnet-5-5', '--effort', 'medium', '--advisor', 'claude-opus-5-5', '--session-id'] }, acts: [{ type: 'emit', value: BUILD_REPORT }] }],
  });
  const dev16 = dev16Ctx(run);
  const first = seated(pinDispatch(dev16, run.unit, spec1(run)));
  assert.deepEqual(seatTripleOf(first.implementerSeatRev), OPUS_MEDIUM, 'pinned on dev.16\'s Opus seat');
  const head = under(run, arcStack('claude-only', null, null));
  assert.deepEqual(seated(implementerDispatch(head, U1)).triple, SONNET_MEDIUM);
  const repinned = dispatches(run).at(-1)!;
  assert.equal(repinned.routingRev, head.routing(null).rev);
  assert.deepEqual(seatTripleOf(repinned.implementerSeatRev), SONNET_MEDIUM, 'the new seat is pinned');
  assert.equal(started(await build(head, run.unit, { kind: 'fresh' })).outcome.kind, 'success');
});

// Derived exclusion (2026-10-27; 1.0.0-dev.26): the pin, the read-time default and growth all bound the same write set.
test('dispatch.derived-exclusion: outputs without a source are excluded; source growth and inclusion across entries win', () => {
  const run = setupUnit({ steps: [] });
  const entry = { sources: [repoPattern('lib/**')], outputs: [repoPattern('test/generated.json')] };
  const plan = { ...run.ctx.plan(), derived: [entry] };
  const ctx = { ...run.ctx, plan: () => plan };
  const first = seated(pinDispatch(ctx, run.unit, spec1(run)));
  assert.deepEqual(first.excluded, ['test/generated.json']);
  assert.equal(inScope(effectiveScope(first), repoPath('test/generated.json')), false);
  assert.equal(inScope(effectiveScope(first), repoPath('test/sibling.json')), true);
  const { excluded: _excluded, ...old } = first;
  const read = dispatchRecord(JSON.parse(JSON.stringify(old)), 'old dispatch');
  assert.deepEqual(effectiveScope(read).exclude, []);
  assert.equal(inScope(effectiveScope(read), repoPath('test/generated.json')), true);

  const source = { ...entry, sources: [repoPattern('src/**')] };
  const shared = { ...plan, derived: [entry, source] };
  const included = seated(pinDispatch({ ...ctx, plan: () => shared }, run.unit, spec1(run)));
  assert.equal(included.excluded, undefined, 'an included output is removed from exclusions, including one already inside scope');
  const grown = { ...run.unit, scope: [...run.unit.scope, repoPattern('lib/**')] };
  const grownPin = firstPin({ ...ctx, plan: () => ({ ...plan, units: [grown] }) }, grown, spec1(run), grown.risk);
  assert.equal(grownPin.excluded, undefined);
  assert.equal(inScope(effectiveScope(grownPin), repoPath('test/generated.json')), true);
});
