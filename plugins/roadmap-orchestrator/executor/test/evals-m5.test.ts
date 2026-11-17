import { systemName } from '../src/core/ids.ts';
// The M5 fixture (evals/m5/), tested without paying: M5 has no scripted root agent (evals/README.md "The M5 fixture"),
// so its free tier is the fixture's validity (setup lays out a product whose tests pass, whose plant is in play, whose
// vision, corpus guide and walkthrough config parse, and which vendors the design skill), the plan shape, and each check
// criterion over inputs built in place (the reflow measurements injected): one passing and at least one failing case per
// criterion, and the driver's stop rule (log.ts), on synthetic logs and on paid run 5's log trimmed to what the rule reads
// (evals/m5/testdata/run5-log.json). The real-browser reflow oracle is test/serial/evals-m5-reflow.test.ts.
// Named tests: evals-m5.setup-valid, evals-m5.plan-shape, evals-m5.log-of, evals-m5.criterion.<name>, evals-m5.stop-rule,
// evals-m5.stop-rule-endgame, evals-m5.stop-rule-run5, evals-m5.owner-code-answers, evals-m5.check-without-arc, evals-m5.check-arc-under-test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import {
PLANT_ANCHOR,PLANT_WORDS,check,demoServingVerdict,
designFirstVerdict,isPng,milestonesPlannedVerdict,nodeHeldVerdict,
endgameRangeVerdict,plantCaughtVerdict,plantRepairedVerdict,polishBoundedVerdict,repairLoopVerdict,
sessionStoppedVerdict,
walkScreenshotsVerdict,
} from '../evals/m5/check.ts';
import { SKILL_SATISFIED,SLICE_ANSWER,codeAnswer,initialPrompt } from '../evals/m5/driver.ts';
import { CORPUS_ROOT,DESIGN_SKILL,PLANT,VISION_DOC } from '../evals/m5/layout.ts';
import { type EndgameLog,type EvidencePlan,type M5Log,type Repairs,endgameSettled,evidenceComplete,logOf } from '../evals/m5/log.ts';
import type { Reflow } from '../evals/m5/reflow.ts';
import { CLAUSES,setup } from '../evals/m5/setup.ts';
import { planShape } from '../evals/m5/shape.ts';
import type { Event,Fact } from '../src/core/events.ts';
import { arcId,jobId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { parseGuideText } from '../src/corpus/guide.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { parseVision } from '../src/holistic/types.ts';
import { runDir } from '../src/input/cli.ts';
import { PLAN_INPUT,keepInput } from '../src/input/inforce.ts';
import { type Milestone,type PlanM1,parsePlan } from '../src/input/plan.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { git,tmpDir } from './helpers/repo.ts';

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
  test('evals-m5.plan-shape: the intended plan holds, and so does a dependent milestone with one held unit; one milestone, a supplied design, a unit before its design, no milestone built on another, or no browser journey is off; either gating direction holds', () => {
    assert.equal(SHAPE.kind, 'ok');
    assert.ok(SHAPE.kind === 'ok' && SHAPE.browser.id === 'MS-1' && SHAPE.dependent.id === 'MS-2');
    assert.deepEqual(SHAPE.kind === 'ok' && SHAPE.held, ['cli', 'settings']);
    assert.ok(milestonesPlannedVerdict(SHAPE).pass);
    assert.ok(PARTIAL.kind === 'ok' && PARTIAL.dependent.id === 'MS-2');
    assert.deepEqual(PARTIAL.kind === 'ok' && PARTIAL.held, ['cli']);
    // Run 4's direction: the browser milestone's page is built on the shell milestone's settings; MS-2 is upstream.
    const reversed = planShape(planOf([{ id: 'store' }, { id: 'design' }, { id: 'design-keeper' }, { id: 'settings', after: ['store', 'design-keeper'] }, { id: 'reserve', after: ['store', 'design', 'settings'] }], [milestone('MS-1', ['reserve'], 'design', 'browser'), milestone('MS-2', ['settings'], 'design-keeper', 'shell')]));
    assert.ok(reversed.kind === 'ok' && reversed.browser.id === 'MS-1' && reversed.upstream.id === 'MS-2' && reversed.dependent.id === 'MS-1');
    assert.deepEqual(reversed.kind === 'ok' && reversed.held, ['reserve']);
    assert.ok(SHAPE.kind === 'ok' && SHAPE.upstream.id === 'MS-1');
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
    off(planOf([...UNITS, { id: 'lone', after: ['design'] }, { id: 'other', after: ['lone'] }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['lone', 'other'], 'design', 'browser')]), /no milestone descends from another/);
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'shell'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]), /no milestone has a browser journey/);
  });
});

const SHA = (c: string): string => c.repeat(40);
/** The shelf's page at 320 px, `scrollWidth` wide, the planted book on it. */
const measured = (scrollWidth: number): Reflow => ({ kind: 'measured', scrollWidth, viewport: 320, html: `<li>${PLANT.title} … ${PLANT.url}</li>` });
/**
 * A log of the story the fixture expects: design publishes, MS-1 builds, walk-1 finds the plant and proposes two tweaks, a
 * repair lands, walk-2 passes, the kept tweak publishes, MS-2 builds and passes, the demo follows each pass.
 */
function goodLog(over: Partial<M5Log> = {}): M5Log {
  return {
    firstDispatch: new Map([['design', 10], ['reserve', 30], ['search', 31], ['design-keeper', 50], ['repair-contrast', 70], ['cli', 120], ['settings', 121]]),
    publications: [
      { seq: 20, unit: 'design', commit: SHA('1') }, { seq: 40, unit: 'reserve', commit: SHA('2') }, { seq: 45, unit: 'search', commit: SHA('3') },
      { seq: 80, unit: 'repair-contrast', commit: SHA('4') }, { seq: 98, unit: 'polish-x1', commit: SHA('8') }, { seq: 130, unit: 'cli', commit: SHA('5') },
      { seq: 140, unit: 'settings', commit: SHA('6') },
    ],
    walks: [
      { job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('3'), seq: 46, outcome: 'reported', findings: ['F-1'], proposals: ['X-1', 'X-2'], dropped: [] },
      { job: 'walk-2', milestone: 'MS-1', round: 2, sha: SHA('4'), seq: 90, outcome: 'reported', findings: [], proposals: [], dropped: [] },
      { job: 'walk-3', milestone: 'MS-2', round: 1, sha: SHA('6'), seq: 141, outcome: 'reported', findings: [], proposals: [], dropped: [] },
    ],
    passed: [{ seq: 100, milestone: 'MS-1', job: 'walk-2' }, { seq: 150, milestone: 'MS-2', job: 'walk-3' }],
    findings: [{
      id: 'F-1', seq: 60, lens: 'walkthrough', milestone: 'MS-1', claim: 'J-1: at 320 px the shelf\'s page scrolls sideways; the first book\'s condition runs off the screen', cause: 'an unbroken URL in .book-meta does not wrap',
      transitions: [{ seq: 65, to: { state: 'owned', unit: 'repair-contrast' } }, { seq: 75, to: { state: 'fixed-on-branch', unit: 'repair-contrast' } }, { seq: 82, to: { state: 'resolved' } }],
    }] as M5Log['findings'],
    tweaks: [{ seq: 95, unit: 'polish-x1', decision: 'keep', reason: 'judged' }, { seq: 96, unit: 'polish-x2', decision: 'drop', reason: 'judged' }],
    compares: [{ job: 'compare-1', unit: 'polish-x1', seq: 93, abandoned: false, interrupted: false }, { job: 'compare-2', unit: 'polish-x2', seq: 94, abandoned: false, interrupted: false }],
    refused: [],
    demos: [{ seq: 101, milestone: 'MS-1', sha: SHA('4') }, { seq: 151, milestone: 'MS-2', sha: SHA('6') }],
    endgame: NO_ENDGAME, audits: [], completed: [],
    ...over,
  };
}

const NO_ENDGAME: EndgameLog = { entered: [], opened: [], fixes: [], landings: [], reviews: [], checkpoints: [] };
/**
 * dev.82: MS-2's loop in the endgame: episode 1 opens on SHA 6, a fix (SHA 7) lands, the closing review covers 6..7, the
 * final audit's invariants coverage reaches 7, the arc completes.
 */
const ENDGAME: Pick<M5Log, 'endgame' | 'audits' | 'completed'> = {
  endgame: {
    entered: [{ seq: 160, episode: 1 }], opened: [{ seq: 170, episode: 1, base: SHA('6') }], fixes: [{ seq: 180, command: 'cmd-1', commit: SHA('7') }],
    landings: [{ seq: 190, job: 'endgame-1', old: SHA('6'), head: SHA('7') }], reviews: [{ seq: 200, job: 'endgame-2', from: SHA('6'), to: SHA('7') }], checkpoints: [],
  },
  audits: [{ seq: 210, job: 'audit-9', covered: [{ lens: 'invariants', from: SHA('6'), to: SHA('7') }] }],
  completed: [220],
};
/** SHA 1 … 7 in a line: `a` is `b` or an ancestor of it. */
const inLine = (a: string, b: string): boolean => a[0]! <= b[0]!;

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
    assert.equal(walkScreenshotsVerdict(SHAPE, goodLog({ walks: [{ ...goodLog().walks[0]!, outcome: 'bring-up-failed' }] }), () => ['x']).pass, false);
  });

  test('evals-m5.criterion.plant-caught: a resolved overflow finding of any judge, or a plant gone before the first walk, passes; a plant live at the walk that no resolved finding names, or unmeasurable, fails', async () => {
    const wide = async (): Promise<Reflow> => measured(902);
    const ok = await plantCaughtVerdict(SHAPE, goodLog(), wide);
    assert.ok(ok.pass, ok.detail);
    assert.match(ok.detail, /F-1 .* resolved at seq 82 by repair-contrast's publication at seq 80/);
    // A resolved finding needs no measurement; any lens counts (run 5: the vision audit caught it before any walk).
    const asked: string[] = [];
    const [f] = goodLog().findings;
    const byLens = await plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, lens: 'vision' }] }), async (sha) => (asked.push(sha), measured(902)));
    assert.ok(byLens.pass, byLens.detail);
    assert.match(byLens.detail, /vision: /);
    assert.equal(asked.length, 0);
    // No resolved finding: measured at the first MS-1 walk's SHA.
    const unnamed = goodLog({ findings: [{ ...f!, claim: 'J-1: the reserve button does nothing', cause: 'dead button' }] });
    const upstream = await plantCaughtVerdict(SHAPE, unnamed, async (sha) => (asked.push(sha), measured(320)));
    assert.ok(upstream.pass, upstream.detail);
    assert.match(upstream.detail, /prevented upstream: \/ lays out 320 px wide at 320 px/);
    assert.deepEqual(asked, [SHA('3')]);
    const missed = await plantCaughtVerdict(SHAPE, unnamed, wide);
    assert.equal(missed.pass, false);
    assert.match(missed.detail, /live at .* no resolved finding names it/);
    // Another overflow, resolved, is not the plant (run 5's F-34, the search heading); a finding naming the plant that the
    // checkpoint folded into a spec is credited when the plant is gone at the walk (run 5's F-1).
    const other = goodLog({ findings: [{ ...f!, claim: 'J-2: a pasted link searched on a 320 px screen makes the no-match page scroll sideways', cause: 'the heading does not wrap' }] });
    assert.equal((await plantCaughtVerdict(SHAPE, other, wide)).pass, false);
    const folded = await plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, lens: 'vision', transitions: [{ seq: 61, to: { state: 'ruled', disposition: 'accepted', by: { type: 'code', reason: 'close-out' } } }] }] }), async () => measured(320));
    assert.ok(folded.pass, folded.detail);
    assert.match(folded.detail, /prevented upstream: .*named by F-1 \(vision, ruled\)/);
    const unknown = await plantCaughtVerdict(SHAPE, unnamed, async () => ({ kind: 'unknown', detail: 'the server did not come up' }));
    assert.equal(unknown.pass, false);
    assert.match(unknown.detail, /the server did not come up/);
    const open = await plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, transitions: f!.transitions.slice(0, 2) }] }), wide);
    assert.equal(open.pass, false);
    assert.match(open.detail, /F-1 .* is fixed-on-branch \(fixed on repair-contrast's branch, published\)/);
    const unpublished = await plantCaughtVerdict(SHAPE, goodLog({ publications: goodLog().publications.filter((p) => p.unit !== 'repair-contrast') }), wide);
    assert.equal(unpublished.pass, false);
    for (const said of ['The page scrolls horizontally on a phone', 'content overflows the viewport', 'the long URL does not wrap', 'fails WCAG 1.4.10 Reflow', 'the page is wider than the screen at 320 px']) assert.ok(PLANT_WORDS.test(said), said);
    for (const said of ['the button is missing', 'Low contrast on the meta line', 'the reservation form has no label']) assert.ok(!PLANT_WORDS.test(said), said);
    for (const said of ['the first book\'s condition runs off the screen', 'the seeded book b1 pushes the page wide', 'the .book-meta line']) assert.ok(PLANT_ANCHOR.test(said), said);
    assert.ok(!PLANT_ANCHOR.test('a pasted link in the search heading'));
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
    const abandonedWalk = (job: string, interrupted = false) => ({ job, milestone: 'MS-2', round: 1, sha: SHA('6'), seq: 135, outcome: 'abandoned' as const, interrupted, findings: [], proposals: [], dropped: [] });
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
    // The driver's early stop is an end the grade accepts; the arc is stopped, not completed.
    const early = sessionStoppedVerdict({ endedBy: 'evidence-complete', stopReason: null, failure: null }, 'a', ['a'], false);
    assert.ok(early.pass, early.detail);
    assert.match(sessionStoppedVerdict({ endedBy: 'timeout', stopReason: null, failure: null }, 'a', ['a'], false).detail, /ended timeout/);
  });

  test('evals-m5.criterion.repair-loop: a walkthrough finding resolved by a published unit, then a later walk that passes its milestone (or, the milestone passed before the repair, reports no finding); no such walk, or no resolution, fails', () => {
    const ok = repairLoopVerdict(goodLog());
    assert.ok(ok.pass, ok.detail);
    assert.match(ok.detail, /MS-1: F-1 .* resolved at seq 82 by repair-contrast's publication at seq 80; walk-2 \(round 2\) re-walked it/);
    // The milestone passed on the walk that found it, before the repair (a non-blocking finding): a later walk reporting no
    // finding passes; one reporting a finding does not.
    const early = { passed: [{ seq: 50, milestone: 'MS-1', job: 'walk-1' }] } as const;
    const clean = repairLoopVerdict(goodLog(early));
    assert.ok(clean.pass, clean.detail);
    assert.match(clean.detail, /walk-2 \(round 2\) re-walked it and reported no finding \(the milestone had passed before the repair\)/);
    const walks = goodLog().walks.map((w) => (w.job === 'walk-2' ? { ...w, findings: ['F-9'] } : w));
    assert.match(repairLoopVerdict(goodLog({ ...early, walks })).detail, /F-1 on MS-1 resolved at seq 82 by repair-contrast, and no later walk of MS-1 passed it/);
    const [f] = goodLog().findings;
    assert.match(repairLoopVerdict(goodLog({ findings: [{ ...f!, transitions: f!.transitions.slice(0, 2) }] })).detail, /F-1 .* is fixed-on-branch/);
    assert.match(repairLoopVerdict(goodLog({ findings: [] })).detail, /no walkthrough finding on a milestone/);
    // dev.82: the loop in the endgame: fixed by an endgame fix, resolved once its landing published, then re-walked.
    const byHand = goodLog({
      ...ENDGAME,
      findings: [{ ...f!, transitions: [{ seq: 182, to: { state: 'fixed-on-branch', endgame: 'cmd-1' } }, { seq: 191, to: { state: 'resolved' } }] }] as M5Log['findings'],
      walks: [...goodLog().walks, { job: 'walk-4', milestone: 'MS-1', round: 3, sha: SHA('7'), seq: 230, outcome: 'reported', findings: [], proposals: [], dropped: [] }],
      passed: [...goodLog().passed, { seq: 235, milestone: 'MS-1', job: 'walk-4' }],
    });
    const landed = repairLoopVerdict(byHand);
    assert.ok(landed.pass, landed.detail);
    assert.match(landed.detail, /F-1 .* resolved at seq 191 by endgame fix cmd-1's landing at seq 190; walk-4 \(round 3\) re-walked it and passed the milestone/);
    const unlanded = goodLog({ ...byHand, endgame: { ...ENDGAME.endgame, landings: [] } });
    assert.match(repairLoopVerdict(unlanded).detail, /F-1 .* is resolved \(fixed by endgame fix cmd-1, unlanded\)/);
  });

  test('evals-m5.criterion.endgame-range: an opened episode with a fix and a landing each in a review\'s range and an audit\'s coverage passes; no fix, no landing, a landing no review or audit covers, or an episode never opened without completion fails; none opened with the arc completed is skipped', () => {
    const ok = endgameRangeVerdict(goodLog(ENDGAME), inLine);
    assert.ok(ok.pass, ok.detail);
    assert.match(ok.detail, /episode\(s\) 1 opened; 1 fix\(es\); endgame-1 6{40}\.\.7{40} landed/);
    const fails = (over: Partial<EndgameLog>, why: RegExp, rest: Partial<M5Log> = {}) => {
      const v = endgameRangeVerdict(goodLog({ ...ENDGAME, endgame: { ...ENDGAME.endgame, ...over }, ...rest }), inLine);
      assert.equal(v.pass, false, v.detail);
      assert.match(v.detail, why);
    };
    fails({ fixes: [] }, /no endgame fix was recorded/);
    fails({ landings: [] }, /nothing landed from the endgame branch/);
    // A review from a later base than the landing's old (the reversed-episode gap) does not cover it.
    fails({ reviews: [{ seq: 200, job: 'endgame-2', from: SHA('7'), to: SHA('7') }] }, /no endgame review covers endgame-1's landing/);
    fails({ reviews: [{ seq: 200, job: 'endgame-2', from: SHA('6'), to: SHA('6') }] }, /no endgame review covers endgame-1's landing/);
    fails({}, /no completed audit's invariants coverage reaches endgame-1's landed head/, { audits: [{ seq: 210, job: 'audit-9', covered: [{ lens: 'invariants', from: SHA('5'), to: SHA('6') }] }] });
    fails({}, /no completed audit's invariants coverage reaches/, { audits: [{ seq: 210, job: 'audit-9', covered: [{ lens: 'drift', from: SHA('6'), to: SHA('7') }] }] });
    const skipped = endgameRangeVerdict(goodLog({ ...ENDGAME, endgame: { ...NO_ENDGAME, entered: [{ seq: 160, episode: 1 }] } }), inLine);
    assert.ok(skipped.pass, skipped.detail);
    assert.match(skipped.detail, /^skipped: endgame episode\(s\) 1 entered and none opened \(the required worklist was empty\); the arc completed at seq 220/);
    fails({ ...NO_ENDGAME, entered: [{ seq: 160, episode: 1 }] }, /endgame episode 1 entered at seq 160, never opened, and the arc did not complete/, { completed: [] });
    fails(NO_ENDGAME, /the arc never entered the endgame/);
  });
});

// ---------------------------------------------------------------------------------------------------
// The driver's stop rule (evals/m5/log.ts)

const unit = (id: string, more: object = {}) => ({ id, after: [], ...more });
/** goodLog's plan: two rounds, the plant's repair, a kept and a dropped (cut) tweak of walk-1. */
const EVIDENCE_PLAN = {
  limits: { walkRounds: 2 },
  milestones: [{ id: 'MS-1', units: ['reserve', 'search'] }, { id: 'MS-2', units: ['cli', 'settings'] }],
  units: [
    ...['design', 'reserve', 'search', 'design-keeper', 'cli', 'settings'].map((u) => unit(u)), unit('repair-contrast', { origin: 'repair' }),
    unit('polish-x1', { origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-1' } }),
    unit('polish-x2', { origin: 'polish', polish: { milestone: 'MS-1', proposal: 'X-2' }, cut: { reason: 'dropped' } }),
  ],
} as unknown as EvidencePlan;
const REPAIRS: Repairs = new Map([['repair-contrast', ['F-1']]]);
const planWith = (over: object): EvidencePlan => ({ ...EVIDENCE_PLAN, ...over }) as EvidencePlan;

describe('the stop rule (evals/m5/log.ts)', () => {
  test('evals-m5.stop-rule: complete on the fixture\'s story; a milestone unpassed, no demo after the last pass or on the latest walk\'s SHA, a walk or compare in flight, a walk due (unless braked), an unweighed finding, an unplaced proposal, a walk-originated unit unsettled (followed to its re-entry) or a tweak unjudged is not', () => {
    const ok = evidenceComplete(goodLog(), EVIDENCE_PLAN, REPAIRS);
    assert.ok(ok.complete, ok.detail);
    assert.match(ok.detail, /MS-1 passed at seq 100, MS-2 passed at seq 150; demo promoted at seq 151; 3 walk-originated unit\(s\) settled \(repair-contrast, polish-x1, polish-x2\)/);
    const not = (log: M5Log, why: RegExp, plan: EvidencePlan = EVIDENCE_PLAN, repairs: Repairs = REPAIRS) => {
      const e = evidenceComplete(log, plan, repairs);
      assert.equal(e.complete, false, e.detail);
      assert.match(e.detail, why);
    };
    const walk3 = goodLog().walks[2]!;
    not(goodLog({ passed: goodLog().passed.slice(0, 1) }), /MS-2 has no milestone-passed/);
    not(goodLog({ demos: goodLog().demos.slice(0, 1) }), /no demo-promoted after the last milestone-passed \(seq 150\)/);
    // Run 5: MS-2 settled 48 ms before its promotion; a later promotion on an older walk's SHA is not the latest walk's.
    not(goodLog({ demos: [...goodLog().demos.slice(0, 1), { seq: 151, milestone: 'MS-1', sha: SHA('4') }] }), /the demo was never promoted on walk-3's SHA/);
    not(goodLog({ walks: [...goodLog().walks, { ...walk3, job: 'walk-4', round: 2, seq: 160, outcome: null }] }), /walk-4 \(MS-2 round 2\) is in flight/);
    not(goodLog({ compares: [...goodLog().compares, { job: 'compare-3', unit: 'polish-x1', seq: 200, abandoned: false, interrupted: false }] }), /compare-3 \(polish-x1\) is in flight/);
    // With a third round allowed, walk-2's landed tweak makes round 3 due, unless round 3's walk failed twice (the brake).
    const proposing = goodLog({ walks: [goodLog().walks[0]!, { ...goodLog().walks[1]!, proposals: ['X-1'] }, walk3] });
    const three = planWith({ limits: { walkRounds: 3 } });
    not(proposing, /MS-1 round 3's walk is due \(polish-x1 landed after walk-2\)/, three);
    const abandoned = (job: string, seq: number, interrupted = false) => ({ ...walk3, job, milestone: 'MS-1', round: 3, seq, outcome: 'abandoned' as const, interrupted });
    const braked = evidenceComplete(goodLog({ walks: [...proposing.walks, abandoned('walk-5', 160), abandoned('walk-6', 170)] }), three, REPAIRS);
    assert.ok(braked.complete, braked.detail);
    not(goodLog({ walks: [...proposing.walks, abandoned('walk-5', 160), abandoned('walk-6', 170, true)] }), /MS-1 round 3's walk is due/, three);
    const finding = { id: 'F-9', seq: 142, lens: 'walkthrough', milestone: 'MS-2', claim: 'x', cause: null, transitions: [] };
    not(goodLog({ walks: [...goodLog().walks.slice(0, 2), { ...walk3, findings: ['F-9'] }], findings: [...goodLog().findings, finding] }), /walk-3's F-9 not yet weighed/);
    not(goodLog({ walks: [...goodLog().walks.slice(0, 2), { ...walk3, proposals: ['X-7'] }] }), /walk-3's proposal X-7 in no polish unit yet/);
    assert.ok(evidenceComplete(goodLog({ walks: [...goodLog().walks.slice(0, 2), { ...walk3, proposals: ['X-7'] }], refused: ['X-7'] }), EVIDENCE_PLAN, REPAIRS).complete);
    not(goodLog({ publications: goodLog().publications.filter((p) => p.unit !== 'repair-contrast') }), /walk-originated repair-contrast neither published nor cut/);
    // A re-entry carries the lineage on: the re-entered unit's publication does not settle it.
    const reentered = planWith({ units: [...EVIDENCE_PLAN.units, unit('repair-contrast-2', { origin: 'repair', reenters: { unit: 'repair-contrast' } })] });
    not(goodLog(), /walk-originated repair-contrast, repair-contrast-2 neither published nor cut/, reentered, new Map([...REPAIRS, ['repair-contrast-2', ['F-1']]]));
    not(goodLog({ tweaks: goodLog().tweaks.slice(1) }), /polish polish-x1 not judged/);
    // A unit repairing only a non-walkthrough finding is no walk evidence: unpublished, it does not hold the stop.
    assert.ok(evidenceComplete(goodLog(), planWith({ units: [...EVIDENCE_PLAN.units, unit('audit-fix', { origin: 'repair' })] }), new Map([...REPAIRS, ['audit-fix', ['F-50']]])).complete);
  });

  test('evals-m5.stop-rule-endgame: an endgame checkpoint request after a milestone\'s last walk makes its next round due (unless braked); the stop then waits for the endgame entered and the arc completed after it', () => {
    const checkpoint = (seq: number) => ({ ...NO_ENDGAME, checkpoints: [{ seq, milestone: 'MS-2' }] });
    const due = evidenceComplete(goodLog({ endgame: checkpoint(160) }), EVIDENCE_PLAN, REPAIRS);
    assert.equal(due.complete, false);
    assert.match(due.detail, /MS-2 round 2's walk is due \(endgame checkpoint at seq 160 after walk-3\)/);
    assert.ok(evidenceComplete(goodLog({ endgame: checkpoint(100) }), EVIDENCE_PLAN, REPAIRS).complete, 'a request before the last walk was served by it');
    const failed = (job: string, seq: number) => ({ ...goodLog().walks[2]!, job, round: 2, seq, outcome: 'abandoned' as const });
    assert.ok(evidenceComplete(goodLog({ endgame: checkpoint(160), walks: [...goodLog().walks, failed('walk-5', 165), failed('walk-6', 170)] }), EVIDENCE_PLAN, REPAIRS).complete, 'the brake');

    assert.match(endgameSettled(goodLog()).detail, /the arc has not entered the endgame/);
    assert.equal(endgameSettled(goodLog()).complete, false);
    const open = endgameSettled(goodLog({ ...ENDGAME, completed: [] }));
    assert.equal(open.complete, false);
    assert.match(open.detail, /endgame episode 1 opened at seq 160; the arc has not completed/);
    assert.equal(endgameSettled(goodLog({ ...ENDGAME, completed: [150] })).complete, false, 'a completion before the entry is not this one');
    const done = endgameSettled(goodLog(ENDGAME));
    assert.ok(done.complete, done.detail);
    assert.match(done.detail, /endgame episode 1 opened; arc-completed at seq 220/);
    assert.match(endgameSettled(goodLog({ ...ENDGAME, endgame: { ...NO_ENDGAME, entered: [{ seq: 160, episode: 1 }] } })).detail, /entered, never opened; arc-completed at seq 220/);
  });

  test('evals-m5.stop-rule-run5: on paid run 5\'s log (trimmed) the rule first holds at seq 7449, MS-2\'s demo promotion at 08:12:49, 85 minutes before arc-completed; its repair loop is F-34 by headings', () => {
    const run5 = JSON.parse(readFileSync(new URL('../evals/m5/testdata/run5-log.json', import.meta.url), 'utf8')) as { plan: EvidencePlan; repairs: Record<string, readonly string[]>; events: readonly Event[] };
    const repairs: Repairs = new Map(Object.entries(run5.repairs));
    const at = (seq: number) => evidenceComplete(logOf(run5.events.filter((e) => e.seq <= seq)), run5.plan, repairs);
    const first = run5.events.find((e) => at(e.seq).complete);
    assert.deepEqual(first && { seq: first.seq, at: first.at }, { seq: 7449, at: '2026-10-20T08:12:49.979Z' });
    assert.match(at(7444).detail, /the demo was never promoted on walk-6's SHA 473f7e30/);
    assert.match(at(6101).detail, /MS-2 round 2's walk is due \(keeper-instead landed after walk-3\)/);
    assert.ok(at(Infinity).complete);
    const loop = repairLoopVerdict(logOf(run5.events));
    assert.ok(loop.pass, loop.detail);
    assert.match(loop.detail, /MS-1: F-34 .* by headings's publication .*; walk-2 \(round 2\)/);
  });
});

describe('the log and the files (evals/m5/log.ts, check.ts)', () => {
  test('evals-m5.log-of: dispatches, unit publications, walks, passes, findings, tweaks, refusals and promotions from events', () => {
    const ev = (seq: number, rec: object): Event => ({ v: 2, seq, prev: null, at: '2026-10-18T00:00:00.000Z', arc: 'arc-1', ...rec }) as unknown as Event;
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
      fact(14, { kind: 'polish-refused', proposal: 'X-2', reasons: ['no reference touched'] }),
      fact(15, { kind: 'endgame-entered', episode: 1, planRev: 3 }),
      fact(16, { kind: 'endgame-opened', episode: 1, base: SHA('1'), handoverSha256: 'e'.repeat(64) }),
      fact(17, { kind: 'endgame-fix', command: 'cmd-1', closes: ['F-1'], commit: SHA('2'), note: 'n' }),
      fact(18, { kind: 'endgame-requested', command: 'cmd-2', request: { type: 'land' } }),
      fact(19, { kind: 'endgame-landed', job: 'endgame-1', old: SHA('1'), head: SHA('2') }),
      fact(20, { kind: 'endgame-reviewed', job: 'endgame-2', from: SHA('1'), to: SHA('2'), findings: [] }),
      fact(21, { kind: 'endgame-requested', command: 'cmd-3', request: { type: 'checkpoint', milestone: 'MS-1' } }),
      fact(22, { kind: 'audit-ended', job: 'audit-1', covered: [{ lens: 'invariants', from: SHA('1'), to: SHA('2') }], findings: [], suppressed: 0, outcome: 'completed' }),
      fact(23, { kind: 'audit-ended', job: 'audit-2', covered: [], findings: [], suppressed: 0, outcome: 'abandoned' }),
      fact(24, { kind: 'arc-completed', planRev: 3, head: SHA('2'), highWater: 23, units: [] }),
    ];
    const log = logOf(events);
    assert.deepEqual([...log.firstDispatch], [['design', 1]]);
    assert.deepEqual(log.publications, [{ seq: 4, unit: 'design', commit: SHA('1') }]);
    assert.deepEqual(log.walks, [{ job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('1'), seq: 7, outcome: 'reported', findings: ['F-1'], proposals: [], dropped: [] }]);
    assert.deepEqual(log.refused, ['X-2']);
    assert.deepEqual(log.passed, [{ seq: 11, milestone: 'MS-1', job: 'walk-1' }]);
    assert.deepEqual(log.findings, [{ id: 'F-1', seq: 8, lens: 'walkthrough', milestone: 'MS-1', claim: 'faint', cause: 'contrast', transitions: [{ seq: 10, to: { state: 'resolved' } }] }]);
    assert.deepEqual(log.tweaks, [{ seq: 12, unit: 'p', decision: 'keep', reason: 'judged' }]);
    assert.deepEqual(log.demos, [{ seq: 13, milestone: 'MS-1', sha: SHA('1') }]);
    assert.deepEqual(log.endgame, {
      entered: [{ seq: 15, episode: 1 }], opened: [{ seq: 16, episode: 1, base: SHA('1') }], fixes: [{ seq: 17, command: 'cmd-1', commit: SHA('2') }],
      landings: [{ seq: 19, job: 'endgame-1', old: SHA('1'), head: SHA('2') }], reviews: [{ seq: 20, job: 'endgame-2', from: SHA('1'), to: SHA('2') }],
      checkpoints: [{ seq: 21, milestone: 'MS-1' }],
    });
    assert.deepEqual(log.audits, [{ seq: 22, job: 'audit-1', covered: [{ lens: 'invariants', from: SHA('1'), to: SHA('2') }] }]);
    assert.deepEqual(log.completed, [24]);
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
    assert.match(by['milestones-settled']!.detail, /threw: the product has no run dir with a plan in force/);
    for (const name of ['design-first', 'node-held', 'walk-screenshots', 'plant-caught', 'repair-loop', 'plant-repaired', 'polish-bounded', 'demo-serving', 'skill-vendored', 'profile', 'endgame-range']) assert.equal(by[name]!.pass, false, name);
  });

  test('evals-m5.check-arc-under-test: of two arcs, the first started whose first plan has the M5 shape is graded; a later shell-only arc (sorting first by name) is not', T, async () => {
    const l = setup(join(tmpDir('m5-two-arcs'), 'fx'));
    writeFileSync(l.report, JSON.stringify({
      schema: 'roadmap/m5-report', profile: 'claude-only', endedBy: 'session-failed', stopReason: null, failure: 'turn 1 exited 1 (turn-1.stderr)', hostDir: join(l.dir, 'host'),
      launch: { envKeys: [], gh: join(l.forgeBin, 'gh'), ghConfigDir: l.ghConfig, xdgConfigHome: l.xdgConfig, gitConfigGlobal: l.gitConfig },
      demo: { seen: [], final: null }, released: [], leftovers: [],
    }));
    const unit = (id: string, after: readonly string[] = []) => ({ id, spec: `specs/${id}.json`, risk: 'med', systems: [systemName('app')], resources: [], after, contingent: [] });
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
  assert.ok(initialPrompt('claude-only').includes(SLICE_ANSWER));
  assert.equal(codeAnswer('I recommend vendoring Anthropic\'s frontend-design skill into .claude/skills/. Will you add it?'), SKILL_SATISFIED);
  assert.equal(codeAnswer('Should reservations expire at six?'), null);
});
