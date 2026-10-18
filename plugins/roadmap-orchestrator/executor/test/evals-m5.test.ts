// The M5 fixture (evals/m5/), tested without paying: M5 has no scripted root agent (evals/README.md "The M5 fixture"),
// so its free tier is the fixture's validity (setup lays out a product whose tests pass, whose plant is in play, whose
// vision, corpus guide and walkthrough config parse, and which vendors the design skill), the contrast oracle, the plan
// shape, and each check criterion over inputs built in place: one passing and at least one failing case per criterion.
// Named tests: evals-m5.setup-valid, evals-m5.css-oracle, evals-m5.plan-shape, evals-m5.log-of, evals-m5.criterion.<name>,
// evals-m5.owner-code-answers, evals-m5.check-without-arc.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { absPath } from '../src/core/values.ts';
import { parseGuideText } from '../src/corpus/guide.ts';
import { parseVision } from '../src/holistic/types.ts';
import type { Milestone, PlanM1 } from '../src/input/plan.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { sha256Hex } from '../src/core/json.ts';
import {
  type M5Log, PLANT_WORDS, check, demoServingVerdict, designFirstVerdict, isPng, logOf, milestonesPlannedVerdict, nodeHeldVerdict, plantAt,
  plantCaughtVerdict, plantRepairedVerdict, polishBoundedVerdict, walkScreenshotsVerdict,
} from '../evals/m5/check.ts';
import { contrastRatio, parseColor, selectorContrast } from '../evals/m5/css.ts';
import { SKILL_SATISFIED, SLICE_ANSWER, codeAnswer } from '../evals/m5/driver.ts';
import { CORPUS_ROOT, DESIGN_SKILL, PLANT, VISION_DOC, layout } from '../evals/m5/layout.ts';
import { CLAUSES, setup } from '../evals/m5/setup.ts';
import { planShape } from '../evals/m5/shape.ts';
import { git, tmpDir } from './helpers/repo.ts';

const T = { timeout: 5 * 60_000 };

describe('the fixture', () => {
  test('evals-m5.setup-valid: the product is committed and pushed, its tests pass, its inputs parse, the skill is vendored and the plant is in play', T, () => {
    const l = setup(join(tmpDir('m5-setup'), 'fx'));
    const product = absPath(l.product);
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

    // The plant computes below the floor at the seed, through the same oracle the check uses.
    const seed = plantAt(product, git(l.product, 'rev-parse', 'main'));
    assert.equal(seed.kind, 'ratio');
    assert.ok(seed.kind === 'ratio' && seed.ratio < PLANT.floor && seed.ratio > 2, JSON.stringify(seed));
    assert.ok(existsSync(join(l.forgeBin, 'gh')));
    assert.throws(() => setup(l.dir), /is not empty/);
  });
});

describe('the contrast oracle (evals/m5/css.ts)', () => {
  test('evals-m5.css-oracle: colour forms, var() with fallbacks, alpha over the background, at-rule blocks skipped, an absent selector', () => {
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 });
    assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
    assert.deepEqual(parseColor('rgba(10, 20, 30, 0.25)'), { r: 10, g: 20, b: 30, a: 0.25 });
    assert.deepEqual(parseColor('hsl(0 100% 50%)'), { r: 255, g: 0, b: 0, a: 1 });
    const red = parseColor('oklch(62.8% 0.2577 29.23)')!;
    assert.ok(Math.abs(red.r - 255) < 1 && red.g < 1 && red.b < 1, JSON.stringify(red));
    assert.equal(parseColor('color-mix(in srgb, red, blue)'), null);
    assert.equal(Math.round(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })), 21);

    const css = ':root { --a: #777; --bg: var(--missing, #ffffff); }\nbody { background: var(--bg); }\n.x { color: var(--a); }\n@media (prefers-color-scheme: dark) { .x { color: #fff; } body { background: #000; } }\n.y { color: rgb(0 0 0 / 50%); }\n.z { color: #000; background-color: #333; }';
    const x = selectorContrast(css, '.x');
    assert.ok(x.kind === 'ratio' && Math.abs(x.ratio - 4.48) < 0.01, JSON.stringify(x));
    const y = selectorContrast(css, '.y');
    assert.ok(y.kind === 'ratio' && Math.abs(y.ratio - 3.95) < 0.05, JSON.stringify(y));
    const z = selectorContrast(css, '.z');
    assert.ok(z.kind === 'ratio' && z.ratio < 2, JSON.stringify(z));
    assert.deepEqual(selectorContrast(css, '.gone'), { kind: 'absent' });
    assert.equal(selectorContrast('.q { color: var(--nope); }', '.q').kind, 'unknown');
    // A later rule for the selector wins, and a comma list names it.
    const later = selectorContrast(`${css}\n.w, .x { color: #000; }`, '.x');
    assert.ok(later.kind === 'ratio' && later.ratio > 20, JSON.stringify(later));
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

/** The fixture's intended plan: design → reserve, search (MS-1, browser); design-keeper → cli, settings (MS-2, shell). */
const UNITS: readonly U[] = [
  { id: 'design' }, { id: 'reserve', after: ['design'] }, { id: 'search', after: ['design'] },
  { id: 'design-keeper', after: ['reserve'] }, { id: 'cli', after: ['design-keeper', 'reserve'] }, { id: 'settings', after: ['design-keeper', 'search'] },
];
const GOOD = planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]);
const SHAPE = planShape(GOOD);

describe('the plan shape (evals/m5/shape.ts)', () => {
  test('evals-m5.plan-shape: the intended plan holds; one milestone, a supplied design, a unit before its design, or a shell milestone off the browser one is off', () => {
    assert.equal(SHAPE.kind, 'ok');
    assert.ok(SHAPE.kind === 'ok' && SHAPE.browser.id === 'MS-1' && SHAPE.shell.id === 'MS-2');
    assert.ok(milestonesPlannedVerdict(SHAPE).pass);
    const off = (plan: PlanM1, problem: RegExp) => {
      const s = planShape(plan);
      assert.equal(s.kind, 'off');
      assert.match(milestonesPlannedVerdict(s).detail, problem);
      assert.equal(milestonesPlannedVerdict(s).pass, false);
    };
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'browser')]), /1 milestones/);
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], null, 'browser'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]), /design is supplied/);
    off(planOf([...UNITS.filter((u) => u.id !== 'search'), { id: 'search' }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli'], 'design-keeper', 'shell')]), /search do not run after its design unit/);
    off(planOf([...UNITS, { id: 'lone', after: ['design'] }], [milestone('MS-1', ['reserve', 'search'], 'design', 'browser'), milestone('MS-2', ['cli', 'lone'], 'design-keeper', 'shell')]), /no shell milestone descends from MS-1/);
    off(planOf(UNITS, [milestone('MS-1', ['reserve', 'search'], 'design', 'shell'), milestone('MS-2', ['cli', 'settings'], 'design-keeper', 'shell')]), /no milestone has a browser journey/);
  });
});

const SHA = (c: string): string => c.repeat(40);
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
      id: 'F-1', seq: 60, lens: 'walkthrough', milestone: 'MS-1', claim: 'J-1: the condition line under each book is faint and hard to read in daylight', cause: 'low contrast .book-meta',
      transitions: [{ seq: 65, to: { state: 'owned', unit: 'repair-contrast' } }, { seq: 75, to: { state: 'fixed-on-branch', unit: 'repair-contrast' } }, { seq: 82, to: { state: 'resolved' } }],
    }] as M5Log['findings'],
    tweaks: [{ seq: 95, unit: 'polish-x1', decision: 'keep', reason: 'judged' }, { seq: 96, unit: 'polish-x2', decision: 'drop', reason: 'judged' }],
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

  test('evals-m5.criterion.node-held: no MS-2 unit dispatched before milestone-passed{MS-1}; one before it, or no pass, fails', () => {
    assert.ok(nodeHeldVerdict(SHAPE, goodLog()).pass);
    const early = nodeHeldVerdict(SHAPE, goodLog({ firstDispatch: new Map([['cli', 99]]) }));
    assert.equal(early.pass, false);
    assert.match(early.detail, /cli dispatched at seq 99, before milestone-passed\{MS-1\} at seq 100/);
    assert.match(nodeHeldVerdict(SHAPE, goodLog({ passed: [] })).detail, /no milestone-passed\{MS-1\}/);
  });

  test('evals-m5.criterion.walk-screenshots: every reported MS-1 walk holds a PNG; one without, or no reported walk, fails', () => {
    assert.ok(walkScreenshotsVerdict(SHAPE, goodLog(), () => ['shot.png']).pass);
    const bare = walkScreenshotsVerdict(SHAPE, goodLog(), (job) => (job === 'walk-2' ? [] : ['shot.png']));
    assert.equal(bare.pass, false);
    assert.match(bare.detail, /walk-2's evidence holds no PNG/);
    assert.equal(walkScreenshotsVerdict(SHAPE, goodLog({ walks: [{ job: 'walk-1', milestone: 'MS-1', round: 1, sha: SHA('3'), seq: 46, outcome: 'bring-up-failed' }] }), () => ['x']).pass, false);
  });

  test('evals-m5.criterion.plant-caught: a contrast finding resolved by a published unit; repaired upstream, no such finding, or unresolved fails', () => {
    const faint = () => ({ kind: 'ratio', ratio: 2.12, color: 'a', background: 'b', from: PLANT.selector }) as const;
    const ok = plantCaughtVerdict(SHAPE, goodLog(), faint);
    assert.ok(ok.pass, ok.detail);
    assert.match(ok.detail, /F-1 .* resolved at seq 82 by repair-contrast's publication at seq 80/);
    const upstream = plantCaughtVerdict(SHAPE, goodLog(), () => ({ kind: 'ratio', ratio: 7, color: 'a', background: 'b', from: PLANT.selector }));
    assert.equal(upstream.pass, false);
    assert.match(upstream.detail, /repaired upstream/);
    const [f] = goodLog().findings;
    assert.equal(plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, claim: 'J-1: the reserve button does nothing', cause: 'dead button' }] }), faint).pass, false);
    const open = plantCaughtVerdict(SHAPE, goodLog({ findings: [{ ...f!, transitions: f!.transitions.slice(0, 2) }] }), faint);
    assert.equal(open.pass, false);
    assert.match(open.detail, /F-1 .* is fixed-on-branch \(fixed on repair-contrast's branch, published\)/);
    const unpublished = plantCaughtVerdict(SHAPE, goodLog({ publications: goodLog().publications.filter((p) => p.unit !== 'repair-contrast') }), faint);
    assert.equal(unpublished.pass, false);
    assert.ok(PLANT_WORDS.test('Low contrast on the meta line') && !PLANT_WORDS.test('the button is missing'));
  });

  test('evals-m5.criterion.plant-repaired: at or above 4.5:1 passes; below it, an unknown colour or a gone selector fails', () => {
    assert.ok(plantRepairedVerdict('h', { kind: 'ratio', ratio: 4.6, color: 'a', background: 'b', from: PLANT.selector }).pass);
    assert.equal(plantRepairedVerdict('h', { kind: 'ratio', ratio: 4.4, color: 'a', background: 'b', from: PLANT.selector }).pass, false);
    assert.equal(plantRepairedVerdict('h', { kind: 'unknown', detail: 'x' }).pass, false);
    assert.match(plantRepairedVerdict('h', { kind: 'absent' }).detail, /adjudicate by hand/);
  });

  test('evals-m5.criterion.polish-bounded: rounds within walkRounds and each polish unit judged once, keep before it published; otherwise fails', () => {
    assert.ok(polishBoundedVerdict(goodLog(), ['polish-x1', 'polish-x2'], 3).pass);
    assert.match(polishBoundedVerdict(goodLog(), ['polish-x1'], 1).detail, /MS-1 was walked in round 2, past walkRounds 1/);
    assert.match(polishBoundedVerdict(goodLog(), ['polish-x3'], 3).detail, /polish unit polish-x3 has 0 tweak-judged facts/);
    const dropped = goodLog({ publications: [...goodLog().publications, { seq: 97, unit: 'polish-x2', commit: SHA('7') }] });
    assert.match(polishBoundedVerdict(dropped, ['polish-x2'], 3).detail, /polish unit polish-x2 published at seq 97 after a drop/);
  });

  test('evals-m5.criterion.demo-serving: the latest promotion serves at one URL; no promotion, no status.demo, a stale demo, a dead URL or a moved URL fails', () => {
    const demo = { where: 'http://127.0.0.1:4100/', milestone: 'MS-2', sha: SHA('6'), held: false };
    const seen = [{ at: 't1', arc: 'a', demo: { ...demo, milestone: 'MS-1', sha: SHA('4') } }, { at: 't2', arc: 'a', demo }];
    const final = { arc: 'a', demo, probe: { url: demo.where, status: 200, error: null } };
    assert.ok(demoServingVerdict(goodLog(), seen, final).pass);
    assert.match(demoServingVerdict(goodLog({ demos: [] }), seen, final).detail, /no demo-promoted/);
    assert.match(demoServingVerdict(goodLog(), seen, { arc: 'a', demo: null, probe: null }).detail, /status.demo/);
    assert.match(demoServingVerdict(goodLog(), seen, { ...final, demo: { ...demo, sha: SHA('4') } }).detail, /the latest promotion MS-2/);
    assert.match(demoServingVerdict(goodLog(), seen, { ...final, probe: { url: demo.where, status: null, error: 'ECONNREFUSED' } }).detail, /did not serve/);
    assert.match(demoServingVerdict(goodLog(), [{ at: 't0', arc: 'a', demo: { ...demo, where: 'http://127.0.0.1:4200/' } }, ...seen], final).detail, /the demo moved/);
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

  test('evals-m5.check-without-arc: a fixture whose session never started an arc fails every arc criterion, naming why, and throws nothing', T, () => {
    const l = setup(join(tmpDir('m5-check'), 'fx'));
    writeFileSync(l.report, JSON.stringify({
      schema: 'roadmap/m5-report', profile: 'claude-only', endedBy: 'stalled', stopReason: null, failure: 'x', hostDir: join(l.dir, 'host'),
      launch: { envKeys: [], gh: join(l.forgeBin, 'gh'), ghConfigDir: l.ghConfig, xdgConfigHome: l.xdgConfig, gitConfigGlobal: l.gitConfig },
      demo: { seen: [], final: null }, released: [], leftovers: [],
    }));
    const r = check(l.dir);
    assert.equal(r.pass, false);
    const by = Object.fromEntries(r.criteria.map((c) => [c.name, c]));
    assert.ok(by['isolation']!.pass, by['isolation']!.detail);
    assert.ok(by['host-released']!.pass, by['host-released']!.detail);
    assert.match(by['session-stopped']!.detail, /ended stalled/);
    assert.match(by['milestones-planned']!.detail, /no plan in force/);
    assert.match(by['arc-complete']!.detail, /threw: the product has no arc ref/);
    for (const name of ['design-first', 'node-held', 'walk-screenshots', 'plant-caught', 'plant-repaired', 'polish-bounded', 'demo-serving', 'skill-vendored', 'profile']) assert.equal(by[name]!.pass, false, name);
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
