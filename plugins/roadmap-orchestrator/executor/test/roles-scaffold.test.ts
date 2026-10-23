// The scaffold role eval's cells, summary and harness (evals/roles/scaffold/), free: degenerate fake writers through run.ts,
// each trial an arc whose plan-check decides `scaffold` and whose scaffold stage runs for real (code's checks, the dry run of
// the load lane, the commit). Named tests: roles.scaffold-cells, roles.scaffold-summary, roles.scaffold-fakes (oracle,
// fix-on-retry, outside and nothing), roles.scaffold-caps, roles.scaffold-seat, roles.scaffold-triggers.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { matchesPattern, repoPath, repoPattern } from '../src/core/values.ts';
import { rebindConfig } from '../evals/roles/run.ts';
import { type ScaffoldRow, scaffoldSeat } from '../evals/roles/scaffold/arc.ts';
import { DEV_SCAFFOLD_CELLS, type ScaffoldCell } from '../evals/roles/scaffold/cells.ts';
import { runScaffold } from '../evals/roles/scaffold/run.ts';
import { type ScaffoldSummary, refusalKind, summariseScaffold } from '../evals/roles/scaffold/summary.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: 600_000 };

const within = (p: string, globs: readonly string[]): boolean => globs.some((g) => matchesPattern(repoPath(p), repoPattern(g)));

test('roles.scaffold-cells: four cells over four families; each reference skeleton lies within its new system, its test paths and its manifest files, holds every entry point and names the load test; no cell names the eval', () => {
  assert.equal(DEV_SCAFFOLD_CELLS.length, 4);
  assert.equal(new Set(DEV_SCAFFOLD_CELLS.map((c) => c.id)).size, 4);
  assert.equal(new Set(DEV_SCAFFOLD_CELLS.map((c) => c.family)).size, 4);
  const words = /\b(evals?|cells?|oracle|answer key|reference)\b/i;
  for (const c of DEV_SCAFFOLD_CELLS) {
    const paths = Object.keys(c.reference);
    const manifest = c.manifest.map((m) => m.path);
    for (const p of paths) assert.ok(manifest.includes(p) || within(p, [...c.newSystem.paths, ...c.newSystem.tests]), `${c.id}: ${p}`);
    for (const e of c.entryPoints) assert.ok(paths.includes(e), `${c.id}: entry point ${e}`);
    for (const m of manifest) assert.ok(within(m, c.scope), `${c.id}: manifest ${m} in scope`);
    const tests = paths.filter((p) => within(p, c.newSystem.tests));
    assert.ok(tests.length > 0 && tests.every((p) => matchesPattern(repoPath(p), repoPattern(c.loadGlob))), `${c.id}: the load glob takes its tests`);
    const leaf = c.testId.split(' > ').at(-1)!;
    assert.ok(tests.some((p) => c.reference[p]!.includes(`'${leaf}'`)), `${c.id}: a test named ${leaf}`);
    for (const text of [...c.acceptance, ...Object.values(c.reference)]) assert.doesNotMatch(text, words, c.id);
  }
});

// ---------------------------------------------------------------------------------------------------
// The summary

function row(cell: ScaffoldCell, trial: number, verdict: ScaffoldRow['verdict'], extra: Partial<ScaffoldRow> = {}): ScaffoldRow {
  return {
    set: 'dev', cell: cell.id, family: cell.family, trial, writer: 'real', void: null, verdict, outcomes: [], refusals: [], files: verdict === 'defect' ? [] : ['a', 'b'],
    linesAdded: verdict === 'defect' ? null : 10, usage: null, estimatedUsd: 0.05, wallMs: 30_000, turns: 8, load: 1000, calls: verdict === 'first' ? 1 : 2, models: ['claude-haiku-5-5'],
    method: { available: [], tools: {}, shellCalls: 2, subagents: [], denials: 0, unavailable: [] }, dir: '/x', ...extra,
  };
}
const crit = (s: ScaffoldSummary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;
const runOf = (trial: number, verdict: (c: ScaffoldCell, i: number) => ScaffoldRow['verdict']) => DEV_SCAFFOLD_CELLS.map((c, i) => row(c, trial, verdict(c, i)));

test('roles.scaffold-summary: each run lands 3/4 or better, half first-try, voids at most a quarter, holdout gap; refusals classified by code\'s reasons', () => {
  const good = summariseScaffold('dev', [0, 1, 2].flatMap((t) => runOf(t, () => 'first')), null, 'arm');
  for (const c of good.criteria) assert.equal(c.pass, true, `${c.name}: ${c.detail}`);
  assert.deepEqual(good.runs.map((r) => [r.landed, r.cells]), [[4, 4], [4, 4], [4, 4]]);

  // One defect in a run passes (3/4); two fail; one bad run of three fails.
  assert.equal(crit(summariseScaffold('dev', runOf(0, (_, i) => (i === 0 ? 'defect' : 'first'))), 'landed'), true);
  assert.equal(crit(summariseScaffold('dev', runOf(0, (_, i) => (i < 2 ? 'defect' : 'first'))), 'landed'), false);
  assert.equal(crit(summariseScaffold('dev', [...runOf(0, () => 'first'), ...runOf(1, (_, i) => (i < 2 ? 'defect' : 'first'))]), 'landed'), false);
  // Retries land, but under half first-try fails.
  const retries = summariseScaffold('dev', runOf(0, (_, i) => (i < 3 ? 'retry' : 'first')));
  assert.deepEqual([crit(retries, 'landed'), crit(retries, 'first-try')], [true, false]);
  // A void neither lands nor grades; over a quarter fails.
  const voided = summariseScaffold('dev', runOf(0, (_, i) => (i < 2 ? null : 'first')).map((r) => (r.verdict === null ? { ...r, void: { reason: 'error' as const, detail: 'x' } } : r)));
  assert.deepEqual([crit(voided, 'landed'), crit(voided, 'voids'), crit(voided, 'first-try')], [false, false, true]);
  // The holdout's landed rate within 15 points of dev's.
  const holdout = DEV_SCAFFOLD_CELLS.map((c, i) => row({ ...c, id: `H${i}` }, 0, i < 2 ? 'first' : 'defect'));
  assert.equal(crit(summariseScaffold('holdout', holdout, good, 'arm'), 'holdout-gap'), false, '2/4 against 12/12');

  // The reasons src/pipeline/scaffold.ts gives, by kind.
  assert.equal(refusalKind('the scaffold writer wrote nothing'), 'nothing');
  assert.equal(refusalKind('it wrote notes/x.md, outside billing\'s paths and test paths and the manifest files'), 'outside');
  assert.equal(refusalKind('entry point src/billing/index.js does not exist'), 'entry-point');
  assert.equal(refusalKind('the load test\'s lane load did not exit 0 as declared (fail)'), 'lane-exit');
  assert.equal(refusalKind('the lane\'s reporter does not show the load test "t" ran'), 'not-ran');
  assert.equal(refusalKind('the scaffold writer\'s report does not match its schema'), 'schema');
});

// ---------------------------------------------------------------------------------------------------
// The harness end to end on degenerate writers

async function fakeRun(writer: string, cells: readonly string[], caps: Readonly<{ n?: number; cap?: number; trialCap?: number; parallel?: number }> = {}) {
  const out = join(tmpDir('scaffold-out'), 'run');
  const lines: string[] = [];
  const summary = await runScaffold({
    set: 'dev', n: caps.n ?? 1, cells, parallel: caps.parallel ?? 2, config: null, out, compare: null, writer: writer as never, cap: caps.cap ?? null, trialCap: caps.trialCap ?? null,
  }, (l) => lines.push(l));
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as ScaffoldRow);
  return { summary, rows, out, lines };
}

test('roles.scaffold-fakes: an oracle writer lands every cell first-try through the production scaffold stage; fix-on-retry lands on the retry, told why; outside and nothing park plan-defect and fail', T, async () => {
  const good = await fakeRun('oracle', DEV_SCAFFOLD_CELLS.map((c) => c.id));
  assert.ok(good.lines.includes('ARM scaffold.med economy claude-haiku-5-5:high'), good.lines.join('\n'));
  for (const c of good.summary.criteria) assert.notEqual(c.pass, false, `${c.name}: ${c.detail}`);
  assert.equal(good.rows.length, 4);
  for (const r of good.rows) {
    const cell = DEV_SCAFFOLD_CELLS.find((c) => c.id === r.cell)!;
    assert.equal(r.void, null, `${r.cell}: ${JSON.stringify(r.void)}`);
    assert.equal(r.verdict, 'first', r.cell);
    assert.deepEqual([...r.files].sort(), Object.keys(cell.reference).sort(), `${r.cell}: the committed skeleton`);
    for (const file of ['key.json', 'prompt-1.txt', 'argv.json', 'scaffold-1.jsonl', 'transcript.jsonl', 'answer.json', 'skeleton.diff', 'row.json']) assert.ok(existsSync(join(r.dir, file)), `${r.cell}: ${file}`);
    const prompt = readFileSync(join(r.dir, 'prompt-1.txt'), 'utf8');
    assert.ok(!prompt.includes(good.out) && !prompt.includes('key.json'), 'the prompt never names the run dir or the key');
    for (const e of cell.entryPoints) assert.ok(prompt.includes(e), `${r.cell}: entry point ${e} in the prompt`);
  }

  const retry = await fakeRun('fix-on-retry', ['module']);
  assert.deepEqual([retry.rows[0]!.verdict, retry.rows[0]!.calls], ['retry', 2]);
  assert.deepEqual(retry.rows[0]!.refusals.flat().map(refusalKind), ['not-ran']);
  assert.match(readFileSync(join(retry.rows[0]!.dir, 'prompt-2.txt'), 'utf8'), /<previous_attempt>/);
  assert.equal(crit(retry.summary, 'first-try'), false);

  const outside = await fakeRun('outside', ['module']);
  assert.equal(outside.rows[0]!.verdict, 'defect');
  assert.deepEqual(outside.rows[0]!.refusals.flat().map(refusalKind), ['outside', 'outside']);
  assert.ok(outside.rows[0]!.outcomes.includes('scaffold:plan-defect'), outside.rows[0]!.outcomes.join());
  assert.equal(crit(outside.summary, 'landed'), false);
  const nothing = await fakeRun('nothing', ['module']);
  assert.deepEqual([nothing.rows[0]!.verdict, nothing.rows[0]!.refusals.flat().map(refusalKind)], ['defect', ['nothing', 'nothing']]);
});

test('roles.scaffold-caps: --trial-cap kills an overspending writer (void cap, its estimate kept); --cap starts no trial past the spend', T, async () => {
  const over = await fakeRun('overspend', ['module'], { trialCap: 1 });
  assert.equal(over.rows[0]!.void?.reason, 'cap', JSON.stringify(over.rows[0]!.void));
  assert.ok(over.rows[0]!.estimatedUsd >= 20);
  assert.ok(over.lines.some((l) => l.startsWith('BRAKE module#0 cap')));
  const capped = await fakeRun('oracle', ['module'], { n: 3, cap: 0.01, parallel: 2 });
  assert.equal(capped.rows.length, 2, 'two ran in parallel before the cap was reached');
  assert.deepEqual(capped.summary.capped, { capUsd: 0.01, notStarted: 1 });
});

test('roles.scaffold-seat: the arm is the scaffold seat (economy, Haiku 5.5 high); --rebind moves it through the repo config; a seat with no scaffold prompt is refused', () => {
  assert.equal(scaffoldSeat(null).arm, 'scaffold.med economy claude-haiku-5-5:high');
  assert.equal(scaffoldSeat(rebindConfig(['economy=claude-haiku-5-5:medium'])).arm, 'scaffold.med economy (rebound) claude-haiku-5-5:medium');
  assert.throws(() => scaffoldSeat(rebindConfig(['economy=claude-opus-5-5:high'])), /scaffold/);
  assert.throws(() => scaffoldSeat(rebindConfig(['economy=gpt-5.6-sol:high'])), /Claude only|scaffold|economy/);
});

test('roles.scaffold-triggers: the scaffold prompt, stage and eval trigger the scaffold eval alone; the shared harness and routing every role', () => {
  for (const p of ['src/prompts/scaffold/claude-haiku-5-5.ts', 'src/pipeline/scaffold.ts', 'evals/roles/scaffold/arc.ts']) assert.deepEqual(triggeredRoles([p]), ['scaffold'], p);
  assert.deepEqual(triggeredRoles(['src/prompts/schemas.ts']), ['gate', 'walkthrough', 'polishJudge', 'verifier', 'scaffold']);
});
