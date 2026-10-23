// The gate role eval's harness and graders (evals/roles/): end to end through run.ts on degenerate fake gates (real
// processes, real git, real lanes), the graders on a gate that cites the plant without reading it, the stream-json
// transcript and cost parser on a captured subagent run, the fake backend's `real` and `checkoutTree` acts, and the
// triggers. Named tests: roles.approve-all, roles.revise-all, roles.cite-every-path, roles.lucky, roles.transcript-cost,
// roles.real-act, roles.checkout-tree-act, roles.triggers, roles.arm, roles.worker-error, roles.wilson, roles.regenerate-check; the spend caps
// and the large-diff gate's grading (1.0.0-dev.12): roles.cap, roles.trial-cap, roles.live-cost, roles.clusters.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DiffShown } from '../src/core/events.ts';
import { repoPath, repoPattern } from '../src/core/values.ts';
import type { GateOutput } from '../src/prompts/schemas.ts';
import { type GateKind, type TrialRow, gateArm } from '../evals/roles/gate/arc.ts';
import type { AnswerKey } from '../evals/roles/gate/fixture.ts';
import { grade, gradeClusters } from '../evals/roles/gate/grade.ts';
import { type Summary, reportLines, summarise } from '../evals/roles/gate/summary.ts';
import { runWorker } from '../evals/roles/pool.ts';
import { rebindConfig, run } from '../evals/roles/run.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { wilson } from '../evals/roles/stats.ts';
import { PRICES, parseEvents, readTranscript, unavailableCalls, usageOf } from '../evals/roles/transcript.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';
import { readCalls, writeScenario } from './helpers/scenario.ts';

const T = { timeout: 300_000 };
const SUBAGENT_STREAM = fileURLToPath(new URL('./fixtures/roles/subagent-stream.jsonl', import.meta.url));

type Caps = Readonly<{ n?: number; cap?: number; trialCap?: number }>;

async function fakeRun(gate: GateKind, cells: readonly string[], caps: Caps = {}): Promise<Readonly<{ summary: Summary; rows: readonly TrialRow[]; out: string; lines: readonly string[] }>> {
  const out = join(tmpDir('roles-out'), 'run');
  const lines: string[] = [];
  const summary = await run({
    set: 'dev', n: caps.n ?? 1, cells, parallel: 1, size: 150, seed: 'harness', risk: 'med', config: null, out, compare: null, gate, cap: caps.cap ?? null, trialCap: caps.trialCap ?? null, readOnly: false, baseline: null,
  }, (l) => lines.push(l));
  assert.ok(lines.includes('ARM gate.med frontier claude-opus-5-5:medium'), 'the report names the arm: the med seat, Opus 5.5 medium (dev.17)');
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TrialRow);
  assert.ok(lines.some((l) => l.startsWith('PASS ') || l.startsWith('FAIL ')), lines.join('\n'));
  return { summary, rows, out, lines };
}

const criterion = (s: Summary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;

test('roles.risk-arms: a trial runs at every risk tier, its scripted build on the backend that tier\'s build seat routes to (codex low/med, Claude high)', T, async () => {
  for (const risk of ['low', 'med', 'high'] as const) {
    const out = join(tmpDir('roles-out'), `run-${risk}`);
    await run({ set: 'dev', n: 1, cells: ['G1'], parallel: 1, size: 150, seed: 'harness', risk, config: null, out, compare: null, gate: 'approve-all', cap: null, trialCap: null, readOnly: false, baseline: null }, () => {});
    const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TrialRow);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.void, null, `${risk}: ${JSON.stringify(rows[0]!.void)}`);
    assert.equal(rows[0]!.outcome, 'approve', risk);
  }
});

test('roles.approve-all: an approve-everything gate catches nothing and passes the clean cell; the trial runs real lanes and keeps the key out of the arc', T, async () => {
  const { summary, rows, out } = await fakeRun('approve-all', ['G1', 'G3a', 'G6']);
  assert.equal(summary.detection.k, 0);
  assert.equal(summary.detection.n, 2);
  assert.equal(criterion(summary, 'planted-detection'), false);
  assert.equal(criterion(summary, 'clean-fp'), true);
  for (const r of rows) {
    assert.equal(r.void, null, JSON.stringify(r.void));
    assert.ok(r.stages.includes('lanes:green'), `${r.cell}: ${r.stages.join(' ')}`);
    assert.equal(r.outcome, 'approve');
    for (const f of ['key.json', 'prompt.txt', 'answer.json', 'transcript.jsonl', 'row.json', 'gate-1.jsonl']) assert.ok(existsSync(join(r.dir, f)), `${r.cell}: ${f}`);
    const prompt = readFileSync(join(r.dir, 'prompt.txt'), 'utf8');
    assert.ok(prompt.length > 0 && !prompt.includes(out), 'the gate prompt never names the eval run dir');
    const key = JSON.parse(readFileSync(join(r.dir, 'key.json'), 'utf8')) as AnswerKey;
    if (key.plant !== null) assert.equal(r.graded?.verdict, 'missed');
    // Over the large-diff threshold the fake answers one cluster over everything, which code accepted and the grade sees whole.
    if (r.largeDiff) assert.ok(r.clusters !== null && r.clusters.uncovered === 0 && r.clusters.duplicated === 0 && r.clusters.depth.routine === r.clusters.files, JSON.stringify(r.clusters));
    else assert.equal(r.clusters, null);
  }
  assert.ok(rows.some((r) => r.largeDiff), 'the omitted-placement cell is over the threshold');
  assert.ok(existsSync(join(out, 'summary.json')));
});

test('roles.revise-all: a revise-everything gate has 100% false positives and fails precision', T, async () => {
  const { summary } = await fakeRun('revise-all', ['G1', 'G3a']);
  assert.equal(criterion(summary, 'clean-fp'), false);
  assert.equal(summary.falsePositives.rate, 1);
  assert.equal(criterion(summary, 'planted-detection'), false);
  assert.equal(criterion(summary, 'precision'), false);
});

test('roles.cite-every-path: citing every changed path catches the plant and fails precision', T, async () => {
  const { summary, rows } = await fakeRun('cite-every-path', ['G3a']);
  assert.equal(rows[0]!.graded?.verdict, 'caught');
  assert.ok(rows[0]!.graded!.spurious > 10);
  assert.equal(criterion(summary, 'planted-detection'), true);
  assert.equal(criterion(summary, 'precision'), false);
});

test('roles.regenerate-check: the hand-edited golden (G4) is caught by the regenerate check before any gate; its clean twin reaches the gate told the goldens were verified', T, async () => {
  const { summary, rows } = await fakeRun('approve-all', ['G4', 'G4c']);
  const g4 = rows.find((r) => r.cell === 'G4')!;
  assert.equal(g4.caught, 'regenerate', g4.stages.join(' '));
  assert.deepEqual([g4.void, g4.graded, g4.calls], [null, null, 0]);
  assert.ok(g4.stages.includes('lanes:red'));
  assert.equal(summary.cells.find((c) => c.cell === 'G4')!.regenerate, 1);
  const g4c = rows.find((r) => r.cell === 'G4c')!;
  assert.equal(g4c.void, null, JSON.stringify(g4c.void));
  assert.equal(g4c.caught, null);
  assert.ok(g4c.stages.includes('lanes:green'), g4c.stages.join(' '));
  assert.match(readFileSync(join(g4c.dir, 'prompt.txt'), 'utf8'), /- goldens\/\*\*: verified by regeneration\. The executor ran \["node","tools\/gen-goldens\.ts"\]/);
});

// ---------------------------------------------------------------------------------------------------
// Graders on synthetic sessions

const KEY: AnswerKey = {
  cell: 'G3b', trial: 0, seed: 's', size: 3000, removes: [],
  plant: { kind: 'logic', path: 'packages/fern/src/early-index.ts', form: 'swap-operator', needle: 'return fernEarlyIndexTotalAcc - b * 59;', deletion: false, intended: 'omitted', predicted: 'omitted' },
  changed: ['packages/fern/src/early-index.ts', 'packages/fern/src/late-gate.ts', 'packages/oak/src/rough-edge.ts'],
};
const PROMPT = 'diff --git a/packages/oak/src/rough-edge.ts b/packages/oak/src/rough-edge.ts\n+x\n<not_inlined>\npackages/fern/src/early-index.ts\npackages/fern/src/late-gate.ts\n</not_inlined>\n';
const SHOWN: DiffShown = { inlined: [repoPath('packages/oak/src/rough-edge.ts')], notInlined: [repoPath('packages/fern/src/early-index.ts'), repoPath('packages/fern/src/late-gate.ts')] };
const CITE: GateOutput = {
  decision: 'revise', findings: [{ severity: 'blocking', path: KEY.plant!.path, text: 'operator flipped', contractRef: null, experiments: [], debt: null, defect: 'incorrect-behaviour', reraises: null, hunk: null }],
  directives: ['Restore it.'], reasons: [], premises: [], unreviewed: [], clusters: null, rulings: [],
};

const tool = (id: string, name: string, input: Record<string, unknown>, result: string, parent: string | null = null): readonly Record<string, unknown>[] => [
  { type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } },
];

test('roles.lucky: citing a not-inlined plant without reading it is lucky; a Read of its diff file (main or subagent), a Grep that showed it, or a Bash command naming it or showing it is a look', () => {
  const none = readTranscript([]);
  const lucky = grade(KEY, SHOWN, PROMPT, none, CITE);
  assert.equal(lucky.verdict, 'lucky');
  assert.equal(lucky.placement, 'omitted');
  assert.deepEqual(lucky.coverage, { omitted: 2, covered: 0, share: 0 });
  const viaSubagent = readTranscript([
    ...tool('a1', 'Agent', { subagent_type: 'reader', prompt: 'read it' }, 'done'),
    ...tool('r1', 'Read', { file_path: `/run/attach/files/${KEY.plant!.path}.diff` }, `+    ${KEY.plant!.needle}`, 'a1'),
  ]);
  const caught = grade(KEY, SHOWN, PROMPT, viaSubagent, CITE);
  assert.equal(caught.verdict, 'caught');
  assert.deepEqual(caught.coverage, { omitted: 2, covered: 1, share: 0.5 });
  const viaGrep = readTranscript(tool('g1', 'Grep', { pattern: 'Acc - b' }, `/wt/${KEY.plant!.path}:9:  ${KEY.plant!.needle}`));
  assert.equal(grade(KEY, SHOWN, PROMPT, viaGrep, CITE).verdict, 'caught');
  const blind = grade(KEY, SHOWN, PROMPT, readTranscript(tool('g2', 'Grep', { pattern: 'nothing' }, 'No matches found')), CITE);
  assert.equal(blind.verdict, 'lucky');
  // dev.13: the gate has a shell. A Bash command naming the file is a look and covers it; output showing the plant is a look.
  const viaCat = grade(KEY, SHOWN, PROMPT, readTranscript(tool('b1', 'Bash', { command: `git show HEAD:${KEY.plant!.path}` }, 'ok')), CITE);
  assert.equal(viaCat.verdict, 'caught');
  assert.deepEqual(viaCat.coverage, { omitted: 2, covered: 1, share: 0.5 });
  const viaOutput = readTranscript(tool('b2', 'Bash', { command: 'git diff HEAD~1 -- packages/fern' }, `+    ${KEY.plant!.needle}`));
  assert.equal(grade(KEY, SHOWN, PROMPT, viaOutput, CITE).verdict, 'caught');
  assert.equal(grade(KEY, SHOWN, PROMPT, readTranscript(tool('b3', 'Bash', { command: 'ls' }, 'packages')), CITE).verdict, 'lucky');

  const row = (verdict: ReturnType<typeof grade>): TrialRow => ({
    set: 'dev', cell: 'G3b', family: 'G3', trial: 0, planted: true, gate: 'cite-plant', outcome: 'revise', caught: null, decision: 'revise', void: null, graded: verdict,
    readOnly: false, experiments: 0, largeDiff: false, clusters: null, usage: null, estimatedUsd: 0, wallMs: 1000, turns: 1, load: 0, calls: 1, models: [], method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: '/x',
  });
  const s = summarise('dev', [row(lucky), row(caught)]);
  assert.equal(s.criteria.find((c) => c.name === 'zero-lucky')!.pass, false);
  assert.equal(s.detection.k, 1, 'a lucky catch is not a detection');
});

test('roles.unreviewed: the gate\'s claimed unreviewed parts beside what it really looked at; silent = not-inlined files neither read nor declared', () => {
  const none = readTranscript([]);
  assert.deepEqual(grade(KEY, SHOWN, PROMPT, none, CITE).unreviewed, { claimed: 0, declared: 0, silent: 2 }, 'claimed full coverage, read nothing');
  const declared = grade(KEY, SHOWN, PROMPT, none, { ...CITE, unreviewed: [{ path: 'packages/fern/src/late-*.ts', reason: 'mechanical rename' }] });
  assert.deepEqual(declared.unreviewed, { claimed: 1, declared: 1, silent: 1 });
  const byDir = grade(KEY, SHOWN, PROMPT, none, { ...CITE, unreviewed: [{ path: 'packages/fern/', reason: 'not read' }] });
  assert.deepEqual(byDir.unreviewed, { claimed: 1, declared: 2, silent: 0 });
  const read = readTranscript(tool('r1', 'Read', { file_path: `/run/attach/files/${KEY.plant!.path}.diff` }, 'x'));
  assert.deepEqual(grade(KEY, SHOWN, PROMPT, read, { ...CITE, unreviewed: null }).unreviewed, { claimed: null, declared: 0, silent: 1 }, 'a dev.11 answer: unknown claim');
});

test('roles.transcript-cost: a captured subagent run: subagent calls by parent_tool_use_id, per-model cost from modelUsage summing to total_cost_usd', () => {
  const events = parseEvents(readFileSync(SUBAGENT_STREAM, 'utf8'));
  const t = readTranscript(events);
  assert.equal(t.subagents.length, 1);
  assert.equal(t.subagents[0]!.model, 'claude-haiku-5-5');
  const reads = t.calls.filter((c) => c.name === 'Read');
  assert.equal(reads.length, 3);
  assert.ok(reads.every((c) => c.parent === t.subagents[0]!.id && c.result !== null));
  assert.deepEqual(unavailableCalls(t), [], 'Agent is listed');
  const u = t.usage!;
  assert.deepEqual(Object.keys(u.byModel).sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(u.check, 'ok');
  assert.ok(Math.abs(u.totalUsd - 0.07086208999999999) < 1e-12);
  const result = events.findLast((e) => e['type'] === 'result')!;
  const topLevel = (result['usage'] as { output_tokens: number }).output_tokens;
  assert.ok(u.byModel['claude-haiku-5-5']!.outputTokens + u.byModel['claude-sonnet-5-5']!.outputTokens > topLevel, 'the top-level usage excludes the subagent');
  assert.equal(usageOf({ ...result, total_cost_usd: 0.5 })!.check, 'mismatch');
});

test('roles.arm: --risk picks the built-in gate seat (Opus at every tier since dev.17); --rebind rebinds a class through the repo config, which the trial arc routes under; a bad rebind is refused', () => {
  assert.equal(gateArm('low', null), 'gate.low frontier claude-opus-5-5:medium');
  assert.equal(gateArm('med', null), 'gate.med frontier claude-opus-5-5:medium');
  assert.equal(gateArm('high', null), 'gate.high frontier claude-opus-5-5:medium');
  const config = rebindConfig(['frontier=claude-sonnet-5-5:high']);
  assert.deepEqual(config, { routing: { classes: { frontier: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } } } });
  assert.equal(gateArm('low', config), 'gate.low frontier (rebound) claude-sonnet-5-5:high');
  assert.equal(gateArm('low', rebindConfig(['efficient=claude-opus-5-5:high'])), 'gate.low frontier claude-opus-5-5:medium', 'a rebind moves only its class');
  // economy (Haiku 5.5) is named by no built-in seat since the 2026-10-17 gate eval; a rebind of it is still accepted,
  // and moves no built-in gate seat.
  const economy = rebindConfig(['economy=claude-haiku-5-5:medium']);
  assert.deepEqual(economy, { routing: { classes: { economy: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'medium' } } } });
  assert.equal(gateArm('low', economy), 'gate.low frontier claude-opus-5-5:medium');
  assert.equal(rebindConfig([]), null);
  assert.throws(() => rebindConfig(['economy=claude-opus-5-5']), /<class>=<model>:<effort>/);
  assert.throws(() => rebindConfig(['economy=claude-opus-9:high']), /model one of/);
  assert.throws(() => rebindConfig(['cheap=claude-opus-5-5:high']), /cheap/);
  assert.throws(() => rebindConfig(['economy=claude-haiku-5-5:huge']), /effort/);
  assert.throws(() => rebindConfig(['economy=claude-opus-5-5:high', 'economy=claude-haiku-5-5:low']), /rebound twice/);
  assert.throws(() => gateArm('low', rebindConfig(['frontier=gpt-5.6-luna:low'])), /no prompt for gate on gpt-5.6-luna/);
  // The trial arc (test/fixtures/unit-common.ts contextFor) resolves its routing under the descriptor's config.
  const d = setupArc({ steps: [] });
  const r = contextFor({ ...d, config: config! });
  try {
    assert.deepEqual(r.ctx.routing(null).table.gate.low, { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    assert.deepEqual(r.ctx.routingBase.config, config);
  } finally {
    r.journal.close();
  }
});

test('roles.cap: --cap starts no trial once the finished trials\' spend reaches it; the rest are counted, never run', T, async () => {
  const { summary, rows, lines } = await fakeRun('approve-all', ['G1'], { n: 3, cap: 0.000001 });
  assert.equal(rows.length, 1, 'the first trial ran; its spend (the fake\'s reported cost) reached the cap');
  assert.ok((rows[0]!.usage?.totalUsd ?? 0) > 0);
  assert.deepEqual(summary.capped, { capUsd: 0.000001, notStarted: 2 });
  assert.ok(lines.some((l) => /^CAP spend \$\d+\.\d+ reached --cap \$0\.00: 2 trials not started$/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('INFO cap $0.00: 2 trials not started'));
});

test('roles.trial-cap: a session whose live spend passes --trial-cap is killed and its trial void as cap, its estimate kept as its spend', T, async () => {
  const { rows, lines } = await fakeRun('overspend', ['G1'], { trialCap: 1 });
  const [r] = rows;
  assert.equal(r!.void?.reason, 'cap', JSON.stringify(r!.void));
  assert.match(r!.void!.detail, /^cap: live spend \$20\.00 over the trial cap \$1\.00$/);
  assert.equal(r!.usage, null, 'killed before any result');
  assert.ok(Math.abs(r!.estimatedUsd - 20.00004) < 1e-6, `${r!.estimatedUsd}`);
  assert.ok(lines.some((l) => l.startsWith('BRAKE G1#0 cap:')), lines.join('\n'));
  assert.ok(lines.some((l) => /^TRIAL G1#0 void:cap .* cost=\$20\.000 /.test(l)), lines.join('\n'));
});

test('roles.live-cost: a running session\'s spend from its messages\' tokens at list price, main and subagents, each message counted once at its latest usage', () => {
  const msg = (id: string, model: string, usage: Record<string, number>, parent: string | null = null): Record<string, unknown> =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, content: [], usage } });
  const t = readTranscript([
    msg('m1', 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 10 }),
    msg('m1', 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }),
    msg('s1', 'claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, 'a1'),
    msg('x1', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
  ]);
  const opus = PRICES['claude-opus-5-5']!;
  const haiku = PRICES['claude-haiku-5-5']!;
  assert.ok(Math.abs(t.liveUsd - (opus.input + 0.1 * opus.output + haiku.cacheRead + haiku.cacheWrite)) < 1e-9, `${t.liveUsd}`);
  assert.throws(() => readTranscript([msg('m2', 'claude-opus-9', { input_tokens: 1 })]), /no list price for model claude-opus-9/);
  assert.equal(readTranscript(parseEvents(readFileSync(SUBAGENT_STREAM, 'utf8'))).liveUsd > 0, true, 'the captured subagent run prices');
});

test('roles.clusters: a cluster map graded against the diff\'s paths (uncovered, doubly covered, files per review depth) and summed per cell', () => {
  const paths = ['packages/a/x.ts', 'packages/a/y.ts', 'packages/b/z.ts', 'README.md'].map((p) => repoPath(p));
  const map = (clusters: GateOutput['clusters']): GateOutput => ({ ...CITE, clusters });
  assert.equal(gradeClusters(CITE, paths), null, 'no map, no grade');
  const whole = gradeClusters(map([{ id: 'a', paths: [repoPattern('packages/a/')], review: 'description' }, { id: 'rest', paths: [repoPattern('packages/b/*.ts'), repoPattern('README.md')], review: 'close' }]), paths)!;
  assert.deepEqual(whole, { files: 4, uncovered: 0, duplicated: 0, depth: { description: 2, routine: 0, close: 2 } });
  const gappy = gradeClusters(map([{ id: 'all', paths: [repoPattern('packages/**')], review: 'routine' }, { id: 'a', paths: [repoPattern('packages/a/x.ts')], review: 'close' }]), paths)!;
  assert.deepEqual(gappy, { files: 4, uncovered: 1, duplicated: 1, depth: { description: 0, routine: 3, close: 0 } });
  const row = (clusters: TrialRow['clusters'], largeDiff: boolean): TrialRow => ({
    set: 'dev', cell: 'G3b', family: 'G3', trial: 0, planted: false, gate: 'real', outcome: 'approve', caught: null, decision: 'approve', void: null, graded: null,
    readOnly: false, experiments: 0, largeDiff, clusters, usage: null, estimatedUsd: 0, wallMs: 1000, turns: 1, load: 0, calls: 1, models: [],
    method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: '/x',
  });
  const s = summarise('dev', [row(whole, true), row(gappy, true), row(null, true), row(null, false)]);
  assert.deepEqual(s.cells[0]!.clusters, { required: 3, mapped: 2, complete: 1 });
  assert.deepEqual(s.cells[0]!.reviewMix, { description: 2, routine: 3, close: 2 });
  assert.ok(reportLines(s).some((l) => l.startsWith('CELL G3b ') && l.endsWith(' clusters=1/3 mapped=2 mix=description:2,routine:3,close:2 experiments=0')), reportLines(s).join('\n'));
});

test('roles.worker-error: a worker that throws voids with its error\'s message, not only the stack frames Node prints last', T, async () => {
  const died = await runWorker({
    role: 'gate', set: 'dev', cell: 'NOPE', trial: 0, seed: 'harness', size: 150, gate: 'approve-all', risk: 'med', config: null,
    out: join(tmpDir('roles-out'), 'w'), medianLoad: null, trialCap: null, readOnly: false,
  }, () => {});
  assert.ok(died !== null && died.endsWith('trial error: no cell NOPE in the dev set'), String(died));
});

test('roles.wilson: Wilson intervals', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.low! - 0.4902) < 1e-3 && Math.abs(w.high! - 0.9433) < 1e-3, JSON.stringify(w));
  assert.equal(wilson(0, 0).rate, null);
});

// ---------------------------------------------------------------------------------------------------
// The fake backend's acts

test('roles.real-act: the real act runs the next claude on PATH with the call\'s argv, stdin, cwd and env, passing stdout and the exit status through', () => {
  const scenario = writeScenario(tmpDir('roles-real'), [{ as: 'claude', expect: {}, acts: [{ type: 'real' }] }]);
  const stub = tmpDir('roles-stub');
  const record = join(stub, 'record.json');
  writeFileSync(join(stub, 'claude'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, 'utf8'), probe: process.env.ROLES_PROBE }));\nprocess.stdout.write('{"type":"result"}\\n');\nprocess.exit(3);\n`, { mode: 0o755 });
  const cwd = tmpDir('roles-cwd');
  const r = spawnSync(join(scenario.binDir, 'claude'), ['-p', '--model', 'm', '--add-dir', '/a b'], {
    cwd, input: 'the prompt\n', encoding: 'utf8', env: { ...process.env, PATH: `${scenario.binDir}:${stub}:${process.env['PATH']}`, ROLES_PROBE: 'kept' },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, '{"type":"result"}\n');
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { argv: ['-p', '--model', 'm', '--add-dir', '/a b'], cwd, stdin: 'the prompt\n', probe: 'kept' });
  assert.equal(readCalls(scenario.path)[0]!.step, 0);
});

test('roles.checkout-tree-act: checkoutTree commits exactly the given commit\'s tree, deletions included, with the message', () => {
  const repo = makeRepo(tmpDir('roles-tree'), { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  git(repo, 'checkout', '--quiet', '-b', 'target');
  git(repo, 'rm', '--quiet', 'a.txt');
  writeFileSync(join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', 'c.txt');
  git(repo, 'commit', '--quiet', '-m', 'target');
  const target = git(repo, 'rev-parse', 'target');
  git(repo, 'checkout', '--quiet', 'main');
  const scenario = writeScenario(tmpDir('roles-tree-sc'), [{ as: 'codex', expect: {}, acts: [{ type: 'checkoutTree', sha: target, message: 'the unit\n' }] }]);
  const r = spawnSync(join(scenario.binDir, 'codex'), ['exec'], { cwd: repo, input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), git(repo, 'rev-parse', 'target^{tree}'));
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'the unit');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(repo, 'a.txt')), false);
});

test('roles.triggers: gate paths trigger the gate eval; shared paths (routing) the walkthrough and polish-judge evals too; unrelated paths none', () => {
  assert.deepEqual(triggeredRoles(['src/prompts/gate/claude-opus-5-5.ts']), ['gate']);
  assert.deepEqual(triggeredRoles(['src/git/boundeddiff.ts', 'README.md']), ['gate']);
  assert.deepEqual(triggeredRoles(['src/routing/classes.ts']), ['gate', 'walkthrough', 'polishJudge']);
  assert.deepEqual(triggeredRoles(['src/holistic/audit.ts', 'test/gate.test.ts']), []);
});
