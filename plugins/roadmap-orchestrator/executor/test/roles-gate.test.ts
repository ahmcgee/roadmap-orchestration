// The gate role eval's harness and graders (evals/roles/): end to end through run.ts on degenerate fake gates (real
// processes, real git, real lanes), the graders on a gate that cites the plant without reading it, the stream-json
// transcript and cost parser on a captured subagent run, the fake backend's `real` and `checkoutTree` acts, and the
// triggers. Named tests: roles.approve-all, roles.revise-all, roles.cite-every-path, roles.lucky, roles.transcript-cost,
// roles.real-act, roles.checkout-tree-act, roles.triggers, roles.arm, roles.wilson, roles.regenerate-check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DiffShown } from '../src/core/events.ts';
import { repoPath } from '../src/core/values.ts';
import type { GateOutput } from '../src/prompts/schemas.ts';
import { type GateKind, type TrialRow, gateArm } from '../evals/roles/gate/arc.ts';
import type { AnswerKey } from '../evals/roles/gate/fixture.ts';
import { grade } from '../evals/roles/gate/grade.ts';
import { type Summary, summarise } from '../evals/roles/gate/summary.ts';
import { rebindConfig, run } from '../evals/roles/run.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { wilson } from '../evals/roles/stats.ts';
import { parseEvents, readTranscript, unavailableCalls, usageOf } from '../evals/roles/transcript.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';
import { readCalls, writeScenario } from './helpers/scenario.ts';

const T = { timeout: 300_000 };
const SUBAGENT_STREAM = fileURLToPath(new URL('./fixtures/roles/subagent-stream.jsonl', import.meta.url));

async function fakeRun(gate: GateKind, cells: readonly string[]): Promise<Readonly<{ summary: Summary; rows: readonly TrialRow[]; out: string }>> {
  const out = join(tmpDir('roles-out'), 'run');
  const lines: string[] = [];
  const summary = await run({ set: 'dev', n: 1, cells, parallel: 1, size: 150, seed: 'harness', risk: 'med', config: null, out, compare: null, gate }, (l) => lines.push(l));
  assert.ok(lines.includes('ARM gate.med efficient claude-sonnet-5-5:high'), 'the report names the arm: the med seat, Sonnet 5.5 high');
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TrialRow);
  assert.ok(lines.some((l) => l.startsWith('PASS ') || l.startsWith('FAIL ')), lines.join('\n'));
  return { summary, rows, out };
}

const criterion = (s: Summary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;

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
  }
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
const CITE: GateOutput = { decision: 'revise', findings: [{ severity: 'blocking', path: KEY.plant!.path, text: 'operator flipped', contractRef: null }], directives: ['Restore it.'], reasons: [], premises: [], unreviewed: [] };

const tool = (id: string, name: string, input: Record<string, unknown>, result: string, parent: string | null = null): readonly Record<string, unknown>[] => [
  { type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } },
];

test('roles.lucky: citing a not-inlined plant without reading it is lucky; a Read of its diff file (main or subagent) or a Grep that showed it is a look', () => {
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

  const row = (verdict: ReturnType<typeof grade>): TrialRow => ({
    set: 'dev', cell: 'G3b', family: 'G3', trial: 0, planted: true, gate: 'cite-plant', outcome: 'revise', caught: null, decision: 'revise', void: null, graded: verdict, usage: null,
    wallMs: 1000, turns: 1, load: 0, calls: 1, models: [], method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: '/x',
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

test('roles.arm: --risk picks the built-in gate seat (Haiku, Sonnet, Opus); --rebind rebinds a class through the repo config, which the trial arc routes under; a bad rebind is refused', () => {
  assert.equal(gateArm('low', null), 'gate.low economy claude-haiku-5-5:high');
  assert.equal(gateArm('med', null), 'gate.med efficient claude-sonnet-5-5:high');
  assert.equal(gateArm('high', null), 'gate.high frontier claude-opus-5-5:medium');
  const config = rebindConfig(['economy=claude-opus-5-5:medium']);
  assert.deepEqual(config, { routing: { classes: { economy: { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' } } } });
  assert.equal(gateArm('low', config), 'gate.low economy (rebound) claude-opus-5-5:medium');
  assert.equal(gateArm('med', config), 'gate.med efficient claude-sonnet-5-5:high', 'a rebind moves only its class');
  assert.equal(rebindConfig([]), null);
  assert.throws(() => rebindConfig(['economy=claude-opus-5-5']), /<class>=<model>:<effort>/);
  assert.throws(() => rebindConfig(['economy=claude-opus-9:high']), /model one of/);
  assert.throws(() => rebindConfig(['cheap=claude-opus-5-5:high']), /cheap/);
  assert.throws(() => rebindConfig(['economy=claude-haiku-5-5:huge']), /effort/);
  assert.throws(() => rebindConfig(['economy=claude-opus-5-5:high', 'economy=claude-haiku-5-5:low']), /rebound twice/);
  assert.throws(() => gateArm('low', rebindConfig(['economy=gpt-5.6-luna:low'])), /no prompt for gate on gpt-5.6-luna/);
  // The trial arc (test/fixtures/unit-common.ts contextFor) resolves its routing under the descriptor's config.
  const d = setupArc({ steps: [] });
  const r = contextFor({ ...d, config: config! });
  try {
    assert.deepEqual(r.ctx.routing(null).table.gate.low, { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
    assert.deepEqual(r.ctx.routingBase.config, config);
  } finally {
    r.journal.close();
  }
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

test('roles.triggers: gate paths trigger the gate eval; unrelated paths none', () => {
  assert.deepEqual(triggeredRoles(['src/prompts/gate/claude-opus-5-5.ts']), ['gate']);
  assert.deepEqual(triggeredRoles(['src/git/boundeddiff.ts', 'README.md']), ['gate']);
  assert.deepEqual(triggeredRoles(['src/routing/classes.ts']), ['gate']);
  assert.deepEqual(triggeredRoles(['src/holistic/audit.ts', 'test/gate.test.ts']), []);
});
