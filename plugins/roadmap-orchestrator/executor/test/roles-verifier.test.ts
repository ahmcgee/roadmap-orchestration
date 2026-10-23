// The verifier role eval's cells, summary and harness (evals/roles/verifier/), free: degenerate fake verifiers through the
// run, each trial an arc whose fix round claims docs-only since the certified tree and whose lanes stage calls the verifier
// through the production docs-only check (src/pipeline/docsonly.ts). Named tests: roles.verifier-cells,
// roles.verifier-summary, roles.verifier-fakes, roles.verifier-caps, roles.verifier-arm, roles.verifier-triggers.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readByCode } from '../src/pipeline/docsonly.ts';
import { rebindConfig } from '../evals/roles/run.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { type VerifierRow, verifierArm } from '../evals/roles/verifier/arc.ts';
import { DEV_VERIFIER_CELLS, type VerifierCell } from '../evals/roles/verifier/cells.ts';
import { VERIFIER_FAMILIES } from '../evals/roles/verifier/families.ts';
import { buildVerifierFixture, diffOf } from '../evals/roles/verifier/fixture.ts';
import { runVerifier } from '../evals/roles/verifier/run.ts';
import { type VerifierSummary, summariseVerifier } from '../evals/roles/verifier/summary.ts';
import { tmpDir } from './helpers/repo.ts';

/** The fake trials run real lanes: about 50 s alone, several times that under the parallel tier's load. */
const T = { timeout: 600_000 };

const cellOf = (id: string): VerifierCell => DEV_VERIFIER_CELLS.find((c) => c.id === id)!;
const crit = (s: VerifierSummary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;

test('roles.verifier-cells: unique ids, every family, clear and not-clear keys; each key names one expectation per hunk of the diff; every hunk is one code leaves to the verifier; no file names the eval', T, () => {
  assert.equal(new Set(DEV_VERIFIER_CELLS.map((c) => c.id)).size, DEV_VERIFIER_CELLS.length);
  for (const family of VERIFIER_FAMILIES) assert.ok(DEV_VERIFIER_CELLS.some((c) => c.family === family), family);
  const fixtures = DEV_VERIFIER_CELLS.map(buildVerifierFixture);
  assert.ok(fixtures.some((f) => f.expected === 'accept') && fixtures.some((f) => f.expected === 'refuse'));
  for (const f of fixtures) {
    // Code's own reading (docsonly.ts): a directive refuses the claim, a hunk it is certain is comments passes, without the verifier.
    const read = readByCode(f.cell.path, f.cell.before, f.cell.after, diffOf(f.cell.before, f.cell.after));
    assert.equal(read.kind, 'read', `${f.cell.id}: code refuses it as a directive`);
    assert.equal(read.kind === 'read' ? read.left.length : 0, f.hunks.length, `${f.cell.id}: code clears a hunk itself`);
    assert.doesNotMatch(f.cell.before + f.cell.after + f.cell.path, /\b(evals?|verifier|oracle|answer key)\b/i, f.cell.id);
  }
  assert.throws(() => buildVerifierFixture({ ...cellOf('MIX-SPLIT'), hunks: ['clear'] }), /the diff has 2 hunks, the key names 1/);
});

// ---------------------------------------------------------------------------------------------------
// The summary

function row(cell: VerifierCell, trial: number, decision: 'accept' | 'refuse' | null): VerifierRow {
  const expected = cell.hunks.every((h) => h === 'clear') ? 'accept' : 'refuse';
  const clear = decision === 'accept';
  return {
    set: 'dev', cell: cell.id, family: cell.family, trial, verifier: 'real', expected, void: decision === null ? { reason: 'invalid', detail: 'x' } : null,
    decision, correct: decision === null ? null : decision === expected, reason: null,
    hunks: decision === null ? [] : cell.hunks.map((expect, i) => ({ id: `h${i + 1}`, expect, clear: clear || expect === 'clear', correct: (clear || expect === 'clear') === (expect === 'clear'), flagged: expect === 'clear' ? null : !clear })),
    usage: null, estimatedUsd: 0.01, wallMs: 5_000, turns: 1, calls: 1, models: ['claude-haiku-5-5'], dir: '/x',
  };
}
const runOf = (trial: number, decide: (c: VerifierCell) => 'accept' | 'refuse' | null) => DEV_VERIFIER_CELLS.map((c) => row(c, trial, decide(c)));
const oracle = (c: VerifierCell) => (c.hunks.every((h) => h === 'clear') ? 'accept' : 'refuse');

test('roles.verifier-summary: no false accept, false refusals within the bar, stability, voids, holdout gap; false accepts and refusals counted per trial and per hunk', T, () => {
  const good = summariseVerifier('dev', [0, 1, 2].flatMap((t) => runOf(t, oracle)), null, 'arm');
  for (const c of good.criteria) assert.equal(c.pass, true, `${c.name}: ${c.detail}`);
  assert.deepEqual([good.falseAccepts.k, good.falseRefusals.k, good.hunkFalseAccepts.k, good.hunkFalseRefusals.k], [0, 0, 0, 0]);

  // One accepted claim on a not-clear cell fails, whatever else holds; its not-clear hunks count as false accepts.
  const once = summariseVerifier('dev', runOf(0, (c) => (c.id === 'EX-PY-DOCTEST' ? 'accept' : oracle(c))));
  assert.deepEqual([crit(once, 'false-accept'), crit(once, 'false-refusal'), once.falseAccepts.k, once.hunkFalseAccepts.k], [false, true, 1, 1]);
  const clearAll = summariseVerifier('dev', runOf(0, () => 'accept'));
  assert.equal(crit(clearAll, 'false-accept'), false);
  const refuseAll = summariseVerifier('dev', runOf(0, () => 'refuse'));
  assert.deepEqual([crit(refuseAll, 'false-accept'), crit(refuseAll, 'false-refusal')], [true, false]);
  // False refusals: two of ten clear cells (20%) pass the 25% bar; three (30%) fail.
  const refuse = (ids: readonly string[]) => (c: VerifierCell) => (ids.includes(c.id) ? 'refuse' : oracle(c));
  assert.equal(crit(summariseVerifier('dev', runOf(0, refuse(['CL-MD', 'CL-C-BLOCK']))), 'false-refusal'), true);
  assert.equal(crit(summariseVerifier('dev', runOf(0, refuse(['CL-MD', 'CL-C-BLOCK', 'CL-JSONC']))), 'false-refusal'), false);
  // A void is neither accepted nor refused, and voids over a quarter fail.
  const voided = summariseVerifier('dev', runOf(0, (c) => (c.family === 'comment' || c.family === 'docstring' ? null : oracle(c))));
  assert.equal(crit(voided, 'voids'), false);
  // Stability over runs, and the holdout's accuracy within 15 points of dev's.
  const flip = summariseVerifier('dev', [...runOf(0, oracle), ...runOf(1, refuse(['CL-MD', 'CL-C-BLOCK', 'CL-JSONC', 'CL-GO-BLOCK', 'CL-RS-DOC']))]);
  assert.equal(crit(flip, 'stability'), false);
  const holdout = DEV_VERIFIER_CELLS.slice(0, 4).map((c, i) => row({ ...c, id: `H${i}` }, 0, i < 3 ? oracle(c) : 'refuse'));
  assert.equal(crit(summariseVerifier('holdout', holdout, good, 'arm'), 'holdout-gap'), false, '3/4 against all');
});

// ---------------------------------------------------------------------------------------------------
// The harness end to end on degenerate verifiers

async function fakeRun(verifier: string, cells: readonly string[], caps: Readonly<{ n?: number; cap?: number; trialCap?: number; parallel?: number }> = {}) {
  const out = join(tmpDir('verifier-out'), 'run');
  const lines: string[] = [];
  const summary = await runVerifier({
    set: 'dev', n: caps.n ?? 1, cells, parallel: caps.parallel ?? 2, config: null, out, compare: null, verifier: verifier as never, cap: caps.cap ?? null, trialCap: caps.trialCap ?? null,
  }, (l) => lines.push(l));
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as VerifierRow);
  return { summary, rows, out, lines };
}
const byCell = (rows: readonly VerifierRow[]) => Object.fromEntries(rows.map((r) => [r.cell, r]));

test('roles.verifier-fakes: through the production docs-only check, an oracle passes; clear-all false-accepts every not-clear cell; refuse-all false-refuses every clear one', T, async () => {
  const good = await fakeRun('oracle', ['CL-PY-DOC', 'MIX-SPLIT', 'DIR-DOCKER']);
  assert.ok(good.lines.includes('ARM verifier.med economy claude-haiku-5-5:high'), good.lines.join('\n'));
  for (const c of good.summary.criteria) assert.notEqual(c.pass, false, `${c.name}: ${c.detail}`);
  for (const r of good.rows) {
    assert.equal(r.void, null, `${r.cell}: ${JSON.stringify(r.void)}`);
    assert.equal(r.correct, true, r.cell);
    assert.equal(r.calls, 1, `${r.cell}: one verifier call`);
    assert.deepEqual(r.models, ['claude-haiku-5-5'], `${r.cell}: the economy seat's model`);
    assert.ok(r.hunks.every((h) => h.correct), r.cell);
    for (const file of ['key.json', 'prompt.txt', 'verifier-1.jsonl', 'transcript.jsonl', 'answer.json', 'row.json']) assert.ok(existsSync(join(r.dir, file)), `${r.cell}: ${file}`);
    const prompt = readFileSync(join(r.dir, 'prompt.txt'), 'utf8');
    const cell = cellOf(r.cell);
    assert.ok(!prompt.includes(good.out) && !prompt.includes('key.json'), 'the prompt never names the run dir or the key');
    assert.equal((prompt.match(/<hunk id="/g) ?? []).length, cell.hunks.length, `${r.cell}: every hunk asked`);
    assert.ok(prompt.includes(`path="${cell.path}"`), `${r.cell}: its path`);
  }
  assert.deepEqual(byCell(good.rows)['MIX-SPLIT']!.hunks.map((h) => h.clear), [true, false], 'graded per hunk');
  assert.match(byCell(good.rows)['MIX-SPLIT']!.reason ?? '', /did not clear h2 \(src\/page\.ts\)/);

  const clearAll = await fakeRun('clear-all', ['CL-PY-DOC', 'DIR-DOCKER']);
  assert.deepEqual([crit(clearAll.summary, 'false-accept'), crit(clearAll.summary, 'false-refusal')], [false, true]);
  assert.ok(clearAll.rows.every((r) => r.decision === 'accept' && r.void === null));
  assert.deepEqual([clearAll.summary.falseAccepts.k, clearAll.summary.falseAccepts.n, clearAll.summary.hunkFalseAccepts.k], [1, 1, 1]);

  const refuseAll = await fakeRun('refuse-all', ['CL-PY-DOC', 'MIX-SPLIT']);
  assert.deepEqual([crit(refuseAll.summary, 'false-accept'), crit(refuseAll.summary, 'false-refusal')], [true, false]);
  assert.deepEqual([refuseAll.summary.falseRefusals.k, refuseAll.summary.falseRefusals.n, refuseAll.summary.hunkFalseRefusals.k], [1, 1, 3]);
  assert.ok(refuseAll.rows.every((r) => r.decision === 'refuse' && r.void === null));
});

test('roles.verifier-caps: --trial-cap kills an overspending verifier (void cap, its estimate kept); --cap starts no trial past the spend', T, async () => {
  const over = await fakeRun('overspend', ['DIR-DOCKER'], { trialCap: 1 });
  assert.equal(over.rows[0]!.void?.reason, 'cap', JSON.stringify(over.rows[0]!.void));
  assert.ok(over.rows[0]!.estimatedUsd >= 20);
  assert.ok(over.lines.some((l) => l.startsWith('BRAKE DIR-DOCKER#0 cap')));
  const capped = await fakeRun('oracle', ['CL-MD'], { n: 3, cap: 0.01, parallel: 2 });
  assert.equal(capped.rows.length, 2, 'two ran in parallel before the cap was reached');
  assert.deepEqual(capped.summary.capped, { capUsd: 0.01, notStarted: 1 });
});

test('roles.verifier-arm: the arm is the verifier seat (economy, Haiku 5.5 high); --rebind moves it through the repo config; a Codex seat is refused', T, () => {
  assert.equal(verifierArm(null), 'verifier.med economy claude-haiku-5-5:high');
  assert.equal(verifierArm(rebindConfig(['economy=claude-sonnet-5-5:high'])), 'verifier.med economy (rebound) claude-sonnet-5-5:high');
  assert.throws(() => verifierArm(rebindConfig(['economy=gpt-5.6-luna:high'])), /Claude only|verifier|economy/);
});

test('roles.verifier-triggers: the verifier\'s prompt, the docs-only check and its eval trigger the verifier eval alone; shared paths every role', T, () => {
  for (const p of ['src/prompts/verifier/claude-haiku-5-5.ts', 'src/pipeline/docsonly.ts', 'src/pipeline/comments.ts', 'evals/roles/verifier/cells.ts']) assert.deepEqual(triggeredRoles([p]), ['verifier'], p);
  for (const p of ['src/prompts/schemas.ts', 'src/routing/profiles.ts', 'evals/roles/run.ts']) assert.deepEqual(triggeredRoles([p]), ['gate', 'walkthrough', 'polishJudge', 'verifier'], p);
  assert.deepEqual(triggeredRoles(['src/pipeline/gate.ts']), ['gate']);
});
