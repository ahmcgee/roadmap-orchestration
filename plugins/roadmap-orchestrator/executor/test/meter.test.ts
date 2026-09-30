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
import { type Seat, unitSeatRef } from '../src/routing/types.ts';
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
const tokens = (input: number, output: number, cacheRead: number | null = null, cacheWrite: number | null = null, turns: number | null = null, costUsd: number | null = null): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, turns, costUsd });
const seat = (role: 'build' | 'gate' | 'planCheck', tier: Seat, unit: typeof U1, attempt: number) => ({ type: 'seat', ...unitSeatRef(role, tier), unit, attempt }) as const;

describe('meter', () => {
  it('spend.by-role: totals per role and routing revision, per seat and per unit, with turns and cost; never a model', () => {
    const log = [
      factEvent({ kind: 'meter', inv: inv(1), routingRev: REV_A, subject: seat('build', 'med', U1, 2), usage: tokens(100, 10, 50, 5) }),
      factEvent({ kind: 'meter', inv: inv(2), routingRev: REV_A, subject: seat('build', 'high', U2, 2), usage: tokens(200, 20) }),
      factEvent({ kind: 'usage-unavailable', inv: inv(3), routingRev: REV_A, subject: seat('build', 'med', U1, 5), reason: 'no-result' }),
      factEvent({ kind: 'meter', inv: inv(4), routingRev: REV_A, subject: seat('gate', 'med', U1, 7), usage: tokens(7, 3, 1, null, 12, 0.5) }),
      factEvent({ kind: 'meter', inv: inv(5), routingRev: REV_A, subject: seat('gate', 'med', U2, 1), usage: tokens(1, 1, 0, 0, 3, 0.25) }),
      factEvent({ kind: 'containment-mode', mode: 'session' }),
    ];
    const m = meterOf(log);
    const zero = { turns: 0, costUsd: 0 };
    assert.deepEqual(m.byRole, [
      { role: 'build', routingRev: REV_A, calls: 3, input: 300, output: 30, cacheRead: 50, cacheWrite: 5, ...zero, unavailable: 1 },
      { role: 'gate', routingRev: REV_A, calls: 2, input: 8, output: 4, cacheRead: 1, cacheWrite: 0, turns: 15, costUsd: 0.75, unavailable: 0 },
    ]);
    assert.deepEqual(m.bySeat, [
      { role: 'build', tier: 'high', routingRev: REV_A, calls: 1, input: 200, output: 20, cacheRead: 0, cacheWrite: 0, ...zero, unavailable: 0 },
      { role: 'build', tier: 'med', routingRev: REV_A, calls: 2, input: 100, output: 10, cacheRead: 50, cacheWrite: 5, ...zero, unavailable: 1 },
      { role: 'gate', tier: 'med', routingRev: REV_A, calls: 2, input: 8, output: 4, cacheRead: 1, cacheWrite: 0, turns: 15, costUsd: 0.75, unavailable: 0 },
    ]);
    assert.deepEqual(m.byUnit, [
      { unit: U1, role: 'build', routingRev: REV_A, calls: 2, input: 100, output: 10, cacheRead: 50, cacheWrite: 5, ...zero, unavailable: 1 },
      { unit: U1, role: 'gate', routingRev: REV_A, calls: 1, input: 7, output: 3, cacheRead: 1, cacheWrite: 0, turns: 12, costUsd: 0.5, unavailable: 0 },
      { unit: U2, role: 'build', routingRev: REV_A, calls: 1, input: 200, output: 20, cacheRead: 0, cacheWrite: 0, ...zero, unavailable: 0 },
      { unit: U2, role: 'gate', routingRev: REV_A, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 3, costUsd: 0.25, unavailable: 0 },
    ]);
    assert.deepEqual(m.bySmoke, []);
    assert.doesNotMatch(JSON.stringify(m), /claude-|gpt-/);
  });

  it('spend.smoke-apart: a smoke is charged to its backend, in no role, seat or unit total', () => {
    const log = [
      factEvent({ kind: 'meter', inv: inv(1), routingRev: REV_A, subject: { type: 'smoke', backend: 'claude' }, usage: tokens(9, 9, 0, 100, 2, 0.1) }),
      factEvent({ kind: 'usage-unavailable', inv: inv(2), routingRev: REV_A, subject: { type: 'smoke', backend: 'codex' }, reason: 'absent' }),
      factEvent({ kind: 'meter', inv: inv(3), routingRev: REV_A, subject: seat('planCheck', 'low', U1, 1), usage: tokens(5, 5) }),
    ];
    const m = meterOf(log);
    assert.deepEqual(m.bySmoke, [
      { backend: 'claude', routingRev: REV_A, calls: 1, input: 9, output: 9, cacheRead: 0, cacheWrite: 100, turns: 2, costUsd: 0.1, unavailable: 0 },
      { backend: 'codex', routingRev: REV_A, calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0, unavailable: 1 },
    ]);
    assert.deepEqual(m.byRole.map((t) => [t.role, t.calls, t.input]), [['planCheck', 1, 5]]);
    assert.deepEqual(m.bySeat.map((t) => [t.role, t.tier, t.calls]), [['planCheck', 'low', 1]]);
  });

  it('byModel derives each seat\'s model at render from its revision\'s table, exactly (facts name the tier)', () => {
    const table = (profile: 'default' | 'claude-only') => resolveRouting({ profile, classes: null, repoConfig: null, plan: null, unit: null });
    const def = table('default');
    const claudeOnly = table('claude-only');
    const tables = new Map<RoutingRev, typeof def.table>([[def.rev, def.table], [claudeOnly.rev, claudeOnly.table]]);
    const t = (role: 'build' | 'gate', tier: Seat, rev: RoutingRev, input: number) =>
      ({ ...unitSeatRef(role, tier), routingRev: rev, calls: 1, input, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 0.5, unavailable: 0 });
    const seats = [t('build', 'med', claudeOnly.rev, 10), t('build', 'med', def.rev, 5), t('build', 'high', def.rev, 7), t('gate', 'high', def.rev, 2), t('gate', 'escalation', def.rev, 3)];
    assert.deepEqual(byModel(seats, tables), [
      { model: 'claude-fable-5-1', calls: 1, input: 3, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 0.5, unavailable: 0 },
      { model: 'claude-opus-5-5', calls: 2, input: 9, output: 2, cacheRead: 0, cacheWrite: 0, turns: 2, costUsd: 1, unavailable: 0 },
      { model: 'claude-sonnet-5-5', calls: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 0.5, unavailable: 0 },
      { model: 'gpt-5.6-luna', calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 0.5, unavailable: 0 },
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
