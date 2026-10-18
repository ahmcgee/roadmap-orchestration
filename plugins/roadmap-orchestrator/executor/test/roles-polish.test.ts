// The polish-judge role eval's cells, after-states, summary and harness (evals/roles/polish/), free: the products brought
// up by the production bring-up and driven over HTTP and the CLI, degenerate fake judges through run.ts. Named tests:
// roles.polish-cells, roles.polish-after-states (each family's before and its better, worse and neutral after-states,
// checked mechanically on the running product: the fields' spacing resolved from the served stylesheet and tokens, the
// budget page's primary action and its order, the usage's sections and command order, the import error naming the field
// and its fix), roles.polish-summary, roles.polish-fakes (oracle, keep-all, drop-all and refused through run.ts, each trial
// an arc whose walk proposes the tweak, whose polish revision admits it and whose compare-1 runs through the production
// compare job), roles.polish-caps, roles.polish-seat.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type JobId, arcId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { sessionContainment } from '../src/contain/session.ts';
import { absPath, isoTimeOf } from '../src/core/values.ts';
import { allocatePorts, bringUp, tearDown } from '../src/walk/bringup.ts';
import { rebindConfig } from '../evals/roles/run.ts';
import { type PolishRow, polishSeat } from '../evals/roles/polish/arc.ts';
import { DEV_POLISH_CELLS, type PolishCell } from '../evals/roles/polish/cells.ts';
import { FAMILIES, POLISH_FAMILY_IDS, type PolishFamilyId, VARIANTS, type Variant, applyEdits } from '../evals/roles/polish/families.ts';
import { buildPolishFixture } from '../evals/roles/polish/fixture.ts';
import { runPolish } from '../evals/roles/polish/run.ts';
import { type PolishSummary, summarisePolish } from '../evals/roles/polish/summary.ts';
import type { Milestone } from '../src/input/plan.ts';
import type { FileMap } from '../evals/roles/walkthrough/product.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: 600_000 };

const cellOf = (id: string): PolishCell => DEV_POLISH_CELLS.find((c) => c.id === id)!;
const cellsOf = (family: PolishFamilyId): Readonly<Record<Variant, PolishCell>> =>
  Object.fromEntries(VARIANTS.map((v) => [v, DEV_POLISH_CELLS.find((c) => c.family === family && c.variant === v)!])) as Record<Variant, PolishCell>;

test('roles.polish-cells: four families, each a better, a worse and a neutral after-state on its step: 12 cells; every after-state edits the product and the reference; built the same every time; no file or proposal names the eval', () => {
  assert.equal(DEV_POLISH_CELLS.length, 12);
  assert.equal(new Set(DEV_POLISH_CELLS.map((c) => c.id)).size, 12);
  for (const family of POLISH_FAMILY_IDS) assert.deepEqual(DEV_POLISH_CELLS.filter((c) => c.family === family).map((c) => c.variant), [...VARIANTS], family);
  const words = /\b(evals?|cells?|better|worse|neutral|answer key|oracle)\b/i;
  for (const cell of DEV_POLISH_CELLS) {
    const f = buildPolishFixture(cell);
    assert.deepEqual([...buildPolishFixture(cell).after], [...f.after], `${cell.id}: deterministic`);
    const changed = Object.keys(f.changed);
    assert.ok(changed.some((p) => p.startsWith('design/')) && changed.some((p) => !p.startsWith('design/')), `${cell.id}: ${changed.join(', ')}`);
    assert.doesNotMatch(cell.proposal, words, `${cell.id}: its proposal`);
    for (const [path, text] of Object.entries(f.changed)) assert.doesNotMatch(text, words, `${cell.id} ${path}`);
    for (const [path, text] of f.before) assert.doesNotMatch(text, /\{\{[a-z-]+\}\}/, `${cell.id} ${path}: an unresolved hook`);
    assert.ok(f.walk.milestone.journeys.some((j) => j.id === FAMILIES[cell.family].journey), `${cell.id}: its journey is the milestone's`);
  }
  // An edit whose text drifted from the product fails loud.
  assert.throws(() => applyEdits(new Map([['a', 'x x']]), [{ file: 'a', find: 'x', replace: 'y' }]), /more than one occurrence/);
  assert.throws(() => applyEdits(new Map([['a', 'x']]), [{ file: 'a', find: 'z', replace: 'y' }]), /no occurrence/);
  assert.throws(() => applyEdits(new Map(), [{ file: 'a', find: 'z', replace: 'y' }]), /does not hold/);
});

// ---------------------------------------------------------------------------------------------------
// The after-states' effects, checked on the running product

/** A product written to a fresh directory. */
function writeProduct(files: FileMap): string {
  const dir = join(tmpDir('polish-product'), 'ledgerly');
  for (const [p, t] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}

/** `files` brought up by the production bring-up of `milestone`; `body` gets its base URL, then it is torn down. */
async function served<X>(files: FileMap, milestone: Milestone, body: (base: string) => Promise<X>): Promise<X> {
  const dir = writeProduct(files);
  const runDir = absPath(tmpDir('polish-up'));
  const journal = openJournal(runDir, arcId('t-polishup'));
  const ctx = { journal, containment: sessionContainment, runDir, hostEnv: process.env };
  const ports = await allocatePorts(milestone.bringUp.serve.map((x) => x.name));
  const end = await bringUp(ctx, {
    milestone, checkout: absPath(dir), ports, parent: { type: 'job', job: 'compare-1' as JobId }, key: 'bring-up:compare-1:after',
    logDir: absPath(join(runDir, 'server')), serveDeadlineAt: isoTimeOf(new Date(Date.now() + 15 * 60_000)),
  });
  if (end.kind !== 'up') throw new Error(`the bring-up ended ${JSON.stringify(end)}`);
  try {
    return await body(`http://127.0.0.1:${ports['web' as never]}`);
  } finally {
    await tearDown(ctx, end.instance);
    journal.close();
  }
}
const text = async (base: string, path: string): Promise<string> => {
  const res = await fetch(`${base}${path}`, { headers: { connection: 'close' } });
  assert.equal(res.status, 200, path);
  return res.text();
};

/** A CSS length in px: a px value, a token (`var(--x)`) or `calc(<length> / n)`, resolved against tokens.css. */
function px(value: string, tokens: string): number {
  const v = value.trim();
  const plain = /^(\d+)px$/.exec(v);
  if (plain !== null) return Number(plain[1]);
  const token = /^var\((--[\w-]+)\)$/.exec(v);
  if (token !== null) {
    const def = new RegExp(`${token[1]}:\\s*([^;]+);`).exec(tokens);
    if (def === null) throw new Error(`no ${token[1]} in tokens.css`);
    return px(def[1]!, tokens);
  }
  const half = /^calc\((.+) \/ (\d+)\)$/.exec(v);
  if (half !== null) return px(half[1]!, tokens) / Number(half[2]);
  throw new Error(`a length px() does not read: ${v}`);
}

/** The record form's field gap as served: the rule's text and its px. */
async function fieldGap(files: FileMap, milestone: Milestone): Promise<Readonly<{ rule: string; px: number }>> {
  return served(files, milestone, async (base) => {
    assert.match(await text(base, '/entries/new'), /<form class="form"/);
    const css = await text(base, '/static/app.css');
    const tokens = await text(base, '/static/tokens.css');
    const m = /\.field \{ margin-bottom: ([^;]+); \}/.exec(css);
    if (m === null) throw new Error('no .field rule in app.css');
    return { rule: m[1]!, px: px(m[1]!, tokens) };
  });
}

/** The team budget page as served: Change limit's class, whether the card comes before the table, the table's heading. */
async function budgetPage(files: FileMap, milestone: Milestone): Promise<Readonly<{ action: string; cardFirst: boolean; heading: string }>> {
  return served(files, milestone, async (base) => {
    const html = await text(base, '/budgets/platform');
    const action = /<a class="([^"]+)" href="\/budgets\/platform\/edit">Change limit<\/a>/.exec(html)?.[1];
    const heading = /<h2>([^<]*entries[^<]*)<\/h2>/i.exec(html)?.[1];
    const card = html.indexOf('<section class="card');
    const table = html.indexOf('<table class="ledger"');
    assert.ok(action !== undefined && heading !== undefined && card >= 0 && table >= 0, html);
    return { action, cardFirst: card < table, heading };
  });
}

const cli = (dir: string, args: readonly string[]) => spawnSync('node', ['bin/ledgerly.js', ...args], { cwd: dir, encoding: 'utf8' });

/** `ledgerly --help`'s sections in order and the commands in its Commands section, in order. */
function usage(files: FileMap): Readonly<{ sections: readonly string[]; commands: readonly string[]; lines: readonly string[] }> {
  const r = cli(writeProduct(files), ['--help']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const at = lines.indexOf('Commands:');
  const end = lines.findIndex((l, i) => i > at && l.trim() === '');
  const commandLines = lines.slice(at + 1, end);
  return { sections: lines.filter((l) => /^(Examples|Commands|Options):$/.test(l)), commands: commandLines.map((l) => l.trim().split(/\s+/)[0]!), lines: commandLines };
}

/** What `ledgerly import bad.csv` says of a row whose amount carries a currency sign: its stderr, after an exit 3. */
function importError(files: FileMap, month: string): string {
  const dir = writeProduct(files);
  writeFileSync(join(dir, 'bad.csv'), `team,month,vendor,amount,note\nplatform,${month},Hetzner,€120,build runners\n`);
  const r = cli(dir, ['import', 'bad.csv', '--data', 'var/check']);
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, '');
  // Progress lines (the import's own, on stderr) come before it: the error is the one `ledgerly:` line.
  const errors = r.stderr.split('\n').filter((l) => l.startsWith('ledgerly:'));
  assert.equal(errors.length, 1, r.stderr);
  return errors[0]!;
}

test('roles.polish-after-states: each family\'s better after-state does what its proposal says, its worse one regresses the step, its neutral one changes nothing a person gains from', T, async () => {
  const at = (cell: PolishCell) => buildPolishFixture(cell);

  // Spacing: 4 px before; the better 24 px (--space-5); the worse 2 px, off the 4 px grid; the neutral the same 4 px, rewritten.
  const sp = cellsOf('spacing');
  const sb = at(sp.better);
  const gap = async (c: PolishCell) => fieldGap(at(c).after, sb.walk.milestone);
  const before = await fieldGap(sb.before, sb.walk.milestone);
  assert.deepEqual(before, { rule: 'var(--space-1)', px: 4 });
  assert.deepEqual(await gap(sp.better), { rule: 'var(--space-5)', px: 24 });
  const worse = await gap(sp.worse);
  assert.equal(worse.px, 2);
  assert.notEqual(worse.px % 4, 0, 'off the 4 px grid every margin is on');
  const neutral = await gap(sp.neutral);
  assert.equal(neutral.px, before.px, 'renders the same gap');
  assert.notEqual(neutral.rule, before.rule, 'though its text changed');

  // Hierarchy: Change limit quiet before; the better one primary; the worse one leads with the table (the figure is no longer first); the neutral one rewords the heading only.
  const hi = cellsOf('hierarchy');
  const hb = at(hi.better);
  const page0 = await budgetPage(hb.before, hb.walk.milestone);
  assert.match(page0.action, /\bbutton-quiet\b/);
  assert.ok(page0.cardFirst);
  assert.match(page0.heading, /^Entries in /);
  const better = await budgetPage(hb.after, hb.walk.milestone);
  assert.deepEqual([/\bbutton-primary\b/.test(better.action), better.cardFirst, better.heading], [true, true, page0.heading]);
  const lower = await budgetPage(at(hi.worse).after, hb.walk.milestone);
  assert.deepEqual([lower.action, lower.cardFirst, lower.heading], [page0.action, false, page0.heading]);
  const reworded = await budgetPage(at(hi.neutral).after, hb.walk.milestone);
  assert.deepEqual([reworded.action, reworded.cardFirst], [page0.action, true]);
  assert.match(reworded.heading, /^\S+ \d{4} entries$/);

  // CLI help: alphabetical commands before; the better in the order a ledger uses them (the command tree's); the worse
  // opens with the options and ends with the examples; the neutral rewords the descriptions only.
  const ch = cellsOf('cli-help');
  const cb = at(ch.better);
  const help0 = usage(cb.before);
  assert.deepEqual([help0.sections, help0.commands], [['Examples:', 'Commands:', 'Options:'], ['config', 'import', 'init', 'report']]);
  const help1 = usage(cb.after);
  assert.deepEqual([help1.sections, help1.commands], [help0.sections, ['init', 'import', 'report', 'config']]);
  assert.match(cb.after.get('design/cli.md')!, /init     \[--data <dir>\][\s\S]*import   <file\.csv>[\s\S]*report   --team[\s\S]*config   check/, 'the command tree it follows');
  const help2 = usage(at(ch.worse).after);
  assert.deepEqual([help2.sections, help2.commands], [['Options:', 'Commands:', 'Examples:'], help0.commands]);
  const help3 = usage(at(ch.neutral).after);
  assert.deepEqual([help3.sections, help3.commands], [help0.sections, help0.commands]);
  assert.notDeepEqual(help3.lines, help0.lines);
  assert.ok(help3.lines.every((l) => /^ {2}\S+\s+[A-Z][a-z]+s /.test(l)), help3.lines.join('\n'));

  // Error copy: the field without its fix before; the better names the field, how to fix it, the file and the line;
  // the worse names no field and no file; the neutral says what the before says, worded otherwise.
  const ec = cellsOf('error-copy');
  const eb = at(ec.better);
  const month = eb.walk.data.month;
  const err0 = importError(eb.before, month);
  assert.equal(err0, 'ledgerly: bad.csv:2: amount is not valid. Nothing was imported.');
  const err1 = importError(eb.after, month);
  assert.equal(err1, 'ledgerly: bad.csv:2: Amount must be a number above zero, like 120 or 120.50, without a currency sign. Nothing was imported.');
  const err2 = importError(at(ec.worse).after, month);
  assert.equal(err2, 'ledgerly: import failed (line 2)');
  assert.doesNotMatch(err2, /amount|bad\.csv|imported/i);
  const err3 = importError(at(ec.neutral).after, month);
  assert.equal(err3, 'ledgerly: bad.csv, line 2: amount is not valid. Nothing was imported.');
  assert.doesNotMatch(err3, /like 120/);
});

// ---------------------------------------------------------------------------------------------------
// The summary

function row(cell: PolishCell, trial: number, decision: 'keep' | 'drop' | null, extra: Partial<PolishRow> = {}): PolishRow {
  const correct = decision === null ? null : (decision === 'keep') === (cell.variant === 'better');
  return {
    set: 'dev', cell: cell.id, family: cell.family, variant: cell.variant, trial, judge: 'real', void: decision === null ? { reason: 'invalid', detail: 'x' } : null,
    decision, correct, reasons: [], usage: null, estimatedUsd: 0.5, wallMs: 60_000, turns: 20, load: 1000, calls: 1, models: ['claude-opus-5-5'],
    method: { available: [], tools: {}, browserCalls: 4, shellCalls: 2, subagents: [], denials: 0, unavailable: [] }, evidence: { files: 4, screenshots: 2 }, dir: '/x', ...extra,
  };
}
const crit = (s: PolishSummary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;
const runOf = (trial: number, decide: (c: PolishCell) => 'keep' | 'drop' | null) => DEV_POLISH_CELLS.map((c) => row(c, trial, decide(c)));
const oracle = (c: PolishCell) => (c.variant === 'better' ? 'keep' : 'drop');

test('roles.polish-summary: each run at 10/12 correct or better, no worse kept, stability over runs, voids, holdout gap; always-keep and always-drop each fail the bar', () => {
  const good = summarisePolish('dev', [0, 1, 2].flatMap((t) => runOf(t, oracle)), null, 'arm');
  for (const c of good.criteria) assert.equal(c.pass, true, `${c.name}: ${c.detail}`);
  assert.deepEqual(good.runs.map((r) => [r.correct, r.cells]), [[12, 12], [12, 12], [12, 12]]);
  assert.equal(good.keepRate.better.rate, 1);
  assert.equal(good.keepRate.neutral.rate, 0);

  const keepAll = summarisePolish('dev', runOf(0, () => 'keep'));
  assert.equal(crit(keepAll, 'accuracy'), false, '4/12');
  assert.equal(crit(keepAll, 'worse-kept'), false);
  const dropAll = summarisePolish('dev', runOf(0, () => 'drop'));
  assert.equal(crit(dropAll, 'accuracy'), false, '8/12');
  assert.equal(crit(dropAll, 'worse-kept'), true, 'dropping everything keeps no regression, and still fails');

  // Two wrong in a run passes (10/12); three fails (9/12); one kept worse after-state fails whatever the count.
  const wrong = (ids: readonly string[]) => (c: PolishCell) => (ids.includes(c.id) ? (oracle(c) === 'keep' ? 'drop' : 'keep') : oracle(c));
  assert.equal(crit(summarisePolish('dev', runOf(0, wrong(['SP-B', 'HI-N']))), 'accuracy'), true);
  assert.equal(crit(summarisePolish('dev', runOf(0, wrong(['SP-B', 'HI-N', 'CH-B']))), 'accuracy'), false);
  const kept = summarisePolish('dev', runOf(0, wrong(['EC-W'])));
  assert.deepEqual([crit(kept, 'accuracy'), crit(kept, 'worse-kept')], [true, false]);
  // Each run is held to the bar: one bad run of three fails.
  assert.equal(crit(summarisePolish('dev', [...runOf(0, oracle), ...runOf(1, wrong(['SP-B', 'HI-N', 'CH-B'])), ...runOf(2, oracle)]), 'accuracy'), false);
  // A void is not correct; voids over a quarter fail.
  const voided = summarisePolish('dev', runOf(0, (c) => (['SP-B', 'HI-B', 'CH-B', 'EC-B'].includes(c.id) ? null : oracle(c))));
  assert.deepEqual([crit(voided, 'accuracy'), crit(voided, 'voids')], [false, false]);
  // Stability: a cell's decisions the same in every graded trial, for 80% of the cells graded twice.
  const flip = summarisePolish('dev', [...runOf(0, oracle), ...runOf(1, wrong(['SP-B', 'HI-N', 'CH-N']))]);
  assert.deepEqual([flip.stability.same, flip.stability.cells, crit(flip, 'stability')], [9, 12, false]);
  // The holdout's accuracy within 15 points of dev's.
  const holdoutRows = DEV_POLISH_CELLS.slice(0, 6).map((c, i) => row({ ...c, id: `H${i}` }, 0, i < 4 ? oracle(c) : oracle(c) === 'keep' ? 'drop' : 'keep'));
  assert.equal(crit(summarisePolish('holdout', holdoutRows, good, 'arm'), 'holdout-gap'), false, '4/6 against 12/12');
});

// ---------------------------------------------------------------------------------------------------
// The harness end to end on degenerate judges

async function fakeRun(judge: string, cells: readonly string[], caps: Readonly<{ n?: number; cap?: number; trialCap?: number; parallel?: number }> = {}) {
  const out = join(tmpDir('polish-out'), 'run');
  const lines: string[] = [];
  const summary = await runPolish({
    set: 'dev', n: caps.n ?? 1, cells, parallel: caps.parallel ?? 2, config: null, out, compare: null, judge: judge as never, cap: caps.cap ?? null, trialCap: caps.trialCap ?? null,
  }, (l) => lines.push(l));
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as PolishRow);
  return { summary, rows, out, lines };
}

test('roles.polish-fakes: an oracle judge passes every criterion through the production compare; keep-all keeps a regression, drop-all drops the improvements, both fail; an answer refused after its repair turn voids the trial', T, async () => {
  const good = await fakeRun('oracle', DEV_POLISH_CELLS.map((c) => c.id));
  assert.ok(good.lines.includes('ARM polishJudge.arc frontier claude-opus-5-5:medium'), good.lines.join('\n'));
  for (const c of good.summary.criteria) assert.notEqual(c.pass, false, `${c.name}: ${c.detail}`);
  assert.equal(good.rows.length, 12);
  for (const r of good.rows) {
    assert.equal(r.void, null, `${r.cell}: ${JSON.stringify(r.void)}`);
    assert.equal(r.correct, true, r.cell);
    for (const file of ['key.json', 'prompt.txt', 'argv.json', 'compare-1.jsonl', 'transcript.jsonl', 'answer.json', 'row.json', 'evidence/before.txt', 'evidence/after.txt', 'evidence/server-before/serve.web.stdout', 'evidence/server-after/serve.web.stdout']) {
      assert.ok(existsSync(join(r.dir, file)), `${r.cell}: ${file}`);
    }
    const cell = cellOf(r.cell);
    const prompt = readFileSync(join(r.dir, 'prompt.txt'), 'utf8');
    assert.ok(!prompt.includes(good.out) && !prompt.includes('key.json'), 'the prompt never names the run dir or the key');
    assert.ok(prompt.includes(cell.proposal), `${r.cell}: the proposal`);
    assert.match(prompt, /<tweak_diff>[\s\S]*diff --git a\/design\//, `${r.cell}: the reference diff`);
    assert.match(prompt, /<before>\ncheckout: \S+\/compare-1\.before\n[\s\S]*<after>\ncheckout: \S+\/compare-1\.after\n/, `${r.cell}: both instances`);
    assert.doesNotMatch(prompt, /\{port:/);
    const argv = JSON.parse(readFileSync(join(r.dir, 'argv.json'), 'utf8')) as string[];
    const browser = cell.family === 'spacing' || cell.family === 'hierarchy';
    assert.equal(argv.includes('--mcp-config'), browser, `${r.cell}: MCP for a browser journey only`);
    assert.equal(existsSync(join(r.dir, 'mcp.json')), browser);
    assert.ok(argv.includes('--strict-mcp-config') && argv.includes('bypassPermissions'));
    const key = JSON.parse(readFileSync(join(r.dir, 'key.json'), 'utf8')) as { expected: string };
    assert.equal(key.expected, cell.variant === 'better' ? 'keep' : 'drop');
  }

  const keepAll = await fakeRun('keep-all', ['SP-W']);
  assert.deepEqual([crit(keepAll.summary, 'accuracy'), crit(keepAll.summary, 'worse-kept')], [false, false]);
  const dropAll = await fakeRun('drop-all', ['SP-B', 'CH-B']);
  assert.equal(crit(dropAll.summary, 'accuracy'), false);
  assert.deepEqual(dropAll.rows.map((r) => r.decision), ['drop', 'drop']);
  // An answer the compare refuses takes its one repair turn; refused again, the compare is abandoned and the trial void.
  const refused = await fakeRun('refused', ['EC-B']);
  assert.equal(refused.rows[0]!.calls, 2, 'the repair turn was taken');
  assert.equal(refused.rows[0]!.void?.reason, 'invalid', JSON.stringify(refused.rows[0]!.void));
  assert.match(refused.rows[0]!.void!.detail, /nowhere\.png, which is no file in the evidence dir/);
});

test('roles.polish-caps: --trial-cap kills an overspending judge (void cap, its estimate kept); --cap starts no trial past the spend', T, async () => {
  const over = await fakeRun('overspend', ['CH-B'], { trialCap: 1 });
  assert.equal(over.rows[0]!.void?.reason, 'cap', JSON.stringify(over.rows[0]!.void));
  assert.ok(over.rows[0]!.estimatedUsd >= 20);
  assert.ok(over.lines.some((l) => l.startsWith('BRAKE CH-B#0 cap')));
  const capped = await fakeRun('oracle', ['CH-B'], { n: 3, cap: 0.01, parallel: 2 });
  assert.equal(capped.rows.length, 2, 'two ran in parallel before the cap was reached');
  assert.deepEqual(capped.summary.capped, { capUsd: 0.01, notStarted: 1 });
});

test('roles.polish-seat: the arm is the polishJudge seat (frontier, Opus 5.5 medium); --rebind moves it through the repo config; a seat with no polishJudge prompt is refused', () => {
  assert.equal(polishSeat(null).arm, 'polishJudge.arc frontier claude-opus-5-5:medium');
  assert.equal(polishSeat(rebindConfig(['frontier=claude-opus-5-5:xhigh'])).arm, 'polishJudge.arc frontier (rebound) claude-opus-5-5:xhigh');
  assert.throws(() => polishSeat(rebindConfig(['frontier=claude-sonnet-5-5:high'])), /polishJudge/);
  assert.throws(() => polishSeat(rebindConfig(['frontier=gpt-5.6-sol:high'])), /Claude only|polishJudge|frontier/);
});
