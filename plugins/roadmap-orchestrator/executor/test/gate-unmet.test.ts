// dev.59 scope item 9 (C-351): acceptance clauses the gate holds unmet across rounds (named by id in a blocking
// `requirement-unmet` finding, src/pipeline/gate.ts `unmetClauses`). A clause every gate answer of the lineage holds unmet,
// from the second round on, goes to the root once as a non-blocking split proposal; the unit goes on. Fake-backed over a
// unit-common arc (one acceptance clause, A1): real processes, real git.
// Named tests: gate.unmet-clauses, gate.never-met-split, gate.never-met-crash.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NeedsUserRecord } from '../src/core/records.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { unmetClauses } from '../src/pipeline/gate.ts';
import type { GateOutput } from '../src/prompts/schemas.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor,type ArcRun,U1,codexStep,contextFor,gateStep,mulBuild,outcomes,setupArc,stepUntil } from './fixtures/unit-common.ts';
import { writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const unmet = (text: string, defect = 'requirement-unmet'): GateOutput['findings'][number] =>
  ({ severity: 'blocking', evidence: ['src/mul.js:1'], path: 'src/mul.js', text, contractRef: null, experiments: [], debt: null, defect, reraises: null, hunk: null }) as GateOutput['findings'][number];
const revise = (text: string) => gateStep({ decision: 'revise', directives: ['Wire A1 in.'], findings: [unmet(text)] });
const fix = (n: number) => codexStep([{ type: 'commit', message: `fix ${n}`, files: { [`src/fix-${n}.md`]: `round ${n}\n` } }], { argv: ['exec', 'resume'] });

/** Every split proposal the arc raised, with the gate attempt that raised it. */
function splits(r: ArcRun): readonly (NeedsUserRecord & Readonly<{ attempt: number | null }>)[] {
  return r.journal.view.opsOf('needsuser.raise').flatMap((i) => {
    const record = readNeedsUser(r.ctx.runDir, i.expect.id);
    return record?.reason === 'split-proposal' ? [{ ...record, attempt: i.parent.type === 'stage' && i.parent.stage === 'gate' ? i.parent.attempt : null }] : [];
  });
}

const gates = (d: ArcDescriptor) => outcomes(d).filter((o) => o.startsWith('gate:'));

test('gate.never-met-split: a clause the gate holds unmet in round 1 raises nothing; unmet again in round 2 it goes to the root once, non-blocking, and the unit goes on', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), revise('A1 is never wired in: mul is not exported.'), fix(1), revise('A1 is never wired in: mul is not exported.'), fix(2), revise('A1 is never wired in: mul is not exported.'), fix(3), gateStep({ decision: 'approve' })] });
  // Three charged revise rounds: both bounds are raised past them.
  const p = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: { limits?: object }[] };
  p.units[0]!.limits = { chargeable: 4, reviseRounds: 3 };
  writeFileSync(d.planPath, JSON.stringify(p));
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.deepEqual(splits(r), [], 'one round is no pattern');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.deepEqual(gates(d), ['gate:revise', 'gate:revise', 'gate:revise', 'gate:approve']);
    const raised = splits(r);
    assert.equal(raised.length, 1, 'once per lineage, not again in round 3');
    const [item] = raised;
    const secondGate = r.journal.view.opsOf('proc.spawn').flatMap((i) => i.parent.type === 'stage' && i.parent.stage === 'gate' ? [i.parent.attempt] : [])
      .filter((a, i, all) => all.indexOf(a) === i)[1];
    assert.deepEqual([item!.blocking, item!.subject, item!.attempt], [false, { type: 'unit', unit: U1 }, secondGate], 'raised by the second gate attempt, for the unit, non-blocking');
    assert.match(item!.summary, /every one of its lineage's 2 gate rounds held A1 \(mul\(2, 3\) is 6\) unmet/);
    assert.ok(item!.recommendation.includes('has run'), 'the lineage\'s attempts against the caps');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('gate.unmet-clauses: a clause is held unmet when a blocking requirement-unmet finding names its id as a whole token', () => {
  const answer = (...findings: GateOutput['findings']): GateOutput => ({ decision: 'revise', directives: ['x'], findings, reasons: ['r'], premises: [], standing: [], clusters: null, rulings: [] });
  const ids = ['A1', 'A10', 'A2-v'];
  assert.deepEqual(unmetClauses(answer(unmet('A10 and A2-v are missing.')), ids), ['A10', 'A2-v']);
  assert.deepEqual(unmetClauses(answer(unmet('(A1) is not met')), ids), ['A1']);
  assert.deepEqual(unmetClauses(answer(unmet('A1 breaks', 'incorrect-behaviour')), ids), [], 'another defect is not an unmet clause');
  assert.deepEqual(unmetClauses(answer({ ...unmet('A1 is missing'), severity: 'note', defect: null }), ids), [], 'a note never holds a clause unmet');
});

test('gate.never-met-crash: killed right after the split proposal is published, before round 2\'s outcome; the restart consumes the recorded answer and raises nothing twice', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), revise('A1 is never wired in: mul is not exported.'), fix(1), revise('A1 is never wired in: mul is not exported.'), fix(2), gateStep({ decision: 'approve' })] });
  const trigger = writeTrigger(tmpDir('unmet-crash'), { label: 'needsuser.raise.after-publish', occurrence: 1 });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', `the first driver died at its crash point: ${first.stderr}`);
  assert.deepEqual(gates(d), ['gate:revise'], 'killed before the second gate\'s outcome');
  // The restart recovers first (the open raise is closed), then drives.
  const second = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
  assert.deepEqual(gates(d), ['gate:revise', 'gate:revise', 'gate:approve']);
  const r = contextFor(d);
  try {
    assert.equal(splits(r).length, 1);
    assert.equal(readCalls(d.scenarioPath).filter((c) => c.as === 'claude' && c.stdin.includes('<mode>gate</mode>')).length, 3, 'the second gate was not asked again');
  } finally {
    r.journal.close();
  }
});
