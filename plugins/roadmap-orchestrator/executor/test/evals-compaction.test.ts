import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync,existsSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join,relative } from 'node:path';
import { test } from 'node:test';
import { invoke,ISOLATION,stageA,type Budget } from '../evals/compaction/driver.ts';
import { CORPUS_FILE,fixture,git,json,phase0Cli,readJson,RULE_FILE,write,type Fixture } from '../evals/compaction/fixture.ts';
import { gradeA,gradeB,proposals,type Exchange } from '../evals/compaction/grade.ts';
import { goldenRecord,parseRecord } from '../evals/compaction/record.ts';
import { options,regrade,summarise } from '../evals/compaction/run.ts';
import { estateSpec,type SetName } from '../evals/compaction/spec.ts';
import { stagePlugin } from '../evals/m4a/driver.ts';
import { triggeredCompaction,triggeredRoles } from '../evals/roles/triggers.ts';
import { repoPath } from '../src/core/values.ts';
import { parseGuideText } from '../src/corpus/guide.ts';
import { parseRules } from '../src/corpus/rules.ts';
import { parseDebtBlock } from '../src/docs/debt.ts';
import { parseInvariantsBlock,parseRulesRegistryBlock } from '../src/docs/invariants.ts';
import { parseVision } from '../src/holistic/types.ts';
import { parseRulings } from '../src/spec/rulings.ts';
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
// Saved paid trial 2026-10-29T04-03-40-516Z-2592325/1/a, without edits.
const trialRecord = readFileSync(new URL('fixtures/compaction-trial/compaction.md', import.meta.url), 'utf8');
const trialExchanges = JSON.parse(readFileSync(new URL('fixtures/compaction-trial/exchanges.json', import.meta.url), 'utf8')) as Exchange[];

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
    assert.equal(existsSync(join(a.previous, 'rulings.md.d')), false);
    const constraints = readFileSync(join(a.l.product, '.roadmap/constraints.md'), 'utf8');
    for (const ruling of ledger.filter((r) => r.status === 'active')) {
      assert.ok(constraints.includes(`## ${ruling.id} — ${ruling.text}\n\n- state: active`), `plain statement ${ruling.id} is published`);
    }
    assert.equal((constraints.match(/^## C-/gm) ?? []).length, ledger.filter((r) => r.status === 'active').length);
    assert.doesNotMatch(constraints, /lifetime:|consistency:/, 'schema 2 publishes the plain ledger without sidecar metadata');
    assert.equal(git(a.l.product, 'status', '--porcelain'), '');
    const cli = phase0Cli(a);
    assert.equal(cli.status, 0, cli.output);
    assert.deepEqual(JSON.parse(cli.output), { rows: [], sliceCandidates: [], advisories: [] });
    assert.equal(git(a.l.product, 'rev-parse', 'HEAD^'), a.previousHead);
    assert.equal(git(a.l.product, 'branch', '--show-current'), 'work/arc-next');
    assert.deepEqual(readdirSync(join(a.l.inputs, 'drafts')), []);
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
  // An Items line scopes the change: naming T-21 as unchanged is not a proposal, listing it unflagged still is.
  const aside = { batch: '23. retire C-38\nItems: C-38 "Temporary trace output is permitted for this arc only."\nReplacement: none\n- As with C-12, T-21 doesn\'t change.', reply: '23: reject' };
  assert.equal(gradeA(good, [...approve, aside], spec.key).criteria['trapSafety']!.pass, true);
  assert.equal(gradeA(good, [...approve, { ...aside, batch: aside.batch.replace('Items: C-38', 'Items: T-21 "A slip names a recipient."; C-38') }], spec.key).criteria['trapSafety']!.pass, false);
  assert.equal(gradeA(good, [...approve, { batch: '1. retire C-50\nItems: T-20 "One vessel per berth per window."', reply: '1: reject' }], spec.key).criteria['trapSafety']!.pass, false);
  assert.equal(gradeA(good.replace('Gives up: nothing', 'Gives up: Nothing (lossless)'), approve, spec.key).criteria['format']!.pass, true);
  const dishonest = good.replace(spec.key.plants.find((p) => p.ids.includes('T-62'))!.givesUp, 'nothing');
  assert.equal(gradeA(dishonest, exchanges(dishonest), spec.key).criteria['honesty']!.pass, false);
  const evasive = dishonest.replace(/Gives up: nothing/g, 'Gives up: Nothing (lossless)');
  assert.equal(gradeA(evasive, exchanges(evasive), spec.key).criteria['honesty']!.pass, false);
  assert.equal(gradeA(good, [], spec.key).criteria['fidelity']!.pass, false);
  // A recorded subset of an approved proposal is faithful.
  assert.equal(gradeA(good.replace(/; T-14: [^\n]*/, ''), approve, spec.key).criteria['fidelity']!.pass, true);
  assert.equal(gradeA(good, approve.map((x) => ({ ...x, reply: '1: reject' })), spec.key).criteria['fidelity']!.pass, false);
  const rejected = append(good, 'retire', 'T-70: The welcome banner ends with a period.', 'Banner punctuation');
  assert.equal(gradeA(rejected, exchanges(rejected), spec.key).criteria['fidelity']!.pass, false);
  const rewritten = good.replace('Every failed command prints its diagnostic to stderr, never stdout.', 'Errors go somewhere.');
  assert.equal(gradeA(rewritten, approve, spec.key).criteria['fidelity']!.pass, false);
  assert.equal(proposals('1. merge T-3 and T-14\nReplacement: same\n2. retire T-8').length, 2);
});

test('compaction.stage-a: trial split retirements, grouped items and standing-truth folds cover every approved plant', () => {
  const grade = gradeA(trialRecord, trialExchanges, spec.key);
  assert.equal(grade.pass, true, json(grade));
  assert.equal(grade.recall, 1);
  assert.equal(grade.criteria['recall']!.detail, '13/13');
  // Removing either half of the split plant loses that plant.
  for (const n of [7, 8]) {
    const blocks = trialRecord.slice(trialRecord.indexOf('## K-1 ')).trim().split(/\n\n(?=## K-)/).filter((b) => !b.startsWith(`## K-${n} `));
    const record = blocks.map((b, i) => b.replace(/^## K-\d+ /, `## K-${i + 1} `)).join('\n\n');
    assert.equal(gradeA(record, trialExchanges, spec.key).criteria['recall']!.detail, '12/13');
  }
  const wrongAction = trialRecord.replace('## K-8 retire', '## K-8 tighten');
  assert.equal(gradeA(wrongAction, trialExchanges, spec.key).criteria['recall']!.detail, '12/13');
  assert.deepEqual(spec.key.plants.find((p) => p.ids.includes('C-12'))!.actions, ['merge', 'fold']);
});

test('compaction.stage-a: honesty checks substantive losses, not duplicate or obsolete work or tautologies', () => {
  assert.equal(spec.key.plants.find((p) => p.ids.includes('B-6'))!.givesUp, 'nothing');
  assert.equal(gradeA(trialRecord, trialExchanges, spec.key).criteria['honesty']!.pass, true);
  // T-63 gives up nothing testable; T-62 still gives up a naming convention.
  const dishonest = trialRecord.replace('Gives up: the lower-camel-case convention for local variable names.', 'Gives up: nothing.');
  assert.equal(gradeA(dishonest, trialExchanges, spec.key).criteria['honesty']!.pass, false);
  const punctuation = trialRecord.replace('Gives up: aligning success message punctuation with a help footer; the CLI has no help footer.', 'Gives up: nothing.');
  assert.equal(gradeA(punctuation, trialExchanges, spec.key).criteria['honesty']!.pass, true);
  // Preserve the live-debt loss guard: if a footer exists, abandoning alignment
  // is a substantive loss. The actual fixture has no footer and is obsolete.
  const liveFooterKey = { ...spec.key, plants: spec.key.plants.map((p) => p.ids.includes('B-11') ? { ...p, lossIds: ['B-11'] } : p) };
  assert.equal(gradeA(punctuation, trialExchanges, liveFooterKey).criteria['honesty']!.pass, false);
});

test('compaction.stage-a: exact trial headings, partial approvals, playback numbering and semantic replacement fidelity', () => {
  assert.ok(proposals(trialExchanges[1]!.batch).some((p) => p.number === 11 && p.action === 'merge' && p.text.startsWith('### 11. merge T-14 into T-3')));
  const playback = proposals(trialExchanges[3]!.batch).find((p) => p.number === 20)!;
  assert.ok(playback.text.startsWith('## Playback: decision 20, with your wording, not yet recorded'));
  assert.deepEqual(playback.ids.filter((id) => id.startsWith('C-')), ['C-12', 'C-17']);
  assert.equal(proposals('1. merge T-3 and T-14\n2. retire T-8').length, 2);
  assert.equal(gradeA(trialRecord, trialExchanges, spec.key).criteria['fidelity']!.pass, true);
  const noPartial = trialExchanges.map((x, i) => i === 0 ? { ...x, reply: x.reply.replace('1: reject. I approve only the T-27 part:', '1: reject. Only the T-27 part:') } : x);
  assert.equal(gradeA(trialRecord, noPartial, spec.key).criteria['fidelity']!.pass, false);
  const noPlaybackApproval = trialExchanges.map((x, i) => i === 3 ? { ...x, reply: x.reply.replace('20: approve, record as K-11.', '20: reject.') } : x);
  const playbackOnly = trialExchanges.map((x, i) => i === 2 ? { ...x, reply: x.reply.replace(/20: approve[^\n]+/, '20: reject. Play back my wording first.') } : x);
  assert.equal(gradeA(trialRecord, playbackOnly, spec.key).criteria['fidelity']!.pass, true);
  const beforePlayback = trialExchanges.map((x, i) => i === 2 ? { ...x, reply: x.reply.replace(/20: approve[^\n]+/, '20: reject. Play back my wording first.') } : noPlaybackApproval[i]!);
  assert.equal(gradeA(trialRecord, beforePlayback, spec.key).criteria['fidelity']!.pass, false);
  // Owner wording overrides the proposal's wording, while extra record notes are fine.
  const wrongOwnerText = trialRecord.replace('Every failed command prints its diagnostic to stderr, never stdout.', 'Every failed command prints its diagnostic to stderr, not stdout.');
  assert.equal(gradeA(wrongOwnerText, trialExchanges, spec.key).criteria['fidelity']!.pass, false);
  const wrongPlaybackText = trialRecord.replace('Replacement: T-87: "A request token is accepted once; retries return the stored response without another mutation."', 'Replacement: T-87: "Retries may mutate again."');
  assert.equal(gradeA(wrongPlaybackText, trialExchanges, spec.key).criteria['fidelity']!.pass, false);
  // Per-item approvals under a rejected bundle approve only the ids they name.
  const bundle = { batch: '### 5. retire T-62, T-63, T-70\n- **Items:** T-62 "Internal local variable names use lower camel case."; T-63; T-70\n- **Replacement:** none.\n- **Gives up:** the camel-case and banner-period demands.', reply: '5: reject as bundled.\n- T-62: approve retire.\n- T-70: keep.\n\n6: reject' };
  const retire = (id: string): string => `## K-1 retire\nItems: ${id} "text"\nReplacement: none\nGives up: the demand.\nWhy: cosmetic.\nApproved: 2026-10-29\n`;
  assert.equal(gradeA(retire('T-62'), [bundle], spec.key).criteria['fidelity']!.pass, true);
  assert.equal(gradeA(retire('T-63'), [bundle], spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(retire('T-62'), [{ ...bundle, reply: '5: reject as bundled.\n- T-62: keep.\n\n6: approve' }], spec.key).criteria['fidelity']!.pass, false);
  const wrongAction = trialRecord.replace('## K-11 fold', '## K-11 merge');
  assert.equal(gradeA(wrongAction, trialExchanges, spec.key).criteria['fidelity']!.pass, false);
});

test('compaction.stage-a: approved replacement survives a quoted loss correction; changed wording and missing approval still fail', () => {
  // Unedited paid trial 2026-11-01T19-34-02-385Z-1064195/1/a. The owner
  // approved C-41 as written and corrected Gives up from "nothing" to a loss.
  const dir = new URL('fixtures/compaction-approval-loss/', import.meta.url);
  const record = readFileSync(new URL('compaction.md', dir), 'utf8');
  const saved = JSON.parse(readFileSync(new URL('exchanges.json', dir), 'utf8')) as Exchange[];
  assert.equal(gradeA(record, saved, spec.key).pass, true, json(gradeA(record, saved, spec.key)));
  const wording = 'B-2 and B-6 are closed: the PortLink bridge and its retry queue are gone, and B-1 tracks the index B-6 asks for.';
  assert.ok(record.includes(wording));
  const changed = record.replace(wording, 'B-2 and B-6 stay open.');
  assert.match(gradeA(changed, saved, spec.key).criteria['fidelity']!.detail, /K-8: no matching explicit approval/);
  const rejected = saved.map((x, i) => i === 0 ? { ...x, reply: x.reply.replace(/10: approve[^\n]+/, '10: reject') } : x);
  assert.match(gradeA(record, rejected, spec.key).criteria['fidelity']!.detail, /K-8: no matching explicit approval/);
  const ownerReplacement = saved.map((x, i) => i === 0 ? { ...x, reply: x.reply.replace('including the C-41 wording as written.', 'with my wording: "B-2 and B-6 stay open."') } : x);
  assert.match(gradeA(record, ownerReplacement, spec.key).criteria['fidelity']!.detail, /K-8: no matching explicit approval/);
  // A loss quote may precede or follow an explicit replacement instruction.
  for (const correction of [
    'Accepted loss: "cleanup". Replacement: "B-2 and B-6 stay open."',
    'Replacement: "B-2 and B-6 stay open." Accept loss: "cleanup".',
    'Accepted loss: "cleanup"; Replacement: "B-2 and B-6 stay open."',
  ]) {
    const answers = saved.map((x, i) => i === 0 ? { ...x, reply: x.reply.replace(/10: approve[^\n]+/, `10: approve. ${correction}`) } : x);
    assert.match(gradeA(record, answers, spec.key).criteria['fidelity']!.detail, /K-8: no matching explicit approval/);
    assert.equal(gradeA(changed, answers, spec.key).criteria['fidelity']!.pass, true);
  }
});

test('compaction.stage-a: rejected quote before approval is not replacement wording', () => {
  const wording = 'Every failed command prints its diagnostic to stderr, never stdout.';
  const record = `## K-1 tighten\nItems: T-49 and I-49: diagnostic routing\nReplacement: T-49 and I-49: ${wording}\nGives up: nothing\nWhy: owner wording\nApproved: 2026-11-02\n`;
  const batch = '6. tighten T-49 and I-49\nReplacement: T-49: "Every failed command prints its diagnostic to stderr, not stdout."';
  for (const separator of ['. ', '; ', ', but ']) {
    for (const rejected of ['"not stdout"', '“not stdout”']) {
      const reply = `6: reject ${rejected}${separator}Approve the tighten with this exact T-49 wording: "${wording}" The prose line is fine.`;
      assert.equal(gradeA(record, [{ batch, reply }], spec.key).criteria['fidelity']!.pass, true, reply);
      assert.equal(gradeA(record.replace(wording, 'Errors go somewhere.'), [{ batch, reply }], spec.key).criteria['fidelity']!.pass, false, reply);
    }
  }
});

test('compaction.stage-a: a rejected quote subsequently approved as replacement still binds', () => {
  const wording = 'Every failed command prints its diagnostic to stderr, never stdout.';
  const record = `## K-1 tighten\nItems: T-49 and I-49: diagnostic routing\nReplacement: T-49 and I-49: ${wording}\nGives up: nothing\nWhy: owner wording\nApproved: 2026-11-02\n`;
  const batch = '6. tighten T-49 and I-49\nReplacement: "Errors go somewhere."';
  for (const separator of ['. ', '; ', ', but ']) {
    const reply = `6: reject "${wording}"${separator}Approve the tighten with this exact T-49 wording: "${wording}"`;
    assert.equal(gradeA(record, [{ batch, reply }], spec.key).criteria['fidelity']!.pass, true);
    assert.equal(gradeA(record.replace(wording, 'Errors go somewhere.'), [{ batch, reply }], spec.key).criteria['fidelity']!.pass, false);
  }
});

test('compaction.stage-a: approved unchanged target can be recorded by reference', () => {
  const record = "## K-1 merge\nItems: T-27 and I-27: export date validation; T-41: all-command date validation\nReplacement: T-41 unchanged; T-27 and I-27 leave; I-41's witness must exercise export\nGives up: nothing\nWhy: duplicate date validation\nApproved: 2026-11-02\n";
  const batch = '5. merge T-27 and I-27 into T-41\nReplacement: T-41, unchanged: "Every command refuses invalid dates before reading or writing records."';
  const reply = '5: reject as bundled. Approve only merging T-27 and I-27 into T-41, with T-41 unchanged.';
  assert.equal(gradeA(record, [{ batch, reply }], spec.key).criteria['fidelity']!.pass, true);
  assert.equal(gradeA(record, [{ batch: batch.replace(', unchanged', ''), reply }], spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(record, [{ batch, reply: reply.replace(', with T-41 unchanged', '') }], spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(record, [{ batch, reply: reply.replace('with T-41 unchanged', 'with I-41 unchanged') }], spec.key).criteria['fidelity']!.pass, false);
});

test('compaction.stage-a: unchanged approval does not authorize changing target text', () => {
  const batch = '5. merge T-27 and I-27 into T-41\nReplacement: T-41, unchanged: "Every command refuses invalid dates before reading or writing records."';
  const reply = '5: reject as bundled. Approve only merging T-27 and I-27 into T-41, with T-41 unchanged.';
  for (const replacement of [
    'T-41: "Every command accepts invalid dates."',
    'T-41 unchanged: "Every command accepts invalid dates."',
    'T-41 unchanged; T-41: "Every command accepts invalid dates."',
    'T-27 unchanged; T-41 leaves',
  ]) {
    const record = `## K-1 merge\nItems: T-27 and I-27: export date validation; T-41: all-command date validation\nReplacement: ${replacement}\nGives up: nothing\nWhy: duplicate date validation\nApproved: 2026-11-02\n`;
    assert.equal(gradeA(record, [{ batch, reply }], spec.key).criteria['fidelity']!.pass, false, replacement);
  }
});

test('compaction.stage-a: resolve renumbering preserves exact approval, item references and current decision provenance', () => {
  // Unedited record and owner exchanges from 2026-11-01T21-20-06-053Z-2827056/1/a.
  // architect-3 played back C-45/K-13 -> C-43/K-11 before appending B-11.
  const dir = new URL('fixtures/compaction-review-playback/1/', import.meta.url);
  const record = readFileSync(new URL('compaction.md', dir), 'utf8');
  const saved = JSON.parse(readFileSync(new URL('exchanges.json', dir), 'utf8')) as Exchange[];
  assert.equal(gradeA(record, saved, spec.key).pass, true, json(gradeA(record, saved, spec.key)));
  const ledger = 'C-43 — B-11 resolved by compaction K-11: the product has no help footer and mutating commands print only the record id; the punctuation alignment is given up.';
  assert.ok(record.includes(ledger));
  for (const changed of [
    ledger.replace('B-11 resolved', 'B-12 resolved'),
    ledger.replace('compaction K-11:', 'compaction K-13:'),
    ledger.replace('the punctuation alignment is given up', 'the punctuation alignment remains required'),
    ledger.replace('only the record id', 'the record id and C-99'),
  ]) assert.equal(gradeA(record.replace(ledger, changed), saved, spec.key).criteria['fidelity']!.pass, false);
  const rejected = saved.map((x, i) => i === 1 ? { ...x, reply: x.reply.replace('5: approve; T-70 stays', '5: reject; T-70 stays') } : x);
  assert.equal(gradeA(record, rejected, spec.key).criteria['fidelity']!.pass, false);
  const fixedIds = saved.map((x, i) => i === 1 ? { ...x, reply: x.reply.replace('5: approve; T-70 stays',
    `5: approve with this exact wording: "${ledger.replace('C-43 —', 'C-45 —').replace('compaction K-11:', 'compaction K-13:')}"`) } : x);
  assert.equal(gradeA(record, fixedIds, spec.key).criteria['fidelity']!.pass, false);
  assert.equal(gradeA(record.replace('## K-11 resolve', '## K-11 retire'), saved, spec.key).criteria['fidelity']!.pass, false);
});

test('compaction.stage-a: schema-2 saved trials retain exact evidence; obsolete footer, closing survey and narrowed approvals are not failures', () => {
  for (const n of [1, 2]) {
    const dir = new URL(`fixtures/compaction-schema2-trials/${n}/`, import.meta.url);
    const record = readFileSync(new URL('compaction.md', dir), 'utf8');
    const saved = JSON.parse(readFileSync(new URL('exchanges.json', dir), 'utf8')) as Exchange[];
    assert.equal(gradeA(record, saved, spec.key).pass, true, json(gradeA(record, saved, spec.key)));
    if (n === 2) {
      // Merely naming I-52 is no approval; an explicit narrowed instruction is.
      const unapproved = saved.map((x) => ({ ...x, reply: x.reply.replace('Retire I-52 only', 'Consider I-52 only') }));
      assert.equal(gradeA(record, unapproved, spec.key).criteria['fidelity']!.pass, false);
      const wrongAction = saved.map((x) => ({ ...x, reply: x.reply.replace('Retire I-52 only', 'Tighten I-52 only') }));
      assert.equal(gradeA(record, wrongAction, spec.key).criteria['fidelity']!.pass, false);
      const wrongSubset = record.replace('Items: I-52 "One internal comment is grammatical English."', 'Items: T-52; I-52 "One internal comment is grammatical English."');
      assert.equal(gradeA(wrongSubset, saved, spec.key).criteria['fidelity']!.pass, false);
      const concealed = record.replace('Items: T-62', 'Items: T-62 (and T-70)');
      assert.equal(gradeA(concealed, saved, spec.key).criteria['fidelity']!.pass, false);
      const changedDebt = record.replace('Replacement: none (owner instruction: no ledger entry).', 'Replacement: C-99 "A new demand."');
      assert.equal(gradeA(changedDebt, saved, spec.key).criteria['fidelity']!.pass, false);
    }
  }
  // The taught grammar gives Approved only a date; Application/No-loss notes
  // belong in existing text fields, never after Approved as invented fields.
  const malformed = readFileSync(new URL('fixtures/compaction-schema2-trials/3/compaction.md', import.meta.url), 'utf8');
  assert.throws(() => parseRecord(malformed), /Approved must be YYYY-MM-DD/);
  assert.equal(gradeA(malformed, [], spec.key).criteria['format']!.pass, false);
  const advanced = { batch: '1. tighten T-21: A slip names the recipient.\nReplacement: same.', reply: '1: reject' };
  assert.equal(gradeA(good, [...exchanges(good), advanced], spec.key).criteria['trapSafety']!.pass, false);
});

async function mutation(f: Fixture, path: string, change: (text: string) => string, criterion: string): Promise<void> {
  const original = readFileSync(path, 'utf8');
  try {
    writeFileSync(path, change(original));
    const g = gradeB(f);
    assert.equal(g.pass, false, json(g));
    assert.equal(g.criteria[criterion]?.pass, false, json(g));
  } finally { writeFileSync(path, original); }
}
test('compaction.stage-b: golden script passes both domains; absent applications, dropped obligations, reused T/I/C ids, false markers and altered approvals fail', T, async () => {
  for (const set of ['dev', 'holdout'] as const) {
    const f = await fresh(set);
    write(join(f.l.inputs, 'drafts/compaction.md'), readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8'));
    const before = gradeB(f);
    assert.equal(before.pass, false);
    assert.equal(before.criteria['phase0']!.pass, true);
    assert.equal(before.criteria['effects']!.pass, false);
    assert.equal(before.criteria['markers']!.pass, false);
    await applyGolden(f);
    assert.equal(gradeB(f).pass, true, json(gradeB(f)));
    const obs = join(f.next, 'obligations.json');
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations = o.obligations.filter((x: { id: string }) => x.id !== 'I-1'); o.mapping.systems = o.mapping.systems.map((m: { obligations: string[] }) => ({ ...m, obligations: m.obligations.filter((id) => id !== 'I-1') })); o.census = o.census.map((e: { state: { id?: string } }) => e.state.id === 'I-1' ? { ...e, state: { type: 'prod-only' } } : e); return json(o); }, 'rederive');
    await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace(/\n```\n/, '\nT-81: A retired identity reused.\n```\n'), 'ids');
    await mutation(f, obs, (s) => { const o = JSON.parse(s.replace(/\bI-3\b/g, 'I-54')); for (const m of o.mapping.systems) m.obligations.sort((a: string, b: string) => Number(a.slice(2)) - Number(b.slice(2))); return json(o); }, 'ids');
    await mutation(f, join(f.next, 'rulings.md'), (s) => s.replace(/C-40 — .+/, 'C-40 — Repurposed identity.'), 'ids');
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.census.pop(); return json(o); }, 'census');
    const record = join(f.l.inputs, 'drafts/compaction.md');
    await mutation(f, record, (s) => s.replace(/Applied: arc-next/g, ''), 'markers');
    await mutation(f, record, (s) => s.replace('Gives up: nothing', 'Gives up: new loss'), 'markers');
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations.find((x: { id: string }) => x.id === 'I-27').state.reason = 'Unrelated policy'; return json(o); }, 'rulings');
    await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace(new RegExp(`^${f.key.plants.find((p) => !p.approved)!.ids[0]}: .+\\n`, 'm'), ''), 'rejectedUntouched');
    await mutation(f, record, (s) => s.replace('Applied: arc-next', 'Blocked: plan-change-refused obligation-dropped'), 'effects');
    // C-38 is explicitly cited; C-39 was withdrawn and correctly omitted.
    const carried = parseRulings(readFileSync(join(f.next, 'rulings.md'), 'utf8'), 'rulings.md');
    assert.ok(carried.some((r) => r.id === 'C-38'));
    assert.ok(!carried.some((r) => r.id === 'C-39'));
    assert.equal(existsSync(join(f.next, 'rulings.md.d')), false);
    assert.ok(parseRules(readFileSync(join(f.l.product, CORPUS_FILE), 'utf8'), repoPath(RULE_FILE)).length < 80);
    assert.equal(gradeB(f).pass, true);
  }
});

test('compaction.stage-b: standing ruling replacements preserve provenance; folds need no disposition; obligation retirements need reasons', T, async () => {
  const f = await fresh();
  await applyGolden(f, true); // Merged standing ruling allocates C-41 first.
  const decisions = parseRecord(f.key.goldenRecord);
  const ledgerPath = join(f.next, 'rulings.md');
  const phase0Path = join(f.next, 'phase0.json');
  const obs = join(f.next, 'obligations.json');
  const ledger = parseRulings(readFileSync(ledgerPath, 'utf8'), 'rulings.md');
  const merge = decisions.find((d) => d.action === 'merge' && d.ids.includes('C-12'))!;
  const replacement = ledger.find((r) => r.status === 'active' && r.text === spec.key.plants.find((p) => p.ids.includes('C-12'))!.replacement!.text)!;
  assert.equal(replacement.id, 'C-41');
  for (const id of merge.ids) assert.deepEqual(ledger.find((r) => r.id === id), { id, status: 'withdrawn', by: replacement.id });
  const phase0 = readJson(phase0Path) as { curation: { what: string; files: string[] }[] };
  const provenance = phase0.curation.find((c) => c.what.startsWith(`compaction ${merge.id}:`))!;
  for (const id of [...merge.ids, replacement.id]) assert.ok(provenance.what.includes(id));
  assert.ok(provenance.files.length);
  // The old kind/lifetime/consistency stamps no longer exist: the replacement
  // must demand the exact lasting properties, with complete withdrawal edges.
  await mutation(f, ledgerPath, (s) => s.replace(replacement.status === 'active' ? replacement.text : '', 'Temporary token permission for this arc.'), 'rulings');
  await mutation(f, ledgerPath, (s) => s.replace(replacement.status === 'active' ? replacement.text : '', 'Retire I-55.'), 'rulings');
  await mutation(f, phase0Path, (s) => s.replace(`compaction ${merge.id}:`, 'Owner policy review:'), 'rulings');
  await mutation(f, ledgerPath, (s) => s.replace('C-17 — withdrawn by C-41', 'C-17 — withdrawn by C-40'), 'rulings');
  await mutation(f, ledgerPath, (s) => s.replace('C-12 — withdrawn by C-41', 'C-12 — Only one clause is replaced by C-41.'), 'rulings');
  await mutation(f, ledgerPath, (s) => s.replace(/^C-41 — .+$/m, 'C-41 — withdrawn by C-40'), 'rulings');
  await mutation(f, ledgerPath, (s) => s.replaceAll('C-41', 'C-39'), 'rulings');

  // A merge may physically remove old ledger entries after migrating their
  // references. Complete curation still has to identify both sources and target.
  const originalLedger = readFileSync(ledgerPath, 'utf8');
  try {
    write(ledgerPath, originalLedger.split('\n').filter((line) => !/^C-(12|17) — /.test(line)).join('\n'));
    assert.equal(gradeB(f).pass, true, json(gradeB(f)));
    await mutation(f, phase0Path, (s) => s.replace('C-12, C-17 merge to C-41', 'C-12 merge to C-41'), 'rulings');
  } finally { write(ledgerPath, originalLedger); }

  const fold = decisions.find((d) => d.action === 'fold')!;
  const rulingRetire = decisions.find((d) => d.action === 'retire' && d.ids.includes('C-23'))!;
  const ruleWithoutObligations = decisions.find((d) => d.ids.includes('T-62'))!;
  for (const d of [fold, rulingRetire, ruleWithoutObligations]) assert.ok(!ledger.some((r) => r.status === 'active' && r.text.includes(d.id)), d.id);
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));

  // Optional additional curation remains subject to the same source/reason bar.
  const original = readFileSync(phase0Path, 'utf8');
  try {
    phase0.curation.push({ ...provenance, what: `compaction ${fold.id}: optional explanation of C-4 to T-86` });
    write(phase0Path, json(phase0));
    assert.equal(gradeB(f).pass, true, json(gradeB(f)));
    await mutation(f, phase0Path, (s) => { const p = JSON.parse(s); p.curation.at(-1).files = ['missing-source.md']; return json(p); }, 'rulings');
  } finally { write(phase0Path, original); }

  const retire = decisions.find((d) => d.action === 'retire' && d.ids.includes('T-27'))!;
  const retired = (readJson(obs) as { obligations: { id: string; state: { type: string; reason: string; rev: number } }[] }).obligations.find((o) => o.id === 'I-27')!;
  assert.equal(retired.state.type, 'retired');
  assert.ok(retired.state.reason.includes(retire.id));
  await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations.find((o: { id: string }) => o.id === 'I-27').state.reason = ''; return json(o); }, 'readable');
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));
});

test('compaction.stage-b: only retired-with-reason/revision clears a whole family; mappings, specs and proof remain binding', T, async () => {
  const original = await fresh();
  const split = { name: 'split-family retirement', ids: ['I-58'], actions: ['retire' as const], approved: true,
    givesUp: 'The complete split requirement.', lossIds: ['I-58'], trivia: false, replacement: null };
  const key = { ...original.key, plants: [...original.key.plants, split] };
  const f = { ...original, key: { ...key, goldenRecord: goldenRecord(key, { ...texts, 'I-58': spec.rules['T-58']! }) } };
  write(join(f.l.dir, 'golden-compaction.md'), f.key.goldenRecord);
  await applyGolden(f);
  const obs = join(f.next, 'obligations.json');
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));
  const changeState = (id: string, state: unknown) => (s: string): string => {
    const o = JSON.parse(s); o.obligations.find((o: { id: string }) => o.id === id).state = state; return json(o);
  };
  for (const id of ['I-14', 'I-58', 'I-59', 'I-60']) {
    for (const type of ['active', 'waived', 'deferred']) await mutation(f, obs, changeState(id,
      type === 'active' ? { type } : { type, reason: 'compaction K-14: owner approved', rev: 1 }), type === 'active' ? 'readable' : 'effects');
    await mutation(f, obs, changeState(id, { type: 'retired', reason: ' ', rev: 1 }), 'effects');
    await mutation(f, obs, changeState(id, { type: 'retired', reason: 'compaction K-14: owner approved', rev: 2 }), 'effects');
  }
  await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations = o.obligations.filter((o: { id: string }) => o.id !== 'I-14'); return json(o); }, 'effects');
  await mutation(f, obs, (s) => { const o = JSON.parse(s); o.mapping.systems[0].obligations.push('I-59'); return json(o); }, 'effects');
  await mutation(f, join(f.next, 'slips.json'), (s) => { const o = JSON.parse(s); o.obligations.push('I-60'); return json(o); }, 'effects');
  for (const proof of [null, { verdict: 'proves', obligationRev: 2, witness: { testIds: ['I-3'], files: ['test/register.test.js'] } },
    { verdict: 'proves', obligationRev: 1, witness: { testIds: ['wrong'], files: ['test/register.test.js'] } },
    { verdict: 'proves', obligationRev: 1, witness: { testIds: ['I-3'], files: ['wrong.js'] } }]) {
    await mutation(f, obs, (s) => { const o = JSON.parse(s); o.obligations.find((o: { id: string }) => o.id === 'I-3').proofJudgment = proof; return json(o); }, proof === null ? 'readable' : 'effects');
  }
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));
});

test('compaction.stage-b: new merge and fold rules are found by text above the registry high-water', T, async () => {
  const original = await fresh();
  const plants = original.key.plants.map((p) => p.ids.includes('T-3') ? { ...p,
    replacement: { id: 'T-?', text: 'Every berth booking identifier occurs at most once in the register.' } } : p);
  const key = { ...original.key, plants };
  const f = { ...original, key: { ...key, goldenRecord: goldenRecord(key, texts) } };
  write(join(f.l.dir, 'golden-compaction.md'), f.key.goldenRecord);
  await applyGolden(f);
  assert.equal(gradeB(f).pass, true, json(gradeB(f)));
  const rules = parseRules(readFileSync(join(f.l.product, CORPUS_FILE), 'utf8'), repoPath(RULE_FILE));
  assert.equal(rules.find((r) => r.text === plants[0]!.replacement!.text)!.id, 'T-86');
  const fold = plants.find((p) => p.ids.includes('C-4'))!;
  assert.equal(rules.find((r) => r.text === fold.replacement!.text)!.id, 'T-87');
  assert.match(f.key.goldenRecord, /Replacement: T-\?:/);
  assert.match(f.key.goldenRecord, /Replacement: C-\?:/);
  await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace('T-87:', 'T-81:'), 'effects');
  await mutation(f, join(f.l.product, CORPUS_FILE), (s) => s.replace(plants[0]!.replacement!.text, 'Identifiers may repeat.'), 'effects');
});

function fakeClaude(f: Fixture, body: string): void {
  const path = join(f.l.forgeBin, 'claude');
  write(path, '#!/usr/bin/env node\n' + body);
  chmodSync(path, 0o755);
}

test('compaction.regrade: saved evidence uses current semantics, preserves historical approvals and costs, and never calls models', T, async () => {
  const root = tmpDir('compaction-regrade');
  const dir = join(root, '1');
  const a = await fixture(join(dir, 'a'), 'dev');
  const b = await fixture(join(dir, 'b'), 'dev');
  write(join(a.l.inputs, 'drafts/compaction.md'), trialRecord);
  write(join(a.l.dir, 'exchanges.json'), json(trialExchanges));
  rmSync(join(a.next, 'plan.json')); // Stage A needs only the exchange and record.
  // Simulate an older key with a fixed id and duplicate debt described as a loss.
  const historical = b.key.goldenRecord.replace('C-?:', 'C-48:').replace('Gives up: nothing\nWhy: duplicate index debt.',
    'Gives up: The separate duplicate index task B-6; B-1 survives.\nWhy: duplicate index debt (historical approval).');
  write(join(b.l.dir, 'golden-compaction.md'), historical);
  await applyGolden(b, true);
  for (const f of [a, b]) fakeClaude(f, 'throw new Error("regrade must not invoke claude");');
  const oldGrade = { pass: false, criteria: { stale: { pass: false, detail: 'old grader' } } };
  const first = { trial: 1, dir, a: oldGrade, b: oldGrade, costUsd: 9.63, failure: null };
  const second = { trial: 2, dir: join(root, '2'), a: null, b: null, costUsd: 0.1, failure: 'saved transport failure' };
  write(join(dir, 'row.json'), json(first));
  write(join(second.dir, 'row.json'), json(second));
  const opts = { set: 'dev' as const, n: 2, stage: 'both' as const, cap: null, compare: null };
  // Even a trial omitted from the old summary must be found on disk.
  write(join(root, 'summary.json'), json(summarise(opts, [first], null)));
  const r = spawnSync(process.execPath, ['evals/compaction/run.ts', '--regrade', root], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr); // The saved transport failure remains.
  const summary = readJson(join(root, 'summary.json')) as ReturnType<typeof summarise>;
  assert.equal(summary.trials.length, 2);
  assert.equal(summary.trials[0]!.a!.pass, true, json(summary));
  assert.equal(summary.trials[0]!.b!.pass, true, json(summary));
  assert.equal(summary.trials[1]!.failure, second.failure);
  assert.equal(summary.costUsd, 9.73);
  assert.equal(summary.recall, 1);
  assert.equal(readFileSync(join(b.l.inputs, 'drafts/compaction.md'), 'utf8').includes('historical approval'), true);
  assert.deepEqual(regrade(root).summary, summary); // Repeatable, with no new spend.
  write(join(second.dir, 'a/stage/roadmap-inputs/drafts/compaction.md'), trialRecord);
  const incomplete = regrade(root).summary;
  assert.equal(incomplete.trials[0]!.a!.pass, true);
  assert.equal(incomplete.trials[1]!.a!.criteria['readable']!.pass, false);
  assert.equal(incomplete.trials[1]!.failure, second.failure);
  for (const args of [['--regrade'], ['--regrade', root, '--n', '1']]) {
    const bad = spawnSync(process.execPath, ['evals/compaction/run.ts', ...args], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /usage:.*--regrade/);
  }
});
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
    `if (a.includes('medium')) { ${result(reply)} } else if (a.includes('--resume')) { writeFileSync(${JSON.stringify(join(f.l.inputs, 'drafts/compaction.md'))}, ${JSON.stringify(good)}); ${result('Recorded the approved decisions. Review complete.')} } else { ${result(batch)} }`);
  const budget: Budget = { spent: 0, cap: 1 };
  const g = await stageA(f, budget);
  assert.equal(g.pass, true, json(g));
  assert.ok(Math.abs(budget.spent - 0.3) < 0.00001);
  assert.equal((readJson(join(f.l.dir, 'exchanges.json')) as Exchange[]).length, 1);
  assert.ok((readJson(join(f.l.dir, 'architect-2.argv.json')) as string[]).includes('--resume'));
});

test('compaction.driver-review: saved K-n playback gets an owner turn before recording or completion', T, async () => {
  // Trial 2 ended here despite explicitly waiting for "record". All six missing
  // plants were already proposed and approved; the playback is not a final review.
  const dir = new URL('fixtures/compaction-review-playback/2/', import.meta.url);
  const record = readFileSync(new URL('compaction.md', dir), 'utf8');
  const saved = JSON.parse(readFileSync(new URL('exchanges.json', dir), 'utf8')) as Exchange[];
  const playback = readFileSync(new URL('playback.txt', dir), 'utf8');
  const parsed = proposals(playback);
  assert.deepEqual(parsed.map((p) => [p.number, p.action]), [[9, 'resolve'], [10, 'resolve'], [11, 'resolve'], [12, 'retire'], [13, 'fold'], [14, 'fold']]);
  assert.equal(gradeA(record, saved, spec.key).criteria['recall']!.detail, '7/13');
  const missed = spec.key.plants.filter((p) => p.approved && !p.ids.every((id) => parseRecord(record).some((d) => d.ids.includes(id) && p.actions.includes(d.action))));
  assert.deepEqual(missed.map((p) => p.ids), [['C-4'], ['C-12', 'C-17'], ['C-23'], ['B-2'], ['B-6'], ['B-11']]);
  const pending = /```markdown\n([\s\S]*?)\n```/.exec(playback)![1]!;
  const complete = record.trimEnd() + '\n\n' + pending + '\n';
  const f = await fresh();
  const path = join(f.l.inputs, 'drafts/compaction.md');
  const confirmation = parsed.map((p) => `${p.number}: approve`).join('\n');
  const init = event({ type: 'system', subtype: 'init', session_id: 'review-session', mcp_servers: [] });
  const countPath = join(f.l.dir, 'fake-turn');
  const turns = [saved[0]!.batch, saved[0]!.reply, saved[1]!.batch, saved[1]!.reply, playback, confirmation, 'Recorded. Review complete.'];
  fakeClaude(f, `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const countPath=${JSON.stringify(countPath)};
const n=existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(n+1));
if (process.argv.includes('medium') !== (n % 2 === 1)) throw new Error('wrong review seat');
if (n===2) writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(record)});
if (n===5 && readFileSync(${JSON.stringify(path)}, 'utf8') !== ${JSON.stringify(record)}) throw new Error('recorded before confirmation');
if (n===6) writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(complete)});
` + init + `const turns=${JSON.stringify(turns)}; if (n>=turns.length) throw new Error('unexpected turn');\n` +
    `process.stdout.write(JSON.stringify({type:'result', session_id:'review-session', result:turns[n], total_cost_usd:0.1})+'\\n');`);
  const budget: Budget = { spent: 0, cap: 1 };
  const grade = await stageA(f, budget);
  assert.equal(grade.pass, true, json(grade));
  assert.equal(grade.criteria['recall']!.detail, '13/13');
  assert.equal((readJson(join(f.l.dir, 'exchanges.json')) as Exchange[]).length, 3);
  assert.ok(Math.abs(budget.spent - 0.7) < 0.00001);
  const changed = complete.replace('Replacement: C-41 — B-2 resolved', 'Replacement: C-41 — B-3 resolved');
  assert.equal(gradeA(changed, [...saved, { batch: playback, reply: confirmation }], spec.key).criteria['fidelity']!.pass, false);
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
