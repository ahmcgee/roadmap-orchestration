import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { SchemaError } from '../src/core/validate.ts';
import { support } from '../src/prompts/index.ts';
import { parseRepoConfig, resolveRouting, routingRevOf, selectProfile, unsupportedSeats } from '../src/routing/layers.ts';
import { MODELS } from '../src/routing/models.ts';
import { PROFILE_TABLES, resolve } from '../src/routing/profiles.ts';
import {
  MODEL_IDS, PROFILES, RISK_TIERS, ROLES, type RoutingLayer, type RoutingTable, type Triple, routingLayer,
} from '../src/routing/types.ts';

const EXECUTOR = new URL('..', import.meta.url).pathname;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/routing/${name}`, import.meta.url), 'utf8'));
const layer = (v: unknown): RoutingLayer => routingLayer(v, 'layer');

const OPUS: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' };
const FABLE: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'default' };
const LUNA_LOW: Triple = { backend: 'codex', model: 'gpt-5.6-luna', effort: 'low' };
const SOL_HIGH: Triple = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
const base = { profile: 'default', repoConfig: null, plan: null, unit: null } as const;

describe('routing', () => {
  it('catalogue: four pinned models, Claude effort default, Codex low|medium|high', () => {
    assert.deepEqual(Object.keys(MODELS).sort(), [...MODEL_IDS].sort());
    for (const m of MODEL_IDS) {
      const info = MODELS[m];
      assert.deepEqual(info.efforts, info.backend === 'claude' ? ['default'] : ['low', 'medium', 'high'], m);
    }
  });

  it('built-in profiles follow D2', () => {
    const d = PROFILE_TABLES.default;
    assert.deepEqual(resolve(d, 'build', 'low'), { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' });
    assert.deepEqual(resolve(d, 'build', 'med'), { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' });
    assert.deepEqual(resolve(d, 'build', 'high'), OPUS);
    for (const p of PROFILES) for (const r of ['planCheck', 'gate'] as const) {
      assert.deepEqual(PROFILE_TABLES[p][r], { low: OPUS, med: OPUS, high: FABLE }, `${p}/${r}`);
    }
    for (const p of PROFILES) assert.deepEqual(unsupportedSeats(resolveRouting({ ...base, profile: p }), null), [], p);
  });

  it('routing.layers: each layer overrides the one below, per seat', () => {
    const repoConfig = parseRepoConfig(fixture('config-seats.json')).routing?.seats ?? null;
    const plan = layer({ build: { low: LUNA_LOW, med: LUNA_LOW }, planCheck: { high: OPUS } });
    const unit = layer({ build: { low: OPUS } });
    const r = resolveRouting({ profile: 'default', repoConfig, plan, unit });
    assert.deepEqual(r.table.build.low, OPUS);
    assert.equal(r.sources.build.low, 'unit');
    assert.deepEqual(r.table.build.med, LUNA_LOW);
    assert.equal(r.sources.build.med, 'plan');
    assert.deepEqual(r.table.planCheck.high, OPUS);
    assert.equal(r.sources.planCheck.high, 'plan');
    assert.deepEqual(r.table.gate.med, FABLE);
    assert.equal(r.sources.gate.med, 'repo-config');
    assert.deepEqual(r.table.build.high, OPUS);
    assert.equal(r.sources.build.high, 'builtin');
    // Without the unit layer, the plan's build.low shows; without the plan too, the repo config's.
    assert.deepEqual(resolveRouting({ profile: 'default', repoConfig, plan, unit: null }).table.build.low, LUNA_LOW);
    const onlyRepo = resolveRouting({ profile: 'default', repoConfig, plan: null, unit: null });
    assert.deepEqual(onlyRepo.table.build.low, SOL_HIGH);
    assert.equal(onlyRepo.sources.build.low, 'repo-config');
  });

  it('routing.claude-only: selected by one config line; no seat resolves to Codex', () => {
    const cfg = parseRepoConfig(fixture('config-claude-only.json'));
    assert.equal(selectProfile(null, cfg), 'claude-only');
    assert.equal(selectProfile('default', cfg), 'default', 'an explicit --profile wins');
    assert.equal(selectProfile(null, null), 'default');
    const r = resolveRouting({ ...base, profile: selectProfile(null, cfg) });
    for (const role of ROLES) for (const tier of RISK_TIERS) {
      assert.equal(r.table[role][tier].backend, 'claude', `${role}/${tier}`);
    }
    assert.deepEqual(unsupportedSeats(r, null), []);
  });

  it('routing.codex-judgment-unsupported: refused at startup with the seat and layer, never the model', () => {
    for (const role of ['planCheck', 'gate'] as const) for (const m of ['gpt-5.6-luna', 'gpt-5.6-sol'] as const) {
      assert.equal(support(role, m).type, 'unsupported', `${role}/${m}`);
    }
    const r = resolveRouting({ ...base, plan: layer({ gate: { med: SOL_HIGH } }), unit: layer({ planCheck: { low: LUNA_LOW } }) });
    const u = unitId('u-one');
    const rejections = unsupportedSeats(r, u);
    assert.deepEqual(rejections, [
      { kind: 'unsupported-routing', role: 'planCheck', tier: 'low', layer: 'unit', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'gate', tier: 'med', layer: 'plan', unit: u, why: 'codex-judgment' },
    ]);
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(rejections), new RegExp(m.replace('.', '\\.')));
    // A Claude model without a prompt for the role is `no-prompt`.
    const noPrompt = unsupportedSeats(resolveRouting({ ...base, unit: layer({ build: { high: FABLE } }) }), null);
    assert.deepEqual(noPrompt, [{ kind: 'unsupported-routing', role: 'build', tier: 'high', layer: 'unit', unit: null, why: 'no-prompt' }]);
  });

  it('an effort the catalogue does not list is refused, naming the layer', () => {
    const xhigh = layer({ build: { low: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' } } });
    assert.throws(() => resolveRouting({ ...base, plan: xhigh }), (e: unknown) => e instanceof SchemaError && e.field === 'plan.build.low.effort');
  });

  it('repo config: unknown keys and malformed triples are refused', () => {
    assert.throws(() => parseRepoConfig({ routing: { profile: 'claude-only', extra: 1 } }), SchemaError);
    assert.throws(() => parseRepoConfig({ routing: { profile: 'fast' } }), SchemaError);
    assert.throws(() => parseRepoConfig({ routing: { seats: { build: { low: { backend: 'claude', model: 'gpt-5.6-luna', effort: 'default' } } } } }), SchemaError);
    assert.deepEqual(parseRepoConfig({}), {});
  });

  it('routing.rev-stable: same table, same rev; any seat change, a different rev', () => {
    const t = PROFILE_TABLES.default;
    const rev = routingRevOf(t);
    assert.match(rev, /^[0-9a-f]{16}$/);
    assert.equal(routingRevOf(structuredClone(t) as RoutingTable), rev);
    assert.equal(resolveRouting(base).rev, rev);
    const seen = new Set([rev]);
    for (const role of ROLES) for (const tier of RISK_TIERS) {
      // A JSON round trip, not structuredClone: the profile shares one tier object between two roles.
      const changed = JSON.parse(JSON.stringify(t)) as { -readonly [R in keyof RoutingTable]: { -readonly [T in keyof RoutingTable[R]]: Triple } };
      changed[role][tier] = t[role][tier].model === SOL_HIGH.model ? LUNA_LOW : SOL_HIGH;
      const r = routingRevOf(changed);
      assert.ok(!seen.has(r), `${role}/${tier}`);
      seen.add(r);
    }
    assert.notEqual(routingRevOf(PROFILE_TABLES['claude-only']), rev);
  });

  it('parse.new-model-fails: a fifth model without a prompt entry fails tsc; the project passes', () => {
    const tsc = `${EXECUTOR}node_modules/.bin/tsc`;
    let failed = false;
    try {
      execFileSync(tsc, ['--noEmit', '-p', 'test/fixtures/tsc-new-model'], { cwd: EXECUTOR, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      const out = String((e as { stdout?: string }).stdout ?? '');
      assert.match(out, /error TS2322/);
      assert.match(out, /Property '"gpt-9-test"' is missing/);
    }
    assert.ok(failed, 'the fixture must not typecheck');
    execFileSync(tsc, ['--noEmit', '-p', '.'], { cwd: EXECUTOR, stdio: 'pipe' });
  });
});
