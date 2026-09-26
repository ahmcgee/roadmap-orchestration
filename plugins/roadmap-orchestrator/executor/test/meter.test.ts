// The meter (src/meter.ts): per-role and per-unit usage totals folded from the log, and the render-time
// model view. The usage-validity test runs real backend invocations through fake CLIs.
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import { type RoutingRev, arcId, invocationId, opId, routingRev, unitId } from '../src/core/ids.ts';
import type { TokenUsage } from '../src/core/records.ts';
import { invoke } from '../src/pipeline/invoke.ts';
import { byModel, meterOf } from '../src/meter.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import { type Seat, seatRef } from '../src/routing/types.ts';
import { backend, context, dones, events, open, run, scenario, specFor } from './fixtures/invoke-specs.ts';

const ARC = arcId('arc-1');
const REV_A = routingRev('aaaaaaaaaaaaaaaa');
const U1 = unitId('u1');
const U2 = unitId('u2');

let seq = 0;
function factEvent(fact: Fact): Event {
  seq += 1;
  return { v: 1, seq, prev: null, at: '2026-09-25T12:00:00.000Z', arc: ARC, type: 'fact', fact } as Event;
}
const inv = (n: number) => invocationId(opId(ARC, n), 1);
const tokens = (input: number, output: number, cacheRead: number | null = null, cacheWrite: number | null = null): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

describe('meter', () => {
  it('spend.by-role: totals per role and routing revision, and per unit; smokes count only by role; never a model', () => {
    const log = [
      factEvent({ kind: 'meter', inv: inv(1), role: 'build', tier: 'med', routingRev: REV_A, unit: { unit: U1, attempt: 2 }, usage: tokens(100, 10, 50, 5) }),
      factEvent({ kind: 'meter', inv: inv(2), role: 'build', tier: 'high', routingRev: REV_A, unit: { unit: U2, attempt: 2 }, usage: tokens(200, 20) }),
      factEvent({ kind: 'usage-unavailable', inv: inv(3), role: 'build', tier: 'med', routingRev: REV_A, unit: { unit: U1, attempt: 5 }, reason: 'no-result' }),
      factEvent({ kind: 'meter', inv: inv(4), role: 'gate', tier: 'med', routingRev: REV_A, unit: { unit: U1, attempt: 7 }, usage: tokens(7, 3, 1, null) }),
      factEvent({ kind: 'meter', inv: inv(5), role: 'planCheck', tier: 'low', routingRev: REV_A, unit: null, usage: tokens(1, 1) }),
      factEvent({ kind: 'containment-mode', mode: 'session' }),
    ];
    const m = meterOf(log);
    assert.deepEqual(m.byRole, [
      { role: 'build', routingRev: REV_A, calls: 3, input: 300, output: 30, cacheRead: 50, cacheWrite: 5, unavailable: 1 },
      { role: 'gate', routingRev: REV_A, calls: 1, input: 7, output: 3, cacheRead: 1, cacheWrite: 0, unavailable: 0 },
      { role: 'planCheck', routingRev: REV_A, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
    ]);
    assert.deepEqual(m.bySeat, [
      { role: 'build', tier: 'high', routingRev: REV_A, calls: 1, input: 200, output: 20, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
      { role: 'build', tier: 'med', routingRev: REV_A, calls: 2, input: 100, output: 10, cacheRead: 50, cacheWrite: 5, unavailable: 1 },
      { role: 'gate', tier: 'med', routingRev: REV_A, calls: 1, input: 7, output: 3, cacheRead: 1, cacheWrite: 0, unavailable: 0 },
      { role: 'planCheck', tier: 'low', routingRev: REV_A, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
    ]);
    assert.deepEqual(m.byUnit, [
      { unit: U1, role: 'build', routingRev: REV_A, calls: 2, input: 100, output: 10, cacheRead: 50, cacheWrite: 5, unavailable: 1 },
      { unit: U1, role: 'gate', routingRev: REV_A, calls: 1, input: 7, output: 3, cacheRead: 1, cacheWrite: 0, unavailable: 0 },
      { unit: U2, role: 'build', routingRev: REV_A, calls: 1, input: 200, output: 20, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(m), /claude-|gpt-/);
  });

  it('byModel derives each seat\'s model at render from its revision\'s table, exactly (facts name the tier)', () => {
    const table = (profile: 'default' | 'claude-only') => resolveRouting({ profile, classes: null, repoConfig: null, plan: null, unit: null });
    const def = table('default');
    const claudeOnly = table('claude-only');
    const tables = new Map<RoutingRev, typeof def.table>([[def.rev, def.table], [claudeOnly.rev, claudeOnly.table]]);
    const t = (role: 'build' | 'gate', tier: Seat, rev: RoutingRev, input: number) =>
      ({ ...seatRef(role, tier), routingRev: rev, calls: 1, input, output: 1, cacheRead: 0, cacheWrite: 0, unavailable: 0 });
    const seats = [t('build', 'med', claudeOnly.rev, 10), t('build', 'med', def.rev, 5), t('build', 'high', def.rev, 7), t('gate', 'high', def.rev, 2), t('gate', 'escalation', def.rev, 3)];
    assert.deepEqual(byModel(seats, tables), [
      { model: 'claude-fable-5-1', calls: 1, input: 3, output: 1, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
      { model: 'claude-opus-5-5', calls: 3, input: 19, output: 3, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
      { model: 'gpt-5.6-luna', calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, unavailable: 0 },
    ]);
    assert.throws(() => byModel([t('gate', 'low', REV_A, 1)], tables), /no routing table for revision aaaaaaaaaaaaaaaa/);
  });
});

test('meter.usage-validity-independent-of-outcome: a failed call\'s usage still counts', { timeout: 60_000 }, async () => {
  const r = run();
  const s = scenario([
    { as: 'claude', expect: {}, acts: [{ type: 'emit', value: { ok: true } }] },
    { as: 'claude', expect: {}, acts: [{ type: 'malformed' }] },
  ]);
  const journal = open(r.runDir, r.arc);
  const ctx = context(journal, r.runDir);
  const ok = await invoke(journal, ctx.containment, specFor(backend(r, s)));
  const bad = await invoke(journal, ctx.containment, specFor(backend(r, s)));
  journal.close();
  assert.ok(ok.kind === 'result' && ok.result.type === 'backend' && ok.result.outcome.kind === 'success');
  assert.ok(bad.kind === 'result' && bad.result.type === 'backend' && bad.result.outcome.kind === 'malformed', JSON.stringify(bad));
  assert.equal(bad.result.usage.kind, 'known', 'the malformed call reported usage');
  assert.deepEqual(dones(r.runDir, 'proc.spawn').map((d) => d.kind === 'proc.spawn' && d.outcome.kind === 'result' ? d.outcome.summary : null), [
    { type: 'backend', outcome: 'success' }, { type: 'backend', outcome: 'malformed' },
  ]);
  const m = meterOf(events(r.runDir));
  assert.equal(m.byRole.length, 1);
  const total = m.byRole[0];
  assert.ok(total !== undefined);
  assert.equal(total.calls, 2);
  assert.equal(total.unavailable, 0);
  const usage = (x: typeof ok) => (x.kind === 'result' && x.result.type === 'backend' && x.result.usage.kind === 'known' ? x.result.usage.tokens.inputTokens : assert.fail());
  assert.equal(total.input, usage(ok) + usage(bad));
});
