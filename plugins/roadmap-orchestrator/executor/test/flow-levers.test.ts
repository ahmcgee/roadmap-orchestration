// M4b step A2: levers, the fence, code's checks after the schema and the ruler (plan "Levers, proposals and the fence",
// RC-4, RC-8, RC-9). Pure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { givenId, laneId, proposalId, resourceName, sha256, stationId, unitId } from '../src/core/ids.ts';
import { type PlanM1, parsePlan } from '../src/input/plan.ts';
import {
  type ProposalContext, LEVER_STEP, argvShapeProblem, assertFenced, checkProposal, diffPaths, flowRevision, metricOf, preimageOf, rejectionKeyOf,
  rejectionKeyText, rulerChanges,
} from '../src/flow/levers.ts';
import { type FlowAction, type FlowDropReason, type FlowProposal, FLOW_LEVERS } from '../src/flow/types.ts';
import { isoTime } from '../src/core/values.ts';

const tool = { argv: ['make', 'probe'], cwd: '.', env: { set: {}, pass: [] } };
const SEED = ['node', '--test', '--test-concurrency=1', 'test/unit/*.test.js'];
const lane = (id: string, argv: readonly string[]) => ({ id, argv, cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] });

function rawPlan(): Record<string, unknown> {
  return {
    schema: 'roadmap/plan-m1', arc: 'arc-2', integrationBranch: 'integration/arc-2', baseline: 'a'.repeat(40), worktreeRoot: '/var/tmp/roadmap-wt',
    contracts: [], rulings: 'rulings.jsonl', architectureDoc: 'docs/architecture.md', direction: 'Converge.',
    suite: { lanes: [lane('unit', SEED), lane('lint', ['npm', 'run', 'lint'])] },
    resources: [{ name: 'db', probe: tool, teardown: tool, pool: { size: 2 } }, { name: 'cache', probe: tool, teardown: tool }],
    units: [
      { id: 'u1', spec: 'specs/u1.json', risk: 'low', scope: ['src/a/**'], resources: [] },
      { id: 'u2', spec: 'specs/u2.json', risk: 'high', scope: ['src/b/**'], resources: [], routing: { gate: { high: 'summit' } } },
      { id: 'u3', spec: 'specs/u3.json', risk: 'med', scope: ['src/c/**'], resources: [], cut: { reason: 'out of scope' } },
    ],
  };
}
const PLAN = parsePlan(rawPlan());
const planWith = (extra: Record<string, unknown>): PlanM1 => parsePlan({ ...rawPlan(), ...extra });

const UNIT = laneId('unit');
const SLOT = stationId('slot:integration');
const SUITE_UNIT = stationId('suite:unit');
const proposal = (action: FlowAction, target = SUITE_UNIT): FlowProposal => ({ id: proposalId('flow-1.0'), target, action, rationale: 'r', risks: 'k' });
type SuiteLaneAction = Extract<FlowAction, { lever: 'suite-lane' }>;
const shard = (argv: readonly string[] = ['node', '--test', '--test-concurrency=6', 'test/unit/*.test.js']): SuiteLaneAction =>
  ({ lever: 'suite-lane', lane: UNIT, argv, reporter: 'node-test', cpu: 6 });

const CONTEXT: ProposalContext = {
  plan: PLAN,
  host: { platform: 'linux', arch: 'x64', cpus: 8, memGiB: 16 },
  constraint: { station: SLOT, internal: true, component: SUITE_UNIT },
  judged: { station: SLOT, agree: true, reason: 'the suite dominates the slot' },
  levers: [
    { lever: 'build-class', tier: 'low', class: 'efficient', builtin: 'efficient' },
    { lever: 'build-class', tier: 'med', class: 'frontier', builtin: 'efficient' },
    { lever: 'build-class', tier: 'high', class: 'frontier', builtin: 'frontier' },
  ],
  givens: [], window: null, verdicts: [], rejections: [], repairWaiting: false, flowHigh: [],
};
const reason = (p: FlowProposal, context: Partial<ProposalContext> = {}): FlowDropReason | null => checkProposal(p, { ...CONTEXT, ...context })?.reason ?? null;
/** A context in which an elevate lever on the slot is not early. */
const AFTER_EXPLOIT: Partial<ProposalContext> = { verdicts: [{ proposal: proposalId('flow-2.0'), lever: 'suite-lane', target: SLOT, verdict: 'no-effect' }] };

describe('the fence', () => {
  it('each lever\'s revision differs from the plan exactly at its own paths, and the preimage tells absent from set', () => {
    const cases: readonly [FlowAction, readonly string[]][] = [
      [{ lever: 'concurrency', cpu: 6 }, ['capacity.cpu']],
      [{ lever: 'resource-pool', resource: resourceName('db'), size: 3 }, ['resources[db].size']],
      [shard(), ['suite.lanes[unit].argv', 'suite.lanes[unit].cpu']],
      [{ lever: 'sequence', unit: unitId('u1'), priority: 'high' }, ['units[u1].priority']],
      [{ lever: 'build-class', tier: 'med', class: 'frontier' }, ['routing.build.med']],
    ];
    for (const [action, paths] of cases) assert.deepEqual(diffPaths(PLAN, flowRevision(PLAN, action)), paths, action.lever);
    assert.deepEqual(preimageOf(PLAN, { lever: 'concurrency', cpu: 6 }), { lever: 'concurrency', cpu: null }, 'no capacity.cpu: the host default');
    assert.deepEqual(preimageOf(planWith({ capacity: { cpu: 4 } }), { lever: 'concurrency', cpu: 6 }), { lever: 'concurrency', cpu: 4 });
    assert.deepEqual(preimageOf(PLAN, shard()), { lever: 'suite-lane', lane: UNIT, argv: SEED, cpu: null });
    assert.deepEqual(preimageOf(PLAN, { lever: 'sequence', unit: unitId('u1'), priority: 'high' }), { lever: 'sequence', unit: unitId('u1'), priority: null });
    assert.deepEqual(preimageOf(PLAN, { lever: 'build-class', tier: 'med', class: 'frontier' }), { lever: 'build-class', tier: 'med', class: null });
    assert.deepEqual(preimageOf(PLAN, { lever: 'resource-pool', resource: resourceName('db'), size: 3 }), { lever: 'resource-pool', resource: resourceName('db'), size: 2 });
    assert.throws(() => flowRevision(PLAN, { lever: 'host', note: 'more cores' }), /advice/);
  });

  it('a forged revision touching anything outside the action\'s instantiated paths throws', () => {
    const next = flowRevision(PLAN, { lever: 'concurrency', cpu: 6 });
    const forged: PlanM1 = { ...next, suite: { lanes: PLAN.suite.lanes.map((l) => (l.id === 'lint' ? { ...l, argv: ['true'] } : l)) } };
    assert.throws(() => assertFenced(PLAN, forged, { lever: 'concurrency', cpu: 6 }), /touched suite\.lanes\[lint\]\.argv/);
    // The template's other instance: a suite-lane action on `unit` may not touch lane `lint`.
    assert.throws(() => assertFenced(PLAN, forged, shard()), /touched capacity\.cpu, suite\.lanes\[lint\]\.argv/);
    // A ruler path under a build-class action.
    const judged: PlanM1 = { ...PLAN, routing: { build: { med: 'frontier' }, gate: { low: 'efficient' } } };
    assert.throws(() => assertFenced(PLAN, judged, { lever: 'build-class', tier: 'med', class: 'frontier' }), /routing\.gate\.low/);
    assert.doesNotThrow(() => assertFenced(PLAN, flowRevision(PLAN, shard()), shard()));
  });

  it('a resource gaining a pool, or a reorder of a keyed list, diffs outside every lever', () => {
    const pooled: PlanM1 = { ...PLAN, resources: PLAN.resources.map((r) => (r.name === 'cache' ? { ...r, pool: { size: 1 } } : r)) };
    assert.deepEqual(diffPaths(PLAN, pooled), ['resources[cache].pool.size']);
    assert.deepEqual(diffPaths(PLAN, { ...PLAN, units: [...PLAN.units].reverse() }), ['units']);
    assert.throws(() => flowRevision(PLAN, { lever: 'resource-pool', resource: resourceName('cache'), size: 2 }), /no pooled resource cache/);
  });
});

describe('metric, step and the rejection key', () => {
  it('code derives the verdict metric and the ToC step from the lever (G7)', () => {
    const metrics = {
      concurrency: metricOf({ lever: 'concurrency', cpu: 2 }, SLOT),
      'resource-pool': metricOf({ lever: 'resource-pool', resource: resourceName('db'), size: 3 }, stationId('stage:build')),
      'suite-lane': metricOf(shard(), SUITE_UNIT),
      sequence: metricOf({ lever: 'sequence', unit: unitId('u1'), priority: 'high' }, SLOT),
      'build-class': metricOf({ lever: 'build-class', tier: 'low', class: 'frontier' }, stationId('stage:build')),
      host: metricOf({ lever: 'host', note: 'n' }, SLOT),
    };
    assert.deepEqual(metrics, {
      concurrency: { type: 'wait', station: 'wait:slot:integration' }, 'resource-pool': { type: 'wait', station: 'wait:build' },
      'suite-lane': { type: 'suite-run', lane: 'unit' }, sequence: { type: 'lead' }, 'build-class': { type: 'lead' }, host: null,
    });
    assert.deepEqual(FLOW_LEVERS.map((l) => LEVER_STEP[l]), ['elevate', 'elevate', 'exploit', 'subordinate', 'exploit', 'elevate']);
  });

  it('RC-9: the key is (station, lever, target), never the value', () => {
    const vectors: readonly [FlowProposal, string][] = [
      [proposal(shard()), 'suite:unit|suite-lane|lane:unit'],
      [proposal(shard(['node', '--test', '--test-concurrency=3', 'test/unit/*.test.js'])), 'suite:unit|suite-lane|lane:unit'],
      [proposal({ lever: 'suite-lane', lane: UNIT, cpu: 4 }, SLOT), 'slot:integration|suite-lane|lane:unit'],
      [proposal({ lever: 'concurrency', cpu: 6 }, SLOT), 'slot:integration|concurrency|capacity'],
      [proposal({ lever: 'resource-pool', resource: resourceName('db'), size: 3 }, SLOT), 'slot:integration|resource-pool|resource:db'],
      [proposal({ lever: 'sequence', unit: unitId('u1'), priority: 'high' }, SLOT), 'slot:integration|sequence|unit:u1'],
      [proposal({ lever: 'build-class', tier: 'high', class: 'summit' }, stationId('stage:build')), 'stage:build|build-class|tier:high'],
      [proposal({ lever: 'host', note: 'buy cores' }, SLOT), 'slot:integration|host|host'],
    ];
    for (const [p, text] of vectors) assert.equal(rejectionKeyText(rejectionKeyOf(p)), text);
    assert.deepEqual(rejectionKeyOf(proposal(shard())), { station: SUITE_UNIT, lever: 'suite-lane', target: { type: 'lane', lane: UNIT } });
  });
});

describe('RC-4 argv shape', () => {
  it('only the --test-concurrency value changes in place', () => {
    assert.equal(argvShapeProblem(SEED, ['node', '--test', '--test-concurrency=6', 'test/unit/*.test.js']), null, 'the plant: =1 → =6');
    assert.match(argvShapeProblem(SEED, ['node', '--test', '--test-concurrency=1', 'test/unit/a.test.js']) ?? '', /not an in-place/, 'a selector change');
    assert.match(argvShapeProblem(SEED, [...SEED, '--test-concurrency=6']) ?? '', /length/, 'a flag appended after the selector');
    assert.match(argvShapeProblem(SEED, ['node', '--test', '--test-concurrency=6', '--test-shard=1/2', 'test/unit/*.test.js']) ?? '', /length/, 'an extra flag');
    assert.match(argvShapeProblem(SEED, ['node', '--test-only', '--test-concurrency=6', 'test/unit/*.test.js']) ?? '', /elements 1, 2 changed/, 'another flag swapped too');
    assert.match(argvShapeProblem(SEED, ['node', '--test', '--test-concurrency=0', 'test/unit/*.test.js']) ?? '', /not an in-place/, 'not a positive count');
    assert.match(argvShapeProblem(SEED, SEED) ?? '', /unchanged/);
    assert.match(argvShapeProblem(['npm', 'test'], ['npm', 'test', '--', '--test-concurrency=6']) ?? '', /length/, 'npm test -- … is ignored by node: refused');
  });
});

describe('checkProposal: each drop reason', () => {
  it('passes the plant proposal', () => assert.equal(checkProposal(proposal(shard()), CONTEXT), null));

  it('target', () => {
    assert.equal(reason(proposal(shard(), stationId('stage:build'))), 'target', 'not the constraint');
    assert.equal(reason(proposal(shard(), SLOT)), null, 'the constraint itself');
    assert.equal(reason(proposal(shard(), stationId('stage:build')), { judged: { station: stationId('stage:build'), agree: false, reason: 'r' } }), 'target', 'a suite-lane action off its lane station');
    assert.equal(reason(proposal({ lever: 'build-class', tier: 'low', class: 'frontier' }, stationId('stage:build')), { judged: { station: stationId('stage:build'), agree: false, reason: 'r' } }), null, 'the disputed station');
    assert.equal(reason(proposal({ lever: 'host', note: 'n' }, stationId('held')), { judged: { station: stationId('held'), agree: false, reason: 'r' } }), 'target', 'held');
    assert.equal(reason(proposal({ lever: 'suite-lane', lane: laneId('nope'), cpu: 4 }, SLOT)), 'target', 'no such lane');
    assert.equal(reason(proposal({ lever: 'resource-pool', resource: resourceName('cache'), size: 2 }, SLOT), AFTER_EXPLOIT), 'target', 'an unpooled resource');
    assert.equal(reason(proposal({ lever: 'sequence', unit: unitId('u3'), priority: 'high' }, SLOT)), 'target', 'a cut unit');
    assert.equal(reason(proposal({ lever: 'resource-pool', resource: resourceName('db'), size: 2 }, SLOT), AFTER_EXPLOIT), 'target', 'a change to nothing');
    assert.equal(reason(proposal(shard()), { constraint: null, judged: { station: SLOT, agree: true, reason: 'r' } }), 'target', 'no constraint and none disputed');
  });

  it('given', () => {
    assert.equal(reason(proposal(shard()), { givens: [{ scope: 'repo', lever: 'suite-lane', note: 'CI owns it' }] }), 'given');
    assert.equal(reason(proposal(shard()), { givens: [{ scope: 'host', id: givenId('G-1'), lever: 'suite-lane', note: 'n', state: 'enforced' }] }), 'given');
    assert.equal(reason(proposal(shard()), { givens: [{ scope: 'host', id: givenId('G-1'), lever: 'suite-lane', note: 'n', state: 'stale' }] }), null, 'a stale host given is not enforced');
    assert.equal(reason(proposal(shard()), { givens: [{ scope: 'repo', lever: 'concurrency', note: 'n' }] }), null, 'another lever');
  });

  it('rejected-before (RC-9)', () => {
    const remembered = { key: rejectionKeyOf(proposal(shard(['node', '--test', '--test-concurrency=3', 'test/unit/*.test.js']))), proposal: proposalId('flow-2.0'), cause: 'worse' as const };
    assert.equal(reason(proposal(shard()), { rejections: [remembered] }), 'rejected-before', 'another value, the same key');
    assert.equal(reason(proposal(shard(), SLOT), { rejections: [remembered] }), null, 'another station');
  });

  it('verdict-open', () => {
    const window = { proposal: proposalId('flow-2.0'), lever: 'suite-lane' as const, target: SLOT, metric: { type: 'lead' as const }, openedAt: isoTime('2026-10-08T12:00:00.000Z'), samples: 1 };
    assert.equal(reason(proposal(shard()), { window }), 'verdict-open');
    assert.equal(reason(proposal({ lever: 'host', note: 'more cores' }, SLOT), { window }), null, 'host advice meanwhile');
  });

  it('elevate-early', () => {
    const pool = proposal({ lever: 'resource-pool', resource: resourceName('db'), size: 3 }, SLOT);
    assert.equal(reason(pool), 'elevate-early');
    assert.equal(reason(pool, { verdicts: [{ proposal: proposalId('flow-2.0'), lever: 'concurrency', target: SLOT, verdict: 'improved' }] }), 'elevate-early', 'an elevate verdict does not count');
    assert.equal(reason(pool, { verdicts: [{ proposal: proposalId('flow-2.0'), lever: 'suite-lane', target: SUITE_UNIT, verdict: 'improved' }] }), 'elevate-early', 'another target');
    assert.equal(reason(pool, AFTER_EXPLOIT), null);
    assert.equal(reason(proposal({ lever: 'host', note: 'n' }, SLOT)), null, 'host is excepted');
  });

  it('argv-shape and lane-cpu', () => {
    const { reporter: _r, ...noReporter } = shard();
    assert.equal(reason(proposal(noReporter)), 'argv-shape', 'no reporter');
    assert.equal(reason(proposal(shard(['node', '--test', '--test-concurrency=6', 'test/unit/a.test.js']))), 'argv-shape', 'a selector change');
    assert.equal(reason(proposal(shard([...SEED, '--test-concurrency=6']))), 'argv-shape', 'appended after the selector');
    const { cpu: _c, ...noCpu } = shard();
    assert.equal(reason(proposal(noCpu)), 'lane-cpu', 'six workers on the fast default of 2');
    assert.equal(reason(proposal({ ...shard(), cpu: 5 })), 'lane-cpu');
    assert.equal(reason(proposal({ lever: 'suite-lane', lane: UNIT, cpu: 4 })), null, 'cpu alone over the seed\'s concurrency 1');
  });

  it('concurrency-cpus', () => {
    assert.equal(reason(proposal({ lever: 'concurrency', cpu: 9 }, SLOT), AFTER_EXPLOIT), 'concurrency-cpus');
    assert.equal(reason(proposal({ lever: 'concurrency', cpu: 8 }, SLOT), AFTER_EXPLOIT), null);
  });

  it('sequence-repair-waiting and sequence-high-set', () => {
    const seq = proposal({ lever: 'sequence', unit: unitId('u1'), priority: 'high' }, SLOT);
    assert.equal(reason(seq), null);
    assert.equal(reason(seq, { repairWaiting: true }), 'sequence-repair-waiting');
    assert.equal(reason(seq, { flowHigh: [unitId('u2')] }), 'sequence-high-set');
  });

  it('build-class-step: one class step, never below the built-in (RC-8)', () => {
    const judged = { judged: { station: stationId('stage:build'), agree: false, reason: 'r' } };
    const build = (tier: 'low' | 'med' | 'high', cls: 'efficient' | 'frontier' | 'summit') => proposal({ lever: 'build-class', tier, class: cls }, stationId('stage:build'));
    assert.equal(reason(build('low', 'summit'), judged), 'build-class-step', 'two steps');
    assert.equal(reason(build('low', 'frontier'), judged), null);
    assert.equal(reason(build('high', 'efficient'), judged), 'build-class-step', 'below the built-in frontier');
    assert.equal(reason(build('med', 'efficient'), { ...judged, levers: CONTEXT.levers }), null, 'back down to the built-in');
  });
});

describe('the ruler', () => {
  const view = (plan: PlanM1, obligations = sha256('1'.repeat(64)), vision = sha256('2'.repeat(64))) => ({ plan, obligationsSha256: obligations, visionSha256: vision });
  it('names the ruler paths a revision touched, and nothing for a lever change', () => {
    assert.deepEqual(rulerChanges(view(PLAN), view(flowRevision(PLAN, shard()))), []);
    assert.deepEqual(rulerChanges(view(PLAN), view(flowRevision(PLAN, { lever: 'build-class', tier: 'high', class: 'summit' }))), [], 'build routing is not judgment');
    assert.deepEqual(rulerChanges(view(PLAN), view(PLAN, sha256('3'.repeat(64)))), ['holistic.obligations']);
    assert.deepEqual(rulerChanges(view(PLAN), view(PLAN, undefined, sha256('4'.repeat(64)))), ['vision']);
    const edited = planWith({
      routing: { gate: { low: 'efficient' } },
      units: (rawPlan()['units'] as Record<string, unknown>[]).map((u) => (u['id'] === 'u1' ? { ...u, risk: 'med' } : u['id'] === 'u2' ? { ...u, routing: { gate: { high: 'frontier' } } } : u))
        .concat([{ id: 'u4', spec: 'specs/u4.json', risk: 'low', scope: ['src/d/**'], resources: [], routing: { planCheck: { low: 'efficient' } } }]),
    });
    assert.deepEqual(rulerChanges(view(PLAN), view(edited)), ['routing.gate', 'units[u1].risk', 'units[u2].routing.gate'], 'a new unit sets a floor, it moves none');
  });
});
