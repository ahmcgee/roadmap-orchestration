import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { SchemaError } from '../src/core/validate.ts';
import { support } from '../src/prompts/index.ts';
import { CLASS_CATALOGUE } from '../src/routing/classes.ts';
import { type RoutingStack, arcStack, parseRepoConfig, resolveRouting, routingRevOf, selectProfile, unsupportedSeats } from '../src/routing/layers.ts';
import { MODELS } from '../src/routing/models.ts';
import { PROFILE_TABLES } from '../src/routing/profiles.ts';
import {
  MODEL_IDS, PROFILES, type RoutingLayer, type RoutingTable, SEAT_REFS, type Seat, type Triple, atSeat, routingLayer,
} from '../src/routing/types.ts';

const EXECUTOR = new URL('..', import.meta.url).pathname;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/routing/${name}`, import.meta.url), 'utf8'));
const layer = (v: unknown): RoutingLayer => routingLayer(v, 'layer');

const OPUS: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const FABLE: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' };
const LUNA: Triple = { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' };
const SOL_HIGH: Triple = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
const base: RoutingStack = arcStack('default', null, null);

describe('routing', () => {
  it('catalogue: four pinned models, Claude effort low|medium|high|xhigh|max, Codex low|medium|high', () => {
    assert.deepEqual(Object.keys(MODELS).sort(), [...MODEL_IDS].sort());
    for (const m of MODEL_IDS) {
      const info = MODELS[m];
      assert.deepEqual(info.efforts, info.backend === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'], m);
    }
  });

  it('routing.classes: the class catalogue is the one binding; profiles name classes, never models', () => {
    assert.deepEqual(CLASS_CATALOGUE, { efficient: LUNA, frontier: OPUS, summit: FABLE });
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(PROFILE_TABLES), new RegExp(m.replace('.', '\\.')));
    const judgment = { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' };
    for (const p of PROFILES) {
      assert.deepEqual(PROFILE_TABLES[p].planCheck, judgment, p);
      assert.deepEqual(PROFILE_TABLES[p].gate, judgment, p);
    }
    assert.deepEqual(PROFILE_TABLES.default.build, { low: 'efficient', med: 'efficient', high: 'frontier' });
    assert.deepEqual(PROFILE_TABLES['claude-only'].build, { low: 'frontier', med: 'frontier', high: 'frontier' });
  });

  it('built-in profiles resolve: Luna builds low/med, Opus builds high and judges every tier, Fable holds escalation', () => {
    const d = resolveRouting(base).table;
    assert.deepEqual(d.build, { low: LUNA, med: LUNA, high: OPUS });
    for (const r of ['planCheck', 'gate'] as const) assert.deepEqual(d[r], { low: OPUS, med: OPUS, high: OPUS, escalation: FABLE }, r);
    for (const p of PROFILES) assert.deepEqual(unsupportedSeats(resolveRouting(arcStack(p, null, null)), null), [], p);
  });

  it('routing.layers: each layer overrides the one below, per seat; sources name the layer that chose the class', () => {
    const config = parseRepoConfig(fixture('config-seats.json'));
    const plan = layer({ build: { low: 'efficient', med: 'frontier' }, planCheck: { escalation: 'frontier' } });
    const unit = layer({ build: { low: 'frontier' } });
    const r = resolveRouting({ ...arcStack('default', config, plan), unit });
    assert.equal(r.classes.build.low, 'frontier');
    assert.equal(r.sources.build.low, 'unit');
    assert.deepEqual(r.table.build.low, OPUS);
    assert.equal(r.sources.build.med, 'plan');
    assert.deepEqual(r.table.build.med, OPUS);
    assert.equal(r.sources.planCheck.escalation, 'plan');
    assert.deepEqual(r.table.planCheck.escalation, OPUS);
    assert.equal(r.sources.gate.med, 'repo-config');
    assert.deepEqual(r.table.gate.med, FABLE);
    assert.equal(r.sources.build.high, 'builtin');
    assert.deepEqual(r.bindings, { efficient: 'builtin', frontier: 'builtin', summit: 'builtin' });
    // Without the unit layer, the plan's build.low shows; without the plan too, the repo config's.
    assert.deepEqual(resolveRouting(arcStack('default', config, plan)).table.build.low, LUNA);
    const onlyRepo = resolveRouting(arcStack('default', config, null));
    assert.deepEqual(onlyRepo.table.build.low, OPUS);
    assert.equal(onlyRepo.sources.build.low, 'repo-config');
  });

  it('routing.class-rebind: the repo config rebinds a class for every seat that names it, and changes the rev', () => {
    const config = parseRepoConfig(fixture('config-classes.json'));
    const r = resolveRouting(arcStack('default', config, null));
    assert.deepEqual(r.table.build.low, SOL_HIGH);
    assert.deepEqual(r.table.build.med, SOL_HIGH);
    assert.deepEqual(r.table.build.high, OPUS);
    assert.equal(r.classes.build.low, 'efficient');
    assert.equal(r.sources.build.low, 'builtin', 'the class was chosen by the profile');
    assert.deepEqual(r.bindings, { efficient: 'repo-config', frontier: 'builtin', summit: 'builtin' });
    assert.notEqual(r.rev, resolveRouting(base).rev);
    // A plan cannot rebind: `classes` is not a routing layer key.
    assert.throws(() => layer({ classes: { efficient: SOL_HIGH } }), (e: unknown) => e instanceof SchemaError && e.field === 'layer.classes');
  });

  it('a class rebind whose effort the catalogue does not list is refused, naming the class', () => {
    const xhigh = { routing: { classes: { efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' } } } };
    assert.throws(() => parseRepoConfig(xhigh), (e: unknown) => e instanceof SchemaError && e.field === 'config.routing.classes.efficient.effort');
  });

  it('routing.claude-only: selected by one config line; no seat resolves to Codex', () => {
    const cfg = parseRepoConfig(fixture('config-claude-only.json'));
    assert.equal(selectProfile(null, cfg), 'claude-only');
    assert.equal(selectProfile('default', cfg), 'default', 'an explicit --profile wins');
    assert.equal(selectProfile(null, null), 'default');
    const r = resolveRouting(arcStack(selectProfile(null, cfg), cfg, null));
    for (const s of SEAT_REFS) assert.equal(atSeat(r.table, s).backend, 'claude', `${s.role}/${s.tier}`);
    assert.deepEqual(unsupportedSeats(r, null), []);
  });

  it('routing.codex-judgment-unsupported: refused at startup with the seat, layer and class, never the model', () => {
    for (const role of ['planCheck', 'gate'] as const) for (const m of ['gpt-5.6-luna', 'gpt-5.6-sol'] as const) {
      assert.equal(support(role, m).type, 'unsupported', `${role}/${m}`);
    }
    const summitOnSol = parseRepoConfig({ routing: { classes: { summit: SOL_HIGH } } });
    const r = resolveRouting({ ...arcStack('default', summitOnSol, layer({ gate: { med: 'efficient' } })), unit: layer({ planCheck: { low: 'efficient' } }) });
    const u = unitId('u-one');
    const rejections = unsupportedSeats(r, u);
    assert.deepEqual(rejections, [
      { kind: 'unsupported-routing', role: 'planCheck', tier: 'low', layer: 'unit', class: 'efficient', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'planCheck', tier: 'escalation', layer: 'builtin', class: 'summit', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'gate', tier: 'med', layer: 'plan', class: 'efficient', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'gate', tier: 'escalation', layer: 'builtin', class: 'summit', unit: u, why: 'codex-judgment' },
    ]);
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(rejections), new RegExp(m.replace('.', '\\.')));
    // A Claude model without a prompt for the role is `no-prompt`.
    const noPrompt = unsupportedSeats(resolveRouting({ ...base, unit: layer({ build: { high: 'summit' } }) }), null);
    assert.deepEqual(noPrompt, [{ kind: 'unsupported-routing', role: 'build', tier: 'high', layer: 'unit', class: 'summit', unit: null, why: 'no-prompt' }]);
  });

  it('routing.classes-only: a triple at a seat, an unknown class, build.escalation and unknown keys are refused', () => {
    const seat = (build: unknown) => parseRepoConfig({ routing: { seats: { build } } });
    assert.throws(() => seat({ low: OPUS }), (e: unknown) => e instanceof SchemaError && e.field === 'config.routing.seats.build.low' && /model class/.test(e.message));
    assert.throws(() => seat({ low: 'opus' }), (e: unknown) => e instanceof SchemaError && e.field === 'config.routing.seats.build.low');
    assert.throws(() => seat({ escalation: 'summit' }), (e: unknown) => e instanceof SchemaError && e.field === 'config.routing.seats.build.escalation');
    assert.deepEqual(parseRepoConfig({ routing: { seats: { gate: { escalation: 'frontier' } } } }).routing?.seats, { gate: { escalation: 'frontier' } });
    assert.throws(() => parseRepoConfig({ routing: { profile: 'claude-only', extra: 1 } }), SchemaError);
    assert.throws(() => parseRepoConfig({ routing: { profile: 'fast' } }), SchemaError);
    assert.throws(() => parseRepoConfig({ routing: { classes: { frontier: { backend: 'claude', model: 'gpt-5.6-luna', effort: 'high' } } } }), SchemaError);
    assert.throws(() => parseRepoConfig({ routing: { classes: { turbo: OPUS } } }), SchemaError);
    assert.deepEqual(parseRepoConfig({}), {});
  });

  it('routing.rev-stable: the rev hashes triples: same table, same rev; any seat or binding change, a different rev', () => {
    const t = resolveRouting(base).table;
    const rev = routingRevOf(t);
    assert.match(rev, /^[0-9a-f]{16}$/);
    assert.equal(routingRevOf(structuredClone(t)), rev);
    assert.equal(resolveRouting(base).rev, rev);
    // Naming the class a seat already has is no change.
    assert.equal(resolveRouting(arcStack('default', null, layer({ build: { low: 'efficient' } }))).rev, rev);
    const seen = new Set([rev]);
    for (const s of SEAT_REFS) {
      // A JSON round trip, not structuredClone: the table shares triple objects between seats.
      const changed = JSON.parse(JSON.stringify(t)) as Record<string, Record<Seat, Triple>>;
      changed[s.role]![s.tier] = atSeat(t, s).model === SOL_HIGH.model ? LUNA : SOL_HIGH;
      const r = routingRevOf(changed as unknown as RoutingTable);
      assert.ok(!seen.has(r), `${s.role}/${s.tier}`);
      seen.add(r);
    }
    assert.notEqual(resolveRouting(arcStack('claude-only', null, null)).rev, rev);
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
