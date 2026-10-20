// The M5 fixture (evals/m5/), tested without paying: M5 has no scripted root agent (evals/README.md "The M5 fixture"),
// so its free tier is the fixture's validity (setup lays out a product whose tests pass, whose plant is in play, whose
// vision, corpus guide and walkthrough config parse, and which vendors the design skill), the plan shape, and each check
// criterion over inputs built in place (the reflow measurements injected): one passing and at least one failing case per
// criterion. The real-browser reflow oracle is test/serial/evals-m5-reflow.test.ts.
// Named tests: evals-m5.setup-valid, evals-m5.plan-shape, evals-m5.log-of, evals-m5.criterion.<name>,
// evals-m5.owner-code-answers, evals-m5.check-without-arc, evals-m5.check-arc-under-test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { runDir } from '../src/input/cli.ts';
import { PLAN_INPUT, keepInput } from '../src/input/inforce.ts';
import { parseGuideText } from '../src/corpus/guide.ts';
import { parseVision } from '../src/holistic/types.ts';
import { type Milestone, type PlanM1, parsePlan } from '../src/input/plan.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { sha256Hex } from '../src/core/json.ts';
import {
  type M5Log, PLANT_WORDS, check, demoServingVerdict, sessionStoppedVerdict, designFirstVerdict, isPng, logOf, milestonesPlannedVerdict, nodeHeldVerdict,
  plantCaughtVerdict, plantRepairedVerdict, polishBoundedVerdict, walkScreenshotsVerdict,
} from '../evals/m5/check.ts';
import { SKILL_SATISFIED, SLICE_ANSWER, codeAnswer } from '../evals/m5/driver.ts';
import { CORPUS_ROOT, DESIGN_SKILL, PLANT, VISION_DOC, layout } from '../evals/m5/layout.ts';
import type { Reflow } from '../evals/m5/reflow.ts';
import { CLAUSES, setup } from '../evals/m5/setup.ts';
import { planShape } from '../evals/m5/shape.ts';
import { git, tmpDir } from './helpers/repo.ts';

const T = { timeout: 5 * 60_000 };

describe('the fixture', () => {
  test('evals-m5.setup-valid: the product is committed and pushed, its tests pass, its inputs parse, the skill is vendored and the plant is in play', T, () => {
    const l = setup(join(tmpDir('m5-setup'), 'fx'));
    assert.equal(git(l.product, 'status', '--porcelain'), '');
    assert.equal(git(l.origin, 'rev-parse', 'main'), git(l.product, 'rev-parse', 'main'));
    const tests = spawnSync(process.execPath, ['--test', 'test/'], { cwd: l.product, encoding: 'utf8', timeout: 120_000 });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);

    // The vision record parses, is confirmed against vision.md's bytes, and compiles its anchors in order.
    const visionText = readFileSync(join(l.product, CORPUS_ROOT, VISION_DOC), 'utf8');
    const vision = parseVision(JSON.parse(readFileSync(join(l.product, '.roadmap', 'vision.json'), 'utf8')));
    assert.equal((vision as unknown as { confirmation: { ref: string } }).confirmation.ref, `corpus:${VISION_DOC}#sha256:${sha256Hex(visionText)}`);
    assert.deepEqual([...visionText.matchAll(/\{(V-\d+)\}/g)].map((m) => m[1]), CLAUSES.map((c) => c.id));
    assert.equal(vision.clauses.filter((c) => c.kind === 'experience').length, 5);
    assert.ok(vision.clauses.filter((c) => c.kind === 'world').length >= 2);

    // The corpus guide and the repo config (with the Playwright walkthrough server) parse; no chain yet (K is asked).
    assert.equal(parseGuideText(readFileSync(join(l.product, '.roadmap', 'corpus.md'), 'utf8')).vision, VISION_DOC);
    const config = parseRepoConfig(JSON.parse(readFileSync(join(l.product, '.roadmap', 'config.json'), 'utf8')));
    assert.equal(config.chain, undefined);
    const server = config.walkthrough?.mcp['playwright'];
    assert.equal(server?.command, 'playwright-mcp');
    assert.deepEqual(server?.args, ['--headless', '--isolated', '--browser', 'chromium', '--output-dir', '{evidence}', '--viewport-size', '{viewport}']);

    // Every corpus rule id is unique and every corpus file is under the guide's root.
    const ids = readdirSync(join(l.product, CORPUS_ROOT)).flatMap((f) => [...readFileSync(join(l.product, CORPUS_ROOT, f), 'utf8').matchAll(/^(T-\d+):/gm)].map((m) => m[1]));
    assert.equal(new Set(ids).size, ids.length);

    // The design skill is committed with its licences.
    for (const f of DESIGN_SKILL.files) assert.ok(git(l.product, 'ls-files', `${DESIGN_SKILL.dir}/${f}`) !== '', `${f} is tracked`);
    assert.match(readFileSync(join(l.product, DESIGN_SKILL.dir, 'SKILL.md'), 'utf8'), /^---\nname: frontend-design\n/);
    assert.match(readFileSync(join(l.product, DESIGN_SKILL.dir, 'LICENSE'), 'utf8'), /Apache License/);

    // The plant is in play at the seed: the planted book is free, first on the shelf, its condition ending in the URL, and
    // no stylesheet rule wraps text (the render itself is test/serial/evals-m5-reflow.test.ts).
    const books = (JSON.parse(readFileSync(join(l.product, PLANT.data), 'utf8')) as { books: { id: string; title: string; condition: string; reservedBy: string | null }[] }).books;
    assert.deepEqual([books[0]!.id, books[0]!.title, books[0]!.reservedBy], [PLANT.book, PLANT.title, null]);
    assert.ok(books[0]!.condition.endsWith(PLANT.url), books[0]!.condition);
    assert.doesNotMatch(readFileSync(join(l.product, 'public', 'style.css'), 'utf8'), /overflow-wrap|word-wrap|word-break|hyphens|white-space|overflow/);
    assert.ok(existsSync(join(l.forgeBin, 'gh')));
    assert.throws(() => setup(l.dir), /is not empty/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Plans and logs built in place (only the fields shape.ts and check.ts read)

type U = Readonly<{ id: string; after?: readonly string[]; origin?: string }>;
const journey = (id: string, via: 'browser' | 'shell') => ({ id, text: `${id} text`, via, entry: via === 'browser' ? '/' : 'node bin/swapshelf.js', budget: null });
const milestone = (id: string, units: readonly string[], design: string | null, via: 'browser' | 'shell'): Milestone => ({
  id, text: `${id} text`, units, design: design === null ? { supplied: true } : { unit: design }, references: ['design/'],
  bringUp: { setup: [], serve: [], env: {}, seed: [] }, journeys: [journey(`J-${id}`, via)], resources: [],
}) as unknown as Milestone;
const planOf = (units: readonly U[], milestones: readonly Milestone[]): PlanM1 =>
  ({ units: units.map((u) => ({ id: u.id, after: u.after ?? [], ...(u.origin === undefined ? {} : { origin: u.origin }) })), milestones }) as unknown as PlanM1;

/** The fixture's intended plan: design → reserve, search (MS-1, browser); design-keeper → cli, settings (MS-2, dependent). */
const UNITS: readonly U[] = [
  { id: 'design' }, { id: 'reserve', after: ['design'] }, { id: 'search', after: ['design'] },
  { id: 'design-keeper', after: ['reserve'] }, { id: 'cli', after: ['design-keeper', 'reserve'] }, { id: 'settings', after: ['design-keeper', 'search'] },
];
const GOOD = planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]);
const SHAPE = planShape(GOOD);
/** MS-2 holds one unit built on MS-1 (cli) and one that only shares MS-1's design unit (lone): only cli is held. */
const PARTIAL = planShape(planOf([...UNITS, { id: 'lone', after: ['design'] }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli', 'lone'], 'design-keeper', 'browser')]));

describe('the plan shape (evals/m5/shape.ts)', () => {
  test('evals-m5.plan-shape: the intended plan holds, and so does a dependent milestone with one held unit; one milestone, a supplied design, a unit before its design, no milestone built on the browser one, or no browser journey is off', () => {
    assert.equal(SHAPE.kind, 'ok');
    assert.ok(SHAPE.kind === 'ok' && SHAPE.browser.id === 'MS-1' && SHAPE.dependent.id === 'MS-2');
    assert.deepEqual(SHAPE.kind === 'ok' && SHAPE.held, ['cli', 'settings']);
    assert.ok(milestonesPlannedVerdict(SHAPE).pass);
    assert.ok(PARTIAL.kind === 'ok' && PARTIAL.dependent.id === 'MS-2');
    assert.deepEqual(PARTIAL.kind === 'ok' && PARTIAL.held, ['cli']);
    const off = (plan: PlanM1, problem: RegExp) => {
      const s = planShape(plan);
      assert.equal(s.kind, 'off');
      assert.match(milestonesPlannedVerdict(s).detail, problem);
      assert.equal(milestonesPlannedVerdict(s).pass, false);
    };
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'browser')]), /1 milestones/);
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], null, 'browser'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]), /design is supplied/);
    off(planOf([...UNITS.filter((u) => u.id !== 'search'), { id: 'search' }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli'], 'design-keeper', 'shell')]), /search do not run after its design unit/);
    // MS-2's units share MS-1's design unit but descend from none of MS-1's units.
    off(planOf([...UNITS, { id: 'lone', after: ['design'] }, { id: 'other', after: ['lone'] }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['lone', 'other'], 'design', 'browser')]), /no milestone descends from MS-1/);
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'shell'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]), /no milestone has a browser journey/);
  });
});

const SHA = (c: string): string => c.repeat(40);
/** The shelf's page at 320 px, `scrollWidth` wide, the planted book on it. */
const measured = (scrollWidth: number): Reflow => ({ kind: 'measured', scrollWidth, viewport: 320, html: `<li>${PLANT.title} … ${PLANT.url}</li>` });
/** A log of the story the fixture expects: design publishes, MS-1 builds, walk-1 finds the plant, a repair lands, walk-2 passes, MS-2 builds. */
function goodLog(over: Partial<M5Log> = {}): M5Log {
  return {
    firstDispatch: new Map([['design', 10], ['reserve', 30], ['search', 31], ['design-keeper', 50], ['repair-contrast', 70], ['cli', 120], ['settings', 121]]),
    publications: [
      { seq: 20, unit: 'design', commit: SHA('1') }, { seq: 40, unit: 'reserve', commit: SHA('2') }, { seq: 45, unit: 'search', commit: SHA('3') },
      { seq: 80, unit: 'repair-contrast', commit: SHA('4') }, { seq: 130, unit: 'cli', commit: SHA('5') }, { seq: 140, unit: 'settings', commit: SHA('6') },
    ],
    walks: [
      { job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('3'), seq: 46, outcome: 'reported' },
      { job: 'walk-2', milestone: 'MS-1', round: 2, sha: SHA('4'), seq: 90, outcome: 'reported' },
      { job: 'walk-3', milestone: 'MS-2', round: 1, sha: SHA('6'), seq: 141, outcome: 'reported' },
    ],
    passed: [{ seq: 100, milestone: 'MS-1', job: 'walk-2' }, { seq: 150, milestone: 'MS-2', job: 'walk-3' }],
    findings: [{
      id: 'F-1', seq: 60, lens: 'walkthrough', milestone: 'MS-1', claim: 'J-1: at 320 px the shelf\'s page scrolls sideways; the first book\'s condition runs off the screen', cause: 'an unbroken URL in .book-meta does not wrap',
      transitions: [{ seq: 65, to: { state: 'owned', unit: 'repair-contrast' } }, { seq: 75, to: { state: 'fixed-on-branch', unit: 'repair-contrast' } }, { seq: 82, to: { state: 'resolved' } }],
    }] as M5Log['findings'],
    tweaks: [{ seq: 95, unit: 'polish-x1', decision: 'keep', reason: 'judged' }, { seq: 96, unit: 'polish-x2', decision: 'drop', reason: 'judged' }],
    compares: [{ job: 'compare-1', unit: 'polish-x1', seq: 93, abandoned: false, interrupted: false }, { job: 'compare-2', unit: 'polish-x2', seq: 94, abandoned: false, interrupted: false }],
    demos: [{ seq: 101, milestone: 'MS-1', sha: SHA('4') }, { seq: 151, milestone: 'MS-2', sha: SHA('6') }],
    ...over,
  };
}

describe('the criteria over the log (evals/m5/check.ts)', () => {
  test('evals-m5.criterion.design-first: the reference published before any MS-1 unit dispatched; a unit dispatched first, or a missing reference dir, fails', () => {
    const none = () => [];
    assert.ok(designFirstVerdict(SHAPE, goodLog(), none).pass);
    const early = designFirstVerdict(SHAPE, goodLog({ firstDispatch: new Map([['design', 10], ['reserve', 15]]) }), none);
    assert.equal(early.pass, false);
    assert.match(early.detail, /reserve was dispatched at seq 15, before design published at seq 20/);
    const missing = designFirstVerdict(SHAPE, goodLog(), (commit, dirs) => (commit === SHA('1') ? dirs : []));
    assert.equal(missing.pass, false);
    assert.match(missing.detail, /has no design\//);
    assert.equal(designFirstVerdict(SHAPE, goodLog({ publications: [] }), none).pass, false);
  });

  test('evals-m5.criterion.node-held: no held MS-2 unit dispatched before milestone-passed{MS-1} (an unheld one may be); a held one before it, or no pass, fails', () => {
    assert.ok(nodeHeldVerdict(SHAPE, goodLog()).pass);
    const early = nodeHeldVerdict(SHAPE, goodLog({ firstDispatch: new Map([['cli', 99]]) }));
    assert.equal(early.pass, false);
    assert.match(early.detail, /cli dispatched at seq 99, before milestone-passed\{MS-1\} at seq 100/);
    assert.match(nodeHeldVerdict(SHAPE, goodLog({ passed: [] })).detail, /no milestone-passed\{MS-1\}/);
    // A dependent-milestone unit built on no MS-1 unit is not held: dispatched early, it passes; a held one early fails.
    assert.ok(nodeHeldVerdict(PARTIAL, goodLog({ firstDispatch: new Map([['lone', 5]]) })).pass);
    assert.match(nodeHeldVerdict(PARTIAL, goodLog({ firstDispatch: new Map([['cli', 99]]) })).detail, /cli dispatched at seq 99/);
  });

  test('evals-m5.criterion.walk-screenshots: every reported MS-1 walk holds a PNG; one without, or no reported walk, fails', () => {
    assert.ok(walkScreenshotsVerdict(SHAPE, goodLog(), () => ['shot.png']).pass);
    const bare = walkScreenshotsVerdict(SHAPE, goodLog(), (job) => (job === 'walk-2' ? [] : ['shot.png']));
    assert.equal(bare.pass, false);
    assert.match(bare.detail, /walk-2's evidence holds no PNG/);
    assert.equal(walkScreenshotsVerdict(SHAPE, goodLog({ walks: [{ job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('3'), seq: 46, outcome: 'bring-up-failed' }] }), () => ['x']).pass, false);
  });

  test('evals-m5.criterion.plant-caught: an overflow finding resolved by a published unit; repaired upstream, unmeasurable, no such finding, or unresolved fails', async () => {
    const wide = async (): Promise<Reflow> => measured(902);
    const ok = await plantCaughtVerdict(SHAPE, goodLog(), wide);
    assert.ok(ok.pass, ok.detail);
    assert.match(ok.detail, /F-1 .* resolved at seq 82 by repair-contrast's publication at seq 80/);
    // Measured at the first MS-1 walk's SHA.
    const asked: string[] = [];
    await plantCaughtVerdict(SHAPE, goodLog(), async (sha) => (asked.push(sha), measured(902)));
    assert.deepEqual(asked, [SHA('3')]);
    const upstream = await plantCaughtVerdict(SHAPE, goodLog(), async () => measured(320));
    assert.equal(upstream.pass, false);
    assert.match(upstream.detail, /repaired upstream: \/ lays out 320 px wide at 320 px .*adjudicate/);
    const unknown = await plantCaughtVerdict(SHAPE, goodLog(), async () => ({ kind: 'unknown', detail: 'the server did not come up' }));
    assert.equal(unknown.pass, false);
    assert.match(unknown.detail, /the server did not come up/);
    const [f] = goodLog().findings;
    assert.equal((await plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, claim: 'J-1: the reserve button does nothing', cause: 'dead button' }] }), wide)).pass, false);
    const open = await plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, transitions: f!.transitions.slice(0, 2) }] }), wide);
    assert.equal(open.pass, false);
    assert.match(open.detail, /F-1 .* is fixed-on-branch \(fixed on repair-contrast's branch, published\)/);
    const unpublished = await plantCaughtVerdict(SHAPE, goodLog({ publications: goodLog().publications.filter((p) => p.unit !== 'repair-contrast') }), wide);
    assert.equal(unpublished.pass, false);
    for (const said of ['The page scrolls horizontally on a phone', 'content overflows the viewport', 'the long URL does not wrap', 'fails WCAG 1.4.10 Reflow', 'the page is wider than the screen at 320 px']) assert.ok(PLANT_WORDS.test(said), said);
    for (const said of ['the button is missing', 'Low contrast on the meta line', 'the reservation form has no label']) assert.ok(!PLANT_WORDS.test(said), said);
  });

  test('evals-m5.criterion.plant-repaired: no wider than the viewport with the planted book listed passes; overflowing, unmeasurable or the book gone fails', () => {
    const ok = plantRepairedVerdict('h', measured(320));
    assert.ok(ok.pass, ok.detail);
    assert.equal(plantRepairedVerdict('h', measured(321)).pass, false);
    assert.equal(plantRepairedVerdict('h', { kind: 'unknown', detail: 'x' }).pass, false);
    const gone = plantRepairedVerdict('h', { kind: 'measured', scrollWidth: 320, viewport: 320, html: '<li>The Dispossessed</li>' });
    assert.equal(gone.pass, false);
    assert.match(gone.detail, /adjudicate by hand/);
    assert.match(plantRepairedVerdict('h', { kind: 'measured', scrollWidth: 320, viewport: 320, html: PLANT.title }).detail, /adjudicate by hand/);
  });

  test('evals-m5.criterion.polish-bounded: rounds within walkRounds and each polish unit judged once, keep before it published; otherwise fails', () => {
    assert.ok(polishBoundedVerdict(goodLog(), ['polish-x1', 'polish-x2'], 3).pass);
    assert.match(polishBoundedVerdict(goodLog(), ['polish-x1'], 1).detail, /MS-1 was walked in round 2, past walkRounds 1/);
    assert.match(polishBoundedVerdict(goodLog(), ['polish-x3'], 3).detail, /polish unit polish-x3 has 0 tweak-judged facts/);
    const dropped = goodLog({ publications: [...goodLog().publications, { seq: 97, unit: 'polish-x2', commit: SHA('7') }] });
    assert.match(polishBoundedVerdict(dropped, ['polish-x2'], 3).detail, /polish unit polish-x2 published at seq 97 after a drop/);
    // Agent D's brakes: a round's failed walks at most twice, a unit's compares at most twice (interrupted ones are no tries).
    const abandonedWalk = (job: string, interrupted = false) => ({ job, milestone: 'MS-2', round: 1, sha: SHA('6'), seq: 135, outcome: 'abandoned' as const, interrupted });
    assert.ok(polishBoundedVerdict(goodLog({ walks: [...goodLog().walks, abandonedWalk('walk-4'), abandonedWalk('walk-5', true), abandonedWalk('walk-6')] }), ['polish-x1', 'polish-x2'], 3).pass);
    assert.match(polishBoundedVerdict(goodLog({ walks: [...goodLog().walks, abandonedWalk('walk-4'), abandonedWalk('walk-5'), abandonedWalk('walk-6')] }), ['polish-x1'], 3).detail, /MS-2 round 1 was abandoned 3 times, past the brake of 2/);
    const compare = (n: number, interrupted = false) => ({ job: `compare-${n}`, unit: 'polish-x1', seq: 90 + n, abandoned: true, interrupted });
    assert.match(polishBoundedVerdict(goodLog({ compares: [compare(1), compare(2), compare(3)] }), ['polish-x1'], 3).detail, /polish-x1 was compared 3 times, past the brake of 2/);
    assert.ok(polishBoundedVerdict(goodLog({ compares: [compare(1, true), compare(2), compare(3)] }), ['polish-x1', 'polish-x2'], 3).pass);
  });

  test('evals-m5.criterion.demo-serving: the latest promotion serves at one URL; no promotion, no status.demo, a stale demo, a dead URL or a moved URL fails', () => {
    const where = (url: string) => ({ type: 'url', url, ports: { web: Number(new URL(url).port) } });
    const url = 'http://127.0.0.1:4100/';
    const demo = { where: where(url), milestone: 'MS-2', sha: SHA('6'), held: false };
    // Each status read is a fresh object: the same URL is no move.
    const seen = [{ at: 't1', arc: 'a', demo: { ...demo, where: where(url), milestone: 'MS-1', sha: SHA('4') } }, { at: 't2', arc: 'a', demo }];
    const final = { arc: 'a', demo, probe: { url, status: 200, error: null } };
    assert.ok(demoServingVerdict(goodLog(), seen, final).pass);
    assert.match(demoServingVerdict(goodLog({ demos: [] }), seen, final).detail, /no demo-promoted/);
    assert.match(demoServingVerdict(goodLog(), seen, { arc: 'a', demo: null, probe: null }).detail, /status.demo/);
    assert.match(demoServingVerdict(goodLog(), seen, { ...final, demo: { ...demo, sha: SHA('4') } }).detail, /the latest promotion MS-2/);
    assert.match(demoServingVerdict(goodLog(), seen, { ...final, probe: { url, status: null, error: 'ECONNREFUSED' } }).detail, /did not serve/);
    assert.match(demoServingVerdict(goodLog(), seen, { ...final, demo: { ...demo, where: null } }).detail, /status.demo.where null is no URL/);
    assert.match(demoServingVerdict(goodLog(), [{ at: 't0', arc: 'a', demo: { ...demo, where: where('http://127.0.0.1:4200/') } }, ...seen], final).detail, /the demo moved: http:\/\/127.0.0.1:4200\/ → http:\/\/127.0.0.1:4100\//);
  });

  test('evals-m5.criterion.session-stopped: a vision-silent or k-limit stop of the arc under test passes, a later arc after its completion too; any other end, an earlier arc, or a later one before completion fails, naming the end', () => {
    const stopped = { endedBy: 'stopped', stopReason: 'k-limit', failure: null } as const;
    assert.ok(sessionStoppedVerdict(stopped, 'a', ['a'], true).pass);
    const later = sessionStoppedVerdict(stopped, 'a', ['a', 'b'], true);
    assert.ok(later.pass, later.detail);
    assert.match(later.detail, /ended stopped \(k-limit\); a under test, then b \(not graded\)/);
    const killed = sessionStoppedVerdict({ endedBy: 'session-failed', stopReason: null, failure: 'turn 1 exited 1 (turn-1.stderr)' }, 'a', ['a', 'b'], true);
    assert.equal(killed.pass, false);
    assert.match(killed.detail, /the session ended session-failed \(turn 1 exited 1 \(turn-1.stderr\)\)/);
    assert.match(sessionStoppedVerdict(stopped, 'a', ['a', 'b'], false).detail, /b started after a, which never completed/);
    assert.match(sessionStoppedVerdict(stopped, 'b', ['a', 'b'], true).detail, /a started before the arc under test b/);
    assert.match(sessionStoppedVerdict(stopped, null, [], false).detail, /no arc under test/);
  });
});

describe('the log and the files (evals/m5/check.ts)', () => {
  test('evals-m5.log-of: dispatches, unit publications, walks, passes, findings, tweaks and promotions from events', () => {
    const ev = (seq: number, rec: object): Event => ({ v: 1, seq, prev: null, at: '2026-10-18T00:00:00.000Z', arc: 'arc-1', ...rec }) as unknown as Event;
    const fact = (seq: number, f: object): Event => ev(seq, { type: 'fact', fact: f });
    const events = [
      fact(1, { kind: 'dispatch', record: { unit: 'design' } }),
      fact(2, { kind: 'dispatch', record: { unit: 'design' } }),
      ev(3, { type: 'intent', kind: 'integration.ff', op: 'op-1', parent: { type: 'stage', unit: 'design' }, expect: { new: SHA('1') } }),
      ev(4, { type: 'done', kind: 'integration.ff', op: 'op-1', outcome: { kind: 'published' } }),
      ev(5, { type: 'intent', kind: 'integration.ff', op: 'op-2', parent: { type: 'arc' }, expect: { new: SHA('2'), subject: { type: 'docs', pub: 'pub-1' } } }),
      ev(6, { type: 'done', kind: 'integration.ff', op: 'op-2', outcome: { kind: 'published' } }),
      fact(7, { kind: 'walk-started', job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('1'), ports: {} }),
      fact(8, { kind: 'finding-opened', id: 'F-1', lens: 'walkthrough', milestone: 'MS-1', claim: 'faint', cause: 'contrast' }),
      fact(9, { kind: 'walk-ended', job: 'walk-1', outcome: 'reported', findings: ['F-1'], proposals: [], dropped: [] }),
      fact(10, { kind: 'finding-transition', id: 'F-1', to: { state: 'resolved' } }),
      fact(11, { kind: 'milestone-passed', milestone: 'MS-1', job: 'walk-1' }),
      fact(12, { kind: 'tweak-judged', unit: 'p', decision: 'keep', reason: 'judged' }),
      fact(13, { kind: 'demo-promoted', milestone: 'MS-1', sha: SHA('1') }),
    ];
    const log = logOf(events);
    assert.deepEqual([...log.firstDispatch], [['design', 1]]);
    assert.deepEqual(log.publications, [{ seq: 4, unit: 'design', commit: SHA('1') }]);
    assert.deepEqual(log.walks, [{ job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('1'), seq: 7, outcome: 'reported' }]);
    assert.deepEqual(log.passed, [{ seq: 11, milestone: 'MS-1', job: 'walk-1' }]);
    assert.deepEqual(log.findings, [{ id: 'F-1', seq: 8, lens: 'walkthrough', milestone: 'MS-1', claim: 'faint', cause: 'contrast', transitions: [{ seq: 10, to: { state: 'resolved' } }] }]);
    assert.deepEqual(log.tweaks, [{ seq: 12, unit: 'p', decision: 'keep', reason: 'judged' }]);
    assert.deepEqual(log.demos, [{ seq: 13, milestone: 'MS-1', sha: SHA('1') }]);
  });

  test('evals-m5.criterion.png: a PNG is told by its signature, not its name', () => {
    const dir = tmpDir('m5-png');
    writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    writeFileSync(join(dir, 'fake.png'), 'not an image');
    assert.ok(isPng(join(dir, 'shot.png')));
    assert.equal(isPng(join(dir, 'fake.png')), false);
  });

  test('evals-m5.check-without-arc: a fixture whose session never started an arc fails every arc criterion, naming why, and throws nothing', T, async () => {
    const l = setup(join(tmpDir('m5-check'), 'fx'));
    writeFileSync(l.report, JSON.stringify({
      schema: 'roadmap/m5-report', profile: 'claude-only', endedBy: 'stalled', stopReason: null, failure: 'x', hostDir: join(l.dir, 'host'),
      launch: { envKeys: [], gh: join(l.forgeBin, 'gh'), ghConfigDir: l.ghConfig, xdgConfigHome: l.xdgConfig, gitConfigGlobal: l.gitConfig },
      demo: { seen: [], final: null }, released: [], leftovers: [],
    }));
    const r = await check(l.dir);
    assert.equal(r.pass, false);
    const by = Object.fromEntries(r.criteria.map((c) => [c.name, c]));
    assert.ok(by['isolation']!.pass, by['isolation']!.detail);
    assert.ok(by['host-released']!.pass, by['host-released']!.detail);
    assert.match(by['session-stopped']!.detail, /ended stalled/);
    assert.match(by['milestones-planned']!.detail, /no plan in force/);
    assert.match(by['arc-complete']!.detail, /threw: the product has no arc ref/);
    for (const name of ['design-first', 'node-held', 'walk-screenshots', 'plant-caught', 'plant-repaired', 'polish-bounded', 'demo-serving', 'skill-vendored', 'profile']) assert.equal(by[name]!.pass, false, name);
  });

  test('evals-m5.check-arc-under-test: of two arcs, the first started whose first plan has the M5 shape is graded; a later shell-only arc (sorting first by name) is not', T, async () => {
    const l = setup(join(tmpDir('m5-two-arcs'), 'fx'));
    writeFileSync(l.report, JSON.stringify({
      schema: 'roadmap/m5-report', profile: 'claude-only', endedBy: 'session-failed', stopReason: null, failure: 'turn 1 exited 1 (turn-1.stderr)', hostDir: join(l.dir, 'host'),
      launch: { envKeys: [], gh: join(l.forgeBin, 'gh'), ghConfigDir: l.ghConfig, xdgConfigHome: l.xdgConfig, gitConfigGlobal: l.gitConfig },
      demo: { seen: [], final: null }, released: [], leftovers: [],
    }));
    const unit = (id: string, after: readonly string[] = []) => ({ id, spec: `specs/${id}.json`, risk: 'med', scope: [`src/${id}/**`], resources: [], after, contingent: [] });
    const ms = (id: string, units: readonly string[], design: string, via: 'browser' | 'shell') => ({
      id, text: `${id} text`, units, design: { unit: design }, references: ['docs/design'], bringUp: { setup: [], serve: [], env: {}, seed: [] },
      journeys: [journey(`J-${id.slice(3)}`, via)], resources: [],
    });
    const plan = (arc: string, units: readonly object[], milestones: readonly object[]) => ({
      schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/var/tmp/wt', contracts: [], rulings: 'rulings.md',
      architectureDoc: 'docs/arch.md', direction: 'd', suite: { lanes: [] }, resources: [], units, holistic: { vision: 'vision.json', advances: ['V-1'] }, milestones,
    });
    const shaped = plan('reserve-a-book', [unit('page-design'), unit('reserve', ['page-design']), unit('search', ['reserve'])], [ms('MS-1', ['reserve'], 'page-design', 'browser'), ms('MS-2', ['search'], 'page-design', 'browser')]);
    const shellOnly = plan('keeper-tools', [unit('cli-design'), unit('cli', ['cli-design']), unit('settings', ['cli'])], [ms('MS-1', ['cli'], 'cli-design', 'shell'), ms('MS-2', ['settings'], 'cli-design', 'shell')]);
    for (const p of [shaped, shellOnly]) {
      parsePlan(p);
      const arc = arcId(p.arc);
      const dir = runDir(gitCommonDir(absPath(l.product)), arc);
      mkdirSync(dir, { recursive: true });
      const planSha256 = keepInput(dir, Buffer.from(JSON.stringify(p)), PLAN_INPUT);
      const j = openJournal(dir, arc);
      j.fact({
        kind: 'plan-applied', rev: 1, command: null, changes: [], planSha256, specs: Object.fromEntries(p.units.map((u) => [(u as { id: string }).id, 'd'.repeat(64)])), source: { type: 'start' }, payloadSha256: 'd'.repeat(64), rulingsSha256: 'd'.repeat(64),
        scheduling: 'dag', routingProvenance: { profile: 'claude-only', arcRoles: 'm4b', repoConfig: { seats: null, classes: null }, planLayer: null, unitLayers: {} },
      } as unknown as Fact);
      j.close();
      // Start order is the journals' first `at` (milliseconds): the later arc starts on a later one.
      for (const t = Date.now(); Date.now() <= t;);
    }
    const by = Object.fromEntries((await check(l.dir)).criteria.map((c) => [c.name, c]));
    assert.ok(by['milestones-planned']!.pass, by['milestones-planned']!.detail);
    assert.match(by['milestones-planned']!.detail, /design \{"unit":"page-design"\}/);
    assert.match(by['design-first']!.detail, /the design unit page-design never published/);
    // The usage-limit kill is reported, not hidden; the later arc is named as not graded.
    assert.equal(by['session-stopped']!.pass, false);
    assert.match(by['session-stopped']!.detail, /the session ended session-failed \(turn 1 exited 1/);
    assert.match(by['session-stopped']!.detail, /keeper-tools started after reserve-a-book, which never completed/);
  });
});

test('evals-m5.owner-code-answers: K, a brief ack, the slice (both scenes) and the frontend-design recommendation (already satisfied)', () => {
  assert.equal(codeAnswer('How many arcs may I run past your last acknowledged brief before I stop and wait?'), 'K = 1.');
  assert.match(codeAnswer('Shall I acknowledge brief B-1 for you?')!, /do not acknowledge/);
  assert.equal(codeAnswer('Do you accept this first slice (V-1)?'), SLICE_ANSWER);
  assert.match(SLICE_ANSWER, /V-1 and V-2/);
  assert.equal(codeAnswer('I recommend vendoring Anthropic\'s frontend-design skill into .claude/skills/. Will you add it?'), SKILL_SATISFIED);
  assert.equal(codeAnswer('Should reservations expire at six?'), null);
});
