import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { unitId, visionClauseId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { SchemaError } from '../src/core/validate.ts';
import { planPath } from '../src/core/values.ts';
import { support } from '../src/prompts/index.ts';
import { EARLIER_BUILTIN_SEATS, PRE_DEV12_BUILTIN_SEATS } from '../src/core/upgrade.ts';
import { CLASS_CATALOGUE, boundAt } from '../src/routing/classes.ts';
import {
  type RoutingStack, arcStack, parseRepoConfig, planStack, resolveRouting, resolveRoutingUnder, routingRevOf, seatsInForce, selectProfile, unsupportedSeats,
} from '../src/routing/layers.ts';
import { MODELS } from '../src/routing/models.ts';
import { BUILTIN_SEATS } from '../src/routing/profiles.ts';
import {
  FRESH_ROLES, MODEL_IDS, PROFILES, type Role, type RoutingLayer, type RoutingTable, SEAT_REFS, type Seat, type Triple, atSeat, routingLayer,
} from '../src/routing/types.ts';

const EXECUTOR = new URL('..', import.meta.url).pathname;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/routing/${name}`, import.meta.url), 'utf8'));
const layer = (v: unknown): RoutingLayer => routingLayer(v, 'layer');

/** The frontier and summit bindings (OR-Q17): Opus 5.5 at medium and at xhigh. */
const OPUS: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const OPUS_XHIGH: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };
const FABLE: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' };
const SONNET: Triple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
/** The efficient class's judgment binding in both profiles (owner ruling 2026-10-15): Sonnet 5.5 at high. */
const SONNET_HIGH: Triple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
/** The economy class's judgment binding in both profiles (1.0.0-dev.12): Haiku 5.5 at high. */
const HAIKU_HIGH: Triple = { backend: 'claude', model: 'claude-haiku-5-5', effort: 'high' };
const LUNA: Triple = { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' };
const SOL_HIGH: Triple = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
const base: RoutingStack = arcStack('default', null, null);

/** A judging role (dev.13: the walk roles act, and have Opus modules only). */
const isFresh = (r: Role): boolean => (FRESH_ROLES as readonly Role[]).includes(r);

describe('routing', () => {
  it('catalogue: six pinned models, Claude effort low|medium|high|xhigh|max, Codex low|medium|high', () => {
    assert.deepEqual(Object.keys(MODELS).sort(), [...MODEL_IDS].sort());
    for (const m of MODEL_IDS) {
      const info = MODELS[m];
      assert.deepEqual(info.efforts, info.backend === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'], m);
    }
  });

  it('routing.classes: the class catalogue is the one binding, per profile; seats name classes, never models', () => {
    const both = (t: Triple) => ({ build: t, judgment: t });
    assert.deepEqual(CLASS_CATALOGUE, {
      default: { efficient: { build: LUNA, judgment: SONNET_HIGH }, frontier: both(OPUS), summit: both(OPUS_XHIGH), economy: { judgment: HAIKU_HIGH } },
      'claude-only': { efficient: { build: SONNET, judgment: SONNET_HIGH }, frontier: both(OPUS), summit: both(OPUS_XHIGH), economy: { judgment: HAIKU_HIGH } },
    });
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(BUILTIN_SEATS), new RegExp(m.replace('.', '\\.')));
    assert.deepEqual(BUILTIN_SEATS, {
      planCheck: { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' },
      build: { low: 'efficient', med: 'efficient', high: 'frontier' },
      gate: { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' },
      lens: { arc: 'efficient' },
      checkpoint: { arc: 'summit' },
      packReview: { arc: 'frontier' },
      flow: { arc: 'efficient' },
      walkthrough: { arc: 'frontier' },
      polishJudge: { arc: 'frontier' },
    });
  });

  it('built-in profiles resolve: efficient builds low/med (Luna; Sonnet medium under claude-only) and judges plan-check low/med, gate low/med, the lenses and flow on Sonnet high; Opus medium builds high and judges the rest; Opus xhigh holds escalation', () => {
    const d = resolveRouting(base).table;
    assert.deepEqual(d.build, { low: LUNA, med: LUNA, high: OPUS });
    const c = resolveRouting(arcStack('claude-only', null, null)).table;
    assert.deepEqual(c.build, { low: SONNET, med: SONNET, high: OPUS });
    for (const t of [d, c]) {
      assert.deepEqual(t.planCheck, { low: SONNET_HIGH, med: SONNET_HIGH, high: OPUS, escalation: OPUS_XHIGH });
      assert.deepEqual(t.gate, { low: SONNET_HIGH, med: SONNET_HIGH, high: OPUS, escalation: OPUS_XHIGH });
      assert.deepEqual([t.lens.arc, t.checkpoint.arc, t.packReview.arc, t.flow.arc], [SONNET_HIGH, OPUS_XHIGH, OPUS, SONNET_HIGH]);
    }
    for (const p of PROFILES) {
      assert.deepEqual(unsupportedSeats(resolveRouting({ ...arcStack(p, null, null), arcScope: 'corpus', arcRoles: 'm4b' }), null), [], p);
    }
  });

  it('routing.efficient-judgment: the efficient class judges on Sonnet 5.5 high in both profiles, at every judgment seat a layer gives it, with a prompt for every judgment role', () => {
    const everyJudgment = layer({
      planCheck: { low: 'efficient', med: 'efficient', high: 'efficient', escalation: 'efficient' },
      gate: { low: 'efficient', med: 'efficient', high: 'efficient', escalation: 'efficient' },
      lens: { arc: 'efficient' }, checkpoint: { arc: 'efficient' }, packReview: { arc: 'efficient' }, flow: { arc: 'efficient' },
    });
    for (const p of PROFILES) {
      assert.deepEqual(CLASS_CATALOGUE[p].efficient.judgment, SONNET_HIGH, p);
      const r = resolveRouting({ ...arcStack(p, null, everyJudgment), arcScope: 'corpus', arcRoles: 'm4b' });
      for (const s of SEAT_REFS) if (isFresh(s.role)) assert.deepEqual(atSeat(r.table, s), SONNET_HIGH, `${p} ${s.role}.${s.tier}`);
      assert.deepEqual(unsupportedSeats(r, null), [], `${p}: route may seat the efficient class at any judgment seat`);
    }
    // The build seats keep the build binding: Luna under default, Sonnet medium under claude-only.
    assert.deepEqual(resolveRouting(arcStack('default', null, layer({ build: { high: 'efficient' } }))).table.build.high, LUNA);
    assert.deepEqual(resolveRouting(arcStack('claude-only', null, layer({ build: { high: 'efficient' } }))).table.build.high, SONNET);
  });

  it('routing.economy: a judgment-only class on Haiku 5.5 high in both profiles; any judgment seat may name it, with a prompt for every judgment role; a build seat naming it is refused in every layer; a rebind moves it', () => {
    const everyJudgment = layer({
      planCheck: { low: 'economy', med: 'economy', high: 'economy', escalation: 'economy' },
      gate: { low: 'economy', med: 'economy', high: 'economy', escalation: 'economy' },
      lens: { arc: 'economy' }, checkpoint: { arc: 'economy' }, packReview: { arc: 'economy' }, flow: { arc: 'economy' },
    });
    for (const p of PROFILES) {
      assert.deepEqual(CLASS_CATALOGUE[p].economy, { judgment: HAIKU_HIGH }, `${p}: no build triple`);
      const r = resolveRouting({ ...arcStack(p, null, everyJudgment), arcScope: 'corpus', arcRoles: 'm4b' });
      for (const s of SEAT_REFS) if (isFresh(s.role)) assert.deepEqual(atSeat(r.table, s), HAIKU_HIGH, `${p} ${s.role}.${s.tier}`);
      assert.deepEqual(unsupportedSeats(r, null), [], `${p}: route may seat economy at any judgment seat`);
    }
    // A build seat names a build class: economy there is refused by the repo config, a plan layer and a unit layer alike.
    assert.throws(() => parseRepoConfig({ routing: { seats: { build: { low: 'economy' } } } }), (e: unknown) => e instanceof SchemaError && e.field === 'config.routing.seats.build.low');
    assert.throws(() => layer({ build: { high: 'economy' } }), (e: unknown) => e instanceof SchemaError && e.field === 'layer.build.high');
    assert.throws(() => boundAt('default', 'economy', 'build'), /binds no build triple/);
    // No built-in seat names economy (the 2026-10-17 gate eval reverted gate.low): with the built-in seats nothing resolves
    // to Haiku, and even a Codex rebind of economy refuses nothing.
    for (const p of PROFILES) {
      const r = resolveRouting({ ...arcStack(p, null, null), arcScope: 'corpus', arcRoles: 'm4b' });
      assert.doesNotMatch(JSON.stringify(r.classes), /economy/, p);
      assert.doesNotMatch(JSON.stringify(r.table), /claude-haiku/, p);
    }
    const lunaEconomy = { economy: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'low' } } as const;
    assert.deepEqual(unsupportedSeats(resolveRouting(arcStack('default', parseRepoConfig({ routing: { classes: lunaEconomy } }), null)), null), []);
    // A repo rebind binds it at every judgment seat naming it (here the repo seats gate.low on it); a Codex rebind refuses
    // them; Haiku has no build prompt.
    const lowOnEconomy = { gate: { low: 'economy' } } as const;
    const onOpus = resolveRouting(arcStack('default', parseRepoConfig({ routing: { seats: lowOnEconomy, classes: { economy: OPUS } } }), null));
    assert.deepEqual([onOpus.table.gate.low, onOpus.bindings.economy], [OPUS, 'repo-config']);
    const onLuna = unsupportedSeats(resolveRouting(arcStack('default', parseRepoConfig({ routing: { seats: lowOnEconomy, classes: lunaEconomy } }), null)), null);
    assert.deepEqual(onLuna, [{ kind: 'unsupported-routing', role: 'gate', tier: 'low', layer: 'repo-config', class: 'economy', unit: null, why: 'codex-judgment' }]);
    const efficientOnHaiku = unsupportedSeats(resolveRouting(arcStack('claude-only', parseRepoConfig({ routing: { classes: { efficient: HAIKU_HIGH } } }), null)), null);
    assert.deepEqual(efficientOnHaiku.map((x) => x.kind === 'unsupported-routing' ? [x.role, x.tier, x.why] : null), [['build', 'low', 'no-prompt'], ['build', 'med', 'no-prompt']]);
  });

  it('routing.gate-ladder-adopted: an arc started on 1.0.0-dev.10 or dev.11 hashed the seats PRE_DEV12_BUILTIN_SEATS keeps; HEAD binds them to the triples it hashed, and only gate.med moved (gate.low went to economy and back within dev.12)', () => {
    for (const p of PROFILES) {
      const stack = { ...arcStack(p, null, null), arcRoles: 'm4b' } as const;
      const before = resolveRoutingUnder(PRE_DEV12_BUILTIN_SEATS, stack);
      const now = resolveRouting(stack);
      assert.deepEqual([before.table.gate.low, before.table.gate.med], [SONNET_HIGH, OPUS], `${p}: dev.11 gated low on Sonnet high, med on Opus medium`);
      assert.notEqual(before.rev, now.rev, `${p}: the ladder moved the rev`);
      const moved = SEAT_REFS.filter((s) => JSON.stringify(atSeat(before.table, s)) !== JSON.stringify(atSeat(now.table, s))).map((s) => `${s.role}.${s.tier}`);
      assert.deepEqual(moved, ['gate.med'], p);
      assert.deepEqual(EARLIER_BUILTIN_SEATS.at(-1), PRE_DEV12_BUILTIN_SEATS);
    }
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
    assert.deepEqual(r.table.gate.med, OPUS_XHIGH);
    assert.equal(r.sources.build.high, 'builtin');
    assert.deepEqual(r.bindings, { efficient: 'builtin', frontier: 'builtin', summit: 'builtin', economy: 'builtin' });
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
    assert.deepEqual(r.table.planCheck.low, SOL_HIGH, 'a rebind binds the judgment seats that name the class too');
    assert.equal(r.classes.build.low, 'efficient');
    assert.equal(r.sources.build.low, 'builtin', 'the class was chosen by the profile');
    assert.deepEqual(r.bindings, { efficient: 'repo-config', frontier: 'builtin', summit: 'builtin', economy: 'builtin' });
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
    // A repo rebind binds the class at every seat that names it, judgment seats included: only it puts Codex there.
    const summitOnSol = parseRepoConfig({ routing: { classes: { summit: SOL_HIGH } } });
    const r = resolveRouting({ ...arcStack('default', summitOnSol, layer({ gate: { med: 'summit' } })), unit: layer({ planCheck: { low: 'summit' } }) });
    const u = unitId('u-one');
    const rejections = unsupportedSeats(r, u);
    assert.deepEqual(rejections, [
      { kind: 'unsupported-routing', role: 'planCheck', tier: 'low', layer: 'unit', class: 'summit', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'planCheck', tier: 'escalation', layer: 'builtin', class: 'summit', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'gate', tier: 'med', layer: 'plan', class: 'summit', unit: u, why: 'codex-judgment' },
      { kind: 'unsupported-routing', role: 'gate', tier: 'escalation', layer: 'builtin', class: 'summit', unit: u, why: 'codex-judgment' },
    ]);
    // The efficient class's catalogue judgment binding is Claude under default, where its builds are Codex; a repo that
    // rebinds it to Codex has its efficient judgment seats refused like any other.
    const efficientOnSol = unsupportedSeats(resolveRouting(arcStack('default', parseRepoConfig(fixture('config-classes.json')), null)), null);
    assert.deepEqual(efficientOnSol.map((x) => x.kind === 'unsupported-routing' ? [x.role, x.tier, x.layer, x.class, x.why] : null), [
      ['planCheck', 'low', 'builtin', 'efficient', 'codex-judgment'], ['planCheck', 'med', 'builtin', 'efficient', 'codex-judgment'],
      ['gate', 'low', 'builtin', 'efficient', 'codex-judgment'], ['gate', 'med', 'builtin', 'efficient', 'codex-judgment'],
    ]);
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(rejections), new RegExp(m.replace('.', '\\.')));
    // A Claude model without a prompt for the role is `no-prompt` (Fable 5.1, reached by a repo rebind, has no build prompt).
    const summitOnFable = parseRepoConfig({ routing: { classes: { summit: FABLE } } });
    const noPrompt = unsupportedSeats(resolveRouting({ ...arcStack('default', summitOnFable, null), unit: layer({ build: { high: 'summit' } }) }), null);
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
    const rev = routingRevOf(t, 'none', null, false);
    assert.match(rev, /^[0-9a-f]{16}$/);
    assert.equal(routingRevOf(structuredClone(t), 'none', null, false), rev);
    assert.equal(resolveRouting(base).rev, rev);
    // Naming the class a seat already has is no change.
    assert.equal(resolveRouting(arcStack('default', null, layer({ build: { low: 'efficient' } }))).rev, rev);
    // Every seat is hashed where it is in force: all of them in a corpus arc of the m4b role set with milestones (the arc
    // seats only in their scope, G20; the walk seats only under milestones, dev.13).
    const seen = new Set([routingRevOf(t, 'corpus', 'm4b', true)]);
    for (const s of SEAT_REFS) {
      // A JSON round trip, not structuredClone: the table shares triple objects between seats.
      const changed = JSON.parse(JSON.stringify(t)) as Record<string, Record<Seat, Triple>>;
      changed[s.role]![s.tier] = atSeat(t, s).model === SOL_HIGH.model ? LUNA : SOL_HIGH;
      const r = routingRevOf(changed as unknown as RoutingTable, 'corpus', 'm4b', true);
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

// The M3 and M4a cases below resolve with no role set (null): the dev.7 role set an adopted 1.0.0-dev.7 arc keeps, whose
// revs, seats in force and checks must not move (M4b, R5). The m4b role set has its own cases.
describe('routing: the arc seats (M3)', () => {
  it('routing.holistic-filter: the arc seats are in force, checked and hashed only in a holistic arc (G20)', () => {
    // A non-holistic arc resolves as in M2: no arc seat is checked, and the rev hashes the unit roles alone.
    for (const p of PROFILES) {
      const r = resolveRouting(arcStack(p, null, null));
      assert.equal(r.arcScope, 'none');
      assert.deepEqual(seatsInForce(r).map((s) => s.role).filter((role) => role === 'lens' || role === 'checkpoint' || role === 'packReview' || role === 'flow'), []);
      assert.deepEqual(unsupportedSeats(r, null), [], p);
      const m2Table = { planCheck: r.table.planCheck, build: r.table.build, gate: r.table.gate };
      assert.equal(r.rev, createHash('sha256').update(canonicalJson(m2Table)).digest('hex').slice(0, 16), `${p}: the M2 rev`);
      // An arc seat rebound in a plan layer changes nothing while the arc is not holistic.
      assert.equal(resolveRouting(arcStack(p, null, layer({ lens: { arc: 'summit' } }))).rev, r.rev);
    }
    // The built-in arc seats: the lenses on efficient (Sonnet high), the checkpoint on summit (Opus xhigh).
    const base = resolveRouting(arcStack('default', null, null));
    assert.deepEqual([base.classes.lens.arc, base.classes.checkpoint.arc], ['efficient', 'summit']);
    assert.deepEqual([base.table.lens.arc, base.table.checkpoint.arc], [SONNET_HIGH, OPUS_XHIGH]);
    // A plan naming a vision puts the M3 arc seats in force: every seat but the pack review's (LR-0a-1), in the dev.7
    // role set the flow seat's, and without milestones the two walk seats' (dev.13) is checked (the built-in arc seats have
    // prompt modules since B4), and the rev hashes them too.
    const plan = { target: 'architecture-doc', holistic: { vision: planPath('vision.json'), advances: [visionClauseId('V-1')] } } as const;
    const h = resolveRouting(planStack('default', null, plan, null));
    assert.equal(h.arcScope, 'architecture-doc');
    assert.equal(seatsInForce(h).length, SEAT_REFS.length - 4);
    assert.notEqual(h.rev, base.rev);
    assert.deepEqual(unsupportedSeats(h, null), []);
    // Every Claude model has a module for every arc role (Sonnet since 2026-10-15): a plan may seat the checkpoint on efficient.
    const sonnet = resolveRouting(planStack('claude-only', null, { ...plan, routing: layer({ checkpoint: { arc: 'efficient' } }) }, null));
    assert.deepEqual(sonnet.table.checkpoint.arc, SONNET_HIGH);
    assert.deepEqual(unsupportedSeats(sonnet, null), []);
    assert.equal(resolveRouting(planStack('default', null, { target: 'architecture-doc' }, null)).rev, base.rev, 'no vision: the M2 stack');
    // A plan layer may seat the arc roles; a class the repo rebinds to Codex there is a Codex judgment.
    const frontierOnSol = parseRepoConfig({ routing: { classes: { frontier: SOL_HIGH } } });
    const codex = resolveRouting(planStack('default', frontierOnSol, { ...plan, routing: layer({ checkpoint: { arc: 'frontier' } }) }, null));
    assert.deepEqual(unsupportedSeats(codex, null).at(-1), {
      kind: 'unsupported-routing', role: 'checkpoint', tier: 'arc', layer: 'plan', class: 'frontier', unit: null, why: 'codex-judgment',
    });
  });
});

describe('routing: M4a (OR-Q17, OR-L3, LR-0a-1)', () => {
  const hashOf = (table: object): string => createHash('sha256').update(canonicalJson(table)).digest('hex').slice(0, 16);

  it('routing.catalogue-m4a: frontier is Opus 5.5 medium and summit Opus 5.5 xhigh in both profiles; Fable is reachable only by a repo rebind', () => {
    for (const p of PROFILES) {
      assert.deepEqual([CLASS_CATALOGUE[p].frontier, CLASS_CATALOGUE[p].summit], [{ build: OPUS, judgment: OPUS }, { build: OPUS_XHIGH, judgment: OPUS_XHIGH }], p);
      const r = resolveRouting({ ...arcStack(p, null, null), arcScope: 'corpus', arcRoles: 'm4b' });
      for (const s of SEAT_REFS) assert.notEqual(atSeat(r.table, s).model, 'claude-fable-5-1', `${p} ${s.role}.${s.tier}`);
      assert.deepEqual(unsupportedSeats(r, null), [], `${p}: every seat of a corpus arc has a prompt`);
    }
    assert.deepEqual(CLASS_CATALOGUE.default.efficient, { build: LUNA, judgment: SONNET_HIGH });
    assert.deepEqual(CLASS_CATALOGUE['claude-only'].efficient, { build: SONNET, judgment: SONNET_HIGH });
    assert.ok(MODELS['claude-fable-5-1'].efforts.includes('high'), 'Fable stays in the model catalogue');
    const fable = resolveRouting(arcStack('default', parseRepoConfig({ routing: { classes: { summit: FABLE } } }), null));
    assert.deepEqual(fable.table.gate.escalation, FABLE);
    assert.equal(fable.bindings.summit, 'repo-config');
  });

  it('routing.packreview-seat: packReview sits on frontier at `arc`; it is in force and hashed only in a corpus arc, so an architecture-doc arc hashes the dev.6 role set', () => {
    assert.deepEqual(BUILTIN_SEATS.packReview, { arc: 'frontier' });
    const vision = { vision: planPath('vision.json'), advances: [visionClauseId('V-1')] };
    const doc = resolveRouting(planStack('default', null, { target: 'architecture-doc', holistic: vision }, null));
    const corpus = resolveRouting(planStack('default', null, { target: 'corpus', holistic: { advances: vision.advances } }, null));
    assert.deepEqual([doc.arcScope, corpus.arcScope], ['architecture-doc', 'corpus']);
    assert.deepEqual(corpus.table.packReview.arc, OPUS);
    assert.ok(seatsInForce(corpus).some((s) => s.role === 'packReview'));
    assert.ok(!seatsInForce(doc).some((s) => s.role === 'packReview'));
    const { packReview: _p, flow: _f, walkthrough: _w, polishJudge: _j, ...dev6Roles } = doc.table;
    assert.equal(doc.rev, hashOf(dev6Roles), 'architecture-doc: unit roles, lens and checkpoint');
    const { flow: _cf, walkthrough: _cw, polishJudge: _cj, ...dev7Roles } = corpus.table;
    assert.equal(corpus.rev, hashOf(dev7Roles), 'corpus: every dev.7 role');
    // A plan layer that moves the packReview seat changes a corpus arc's rev only.
    const moved = layer({ packReview: { arc: 'summit' } });
    assert.equal(resolveRouting(planStack('default', null, { target: 'architecture-doc', holistic: vision, routing: moved }, null)).rev, doc.rev);
    assert.notEqual(resolveRouting(planStack('default', null, { target: 'corpus', holistic: { advances: vision.advances }, routing: moved }, null)).rev, corpus.rev);
  });
});
