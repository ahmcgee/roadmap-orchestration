// The meter (src/meter.ts): per-role and per-unit usage totals folded from the log, and the render-time
// model and class views. The usage-validity test runs real backend invocations through fake CLIs. 2026-10-16:
// meter.subagents-by-class (a call's subagent spend per usage class), meter.session-charge (a Claude session's cumulative
// readings charged once).
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import { type RoutingRev, arcId, claudeSessionId, invocationId, jobIdOf, opId, routingRev, unitId } from '../src/core/ids.ts';
import type { ClassUsage, TokenUsage } from '../src/core/records.ts';
import { type SessionCharge, addCharged } from '../src/core/usage.ts';
import { invoke, usageFact } from '../src/pipeline/invoke.ts';
import { byClass, byModel, meterOf, ownShare } from '../src/meter.ts';
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

  it('meter.job-usage: a job\'s lens and checkpoint calls count at their arc seat, by role and per job, never per unit; byModel renders them', () => {
    const job = (j: string, role: 'lens' | 'checkpoint', attempt: number) => ({ type: 'job', job: jobIdOf(j), attempt, role, tier: 'arc' }) as const;
    const holistic = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null, arcScope: 'architecture-doc' });
    const rev = holistic.rev;
    const log = [
      factEvent({ kind: 'meter', inv: inv(1), routingRev: rev, subject: job('audit-1', 'lens', 1), usage: tokens(100, 10) }),
      factEvent({ kind: 'meter', inv: inv(2), routingRev: rev, subject: job('audit-1', 'lens', 2), usage: tokens(50, 5, 7) }),
      factEvent({ kind: 'usage-unavailable', inv: inv(3), routingRev: rev, subject: job('ckpt-1', 'checkpoint', 1), reason: 'no-result' }),
      factEvent({ kind: 'meter', inv: inv(4), routingRev: rev, subject: job('ckpt-1', 'checkpoint', 2), usage: tokens(30, 3) }),
      factEvent({ kind: 'meter', inv: inv(5), routingRev: rev, subject: seat('gate', 'med', U1, 1), usage: tokens(1, 1) }),
    ];
    const m = meterOf(log);
    const zero = { cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 };
    assert.deepEqual(m.byRole.map((t) => [t.role, t.calls, t.input, t.unavailable]), [['checkpoint', 2, 30, 1], ['gate', 1, 1, 0], ['lens', 2, 150, 0]]);
    assert.deepEqual(m.bySeat.map((t) => [t.role, t.tier, t.calls]), [['checkpoint', 'arc', 2], ['gate', 'med', 1], ['lens', 'arc', 2]]);
    assert.deepEqual(m.byJob, [
      { job: 'audit-1', role: 'lens', routingRev: rev, calls: 2, input: 150, output: 15, ...zero, cacheRead: 7, unavailable: 0 },
      { job: 'ckpt-1', role: 'checkpoint', routingRev: rev, calls: 2, input: 30, output: 3, ...zero, unavailable: 1 },
    ]);
    assert.deepEqual(m.byUnit.map((t) => [t.unit, t.role]), [[U1, 'gate']], 'a job\'s call is in no unit total');
    // The render-time model view resolves the arc seats of a holistic revision's table.
    const models = byModel(m.bySeat, new Map([[rev, holistic.table]]));
    assert.equal(models.reduce((n, x) => n + x.calls, 0), 5);
    const callsOf = (model: string) => models.find((x) => x.model === model)?.calls ?? 0;
    assert.ok(callsOf(holistic.table.lens.arc.model) >= 2 && callsOf(holistic.table.checkpoint.arc.model) >= 2, JSON.stringify(models));
    assert.doesNotMatch(JSON.stringify(m), /claude-|gpt-/);
  });

  it('meter.packreview-seat: a pack review\'s calls count at the packReview arc seat of a corpus arc\'s revision, by role and per review job, never per unit; byModel resolves its seat (frontier)', () => {
    const corpus = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null, arcScope: 'corpus' });
    const rev = corpus.rev;
    const review = (j: string, attempt: number) => ({ type: 'job', job: jobIdOf(j), attempt, role: 'packReview', tier: 'arc' }) as const;
    const log = [
      factEvent({ kind: 'meter', inv: inv(1), routingRev: rev, subject: review('review-1', 1), usage: tokens(400, 40, 10) }),
      factEvent({ kind: 'usage-unavailable', inv: inv(2), routingRev: rev, subject: review('review-2', 1), reason: 'no-result' }),
      factEvent({ kind: 'meter', inv: inv(3), routingRev: rev, subject: review('review-2', 2), usage: tokens(300, 30) }),
    ];
    const m = meterOf(log);
    assert.deepEqual(m.byRole.map((t) => [t.role, t.routingRev, t.calls, t.input, t.unavailable]), [['packReview', rev, 3, 700, 1]]);
    assert.deepEqual(m.bySeat.map((t) => [t.role, t.tier, t.calls]), [['packReview', 'arc', 3]]);
    assert.deepEqual(m.byJob.map((t) => [t.job, t.role, t.calls, t.input]), [['review-1', 'packReview', 1, 400], ['review-2', 'packReview', 2, 300]]);
    assert.deepEqual(m.byUnit, [], 'a review\'s call is in no unit total');
    assert.deepEqual(byModel(m.bySeat, new Map([[rev, corpus.table]])).map((x) => [x.model, x.calls]), [[corpus.table.packReview.arc.model, 3]]);
    assert.equal(corpus.table.packReview.arc.model, 'claude-opus-5-5', 'frontier binds Opus 5.5 (OR-Q17)');
    // The architecture-doc scope has the seat in its table too (every SeatTable maps every role), so its revs resolve it.
    const doc = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null, arcScope: 'architecture-doc' });
    assert.notEqual(doc.rev, rev, 'packReview is in force only in a corpus arc (LR-0a-1), so the revs differ');
    assert.doesNotMatch(JSON.stringify(m), /claude-|gpt-/);
  });

  it('meter.subagents-by-class: a call\'s totals include its subagents\'; byClass puts each seat\'s own share on its class and the delegated share on its own', () => {
    const def = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null });
    const rev = def.rev;
    const S1 = claudeSessionId('11111111-1111-4111-8111-111111111111');
    const S2 = claudeSessionId('22222222-2222-4222-8222-222222222222');
    const economy: ClassUsage = { class: 'economy', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.01 };
    const frontier: ClassUsage = { class: 'frontier', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 10, costUsd: 0.1 };
    const log = [
      // gate.low sits on economy (Haiku 5.5, 1.0.0-dev.12); its subagents spent on economy (Haiku) and frontier (Opus).
      factEvent({ kind: 'meter', inv: inv(1), routingRev: rev, subject: seat('gate', 'low', U1, 1), usage: tokens(111, 56, 1100, 230, 4, 1.11), session: S1, delegated: [frontier, economy] }),
      // gate.med sits on efficient (Sonnet 5.5); nothing delegated.
      factEvent({ kind: 'meter', inv: inv(2), routingRev: rev, subject: seat('gate', 'med', U2, 1), usage: tokens(50, 5, 0, 0, 2, 0.5), session: S2, delegated: [] }),
    ];
    const m = meterOf(log);
    assert.deepEqual(m.bySeat.map((t) => [t.role, t.tier, t.input, t.costUsd]), [['gate', 'low', 111, 1.11], ['gate', 'med', 50, 0.5]], 'seat totals include subagents');
    assert.deepEqual(m.delegatedBySeat.map((d) => [d.role, d.tier, d.class, d.input, d.costUsd]), [['gate', 'low', 'frontier', 1, 0.1], ['gate', 'low', 'economy', 10, 0.01]]);
    assert.deepEqual(ownShare(m).map((t) => [t.tier, t.input, t.output, t.cacheRead, t.cacheWrite, Number(t.costUsd.toFixed(6)), t.calls, t.turns]), [
      ['low', 100, 50, 1000, 200, 1, 1, 4], ['med', 50, 5, 0, 0, 0.5, 1, 2],
    ]);
    const classes = byClass(m, new Map([[rev, def.classes]]));
    assert.deepEqual(classes.map((c) => [c.class, c.input, c.output, c.cacheRead, c.cacheWrite, Number(c.costUsd.toFixed(6))]), [
      // economy holds gate.low's own share and its Haiku subagent's alike: a seat's own class and a delegated class are one bucket.
      ['efficient', 50, 5, 0, 0, 0.5], ['frontier', 1, 1, 0, 10, 0.1], ['economy', 110, 55, 1100, 220, 1.01],
    ]);
    // byModel counts a seat's own share on the seat's model: Haiku (economy gate.low) 100 input, Sonnet (efficient gate.med) 50.
    assert.deepEqual(byModel(ownShare(m), new Map([[rev, def.table]])).map((x) => [x.model, x.input]), [['claude-haiku-5-5', 100], ['claude-sonnet-5-5', 50]]);
    assert.throws(() => byClass(m, new Map()), /no class table for revision/);
    assert.doesNotMatch(JSON.stringify(m), /claude-|gpt-/);
  });

  it('meter.session-charge: a resumed Claude session\'s cumulative reading is charged less what its earlier facts charged; a lower one fails loud', () => {
    const S = claudeSessionId('33333333-3333-4333-8333-333333333333');
    const charge = { routingRev: REV_A, subject: seat('planCheck', 'med', U1, 1) };
    let sum: SessionCharge | null = null;
    const view = { sessionCharge: () => sum };
    const economy = (input: number, cost: number): ClassUsage => ({ class: 'economy', inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost });
    // The fresh call: its reading is charged whole.
    const first = usageFact(view, charge, inv(1), { kind: 'known', tokens: tokens(10, 5, 100, 50, 3, 0.2), delegated: [economy(4, 0.01)] }, S);
    assert.ok(first.kind === 'meter');
    assert.deepEqual([first.usage, first.session, first.delegated], [tokens(10, 5, 100, 50, 3, 0.2), S, [economy(4, 0.01)]]);
    sum = addCharged(sum, { tokens: first.usage, delegated: first.delegated ?? [] });
    // The repair turn resumes it: the CLI reports the session's totals; the fact charges the difference, its own turns.
    const second = usageFact(view, charge, inv(2), { kind: 'known', tokens: tokens(14, 9, 300, 60, 2, 0.35), delegated: [economy(4, 0.01)] }, S);
    assert.ok(second.kind === 'meter');
    assert.deepEqual(second.usage.inputTokens, 4);
    assert.deepEqual([second.usage.outputTokens, second.usage.cacheReadTokens, second.usage.cacheWriteTokens, second.usage.turns], [4, 200, 10, 2]);
    assert.ok(Math.abs((second.usage.costUsd ?? -1) - 0.15) < 1e-12);
    assert.deepEqual(second.delegated, [economy(0, 0)]);
    // The meter's sums over the two facts are the session's last reading (turns: both processes').
    const m = meterOf([factEvent(first), factEvent(second)]);
    assert.deepEqual(m.byRole.map((t) => [t.input, t.output, t.cacheRead, t.cacheWrite, t.turns, Number(t.costUsd.toFixed(6))]), [[14, 9, 300, 60, 5, 0.35]]);
    sum = addCharged(sum, { tokens: second.usage, delegated: second.delegated ?? [] });
    assert.throws(() => usageFact(view, charge, inv(3), { kind: 'known', tokens: tokens(13, 9, 300, 60, 1, 0.35), delegated: [] }, S), /below what the session's earlier invocations were charged/);
    // A reading without `delegated` (Codex, or an earlier executor's) is charged as recorded and names no session.
    const codex = usageFact(view, charge, inv(4), { kind: 'known', tokens: tokens(1, 1) }, null);
    assert.ok(codex.kind === 'meter' && codex.session === undefined && codex.delegated === undefined);
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
      // build.high (frontier), gate.high (frontier) and gate.escalation (summit): Opus 5.5 at medium and xhigh (OR-Q17).
      { model: 'claude-opus-5-5', calls: 3, input: 12, output: 3, cacheRead: 0, cacheWrite: 0, turns: 3, costUsd: 1.5, unavailable: 0 },
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
