import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePlan } from '../src/input/plan.ts';
import { SchemaError } from '../src/core/validate.ts';

const tool = { argv: ['make', 'probe-db'], cwd: '.', env: { set: {}, pass: [] } };

function validPlan(): Record<string, unknown> {
  return {
    schema: 'roadmap/plan-m1',
    arc: 'arc-2',
    integrationBranch: 'integration/arc-2',
    baseline: 'a'.repeat(40),
    worktreeRoot: '/var/tmp/roadmap-wt',
    contracts: ['.roadmap/contracts/api.md'],
    rulings: 'rulings.jsonl',
    architectureDoc: 'docs/architecture.md',
    direction: 'Converge on the documented target state.',
    suite: { lanes: [{ id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'estate', resources: ['db'], evidenceGlobs: [] }] },
    resources: [{ name: 'db', probe: tool, teardown: { ...tool, argv: ['make', 'down-db'] } }],
    units: [{ id: 'u1', spec: 'specs/u1.json', risk: 'med', scope: ['src/auth/**'], resources: ['db'] }],
  };
}

function rejects(plan: unknown, field: string): void {
  assert.throws(() => parsePlan(plan), (err: unknown) => {
    assert.ok(err instanceof SchemaError, String(err));
    assert.equal(err.field, field);
    return true;
  });
}

const REQUIRED = ['schema', 'arc', 'integrationBranch', 'baseline', 'worktreeRoot', 'contracts', 'rulings', 'architectureDoc', 'direction', 'suite', 'resources', 'units'] as const;

// One wrong-typed or malformed value per field.
const WRONG: { readonly [K in (typeof REQUIRED)[number] | 'routing' | 'architectureDigest']: unknown } = {
  schema: 'roadmap/plan-m2',
  arc: 'Arc 2',
  integrationBranch: 'bad..branch',
  baseline: 'abc',
  worktreeRoot: 'relative/wt',
  contracts: ['../outside.md'],
  rulings: '/abs/rulings.jsonl',
  architectureDoc: 42,
  architectureDigest: '/abs/digest.md',
  direction: '',
  suite: { lanes: 'npm test' },
  resources: [{ name: 'integration-slot', probe: tool, teardown: tool }],
  units: [],
  routing: { gate: { high: { backend: 'codex', model: 'claude-opus-5-5', effort: 'high' } } },
};

describe('plan.json (M1)', () => {
  it('a valid plan parses unchanged, with `after`, `contingent` and suite lanes\' `evidenceExcludes` defaulting to none', () => {
    const plan = validPlan();
    const suite = plan['suite'] as { lanes: object[] };
    assert.deepEqual(parsePlan(plan), {
      ...plan, suite: { lanes: suite.lanes.map((l) => ({ ...l, evidenceExcludes: [] })) }, units: (plan['units'] as object[]).map((u) => ({ ...u, after: [], contingent: [] })),
    });
  });

  it('plan.after: a unit may run after units earlier in plan order; a later, unknown, own or repeated id is refused, naming it', () => {
    const u = (id: string, after?: readonly string[]) => ({ id, spec: `specs/${id}.json`, risk: 'med', scope: ['src/**'], resources: [], ...(after === undefined ? {} : { after }) });
    const plan = (...units: object[]) => ({ ...validPlan(), units });
    assert.deepEqual(parsePlan(plan(u('a'), u('b', ['a']), u('c', ['a', 'b']))).units.map((x) => x.after), [[], ['a'], ['a', 'b']]);
    rejects(plan(u('a', ['b']), u('b')), 'plan.units[0].after[0]');
    rejects(plan(u('a'), u('b', ['nope'])), 'plan.units[1].after[0]');
    rejects(plan(u('a'), u('b', ['b'])), 'plan.units[1].after[0]');
    rejects(plan(u('a'), u('b', ['a', 'a'])), 'plan.units[1].after[1]');
  });

  it('routing is optional and, when present, parses as a layer of classes', () => {
    const routing = { gate: { high: 'summit', escalation: 'frontier' }, build: { low: 'frontier' } };
    assert.deepEqual(parsePlan({ ...validPlan(), routing }).routing, routing);
    assert.equal('routing' in parsePlan(validPlan()), false);
  });

  it('architectureDigest is optional and, when present, a repo path', () => {
    assert.equal(parsePlan({ ...validPlan(), architectureDigest: 'docs/digest.md' }).architectureDigest, 'docs/digest.md');
    assert.equal('architectureDigest' in parsePlan(validPlan()), false);
  });

  for (const field of REQUIRED) {
    it(`rejects a missing ${field}, naming it`, () => {
      const plan = validPlan();
      delete plan[field];
      rejects(plan, `plan.${field}`);
    });
  }

  for (const [field, value] of Object.entries(WRONG)) {
    it(`rejects a wrong-typed ${field}, naming it`, () => {
      const got = (() => {
        try {
          parsePlan({ ...validPlan(), [field]: value });
          return null;
        } catch (err) {
          return err;
        }
      })();
      assert.ok(got instanceof SchemaError, `accepted ${field}=${JSON.stringify(value)}`);
      assert.ok(got.field.startsWith(`plan.${field}`), got.field);
    });
  }

  it('rejects a triple at a seat: a plan names classes and cannot bind one (hard cutover)', () => {
    rejects({ ...validPlan(), routing: { build: { high: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } }, 'plan.routing.build.high');
    rejects({ ...validPlan(), routing: { classes: { frontier: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' } } } }, 'plan.routing.classes');
  });

  it('rejects an unknown class, and an escalation seat for build', () => {
    rejects({ ...validPlan(), routing: { build: { high: 'opus' } } }, 'plan.routing.build.high');
    rejects({ ...validPlan(), routing: { build: { escalation: 'summit' } } }, 'plan.routing.build.escalation');
  });

  it('names nested unit fields', () => {
    const plan = validPlan();
    const units = plan['units'] as Record<string, unknown>[];
    rejects({ ...plan, units: [{ ...units[0], risk: 'critical' }] }, 'plan.units[0].risk');
    const { scope: _s, ...noScope } = units[0] as Record<string, unknown>;
    rejects({ ...plan, units: [noScope] }, 'plan.units[0].scope');
  });

  it('reads a reserved unit id (batch-<n>, jobs, mutants): an adopted arc keeps its units; only units entering are refused', () => {
    const units = validPlan()['units'] as Record<string, unknown>[];
    for (const id of ['batch-3', 'jobs', 'mutants']) assert.equal(parsePlan({ ...validPlan(), units: [{ ...units[0], id }] }).units[0]!.id, id);
  });

  it('rejects unknown fields and duplicate unit ids', () => {
    rejects({ ...validPlan(), extra: true }, 'plan.extra');
    const units = validPlan()['units'] as Record<string, unknown>[];
    rejects({ ...validPlan(), units: [units[0], { ...units[0], spec: 'specs/u1b.json' }] }, 'plan.units[1]');
  });
});
