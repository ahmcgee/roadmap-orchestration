// Per-unit routing, bounds and the risk floor (M3 step A3): a plan unit's `routing` layer on the arc's stack
// (src/routing/layers.ts `provenanceStack`), the routing provenance a revision records (H7), the unit's pinned
// `bounds` (src/input/plan.ts `boundsOf`) and the windows and table rounds they set, and the Phase-0 risk floor of
// `apply` (src/input/classify.ts `riskFloorReason`). Integrated: real processes, real git, fake backends; applies go
// through the command path under a context that follows the log as the executor's does (fixtures/route-common.ts).
// Named tests: routing.unit-layer-rev, routing.provenance-recorded, limits.windows-and-bounds, route.risk-floor.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Event, IntentOf } from '../src/core/events.ts';
import { unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { readRepoConfig } from '../src/preflight/checks.ts';
import { type RoutingBase, requirePlanInForce, unitRouting } from '../src/input/inforce.ts';
import { boundsOf } from '../src/input/plan.ts';
import { step } from '../src/pipeline/unit.ts';
import { provenanceStack, resolveRouting } from '../src/routing/layers.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, U1, codexStep, contextFor, gateStep, isGateCall, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { type Json, apply, editPlan, editSpec, editUnit, followContext, modelOf, planDirOf, recordFirst, stepTo, unitOf } from './fixtures/route-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const U2 = unitId('u2');
/** A Claude call's seat binding, model and effort: frontier and summit are both Opus 5.5 (OR-Q17), told by effort. */
const seatOf = (argv: readonly string[]): string => `${modelOf(argv)}/${argv[argv.indexOf('--effort') + 1]}`;
const SUMMIT = 'claude-opus-5-5/xhigh';
const FRONTIER = 'claude-opus-5-5/medium';

/** A fresh Claude implementer session (the frontier build seat) that commits mul. */
const claudeBuild = (): Step => ({
  as: 'claude',
  expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'], argvLacks: ['--resume'] },
  acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: BUILD_REPORT }],
});

const appliedOk = (o: { kind: string }): void => assert.equal(o.kind, 'applied', JSON.stringify(o));
const rejection = (o: { kind: string; reason?: string }): string => (o.kind === 'rejected' ? o.reason! : assert.fail(`expected a rejection, got ${JSON.stringify(o)}`));

test('routing.unit-layer-rev: a unit routing layer gives that unit its own routingRev (re-pinned at its next dispatch, its gate on summit); a later layer moving its implementer seat after its build parks it routing-changed, while a unit not yet built is re-pinned', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      planCheckStep({ decision: 'approve' }), // u1
      planCheckStep({ decision: 'approve' }), // u2
      mulBuild(), // u1, on efficient (Codex)
      gateStep({ decision: 'revise', directives: ['Export mul as the default export too.'] }), // u1, on its layer's summit
      claudeBuild(), // u2, on its layer's frontier build seat
    ],
  });
  recordFirst(d);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    const arcRev = ctx.routing(null).rev;
    await stepTo(ctx, 'u1', (f) => f.stage === 'plan-check');
    assert.equal(r.journal.view.dispatchOf(U1)?.routingRev, arcRev);

    editUnit(d, 'u1', (u) => void (u['routing'] = { gate: { med: 'summit' } }));
    appliedOk(await apply(r, ctx));
    const u1Rev = ctx.routing(U1).rev;
    assert.notEqual(u1Rev, arcRev, 'the unit layer gives u1 its own rev');
    assert.equal(ctx.routing(U2).rev, arcRev, 'u2 has no layer: the arc\'s rev');
    assert.deepEqual(r.journal.view.planApplied()?.changes, [{ type: 'routing', routingRev: u1Rev, unit: U1 }]);

    await stepTo(ctx, 'u2', (f) => f.stage === 'plan-check');
    await stepTo(ctx, 'u1', (f) => f.stage === 'gate');
    assert.deepEqual(outcomes(d, 'u1').at(-1), 'gate:revise');
    const u1Records = r.journal.view.dispatchesOf(U1);
    assert.deepEqual(u1Records.map((x) => x.routingRev), [arcRev, u1Rev], 'u1 re-pinned under its unit rev at its next dispatch');
    assert.equal(u1Records[1]?.implementerSeatRev, u1Records[0]?.implementerSeatRev, 'a judgment-only layer leaves the implementer seat');
    assert.deepEqual(r.journal.view.dispatchesOf(U2).map((x) => x.routingRev), [arcRev], 'u2 keeps the arc\'s rev');
    const gates = readCalls(d.scenarioPath).filter(isGateCall);
    assert.equal(gates.length, 1);
    assert.equal(seatOf(gates[0]!.argv), SUMMIT, 'u1\'s gate ran on its layer\'s summit class');

    // A layer that moves u1's implementer seat after its build started, and u2's before its build.
    editUnit(d, 'u1', (u) => void (u['routing'] = { gate: { med: 'summit' }, build: { med: 'frontier' } }));
    editUnit(d, 'u2', (u) => void (u['routing'] = { build: { med: 'frontier' } }));
    appliedOk(await apply(r, ctx));
    const [u1Moved, u2Moved] = [ctx.routing(U1).rev, ctx.routing(U2).rev];
    assert.deepEqual(r.journal.view.planApplied()?.changes, [{ type: 'routing', routingRev: u1Moved, unit: U1 }, { type: 'routing', routingRev: u2Moved, unit: U2 }]);

    const parked = await step(ctx, unitOf(ctx, 'u1'));
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'routing-changed', JSON.stringify(parked));
    assert.equal(outcomes(d, 'u1').at(-1), 'build:routing-changed');
    assert.equal(r.journal.view.dispatchesOf(U1).length, 2, 'a park re-pins nothing');

    await stepTo(ctx, 'u2', (f) => f.stage === 'build');
    assert.equal(outcomes(d, 'u2').at(-1), 'build:success');
    const u2Records = r.journal.view.dispatchesOf(U2);
    assert.deepEqual(u2Records.map((x) => x.routingRev), [arcRev, u2Moved], 'u2 re-pinned under its new unit rev, not parked');
    assert.notEqual(u2Records[1]?.implementerSeatRev, u2Records[0]?.implementerSeatRev);
    const calls = readCalls(d.scenarioPath);
    assert.equal(calls.length, 5);
    assert.ok(calls.every((c) => c.step !== null), 'every call matched its step');
    assert.deepEqual([calls[4]!.as, seatOf(calls[4]!.argv)], ['claude', FRONTIER], 'u2 built on its layer\'s frontier seat');
  } finally {
    r.journal.close();
  }
});

test('routing.provenance-recorded: plan-applied records the profile, the repo config\'s seats and classes, the plan layer and the unit layers; they reproduce the unit\'s dispatch rev, and a later edit of the live config changes nothing in force', T, async () => {
  const d = setupArc({ units: [{ id: 'u1' }, { id: 'u2' }], steps: [planCheckStep({ decision: 'approve' })] });
  const configPath = join(d.repo, '.roadmap', 'config.json');
  const sonnet = (effort: string): Json => ({ backend: 'claude', model: 'claude-sonnet-5-5', effort });
  mkdirSync(join(d.repo, '.roadmap'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ routing: { seats: { gate: { high: 'summit' } }, classes: { efficient: sonnet('medium') } } }));
  editPlan(d, (p) => void (p['routing'] = { planCheck: { low: 'summit' } }));
  editUnit(d, 'u1', (u) => void (u['routing'] = { gate: { med: 'summit' } }));
  // As a start does (src/preflight/checks.ts `settlePlan`): the routing base is the profile and the repo config read now.
  const base: RoutingBase = { profile: 'default', config: readRepoConfig(absPath(d.repo)) };
  recordFirst(d, base);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    const provenance = r.journal.view.planApplied()?.routingProvenance;
    assert.deepEqual(provenance, {
      profile: 'default',
      repoConfig: { seats: { gate: { high: 'summit' } }, classes: { efficient: sonnet('medium') } },
      planLayer: { planCheck: { low: 'summit' } },
      unitLayers: { u1: { gate: { med: 'summit' } } },
    });
    await stepTo(ctx, 'u1', (f) => f.stage === 'plan-check');
    const record = r.journal.view.dispatchOf(U1)!;
    const reproduced = resolveRouting(provenanceStack(provenance!, 'none', U1));
    assert.equal(record.routingRev, reproduced.rev, 'the provenance reproduces the unit\'s dispatch rev');
    const plan = requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
    assert.equal(reproduced.rev, unitRouting(base, plan, unitOf(ctx, 'u1')).rev, 'the same routing the start resolved');
    assert.deepEqual(
      [reproduced.bindings.efficient, reproduced.sources.gate.med, reproduced.sources.gate.high, reproduced.sources.planCheck.low],
      ['repo-config', 'unit', 'repo-config', 'plan'],
    );
    assert.equal(reproduced.table.build.med.model, 'claude-sonnet-5-5', 'the repo config rebinds the efficient class');
    assert.notEqual(resolveRouting(provenanceStack(provenance!, 'none', U2)).rev, record.routingRev, 'u2 has no unit layer');

    // The architect edits the live config: a revision's routing never re-reads it (H7).
    writeFileSync(configPath, JSON.stringify({ routing: { classes: { efficient: sonnet('high') } } }));
    const live = unitRouting({ profile: 'default', config: readRepoConfig(absPath(d.repo)) }, plan, unitOf(ctx, 'u1'));
    assert.notEqual(live.rev, record.routingRev, 'the live file would resolve another rev');
    assert.equal(ctx.routing(U1).rev, record.routingRev, 'the routing in force still resolves from the recorded provenance');
    assert.deepEqual(r.journal.view.planApplied()?.routingProvenance, provenance);
  } finally {
    r.journal.close();
  }
});

type SpawnEvent = Event & IntentOf<'proc.spawn'>;
/** The unit's backend spawns of `role`, in log order (every ordinal). */
function spawnsOf(r: ReturnType<typeof contextFor>, role: string): readonly SpawnEvent[] {
  return readJournal(r.ctx.runDir, r.journal.view.arc).events.filter((e): e is SpawnEvent =>
    e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'backend' && e.expect.subject.role === role);
}
/** A spawn's window: its deadline less the time its intent was written, in ms. */
const windowOf = (e: SpawnEvent): number => Date.parse(e.deadlineAt!) - Date.parse(e.at);
const MIN = 60_000;
/** Within the few seconds between computing a deadline and writing its intent. */
const about = (ms: number, want: number, what: string): void => assert.ok(ms <= want && ms > want - 5_000, `${what}: window ${ms} ms, want ≈ ${want} ms`);

test('limits.windows-and-bounds: the plan\'s and the unit\'s limits are pinned as the dispatch bounds and set the backend windows and the table\'s rounds; a limits apply re-pins them, and one below what the unit spent is refused', T, async () => {
  const brokenMul = { ...MUL, 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' };
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'add mul', files: brokenMul }], { argv: ['exec', '-C'] }),
      codexStep([{ type: 'commit', message: 'fix mul', files: MUL }], { argv: ['exec', 'resume'] }),
      gateStep({ decision: 'revise', directives: ['Export mul as the default export too.'] }),
      codexStep([{ type: 'commit', message: 'default export', files: { 'src/mul.js': `${MUL['src/mul.js']}export default mul;\n` } }], { argv: ['exec', 'resume'] }),
      gateStep({ decision: 'revise', directives: ['Document mul.'] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  editPlan(d, (p) => void (p['limits'] = { reviseRounds: 1, freshBuildMin: 2, judgmentDeadlineMin: 3 }));
  editUnit(d, 'u1', (u) => void (u['limits'] = { editAllowanceMin: 5 }));
  recordFirst(d);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    await stepTo(ctx, 'u1', (f) => f.stage === 'plan-check');
    const first = r.journal.view.dispatchOf(U1)!;
    assert.deepEqual(first.bounds, boundsOf(ctx.plan(), unitOf(ctx, 'u1')));
    assert.deepEqual(first.bounds, {
      chargeable: 3, redirects: 2, reviseRounds: 1, candidateReds: 1, retries: 1, judgmentDeadlineMin: 3, freshBuildMin: 2, editAllowanceMin: 5,
    }, 'the built-in bounds, the plan\'s limits, then the unit\'s own');
    assert.equal(first.transientRules, 'm3');

    // lanes red (a charged fix round), gate revise (the one revise round), gate revise again: beyond 1 round, route up.
    await stepTo(ctx, 'u1', (f) => f.stage === 'gate' && r.journal.view.unit(U1).counters.reviseRounds === 1 && f.class === 'route-up');
    assert.deepEqual(outcomes(d), [
      'plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:red',
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:revise',
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:revise',
    ]);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.counters.reviseRounds, u.counters.chargeableFailures, u.routedUp], [1, 2, ['gate']], 'the second revise routed up, uncharged');

    about(windowOf(spawnsOf(r, 'planCheck')[0]!), 3 * MIN, 'plan-check');
    const builds = spawnsOf(r, 'build');
    assert.equal(builds.length, 3);
    about(windowOf(builds[0]!), 2 * MIN, 'the fresh build');
    for (const fix of builds.slice(1)) {
      const w = windowOf(fix);
      assert.ok(w > 5 * MIN - 5_000 && w < 6 * MIN, `a fix round: the edit allowance plus the measured lane series, got ${w} ms`);
    }
    for (const g of spawnsOf(r, 'gate')) about(windowOf(g), 3 * MIN, 'a gate');

    // A limits apply below what u1 spent is refused; one above it re-pins u1's next dispatch.
    editUnit(d, 'u1', (x) => void (x['limits'] = { editAllowanceMin: 5, chargeable: 1 }));
    assert.match(rejection(await apply(r, ctx)), /unit u1: its chargeable bound 1 is below what it has spent \(2\)/);
    editUnit(d, 'u1', (x) => void (x['limits'] = { editAllowanceMin: 5, judgmentDeadlineMin: 4 }));
    appliedOk(await apply(r, ctx));
    assert.deepEqual(r.journal.view.planApplied()?.changes, [{ type: 'limits', unit: U1 }]);
    assert.equal(r.journal.view.dispatchesOf(U1).length, 1, 'an apply re-pins nothing by itself');

    await stepTo(ctx, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const records = r.journal.view.dispatchesOf(U1);
    assert.equal(records.length, 2);
    assert.deepEqual(records[1]!.bounds, { ...first.bounds, judgmentDeadlineMin: 4 }, 're-pinned with the new bounds at the next dispatch');
    assert.deepEqual([records[1]!.routingRev, records[1]!.riskFloor, records[1]!.transientRules], [first.routingRev, first.riskFloor, 'm3']);
    const gates = spawnsOf(r, 'gate');
    about(windowOf(gates.at(-1)!), 4 * MIN, 'the gate after the re-pin');
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls.every((c) => c.step !== null));
    assert.equal(seatOf(calls.filter(isGateCall).at(-1)!.argv), SUMMIT, 'the routed-up gate sits on the escalation seat');
  } finally {
    r.journal.close();
  }
});

/** Ruling `id` in force from the start: its ledger line and its sidecar `<ledger>.d/<id>.json` (A2: the ledger is executor-owned after start). */
function addRuling(d: ReturnType<typeof setupArc>, id: string, statement: string, over: Json): void {
  const ledger = join(planDirOf(d), 'rulings.md');
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}${id} — ${statement}\n`);
  mkdirSync(`${ledger}.d`, { recursive: true });
  const hex = 'a'.repeat(64);
  writeFileSync(join(`${ledger}.d`, `${id}.json`), JSON.stringify({
    schema: 'roadmap/ruling-m3', id, statement, kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'phase 0', supersedes: [], condition: null,
    docRefs: [{ path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module', relation: 'consistent' }], contractRefs: [], contractOps: [],
    obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
    consistency: { verdict: 'consistent', judgedRevs: { head: 'b'.repeat(40), ledgerSha256: hex, obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
    ...over,
  }));
}

test('route.risk-floor: a risk below its Phase-0 floor is refused unless the unit\'s spec cites an active ruling for it; a dispatched unit\'s risk may rise, re-pinned at its next stage (parked routing-changed once its build started on a seat the raise moves)', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', risk: 'high' }, { id: 'u4', risk: 'high' }],
    steps: [planCheckStep({ decision: 'approve' }), mulBuild(), planCheckStep({ decision: 'approve' }), claudeBuild()],
  });
  addRuling(d, 'C-2', 'u4 is low risk after all.', { appliesTo: { type: 'units', units: ['u4'] } });
  const cites = { contracts: ['contracts/api.md'], rulings: ['C-1', 'C-2'] };
  // Both cite C-2; it applies to u4 alone.
  editSpec(d, 'u3', (s) => void (s['cites'] = cites));
  editSpec(d, 'u4', (s) => void (s['cites'] = cites));
  recordFirst(d);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    await stepTo(ctx, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    await stepTo(ctx, 'u2', (f) => f.stage === 'plan-check');

    editUnit(d, 'u3', (u) => void (u['risk'] = 'med'));
    assert.match(
      rejection(await apply(r, ctx)),
      /unit u3: risk med is below its Phase-0 floor high; lowering it needs its spec to cite an active ruling for u3/,
    );
    editUnit(d, 'u3', (u) => void (u['risk'] = 'high'));
    editUnit(d, 'u4', (u) => void (u['risk'] = 'low'));
    appliedOk(await apply(r, ctx));
    assert.deepEqual(r.journal.view.planApplied()?.changes, [{ type: 'unit-changed', unit: unitId('u4') }]);

    // Raise the dispatched units: u1 built on build.med, u2 not yet built.
    editUnit(d, 'u1', (u) => void (u['risk'] = 'high'));
    editUnit(d, 'u2', (u) => void (u['risk'] = 'high'));
    appliedOk(await apply(r, ctx));
    assert.deepEqual(r.journal.view.planApplied()?.changes, [{ type: 'unit-changed', unit: U1 }, { type: 'unit-changed', unit: U2 }]);
    assert.deepEqual([r.journal.view.dispatchesOf(U1).length, r.journal.view.dispatchesOf(U2).length], [1, 1], 'an apply re-pins nothing by itself');

    const parked = await step(ctx, unitOf(ctx, 'u1'));
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'routing-changed', JSON.stringify(parked));
    assert.equal(outcomes(d, 'u1').at(-1), 'gate:routing-changed');
    assert.deepEqual(r.journal.view.dispatchesOf(U1).map((x) => x.riskFloor), ['med'], 'the park re-pins nothing');

    await stepTo(ctx, 'u2', (f) => f.stage === 'build');
    assert.equal(outcomes(d, 'u2').at(-1), 'build:success');
    const u2 = r.journal.view.dispatchesOf(U2);
    assert.deepEqual(u2.map((x) => x.riskFloor), ['med', 'high'], 'u2 re-pinned at the higher floor at its next stage');
    assert.equal(u2[1]!.routingRev, u2[0]!.routingRev);
    assert.notEqual(u2[1]!.implementerSeatRev, u2[0]!.implementerSeatRev);
    assert.equal(r.journal.view.unit(U2).buildTier, 'high');
    const calls = readCalls(d.scenarioPath);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.step !== null));
    assert.deepEqual([calls[3]!.as, seatOf(calls[3]!.argv)], ['claude', FRONTIER], 'u2 built on build.high');
  } finally {
    r.journal.close();
  }
});
