import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { repoPath } from '../src/core/values.ts';
import { parseGuideText } from '../src/corpus/guide.ts';
import { parseRules } from '../src/corpus/rules.ts';
import { parseInvariantsBlock, parseRulesRegistryBlock } from '../src/docs/invariants.ts';
import { parseDebtBlock } from '../src/docs/debt.ts';
import { parseVision } from '../src/holistic/types.ts';
import { parseRulings } from '../src/spec/rulings.ts';
import { stagePlugin } from '../evals/m4a/driver.ts';
import { fixture, phase0Cli, loadSidecars, json, readJson, write, git, CORPUS_FILE, RULE_FILE, type Fixture } from '../evals/compaction/fixture.ts';
import { gradeA, gradeB, proposals, type Exchange } from '../evals/compaction/grade.ts';
import { goldenRecord, parseRecord } from '../evals/compaction/record.ts';
import { estateSpec, type SetName } from '../evals/compaction/spec.ts';
import { invoke, ISOLATION, stageA, type Budget } from '../evals/compaction/driver.ts';
import { options, summarise } from '../evals/compaction/run.ts';
import { triggeredCompaction, triggeredRoles } from '../evals/roles/triggers.ts';
import { applyGolden } from './helpers/compaction.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: 120_000 };
const fresh = (set: SetName = 'dev') => fixture(join(tmpDir('compaction'), 'fixture'), set);
function bytes(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !relative(dir, join(e.parentPath, e.name)).split('/').includes('.git')).map((e) => {
    const path = join(e.parentPath, e.name);
    return [relative(dir, path), readFileSync(path, 'utf8')];
  }).sort(([a], [b]) => a!.localeCompare(b!)));
}
function exchanges(record: string): Exchange[] {
  const blocks = record.trim().split(/\n\n(?=## K-)/);
  return blocks.map((b) => ({ batch: `1. ${b.replace(/^## K-\d+ /, '')}`, reply: '1: approve' }));
}
function append(record: string, action: string, items: string, givesUp = 'nothing', replacement = 'none'): string {
  return record + `\n## K-${parseRecord(record).length + 1} ${action}\nItems: ${items}\nReplacement: ${replacement}\nGives up: ${givesUp}\nWhy: Review.\nApproved: 2026-10-01\n`;
}
const spec = estateSpec('dev');
const texts = { ...spec.rules, ...spec.rulings, 'I-52': 'One internal comment is grammatical English.', ...Object.fromEntries(spec.debt.map((what, i) => [`B-${i + 1}`, what])) };
const good = goldenRecord(spec.key, texts);

test('compaction.fixture: both sets deterministic, readers accept rendered estate, hidden key stays outside stage, golden chain passes real CLI before compaction', T, async () => {
  for (const set of ['dev', 'holdout'] as const) {
    const a = await fresh(set), b = await fresh(set);
    const aBytes = bytes(a.l.stage), bBytes = bytes(b.l.stage);
    assert.deepEqual(Object.fromEntries(Object.entries(aBytes).map(([p, s]) => [p, s.replaceAll(a.l.dir, '<fixture>')])), Object.fromEntries(Object.entries(bBytes).map(([p, s]) => [p, s.replaceAll(b.l.dir, '<fixture>')])));
    assert.deepEqual(readJson(join(a.l.dir, 'key.json')), a.key);
    for (const answer of a.key.ownerAnswers) {
      assert.doesNotMatch(answer, /\.\./);
      assert.match(answer, /\.$/);
    }
    const invariantText = readFileSync(join(a.l.product, '.roadmap/invariants.md'), 'utf8');
    const obs = parseInvariantsBlock(invariantText)!;
    const registry = parseRulesRegistryBlock(invariantText)!;
    assert.equal(obs.obligations.length, 60);
    assert.equal(registry.active.length, 80);
    assert.equal(registry.retired.length, 5);
    assert.equal(registry.highWater, 85);
    assert.equal(parseDebtBlock(readFileSync(join(a.l.product, '.roadmap/debt.md'), 'utf8'))!.items.length, 15);
    assert.equal(parseGuideText(readFileSync(join(a.l.product, '.roadmap/corpus.md'), 'utf8')).vision, 'vision.md');
    parseVision(readJson(join(a.l.product, '.roadmap/vision.json')));
    const ledger = parseRulings(readFileSync(join(a.previous, 'rulings.md'), 'utf8'), 'rulings.md');
    assert.equal(ledger.length, 40);
    assert.equal(loadSidecars(a.previous).length, 40);
    assert.match(readFileSync(join(a.l.product, '.roadmap/constraints.md'), 'utf8'), /lifetime: standing/);
    assert.equal(git(a.l.product, 'status', '--porcelain'), '');
    const cli = phase0Cli(a);
    assert.equal(cli.status, 0, cli.output);
    assert.deepEqual(JSON.parse(cli.output), { rows: [], sliceCandidates: [], advisories: [] });
    assert.equal(git(a.l.product, 'rev-parse', 'HEAD^'), a.previousHead);
    assert.equal(git(a.l.product, 'branch', '--show-current'), 'work/arc-next');
    assert.deepEqual(readdirSync(join(a.l.inputs, '_next')), []);
    const product = spawnSync(process.execPath, ['--test', 'test/'], { cwd: a.l.product, encoding: 'utf8' });
    assert.equal(product.status, 0, product.stdout + product.stderr);
    const ids = new Set([...Object.keys(estateSpec(set).rules), ...obs.obligations.map((o) => o.id), ...ledger.map((r) => r.id), ...Array.from({ length: 15 }, (_, i) => `B-${i + 1}`)]);
    for (const id of [...a.key.plants.flatMap((p) => p.ids), ...a.key.traps.lossy, a.key.traps.loadBearing, a.key.traps.disposition, a.key.traps.advanced]) assert.ok(ids.has(id), id);
    assert.ok(!Object.keys(aBytes).some((p) => /key|golden|holdout/.test(p)));
    stagePlugin(a.l);
    for (const excluded of ['executor/evals', 'executor/test', 'executor/node_modules']) assert.equal(existsSync(join(a.l.plugin, excluded)), false);
  }
  assert.notDeepEqual(estateSpec('dev').key.plants.map((p) => p.ids), estateSpec('holdout').key.plants.map((p) => p.ids));
});

test('compaction.stage-a: format, recall threshold, each trap, honest losses and approval fidelity each pass and fail', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../evals/compaction/key-dev.json', import.meta.url), 'utf8')), spec.key);
  const approve = exchanges(good);
  assert.equal(gradeA(good, approve, spec.key).pass, true, json(gradeA(good, approve, spec.key)));
  for (const bad of ['', good.replace('K-2', 'K-7'), good.replace('Gives up: nothing\n', ''), good.replace('Approved: 2026-10-01', 'Approved: yes'), good.replace('Replacement: none', 'Replacement:')]) assert.equal(gradeA(bad, approve, spec.key).criteria['format']!.pass, false);
  const blocks = good.trim().split(/\n\n(?=## K-)/);
  assert.equal(gradeA(blocks.slice(0, 11).join('\n\n') + '\n', approve, spec.key).criteria['recall']!.pass, true);
  assert.equal(gradeA(blocks.slice(0, 10).join('\n\n') + '\n', approve, spec.key).criteria['recall']!.pass, false);
  for (const [action, items] of [['merge', 'T-36: JSON export; T-37: CSV export'], ['retire', 'T-20: One vessel per berth per window.'], ['merge', 'C-31: Waive I-55; C-32: Defer I-56']]) {
    const record = append(good, action!, items!);
    assert.equal(gradeA(record, exchanges(record), spec.key).criteria['trapSafety']!.pass, false);
  }
  assert.equal(gradeA(good, [...approve, { batch: '1. retire T-20: One vessel per berth per window.', reply: '1: reject' }], spec.key).criteria['trapSafety']!.pass, false);
  assert.equal(gradeA(good, [...approve, { batch: '1. retire T-20: One vessel per berth per window. Flag: must-hold I-20 and safety critical.', reply: '1: reject' }], spec.key).criteria['trapSafety']!.pass, true);
  const advanced = { batch: '1. tighten T-21: A slip names a recipient.\nReplacement: same.\nGives up: nothing', reply: '1: reject' };
  assert.equal(gradeA(good, [...approve, advanced], spec.key).criteria['trapSafety']!.pass, false);
  assert.equal(gradeA(good, [...approve, { ...advanced, batch: advanced.batch + '\nFlag: serves the current V-1 slice.' }], spec.key).criteria['trapSafety']!.pass, true);
  assert.equal(gradeA(good.replace('Gives up: nothing', 'Gives up: Nothing (lossless)'), approve, spec.key).criteria['format']!.pass, true);
  const dishonest = good.replace(spec.key.plants.find((p) => p.ids.includes('T-62'))!.givesUp, 'nothing');
  assert.equal(gradeA(dishonest, exchanges(dishonest), spec.key).criteria['honesty']!.pass, false);
  const evasive = dishonest.replace(/Gives up: nothing/g, 'Gives up: Nothing (lossless)');
  assert.equal(gradeA(evasive, exchanges(evasive), spec.key).criteria['honesty']!.pass, false);
  assert.equal(gradeA(good, [], spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(good.replace(/; T-14: [^\n]*/, ''), approve, spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(good, approve.map((x) => ({ ...x, reply: '1: reject' })), spec.key).criteria['fidelity']!.pass, false);
  const rejected = append(good, 'retire', 'T-70: The welcome banner ends with a period.', 'Banner punctuation');
  assert.equal(gradeA(rejected, exchanges(rejected), spec.key).criteria['fidelity']!.pass, false);
  const rewritten = good.replace('Every failed command prints its diagnostic to stderr, never stdout.', 'Errors go somewhere.');
  assert.equal(gradeA(rewritten, approve, spec.key).criteria['fidelity']!.pass, false);
  assert.equal(proposals('1. merge T-3 and T-14\nReplacement: same\n2. retire T-8').length, 2);
});

async function mutation(f: Fixture, path: string, change: (text: string) => string, criterion: string): Promise<void> {
  const original = readFileSync(path, 'utf8');
  try {
    writeFileSync(path, change(original));
    const g = gradeB(f);
    assert.equal(g.pass, false, json(g));
    assert.equal(g.criteria[criterion]!.pass, false, json(g));
  } finally { writeFileSync(path, original); }
}
test('compaction.stage-b: golden script passes both domains; absent applications, dropped obligations, reused T/I/C ids, false markers and altered approvals fail', T, async () => {
  for (const set of ['dev', 'holdout'] as const) {
    const f = await fresh(set);
    write(join(f.l.inputs, '_next/compaction.md'), readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8'));
    const before = gradeB(f);
    assert.equal(before.pass, false);
    assert.equal(before.criteria['phase0']!.pass, true);
    assert.equal(before.criteria['effects']!.pass, false);
    assert.equal(before.criteria['markers']!.pass, false);
    await applyGolden(f);
    assert.equal(gradeB(f).pass, true, json(gradeB(f)));
    const obs = join(f.next, 'obligations.json');
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations = o.obligations.filter((x: { id: string }) => x.id !== 'I-1'); o.mapping.paths = o.mapping.paths.map((m: { obligations: string[] }) => ({ ...m, obligations: m.obligations.filter((id) => id !== 'I-1') })); o.census = o.census.map((e: { state: { id?: string } }) => e.state.id === 'I-1' ? { ...e, state: { type: 'prod-only' } } : e); return json(o); }, 'rederive');
    await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace(/\n```\n/, '\nT-81: A retired identity reused.\n```\n'), 'ids');
    await mutation(f, obs, (s) => s.replaceAll('I-61', 'I-54'), 'ids');
    await mutation(f, join(f.next, 'rulings.md'), (s) => s.replace(/C-40 — .+/, 'C-40 — Repurposed identity.'), 'ids');
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.census.pop(); return json(o); }, 'census');
    const record = join(f.l.inputs, '_next/compaction.md');
    await mutation(f, record, (s) => s.replace(/Applied: arc-next/g, ''), 'markers');
    await mutation(f, record, (s) => s.replace('Gives up: nothing', 'Gives up: new loss'), 'markers');
    await mutation(f, join(f.next, 'rulings.md.d/C-41.json'), (s) => s.replace('"lifetime": "arc"', '"lifetime": "standing"'), 'rulings');
    await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace(new RegExp(`^${f.key.plants.find((p) => !p.approved)!.ids[0]}: .+\\n`, 'm'), ''), 'rejectedUntouched');
    await mutation(f, record, (s) => s.replace('Applied: arc-next', 'Blocked: plan-change-refused obligation-dropped'), 'effects');
    // C-38 is arc-lifetime but explicitly cited; C-39 was withdrawn and correctly omitted.
    assert.ok(loadSidecars(f.next).some((s) => s.id === 'C-38'));
    assert.ok(!loadSidecars(f.next).some((s) => s.id === 'C-39'));
    assert.ok(parseRules(readFileSync(join(f.l.product, CORPUS_FILE), 'utf8'), repoPath(RULE_FILE)).length < 80);
    assert.equal(gradeB(f).pass, true);
  }
});

test('compaction.stage-b: standing ruling replacements preserve provenance; folds need no Phase-0 ruling; obligation removals do', T, async () => {
  const f = await fresh();
  await applyGolden(f);
  const decisions = parseRecord(f.key.goldenRecord);
  const sidecars = loadSidecars(f.next);
  const merge = decisions.find((d) => d.action === 'merge' && d.ids.includes('C-12'))!;
  const replacementId = f.key.plants.find((p) => p.ids.includes('C-12'))!.replacement!.id;
  const replacement = sidecars.find((s) => s.id === replacementId)!;
  const originals = loadSidecars(f.previous).filter((s) => merge.ids.includes(s.id));
  assert.equal(originals.length, 2);
  for (const original of originals) {
    assert.equal(replacement.kind, original.kind);
    assert.equal(replacement.lifetime, original.lifetime);
  }
  assert.equal(replacement.lifetime, 'standing');
  assert.match(replacement.trigger, new RegExp(`\\b${merge.id}\\b`));
  const replacementPath = join(f.next, 'rulings.md.d', `${replacementId}.json`);
  await mutation(f, replacementPath, (s) => json({ ...JSON.parse(s), lifetime: 'arc' }), 'rulings');
  await mutation(f, replacementPath, (s) => json({ ...JSON.parse(s), kind: 'disposition' }), 'rulings');
  await mutation(f, replacementPath, (s) => json({ ...JSON.parse(s), trigger: 'Owner policy review' }), 'rulings');

  const fold = decisions.find((d) => d.action === 'fold')!;
  const rulingRetire = decisions.find((d) => d.action === 'retire' && d.ids.includes('C-23'))!;
  const ruleWithoutObligations = decisions.find((d) => d.ids.includes('T-62'))!;
  for (const d of [fold, rulingRetire, ruleWithoutObligations]) assert.ok(!sidecars.some((s) => s.trigger.includes(d.id)), d.id);
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));

  // An optional Phase-0 ruling is allowed for a fold, but must still be valid.
  const phase0Path = join(f.next, 'rulings.md.d/C-41.json');
  const phase0Bytes = readFileSync(phase0Path, 'utf8');
  try {
    const optional = { ...JSON.parse(phase0Bytes), trigger: `compaction K-1, ${fold.id}` };
    write(phase0Path, json(optional));
    assert.equal(gradeB(f).pass, true, json(gradeB(f)));
    await mutation(f, phase0Path, () => json({ ...optional, lifetime: 'standing' }), 'rulings');
  } finally { write(phase0Path, phase0Bytes); }

  const retire = decisions.find((d) => d.action === 'retire' && d.ids.includes('T-27'))!;
  const required = sidecars.find((s) => s.trigger === `compaction ${retire.id}`)!;
  assert.ok(required.obligationDispositions.some((o) => o.id === 'I-27' && o.disposition === 'retired'));
  const requiredPath = join(f.next, 'rulings.md.d', `${required.id}.json`);
  const requiredBytes = readFileSync(requiredPath, 'utf8');
  try {
    rmSync(requiredPath);
    await mutation(f, join(f.next, 'rulings.md'), (s) => s.split('\n').filter((line) => !line.startsWith(`${required.id} — `)).join('\n'), 'rulings');
  } finally { write(requiredPath, requiredBytes); }
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));
});

function fakeClaude(f: Fixture, body: string): void {
  const path = join(f.l.forgeBin, 'claude');
  write(path, '#!/usr/bin/env node\n' + body);
  chmodSync(path, 0o755);
}
const event = (e: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(e) + '\n')});\n`;
test('compaction.driver: free fake CLI checks argv, resume, owner isolation, costs, cap, and fails closed on bad init or missing cost', T, async () => {
  const f = await fresh();
  const clean = event({ type: 'system', subtype: 'init', session_id: 'fixture-session', mcp_servers: [] });
  const answer = event({ type: 'result', session_id: 'fixture-session', result: 'done', total_cost_usd: 0.25 });
  const budget: Budget = { spent: 0, cap: 1 };
  fakeClaude(f, clean + answer);
  const turn = await invoke(f, 'root', 'review', null, false, budget, Date.now() + 60_000);
  assert.equal(turn.session, 'fixture-session');
  await invoke(f, 'resume', 'continue', turn.session, false, budget, Date.now() + 60_000);
  await invoke(f, 'owner', 'approve', null, true, budget, Date.now() + 60_000);
  assert.equal(budget.spent, 0.75);
  const args = readJson(join(f.l.dir, 'root.argv.json')) as string[];
  for (const arg of ['claude-opus-5-5', 'high', '--plugin-dir', '--permission-mode', ...ISOLATION]) assert.ok(args.includes(arg), arg);
  assert.ok((readJson(join(f.l.dir, 'resume.argv.json')) as string[]).includes('--resume'));
  assert.ok((readJson(join(f.l.dir, 'owner.argv.json')) as string[]).includes('medium'));
  assert.ok(!(readJson(join(f.l.dir, 'owner.argv.json')) as string[]).includes('--plugin-dir'));
  await assert.rejects(invoke(f, 'cap', 'review', null, false, { spent: 0.8, cap: 1 }, Date.now() + 60_000), /cap exceeded/);
  for (const init of [{ mcp_servers: [{ name: 'unexpected' }] }, { memory_paths: [] }]) {
    fakeClaude(f, event({ type: 'system', subtype: 'init', session_id: 'x', ...init }) + answer);
    await assert.rejects(invoke(f, 'bad-init', 'review', null, false, { spent: 0, cap: null }, Date.now() + 60_000), /isolation/);
  }
  fakeClaude(f, clean + event({ type: 'result', result: 'done' }));
  await assert.rejects(invoke(f, 'no-cost', 'review', null, false, { spent: 0, cap: null }, Date.now() + 60_000), /total_cost_usd/);
  fakeClaude(f, clean + answer);
  await assert.rejects(invoke(f, 'timeout', 'review', null, false, { spent: 0, cap: null }, Date.now() - 1), /timeout/);
});


test('compaction.driver-review: fake root resumes after explicit owner answers, appends the record and ends on unnumbered text', T, async () => {
  const f = await fresh();
  const batch = good.trim().split(/\n\n(?=## K-)/).map((b, i) => `${i + 1}. ${b.replace(/^## K-\d+ /, '')}`).join('\n\n');
  const reply = parseRecord(good).map((_, i) => `${i + 1}: approve`).join('\n');
  const init = event({ type: 'system', subtype: 'init', session_id: 'review-session', mcp_servers: [] });
  const result = (text: string) => event({ type: 'result', session_id: 'review-session', result: text, total_cost_usd: 0.1 });
  fakeClaude(f, `const { writeFileSync } = require('node:fs');\nconst a=process.argv.slice(2);\n` + init +
    `if (a.includes('medium')) { ${result(reply)} } else if (a.includes('--resume')) { writeFileSync(${JSON.stringify(join(f.l.inputs, '_next/compaction.md'))}, ${JSON.stringify(good)}); ${result('Recorded the approved decisions. Review complete.')} } else { ${result(batch)} }`);
  const budget: Budget = { spent: 0, cap: 1 };
  const g = await stageA(f, budget);
  assert.equal(g.pass, true, json(g));
  assert.ok(Math.abs(budget.spent - 0.3) < 0.00001);
  assert.equal((readJson(join(f.l.dir, 'exchanges.json')) as Exchange[]).length, 1);
  assert.ok((readJson(join(f.l.dir, 'architect-2.argv.json')) as string[]).includes('--resume'));
});

test('compaction.cli-summary-triggers: strict flags, stages independent, incomplete runs fail, compare gap and skill triggers', () => {
  assert.deepEqual(options(['--set', 'dev', '--n', '2']), { set: 'dev', n: 2, stage: 'both', cap: null, compare: null });
  for (const args of [[], ['--set', 'no', '--n', '1'], ['--set', 'dev', '--n', '0'], ['--set', 'dev', '--n', '1', '--cap', 'NaN'], ['--set', 'dev', '--n', '1', '--stage', 'x']]) assert.throws(() => options(args));
  const opts = options(['--set', 'dev', '--n', '1', '--stage', 'a']);
  const a = gradeA(good, exchanges(good), spec.key);
  const row = { trial: 1, dir: '/unused', a, b: null, costUsd: 0.5, failure: null };
  const summary = summarise(opts, [row], null);
  assert.equal(summary.pass, true);
  assert.equal(summary.costUsd, 0.5);
  assert.equal(summarise({ ...opts, stage: 'both' }, [row], null).pass, false);
  assert.equal(summarise({ ...opts, n: 2 }, [row], null).pass, false);
  assert.equal(summarise({ ...opts, set: 'holdout' }, [{ ...row, a: { ...a, recall: 0.84 } }], summary).comparison!.pass, false);
  assert.equal(summarise({ ...opts, set: 'holdout' }, [{ ...row, a: { ...a, recall: 0.86 } }], summary).comparison!.pass, true);
  assert.equal(summarise({ ...opts, set: 'holdout' }, [{ ...row, a: null, failure: 'cap' }], summary).comparison!.pass, false);
  const bOpts = { ...opts, stage: 'b' as const };
  const bRow = { ...row, a: null, b: { pass: true, criteria: {} } };
  const bSummary = summarise(bOpts, [bRow], null);
  assert.equal(summarise({ ...bOpts, set: 'holdout' }, [bRow], bSummary).comparison!.pass, true);
  for (const path of ['../skills/estate-compaction/SKILL.md', '../skills/orchestrate/SKILL.md', 'evals/compaction/grade.ts']) assert.ok(triggeredCompaction([path]), path);
  assert.equal(triggeredCompaction(['src/pipeline/gate.ts']), false);
  assert.deepEqual(triggeredRoles(['../skills/estate-compaction/SKILL.md']), []);
});
