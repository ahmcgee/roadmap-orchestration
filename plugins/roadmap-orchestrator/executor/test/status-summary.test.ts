import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { arcId, laneId, unitId } from '../src/core/ids.ts';
import type { Event, StageOutcomeFact } from '../src/core/events.ts';
import { parseCommand } from '../src/input/cli.ts';
import { parsePlan } from '../src/input/plan.ts';
import { summarize } from '../src/status/summary.ts';
import { status } from '../src/status.ts';
import { absPath } from '../src/core/values.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

const event = (fact: StageOutcomeFact): Event => ({ type: 'fact', fact }) as Event;

test('status summary golden: progress, expectations, caught and notices with no blocking budget policy', () => {
  const d = setupArc({ steps: [] });
  const plan = parsePlan({ ...JSON.parse(readFileSync(d.planPath, 'utf8')), expectations: { arcUsd: 10, perMilestoneUsd: 2 } });
  contextFor(d).journal.close();
  const s = status(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  const events = [event({ kind: 'stage-outcome', unit: unitId('u1'), stage: 'gate', attempt: 1, outcome: 'revise', class: 'revise', chargeable: true })];
  const summary = summarize({ ...s, arc: arcId('golden'), spend: { ...s.spend, byRole: [{ role: 'build', routingRev: '0123456789abcdef' as never, calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 12, unavailable: 0 }] } }, events, plan);
  assert.deepEqual(summary, JSON.parse(readFileSync(new URL('./fixtures/status-summary.golden.json', import.meta.url), 'utf8')));
  assert.deepEqual(parseCommand(['status', '--summary']), { command: 'status', run: { type: 'host' }, summary: true });
});

test('expectations are optional finite nonnegative USD and can be exceeded without a cap', () => {
  const d = setupArc({ steps: [] }); const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
  assert.equal(parsePlan(raw).expectations, undefined);
  assert.deepEqual(parsePlan({ ...raw, expectations: { arcUsd: 0 } }).expectations, { arcUsd: 0 });
  for (const n of [-1, Infinity, '2']) assert.throws(() => parsePlan({ ...raw, expectations: { arcUsd: n } }));
});
