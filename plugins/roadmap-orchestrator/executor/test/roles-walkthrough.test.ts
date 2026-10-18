// The walkthrough role eval's generator, plants, graders, summary and harness (evals/roles/walkthrough/), free: real
// products brought up and driven over HTTP and the CLI, degenerate fake walkers through run.ts. Named tests:
// roles.walk-gen-deterministic, roles.walk-cells, roles.walk-slots, roles.walk-plants (each slot's predicted effect,
// checked mechanically on the running product: the 404 route, the contrast ratio, the stylesheet, the exit codes and
// streams, the problem document, the warning, the CI report, the README as written), roles.walk-grading,
// roles.walk-summary, roles.walk-fakes (oracle, clean-report, cite-plants, flag-everything, breaks-everything and refused
// through run.ts, each trial an arc whose u1 merges and whose walk-1 runs through the production walk job),
// roles.walk-caps, roles.walk-seat, roles.walk-triggers. The products are brought up by the production bring-up
// (src/walk/bringup.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { type JobId, arcId, journeyId, visionClauseId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { sessionContainment } from '../src/contain/session.ts';
import { absPath, isoTimeOf, repoPath } from '../src/core/values.ts';
import { allocatePorts, bringUp, substitutePorts, tearDown } from '../src/walk/bringup.ts';
import type { WalkthroughOutput } from '../src/prompts/schemas.ts';
import { rebindConfig } from '../evals/roles/run.ts';
import { readTranscript } from '../evals/roles/transcript.ts';
import { triggeredRoles } from '../evals/roles/triggers.ts';
import { type WalkRow, walkSeat } from '../evals/roles/walkthrough/arc.ts';
import { DEV_WALK_CELLS } from '../evals/roles/walkthrough/cells.ts';
import { FAMILY_IDS, PAGE_INFO, PAGES, type FamilyId, pageFile, pagePath } from '../evals/roles/walkthrough/families.ts';
import { type SlotKey, VISION_JSON, type WalkCell, type WalkFixture, buildWalkFixture } from '../evals/roles/walkthrough/fixture.ts';
import { assignFindings, gradeWalk } from '../evals/roles/walkthrough/grade.ts';
import { baseFiles } from '../evals/roles/walkthrough/product.ts';
import { runWalk } from '../evals/roles/walkthrough/run.ts';
import { pageOf, assignSlots } from '../evals/roles/walkthrough/slots.ts';
import { type WalkSummary, summariseWalk } from '../evals/roles/walkthrough/summary.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: 600_000 };
/** The environment for the product's own `node --test` runs: without the runner's NODE_TEST_CONTEXT, which would make them report to this run. */
const PLAIN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

function writeProduct(f: WalkFixture): string {
  const dir = join(tmpDir('walk-product'), 'ledgerly');
  for (const [p, t] of f.files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}

test('roles.walk-gen-deterministic: a seed gives the same product and slots every time; seeds differ; every hook resolved; no file names the eval', () => {
  const words = /\b(plant(ed|s)?|twins?|slots?|defects?|evals?|needles?|answer key)\b/i;
  const families = /\bW\d{1,2}\b/;
  for (const cell of DEV_WALK_CELLS) {
    const a = buildWalkFixture(cell);
    const b = buildWalkFixture(cell);
    assert.deepEqual([...a.files], [...b.files], cell.id);
    assert.deepEqual(a.slots, b.slots, cell.id);
    for (const [path, text] of a.files) {
      assert.doesNotMatch(text, /\{\{[a-z-]+\}\}/, `${cell.id} ${path}: an unresolved hook`);
      assert.doesNotMatch(text, words, `${cell.id} ${path}: a word that names the eval`);
      assert.doesNotMatch(text, families, `${cell.id} ${path}: a family id`);
    }
    assert.ok(a.files.has('.gitignore') && !a.files.has('gitignore'));
  }
  const [s1, s2] = DEV_WALK_CELLS.map((c) => buildWalkFixture(c));
  assert.notDeepEqual(s1!.data, s2!.data);
  // The base product's hooks are exactly the generator's: a hook nothing fills, or a contribution to no hook, fails loud.
  assert.ok([...baseFiles().values()].some((t) => t.includes('{{dispatch}}')));
});

test('roles.walk-cells: each family is planted in exactly two of the four dev seeds (26 plants, 26 twins); no two seeds plant the same set', () => {
  for (const f of FAMILY_IDS) assert.equal(DEV_WALK_CELLS.filter((c) => c.planted.includes(f)).length, 2, f);
  assert.equal(DEV_WALK_CELLS.reduce((a, c) => a + c.planted.length, 0), 26);
  assert.equal(new Set(DEV_WALK_CELLS.map((c) => [...c.planted].sort().join(','))).size, 4);
  assert.ok(VISION_JSON.clauses.some((x) => x.kind === 'experience'));
  for (const c of DEV_WALK_CELLS) {
    const f = buildWalkFixture(c);
    assert.equal(f.slots.length, 13);
    assert.deepEqual(f.slots.filter((s) => s.state === 'plant').map((s) => s.family).sort(), [...c.planted].sort());
    assert.equal(f.milestone.journeys.length, 9);
    assert.deepEqual(f.milestone.journeys.map((j) => j.via), ['browser', 'browser', 'browser', 'shell', 'shell', 'shell', 'shell', 'shell', 'shell']);
  }
});

test('roles.walk-slots: one slot per page, W1 on a journey\'s last step, W7 on a form, W6 on a primary action, no plant behind W1\'s dead end; seeded', () => {
  for (let i = 0; i < 40; i++) {
    const planted = FAMILY_IDS.filter((_, k) => (i >> (k % 5)) % 2 === 1);
    const slots = assignSlots(`probe-${i}`, planted);
    assert.deepEqual(slots, assignSlots(`probe-${i}`, planted));
    const pages = slots.flatMap((s) => (pageOf(s) === null ? [] : [pageOf(s)]));
    assert.equal(new Set(pages).size, pages.length, `seed ${i}: two slots on a page`);
    const w1 = slots.find((s) => s.family === 'W1')!;
    assert.equal(w1.at.kind, 'flow');
    const w2 = slots.find((s) => s.family === 'W2')!;
    if (w2.state === 'twin') {
      assert.deepEqual(w2.at, { kind: 'page', page: 'statement-print' });
      assert.ok(!(w1.at.kind === 'flow' && w1.at.journey === 'J-3'), 'the print view behind W1\'s dead end');
    } else assert.notDeepEqual(w2.at, { kind: 'page', page: 'statement-print' });
    const w7 = slots.find((s) => s.family === 'W7')!;
    assert.ok(w7.at.kind === 'page' && PAGE_INFO[w7.at.page].form);
    const w6 = slots.find((s) => s.family === 'W6')!;
    assert.ok(w6.at.kind === 'page' && PAGE_INFO[w6.at.page].primary);
  }
  assert.throws(() => assignSlots('x', ['W99' as FamilyId]), /no family W99/);
});

// ---------------------------------------------------------------------------------------------------
// The plants' predicted effects, checked on the running product

type Up = Readonly<{ dir: string; f: WalkFixture; base: string; env: Readonly<Record<string, string>>; stop: () => Promise<void> }>;

/** The cell's product, brought up by the production bring-up (its spawns journalled under a walk job of a scratch log). */
async function up(cell: WalkCell): Promise<Up> {
  const f = buildWalkFixture(cell);
  const dir = writeProduct(f);
  const runDir = absPath(tmpDir('walk-up'));
  const journal = openJournal(runDir, arcId('t-walkup'));
  const ctx = { journal, containment: sessionContainment, runDir, hostEnv: process.env };
  const ports = await allocatePorts(f.milestone.bringUp.serve.map((x) => x.name));
  const end = await bringUp(ctx, {
    milestone: f.milestone, checkout: absPath(dir), ports, parent: { type: 'job', job: 'walk-1' as JobId }, key: 'bring-up:walk-1',
    logDir: absPath(join(runDir, 'server')), serveDeadlineAt: isoTimeOf(new Date(Date.now() + 15 * 60_000)),
  });
  if (end.kind !== 'up') throw new Error(`${cell.id}: the bring-up ended ${JSON.stringify(end)}`);
  const stop = async (): Promise<void> => {
    await tearDown(ctx, end.instance);
    journal.close();
  };
  return { dir, f, base: `http://127.0.0.1:${ports['web' as never]}`, env: end.instance.product.env, stop };
}

const cli = (u: Up, args: readonly string[], cwd = u.dir) =>
  spawnSync('node', ['bin/ledgerly.js', ...args], { cwd, env: { ...process.env, ...u.env }, encoding: 'utf8' });

// Every request on a fresh connection: a kept-alive one idle past the server's keep-alive timeout (a slow CLI or CI check
// in between) can be closed by the server just as it is reused.
const CLOSE = { connection: 'close' };
const get = async (u: Up, path: string): Promise<Response> => fetch(`${u.base}${path}`, { redirect: 'manual', headers: CLOSE });
const post = async (u: Up, path: string, form: Record<string, string>): Promise<Response> =>
  fetch(`${u.base}${path}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: CLOSE });

function hexOf(css: string, token: string): string {
  const m = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
  if (m === null) throw new Error(`no ${token} in tokens.css`);
  return m[1]!;
}
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** The README quickstart's commands (steps 1 to 3), as written, comments dropped. */
function quickstart(readme: string): readonly string[][] {
  return readme.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('node bin/ledgerly.js')).map((l) => l.replace(/\s+#.*$/, '').split(/\s+/));
}

async function checkSlot(u: Up, s: SlotKey): Promise<void> {
  const plant = s.state === 'plant';
  const month = u.f.data.month;
  const at = s.at;
  const label = `${u.f.cell.id} ${s.family} ${s.state} ${JSON.stringify(at)}`;
  const html = async (path: string): Promise<string> => {
    const r = await get(u, path);
    assert.equal(r.status, 200, `${label}: GET ${path}`);
    return r.text();
  };
  const appCss = readFileSync(join(u.dir, 'web/static/app.css'), 'utf8');
  const tokens = readFileSync(join(u.dir, 'design/tokens.css'), 'utf8');
  const paper = hexOf(tokens, '--ll-paper');
  const page = at.kind === 'page' ? at.page : null;
  switch (s.family) {
    case 'W1': {
      if (at.kind !== 'flow') throw new Error(label);
      const r = at.journey === 'J-1' ? (assert.match(await html('/entries/new'), /action="\/entries\/record"/), await post(u, '/entries/record', { team: 'platform', month, vendor: 'Hetzner', amount: '10' }))
        : at.journey === 'J-2' ? (assert.match(await html('/budgets/platform/edit'), /action="\/budgets\/platform\/limits"/), await post(u, '/budgets/platform/limits', { limit: '5000' }))
        : (assert.match(await html(`/statements/${month}`), new RegExp(`href="/statements/${month}/printable"`)), await get(u, `/statements/${month}/printable`));
      if (plant) assert.equal(r.status, 404, `${label}: the last step dead-ends`);
      else {
        assert.ok([302, 307].includes(r.status), `${label}: ${r.status}`);
        const to = r.headers.get('location')!;
        assert.equal(to, at.journey === 'J-1' ? '/entries' : at.journey === 'J-2' ? '/budgets/platform/limit' : `/statements/${month}/print`);
      }
      return;
    }
    case 'W2': {
      const text = await html(pagePath(page!, month));
      if (plant) {
        assert.match(text, /href="\/static\/ledgerly\.css"/, label);
        assert.equal((await get(u, '/static/ledgerly.css')).status, 404, `${label}: the stylesheet 404s`);
      } else {
        assert.equal(page, 'statement-print');
        assert.match(text, /print\.css/);
        assert.doesNotMatch(text, /app\.css/);
      }
      return;
    }
    case 'W3': {
      const text = await html(pagePath(page!, month));
      if (plant) {
        assert.match(text, /class="card card-tinted"/, label);
        const rule = /\.card-tinted \{([^}]*)\}/.exec(appCss)![1]!;
        const colour = /background: (#[0-9A-F]{6})/.exec(rule)![1]!;
        assert.ok(!tokens.toUpperCase().includes(colour.toUpperCase()), `${label}: ${colour} is off-token`);
        const padding = Number(/padding: (\d+)px/.exec(rule)![1]);
        assert.notEqual(padding % 4, 0, `${label}: ${padding}px is off the 4px grid`);
      } else {
        assert.match(text, /class="card card--highlight"/, label);
        assert.match(appCss, /\.card--highlight \{ background: var\(--ll-highlight\);[^}]*padding: var\(--space-4\)/);
      }
      return;
    }
    case 'W4': {
      const text = await html(pagePath(page!, month));
      if (plant) {
        assert.match(text, /getElementById\('month-filter'\)\.addEventListener/, label);
        assert.doesNotMatch(text, /id="month-filter"/, `${label}: the element the script needs is absent, so it throws on load`);
      } else assert.match(text, /console\.info\('ledgerly: [a-z-]+ view'\)/, label);
      return;
    }
    case 'W5': {
      const text = await html(pagePath(page!, month));
      if (plant) {
        assert.match(text, /class="lead lead-soft"/, label);
        const colour = /\.lead-soft \{ color: (#[0-9A-F]{6}); \}/.exec(appCss)![1]!;
        const ratio = contrast(colour, paper);
        assert.ok(ratio > 3.0 && ratio < 3.2, `${label}: body text at ${ratio.toFixed(2)}:1`);
      } else {
        assert.match(text, /<p class="caption">Amounts include tax/, label);
        const ratio = contrast(hexOf(tokens, '--ll-ink-muted'), paper);
        assert.ok(ratio >= 4.5 && ratio < 4.7, `${label}: the caption at ${ratio.toFixed(2)}:1`);
      }
      return;
    }
    case 'W6': {
      const text = await html(pagePath(page!, month));
      if (plant) {
        assert.match(text, /button-primary button-flat/, label);
        const rule = /\.button-flat:focus, \.button-flat:focus-visible \{([^}]*)\}/.exec(appCss)![1]!;
        assert.match(rule, /outline: none/);
        assert.doesNotMatch(rule, /box-shadow/, `${label}: no other focus indicator`);
      } else {
        assert.match(text, /button-primary button-ring/, label);
        assert.match(/\.button-ring:focus-visible \{([^}]*)\}/.exec(appCss)![1]!, /outline: none; box-shadow: [^;]*var\(--ll-focus\)/);
        assert.ok(contrast(hexOf(tokens, '--ll-focus'), paper) >= 3);
      }
      return;
    }
    case 'W7': {
      const r = page === 'entry-new' ? await post(u, '/entries', { team: 'platform', month, vendor: '', amount: 'abc' }) : await post(u, '/budgets/platform/limit', { limit: 'abc' });
      assert.equal(r.status, 422, label);
      const text = await r.text();
      if (plant) {
        assert.match(text, /<li>Invalid input<\/li>/, label);
        assert.doesNotMatch(text, /class="field-error"/, `${label}: no field is named`);
      } else {
        assert.match(text, page === 'entry-new' ? /Amount must be a number above zero/ : /Limit must be a whole amount/, label);
        assert.match(text, /class="field-error"/);
      }
      return;
    }
    case 'W8': {
      if (at.kind !== 'command') throw new Error(label);
      const bad = join(u.dir, 'bad.csv');
      writeFileSync(bad, `team,month,vendor,amount,note\nplatform,${month},Hetzner,abc,runners\n`);
      const fail = at.command === 'import' ? cli(u, ['import', 'bad.csv', '--data', 'var/ledger']) : cli(u, ['report', '--team', 'nope', '--data', 'var/ledger']);
      const ok = at.command === 'import' ? cli(u, ['import', `samples/${month}.csv`, '--data', 'var/ledger', '--dry-run']) : cli(u, ['report', '--team', 'platform', '--data', 'var/ledger']);
      assert.equal(ok.status, 0, `${label}: ${ok.stderr}`);
      assert.match(ok.stdout, at.command === 'import' ? /^Would add/ : /Total:/);
      if (plant) {
        assert.equal(fail.status, 0, `${label}: a failure exits 0`);
        assert.match(fail.stdout, /^ledgerly: /, `${label}: the error on stdout`);
        assert.equal(fail.stderr, '');
      } else {
        assert.equal(fail.status, 3, label);
        assert.equal(fail.stdout, '');
        assert.match(ok.stderr, at.command === 'import' ? /^Reading .*\nChecked \d+ rows\n$/ : /^Reading the ledger in var\/ledger\n\d+ entries for platform in /, `${label}: progress on stderr`);
      }
      return;
    }
    case 'W9': {
      const create = async (entry: Record<string, string | number>): Promise<[Response, Record<string, unknown>]> => {
        const r = await fetch(`${u.base}/api/v1/entries`, {
          method: 'POST', headers: { ...CLOSE, authorization: `Bearer ${u.env['LEDGERLY_API_TOKEN']}`, 'content-type': 'application/json' },
          body: JSON.stringify(entry),
        });
        return [r, (await r.json()) as Record<string, unknown>];
      };
      const [r, body] = await create({ team: 'platform', month: 'Sept', vendor: 'Hetzner', amount: '12,50' });
      // A body with fields the API does not know is refused through the same response, never stored with them dropped.
      const [ru, unknown] = await create({ team: 'platform', month, vendor: 'Hetzner', amount: '12.50', notes: 'runners', currency: 'EUR' });
      // A JSON number amount is refused (amounts are decimal strings, never floats), never recorded.
      const [rn, numeric] = await create({ team: 'platform', month, vendor: 'Hetzner', amount: 12.5 });
      if (plant) {
        assert.equal(r.status, 200, label);
        assert.equal(typeof body['error'], 'string');
        assert.equal(ru.status, 200, label);
        assert.match(String(unknown['error']), /notes is not an entry field/);
        assert.equal(rn.status, 200, label);
        assert.match(String(numeric['error']), /Amount must be a decimal string/);
      } else {
        assert.equal(r.status, 422, label);
        assert.equal(r.headers.get('content-type'), 'application/problem+json');
        assert.equal(body['type'], 'https://ledgerly.dev/problems/invalid-entry');
        assert.deepEqual((body['invalid_params'] as { name: string }[]).map((x) => x.name), ['month', 'amount']);
        assert.equal(ru.status, 422, label);
        assert.deepEqual((unknown['invalid_params'] as { name: string }[]).map((x) => x.name), ['notes', 'currency']);
        assert.equal(rn.status, 422, label);
        assert.deepEqual(numeric['invalid_params'], [{ name: 'amount', reason: 'Amount must be a decimal string, like "120.50", not a JSON number.' }]);
      }
      return;
    }
    case 'W10': {
      const conf = readFileSync(join(u.dir, 'ledgerly.conf'), 'utf8').replace('alert_at', 'alerts_at');
      writeFileSync(join(u.dir, 'edited.conf'), conf);
      const line = conf.split('\n').findIndex((l) => l.startsWith('alerts_at')) + 1;
      const r = cli(u, ['config', 'check', '--file', 'edited.conf']);
      assert.equal(r.status, 0, label);
      if (plant) assert.equal(r.stderr, '', `${label}: the unknown key passes in silence`);
      else assert.match(r.stderr, new RegExp(`^warning: edited\\.conf:${line}: unknown key "alerts_at" in \\[team\\.platform\\], ignored; did you mean "alert_at"\\?`), label);
      return;
    }
    case 'W11': {
      const none = cli(u, []);
      const typo = cli(u, ['reprot', '--team', 'platform', '--data', 'var/ledger']);
      if (plant) {
        assert.equal(none.status, 1, label);
        assert.match(none.stderr, /TypeError[\s\S]*\n\s+at /, `${label}: a stack trace`);
        assert.equal(typo.status, 0);
        assert.match(typo.stdout, /Total:/, `${label}: the typo ran report`);
      } else {
        assert.equal(none.status, 2, label);
        assert.ok(none.stderr.indexOf('Examples:') < none.stderr.indexOf('Commands:') && none.stderr.indexOf('Examples:') > 0, `${label}: examples first`);
        assert.equal(typo.status, 2);
        assert.equal(typo.stdout, '');
        assert.match(typo.stderr, /unknown command "reprot"; did you mean "report"\?/);
        const far = cli(u, ['xyz']);
        assert.equal(far.status, 2);
        assert.equal(far.stderr, 'ledgerly: unknown command "xyz"; run "ledgerly --help" for every command.\n', label);
      }
      return;
    }
    case 'W12': {
      const copy = join(tmpDir('walk-ci'), 'ledgerly');
      cpSync(u.dir, copy, { recursive: true });
      const green = spawnSync('node', ['ci/run.js'], { cwd: copy, encoding: 'utf8', env: PLAIN_ENV });
      assert.equal(green.status, 0, `${label}: ${green.stdout}`);
      assert.match(green.stdout, /Pipeline passed/);
      const t = join(copy, 'test/money.test.js');
      writeFileSync(t, readFileSync(t, 'utf8').replace("assert.equal(parseAmount('120'), 12000)", "assert.equal(parseAmount('120'), 1)"));
      const red = spawnSync('node', ['ci/run.js'], { cwd: copy, encoding: 'utf8', env: PLAIN_ENV });
      assert.equal(red.status, 1, label);
      if (plant) {
        assert.equal(red.stdout.trim().split('\n').at(-1), 'exit 1', label);
        assert.doesNotMatch(red.stdout, /money\.test\.js|unit/, `${label}: names neither the step nor the file`);
      } else {
        // The failure cites the line holding the step's command, as design/ci.md's golden output does.
        const runLine = readFileSync(join(copy, 'ci/pipeline.yml'), 'utf8').split('\n').indexOf('    run: node --test test/*.test.js') + 1;
        assert.ok(runLine > 0);
        assert.match(red.stdout, new RegExp(`Step "unit" failed \\(ci/pipeline\\.yml:${runLine}\\): node --test test/\\*\\.test\\.js\n`), label);
        assert.match(readFileSync(join(copy, 'design/ci.md'), 'utf8'), new RegExp(`Step "unit" failed \\(ci/pipeline\\.yml:${runLine}\\)`), `${label}: the golden output agrees`);
        assert.match(red.stdout, /test\/money\.test\.js/);
        assert.match(red.stdout, /rerun it locally: node --test test\/money\.test\.js/);
        // Each failing test by its file and line, its name and its error, as the golden output shows.
        assert.match(red.stdout, /\n {4}test at test\/money\.test\.js:\d+:\d+\n {4}✖ amounts parse into minor units \(/, `${label}: the failing test named`);
        assert.match(red.stdout, /AssertionError \[ERR_ASSERTION\]/);
        assert.match(readFileSync(join(copy, 'design/ci.md'), 'utf8'), /\n {4}test at test\/report\.test\.js:\d+:1\n {4}✖ /, `${label}: the golden output shows it`);
      }
      return;
    }
    case 'W13': {
      const copy = join(tmpDir('walk-readme'), 'ledgerly');
      cpSync(u.dir, copy, { recursive: true, filter: (src) => !src.startsWith(join(u.dir, 'var')) });
      const cmds = quickstart(readFileSync(join(copy, 'README.md'), 'utf8'));
      assert.equal(cmds.length, 3, label);
      const runs = cmds.map((argv) => spawnSync(argv[0]!, argv.slice(1), { cwd: copy, encoding: 'utf8' }));
      if (plant) assert.ok(runs.some((r) => r.status === 2 && /unknown option --(data-dir|period)/.test(r.stderr)), `${label}: a command fails as written`);
      else {
        for (const r of runs) assert.equal(r.status, 0, `${label}: ${r.stderr}`);
        assert.match(readFileSync(join(copy, 'README.md'), 'utf8'), /# add --(force|json)/);
      }
      return;
    }
  }
}

test('roles.walk-plants: on every dev seed\'s running product, each slot does what its plant or twin predicts, and the rest of the product is clean', T, async () => {
  for (const cell of DEV_WALK_CELLS) {
    const u = await up(cell);
    try {
      for (const s of u.f.slots) await checkSlot(u, s);
      // Clean everywhere else: every page answers 200 and loads its stylesheets, but a planted W2 page's.
      const w2 = u.f.slots.find((s) => s.family === 'W2')!;
      for (const p of PAGES) {
        const r = await get(u, pagePath(p, u.f.data.month));
        assert.equal(r.status, 200, `${cell.id} ${p}`);
        const text = await r.text();
        if (!(w2.state === 'plant' && w2.at.kind === 'page' && w2.at.page === p) && p !== 'statement-print') assert.match(text, /href="\/static\/app\.css"/, `${cell.id} ${p}`);
        if (p !== 'statement-print') assert.equal(text.match(/<section class="card[ "]/g)?.length, 1, `${cell.id} ${p}: one card`);
      }
      // The overview follows the reference's layout too: one card, holding the page's figure and its primary action.
      const overview = await (await get(u, '/')).text();
      assert.match(overview, /<section class="card" aria-label="This month">\s*<p class="card-figure">[^<]* spent of [^<]* across 3 teams\.<\/p>\s*<p><a class="button button-primary" href="\/entries\/new">Record entry<\/a><\/p>\s*<\/section>/, `${cell.id}: the overview's card`);
      // On an empty ledger, Budgets invites the next action (DESIGN.md: "Empty states invite the next action"): it says nothing
      // is recorded, offers Record entry, and still lists every team with its limit and a way to change it.
      assert.equal(cli(u, ['init', '--data', 'var/empty']).status, 0);
      const render = "const { loadConfig } = await import('./src/config.js'); const { openLedger } = await import('./src/ledger.js');"
        + " const { get } = await import('./web/pages/budgets.js'); process.stdout.write(get({ config: loadConfig().config, ledger: openLedger('var/empty') }).html);";
      const empty = spawnSync('node', ['--input-type=module', '-e', render], { cwd: u.dir, encoding: 'utf8' });
      assert.equal(empty.status, 0, empty.stderr);
      assert.match(empty.stdout, /<p class="card-figure">No spend recorded yet: 3 teams, nothing against their limits\.<\/p>/, `${cell.id}: the empty Budgets names what is missing`);
      assert.match(empty.stdout, /<a class="button button-primary" href="\/entries\/new">Record entry<\/a>/, `${cell.id}: and the next action`);
      for (const t of u.f.data.teams) assert.match(empty.stdout, new RegExp(`href="/budgets/${t.id}">[^<]+</a></h2>\\s*<p>Limit: <span class="figure">[^<]+</span> a month\\. <a href="/budgets/${t.id}/edit">Change limit</a>`), `${cell.id}: ${t.id} listed with its limit`);
      // A list parameter the API does not know is refused, each named, never ignored (design/api.md, "Errors").
      const stray = await fetch(`${u.base}/api/v1/entries?mnth=${u.f.data.month}&team=platform&colour=red`, { headers: { ...CLOSE, authorization: `Bearer ${u.env['LEDGERLY_API_TOKEN']}` } });
      assert.equal(stray.status, 400, `${cell.id}: an unknown list parameter`);
      const strayBody = (await stray.json()) as { type: string; invalid_params: { name: string }[] };
      assert.equal(strayBody.type, 'https://ledgerly.dev/problems/invalid-query');
      assert.deepEqual(strayBody.invalid_params.map((x) => x.name), ['mnth', 'colour']);
      for (const asset of ['/static/app.css', '/static/tokens.css', '/static/print.css', '/static/favicon.svg', '/favicon.ico']) assert.equal((await get(u, asset)).status, 200, asset);
      // The other two journeys' last steps go where they should.
      const w1 = u.f.slots.find((s) => s.family === 'W1')!;
      if (!(w1.at.kind === 'flow' && w1.at.journey === 'J-1')) {
        const r = await post(u, '/entries', { team: 'platform', month: u.f.data.month, vendor: 'Hetzner', amount: '10.50' });
        assert.equal(r.status, 303);
        assert.match(r.headers.get('location')!, /^\/entries\/e-\d{4}\?recorded=1$/);
      }
      assert.equal(spawnSync('node', ['--test', 'test/*.test.js'], { cwd: u.dir, encoding: 'utf8', env: PLAIN_ENV }).status, 0, `${cell.id}: the product's own tests`);
    } finally {
      await u.stop();
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// Grading and the summary over scripted answers

type Finding = WalkthroughOutput['findings'][number];
const cellOf = (id: string): WalkCell => DEV_WALK_CELLS.find((c) => c.id === id)!;
const slotOf = (f: WalkFixture, family: FamilyId): SlotKey => f.slots.find((s) => s.family === family)!;

function finding(journey: string, cls: Finding['class'], claim: string, paths: readonly string[] = []): Finding {
  return {
    class: cls, journey: journeyId(journey), evidence: ['shot.png'], claim, cause: 'because', paths: paths.map((p) => repoPath(p)),
    against: cls === 'breaks' ? { type: 'journey' } : { type: 'vision', clause: visionClauseId('V-5') },
  };
}
function answer(findings: readonly Finding[], polish = 0): WalkthroughOutput {
  return {
    final: true, journeys: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ journey: journeyId(`J-${n}`), outcome: 'completed' as const, evidence: ['a.png'], note: '' })),
    findings, premises: [], reasons: [],
    polish: Array.from({ length: polish }, (_, i) => ({ journey: journeyId('J-1'), evidence: ['a.png'], text: 'tighter spacing', unit: { id: `x${i}` as never, scope: [], spec: '' } })),
  };
}
/** A transcript whose session visited `urls` in the browser and ran `commands` in a shell (and Read `reads`). */
function transcriptOf(urls: readonly string[], commands: readonly string[], reads: readonly string[] = []) {
  const calls = [
    ...urls.map((url) => ({ name: 'mcp__playwright__browser_navigate', input: { url } })),
    ...commands.map((command) => ({ name: 'Bash', input: { command } })),
    ...reads.map((file_path) => ({ name: 'Read', input: { file_path } })),
  ];
  return readTranscript(calls.map((c, i) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, ...c }], usage: { input_tokens: 1, output_tokens: 1 } } })));
}

test('roles.walk-grading: caught, misclassed, lucky, false-blocking, twin false positives and stray findings, localised by paths, routes and words', () => {
  const f = buildWalkFixture(cellOf('S1'));
  const base = 'http://127.0.0.1:4000';
  const w5 = slotOf(f, 'W5');
  if (w5.at.kind !== 'page') throw new Error('W5 off a page');
  const w5Journey = PAGE_INFO[w5.at.page].journey;
  const visited = transcriptOf(PAGES.map((p) => `${base}${pagePath(p, f.data.month)}`), ['curl -s http://127.0.0.1:4000/api/v1/entries', 'node bin/ledgerly.js', 'node bin/ledgerly.js init --data .ledgerly', 'node ci/run.js', 'node bin/ledgerly.js config check']);
  const verdict = (g: ReturnType<typeof gradeWalk>, fam: FamilyId) => g.slots.find((s) => s.family === fam)!;

  // A contrast floor caught by path, as breaks; the same as deviates is misclassed; without a visit it is lucky.
  const byPath = finding(w5Journey, 'breaks', 'the lead text is hard to read', [pageFile(w5.at.page)]);
  assert.equal(verdict(gradeWalk(f.slots, visited, answer([byPath])), 'W5').verdict, 'caught');
  assert.equal(verdict(gradeWalk(f.slots, visited, answer([{ ...byPath, class: 'deviates', against: { type: 'vision', clause: visionClauseId('V-6') } }])), 'W5').verdict, 'misclassed');
  assert.equal(verdict(gradeWalk(f.slots, transcriptOf([], [], [`/x/${pageFile(w5.at.page)}`]), answer([byPath])), 'W5').verdict, 'lucky', 'a Read of the source is no visit');
  // A visit inside a browser script names no route, but it names the screenshot the finding cites: that is a visit; a Read
  // of the same file is not.
  const shot = { ...byPath, evidence: [`${w5Journey}/04-lead.png`] };
  const scripted = readTranscript([{ type: 'assistant', parent_tool_use_id: null, message: { id: 'ms', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'ts', name: 'mcp__playwright__browser_run_code_unsafe', input: { code: `async (page) => { await page.click('a'); await page.screenshot({ path: D + '${w5Journey}/04-lead.png' }); }` } }], usage: { input_tokens: 1, output_tokens: 1 } } }]);
  assert.equal(verdict(gradeWalk(f.slots, scripted, answer([shot])), 'W5').verdict, 'caught', 'the cited screenshot was taken by acting');
  assert.equal(verdict(gradeWalk(f.slots, transcriptOf([], [], [`/ev/${w5Journey}/04-lead.png`]), answer([shot])), 'W5').verdict, 'lucky', 'reading the screenshot is no visit');
  // A finding on another journey does not localise to the slot.
  assert.equal(verdict(gradeWalk(f.slots, visited, answer([{ ...byPath, journey: journeyId('J-8') }])), 'W5').verdict, 'missed');

  // The API error model (a contract: breaks) localised by its words alone; as deviates it is misclassed.
  const contract = { type: 'contract', path: repoPath('design/api.md'), anchor: 'Errors', dependents: 'every tool that records entries' } as const;
  const api = finding('J-6', 'breaks', 'POST /api/v1/entries answers 200 with an error body instead of a problem document');
  const g1 = gradeWalk(f.slots, visited, answer([{ ...api, against: contract }]));
  assert.deepEqual([verdict(g1, 'W9').verdict, verdict(g1, 'W9').falseBlocking], ['caught', false]);
  const g2 = gradeWalk(f.slots, visited, answer([{ ...api, class: 'deviates', against: { type: 'design', path: repoPath('design/api.md'), anchor: 'Errors' } }]));
  assert.equal(verdict(g2, 'W9').verdict, 'misclassed');
  // A README stale against a correct cli.md is deviates; as breaks it is caught but false-blocking.
  const docs = finding('J-9', 'deviates', 'the README quickstart command fails as written');
  const g4 = gradeWalk(f.slots, visited, answer([docs]));
  assert.deepEqual([verdict(g4, 'W13').verdict, verdict(g4, 'W13').falseBlocking], ['caught', false]);
  const g5 = gradeWalk(f.slots, visited, answer([{ ...docs, class: 'breaks', against: { type: 'journey' } }]));
  assert.deepEqual([verdict(g5, 'W13').verdict, verdict(g5, 'W13').falseBlocking], ['caught', true]);

  // A finding on a twin is a false positive (false-blocking when breaks); a finding off every slot is stray.
  const twin = f.slots.find((s) => s.state === 'twin' && s.family === 'W2')!;
  const onTwin = finding('J-3', 'breaks', 'the print view has no styling at all', [pageFile('statement-print')]);
  const stray = finding('J-6', 'breaks', 'the teams list is not sorted by name');
  const g3 = gradeWalk(f.slots, visited, answer([onTwin, stray], 2));
  assert.equal(twin.state, 'twin');
  assert.deepEqual([verdict(g3, 'W2').verdict, verdict(g3, 'W2').falseBlocking], ['false-positive', true]);
  assert.deepEqual(g3.stray, { findings: 1, breaks: 1 });
  assert.equal(g3.polish, 2);
  for (const s of g3.slots.filter((x) => x.family !== 'W2')) assert.ok(['missed', 'clean'].includes(s.verdict), `${s.family} ${s.verdict}`);

  // A tie between a planted slot and a twin on the same journey goes to the plant (S2: W13 planted, W11 its twin).
  const s2 = buildWalkFixture(cellOf('S2'));
  assert.equal(slotOf(s2, 'W13').state, 'plant');
  assert.equal(slotOf(s2, 'W11').state, 'twin');
  const tie = finding('J-9', 'breaks', 'the README shows a usage that fails');
  const owner = assignFindings([tie], s2.slots)[0];
  assert.ok(owner !== null && owner !== undefined);
  assert.equal(s2.slots[owner]!.family, 'W13');
});

function row(cell: string, trial: number, verdicts: Partial<Record<FamilyId, string>>, extra: Partial<WalkRow> = {}): WalkRow {
  return {
    set: 'dev', cell, trial, walker: 'oracle', void: null, usage: null, estimatedUsd: 1, wallMs: 1000, turns: 1, load: 1, models: [],
    method: { available: [], tools: {}, browserCalls: 0, shellCalls: 0, subagents: [], denials: 0, unavailable: [] }, evidence: { files: 0, screenshots: 0 }, dir: '', calls: 1,
    graded: {
      findings: 0, stray: { findings: 0, breaks: 0 }, polish: 0, blocked: 0,
      slots: FAMILY_IDS.map((family) => {
        const v = verdicts[family] ?? 'clean';
        const [verdict, fb] = v.split('!') as [string, string | undefined];
        return { family, state: ['clean', 'false-positive'].includes(verdict) ? 'twin' as const : 'plant' as const, verdict: verdict as never, falseBlocking: fb !== undefined, findings: [], exercised: true };
      }),
    },
    ...extra,
  };
}
const crit = (s: WalkSummary, name: string): boolean | null => s.criteria.find((c) => c.name === name)!.pass;

test('roles.walk-summary: recall with its Wilson bound, family catches, twin false positives against 3/78, false-blocking, stability over runs, voids, holdout gap', () => {
  const all = Object.fromEntries(FAMILY_IDS.map((f) => [f, 'caught'])) as Record<FamilyId, string>;
  const perfect = [0, 1, 2].flatMap((t) => ['S1', 'S2'].map((c) => row(c, t, all)));
  const s = summariseWalk('dev', perfect, null, 'arm');
  for (const name of ['recall', 'family-catches', 'zero-lucky', 'false-blocking', 'stability', 'voids', 'cost-check']) assert.equal(crit(s, name), true, name);
  assert.equal(crit(s, 'twin-fp'), null, 'no twin graded');
  assert.equal(s.recall.k, 78);
  assert.ok(s.recall.low !== null && s.recall.low > 0.9);

  // One family missed everywhere: recall 12/13 holds, family-catches fails; a lucky catch fails zero-lucky.
  const missW4 = summariseWalk('dev', perfect.map((r) => row(r.cell, r.trial, { ...all, W4: 'missed' })));
  assert.equal(crit(missW4, 'recall'), true);
  assert.equal(crit(missW4, 'family-catches'), false);
  assert.equal(crit(summariseWalk('dev', [row('S1', 0, { ...all, W1: 'lucky' })]), 'zero-lucky'), false);

  // Twins: 3 false positives in 78 pass, 4 fail.
  const twins = (fps: number): WalkRow[] => Array.from({ length: 6 }, (_, t) => row('S1', t, Object.fromEntries(FAMILY_IDS.map((f, i) => [f, t * 13 + i < fps ? 'false-positive' : 'clean']))));
  assert.equal(crit(summariseWalk('dev', twins(3)), 'twin-fp'), true);
  assert.equal(crit(summariseWalk('dev', twins(4)), 'twin-fp'), false);

  // False-blocking: on a slot, or a stray breaks.
  assert.equal(crit(summariseWalk('dev', [row('S1', 0, { ...all, W7: 'caught!' })]), 'false-blocking'), false);
  const strayRow = row('S1', 0, all);
  assert.equal(crit(summariseWalk('dev', [{ ...strayRow, graded: { ...strayRow.graded!, stray: { findings: 1, breaks: 1 } } }]), 'false-blocking'), false);

  // Stability: 13 pairs; three of them flip between runs: 10/13 = 77% fails, two flipping 11/13 = 85% passes.
  const flips = (n: number): WalkRow[] => [0, 1, 2].map((t) => row('S1', t, Object.fromEntries(FAMILY_IDS.map((f, i) => [f, i < n && t === 1 ? 'missed' : 'caught']))));
  assert.equal(crit(summariseWalk('dev', flips(3)), 'stability'), false);
  assert.equal(crit(summariseWalk('dev', flips(2)), 'stability'), true);

  // Voids: over a quarter fails; the holdout gap compares recall.
  const voided: WalkRow = { ...row('S1', 3, all), void: { reason: 'bring-up', detail: 'x' }, graded: null };
  assert.equal(crit(summariseWalk('dev', [row('S1', 0, all), row('S1', 1, all), voided]), 'voids'), false);
  const holdout = summariseWalk('holdout', [row('H1', 0, { ...all, W1: 'missed', W2: 'missed', W3: 'missed' })], s, 'arm');
  assert.equal(crit(holdout, 'holdout-gap'), false, '10/13 against 13/13');
});

// ---------------------------------------------------------------------------------------------------
// The harness end to end on degenerate walkers

async function fakeRun(walker: string, cells: readonly string[], caps: Readonly<{ n?: number; cap?: number; trialCap?: number }> = {}) {
  const out = join(tmpDir('walk-out'), 'run');
  const lines: string[] = [];
  const summary = await runWalk({
    set: 'dev', n: caps.n ?? 1, cells, parallel: 2, config: null, out, compare: null, walker: walker as never, cap: caps.cap ?? null, trialCap: caps.trialCap ?? null,
  }, (l) => lines.push(l));
  const rows = readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as WalkRow);
  return { summary, rows, out, lines };
}

test('roles.walk-fakes: an oracle walker passes every criterion; clean-report misses all, cite-plants is lucky, flag-everything cries wolf on twins, breaks-everything blocks, a report refused after its repair turn voids the trial', T, async () => {
  const oracle = await fakeRun('oracle', DEV_WALK_CELLS.map((c) => c.id));
  assert.ok(oracle.lines.includes('ARM walkthrough.arc frontier claude-opus-5-5:medium'), oracle.lines.join('\n'));
  for (const c of oracle.summary.criteria) assert.notEqual(c.pass, false, `${c.name}: ${c.detail}`);
  assert.equal(oracle.summary.recall.k, 26);
  for (const r of oracle.rows) {
    assert.equal(r.void, null, JSON.stringify(r.void));
    assert.equal(r.calls, 1);
    for (const file of ['key.json', 'prompt.txt', 'argv.json', 'walk-1.jsonl', 'transcript.jsonl', 'answer.json', 'row.json', 'evidence/notes.md', 'evidence/server/serve.web.stdout']) assert.ok(existsSync(join(r.dir, file)), `${r.cell}: ${file}`);
    const prompt = readFileSync(join(r.dir, 'prompt.txt'), 'utf8');
    assert.ok(!prompt.includes(oracle.out) && !prompt.includes('key.json'), 'the prompt never names the run dir or the key');
    const argv = JSON.parse(readFileSync(join(r.dir, 'argv.json'), 'utf8')) as string[];
    assert.ok(argv.includes('--mcp-config'));
    const mcp = JSON.parse(readFileSync(join(r.dir, 'mcp.json'), 'utf8')) as { mcpServers: { playwright: { args: string[] } } };
    assert.deepEqual(mcp.mcpServers.playwright.args.slice(0, 4), ['--headless', '--isolated', '--browser', 'chromium']);
    assert.ok(mcp.mcpServers.playwright.args.includes('1280x800') && !mcp.mcpServers.playwright.args.some((a) => a.includes('{')), 'substituted');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash,Write,Edit,Agent');
    assert.ok(argv.includes('--strict-mcp-config') && argv.includes('bypassPermissions'));
    // The journeys' entries reach the session with their ports.
    assert.match(prompt, /http:\/\/127\.0\.0\.1:\d+\/entries/);
    assert.doesNotMatch(prompt, /\{port:/);
  }

  const clean = await fakeRun('clean-report', ['S1']);
  assert.equal(crit(clean.summary, 'recall'), false);
  assert.equal(crit(clean.summary, 'twin-fp'), true);
  const lucky = await fakeRun('cite-plants', ['S1']);
  assert.equal(crit(lucky.summary, 'zero-lucky'), false);
  assert.equal(lucky.summary.recall.k, 0, 'a lucky catch is no catch');
  const wolf = await fakeRun('flag-everything', ['S1', 'S2']);
  assert.equal(crit(wolf.summary, 'twin-fp'), false);
  assert.ok(wolf.summary.cells.every((c) => c.misclassed > 0), 'breaks-expected plants reported as deviates');
  assert.equal(crit(wolf.summary, 'false-blocking'), true);
  const blocker = await fakeRun('breaks-everything', ['S2']);
  assert.equal(crit(blocker.summary, 'false-blocking'), false);
  // A report the walk job refuses takes its one repair turn; refused again, the walk is abandoned and the trial void.
  const refused = await fakeRun('refused', ['S3']);
  assert.equal(refused.rows[0]!.calls, 2, 'the repair turn was taken');
  assert.equal(refused.rows[0]!.void?.reason, 'invalid', JSON.stringify(refused.rows[0]!.void));
  assert.match(refused.rows[0]!.void!.detail, /nowhere\.png, which is no file in the evidence dir/);
});

test('roles.walk-caps: --trial-cap kills an overspending session (void cap, its estimate kept); --cap starts no trial past the spend', T, async () => {
  const over = await fakeRun('overspend', ['S1'], { trialCap: 1 });
  assert.equal(over.rows[0]!.void?.reason, 'cap', JSON.stringify(over.rows[0]!.void));
  assert.ok(over.rows[0]!.estimatedUsd >= 20);
  assert.ok(over.lines.some((l) => l.startsWith('BRAKE S1#0 cap')));
  const capped = await fakeRun('oracle', ['S1'], { n: 3, cap: 0.01 });
  assert.equal(capped.rows.length, 2, 'two ran in parallel before the cap was reached');
  assert.deepEqual(capped.summary.capped, { capUsd: 0.01, notStarted: 1 });
});

test('roles.walk-seat: the arm is the walkthrough seat (frontier, Opus 5.5 medium); --rebind moves it through the repo config; a seat with no walkthrough prompt is refused', () => {
  assert.equal(walkSeat(null).arm, 'walkthrough.arc frontier claude-opus-5-5:medium');
  assert.equal(walkSeat(rebindConfig(['frontier=claude-opus-5-5:xhigh'])).arm, 'walkthrough.arc frontier (rebound) claude-opus-5-5:xhigh');
  assert.throws(() => walkSeat(rebindConfig(['frontier=claude-sonnet-5-5:high'])), /walkthrough/);
  assert.throws(() => walkSeat(rebindConfig(['frontier=gpt-5.6-sol:high'])), /Claude only|walkthrough|frontier/);
  assert.equal(substitutePorts('http://127.0.0.1:{port:web}/x', { web: 4100 } as never), 'http://127.0.0.1:4100/x');
  assert.throws(() => substitutePorts('{port:api}', { web: 1 } as never), /names no allocated port/);
});

test('roles.walk-triggers: walkthrough paths trigger the walkthrough eval; the bring-up, the MCP config and the product the polish judge\'s too; the compare and the polish revision only the polish judge; the shared harness every role; the gate\'s own paths only the gate', () => {
  assert.deepEqual(triggeredRoles(['src/prompts/walkthrough/claude-opus-5-5.ts']), ['walkthrough']);
  for (const p of ['src/walk/walk.ts', 'src/walk/report.ts', 'src/walk/milestones.ts']) assert.deepEqual(triggeredRoles([p]), ['walkthrough'], p);
  for (const p of ['src/walk/bringup.ts', 'src/backends/mcp.ts']) assert.deepEqual(triggeredRoles([p]), ['walkthrough', 'polishJudge'], p);
  assert.deepEqual(triggeredRoles(['evals/roles/walkthrough/ledgerly/web/pages/entries.js']), ['walkthrough', 'polishJudge']);
  assert.deepEqual(triggeredRoles(['src/backends/argv.ts']), ['gate', 'walkthrough', 'polishJudge']);
  assert.deepEqual(triggeredRoles(['evals/roles/run.ts']), ['gate', 'walkthrough', 'polishJudge']);
  assert.deepEqual(triggeredRoles(['evals/roles/gate/arc.ts', 'evals/roles/gen/plant.ts']), ['gate']);
  for (const p of ['src/prompts/polishJudge/claude-opus-5-5.ts', 'src/walk/compare.ts', 'src/walk/polish.ts', 'evals/roles/polish/arc.ts']) assert.deepEqual(triggeredRoles([p]), ['polishJudge'], p);
});
