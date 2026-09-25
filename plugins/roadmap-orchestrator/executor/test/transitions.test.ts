// Pure-module tests of the transition table (src/pipeline/transitions.ts): one case per row of the plan's
// table, exhaustiveness over every (stage, outcome), the bounds, route-up, risk promotion and retries, and
// agreement between the counters a decision predicts and the counters the fold derives from its fact.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type LogRecord, type OutcomeClass, type OutcomeStage, type RetryStage, type StageOutcomeKind, OUTCOME_STAGES,
  RETRY_STAGES, STAGE_OUTCOME_KINDS,
} from '../src/core/events.ts';
import { specRev } from '../src/core/ids.ts';
import { type UnitCounters, type UnitState, afterStageOutcome, fold, newUnitState } from '../src/core/state.ts';
import { repoPattern } from '../src/core/values.ts';
import { type Next, type StageOutcome, TABLE, outcomeFact, transition } from '../src/pipeline/transitions.ts';
import { ARC, AT, REV, U1, chain } from './fixtures/log-records.ts';

type Counter = Exclude<keyof UnitCounters, 'retries' | 'attempts'> | `retries.${RetryStage}`;
type Given = Readonly<{
  counters?: Partial<Record<Counter, number>>;
  routedUp?: UnitState['routedUp'];
  promotion?: boolean;
  risk?: UnitState['risk'];
}>;

/** A unit at risk `med` with nothing counted, patched by `g`. */
function unit(g: Given = {}): UnitState {
  const base = newUnitState(U1, 'plan-check', g.risk ?? 'med');
  const c = { ...base.counters, retries: { ...base.counters.retries } };
  for (const [name, n] of Object.entries(g.counters ?? {}) as [Counter, number][]) {
    if (name.startsWith('retries.')) c.retries[name.slice('retries.'.length) as RetryStage] = n;
    else c[name as Exclude<Counter, `retries.${RetryStage}`>] = n;
  }
  return { ...base, counters: c, routedUp: g.routedUp ?? [], promotion: g.promotion ?? false };
}

const outcome = <S extends OutcomeStage>(stage: S, kind: StageOutcomeKind<S>): StageOutcome => ({ stage, kind }) as StageOutcome;

/** `stage[/round]@seat`, `stage` (executor stage), `park:<reason>`, `stop:<reason>`, `retire`. */
function show(n: Next): string {
  switch (n.kind) {
    case 'park':
    case 'stop':
      return `${n.kind}:${n.needsUser.reason}`;
    case 'retire':
      return 'retire';
    case 'hold':
      return 'hold';
    case 'stage':
      if (n.stage === 'build') return `build/${n.round}@${n.seat}`;
      return n.seat === null ? n.stage : `${n.stage}@${n.seat}`;
  }
}

function flat(c: UnitCounters): Record<Counter, number> {
  const out: Record<string, number> = {
    chargeableFailures: c.chargeableFailures, redirects: c.redirects, reviseRounds: c.reviseRounds, candidateReds: c.candidateReds,
  };
  for (const s of RETRY_STAGES) out[`retries.${s}`] = c.retries[s];
  return out as Record<Counter, number>;
}

function delta(before: UnitCounters, after: UnitCounters): Partial<Record<Counter, number>> {
  const a = flat(after);
  const b = flat(before);
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== b[k as Counter]).map(([k, v]) => [k, v - b[k as Counter]]));
}

// The plan's table, one case per row plus one per bound, retry or route-up branch of a row.
// [stage, outcome, given state, next, recorded class, counter deltas]. The unit's risk is med throughout.
type Row = { [S in OutcomeStage]: readonly [S, StageOutcomeKind<S>, Given, string, OutcomeClass, Partial<Record<Counter, number>>] }[OutcomeStage];
const ROWS: readonly Row[] = [
  // plan-check (fresh judgment)
  ['plan-check', 'approve', {}, 'build/fresh@med', 'advance', {}],
  ['plan-check', 'redirect', {}, 'plan-check@med', 'redirect', { redirects: 1 }],
  ['plan-check', 'redirect', { counters: { redirects: 1 } }, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'redirect', { counters: { redirects: 1 }, routedUp: ['plan-check'] }, 'park:escalation', 'park', {}],
  ['plan-check', 'infeasible', {}, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'infeasible', { routedUp: ['plan-check'] }, 'park:escalation', 'park', {}],
  ['plan-check', 'escalate', {}, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'escalate', { risk: 'high' }, 'park:escalation', 'park', {}],
  ['plan-check', 'risk-lowered', {}, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'scope-widened', {}, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'scope-widened', { routedUp: ['plan-check'] }, 'park:escalation', 'park', {}],
  ['plan-check', 'interrupted', {}, 'hold', 'hold', {}],
  ['plan-check', 'refusal', {}, 'plan-check@high', 'route-up', {}],
  ['plan-check', 'refusal', { routedUp: ['plan-check'] }, 'park:refusal', 'park', {}],
  ['plan-check', 'malformed', {}, 'plan-check@med', 'retry', { 'retries.plan-check': 1 }],
  ['plan-check', 'malformed', { counters: { 'retries.plan-check': 1 } }, 'park:malformed', 'park', {}],
  ['plan-check', 'process-fault', {}, 'park:process-fault', 'park', {}],
  // build (implementer)
  ['build', 'success', {}, 'quiesce', 'advance', {}],
  ['build', 'refusal', {}, 'park:refusal', 'park', {}],
  ['build', 'malformed', {}, 'build/resume@med', 'retry', { 'retries.build': 1 }],
  ['build', 'malformed', { counters: { 'retries.build': 1 } }, 'park:malformed', 'park', {}],
  ['build', 'process-fault', {}, 'park:process-fault', 'park', {}],
  ['build', 'occupied', {}, 'park:occupancy-unlabelled', 'park', {}],
  ['build', 'cleanup-failed', {}, 'park:residue', 'park', {}],
  ['build', 'interrupted', {}, 'hold', 'hold', {}],
  ['build', 'interrupted', { counters: { 'retries.build': 1, chargeableFailures: 2 } }, 'hold', 'hold', {}],
  // quiesce → evidence → salvage → teardown
  ['quiesce', 'empty', {}, 'evidence', 'advance', {}],
  ['evidence', 'captured', {}, 'salvage', 'advance', {}],
  ['salvage', 'committed', {}, 'teardown', 'advance', {}],
  ['salvage', 'committed-contract-touched', {}, 'teardown', 'trigger', {}],
  ['salvage', 'unmerged', {}, 'park:salvage-failed', 'park', {}],
  ['salvage', 'commit-failed', {}, 'park:salvage-failed', 'park', {}],
  ['teardown', 'released', {}, 'lanes', 'advance', {}],
  ['teardown', 'cleanup-failed', {}, 'park:residue', 'park', {}],
  // lanes (clean detached worktree at the salvage SHA)
  ['lanes', 'green', {}, 'gate@med', 'advance', {}],
  ['lanes', 'green', { promotion: true }, 'gate@high', 'advance', {}],
  ['lanes', 'red', {}, 'build/fix@med', 'advance', { chargeableFailures: 1 }],
  ['lanes', 'red', { counters: { chargeableFailures: 2 } }, 'park:chargeable-bound', 'park', { chargeableFailures: 1 }],
  ['lanes', 'not-certified', {}, 'build/fix@med', 'advance', { chargeableFailures: 1 }],
  ['lanes', 'blocked', {}, 'lanes', 'retry', { 'retries.lanes': 1 }],
  ['lanes', 'blocked', { counters: { 'retries.lanes': 1 } }, 'park:lane-blocked', 'park', {}],
  ['lanes', 'interrupted', {}, 'hold', 'hold', {}],
  ['lanes', 'cleanup-failed', {}, 'park:residue', 'park', {}],
  ['lanes', 'occupied', {}, 'park:occupancy-unlabelled', 'park', {}],
  // gate (fresh judgment)
  ['gate', 'approve', {}, 'candidate', 'advance', {}],
  ['gate', 'revise', {}, 'build/fix@med', 'revise', { reviseRounds: 1, chargeableFailures: 1 }],
  ['gate', 'revise', { counters: { reviseRounds: 1 } }, 'build/fix@med', 'revise', { reviseRounds: 1, chargeableFailures: 1 }],
  ['gate', 'revise', { counters: { reviseRounds: 2 } }, 'gate@high', 'route-up', {}],
  ['gate', 'revise', { counters: { reviseRounds: 2 }, routedUp: ['gate'] }, 'park:escalation', 'park', {}],
  ['gate', 'escalate', {}, 'gate@high', 'route-up', {}],
  ['gate', 'escalate', { promotion: true }, 'park:escalation', 'park', {}],
  ['gate', 'empty-diff', {}, 'park:empty-diff', 'park', {}],
  ['gate', 'refusal', {}, 'gate@high', 'route-up', {}],
  ['gate', 'refusal', { routedUp: ['gate'] }, 'park:refusal', 'park', {}],
  ['gate', 'malformed', {}, 'gate@med', 'retry', { 'retries.gate': 1 }],
  ['gate', 'malformed', { counters: { 'retries.gate': 1 } }, 'park:malformed', 'park', {}],
  ['gate', 'process-fault', {}, 'park:process-fault', 'park', {}],
  ['gate', 'interrupted', {}, 'hold', 'hold', {}],
  // candidate (integration slot)
  ['candidate', 'green', {}, 'ff', 'advance', {}],
  ['candidate', 'transient-violation', {}, 'build/fix@med', 'trigger', { chargeableFailures: 1 }],
  ['candidate', 'conflict', {}, 'build/resolve@med', 'advance', {}],
  ['candidate', 'red', {}, 'build/fix@med', 'candidate-red', { candidateReds: 1, chargeableFailures: 1 }],
  ['candidate', 'red', { counters: { candidateReds: 1 } }, 'park:candidate-red', 'park', {}],
  ['candidate', 'base-red', {}, 'park:base-red', 'park', {}],
  ['candidate', 'occupied', {}, 'park:occupancy-unlabelled', 'park', {}],
  ['candidate', 'interrupted', {}, 'hold', 'hold', {}],
  // ff
  ['ff', 'published', {}, 'snapshot', 'advance', {}],
  ['ff', 'cas-stale', {}, 'candidate', 'advance', {}],
  ['ff', 'fingerprint-invalid', {}, 'gate@med', 'advance', {}],
  ['ff', 'foreign-move', {}, 'stop:foreign-ref-move', 'stop', {}],
  // snapshot
  ['snapshot', 'published', {}, 'retire', 'retire', {}],
];

/** Every (stage, outcome) the fact vocabulary admits; StageOutcome is derived from the same list. */
const ALL: readonly StageOutcome[] = OUTCOME_STAGES.flatMap((s) => STAGE_OUTCOME_KINDS[s].map((k) => ({ stage: s, kind: k }) as StageOutcome));

describe('transitions', () => {
  it('transitions.table: every row gives its next step, class and counter deltas', () => {
    for (const [stage, kind, given, next, cls, deltas] of ROWS) {
      const u = unit(given);
      const o = outcome(stage, kind);
      const label = `${stage} ${kind} ${JSON.stringify(given)}`;
      const n = transition(u, o);
      const fact = outcomeFact(u, o, 1);
      assert.equal(show(n), next, label);
      assert.equal(fact.class, cls, label);
      assert.equal(fact.chargeable, (deltas.chargeableFailures ?? 0) === 1, `${label}: chargeable`);
      const after = afterStageOutcome(u, fact);
      assert.deepEqual(delta(u.counters, after.counters), deltas, `${label}: counter deltas`);
      if (n.kind === 'stage') assert.deepEqual(n.counters, after.counters, `${label}: Next.counters are the recorded counters`);
    }
  });

  it('transitions.exhaustive: every (stage, outcome) has exactly one table row and a case above', () => {
    for (const s of OUTCOME_STAGES) {
      assert.deepEqual(Object.keys(TABLE[s]).sort(), [...STAGE_OUTCOME_KINDS[s]].sort(), `table rows of ${s}`);
    }
    const covered = new Set(ROWS.map(([s, k]) => `${s} ${k}`));
    for (const o of ALL) {
      assert.ok(covered.has(`${o.stage} ${o.kind}`), `no table case for ${o.stage} ${o.kind}`);
      transition(unit(), o);
    }
    assert.equal(covered.size, ALL.length);
    assert.ok(!OUTCOME_STAGES.includes('retire' as OutcomeStage), 'retire is terminal and reports no outcome');
  });

  it('transitions.bound-3: the third chargeable failure parks, whatever its row says', () => {
    const { nexts, state } = drive([
      outcome('lanes', 'red'), // 1
      outcome('gate', 'revise'), // 2
      outcome('gate', 'revise'), // 3: a revise round within its bound, but the unit is bounded first
    ]);
    assert.deepEqual(nexts.map(show), ['build/fix@med', 'build/fix@med', 'park:chargeable-bound']);
    assert.equal(state.counters.chargeableFailures, 3);
    assert.equal(state.counters.reviseRounds, 1, 'the bounded revise round did not happen');
    assert.equal(state.status, 'park-pending');
    // Uncharged failures never count toward the bound.
    const quiet = drive([outcome('lanes', 'blocked'), outcome('build', 'malformed'), outcome('gate', 'malformed'), outcome('candidate', 'conflict')]);
    assert.equal(quiet.state.counters.chargeableFailures, 0);
  });

  it('transitions.route-up-then-needs-user: the high seat of the role, then park', () => {
    const { nexts, state } = drive([outcome('gate', 'refusal'), outcome('gate', 'refusal')]);
    assert.deepEqual(nexts.map(show), ['gate@high', 'park:refusal']);
    assert.deepEqual(state.routedUp, ['gate']);
    // Per role: a routed-up plan-check leaves the gate on the unit's seat; a routed-up gate stays high.
    const perRole = drive([
      outcome('plan-check', 'escalate'), outcome('plan-check', 'approve'), outcome('lanes', 'green'), outcome('gate', 'escalate'),
      outcome('gate', 'revise'), outcome('lanes', 'green'), outcome('gate', 'escalate'),
    ]);
    assert.deepEqual(perRole.nexts.map(show), [
      'plan-check@high', 'build/fresh@med', 'gate@med', 'gate@high', 'build/fix@med', 'gate@high', 'park:escalation',
    ]);
  });

  it('transitions.risk-promotion-next-judgment-only', () => {
    const { nexts } = drive([
      outcome('salvage', 'committed-contract-touched'),
      outcome('teardown', 'released'),
      outcome('lanes', 'red'), // a fix round between the trigger and the gate keeps it pending
      outcome('lanes', 'green'),
      outcome('gate', 'malformed'), // the retry is the same judgment dispatch
      outcome('gate', 'approve'), // the promoted judgment decided
      outcome('candidate', 'green'),
      outcome('ff', 'fingerprint-invalid'),
      outcome('gate', 'approve'),
      outcome('candidate', 'transient-violation'), // scope growth: the implementer keeps its seat
      outcome('lanes', 'green'),
    ]);
    assert.deepEqual(nexts.map(show), [
      'teardown', 'lanes', 'build/fix@med', 'gate@high', 'gate@high', 'candidate', 'ff', 'gate@med', 'candidate', 'build/fix@med', 'gate@high',
    ]);
  });

  it('transitions.malformed-one-uncharged: one uncharged retry per stage, then park', () => {
    for (const [stage, retried] of [['plan-check', 'plan-check@med'], ['build', 'build/resume@med'], ['gate', 'gate@med']] as const) {
      const { nexts, facts, state } = drive([outcome(stage, 'malformed'), outcome(stage, 'malformed')]);
      assert.deepEqual(nexts.map(show), [retried, 'park:malformed'], stage);
      assert.deepEqual(facts.map((f) => [f.class, f.chargeable]), [['retry', false], ['park', false]], stage);
      assert.equal(state.counters.retries[stage], 1, stage);
      assert.equal(state.counters.chargeableFailures, 0, stage);
    }
  });
});

describe('transitions (holds)', () => {
  it('transitions.interrupted-holds: an interruption moves no counter, holds the unit and keeps a pending promotion', () => {
    for (const stage of ['plan-check', 'build', 'lanes', 'gate', 'candidate'] as const) {
      const { nexts, facts, state } = drive([outcome(stage, 'interrupted')]);
      assert.deepEqual(nexts.map(show), ['hold'], stage);
      assert.deepEqual(facts.map((f) => [f.class, f.chargeable]), [['hold', false]], stage);
      assert.equal(state.status, 'held', stage);
      assert.deepEqual({ ...state.counters, attempts: 0 }, { ...newUnitState(U1, stage, 'med').counters, attempts: 0 }, stage);
    }
    const held = drive([outcome('salvage', 'committed-contract-touched'), outcome('gate', 'interrupted')]);
    assert.equal(held.state.promotion, true, 'the held gate is re-dispatched on the promoted seat');
    const resumed = drive([outcome('salvage', 'committed-contract-touched'), outcome('gate', 'interrupted'), outcome('gate', 'approve')]);
    assert.deepEqual(resumed.nexts.map(show), ['teardown', 'hold', 'candidate']);
    assert.equal(resumed.state.status, 'active');
    assert.equal(resumed.state.promotion, false);
  });
});

type Driven = Readonly<{ nexts: readonly Next[]; facts: readonly ReturnType<typeof outcomeFact>[]; state: UnitState }>;

/**
 * Feeds outcomes to one unit at risk med, recording each as its `stage-outcome` fact in a real log and
 * deciding each from the state the fold derives, and checks each decision's counters against the fold's.
 */
function drive(outcomes: readonly StageOutcome[]): Driven {
  const records: LogRecord[] = [{
    type: 'fact', fact: { kind: 'dispatch', record: { unit: U1, specRev: specRev(1), scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: REV, at: AT } },
  }];
  const attempts = new Map<OutcomeStage, number>();
  const nexts: Next[] = [];
  const facts: ReturnType<typeof outcomeFact>[] = [];
  let state = newUnitState(U1, outcomes[0]!.stage, 'med');
  for (const o of outcomes) {
    const attempt = (attempts.get(o.stage) ?? 0) + 1;
    attempts.set(o.stage, attempt);
    const next = transition(state, o);
    const fact = outcomeFact(state, o, attempt);
    records.push({ type: 'fact', fact });
    const folded = fold(ARC, chain(records)).units.find((u) => u.unit === U1);
    assert.ok(folded !== undefined);
    if (next.kind === 'stage') assert.deepEqual({ ...next.counters, attempts: 0 }, { ...folded.counters, attempts: 0 }, `${o.stage} ${o.kind}`);
    nexts.push(next);
    facts.push(fact);
    state = folded;
  }
  return { nexts, facts, state };
}
