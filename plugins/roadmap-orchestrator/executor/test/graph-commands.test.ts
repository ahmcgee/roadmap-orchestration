// The graph commands (src/commands/graph.ts) through the command op: `resolve-edge` and `run-only` record
// their facts, refuse what the plan in force does not name, and apply nothing twice. Named tests:
// cmd.resolve-edge, cmd.run-only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { resolveEdge, runOnly } from '../src/commands/graph.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type CommandId, arcId, edgeId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { admitter } from '../src/schedule/ready.ts';
import { type ArcDescriptor, type ArcRun, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: 60_000 };
const U1 = unitId('u1');
const U2 = unitId('u2');
const U3 = unitId('u3');

/** Three units; u3 waits on the contingent edge `e-vendor`. */
function arc(): ArcRun {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
  plan.units[2]!['contingent'] = [{ id: 'e-vendor', condition: 'the vendor ships its v2 API' }];
  writeFileSync(d.planPath, JSON.stringify(plan));
  return contextFor(d);
}

async function command(r: ArcRun, body: CommandBody) {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r), file) };
}

const factsOf = (d: ArcDescriptor, kind: Fact['kind']): readonly Fact[] =>
  readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === kind ? [e.fact] : []));

test('cmd.resolve-edge: records the edge resolved on the architect\'s evidence, once; an unknown or resolved edge is rejected', T, async () => {
  const r = arc();
  try {
    const unknown = await command(r, { type: 'resolve-edge', edge: edgeId('e-nope'), evidence: 'x' });
    assert.deepEqual(unknown.outcome, { kind: 'rejected', reason: 'no unit of the plan in force has a contingent edge e-nope' });

    const first = await command(r, { type: 'resolve-edge', edge: edgeId('e-vendor'), evidence: 'v2 is on the registry' });
    assert.equal(first.outcome.kind, 'applied');
    const resolved = r.journal.view.edgeResolved(edgeId('e-vendor'));
    assert.deepEqual([resolved?.command, resolved?.evidence], [first.id, 'v2 is on the registry']);

    const again = await command(r, { type: 'resolve-edge', edge: edgeId('e-vendor'), evidence: 'again' });
    assert.deepEqual(again.outcome, { kind: 'rejected', reason: `edge e-vendor is already resolved (by ${first.id})` });
    // Recovery re-runs the effect of the command that resolved it: its postcondition holds, nothing is written.
    assert.deepEqual(resolveEdge(commandContextFor(r), first.id as CommandId, edgeId('e-vendor'), 'v2 is on the registry'), { kind: 'applied', verified: ['edge e-vendor of unit u3 resolved'] });
    assert.equal(factsOf(r.d, 'edge-resolved').length, 1);
  } finally {
    r.journal.close();
  }
});

test('cmd.run-only: limits admission to the units named, checked at admission, then clears; ids outside the plan are rejected', T, async () => {
  const r = arc();
  try {
    const admit = admitter((u) => r.ctx.routing(u).table);
    const constraints = (unit: typeof U1) =>
      admit({ view: r.journal.view, plan: r.ctx.plan(), unit: r.unit(unit), stage: 'plan-check', blocking: [], drains: [], tripped: [] });

    const outside = await command(r, { type: 'run-only', units: [U1, unitId('u9')] });
    assert.deepEqual(outside.outcome, { kind: 'rejected', reason: 'unit u9 is not in the plan in force' });
    assert.equal(r.journal.view.runOnly(), null);

    const only = await command(r, { type: 'run-only', units: [U1, U3] });
    assert.equal(only.outcome.kind, 'applied');
    assert.deepEqual(r.journal.view.runOnly(), [U1, U3]);
    assert.deepEqual(constraints(U1), { kind: 'admit' });
    assert.deepEqual(constraints(U2), { kind: 'wait', constraints: [{ type: 'run-only' }] });
    // Its effect again (recovery after a crash before the receipt): in force already, nothing written.
    assert.deepEqual(runOnly(commandContextFor(r), only.id as CommandId, [U1, U3]), { kind: 'applied', verified: ['admission limited to u1, u3'] });
    assert.equal(factsOf(r.d, 'run-only').length, 1);

    const clear = await command(r, { type: 'run-only', units: null });
    assert.equal(clear.outcome.kind, 'applied');
    assert.equal(r.journal.view.runOnly(), null);
    assert.deepEqual(constraints(U2), { kind: 'admit' });
    assert.equal(factsOf(r.d, 'run-only').length, 2);
  } finally {
    r.journal.close();
  }
});
