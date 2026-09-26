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
  it('a valid plan parses unchanged, with `after` defaulting to none', () => {
    const plan = validPlan();
    assert.deepEqual(parsePlan(plan), { ...plan, units: (plan['units'] as object[]).map((u) => ({ ...u, after: [] })) });
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

  it('routing is optional and, when present, parses as a layer', () => {
    const routing = { gate: { high: { backend: 'claude', model: 'claude-fable-5-1', effort: 'default' } }, build: { low: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' } } };
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

  it('rejects a Claude triple with a Codex effort', () => {
    rejects({ ...validPlan(), routing: { build: { high: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } }, 'plan.routing.build.high.effort');
  });

  it('rejects an unknown model id', () => {
    rejects({ ...validPlan(), routing: { build: { high: { backend: 'claude', model: 'claude-sonnet-5', effort: 'default' } } } }, 'plan.routing.build.high.model');
  });

  it('names nested unit fields', () => {
    const plan = validPlan();
    const units = plan['units'] as Record<string, unknown>[];
    rejects({ ...plan, units: [{ ...units[0], risk: 'critical' }] }, 'plan.units[0].risk');
    const { scope: _s, ...noScope } = units[0] as Record<string, unknown>;
    rejects({ ...plan, units: [noScope] }, 'plan.units[0].scope');
  });

  it('rejects unknown fields and duplicate unit ids', () => {
    rejects({ ...validPlan(), extra: true }, 'plan.extra');
    const units = validPlan()['units'] as Record<string, unknown>[];
    rejects({ ...validPlan(), units: [units[0], { ...units[0], spec: 'specs/u1b.json' }] }, 'plan.units[1]');
  });
});
